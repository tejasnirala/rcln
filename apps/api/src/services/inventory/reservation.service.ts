/**
 * Reservations: stock spoken for and not yet gone (PI-3.4).
 *
 * `RESERVED` was a `StockStatus` member with no workflow in PI-2, on purpose, so
 * this phase needed no enum migration. This file is the workflow.
 *
 * ── THE ROW IS THE PAPERWORK; THE MOVEMENT IS THE FACT ──────────────────────
 * Creating a reservation writes a `RESERVATION` movement — AVAILABLE → RESERVED
 * — in the SAME transaction as the row. Releasing one writes a `RELEASE` back.
 * A reservation row that committed without its movement would hold nothing while
 * claiming to, and two pharmacists would dispense the same last strip, which is
 * the entire failure this table exists to prevent.
 *
 * The quantity is therefore never "checked" against anything here: the movement
 * engine takes the bucket lock and refuses a reservation the shelf cannot cover
 * with the same 409 a dispense gets. Losing that race is an ordinary outcome.
 *
 * ── WHY THERE IS NO `consumeReservation` YET ────────────────────────────────
 * Because nothing consumes one. PI-7's dispensing and PI-9's consumption move
 * quantity out of the `RESERVED` bucket directly and will set `CONSUMED` in the
 * same transaction they dispense in. Writing that transition now would mean
 * writing a caller for it now, and a state nothing can reach is a state nobody
 * maintains. The enum member exists so neither phase needs a migration.
 *
 * NO PHI. A reservation names a `reference_id` — a prescription in PI-7, a
 * procedure in PI-9 — and never a patient.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateStockReservationRequest,
  ReleaseStockReservationRequest,
  StockReservationListResponse,
  StockReservationQuery,
  StockReservationSummary,
} from '@rcln/contracts';
import { toBaseUnits } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { movementDeps, recordMovementIn } from './movement.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { assertBranchInScope } from '../shared/branch.js';

/**
 * How far ahead a reservation may be set to expire.
 *
 * ⚠️ A CAP AND NOT A DEFAULT, AND THE CONTRACT DELIBERATELY HAS NO DEFAULT AT
 *   ALL. A reservation holds stock out of `AVAILABLE`, and one nobody releases
 *   is a medicine the clinic can see on the shelf and cannot dispense. Ninety
 *   days is long enough for a procedure booked next quarter and short enough
 *   that a forgotten hold surfaces within one stock take. A clinic that needs
 *   longer is describing consignment stock or a quarantine, both of which are
 *   different statuses with different screens.
 */
const MAX_RESERVATION_DAYS = 90;

const summaryInclude = Prisma.validator<Prisma.StockReservationInclude>()({
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  location: { select: { name: true } },
  batch: { select: { lotNumber: true } },
  serial: { select: { serialNumber: true } },
  createdBy: { select: { fullName: true } },
  releasedBy: { select: { fullName: true } },
});

type Row = Prisma.StockReservationGetPayload<{ include: typeof summaryInclude }>;

