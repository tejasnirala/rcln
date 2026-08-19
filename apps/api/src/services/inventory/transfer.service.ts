/**
 * Transfers: stock leaving one place and arriving at another (PI-3.2, PI-3.3).
 *
 * ── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE ───────────────
 *
 *     branch A                                        branch B
 *       AVAILABLE ──TRANSFER_OUT──▶ (the document) ──TRANSFER_IN──▶ AVAILABLE
 *                  actor scoped to A                actor scoped to B
 *
 * IN-TRANSIT STOCK IS HELD BY THE DOCUMENT, NOT BY A BUCKET. Dispatch writes the
 * `TRANSFER_OUT` legs at the sending branch and nothing at the receiving one;
 * receipt writes the `TRANSFER_IN` legs at the receiving branch and nothing at
 * the sending one. Both cite this transfer's id, so the pair is one join apart,
 * and NEITHER SIDE EVER WRITES A ROW AT THE OTHER'S BRANCH.
 *
 * That is forced rather than chosen. `branch_isolation` is RESTRICTIVE on
 * `stock_ledger`, so a row's `branch_id` must be inside the writer's scope. An
 * `IN_TRANSIT` bucket owned by the sender — which INVENTORY_ARCHITECTURE.md
 * describes — would make the RECEIVER write a removal against a branch they
 * cannot see, and the only ways to allow that are to widen their tenant context
 * or to write the row twice. The first punches the first hole in the branch
 * boundary; the second reintroduces the second ledger writer PI-ADR-004 forbids.
 * The full argument is on the `StockTransfer` model.
 *
 * What is outstanding is `sent − received` over the lines of `DISPATCHED`
 * transfers, which is a better answer than a bucket: "transfer TRF-000042, sent
 * by Anand from Central Store on the 4th, 3 boxes outstanding".
 *
 * ── INTRA-BRANCH IS ONE TRANSACTION, NOT A FLOW ─────────────────────────────
 * When the two branches are one there is nothing to be in transit between, so
 * `dispatchTransfer` writes BOTH legs together and the document goes straight to
 * `RECEIVED`. It is still a document, because "who moved the vaccines out of the
 * fridge" is a question with an answer.
 *
 * ── SERIALS ARE THE ONE CROSS-BRANCH WRITE, AND IT IS UNAVOIDABLE ────────────
 * A serial IS the physical device, so it cannot be copied to the destination the
 * way a lot is — two rows would be two devices. `serials.branch_id` therefore
 * has to MOVE, which needs a caller holding both branches. Refused with a
 * sentence when they do not; the check is inline in `receiveTransfer`, beside
 * the update it guards.
 *
 * ── EVERY STATE CHANGE TAKES THE HEADER'S ROW LOCK FIRST ────────────────────
 * `lockTransferOrThrow`, not `findTransferOrThrow`. `withTenant` opens a plain
 * READ COMMITTED transaction, so without it every transition here is a
 * read-then-write race: two dispatches both see DRAFT and both write a full set
 * of legs. The nastiest pair is cancel-against-receive, because they write at
 * DIFFERENT branches and the engine's advisory bucket locks therefore never
 * bring them into contact. See the helper.
 *
 * NO PHI. A transfer names products, lots, places and quantities. The one
 * PHI-adjacent column in this domain is `serials.assigned_patient_id`, and a
 * serial assigned to a patient is refused for transfer — at draft time AND
 * again at dispatch AND again at receipt, because `assignSerial` writes no
 * ledger movement and the days between those moments are exactly when a device
 * gets fitted. See `assertSerialIsStillStock`.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CancelStockTransferRequest,
  CreateStockTransferRequest,
  ReceiveStockTransferRequest,
  StockTransferDetail,
  StockTransferLineDetail,
  StockTransferLineRequest,
  StockTransferListResponse,
  StockTransferQuery,
  StockTransferSummary,
  UpdateStockTransferRequest,
} from '@rcln/contracts';
import { toBaseUnits } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { movementDeps, recordMovementIn } from './movement.service.js';
import { consultForStockMovement } from '../regulatory/consult.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { assertBranchInScope } from '../shared/branch.js';

const detailInclude = Prisma.validator<Prisma.StockTransferInclude>()({
  fromBranch: { select: { name: true } },
  toBranch: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  dispatchedBy: { select: { fullName: true } },
  receivedBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    include: {
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
      batch: { select: { lotNumber: true, expiresOn: true } },
      serial: { select: { serialNumber: true } },
      unit: { select: { symbol: true } },
    },
    /*
     * ⚠️ THE `id` TIE-BREAK IS LOAD-BEARING (KNOWN_ISSUES #1, closed in PI-8).
     *   `createMany` gives every line of one document the SAME `created_at`, so
     *   `createdAt` alone is not a total order and a transfer's lines could come
     *   back arranged differently on each read. PI-4 hit the identical bug in the
     *   four procurement document services, where it made a landed-cost assertion
     *   fail; this file kept it because no PI-3 suite asserts line order. Fixed
     *   here because PI-8 touched this file, which is what the entry asked for.
     */
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
});

type DetailRow = Prisma.StockTransferGetPayload<{ include: typeof detailInclude }>;
type LineRow = DetailRow['lines'][number];

function toLineDetail(line: LineRow): StockTransferLineDetail {
  return {
    id: line.id,
    productId: line.productId,
    productCode: line.product.code,
    productName: line.product.name,
    baseUnitSymbol: line.product.baseUnit.symbol,
    batchId: line.batchId,
    /*
     * ⚠️ THE LINE'S OWN SNAPSHOT, NOT THE BATCH JOIN, AND THE JOIN WAS THE SAME
     *   BUG THE HEADER ALREADY CARRIED. `batches` is branch-scoped, so for the
     *   RECEIVING branch the relation resolves to NULL — not forbidden, just
     *   absent — and the delivery note rendered "no lot number, no expiry" for
     *   the one person who has to check them against the pack. The columns exist
     *   on the line for precisely this; reading past them to the join threw the
     *   fix away. See the `transfer_line_lot_snapshot` migration.
     */
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn?.toISOString().slice(0, 10) ?? null,
    serialId: line.serialId,
    serialNumber: line.serial?.serialNumber ?? null,
    sentQuantityBase: line.sentQuantityBase.toString(),
    receivedQuantityBase: line.receivedQuantityBase.toString(),
    /*
     * ⚠️ `Prisma.Decimal.sub`, NOT `Number(a) - Number(b)`. These are
     *   `Decimal(18,6)` and a double has lost the tail before the subtraction
     *   runs — the same reason `sumQuantities` in batch.service.ts spells it
     *   out. This is the number a storekeeper chases a missing box with.
     */
    outstandingQuantityBase: line.sentQuantityBase.sub(line.receivedQuantityBase).toString(),
    quantityEntered: line.quantityEntered.toString(),
    unitSymbol: line.unit.symbol,
    destinationBatchId: line.destinationBatchId,
    notes: line.notes,
  };
}

