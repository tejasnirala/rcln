/**
 * Requisitions: a branch asking the organization to buy something (PI-4.3).
 *
 * ── THE APPROVAL SPLIT IS THE ENTIRE POINT OF THIS FILE ─────────────────────
 *
 *     storekeeper                        branch administrator
 *     REQUISITION_CREATE  ──submit──▶    REQUISITION_APPROVE  ──▶ purchase order
 *
 * ⚠️ ENFORCED IN THREE PLACES, AND ONLY THE THIRD CANNOT BE FORGOTTEN:
 *
 *   1. two permission codes, `procurement.requisition.create` and `.approve`;
 *   2. `assertNotOwnRequisition` below, which refuses an approval by the row's own
 *      `created_by_id`;
 *   3. the `purchase_requisitions_approver_is_not_creator` CHECK constraint.
 *
 *   1 and 2 are each one edit away from absent, and an approval control a later
 *   phase can quietly remove is not a control. This is the shape every
 *   procurement fraud in a small organization takes: the person who chooses the
 *   supplier, the quantity and the price is the person who signs it off.
 *
 * ⚠️ A CLINIC MAY GRANT BOTH CODES TO ONE PERSON, AND THAT IS DELIBERATELY
 *   POSSIBLE. A single-doctor clinic has nobody else, and refusing to let them buy
 *   anything would be a platform deciding how a business is staffed. What they
 *   still cannot do is self-approve ONE DOCUMENT, because the CHECK compares two
 *   user ids and not two permissions. `ORG_OWNER` holds both for that reason.
 *
 * ── EVERY STATE CHANGE TAKES THE HEADER'S ROW LOCK FIRST ────────────────────
 * `lockRequisitionOrThrow`, not `findRequisitionOrThrow`. `withTenant` opens a
 * plain READ COMMITTED transaction, so without it every transition here is a
 * read-then-write race: two concurrent approvals both see `SUBMITTED`, both write,
 * and two requisition numbers are issued with one lost. PI-3 learned this on
 * transfers and the shape is identical.
 *
 * NO PHI. A requisition names products and quantities.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreatePurchaseRequisitionRequest,
  PurchaseRequisitionDetail,
  PurchaseRequisitionLineDetail,
  PurchaseRequisitionLineRequest,
  PurchaseRequisitionListResponse,
  PurchaseRequisitionQuery,
  PurchaseRequisitionSummary,
  RejectPurchaseRequisitionRequest,
  UpdatePurchaseRequisitionRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import {
  assertBranchInScope,
  assertNoDuplicateLines,
  fromDateString,
  resolveProductForLine,
  toBase,
  toDateString,
  toQuantityString,
} from './shared.js';

const detailInclude = Prisma.validator<Prisma.PurchaseRequisitionInclude>()({
  branch: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  rejectedBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    include: {
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      suggestedSupplier: { select: { name: true } },
    },
    orderBy: { lineNumber: 'asc' },
  },
});

type DetailRow = Prisma.PurchaseRequisitionGetPayload<{ include: typeof detailInclude }>;
type LineRow = DetailRow['lines'][number];

function toLineDetail(line: LineRow): PurchaseRequisitionLineDetail {
  return {
    id: line.id,
    productId: line.productId,
    productCode: line.product.code,
    productName: line.product.name,
    baseUnitSymbol: line.product.baseUnit.symbol,
    quantityBase: toQuantityString(line.quantityBase),
    quantityEntered: toQuantityString(line.quantityEntered),
    unitSymbol: line.unit.symbol,
    suggestedSupplierId: line.suggestedSupplierId,
    suggestedSupplierName: line.suggestedSupplier?.name ?? null,
    notes: line.notes,
  };
}

/**
 * ⚠️ `canApprove` IS COMPUTED FROM WHO IS ASKING, NOT FROM THE ROW ALONE. It is
 *   false for the requisition's own creator however many permissions they hold,
 *   because the CHECK constraint would refuse the write and a button that produces
 *   a 400 is worse than no button. Presentation only: `approveRequisition`
 *   re-decides, and the constraint decides again after that.
 */