function toSummary(row: Row, now: Date): StockReservationSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    productId: row.productId,
    productCode: row.product.code,
    productName: row.product.name,
    baseUnitSymbol: row.product.baseUnit.symbol,
    batchId: row.batchId,
    lotNumber: row.batch?.lotNumber ?? null,
    serialId: row.serialId,
    serialNumber: row.serial?.serialNumber ?? null,
    locationId: row.locationId,
    locationName: row.location.name,
    quantityBase: row.quantityBase.toString(),
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    expiresAt: row.expiresAt.toISOString(),
    /*
     * ⚠️ "OVERDUE" IS A PROPERTY OF THIS MOMENT, NOT A COLUMN, AND IT IS WHAT
     *   MAKES THE SWEEP VISIBLE INSTEAD OF MAGICAL. An ACTIVE reservation past
     *   its time is one the sweep has not reached yet — it runs on a schedule,
     *   not on a timer per row — and a screen that showed it as merely "active"
     *   would leave a pharmacist waiting for stock that is already theirs.
     */
    isOverdue: row.status === 'ACTIVE' && row.expiresAt.getTime() <= now.getTime(),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.fullName,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    releasedByName: row.releasedBy?.fullName ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listReservations(
  ctx: TenantContext,
  query: StockReservationQuery
): Promise<StockReservationListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.StockReservationWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.referenceType !== undefined ? { referenceType: query.referenceType } : {}),
      ...(query.referenceId !== undefined ? { referenceId: query.referenceId } : {}),
    };

    const [total, rows] = await Promise.all([
      tx.stockReservation.count({ where }),
      tx.stockReservation.findMany({
        where,
        include: summaryInclude,
        /*
         * Soonest to expire first — the one an ACTIVE list is actually about —
         * and `id` last so offset pagination means something. Several
         * reservations legitimately share an expiry to the second when a screen
         * creates them in a loop.
         */
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    const now = new Date();
    return {
      reservations: rows.map((r) => toSummary(r, now)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function reserveStock(
  ctx: TenantContext,
  input: CreateStockReservationRequest,
  options: CatalogueActionOptions = {}
): Promise<StockReservationSummary> {
  assertBranchInScope(ctx, input.branchId);

  const expiresAt = new Date(input.expiresAt);
  const now = new Date();
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ValidationError(
      'This reservation would expire in the past, so it would be released again the moment it was made.'
    );
  }
  if (expiresAt.getTime() - now.getTime() > MAX_RESERVATION_DAYS * 86_400_000) {
    throw new ValidationError(
      `A reservation can be held for at most ${String(MAX_RESERVATION_DAYS)} days. Stock held longer than that is consignment or quarantine, both of which have their own status and their own screen — and a hold nobody remembers is a medicine the clinic can see and cannot dispense.`
    );
  }

  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: {
        id: true,
        name: true,
        baseUnitId: true,
        isStockItem: true,
        deletedAt: true,
        baseUnit: { select: { code: true } },
      },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so there is no quantity of it to hold back.`
      );
    }

    const quantityBase = await toBaseUnits(
      tx,
      movementDeps,
      { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
      input
    );

    /*
     * ⚠️ THE MOVEMENT FIRST, THE ROW SECOND, AND BOTH IN ONE TRANSACTION. The
     *   movement is what takes the bucket lock and refuses a hold the shelf
     *   cannot cover — with the same 409 a dispense gets, which is the correct
     *   outcome and not an error. Writing the row first would mean a refused
     *   movement rolled back a row that had already been reported as created.
     */
    await recordMovementIn(
      tx,
      ctx,
      {
        branchId: input.branchId,
        productId: input.productId,
        batchId: input.batchId ?? null,
        serialId: input.serialId ?? null,
        movementType: 'RESERVATION',
        quantity: quantityBase,
        locationId: input.locationId,
        statusFrom: 'AVAILABLE',
        statusTo: 'RESERVED',
        referenceType: input.referenceType,
        referenceId: input.referenceId ?? null,
        reasonNote: input.notes ?? null,
      },
      options
    );

    const created = await tx.stockReservation.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        batchId: input.batchId ?? null,
        serialId: input.serialId ?? null,
        locationId: input.locationId,
        quantityBase,
        referenceType: input.referenceType,
        referenceId: input.referenceId ?? null,
        expiresAt,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
      include: summaryInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'stock_reservation',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        productId: created.productId,
        locationId: created.locationId,
        quantityBase: created.quantityBase.toString(),
        expiresAt: created.expiresAt.toISOString(),
        referenceType: created.referenceType,
      },
      ...options,
    });

    return toSummary(created, now);
  });
}

/**
 * Give it back.
 *
 * ⚠️ THE `RELEASE` MOVEMENT AND THE STATUS CHANGE COMMIT TOGETHER. A row marked
 *   RELEASED whose movement did not write leaves the quantity sitting in the
 *   RESERVED bucket with nothing claiming it — invisible to allocation, held for
 *   nobody, and releasable only by somebody who works out what happened from the
 *   ledger.
 *
 * ⚠️ THE ROW IS CLAIMED BEFORE THE MOVEMENT IS WRITTEN, WHICH IS THE REVERSE OF
 *   `reserveStock`'S ORDER AND IS REVERSED ON PURPOSE. There, the movement is
 *   the thing that can fail and must fail before a row is claimed. Here, the row
 *   is what DECIDES whether the movement happens at all: `updateMany` with the
 *   status in its predicate returns a count, and zero means somebody else got
 *   there first.
 *
 *   Without it this raced the sweep into a double release. A pharmacist pressing
 *   the button at the moment the hourly sweep reached the same reservation:
 *   the sweep claims and writes `RELEASE 5`; the manual path, which read
 *   `ACTIVE` before that claim, writes a SECOND `RELEASE 5` and overwrites the
 *   row. Five units move RESERVED → AVAILABLE twice, draining the bucket on
 *   behalf of some OTHER active reservation, which then fails its own release
 *   later with a 409 nobody can explain.
 *
 *   `packages/inventory/src/reservation-sweep.ts` gets this right and says why.
 *   This function said it was "shared with the worker's sweep" and was not —
 *   the sweep has its own copy, correct, and this one was the copy that was
 *   wrong. The claim is now the same shape in both.
 *
 * ⚠️ AND IT IS `RELEASED` ONLY. The `EXPIRED` outcome belongs to the sweep and
 *   is written there; a parameter here for a value nothing passes is a branch
 *   nothing maintains.
 */
export async function releaseReservationIn(
  tx: TxClient,
  ctx: TenantContext,
  reservation: {
    id: string;
    branchId: string;
    productId: string;
    batchId: string | null;
    serialId: string | null;
    locationId: string;
    quantityBase: Prisma.Decimal;
  },
  options: CatalogueActionOptions & { notes?: string | null | undefined } = {}
): Promise<boolean> {
  const { notes, ...auditOptions } = options;

  const claimed = await tx.stockReservation.updateMany({
    where: { id: reservation.id, status: 'ACTIVE' },
    data: {
      status: 'RELEASED',
      releasedAt: new Date(),
      /*
       * ⚠️ SET HERE BECAUSE A PERSON DID IT. The sweep deliberately leaves this
       *   NULL, and that difference is a fact rather than a missing value:
       *   "the pharmacist gave it back" and "it timed out" mean different things
       *   to whoever is asking why the stock is available again. The
       *   `stock_reservations_terminal_dated` CHECK pairs the timestamp with the
       *   STATUS and deliberately not with the actor.
       */
      releasedById: ctx.userId,
    },
  });
  if (claimed.count === 0) return false;

  await recordMovementIn(
    tx,
    ctx,
    {
      branchId: reservation.branchId,
      productId: reservation.productId,
      batchId: reservation.batchId,
      serialId: reservation.serialId,
      movementType: 'RELEASE',
      quantity: reservation.quantityBase.toString(),
      locationId: reservation.locationId,
      statusFrom: 'RESERVED',
      statusTo: 'AVAILABLE',
      referenceType: 'MANUAL',
      referenceId: reservation.id,
      reasonNote: notes ?? null,
    },
    auditOptions
  );

  return true;
}

export async function releaseReservation(
  ctx: TenantContext,
  id: string,
  input: ReleaseStockReservationRequest,
  options: CatalogueActionOptions = {}
): Promise<StockReservationSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.stockReservation.findUnique({
      where: { id },
      include: summaryInclude,
    });
    if (!existing) throw new NotFoundError('Reservation');

    /*
     * Checked here for the SENTENCE, and claimed inside `releaseReservationIn`
     * for the correctness. This read tells somebody who pressed the button on a
     * stale screen what happened; the claim is what stops two releases of one
     * hold. Both, because the first alone is a race and the second alone is a
     * bare 409 with nothing to say.
     */
    if (existing.status !== 'ACTIVE') {
      throw new ConflictError(
        existing.status === 'CONSUMED'
          ? 'This stock has already been dispensed, so there is nothing left to release.'
          : `This reservation was already ${existing.status.toLowerCase()}.`
      );
    }

    const released = await releaseReservationIn(tx, ctx, existing, {
      ...options,
      ...(input.notes != null ? { notes: input.notes } : {}),
    });

    /*
     * ⚠️ THE CLAIM LOST, WHICH MEANS THE SWEEP GOT THERE IN THE MILLISECONDS
     *   SINCE THE READ ABOVE. An ordinary outcome, and the stock IS back in
     *   AVAILABLE either way — so this says what happened rather than reporting
     *   a failure.
     */
    if (!released) {
      throw new ConflictError(
        'This reservation ran out of time and was released automatically a moment ago. The stock is already back in the available count.'
      );
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_reservation',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'RELEASED', quantityBase: existing.quantityBase.toString() },
      ...options,
    });

    const updated = await tx.stockReservation.findUniqueOrThrow({
      where: { id },
      include: summaryInclude,
    });
    return toSummary(updated, new Date());
  });
}
