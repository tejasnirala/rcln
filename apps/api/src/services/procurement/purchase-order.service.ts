/**
 * Purchase orders: the organization committing to buy (PI-4.4).
 *
 * ── THE SUPPLIER IS SNAPSHOTTED, AND FOR A DIFFERENT REASON THAN PI-3'S ─────
 * ⚠️ THIS IS **NOT** THE INVISIBILITY PROBLEM TRANSFERS HIT. `suppliers` is
 *   org-scoped, so a branch CAN read it; nothing here comes back NULL. The reason
 *   is the other one the invoice practitioner snapshot exists for: a purchase order
 *   is a document that was SENT to somebody, on a day, naming them. A supplier who
 *   changes their trading name or re-registers for GST next year must not silently
 *   rewrite what last year's orders said.
 *
 *   Both reasons produce the same column and it is worth knowing which applies,
 *   because the PI-3 one implies a policy cannot be weakened to fix it and this one
 *   does not.
 *
 * ── WHERE THE COST COMES FROM, IN ORDER ─────────────────────────────────────
 *   1. `unitCostBase` on the line, if the buyer stated one;
 *   2. `pricePerPackMinor / packQuantityBase`, if they quoted a pack price;
 *   3. the price book row named by `supplierProductId`, resolved AT ORDERING TIME;
 *   4. refused — a line with no price is an order nobody can approve.
 *
 * ⚠️ THE PRICE IS COPIED ONTO THE LINE AND NEVER RE-READ. A supplier's new price
 *   list must not restate what an issued order cost, and `supplier_products`
 *   carries `price_effective_from`/`_to` precisely so the two can be seen to
 *   differ.
 *
 * ── TOTALS ARE STORED, NOT DERIVED ON READ ──────────────────────────────────
 * Exactly as invoice totals are: a document states a total, and a total recomputed
 * on every read is a total that changes when a rounding rule does. Tax is whatever
 * the supplier charged and is never computed (PI-ADR-006).
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { unitCostFromPack, valueOf } from '@rcln/inventory';
import type {
  CancelPurchaseOrderRequest,
  ClosePurchaseOrderRequest,
  CreatePurchaseOrderRequest,
  PurchaseOrderDetail,
  PurchaseOrderLineDetail,
  PurchaseOrderLineRequest,
  PurchaseOrderListResponse,
  PurchaseOrderQuery,
  PurchaseOrderSummary,
  UpdatePurchaseOrderRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import {
  assertBranchInScope,
  assertNoDuplicateLines,
  fromDateString,
  resolveLocation,
  resolveProductForLine,
  resolveSupplierForDocument,
  toBase,
  toDateString,
  toMinorNumber,
  toQuantityString,
} from './shared.js';

const detailInclude = Prisma.validator<Prisma.PurchaseOrderInclude>()({
  branch: { select: { name: true } },
  requisition: { select: { requisitionNumber: true } },
  deliverToLocation: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  issuedBy: { select: { fullName: true } },
  lines: {
    include: {
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      supplierProduct: { select: { supplierSku: true } },
    },
    orderBy: { lineNumber: 'asc' },
  },
});

type DetailRow = Prisma.PurchaseOrderGetPayload<{ include: typeof detailInclude }>;
type LineRow = DetailRow['lines'][number];

function toLineDetail(line: LineRow): PurchaseOrderLineDetail {
  return {
    id: line.id,
    productId: line.productId,
    productCode: line.product.code,
    productName: line.product.name,
    baseUnitSymbol: line.product.baseUnit.symbol,
    supplierProductId: line.supplierProductId,
    supplierSku: line.supplierProduct?.supplierSku ?? null,
    orderedQuantityBase: toQuantityString(line.orderedQuantityBase),
    receivedQuantityBase: toQuantityString(line.receivedQuantityBase),
    /*
     * ⚠️ `Prisma.Decimal.sub`, NOT `Number(a) - Number(b)`. These are
     *   `Decimal(18,6)` and a double has already lost the tail before the
     *   subtraction runs. This is the number a buyer chases a short shipment with.
     */
    outstandingQuantityBase: line.orderedQuantityBase.sub(line.receivedQuantityBase).toString(),
    quantityEntered: toQuantityString(line.quantityEntered),
    unitSymbol: line.unit.symbol,
    unitCostBase: toMinorNumber(line.unitCostBase),
    pricePerPackMinor:
      line.pricePerPackMinor === null ? null : toMinorNumber(line.pricePerPackMinor),
    packQuantityBase:
      line.packQuantityBase === null ? null : toQuantityString(line.packQuantityBase),
    lineSubtotalMinor: toMinorNumber(line.lineSubtotalMinor),
    taxRateBps: line.taxRateBps,
    taxAmountMinor: toMinorNumber(line.taxAmountMinor),
    lineTotalMinor: toMinorNumber(line.lineTotalMinor),
    notes: line.notes,
  };
}