function toSummary(row: DetailRow, ctx: TenantContext): PurchaseRequisitionSummary {
  return {
    id: row.id,
    requisitionNumber: row.requisitionNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    status: row.status,
    requiredBy: toDateString(row.requiredBy),
    lineCount: row.lines.length,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.fullName,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByName: row.approvedBy?.fullName ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    canApprove: row.status === 'SUBMITTED' && row.createdById !== ctx.userId,
  };
}

function toDetail(row: DetailRow, ctx: TenantContext): PurchaseRequisitionDetail {
  return {
    ...toSummary(row, ctx),
    notes: row.notes,
    rejectionReason: row.rejectionReason,
    rejectedByName: row.rejectedBy?.fullName ?? null,
    cancelledByName: row.cancelledBy?.fullName ?? null,
    lines: row.lines.map(toLineDetail),
  };
}

async function findRequisitionOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.purchaseRequisition.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Requisition');
  return row;
}

/**
 * Take the header's row lock, then read it. Every path that CHANGES state starts
 * here.
 *
 * ⚠️ `FOR UPDATE` IS LEGITIMATE ON THIS TABLE AND IS REFUSED ON `stock_balances`,
 *   AND THE DIFFERENCE IS THE GRANT. Postgres requires the UPDATE privilege to
 *   take a row lock; `rcln_app` holds ordinary UPDATE here and none at all on the
 *   balance cache, which is why the movement engine uses an advisory lock there.
 *
 * ⚠️ RLS STILL APPLIES, so a requisition at a branch the caller cannot see returns
 *   no row and this raises NOT FOUND rather than blocking on a lock they may not
 *   take.
 */
async function lockRequisitionOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "purchase_requisitions" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Requisition');
  return findRequisitionOrThrow(tx, id);
}

/**
 * ⚠️ THE SECOND OF THE THREE LAYERS. The CHECK constraint says the same thing
 *   without a sentence; this is what turns it into one a person can act on, and it
 *   is deliberately phrased so the reader understands it is not a permissions
 *   problem they can fix by being granted something.
 */
function assertNotOwnRequisition(row: DetailRow, ctx: TenantContext): void {
  if (row.createdById === ctx.userId) {
    throw new ValidationError(
      'A requisition cannot be approved by the person who raised it. Somebody else with approval access has to look at it — that is the whole point of the two steps, and no permission grants a way round it.'
    );
  }
}

interface ResolvedLine {
  productId: string;
  quantityBase: string;
  quantityEntered: string;
  unitId: string;
  suggestedSupplierId: string | null;
  notes: string | null;
}

async function resolveLines(
  tx: TxClient,
  lines: PurchaseRequisitionLineRequest[]
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const product = await resolveProductForLine(tx, line.productId);

    if (line.suggestedSupplierId != null) {
      const supplier = await tx.supplier.findUnique({
        where: { id: line.suggestedSupplierId },
        select: { id: true, deletedAt: true },
      });
      if (!supplier || supplier.deletedAt) throw new NotFoundError('Supplier');
      /*
       * ⚠️ A BLACKLISTED SUPPLIER IS NOT REFUSED HERE, AND THAT IS DELIBERATE. This
       *   is a SUGGESTION on an internal request — the requester saying who they
       *   usually get it from — and the refusal belongs where the money is
       *   committed, in `resolveSupplierForDocument`. Refusing it here would make a
       *   storekeeper's request fail for a commercial decision they may not know
       *   about, with nothing useful for them to do about it.
       */
    }

    resolved.push({
      productId: product.id,
      quantityBase: await toBase(tx, product, line),
      quantityEntered: line.quantity,
      unitId: line.unitId ?? product.baseUnitId,
      suggestedSupplierId: line.suggestedSupplierId ?? null,
      notes: line.notes ?? null,
    });
  }

  assertNoDuplicateLines(
    resolved.map((l) => l.productId),
    'The same product is asked for twice on this requisition. Combine them into one line — two lines for one product could mean the total or a duplicate, and neither should be guessed.'
  );

  return resolved;
}