function toSummary(row: DetailRow): StockTransferSummary {
  return {
    id: row.id,
    transferNumber: row.transferNumber,
    fromBranchId: row.fromBranchId,
    fromBranchName: row.fromBranch.name,
    toBranchId: row.toBranchId,
    toBranchName: row.toBranch.name,
    fromLocationId: row.fromLocationId,
    /*
     * ⚠️ THE SNAPSHOT, NOT THE JOIN, AND THE JOIN IS WHAT BROKE. The sending
     *   branch's shelf is invisible to the RECEIVER under
     *   `inventory_locations.branch_isolation` — the relation comes back NULL,
     *   not forbidden — so reading `row.fromLocation.name` threw for the one
     *   person who most needs to know where the box came from. See the
     *   `transfer_location_snapshot` migration.
     */
    fromLocationName: row.fromLocationName,
    toLocationId: row.toLocationId,
    toLocationName: row.toLocationName,
    status: row.status,
    isIntraBranch: row.fromBranchId === row.toBranchId,
    lineCount: row.lines.length,
    outstandingLineCount: row.lines.filter((l) =>
      l.sentQuantityBase.greaterThan(l.receivedQuantityBase)
    ).length,
    createdAt: row.createdAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdByName: row.createdBy.fullName,
    dispatchedByName: row.dispatchedBy?.fullName ?? null,
    receivedByName: row.receivedBy?.fullName ?? null,
  };
}

function toDetail(row: DetailRow): StockTransferDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    cancelledByName: row.cancelledBy?.fullName ?? null,
    lines: row.lines.map(toLineDetail),
  };
}

async function findTransferOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.stockTransfer.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Transfer');
  return row;
}

/**
 * Take the header's row lock, then read it. Every path that CHANGES a transfer's
 * state starts here.
 *
 * ⚠️ WITHOUT THIS, EVERY STATE TRANSITION IN THIS FILE IS A READ-THEN-WRITE RACE.
 *   `withTenant` opens a plain transaction with no isolation level, so READ
 *   COMMITTED applies: two concurrent requests both read `DRAFT`, both decide
 *   they are the one dispatching, and both write a full set of `TRANSFER_OUT`
 *   legs. The branch is debited twice for one document, two transfer numbers are
 *   issued and one is lost, and nothing raises — `stock_balances_non_negative`
 *   only catches it when the shelf happens to be too thin to cover the second.
 *
 *   The nastier pair is cancel-against-receive, because the two write at
 *   DIFFERENT branches: the compensating `TRANSFER_IN` at the sender and the
 *   real one at the receiver touch different buckets, so the engine's advisory
 *   bucket locks never bring them into contact. Ten units dispatched, twenty
 *   units landed, one header update silently overwriting the other.
 *
 * ⚠️ `FOR UPDATE` IS LEGITIMATE HERE AND IS REFUSED ON `stock_balances`, AND THE
 *   DIFFERENCE IS THE GRANT. Postgres requires the UPDATE privilege to take a
 *   row lock; `rcln_app` holds no UPDATE on the balance cache, which is why the
 *   engine uses an advisory lock there (see `lockBuckets`). It holds ordinary
 *   UPDATE on `stock_transfers`, so the row lock — which is narrower, releases
 *   on COMMIT, and needs no hashing — is the right instrument.
 *
 * ⚠️ RLS STILL APPLIES, so a transfer neither of whose ends the caller works at
 *   returns no row and this raises NOT FOUND rather than blocking on a lock the
 *   caller may not take.
 */
async function lockTransferOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "stock_transfers" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Transfer');

  // Re-read through Prisma for the relations. The lock is held for the rest of
  // the transaction, so what comes back cannot change under us.
  return findTransferOrThrow(tx, id);
}

// ---------------------------------------------------------------------------
// Line resolution
// ---------------------------------------------------------------------------

interface ResolvedLine {
  productId: string;
  batchId: string | null;
  serialId: string | null;
  sentQuantityBase: string;
  quantityEntered: string;
  unitId: string;
  notes: string | null;
  /*
   * ⚠️ THE LOT'S IDENTITY, COPIED OFF THE SENDER'S ROW AT DRAFT TIME, BECAUSE
   *   THE RECEIVER CANNOT READ IT. `batches` is branch-scoped and the policy is
   *   absolute, so `findOrCreateDestinationBatch` reading the source lot at
   *   receipt came back EMPTY — not forbidden — and receipt raised "Batch not
   *   found" at the moment somebody was signing for a delivery in their hands.
   *   Which is what a paper delivery note has always carried. See the
   *   `transfer_line_lot_snapshot` migration.
   */
  lotNumber: string | null;
  manufacturedOn: Date | null;
  expiresOn: Date | null;
  manufacturerId: string | null;
  unitCostBase: bigint | null;
  currency: string | null;
}

/**
 * Turn what the sender typed into what the document stores.
 *
 * ⚠️ THE SAME `toBaseUnits` THE LEDGER USES, IMPORTED FROM `@rcln/inventory`
 *   RATHER THAN REIMPLEMENTED. The line and the movement it will later write
 *   must agree to the last decimal place: a line that converted "2 boxes"
 *   differently from its own `TRANSFER_OUT` leg would put the delivery note and
 *   the shelves out of step at the exact moment somebody reconciles the two, and
 *   by an amount each individual conversion could justify.
 *
 * The batch and serial are re-read rather than trusted, for the reason
 * `recordMovementIn` re-reads them: the composite FK proves they belong to this
 * TENANT and says nothing about whether they belong to this PRODUCT or this
 * BRANCH.
 */
