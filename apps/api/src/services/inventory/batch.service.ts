/**
 * Batches: one lot of one product, received once, with one expiry and one cost.
 *
 * ⚠️ A BATCH ROW HOLDS NO QUANTITY, AND ADDING ONE WOULD UNDO PI-ADR-004. How
 *   much of a lot is left is the sum of `stock_balances` across the locations
 *   and statuses it sits in, and one lot legitimately has ten units available at
 *   the main pharmacy and thirty quarantined in the fridge. A `quantity` column
 *   here could express neither, and it would be the number every screen read.
 *
 * ⚠️ `status` IS NOT PATCHABLE, AND THAT IS THE POINT OF THE LEDGER. Quarantining
 *   or recalling a lot MOVES QUANTITY between status buckets, so it is a
 *   movement with a reason and an audit row, never a column edit. A
 *   `PATCH { status: 'QUARANTINED' }` would leave the balances saying the stock
 *   is still available and the batch saying it is not — two answers to one
 *   question, and allocation reads the one that lets it dispense. The batch's
 *   own status is maintained HERE, by `quarantineBatch` and `recallBatch`, in
 *   the same transaction as the movement that makes it true.
 *
 * ⚠️ LOT UNIQUENESS IS TENANT- AND BRANCH-QUALIFIED. A lot number is the
 *   MANUFACTURER's identifier: two clinics stocking the same medicine hold the
 *   same lot number, and one group receiving that lot at two sites holds it
 *   twice, at two costs. A global unique would fail the second receipt with a
 *   duplicate key nobody could explain.
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  BatchDetail,
  BatchListResponse,
  BatchQuery,
  BatchSummary,
  CreateBatchRequest,
  UpdateBatchRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { toCalendarDate, toDateColumn } from '../product/values.js';
import { recordMovementIn } from './movement.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';

const summaryInclude = Prisma.validator<Prisma.BatchInclude>()({
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  manufacturer: { select: { name: true } },
  balances: { select: { status: true, quantity: true, locationId: true } },
});

const detailInclude = Prisma.validator<Prisma.BatchInclude>()({
  ...summaryInclude,
  balances: {
    select: {
      status: true,
      quantity: true,
      locationId: true,
      location: { select: { name: true } },
    },
  },
});

type SummaryRow = Prisma.BatchGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.BatchGetPayload<{ include: typeof detailInclude }>;

/**
 * Sum a lot's balances without going near a float.
 *
 * ⚠️ `Prisma.Decimal.add`, NOT `Number(a) + Number(b)`. These are
 *   `Decimal(18,6)` values and a double has already lost the tail at eighteen
 *   digits — a lot of 12,345,678.123456 mg summed through `Number` comes back
 *   wrong in the last places, silently, in the number a pharmacist reconciles
 *   against a shelf.
 */
function sumQuantities(
  balances: { status: string; quantity: Prisma.Decimal }[],
  onlyStatus?: string
): string {
  return balances
    .filter((b) => onlyStatus === undefined || b.status === onlyStatus)
    .reduce((total, b) => total.add(b.quantity), new Prisma.Decimal(0))
    .toString();
}

function toSummary(row: SummaryRow): BatchSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    productId: row.productId,
    productName: row.product.name,
    productCode: row.product.code,
    lotNumber: row.lotNumber,
    manufacturedOn: row.manufacturedOn === null ? null : toCalendarDate(row.manufacturedOn),
    expiresOn: row.expiresOn === null ? null : toCalendarDate(row.expiresOn),
    retestOn: row.retestOn === null ? null : toCalendarDate(row.retestOn),
    manufacturerId: row.manufacturerId,
    manufacturerName: row.manufacturer?.name ?? null,
    // BigInt does not survive JSON. Minor units are far inside
    // Number.MAX_SAFE_INTEGER, so the narrowing is exact.
    unitCostBase: row.unitCostBase === null ? null : Number(row.unitCostBase),
    currency: row.currency,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    quantityOnHand: sumQuantities(row.balances),
    quantityAvailable: sumQuantities(row.balances, 'AVAILABLE'),
    baseUnitSymbol: row.product.baseUnit.symbol,
    quarantinedAt: row.quarantinedAt?.toISOString() ?? null,
    quarantineReason: row.quarantineReason,
    recalledAt: row.recalledAt?.toISOString() ?? null,
    recallReference: row.recallReference,
  };
}

function toDetail(row: DetailRow): BatchDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    balances: row.balances.map((b) => ({
      locationId: b.locationId,
      locationName: b.location.name,
      status: b.status,
      quantity: b.quantity.toString(),
    })),
  };
}