function lineData(
  ctx: TenantContext,
  branchId: string,
  requisitionId: string,
  lines: ResolvedLine[]
): Prisma.PurchaseRequisitionLineCreateManyInput[] {
  return lines.map((l, index) => ({
    organizationId: ctx.organizationId,
    branchId,
    requisitionId,
    // 1-based, and it IS the order the document renders in. See the model.
    lineNumber: index + 1,
    productId: l.productId,
    quantityBase: l.quantityBase,
    quantityEntered: l.quantityEntered,
    unitId: l.unitId,
    suggestedSupplierId: l.suggestedSupplierId,
    notes: l.notes,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRequisitions(
  ctx: TenantContext,
  query: PurchaseRequisitionQuery
): Promise<PurchaseRequisitionListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.PurchaseRequisitionWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      /*
       * "What is waiting for me to approve", and the `createdById` exclusion is not
       * cosmetic: those rows are unapprovable by this caller, so listing them on an
       * approval screen produces a queue of buttons that all fail.
       */
      ...(query.awaitingApproval
        ? { status: 'SUBMITTED' as const, createdById: { not: ctx.userId } }
        : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { requisitionNumber: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.purchaseRequisition.count({ where }),
      tx.purchaseRequisition.findMany({
        where,
        include: detailInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      requisitions: rows.map((row) => toSummary(row, ctx)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getRequisition(
  ctx: TenantContext,
  id: string
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findRequisitionOrThrow(tx, id), ctx));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createRequisition(
  ctx: TenantContext,
  input: CreatePurchaseRequisitionRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const lines = await resolveLines(tx, input.lines);

    /*
     * ⚠️ THE HEADER AND THE LINES ARE TWO STATEMENTS, NOT A NESTED `create`, AND THE
     *   NESTED FORM DOES NOT COMPILE AGAINST THIS SCHEMA. The lines reach their
     *   parent through the COMPOSITE relation `(organization_id, requisition_id)`,
     *   so Prisma treats `organization_id` as part of that relation and refuses it
     *   as a scalar inside a nested write — `Unknown argument organizationId`. Both
     *   rows still commit together: `withTenant` opened the transaction. Exactly
     *   what PI-3's transfers found.
     */
    const header = await tx.purchaseRequisition.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        requiredBy: input.requiredBy != null ? fromDateString(input.requiredBy) : null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
      select: { id: true },
    });

    await tx.purchaseRequisitionLine.createMany({
      data: lineData(ctx, input.branchId, header.id, lines),
    });

    const created = await findRequisitionOrThrow(tx, header.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'purchase_requisition',
      entityId: created.id,
      branchId: input.branchId,
      after: { branchId: created.branchId, lineCount: created.lines.length },
      ...options,
    });

    return toDetail(created, ctx);
  });
}

/**
 * Edit a DRAFT.
 *
 * ⚠️ ONLY A DRAFT, AND THE STATUS CHECK IS THE WHOLE SAFETY OF THIS FUNCTION. A
 *   submitted requisition is in front of somebody who is about to agree to spend
 *   money on it; letting the requester change the quantities underneath them is
 *   the approval control undone from the other end. A submitted requisition is
 *   changed by rejecting it and raising another, which leaves both on the record.
 */
export async function updateRequisition(
  ctx: TenantContext,
  id: string,
  input: UpdatePurchaseRequisitionRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockRequisitionOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        `This requisition has already been ${existing.status.toLowerCase()}, so its lines cannot be changed. Raise a new one — changing what somebody is about to approve is the approval undone from the other end.`
      );
    }
    assertBranchInScope(ctx, existing.branchId);

    if (input.lines !== undefined) {
      const lines = await resolveLines(tx, input.lines);
      // Replaced wholesale, the way a draft transfer's are. Nothing has been
      // committed, so there is nothing to preserve.
      await tx.purchaseRequisitionLine.deleteMany({ where: { requisitionId: id } });
      await tx.purchaseRequisitionLine.createMany({
        data: lineData(ctx, existing.branchId, id, lines),
      });
    }

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: {
        ...(input.requiredBy !== undefined
          ? { requiredBy: input.requiredBy === null ? null : fromDateString(input.requiredBy) }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_requisition',
      entityId: id,
      branchId: existing.branchId,
      before: { lineCount: existing.lines.length },
      after: { lineCount: updated.lines.length },
      ...options,
    });

    return toDetail(updated, ctx);
  });
}