function toSummary(row: DetailRow): PurchaseOrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    supplierId: row.supplierId,
    // The snapshot, not a join to today's supplier row. See the file header.
    supplierName: row.supplierName,
    supplierTaxNumber: row.supplierTaxNumber,
    requisitionId: row.requisitionId,
    requisitionNumber: row.requisition?.requisitionNumber ?? null,
    status: row.status,
    currency: row.currency,
    expectedDate: toDateString(row.expectedDate),
    lineCount: row.lines.length,
    outstandingLineCount: row.lines.filter((l) =>
      l.orderedQuantityBase.greaterThan(l.receivedQuantityBase)
    ).length,
    subtotalMinor: toMinorNumber(row.subtotalMinor),
    taxAmountMinor: toMinorNumber(row.taxAmountMinor),
    totalMinor: toMinorNumber(row.totalMinor),
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.fullName,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    issuedByName: row.issuedBy?.fullName ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

function toDetail(row: DetailRow): PurchaseOrderDetail {
  return {
    ...toSummary(row),
    deliverToLocationId: row.deliverToLocationId,
    deliverToLocationName: row.deliverToLocation?.name ?? null,
    terms: row.terms,
    notes: row.notes,
    closureReason: row.closureReason,
    cancellationReason: row.cancellationReason,
    lines: row.lines.map(toLineDetail),
  };
}

async function findOrderOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.purchaseOrder.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Purchase order');
  return row;
}

/** The header's row lock. Every path that CHANGES state starts here — see the
 *  requisition service for the full argument, which is identical. */
async function lockOrderOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "purchase_orders" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Purchase order');
  return findOrderOrThrow(tx, id);
}

interface ResolvedLine {
  productId: string;
  supplierProductId: string | null;
  orderedQuantityBase: string;
  quantityEntered: string;
  unitId: string;
  unitCostBase: bigint;
  pricePerPackMinor: bigint | null;
  packQuantityBase: string | null;
  lineSubtotalMinor: bigint;
  taxRateBps: number | null;
  taxAmountMinor: bigint;
  lineTotalMinor: bigint;
  notes: string | null;
}

/**
 * Where the cost comes from, in the order stated in the file header.
 *
 * ⚠️ THE PRICE BOOK IS CONSULTED BY DATE, NOT JUST BY ID. A `supplierProductId`
 *   whose price ended last month is a stale screen, and taking its price anyway
 *   would order at a price the supplier has withdrawn. Refused with a sentence
 *   naming the date, which is something a buyer can act on.
 */