function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

async function findBatchOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.batch.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Batch');
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listBatches(
  ctx: TenantContext,
  query: BatchQuery
): Promise<BatchListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE EXPIRY WINDOW IS COMPUTED IN UTC AND THAT IS CORRECT HERE.
     *   `expires_on` is a `@db.Date` — a calendar day printed on a pack, in
     *   nobody's particular timezone — so "expiring within 30 days" is day
     *   arithmetic on days. The BRANCH's zone matters when deciding whether a
     *   lot has expired TODAY, which is the sweep's job and is done there.
     */
    const cutoff =
      query.expiringWithinDays === undefined
        ? undefined
        : new Date(
            new Date(new Date().toISOString().slice(0, 10)).getTime() +
              query.expiringWithinDays * 86_400_000
          );

    const where: Prisma.BatchWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(cutoff !== undefined ? { expiresOn: { not: null, lte: cutoff } } : {}),
      ...(query.onlyWithStock ? { balances: { some: { quantity: { gt: 0 } } } } : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { lotNumber: { contains: query.q, mode: 'insensitive' } },
              { product: { name: { contains: query.q, mode: 'insensitive' } } },
              { product: { code: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    /*
     * ⚠️ NULLS LAST ON `expiresOn`, SPELLED OUT. Postgres sorts NULLs FIRST on
     *   ASC — the opposite of what a FEFO-shaped list wants — so a batch with no
     *   expiry would head every page of "what expires soonest". PI-1 shipped a
     *   bug of exactly this shape in the other direction; it is written out here
     *   rather than left to the default.
     */
    const orderBy: Prisma.BatchOrderByWithRelationInput[] =
      query.sortBy === 'expiresOn'
        ? [{ expiresOn: { sort: query.sortOrder, nulls: 'last' } }, { receivedAt: 'asc' }]
        : [{ [query.sortBy]: query.sortOrder }];

    const [total, rows] = await Promise.all([
      tx.batch.count({ where }),
      tx.batch.findMany({
        where,
        include: summaryInclude,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      batches: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getBatch(ctx: TenantContext, id: string): Promise<BatchDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findBatchOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createBatch(
  ctx: TenantContext,
  input: CreateBatchRequest,
  options: CatalogueActionOptions = {}
): Promise<BatchDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: {
        id: true,
        name: true,
        trackingMode: true,
        isExpiryControlled: true,
        isStockItem: true,
        deletedAt: true,
      },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (!product.isStockItem) {
      throw new ValidationError(`${product.name} is not stocked, so it has no lots.`);
    }
    if (product.trackingMode === 'NONE' || product.trackingMode === 'SERIAL') {
      throw new ValidationError(
        `${product.name} is not batch-tracked, so recording a lot for it would create a lot nothing can ever move. Change its tracking mode first if it should be.`
      );
    }

    /*
     * The database refuses this too — `batches_expiry_required` — but a trigger
     * message names a constraint. This one names the product and says what to
     * do, which is what the caller can act on.
     */
    if (product.isExpiryControlled && input.expiresOn == null) {
      throw new ValidationError(
        `${product.name} is expiry-controlled, so every lot of it must carry an expiry date. Without one the lot would be invisible to the expiry sweep for ever.`
      );
    }

    const clash = await tx.batch.findFirst({
      where: {
        branchId: input.branchId,
        productId: input.productId,
        lotNumber: input.lotNumber,
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        `Lot ${input.lotNumber} of ${product.name} is already recorded at this branch. Receive more of it as a movement rather than as a second lot, so the two receipts share one expiry and one cost.`
      );
    }

    const created = await tx.batch.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        lotNumber: input.lotNumber,
        manufacturedOn: toDateColumn(input.manufacturedOn),
        expiresOn: toDateColumn(input.expiresOn),
        retestOn: toDateColumn(input.retestOn),
        manufacturerId: input.manufacturerId ?? null,
        unitCostBase: input.unitCostBase == null ? null : BigInt(input.unitCostBase),
        currency: input.currency ?? null,
        notes: input.notes ?? null,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'batch',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        productId: created.productId,
        lotNumber: created.lotNumber,
        expiresOn: created.expiresOn === null ? null : toCalendarDate(created.expiresOn),
        unitCostBase: created.unitCostBase === null ? null : Number(created.unitCostBase),
        currency: created.currency,
      },
      ...options,
    });

    return toDetail(created);
  });
}

export async function updateBatch(
  ctx: TenantContext,
  id: string,
  input: UpdateBatchRequest,
  options: CatalogueActionOptions = {}
): Promise<BatchDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findBatchOrThrow(tx, id);

    if (input.expiresOn === null) {
      const product = await tx.product.findUnique({
        where: { id: existing.productId },
        select: { isExpiryControlled: true, name: true },
      });
      if (product?.isExpiryControlled) {
        throw new ValidationError(
          `${product.name} is expiry-controlled, so this lot cannot have its expiry removed.`
        );
      }
    }

    const updated = await tx.batch.update({
      where: { id },
      data: {
        ...(input.manufacturedOn !== undefined
          ? { manufacturedOn: toDateColumn(input.manufacturedOn) }
          : {}),
        ...(input.expiresOn !== undefined ? { expiresOn: toDateColumn(input.expiresOn) } : {}),
        ...(input.retestOn !== undefined ? { retestOn: toDateColumn(input.retestOn) } : {}),
        ...(input.manufacturerId !== undefined ? { manufacturerId: input.manufacturerId } : {}),
        ...(input.unitCostBase !== undefined
          ? { unitCostBase: input.unitCostBase === null ? null : BigInt(input.unitCostBase) }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'batch',
      entityId: id,
      branchId: existing.branchId,
      before: {
        expiresOn: existing.expiresOn === null ? null : toCalendarDate(existing.expiresOn),
        unitCostBase: existing.unitCostBase === null ? null : Number(existing.unitCostBase),
        currency: existing.currency,
      },
      after: {
        expiresOn: updated.expiresOn === null ? null : toCalendarDate(updated.expiresOn),
        unitCostBase: updated.unitCostBase === null ? null : Number(updated.unitCostBase),
        currency: updated.currency,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Quarantine or release a whole lot: the batch's status and the movement that
 * makes it true, in ONE transaction.
 *
 * ⚠️ THE TWO HALVES MUST COMMIT TOGETHER OR NOT AT ALL. A batch flagged
 *   `QUARANTINED` whose quantity is still sitting in the AVAILABLE bucket is
 *   dispensable — allocation reads the balance, not the batch — so a status
 *   update that committed without its movement would produce a lot that says it
 *   is held and behaves as if it is not. That is strictly worse than neither.
 *
 * Every location the lot sits at is moved, because a quarantine is about the
 * LOT: half a recalled lot left available at the satellite pharmacy is the exact
 * failure a recall exists to prevent.
 */
export async function setBatchHold(
  ctx: TenantContext,
  id: string,
  action: 'QUARANTINE' | 'QUARANTINE_RELEASE' | 'RECALL',
  input: { reason: string; recallReference?: string | null | undefined },
  options: CatalogueActionOptions = {}
): Promise<BatchDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findBatchOrThrow(tx, id);

    const fromStatus = action === 'QUARANTINE_RELEASE' ? 'QUARANTINED' : 'AVAILABLE';
    const toStatus =
      action === 'QUARANTINE' ? 'QUARANTINED' : action === 'RECALL' ? 'RECALLED' : 'AVAILABLE';

    const movable = existing.balances.filter(
      (b) => b.status === fromStatus && b.quantity.greaterThan(0)
    );

    /*
     * A lot with nothing in the source bucket is not an error. A recall of a lot
     * that is already fully dispensed still has to be RECORDED — that is the
     * point at which somebody asks who received it — and refusing it because
     * there is no quantity to move would leave the most urgent case unrecordable.
     */
    for (const balance of movable) {
      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: existing.branchId,
          productId: existing.productId,
          batchId: existing.id,
          movementType: action,
          quantity: balance.quantity.toString(),
          locationId: balance.locationId,
          statusFrom: fromStatus,
          statusTo: toStatus,
          reasonCode: action,
          reasonNote: input.reason,
          referenceType: action === 'RECALL' ? 'RECALL' : 'MANUAL',
        },
        options
      );
    }

    const now = new Date();
    const updated = await tx.batch.update({
      where: { id },
      data:
        action === 'QUARANTINE'
          ? { status: 'QUARANTINED', quarantinedAt: now, quarantineReason: input.reason }
          : action === 'RECALL'
            ? {
                status: 'RECALLED',
                recalledAt: now,
                recallReference: input.recallReference ?? null,
              }
            : // Release restores ACTIVE and clears the pair together — the
              // `batches_quarantine_reasoned` CHECK insists on both or neither.
              { status: 'ACTIVE', quarantinedAt: null, quarantineReason: null },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'batch',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: updated.status, reason: input.reason, locationsMoved: movable.length },
      ...options,
    });

    return toDetail(updated);
  });
}