/**
 * Send it for approval, and burn the number.
 *
 * ⚠️ THE NUMBER IS ISSUED HERE AND NOT AT CREATE. A draft that is abandoned must
 *   not leave a gap in a series somebody reads as a sequence, and `issueNumber` is
 *   transactional so a submit that rolls back burns nothing. Called as late in the
 *   transaction as the flow allows, because its row lock serialises every
 *   concurrent submit for this branch's counter.
 */
export async function submitRequisition(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockRequisitionOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError('This requisition has already been submitted.');
    }
    assertBranchInScope(ctx, existing.branchId);
    if (existing.lines.length === 0) {
      throw new ValidationError('This requisition has no lines, so there is nothing to ask for.');
    }

    const number = await issueNumber(tx, ctx, {
      type: 'PURCHASE_REQUISITION',
      branchId: existing.branchId,
      // Never resets: a requisition number is a document identifier.
      periodKey: '',
      prefix: 'REQ-',
    });

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: {
        requisitionNumber: number.formatted,
        status: 'SUBMITTED',
        submittedAt: new Date(),
        submittedById: ctx.userId,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_requisition',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: updated.status, requisitionNumber: updated.requisitionNumber },
      ...options,
    });

    return toDetail(updated, ctx);
  });
}

export async function approveRequisition(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockRequisitionOrThrow(tx, id);
    if (existing.status !== 'SUBMITTED') {
      throw new ConflictError(
        existing.status === 'DRAFT'
          ? 'This requisition has not been submitted yet, so there is nothing to approve.'
          : `This requisition is already ${existing.status.toLowerCase()}.`
      );
    }
    assertBranchInScope(ctx, existing.branchId);
    assertNotOwnRequisition(existing, ctx);

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedById: ctx.userId },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_requisition',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'APPROVED', approvedById: ctx.userId },
      ...options,
    });

    return toDetail(updated, ctx);
  });
}

/**
 * ⚠️ REJECTION IS GATED BY THE SAME `assertNotOwnRequisition` AS APPROVAL, WHICH
 *   LOOKS LIKE OVER-REACH AND IS NOT. Rejecting your own requisition is
 *   indistinguishable in effect from cancelling it — which `cancelRequisition`
 *   already does, and which does not pretend somebody reviewed it. Allowing it
 *   would put "reviewed and refused" on a document nobody reviewed, which is the
 *   audit trail lying in the direction that looks diligent.
 */
export async function rejectRequisition(
  ctx: TenantContext,
  id: string,
  input: RejectPurchaseRequisitionRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockRequisitionOrThrow(tx, id);
    if (existing.status !== 'SUBMITTED') {
      throw new ConflictError(
        existing.status === 'DRAFT'
          ? 'This requisition has not been submitted yet, so there is nothing to reject. The person who raised it can cancel it.'
          : `This requisition is already ${existing.status.toLowerCase()}.`
      );
    }
    assertBranchInScope(ctx, existing.branchId);
    assertNotOwnRequisition(existing, ctx);

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectedById: ctx.userId,
        rejectionReason: input.reason,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_requisition',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'REJECTED', reason: input.reason },
      ...options,
    });

    return toDetail(updated, ctx);
  });
}

/**
 * Withdraw it.
 *
 * ⚠️ REACHABLE FROM `DRAFT`, `SUBMITTED` AND `APPROVED`, AND NOT FROM `ORDERED`. An
 *   approved requisition that the branch no longer needs is withdrawn, which is
 *   ordinary; once a purchase order exists the commitment is to the SUPPLIER and
 *   cancelling the internal request would leave the order looking unauthorised.
 *   Cancel the order.
 */
export async function cancelRequisition(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<PurchaseRequisitionDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockRequisitionOrThrow(tx, id);
    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This requisition has already been cancelled.');
    }
    if (existing.status === 'ORDERED') {
      throw new ConflictError(
        'A purchase order has already been raised from this requisition, so it cannot be withdrawn. Cancel the order instead — the commitment is to the supplier now.'
      );
    }
    if (existing.status === 'REJECTED') {
      throw new ConflictError('This requisition was rejected, so there is nothing to withdraw.');
    }
    assertBranchInScope(ctx, existing.branchId);

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: ctx.userId },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_requisition',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'CANCELLED' },
      ...options,
    });

    return toDetail(updated, ctx);
  });
}