async function resolveUnitCost(
  tx: TxClient,
  line: PurchaseOrderLineRequest,
  supplierId: string,
  productName: string,
  currency: string
): Promise<{
  unitCostBase: bigint;
  pricePerPackMinor: bigint | null;
  packQuantityBase: string | null;
}> {
  if (line.unitCostBase != null) {
    return {
      unitCostBase: BigInt(line.unitCostBase),
      pricePerPackMinor: line.pricePerPackMinor != null ? BigInt(line.pricePerPackMinor) : null,
      packQuantityBase: line.packQuantityBase ?? null,
    };
  }

  if (line.pricePerPackMinor != null && line.packQuantityBase != null) {
    return {
      unitCostBase: BigInt(unitCostFromPack(line.pricePerPackMinor, line.packQuantityBase)),
      pricePerPackMinor: BigInt(line.pricePerPackMinor),
      packQuantityBase: line.packQuantityBase,
    };
  }

  if (line.supplierProductId != null) {
    const priced = await tx.supplierProduct.findUnique({
      where: { id: line.supplierProductId },
      select: {
        id: true,
        supplierId: true,
        productId: true,
        supplierSku: true,
        quantityPerPack: true,
        pricePerPackMinor: true,
        currency: true,
        isActive: true,
        deletedAt: true,
        priceEffectiveFrom: true,
        priceEffectiveTo: true,
      },
    });
    if (!priced || priced.deletedAt) throw new NotFoundError('Supplier product');
    if (priced.supplierId !== supplierId) {
      throw new ValidationError(
        `${priced.supplierSku} is another supplier's catalogue entry, so it cannot price a line on this order.`
      );
    }
    if (priced.productId !== line.productId) {
      throw new ValidationError(
        `${priced.supplierSku} is not the supplier's code for ${productName}.`
      );
    }
    if (!priced.isActive) {
      throw new ValidationError(
        `${priced.supplierSku} is no longer offered, so it cannot price this line. Enter the price you have been quoted.`
      );
    }

    const today = new Date();
    if (priced.priceEffectiveFrom > today) {
      throw new ValidationError(
        `The price recorded for ${priced.supplierSku} does not take effect until ${priced.priceEffectiveFrom.toISOString().slice(0, 10)}. Enter the price you are paying today.`
      );
    }
    if (priced.priceEffectiveTo !== null && priced.priceEffectiveTo < today) {
      throw new ValidationError(
        `The price recorded for ${priced.supplierSku} ended on ${priced.priceEffectiveTo.toISOString().slice(0, 10)}. Update the price book or enter the price you have been quoted.`
      );
    }
    /*
     * ⚠️ A CURRENCY MISMATCH IS REFUSED RATHER THAN CONVERTED. This programme
     *   applies no FX policy (see KNOWN_ISSUES), so taking a USD price onto an INR
     *   order would put a number on the document in a currency it does not claim
     *   to be in — and every total below would add it to rupees.
     */
    if (priced.currency !== currency) {
      throw new ValidationError(
        `${priced.supplierSku} is priced in ${priced.currency} and this order is in ${currency}. Raise the order in ${priced.currency}, or enter the price in ${currency} yourself — nothing here converts between currencies.`
      );
    }

    return {
      unitCostBase: BigInt(
        unitCostFromPack(
          toMinorNumber(priced.pricePerPackMinor),
          toQuantityString(priced.quantityPerPack)
        )
      ),
      pricePerPackMinor: priced.pricePerPackMinor,
      packQuantityBase: toQuantityString(priced.quantityPerPack),
    };
  }

  throw new ValidationError(
    `${productName} has no price on this order. Pick the supplier's catalogue entry, or enter what you are paying — an order line with no price is one nobody can approve.`
  );
}

async function resolveLines(
  tx: TxClient,
  lines: PurchaseOrderLineRequest[],
  supplierId: string,
  currency: string
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const product = await resolveProductForLine(tx, line.productId);
    const orderedQuantityBase = await toBase(tx, product, line);
    const cost = await resolveUnitCost(tx, line, supplierId, product.name, currency);

    /*
     * ⚠️ THE LINE SUBTOTAL IS `unitCostBase × quantity`, ROUNDED ONCE, THROUGH THE
     *   PACKAGE. `valueOf` does the multiplication as an exact rational over
     *   `bigint` and rounds half-up at the end — the same function the moving
     *   average uses, so an order and the valuation of what it delivers cannot
     *   round differently.
     */
    const lineSubtotalMinor = valueOf(cost.unitCostBase, orderedQuantityBase);
    const taxAmountMinor = BigInt(line.taxAmountMinor ?? 0);

    resolved.push({
      productId: product.id,
      supplierProductId: line.supplierProductId ?? null,
      orderedQuantityBase,
      quantityEntered: line.quantity,
      unitId: line.unitId ?? product.baseUnitId,
      unitCostBase: cost.unitCostBase,
      pricePerPackMinor: cost.pricePerPackMinor,
      packQuantityBase: cost.packQuantityBase,
      lineSubtotalMinor,
      taxRateBps: line.taxRateBps ?? null,
      taxAmountMinor,
      lineTotalMinor: lineSubtotalMinor + taxAmountMinor,
      notes: line.notes ?? null,
    });
  }

  assertNoDuplicateLines(
    resolved.map((l) => l.productId),
    'The same product appears on this order twice. Combine them into one line — two lines for one product could mean the total or a duplicate, and neither should be guessed.'
  );

  return resolved;
}

function totalsOf(lines: ResolvedLine[]): {
  subtotalMinor: bigint;
  taxAmountMinor: bigint;
  totalMinor: bigint;
} {
  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineSubtotalMinor, 0n);
  const taxAmountMinor = lines.reduce((sum, l) => sum + l.taxAmountMinor, 0n);
  return { subtotalMinor, taxAmountMinor, totalMinor: subtotalMinor + taxAmountMinor };
}