async function resolveLines(
  tx: TxClient,
  fromBranchId: string,
  lines: StockTransferLineRequest[]
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const product = await tx.product.findUnique({
      where: { id: line.productId },
      select: {
        id: true,
        name: true,
        baseUnitId: true,
        trackingMode: true,
        isStockItem: true,
        deletedAt: true,
        baseUnit: { select: { code: true } },
      },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so it has no quantity to transfer. A consultation fee is a product to billing and never to inventory.`
      );
    }

    const batchId = line.batchId ?? null;
    const serialId = line.serialId ?? null;
    const mode = product.trackingMode;

    /*
     * Checked here as well as on the ledger leg, and both are wanted. The leg's
     * CHECK constraint is what makes it unrepresentable; this is what makes the
     * DRAFT unsaveable, so the sender finds out while building the document
     * rather than at the moment they press Dispatch.
     */
    if ((mode === 'LOT_BATCH' || mode === 'LOT_AND_SERIAL') && batchId === null) {
      throw new ValidationError(
        `${product.name} is batch-tracked, so every line of it must name a lot.`
      );
    }
    if ((mode === 'SERIAL' || mode === 'LOT_AND_SERIAL') && serialId === null) {
      throw new ValidationError(
        `${product.name} is serial-tracked, so every line of it must name a serial number.`
      );
    }

    let snapshot: Pick<
      ResolvedLine,
      'lotNumber' | 'manufacturedOn' | 'expiresOn' | 'manufacturerId' | 'unitCostBase' | 'currency'
    > = {
      lotNumber: null,
      manufacturedOn: null,
      expiresOn: null,
      manufacturerId: null,
      unitCostBase: null,
      currency: null,
    };

    if (batchId !== null) {
      const batch = await tx.batch.findUnique({
        where: { id: batchId },
        select: {
          id: true,
          productId: true,
          branchId: true,
          lotNumber: true,
          status: true,
          manufacturedOn: true,
          expiresOn: true,
          manufacturerId: true,
          unitCostBase: true,
          currency: true,
        },
      });
      if (!batch) throw new NotFoundError('Batch');
      if (batch.productId !== product.id) {
        throw new ValidationError(`Lot ${batch.lotNumber} is not a lot of ${product.name}.`);
      }
      if (batch.branchId !== fromBranchId) {
        throw new ValidationError(
          `Lot ${batch.lotNumber} is not held at the branch this transfer is being sent from.`
        );
      }
      /*
       * ⚠️ A QUARANTINED OR RECALLED LOT MAY NOT BE SENT ANYWHERE, AND THIS IS
       *   THE CHECK THAT SAYS SO. The ledger would allow it — the quantity sits
       *   in the QUARANTINED bucket and a `TRANSFER_OUT` from that bucket is a
       *   legal movement — and allowing it is how a recalled lot gets quietly
       *   moved to the site that has not heard about the recall yet. Sending
       *   quarantined stock somewhere is a DISPOSAL or a purchase return, both
       *   of which say what they are.
       */
      if (batch.status === 'QUARANTINED' || batch.status === 'RECALLED') {
        throw new ValidationError(
          `Lot ${batch.lotNumber} is ${batch.status.toLowerCase()} and cannot be transferred. Stock that is being held is disposed of or returned to the supplier, not moved to another shelf.`
        );
      }

      snapshot = {
        lotNumber: batch.lotNumber,
        manufacturedOn: batch.manufacturedOn,
        expiresOn: batch.expiresOn,
        manufacturerId: batch.manufacturerId,
        unitCostBase: batch.unitCostBase,
        currency: batch.currency,
      };
    }

    if (serialId !== null) {
      const serial = await tx.serial.findUnique({
        where: { id: serialId },
        select: {
          id: true,
          productId: true,
          branchId: true,
          batchId: true,
          serialNumber: true,
          assignedPatientId: true,
        },
      });
      if (!serial) throw new NotFoundError('Serial');
      if (serial.productId !== product.id) {
        throw new ValidationError(`Serial ${serial.serialNumber} is not a ${product.name}.`);
      }
      if (serial.branchId !== fromBranchId) {
        throw new ValidationError(`Serial ${serial.serialNumber} is held at a different branch.`);
      }
      if (batchId !== null && serial.batchId !== batchId) {
        throw new ValidationError(
          `Serial ${serial.serialNumber} does not belong to the lot this line names.`
        );
      }
      /*
       * ⚠️ THE ONE PHI-ADJACENT CHECK IN THIS FILE, AND THE ERROR DELIBERATELY
       *   DOES NOT NAME THE PATIENT. "Device 7742 is in Mrs Rao" is a clinical
       *   fact about a named person; "device 7742 has been issued to a patient"
       *   is what the storekeeper needs to know and carries none of it.
       */
      if (serial.assignedPatientId !== null) {
        throw new ValidationError(
          `Serial ${serial.serialNumber} has been issued to a patient and is no longer stock. It cannot be transferred.`
        );
      }
    }

    const quantityBase = await toBaseUnits(
      tx,
      movementDeps,
      { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
      line
    );

    resolved.push({
      productId: product.id,
      batchId,
      serialId,
      sentQuantityBase: quantityBase,
      quantityEntered: line.quantity,
      unitId: line.unitId ?? product.baseUnitId,
      notes: line.notes ?? null,
      ...snapshot,
    });
  }

  /*
   * ⚠️ THE DUPLICATE CHECK IS HERE AND IN A UNIQUE INDEX, AND THE INDEX ALONE
   *   WOULD PRODUCE A 23505 NOBODY CAN READ. Two lines for the same lot have two
   *   plausible readings — did they mean the sum, or did they type it twice —
   *   and neither should be guessed. The message says which line.
   */
  const seen = new Set<string>();
  for (const line of resolved) {
    const key = `${line.productId}|${line.batchId ?? '-'}|${line.serialId ?? '-'}`;
    if (seen.has(key)) {
      throw new ValidationError(
        'The same product and lot appears on this transfer twice. Combine them into one line — two lines for one lot could mean the total or a duplicate, and neither should be guessed.'
      );
    }
    seen.add(key);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTransfers(
  ctx: TenantContext,
  query: StockTransferQuery
): Promise<StockTransferListResponse> {
  if (query.fromBranchId !== undefined) assertBranchInScope(ctx, query.fromBranchId);
  if (query.toBranchId !== undefined) assertBranchInScope(ctx, query.toBranchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.StockTransferWhereInput = {
      ...(query.fromBranchId !== undefined ? { fromBranchId: query.fromBranchId } : {}),
      ...(query.toBranchId !== undefined ? { toBranchId: query.toBranchId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      /*
       * "What is still on the van", expressed as the two statuses that mean it.
       *
       * ⚠️ NOT `received < sent` ON THE LINES, AND NOT BECAUSE THAT WOULD BE
       *   WRONG. Prisma's filter language cannot compare one column to another —
       *   it would take `$queryRaw` and a hand-built page — and the two are
       *   equivalent by construction: `receiveTransfer` re-reads the lines and
       *   flips the status to RECEIVED in the same transaction that fills the
       *   last one, and the `stock_transfers_dispatched_states_complete` CHECK
       *   is what stops a post-dispatch status existing without its legs. If
       *   those two ever diverge this filter is wrong, which is why they are
       *   named here.
       */
      ...(query.outstandingOnly
        ? { status: { in: ['DISPATCHED', 'PARTIALLY_RECEIVED'] as const } }
        : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { transferNumber: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.stockTransfer.count({ where }),
      tx.stockTransfer.findMany({
        where,
        include: detailInclude,
        // `id` last, so offset pagination means something. Same reasoning as
        // `listBalances` — several transfers share a created_at to the second.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      transfers: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getTransfer(ctx: TenantContext, id: string): Promise<StockTransferDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findTransferOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createTransfer(
  ctx: TenantContext,
  input: CreateStockTransferRequest,
  options: CatalogueActionOptions = {}
): Promise<StockTransferDetail> {
  /*
   * ⚠️ ONLY THE SENDING BRANCH IS REQUIRED TO BE IN SCOPE, AND THAT IS THE
   *   WHOLE POINT OF THE DESIGN. A storekeeper at Central Store sends stock to a
   *   site they have no access to; they can see the branch EXISTS — the RLS
   *   policy on `stock_transfers` lets both ends read the document — and they
   *   cannot see a single thing on its shelves. Requiring both would mean only
   *   an org-wide role could ever move stock between sites.
   *
   *   `to_branch_id` is proved to be in the same ORGANIZATION by the composite
   *   foreign key, which is the check that actually matters here.
   */
  assertBranchInScope(ctx, input.fromBranchId);

  return withTenant(ctx, async (tx) => {
    const fromLocation = await tx.inventoryLocation.findUnique({
      where: { id: input.fromLocationId },
      select: { id: true, branchId: true, isActive: true, deletedAt: true, name: true },
    });
    if (!fromLocation || fromLocation.deletedAt) throw new NotFoundError('Inventory location');
    if (fromLocation.branchId !== input.fromBranchId) {
      throw new ValidationError(
        `${fromLocation.name} is not at the branch this transfer is being sent from.`
      );
    }
    if (!fromLocation.isActive) {
      throw new ValidationError(
        `${fromLocation.name} is no longer in use, so stock cannot leave it.`
      );
    }

    const toBranch = await tx.branch.findUnique({
      where: { id: input.toBranchId },
      select: { id: true, name: true },
    });
    if (!toBranch) throw new NotFoundError('Branch');

    /*
     * ⚠️ THE DESTINATION SHELF IS ONLY VALIDATED WHEN THE SENDER NAMED ONE, AND
     *   ONLY WHEN THEY CAN SEE IT. A sender scoped to one branch reads NULL back
     *   from a location at another under RLS — the row is invisible, not
     *   missing — so a hard `NotFoundError` here would refuse the ordinary
     *   inter-branch case. It is validated properly at receipt, by somebody who
     *   can see the shelf.
     */
    let proposedToLocationName: string | null = null;
    if (input.toLocationId != null && ctx.branchIds.includes(input.toBranchId)) {
      const toLocation = await tx.inventoryLocation.findUnique({
        where: { id: input.toLocationId },
        select: { branchId: true, deletedAt: true, name: true },
      });
      if (!toLocation || toLocation.deletedAt) throw new NotFoundError('Inventory location');
      if (toLocation.branchId !== input.toBranchId) {
        throw new ValidationError(
          `${toLocation.name} is not at the branch this transfer is being sent to.`
        );
      }
      proposedToLocationName = toLocation.name;
    }

    if (
      input.fromBranchId === input.toBranchId &&
      input.toLocationId != null &&
      input.toLocationId === input.fromLocationId
    ) {
      throw new ValidationError(
        'This transfer moves stock from a shelf to itself, which changes nothing. Pick a different destination.'
      );
    }

    const lines = await resolveLines(tx, input.fromBranchId, input.lines);

    /*
     * ⚠️ THE HEADER AND THE LINES ARE TWO STATEMENTS, NOT A NESTED `create`, AND
     *   THE NESTED FORM DOES NOT COMPILE AGAINST THIS SCHEMA. `stock_transfer_
     *   lines` reaches its parent through the COMPOSITE relation
     *   `(organization_id, transfer_id)`, so Prisma treats `organization_id` as
     *   part of that relation and refuses it as a scalar inside a nested write —
     *   `Unknown argument organizationId`. Both rows still commit together;
     *   `withTenant` opened the transaction and this is the same one
     *   `updateTransfer` writes its replacement lines on.
     */
    const header = await tx.stockTransfer.create({
      data: {
        organizationId: ctx.organizationId,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        fromLocationId: input.fromLocationId,
        fromLocationName: fromLocation.name,
        toLocationId: input.toLocationId ?? null,
        toLocationName: proposedToLocationName,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
      select: { id: true },
    });

    await tx.stockTransferLine.createMany({
      data: lines.map((l) => ({
        organizationId: ctx.organizationId,
        transferId: header.id,
        productId: l.productId,
        batchId: l.batchId,
        serialId: l.serialId,
        sentQuantityBase: l.sentQuantityBase,
        quantityEntered: l.quantityEntered,
        unitId: l.unitId,
        notes: l.notes,
        lotNumber: l.lotNumber,
        manufacturedOn: l.manufacturedOn,
        expiresOn: l.expiresOn,
        manufacturerId: l.manufacturerId,
        unitCostBase: l.unitCostBase,
        currency: l.currency,
      })),
    });

    const created = await findTransferOrThrow(tx, header.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'stock_transfer',
      entityId: created.id,
      branchId: input.fromBranchId,
      after: {
        fromBranchId: created.fromBranchId,
        toBranchId: created.toBranchId,
        fromLocationId: created.fromLocationId,
        lineCount: created.lines.length,
      },
      ...options,
    });

    return toDetail(created);
  });
}

/**
 * Edit a DRAFT.
 *
 * ⚠️ ONLY A DRAFT, AND THE STATUS CHECK IS THE WHOLE SAFETY OF THIS FUNCTION. A
 *   dispatched transfer has ledger rows against its lines; replacing those lines
 *   would leave movements citing lines that no longer exist and a sending branch
 *   whose shelves disagree with its own delivery note. A dispatched transfer is
 *   corrected by receiving what actually arrived and adjusting the difference,
 *   which is what those two operations are for.
 */
export async function updateTransfer(
  ctx: TenantContext,
  id: string,
  input: UpdateStockTransferRequest,
  options: CatalogueActionOptions = {}
): Promise<StockTransferDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockTransferOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        `This transfer has already been ${existing.status === 'CANCELLED' ? 'cancelled' : 'sent'}, so its lines cannot be changed. Receive what arrived and adjust the difference with a reason.`
      );
    }
    assertBranchInScope(ctx, existing.fromBranchId);

    if (input.lines !== undefined) {
      const lines = await resolveLines(tx, existing.fromBranchId, input.lines);
      /*
       * Replaced wholesale, the way storage areas are. A diff would need stable
       * client-side ids for rows the client never sees, and the document has not
       * moved anything yet — there is nothing to preserve.
       */
      await tx.stockTransferLine.deleteMany({ where: { transferId: id } });
      await tx.stockTransferLine.createMany({
        data: lines.map((l) => ({
          organizationId: ctx.organizationId,
          transferId: id,
          productId: l.productId,
          batchId: l.batchId,
          serialId: l.serialId,
          sentQuantityBase: l.sentQuantityBase,
          quantityEntered: l.quantityEntered,
          unitId: l.unitId,
          notes: l.notes,
          lotNumber: l.lotNumber,
          manufacturedOn: l.manufacturedOn,
          expiresOn: l.expiresOn,
          manufacturerId: l.manufacturerId,
          unitCostBase: l.unitCostBase,
          currency: l.currency,
        })),
      });
    }

    /*
     * ⚠️ THE SNAPSHOT MOVES WITH THE ID, OR THE TWO STOP AGREEING. A draft whose
     *   destination is changed and whose NAME is not would show the receiving
     *   branch the previous shelf — the failure mode a denormalised column
     *   always has, and the one place in this file where it can arise.
     */
    let toLocationName: string | null | undefined;
    if (input.toLocationId === null) {
      toLocationName = null;
    } else if (input.toLocationId !== undefined) {
      const toLocation = await tx.inventoryLocation.findUnique({
        where: { id: input.toLocationId },
        select: { branchId: true, deletedAt: true, name: true },
      });

      /*
       * ⚠️ THE BRANCH IS CHECKED HERE TOO, AND THE FIRST VERSION CHECKED IT ON
       *   EVERY PATH BUT THIS ONE. `createTransfer` and `receiveTransfer` both
       *   refuse a shelf at the wrong branch; this one took whatever it was
       *   given, so a draft could be repointed at another branch's location. It
       *   fails safe eventually — the composite FK and `recordMovementIn` both
       *   refuse it — but the refusal arrives at DISPATCH, as a foreign-key
       *   error about a column nobody mentioned, and the stored snapshot names
       *   the wrong branch's shelf in the meantime.
       *
       *   ⚠️ A LOOKUP THAT RETURNS NOTHING IS **NOT** REFUSED, AND THAT IS
       *     DELIBERATE. The destination is legitimately a branch the sender
       *     cannot see, in which case RLS returns no row — absent, not
       *     forbidden. Only a shelf the sender CAN see and which belongs to the
       *     wrong branch is an error; the invisible case leaves the name null and
       *     the receiver fills it in when they sign for it, exactly as
       *     `createTransfer` does.
       */
      if (toLocation && toLocation.branchId !== existing.toBranchId) {
        throw new ValidationError(
          `${toLocation.name} is not at the branch this transfer is being sent to.`
        );
      }
      if (toLocation?.deletedAt) throw new NotFoundError('Inventory location');

      toLocationName = toLocation?.name ?? null;
    }

    const updated = await tx.stockTransfer.update({
      where: { id },
      data: {
        ...(input.toLocationId !== undefined ? { toLocationId: input.toLocationId } : {}),
        ...(toLocationName !== undefined ? { toLocationName } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_transfer',
      entityId: id,
      branchId: existing.fromBranchId,
      before: { lineCount: existing.lines.length },
      after: { lineCount: updated.lines.length },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Send it.
 *
 * ⚠️ EVERY `TRANSFER_OUT` LEG AND THE STATUS CHANGE COMMIT TOGETHER OR NOT AT
 *   ALL. A transfer marked DISPATCHED whose legs did not write is stock the
 *   sending branch still shows on its shelves and the receiving branch is
 *   expecting — and the `stock_transfers_dispatched_states_complete` CHECK is
 *   the layer under this one, refusing a post-dispatch status with no dispatch
 *   time and no number.
 *
 * ⚠️ AND AN INTRA-BRANCH TRANSFER WRITES **BOTH** LEGS HERE. There is nothing to
 *   be in transit between when the two branches are one, so the pair commits
 *   together and the document goes straight to RECEIVED — which is the atomic
 *   pair PI-3.2 asks for, and the reason `manualMovementType` still refuses to
 *   expose TRANSFER_IN and TRANSFER_OUT one at a time.
 */
export async function dispatchTransfer(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<StockTransferDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockTransferOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError('This transfer has already been sent.');
    }
    /*
     * The SENDER's branch, because the legs written here carry it. RLS would
     * refuse the row anyway; this turns a policy violation into a sentence.
     */
    assertBranchInScope(ctx, existing.fromBranchId);
    if (existing.lines.length === 0) {
      throw new ValidationError('This transfer has no lines, so there is nothing to send.');
    }

    /*
     * ⚠️ NARROWED BY STRUCTURE RATHER THAN BY AN ASSERTION. The compound guard
     *   `if (isIntraBranch && toLocationId === null) throw` narrows nothing
     *   afterwards, so the leg below needed `as string` — which is the same
     *   class of thing as `!`, and load-bearing for the compiler the moment
     *   somebody moves the guard. Written this way, TypeScript narrows it for
     *   free and the assertion is gone.
     */
    const intraBranch: { destinationId: string } | null =
      existing.fromBranchId === existing.toBranchId
        ? ((): { destinationId: string } => {
            if (existing.toLocationId === null) {
              throw new ValidationError(
                'Say which shelf this stock is moving to. A transfer within one branch arrives the moment it leaves, so the destination cannot be decided later.'
              );
            }
            return { destinationId: existing.toLocationId };
          })()
        : null;
    const isIntraBranch = intraBranch !== null;

    const number = await issueNumber(tx, ctx, {
      type: 'STOCK_TRANSFER',
      branchId: existing.fromBranchId,
      // Never resets: a transfer number is a document identifier, and a clinic
      // reconciling a six-month-old delivery note needs it to mean one thing.
      periodKey: '',
      prefix: 'TRF-',
    });

    for (const line of existing.lines) {
      // Re-checked here as well as at draft time: the two moments are days
      // apart and a device can be fitted to a patient in between.
      if (line.serialId !== null) {
        await assertSerialIsStillStock(tx, line.serialId, line.serial?.serialNumber ?? null);
      }

      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: existing.fromBranchId,
          productId: line.productId,
          batchId: line.batchId,
          serialId: line.serialId,
          movementType: 'TRANSFER_OUT',
          quantity: line.sentQuantityBase.toString(),
          locationId: existing.fromLocationId,
          statusFrom: 'AVAILABLE',
          referenceType: 'TRANSFER',
          referenceId: existing.id,
        },
        options
      );

      if (intraBranch) {
        await recordMovementIn(
          tx,
          ctx,
          {
            branchId: existing.toBranchId,
            productId: line.productId,
            // Same branch, so the SAME lot row — nothing to find or create.
            batchId: line.batchId,
            serialId: line.serialId,
            movementType: 'TRANSFER_IN',
            quantity: line.sentQuantityBase.toString(),
            locationId: intraBranch.destinationId,
            statusTo: 'AVAILABLE',
            referenceType: 'TRANSFER',
            referenceId: existing.id,
          },
          options
        );

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: {
            receivedQuantityBase: line.sentQuantityBase,
            destinationBatchId: line.batchId,
          },
        });

        if (line.serialId !== null) {
          await tx.serial.update({
            where: { id: line.serialId },
            data: { currentLocationId: intraBranch.destinationId },
          });
        }
      }
    }

    const now = new Date();
    const updated = await tx.stockTransfer.update({
      where: { id },
      data: {
        transferNumber: number.formatted,
        status: isIntraBranch ? 'RECEIVED' : 'DISPATCHED',
        dispatchedAt: now,
        dispatchedById: ctx.userId,
        ...(isIntraBranch ? { receivedAt: now, receivedById: ctx.userId } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_transfer',
      entityId: id,
      branchId: existing.fromBranchId,
      before: { status: existing.status },
      after: {
        status: updated.status,
        transferNumber: updated.transferNumber,
        lineCount: updated.lines.length,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * A serial that is still stock, re-checked at the moment it is about to move.
 *
 * ⚠️ CHECKED AGAIN HERE, HAVING ALREADY BEEN CHECKED AT DRAFT TIME, BECAUSE THE
 *   TWO MOMENTS ARE DAYS APART AND THE FACT CHANGES IN BETWEEN. `assignSerial`
 *   sets `assigned_patient_id` and `status = ISSUED` and writes NO ledger
 *   movement — the quantity stays in the AVAILABLE bucket — so nothing in
 *   `recordMovementIn` notices: its serial read selects the product, branch, lot
 *   and number, and neither the patient link nor the status.
 *
 *   So: draft a transfer naming serial S, fit S to a patient, dispatch, receive.
 *   The receipt moves `serials.branch_id`, and a device record CARRYING A
 *   PATIENT LINK lands inside the receiving branch's RLS scope — readable by
 *   staff who never had access to the branch that fitted it. That is a PHI
 *   disclosure produced by an ordinary sequence of legitimate actions, with no
 *   error anywhere along it.
 *
 * ⚠️ THE MESSAGE DOES NOT NAME THE PATIENT, AND MUST NOT. "Device 7742 has been
 *   issued to a patient" is what the storekeeper needs; "device 7742 is in Mrs
 *   Rao" is a clinical fact about a named person on a stock screen.
 */
async function assertSerialIsStillStock(
  tx: TxClient,
  serialId: string,
  fallbackNumber: string | null
): Promise<void> {
  const serial = await tx.serial.findUnique({
    where: { id: serialId },
    select: { serialNumber: true, status: true, assignedPatientId: true },
  });
  if (!serial) throw new NotFoundError('Serial');

  const label = serial.serialNumber || (fallbackNumber ?? '');

  if (serial.assignedPatientId !== null) {
    throw new ValidationError(
      `Serial ${label} has been issued to a patient since this transfer was drafted, so it is no longer stock and cannot be moved.`
    );
  }
  if (serial.status !== 'IN_STOCK' && serial.status !== 'RETURNED') {
    throw new ValidationError(
      `Serial ${label} is ${serial.status.toLowerCase().replace('_', ' ')} and is no longer stock, so it cannot be moved.`
    );
  }
}

/**
 * The receiving branch's own lot row for a lot that arrived from elsewhere.
 *
 * ⚠️ IT IS BUILT FROM THE **LINE'S SNAPSHOT**, NOT FROM THE SENDER'S BATCH ROW,
 *   AND THE FIRST VERSION READ THE SENDER'S ROW AND FAILED. `batches` is
 *   branch-scoped and its policy is absolute, so the sending branch's lot is
 *   invisible to whoever is signing for the delivery — the read came back EMPTY
 *   rather than forbidden, and receipt raised "Batch not found" at the moment
 *   somebody had the boxes in their hands. Found by
 *   `stock-movements.test.ts`, which is the only reason it is not still there:
 *   nothing about it is visible from reading the code, because the query is
 *   correct and the policy is correct and they are correct about different
 *   things.
 *
 * ⚠️ A SECOND `batches` ROW FOR ONE MANUFACTURER'S LOT IS THE MODEL, NOT A
 *   WORKAROUND. `(organization_id, branch_id, id)` is what every movement
 *   composes against, so one row cannot serve both sites. The lot NUMBER,
 *   expiry and manufacturer identify the physical stock and are copied; the cost
 *   is copied too, so the receiving branch values what it holds at what the
 *   group paid rather than at nothing.
 *
 * Idempotent by lot number: a second delivery of the same lot finds the row the
 * first one created, which is what `@@unique([organizationId, branchId,
 * productId, lotNumber])` is for.
 */
async function findOrCreateDestinationBatch(
  tx: TxClient,
  ctx: TenantContext,
  line: {
    productId: string;
    lotNumber: string | null;
    manufacturedOn: Date | null;
    expiresOn: Date | null;
    manufacturerId: string | null;
    unitCostBase: bigint | null;
    currency: string | null;
  },
  toBranchId: string
): Promise<string | null> {
  /*
   * A line with no lot number is a line for an untracked product, which is the
   * commonest case in the programme and needs no destination row at all. The
   * `stock_transfer_lines_lot_snapshot_complete` CHECK is what guarantees this
   * agrees with `batch_id` being null.
   */
  if (line.lotNumber === null) return null;

  const existing = await tx.batch.findFirst({
    where: { branchId: toBranchId, productId: line.productId, lotNumber: line.lotNumber },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.batch.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: toBranchId,
      productId: line.productId,
      lotNumber: line.lotNumber,
      manufacturedOn: line.manufacturedOn,
      expiresOn: line.expiresOn,
      manufacturerId: line.manufacturerId,
      unitCostBase: line.unitCostBase,
      currency: line.currency,
      /*
       * ⚠️ `receivedAt` DEFAULTS TO **NOW**, AND IS DELIBERATELY NOT COPIED. This
       *   is when the lot arrived AT THIS BRANCH, and it is the FEFO tie-break:
       *   two lots expiring the same day go out oldest-received-HERE first.
       *   Copying the original date would make a lot that has just been unpacked
       *   look like the oldest thing on the shelf.
       */
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Sign for what arrived.
 *
 * ⚠️ EVERY ROW THIS WRITES CARRIES THE **RECEIVING** BRANCH, WHICH IS WHY A
 *   BRANCH-SCOPED RECEIVER CAN DO IT AT ALL. The `TRANSFER_IN` legs, the
 *   destination lot rows and the line updates are all at `to_branch_id`; nothing
 *   here touches the sending branch's stock, and nothing needs to. See the file
 *   header.
 */
export async function receiveTransfer(
  ctx: TenantContext,
  id: string,
  input: ReceiveStockTransferRequest,
  options: CatalogueActionOptions = {}
): Promise<StockTransferDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockTransferOrThrow(tx, id);
    assertBranchInScope(ctx, existing.toBranchId);

    if (existing.status !== 'DISPATCHED' && existing.status !== 'PARTIALLY_RECEIVED') {
      throw new ConflictError(
        existing.status === 'DRAFT'
          ? 'This transfer has not been sent yet, so there is nothing to receive.'
          : `This transfer is already ${existing.status.toLowerCase().replace('_', ' ')}.`
      );
    }

    const toLocation = await tx.inventoryLocation.findUnique({
      where: { id: input.toLocationId },
      select: { id: true, branchId: true, isActive: true, deletedAt: true, name: true },
    });
    if (!toLocation || toLocation.deletedAt) throw new NotFoundError('Inventory location');
    if (toLocation.branchId !== existing.toBranchId) {
      throw new ValidationError(
        `${toLocation.name} is not at the branch this transfer was sent to.`
      );
    }
    if (!toLocation.isActive) {
      throw new ValidationError(
        `${toLocation.name} is no longer in use, so stock cannot be received into it.`
      );
    }

    const byId = new Map(existing.lines.map((l) => [l.id, l]));

    /*
     * ⚠️ WHAT EACH LINE HAS TAKEN **SO FAR IN THIS REQUEST**, AND WITHOUT IT THIS
     *   LOOP MINTED STOCK. `line` is the object loaded once before the loop, so
     *   `line.receivedQuantityBase` never changes as the loop runs: two entries
     *   naming one line both measured themselves against the same untouched
     *   value, both passed the over-receipt check, both wrote a `TRANSFER_IN`
     *   leg, and the final write set the row to `stale + last` rather than to
     *   the sum. Ten units sent became twenty received with the document
     *   reporting nothing outstanding.
     *
     *   The contract now refuses a duplicate `lineId` outright, which is the
     *   layer that stops it. This is the second: the loop no longer depends on
     *   the request being well-formed to be correct, so a future caller that
     *   folds two entries together — or a later phase that receives the same
     *   line twice on purpose — cannot reintroduce it.
     */
    const takenThisRequest = new Map<string, Prisma.Decimal>();

    /*
     * ⚠️ SORTED INTO A CANONICAL ORDER BEFORE ANY BUCKET IS TOUCHED. Each leg
     *   takes an advisory lock held until COMMIT, so the lock ACQUISITION ORDER
     *   here is the order the client happened to send its lines in — and two
     *   receipts of overlapping transfers whose lines arrive in opposite orders
     *   deadlock. `lockBuckets` in the engine sorts within ONE movement for
     *   exactly this reason; this is the same rule one level up, where the
     *   caller controls the sequence. Measured on the expiry sweep in PI-2.
     */
    const ordered = [...input.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : 1));

    for (const received of ordered) {
      const line = byId.get(received.lineId);
      if (!line) throw new NotFoundError('Transfer line');

      const alreadyTaken = takenThisRequest.get(line.id) ?? new Prisma.Decimal(0);
      const outstanding = line.sentQuantityBase.sub(line.receivedQuantityBase).sub(alreadyTaken);
      const quantity = new Prisma.Decimal(received.quantityBase);

      /*
       * ⚠️ OVER-RECEIPT IS REFUSED RATHER THAN ABSORBED, AND THE CHECK
       *   CONSTRAINT SAYS THE SAME THING WITHOUT A SENTENCE. Receiving more than
       *   was sent is a data-entry error nine times in ten; on the tenth it is a
       *   genuine discovery of stock, which is an ADJUSTMENT with a reason code
       *   at this branch. Letting the transfer absorb it files a discovery as a
       *   delivery, and the sending branch's books never balance again.
       */
      if (quantity.greaterThan(outstanding)) {
        throw new ValidationError(
          `${line.product.name} has ${outstanding.toString()} ${line.product.baseUnit.symbol} still outstanding on this transfer and ${quantity.toString()} is being received. If more arrived than was sent, receive what was sent and record the difference as an adjustment with a reason.`
        );
      }

      /*
       * ⚠️ ON RECEIPT RATHER THAN ON DISPATCH, BECAUSE THE QUESTION IS ABOUT
       *   WHERE THE STOCK IS GOING. A storage rule — "a Schedule X drug may be
       *   kept only in a controlled cabinet" — is a statement about the
       *   DESTINATION, and `toLocation` does not exist until here: dispatch
       *   knows the receiving BRANCH but not the shelf. Asking at dispatch would
       *   evaluate every transfer against no location at all, which the engine
       *   correctly answers `UNDETERMINED` for.
       *
       * Nothing blocks yet — see `regulatory/enforcement.ts`.
       */
      await consultForStockMovement(tx, ctx, {
        branchId: existing.toBranchId,
        productId: line.productId,
        locationId: toLocation.id,
        quantityBase: quantity.toString(),
        transaction: 'TRANSFER',
        occurredAt: new Date(),
        documentType: 'TRANSFER',
        documentId: existing.id,
        /* The caller, as the rules judge them. See the goods-receipt note. */
        roleCodes: options.roleCodes ?? [],
      });

      const destinationBatchId = await findOrCreateDestinationBatch(
        tx,
        ctx,
        line,
        existing.toBranchId
      );

      /*
       * ⚠️ THE SERIAL MOVES BRANCH, IT IS NOT COPIED, AND THIS IS THE ONE
       *   CROSS-BRANCH WRITE IN THE WHOLE FLOW. A serial IS the physical device
       *   — two rows would be two devices — so `branch_id` has to be updated on
       *   the row the SENDING branch owns. Under `branch_isolation` the USING
       *   clause is evaluated against the OLD row, so a receiver who does not
       *   also hold the sending branch simply does not see it, and the update
       *   matches zero rows and reports success. That silent no-op is exactly
       *   the failure mode the codebase refuses elsewhere, so it is checked
       *   here, first, with a sentence.
       */
      if (line.serialId !== null) {
        await assertSerialIsStillStock(tx, line.serialId, line.serial?.serialNumber ?? null);

        if (!ctx.branchIds.includes(existing.fromBranchId)) {
          throw new ValidationError(
            `Serial ${line.serial?.serialNumber ?? ''} can only be received by somebody who works at both branches. A serial-numbered item is one physical device, so receiving it MOVES the device's record rather than copying it, and that record belongs to the sending branch until it does.`.trim()
          );
        }
        await tx.serial.update({
          where: { id: line.serialId },
          data: {
            branchId: existing.toBranchId,
            batchId: destinationBatchId,
            currentLocationId: toLocation.id,
          },
        });
      }

      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: existing.toBranchId,
          productId: line.productId,
          batchId: destinationBatchId,
          serialId: line.serialId,
          movementType: 'TRANSFER_IN',
          quantity: quantity.toString(),
          locationId: toLocation.id,
          statusTo: 'AVAILABLE',
          referenceType: 'TRANSFER',
          referenceId: existing.id,
        },
        options
      );

      /*
       * ⚠️ `alreadyTaken + quantity`, NOT `line.receivedQuantityBase + quantity`.
       *   The second is the absolute assignment that made the duplicate-line bug
       *   invisible in the row while the ledger ran ahead of it.
       */
      const takenNow = alreadyTaken.add(quantity);
      takenThisRequest.set(line.id, takenNow);

      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: {
          receivedQuantityBase: line.receivedQuantityBase.add(takenNow),
          destinationBatchId,
        },
      });
    }

    /*
     * Re-read rather than computing what the state should now be. The lines were
     * just updated inside this transaction and a service that predicted the
     * answer would agree with the rows right up until the day one of them
     * changed — the same reasoning `recordMovementIn` uses for the balances.
     */
    const lines = await tx.stockTransferLine.findMany({
      where: { transferId: id },
      select: { sentQuantityBase: true, receivedQuantityBase: true },
    });
    const fullyReceived = lines.every((l) =>
      l.receivedQuantityBase.greaterThanOrEqualTo(l.sentQuantityBase)
    );

    const now = new Date();
    const updated = await tx.stockTransfer.update({
      where: { id },
      data: {
        status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        toLocationId: toLocation.id,
        // The receiver decided, so the snapshot is theirs from here on.
        toLocationName: toLocation.name,
        // ⚠️ Only when it is DONE. `received_at` on a partially-received
        // transfer would say the delivery closed while a box is still missing,
        // and the CHECK pairs it with `received_by_id` either way.
        ...(fullyReceived ? { receivedAt: now, receivedById: ctx.userId } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_transfer',
      entityId: id,
      branchId: existing.toBranchId,
      before: { status: existing.status },
      after: {
        status: updated.status,
        toLocationId: toLocation.id,
        linesReceived: input.lines.length,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Kill it.
 *
 * ⚠️ TWO DIFFERENT OPERATIONS BEHIND ONE NAME, AND THE DIFFERENCE IS WHETHER
 *   STOCK HAS MOVED. Cancelling a DRAFT writes no ledger row at all — nothing
 *   left the shelf. Cancelling a DISPATCHED transfer writes a compensating
 *   `TRANSFER_IN` BACK TO THE SENDER for whatever is still outstanding, because
 *   that quantity has already left the sending branch's shelves and has to land
 *   somewhere. There is no edit and no deletion; a correction is a compensating
 *   movement (PI-ADR-004 rule 3).
 *
 * ⚠️ AND IT IS THE **SENDER** WHO CANCELS AFTER DISPATCH, NECESSARILY. The
 *   compensating legs carry the sending branch, so only somebody scoped there
 *   can write them. A receiving branch that wants a delivery reversed asks the
 *   sender, which is also how it works with a van.
 */
export async function cancelTransfer(
  ctx: TenantContext,
  id: string,
  input: CancelStockTransferRequest,
  options: CatalogueActionOptions = {}
): Promise<StockTransferDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockTransferOrThrow(tx, id);

    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This transfer has already been cancelled.');
    }
    if (existing.status === 'RECEIVED') {
      throw new ConflictError(
        'This transfer has been received in full, so there is nothing to cancel. Send the stock back as a new transfer.'
      );
    }
    assertBranchInScope(ctx, existing.fromBranchId);

    if (existing.status !== 'DRAFT') {
      for (const line of existing.lines) {
        const outstanding = line.sentQuantityBase.sub(line.receivedQuantityBase);
        if (outstanding.lessThanOrEqualTo(0)) continue;

        await recordMovementIn(
          tx,
          ctx,
          {
            branchId: existing.fromBranchId,
            productId: line.productId,
            batchId: line.batchId,
            serialId: line.serialId,
            movementType: 'TRANSFER_IN',
            quantity: outstanding.toString(),
            locationId: existing.fromLocationId,
            statusTo: 'AVAILABLE',
            referenceType: 'TRANSFER',
            referenceId: existing.id,
            reasonNote: `Transfer cancelled: ${input.reason}`,
          },
          options
        );
      }
    }

    const updated = await tx.stockTransfer.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: ctx.userId,
        cancellationReason: input.reason,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_transfer',
      entityId: id,
      branchId: existing.fromBranchId,
      before: { status: existing.status },
      after: { status: 'CANCELLED', reason: input.reason },
      ...options,
    });

    return toDetail(updated);
  });
}