function lineData(
  ctx: TenantContext,
  branchId: string,
  purchaseOrderId: string,
  lines: ResolvedLine[]
): Prisma.PurchaseOrderLineCreateManyInput[] {
  return lines.map((l, index) => ({
    organizationId: ctx.organizationId,
    branchId,
    purchaseOrderId,
    // 1-based, and it IS the order the document renders in. See the model.
    lineNumber: index + 1,
    productId: l.productId,
    supplierProductId: l.supplierProductId,
    orderedQuantityBase: l.orderedQuantityBase,
    quantityEntered: l.quantityEntered,
    unitId: l.unitId,
    unitCostBase: l.unitCostBase,
    pricePerPackMinor: l.pricePerPackMinor,
    packQuantityBase: l.packQuantityBase,
    lineSubtotalMinor: l.lineSubtotalMinor,
    taxRateBps: l.taxRateBps,
    taxAmountMinor: l.taxAmountMinor,
    lineTotalMinor: l.lineTotalMinor,
    notes: l.notes,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPurchaseOrders(
  ctx: TenantContext,
  query: PurchaseOrderQuery
): Promise<PurchaseOrderListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.supplierId !== undefined ? { supplierId: query.supplierId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      /*
       * "What are we still waiting for", as the two statuses that mean it.
       *
       * ⚠️ NOT `received < ordered` ON THE LINES, AND NOT BECAUSE THAT WOULD BE
       *   WRONG. Prisma's filter language cannot compare one column to another, and
       *   the two are equivalent by construction: `postReceipt` re-reads the lines
       *   and flips the status in the same transaction that fills the last one. The
       *   same call `listTransfers` made, with the same caveat — if those two ever
       *   diverge this filter is wrong, which is why it is named here.
       */
      ...(query.outstandingOnly
        ? { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] as const } }
        : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { orderNumber: { contains: query.q, mode: 'insensitive' } },
              { supplierName: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.purchaseOrder.count({ where }),
      tx.purchaseOrder.findMany({
        where,
        include: detailInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      purchaseOrders: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getPurchaseOrder(
  ctx: TenantContext,
  id: string
): Promise<PurchaseOrderDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findOrderOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  ctx: TenantContext,
  input: CreatePurchaseOrderRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseOrderDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const supplier = await resolveSupplierForDocument(tx, input.supplierId);

    /*
     * ⚠️ THE CURRENCY IS DECIDED HERE, ONCE, AND EVERY AMOUNT ON THE DOCUMENT IS IN
     *   IT. A supplier with no default and a caller who names none is refused
     *   rather than defaulted to the clinic's currency: a number with no currency is
     *   a number that will be added to a different one, which is the same rule
     *   `batches` enforces with a CHECK.
     */
    const currency = input.currency ?? supplier.currency;
    if (currency == null) {
      throw new ValidationError(
        `${supplier.name} has no currency recorded, so say which currency this order is in. An amount with no currency is one that will eventually be added to a different one.`
      );
    }

    if (input.requisitionId != null) {
      const requisition = await tx.purchaseRequisition.findUnique({
        where: { id: input.requisitionId },
        select: { id: true, branchId: true, status: true, requisitionNumber: true },
      });
      if (!requisition) throw new NotFoundError('Requisition');
      /*
       * ⚠️ ONLY AN **APPROVED** REQUISITION MAY BECOME AN ORDER, AND THIS IS WHERE
       *   THE APPROVAL SPLIT ACTUALLY BITES. Without this check the two permission
       *   codes and the CHECK constraint are decoration: a buyer could cite a draft
       *   requisition nobody has looked at, and the order would carry a link that
       *   makes it look authorised.
       */
      if (requisition.status !== 'APPROVED') {
        throw new ValidationError(
          requisition.status === 'ORDERED'
            ? `Requisition ${requisition.requisitionNumber ?? ''} has already been ordered.`.trim()
            : `Requisition ${requisition.requisitionNumber ?? ''} is ${requisition.status.toLowerCase()} and has not been approved, so an order cannot be raised from it.`.trim()
        );
      }
      if (requisition.branchId !== input.branchId) {
        throw new ValidationError(
          'This requisition was raised at a different branch. An order delivers to the branch that asked for the stock.'
        );
      }
    }

    if (input.deliverToLocationId != null) {
      await resolveLocation(tx, input.branchId, input.deliverToLocationId, 'be delivered to');
    }

    const lines = await resolveLines(tx, input.lines, supplier.id, currency);
    const totals = totalsOf(lines);

    const header = await tx.purchaseOrder.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        supplierId: supplier.id,
        requisitionId: input.requisitionId ?? null,
        supplierName: supplier.name,
        supplierTaxNumber: supplier.taxNumber,
        currency,
        expectedDate: input.expectedDate != null ? fromDateString(input.expectedDate) : null,
        deliverToLocationId: input.deliverToLocationId ?? null,
        terms: input.terms ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
        ...totals,
      },
      select: { id: true },
    });

    await tx.purchaseOrderLine.createMany({
      data: lineData(ctx, input.branchId, header.id, lines),
    });

    const created = await findOrderOrThrow(tx, header.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'purchase_order',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        supplierId: supplier.id,
        currency,
        lineCount: created.lines.length,
        totalMinor: toMinorNumber(created.totalMinor),
      },
      ...options,
    });

    return toDetail(created);
  });
}

/**
 * Edit a DRAFT.
 *
 * ⚠️ ONLY A DRAFT. An issued order has been sent to a supplier who is acting on it,
 *   and its lines may already have receipts against them — replacing those lines
 *   would leave receipt lines citing order lines that no longer exist and a
 *   `received_quantity_base` accumulated against nothing. An issued order is
 *   corrected by receiving what actually arrived and closing the remainder, which
 *   is what those two operations are for.
 */
export async function updatePurchaseOrder(
  ctx: TenantContext,
  id: string,
  input: UpdatePurchaseOrderRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseOrderDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockOrderOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        `This order has already been ${existing.status === 'CANCELLED' ? 'cancelled' : 'issued'}, so its lines cannot be changed. Receive what arrives and close the remainder with a reason.`
      );
    }
    assertBranchInScope(ctx, existing.branchId);

    if (input.deliverToLocationId != null) {
      await resolveLocation(tx, existing.branchId, input.deliverToLocationId, 'be delivered to');
    }

    let totals: ReturnType<typeof totalsOf> | undefined;
    if (input.lines !== undefined) {
      const lines = await resolveLines(tx, input.lines, existing.supplierId, existing.currency);
      totals = totalsOf(lines);
      await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
      await tx.purchaseOrderLine.createMany({
        data: lineData(ctx, existing.branchId, id, lines),
      });
    }

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(input.expectedDate !== undefined
          ? {
              expectedDate: input.expectedDate === null ? null : fromDateString(input.expectedDate),
            }
          : {}),
        ...(input.deliverToLocationId !== undefined
          ? { deliverToLocationId: input.deliverToLocationId }
          : {}),
        ...(input.terms !== undefined ? { terms: input.terms } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(totals ?? {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_order',
      entityId: id,
      branchId: existing.branchId,
      before: {
        lineCount: existing.lines.length,
        totalMinor: toMinorNumber(existing.totalMinor),
      },
      after: { lineCount: updated.lines.length, totalMinor: toMinorNumber(updated.totalMinor) },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Commit it, and burn the number.
 *
 * ⚠️ THE NUMBER IS ISSUED HERE AND THE SUPPLIER WILL QUOTE IT BACK ON THEIR
 *   INVOICE, WHICH IS WHY IT IS NOT ISSUED AT CREATE. A gap in this series is a gap
 *   an auditor or a supplier will ask about. `issueNumber` is transactional, so an
 *   issue that rolls back burns nothing.
 *
 * ⚠️ AND THE REQUISITION MOVES TO `ORDERED` IN THE SAME TRANSACTION. Two states
 *   because approval and commitment are two decisions — an approved requisition
 *   nobody has ordered is the most useful thing on a buyer's screen, and it stops
 *   being that the moment this commits.
 */
export async function issuePurchaseOrder(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<PurchaseOrderDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockOrderOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError('This order has already been issued.');
    }
    assertBranchInScope(ctx, existing.branchId);
    if (existing.lines.length === 0) {
      throw new ValidationError('This order has no lines, so there is nothing to order.');
    }

    /*
     * ⚠️ THE SUPPLIER'S STATUS IS RE-CHECKED HERE, HAVING BEEN CHECKED AT CREATE.
     *   The two moments are days apart and a supplier gets blacklisted in between —
     *   which is PI-3's third CRITICAL restated: a fact a document asserts about the
     *   world has to be re-asserted when it ACTS. Creating a draft asserts nothing;
     *   issuing it sends an order.
     */
    await resolveSupplierForDocument(tx, existing.supplierId);

    const number = await issueNumber(tx, ctx, {
      type: 'PURCHASE_ORDER',
      branchId: existing.branchId,
      periodKey: '',
      prefix: 'PO-',
    });

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        orderNumber: number.formatted,
        status: 'ISSUED',
        issuedAt: new Date(),
        issuedById: ctx.userId,
      },
      include: detailInclude,
    });

    if (existing.requisitionId !== null) {
      /*
       * ⚠️ A CONDITIONAL `updateMany` RATHER THAN AN `update`, WHICH IS PI-3'S
       *   RESERVATION CLAIM PATTERN. Two orders raised from one approved requisition
       *   race here; the `status: 'APPROVED'` predicate means the second matches
       *   zero rows instead of overwriting the first, and the requisition ends up
       *   ORDERED exactly once. It is not an error for the second to lose — both
       *   orders are legitimate, and a requisition may honestly be split across two
       *   suppliers.
       */
      await tx.purchaseRequisition.updateMany({
        where: { id: existing.requisitionId, status: 'APPROVED' },
        data: { status: 'ORDERED' },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_order',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'ISSUED', orderNumber: updated.orderNumber },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Stop waiting for the rest of it.
 *
 * ⚠️ `CLOSED` IS NOT `RECEIVED`, AND WITHOUT IT A BUYER'S ONLY OPTIONS FOR A SHORT
 *   SHIPMENT ARE A PERMANENT PHANTOM EXPECTATION ON THE "WHAT ARE WE WAITING FOR"
 *   SCREEN OR A FALSIFIED RECEIPT. It writes no ledger row and moves no stock: it
 *   records a judgement that nothing more is coming, which is why the reason is
 *   required by the contract AND by the
 *   `purchase_orders_closure_complete` CHECK.
 */
export async function closePurchaseOrder(
  ctx: TenantContext,
  id: string,
  input: ClosePurchaseOrderRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseOrderDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockOrderOrThrow(tx, id);
    assertBranchInScope(ctx, existing.branchId);

    if (existing.status === 'DRAFT') {
      throw new ConflictError(
        'This order has not been issued, so there is nothing outstanding to close. Cancel it instead.'
      );
    }
    if (existing.status === 'CLOSED') throw new ConflictError('This order is already closed.');
    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This order was cancelled, so there is nothing to close.');
    }
    if (existing.status === 'RECEIVED') {
      throw new ConflictError(
        'This order was received in full, so there is nothing outstanding to close.'
      );
    }

    const now = new Date();
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: now,
        closedById: ctx.userId,
        closureReason: input.reason,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_order',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'CLOSED', reason: input.reason },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Kill it.
 *
 * ⚠️ ONLY BEFORE ANYTHING HAS BEEN RECEIVED, AND THAT IS THE WHOLE SAFETY OF THIS
 *   FUNCTION. Unlike a transfer, a purchase order holds no stock of its own — it is
 *   paperwork, and cancelling one writes no compensating movement because there is
 *   nothing to compensate. But an order with receipts against it has lots on
 *   shelves and costs in a moving average that cite it, and marking it cancelled
 *   would say the clinic never ordered what it is holding. Partially received
 *   orders are CLOSED, which is exactly the distinction that status exists for.
 */
export async function cancelPurchaseOrder(
  ctx: TenantContext,
  id: string,
  input: CancelPurchaseOrderRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseOrderDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockOrderOrThrow(tx, id);
    assertBranchInScope(ctx, existing.branchId);

    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This order has already been cancelled.');
    }
    if (existing.status === 'CLOSED') {
      throw new ConflictError('This order is closed, so there is nothing to cancel.');
    }

    const received = existing.lines.some((l) => l.receivedQuantityBase.greaterThan(0));
    if (received) {
      throw new ConflictError(
        'Part of this order has already been received, so it cannot be cancelled — the stock is on a shelf and the clinic did order it. Close it instead, which records that nothing more is coming.'
      );
    }

    const updated = await tx.purchaseOrder.update({
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
      entityType: 'purchase_order',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'CANCELLED', reason: input.reason },
      ...options,
    });

    return toDetail(updated);
  });
}
