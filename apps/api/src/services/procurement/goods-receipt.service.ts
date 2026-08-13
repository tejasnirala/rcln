/**
 * Goods receipts: what actually turned up (PI-4.5, PI-4.6).
 *
 * ── THIS IS WHERE THE TRUTH ENTERS, AND WHERE IT IS HARDEST TO CORRECT ──────
 *
 *   supplier ──▶ goods_receipt ──POST──▶ batches + serials
 *                      │                     │
 *                      └── PURCHASE_RECEIPT ─┴──▶ stock_ledger ──▶ stock_balances
 *                                                       (trigger)
 *
 * Everything downstream is downstream of this file. The lot number a recall will
 * search for, the expiry the sweep will act on, the serial a device history hangs
 * off, and the cost every valuation will sum — all first written here, by somebody
 * standing at a loading bay with a box.
 *
 * ── WHAT POST ENFORCES, AND WHERE EACH RULE ACTUALLY LIVES ──────────────────
 *
 *   the product's tracking mode      `recordMovementIn` + a CHECK on the leg
 *   an expiry on a controlled product  HERE, with a sentence naming the product
 *   an already-expired lot refused      HERE — see `assertLotIsReceivable`
 *   over-receipt beyond tolerance       HERE, from a SETTING (PI-ADR-015)
 *   one serial per line, quantity one   a CHECK on `goods_receipt_lines`
 *
 * ⚠️ THE OVER-RECEIPT RULE IS THE ONE WITH A SINGLE LAYER, AND IT IS THE ONLY ONE
 *   THAT COULD NOT HAVE A SECOND. A CHECK constraint cannot read a setting, and the
 *   tolerance is a setting because suppliers legitimately over-ship and how much
 *   slack is acceptable differs per clinic. It has its own integration test for
 *   that reason.
 *
 * ── EVERY LESSON PI-3 PAID FOR IS APPLIED HERE ──────────────────────────────
 *   ⚠️ THE HEADER'S ROW LOCK FIRST (`lockReceiptOrThrow`). Two concurrent posts both
 *     see DRAFT, both write a full set of legs, and the branch is credited twice
 *     for one delivery. Nothing raises.
 *   ⚠️ THE LOOP ACCUMULATES WITHIN THE REQUEST (`takenThisRequest` in
 *     `assertWithinTolerance`). PI-3's receipt loop measured every entry against a
 *     snapshot loaded once and minted stock — and `verifyBalances()` agreed,
 *     because both legs were genuine ledger rows.
 *   ⚠️ FACTS ARE RE-ASSERTED AT THE MOMENT OF ACTING. The supplier's status, the
 *     shelf's activity and the lot's expiry are all re-read at POST, days after the
 *     draft asserted them.
 *
 * NO PHI. A receipt CREATES serials and never reads a patient link.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { apportionByValue, unitCostFromPack, valueOf } from '@rcln/inventory';
import type {
  CancelGoodsReceiptRequest,
  CreateGoodsReceiptRequest,
  DecideGoodsReceiptQualityRequest,
  GoodsReceiptDetail,
  GoodsReceiptLineDetail,
  GoodsReceiptLineRequest,
  GoodsReceiptListResponse,
  GoodsReceiptQuery,
  GoodsReceiptSummary,
  UpdateGoodsReceiptRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { recordMovementIn } from '../inventory/movement.service.js';
import { consultForStockMovement } from '../regulatory/consult.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { rollReceiptIntoAverage } from './costing.service.js';
import {
  assertBranchInScope,
  assertNoDuplicateLines,
  fromDateString,
  resolveLocation,
  resolveProductForLine,
  resolveReceivingPolicy,
  resolveSupplierForDocument,
  toBase,
  toDateString,
  toMinorNumber,
  toQuantityString,
  type ProductForLine,
} from './shared.js';

const detailInclude = Prisma.validator<Prisma.GoodsReceiptInclude>()({
  branch: { select: { name: true } },
  supplier: { select: { code: true } },
  purchaseOrder: { select: { orderNumber: true } },
  location: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  postedBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    include: {
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      manufacturer: { select: { name: true } },
      qualityDecidedBy: { select: { fullName: true } },
    },
    orderBy: { lineNumber: 'asc' },
  },
});

type DetailRow = Prisma.GoodsReceiptGetPayload<{ include: typeof detailInclude }>;
type LineRow = DetailRow['lines'][number];

function toLineDetail(line: LineRow): GoodsReceiptLineDetail {
  return {
    id: line.id,
    productId: line.productId,
    productCode: line.product.code,
    productName: line.product.name,
    baseUnitSymbol: line.product.baseUnit.symbol,
    purchaseOrderLineId: line.purchaseOrderLineId,
    batchId: line.batchId,
    serialId: line.serialId,
    receivedQuantityBase: toQuantityString(line.receivedQuantityBase),
    rejectedQuantityBase: toQuantityString(line.rejectedQuantityBase),
    quantityEntered: toQuantityString(line.quantityEntered),
    unitSymbol: line.unit.symbol,
    /*
     * ⚠️ THE LINE'S OWN SNAPSHOT, NOT A JOIN TO `batches`, AND THE JOIN IS WHAT
     *   PI-3 GOT WRONG TWICE. Here it is worse than there: a DRAFT has no lot row
     *   at all, so the join is NULL for every unposted receipt — and the person
     *   keying a delivery in is exactly the person who needs to read back the lot
     *   number and expiry they just typed off the pack.
     */
    lotNumber: line.lotNumber,
    manufacturedOn: toDateString(line.manufacturedOn),
    expiresOn: toDateString(line.expiresOn),
    retestOn: toDateString(line.retestOn),
    manufacturerId: line.manufacturerId,
    manufacturerName: line.manufacturer?.name ?? null,
    serialNumber: line.serialNumber,
    unitCostBase: toMinorNumber(line.unitCostBase),
    currency: line.currency,
    landedCostMinor: toMinorNumber(line.landedCostMinor),
    lineSubtotalMinor: toMinorNumber(line.lineSubtotalMinor),
    taxRateBps: line.taxRateBps,
    taxAmountMinor: toMinorNumber(line.taxAmountMinor),
    lineTotalMinor: toMinorNumber(line.lineTotalMinor),
    qualityStatus: line.qualityStatus,
    qualityDecidedAt: line.qualityDecidedAt?.toISOString() ?? null,
    qualityDecidedByName: line.qualityDecidedBy?.fullName ?? null,
    qualityNotes: line.qualityNotes,
    notes: line.notes,
  };
}

function toSummary(row: DetailRow): GoodsReceiptSummary {
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    supplierId: row.supplierId,
    // The snapshot. See the purchase-order service for which of the two reasons
    // applies here and why the difference matters.
    supplierName: row.supplierName,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNumber: row.purchaseOrder?.orderNumber ?? null,
    status: row.status,
    locationId: row.locationId,
    locationName: row.location.name,
    receivedAt: row.receivedAt.toISOString(),
    currency: row.currency,
    supplierInvoiceNumber: row.supplierInvoiceNumber,
    supplierInvoiceDate: toDateString(row.supplierInvoiceDate),
    lineCount: row.lines.length,
    awaitingQualityLineCount: row.lines.filter((l) => l.qualityStatus === 'PENDING').length,
    goodsValueMinor: toMinorNumber(row.goodsValueMinor),
    taxAmountMinor: toMinorNumber(row.taxAmountMinor),
    totalMinor: toMinorNumber(row.totalMinor),
    qualityHoldRequired: row.qualityHoldRequired,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.fullName,
    postedAt: row.postedAt?.toISOString() ?? null,
    postedByName: row.postedBy?.fullName ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

function toDetail(row: DetailRow): GoodsReceiptDetail {
  return {
    ...toSummary(row),
    freightMinor: toMinorNumber(row.freightMinor),
    dutyMinor: toMinorNumber(row.dutyMinor),
    handlingMinor: toMinorNumber(row.handlingMinor),
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    cancelledByName: row.cancelledBy?.fullName ?? null,
    lines: row.lines.map(toLineDetail),
  };
}

async function findReceiptOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.goodsReceipt.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Goods receipt');
  return row;
}

/** The header's row lock. See the requisition service for the full argument. */
async function lockReceiptOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "goods_receipts" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Goods receipt');
  return findReceiptOrThrow(tx, id);
}

/**
 * The ORDER's row lock, taken by whichever receipt is posting against it.
 *
 * ⚠️ LOCKING THE RECEIPT HEADER IS NOT ENOUGH, AND THAT GAP WAS A REAL HOLE IN THE
 *   FIRST VERSION OF THIS FILE. Two receipts against one purchase order are two
 *   DIFFERENT `goods_receipts` rows, so `lockReceiptOrThrow` serialises nothing
 *   between them — and both the over-receipt decision and `refreshOrderStatus` read
 *   the order's lines and then write. Both are read-then-write races, which is PI-3's
 *   entire lesson surviving in the one place this phase claimed to have closed it:
 *
 *     TOLERANCE   PO for 100, tolerance 0%. Two drafts of 100 posted concurrently.
 *                 Both read `received_quantity_base = 0`, both pass
 *                 `assertWithinTolerance`, both `increment`. 200 units of real stock
 *                 land against a 100-unit order — and
 *                 `purchase_order_lines_quantities_valid` deliberately has NO upper
 *                 bound (the tolerance is a setting a CHECK cannot read), so the
 *                 database does not catch it either.
 *
 *     STATUS      Receipt A completes the order and sets RECEIVED. Receipt B read the
 *                 lines before A committed, computed `fullyReceived = false`, and its
 *                 UPDATE lands after A's commit — overwriting RECEIVED with
 *                 PARTIALLY_RECEIVED. The order then sits on the "what are we waiting
 *                 for" screen for ever with nothing outstanding.
 *
 * ⚠️ THE HEADER, NOT THE LINES, AND DELIBERATELY SO. One lock per receipt rather than
 *   one per line means the acquisition order cannot vary with the order the lines
 *   happen to be in — the deadlock the engine's `lockBuckets` sorts to avoid. A
 *   receipt cites exactly one order, and the sequence is always receipt-then-order,
 *   so no cycle is reachable.
 *
 * ⚠️ RLS STILL APPLIES, so an order at a branch the caller cannot see returns no row.
 *   That is NOT an error here: a receipt without a readable order is the no-order
 *   case, which `postGoodsReceipt` handles, and the tolerance check is skipped for it
 *   anyway because the lines cite no order line.
 */
async function lockPurchaseOrder(tx: TxClient, purchaseOrderId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "purchase_orders" WHERE "id" = ${purchaseOrderId}::uuid FOR UPDATE
  `;
}

// ---------------------------------------------------------------------------
// Line resolution
// ---------------------------------------------------------------------------

interface ResolvedLine {
  productId: string;
  purchaseOrderLineId: string | null;
  receivedQuantityBase: string;
  quantityEntered: string;
  unitId: string;
  lotNumber: string | null;
  manufacturedOn: Date | null;
  expiresOn: Date | null;
  retestOn: Date | null;
  manufacturerId: string | null;
  serialNumber: string | null;
  unitCostBase: bigint;
  currency: string;
  lineSubtotalMinor: bigint;
  taxRateBps: number | null;
  taxAmountMinor: bigint;
  lineTotalMinor: bigint;
  notes: string | null;
}

/**
 * The lot's identity, against what the product requires.
 *
 * ⚠️ THE TRACKING-MODE CHECKS ARE HERE **AND** ON THE LEDGER LEG, AND BOTH ARE
 *   WANTED. The leg's CHECK constraint (PI-ADR-014) is what makes a serial-less
 *   `SERIAL` movement unrepresentable; this is what makes the DRAFT unsaveable, so
 *   the person keying the delivery in finds out while they still have the pack in
 *   their hand rather than at the moment they press Post.
 *
 * ⚠️ THE EXPIRY CHECK HAS **NO** SECOND LAYER, AND IT CANNOT HAVE ONE. Whether a
 *   product is expiry-controlled is a column on `products`, and a CHECK constraint
 *   on `goods_receipt_lines` cannot join to it — the same reason `tracking_mode` is
 *   denormalised onto the ledger. It could be denormalised here too; it is not,
 *   because unlike the ledger a receipt line is never read as history in isolation.
 *   Written down rather than pretended away.
 */
function assertIdentityForProduct(product: ProductForLine, line: GoodsReceiptLineRequest): void {
  const mode = product.trackingMode;
  const needsLot = mode === 'LOT_BATCH' || mode === 'LOT_AND_SERIAL';
  const needsSerial = mode === 'SERIAL' || mode === 'LOT_AND_SERIAL';

  if (needsLot && (line.lotNumber == null || line.lotNumber.length === 0)) {
    throw new ValidationError(
      `${product.name} is batch-tracked, so every line of it needs the lot number printed on the pack.`
    );
  }
  if (needsSerial && (line.serialNumber == null || line.serialNumber.length === 0)) {
    throw new ValidationError(
      `${product.name} is serial-tracked, so every line of it needs one serial number — one line per unit, because a serial is one physical device.`
    );
  }
  if (product.isExpiryControlled && line.expiresOn == null) {
    throw new ValidationError(
      `${product.name} is expiry-controlled, so the expiry date on the pack has to be recorded. A pack with no expiry recorded is one the expiry sweep can never act on.`
    );
  }
  if (!needsLot && line.lotNumber != null) {
    throw new ValidationError(
      `${product.name} is not batch-tracked, so it has no lot to record. Remove the lot number, or change the product's tracking mode in the catalogue.`
    );
  }
  if (!needsSerial && line.serialNumber != null) {
    throw new ValidationError(
      `${product.name} is not serial-tracked, so it has no serial number to record.`
    );
  }
}

/**
 * A lot that may be received at all.
 *
 * ⚠️ AN ALREADY-EXPIRED LOT IS REFUSED OUTRIGHT, AND THIS IS THE CHECK. Receiving
 *   stock that is dead on arrival puts it in the AVAILABLE bucket for the nightly
 *   sweep to find and expire — which reads, for ever, as a clinic that let it
 *   expire on the shelf. The supplier sent short-dated goods; that is a
 *   conversation with them, not a ledger row.
 *
 * ⚠️ COMPARED IN THE **BRANCH'S** TIMEZONE, NEVER `new Date()` AGAINST A UTC
 *   MIDNIGHT (invariant 6). A lot dated the 31st is good THROUGH the 31st at the
 *   clinic, and a container-based comparison would expire it up to a day early or
 *   late depending on where the server is. The expiry sweep does exactly this with
 *   `AT TIME ZONE b.timezone`; this is that comparison, done once, in SQL.
 */
async function assertLotIsReceivable(
  tx: TxClient,
  branchId: string,
  productName: string,
  expiresOn: Date | null
): Promise<void> {
  if (expiresOn === null) return;

  const rows = await tx.$queryRaw<{ expired: boolean }[]>`
    SELECT ${expiresOn}::date < (now() AT TIME ZONE b."timezone")::date AS expired
      FROM "branches" b
     WHERE b."id" = ${branchId}::uuid
  `;
  if (rows[0]?.expired === true) {
    throw new ValidationError(
      `${productName} is being received with an expiry of ${expiresOn.toISOString().slice(0, 10)}, which has already passed at this branch. Expired stock cannot be received — take it up with the supplier, because receiving it would record the clinic as having let it expire.`
    );
  }
}

async function resolveLines(
  tx: TxClient,
  branchId: string,
  purchaseOrderId: string | null,
  currency: string,
  lines: GoodsReceiptLineRequest[]
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const product = await resolveProductForLine(tx, line.productId);
    assertIdentityForProduct(product, line);

    const receivedQuantityBase = await toBase(tx, product, line);

    if (line.manufacturerId != null) {
      const manufacturer = await tx.manufacturer.findUnique({
        where: { id: line.manufacturerId },
        select: { id: true, deletedAt: true },
      });
      if (!manufacturer || manufacturer.deletedAt) throw new NotFoundError('Manufacturer');
    }

    /*
     * ⚠️ THE ORDER LINE IS CHECKED TO BE ON **THIS** ORDER AND FOR **THIS** PRODUCT.
     *   The composite FK proves only that it belongs to this tenant and this branch;
     *   a receipt line citing another order's line would accumulate a received
     *   quantity against a delivery nobody made, and the buyer's outstanding screen
     *   would quietly close an order that never arrived.
     */
    if (line.purchaseOrderLineId != null) {
      if (purchaseOrderId === null) {
        throw new ValidationError(
          'This receipt is not against a purchase order, so its lines cannot cite order lines. Pick the order on the receipt first.'
        );
      }
      const orderLine = await tx.purchaseOrderLine.findUnique({
        where: { id: line.purchaseOrderLineId },
        select: { id: true, purchaseOrderId: true, productId: true },
      });
      if (!orderLine) throw new NotFoundError('Purchase order line');
      if (orderLine.purchaseOrderId !== purchaseOrderId) {
        throw new ValidationError(
          'One of these lines is against a different purchase order. A receipt delivers against one order.'
        );
      }
      if (orderLine.productId !== product.id) {
        throw new ValidationError(
          `The order line this ${product.name} is being received against is for a different product.`
        );
      }
    }

    // Cost: an explicit per-base-unit figure, or a pack price, or nothing.
    let unitCostBase: bigint;
    if (line.unitCostBase != null) {
      unitCostBase = BigInt(line.unitCostBase);
    } else if (line.pricePerPackMinor != null && line.packQuantityBase != null) {
      unitCostBase = BigInt(unitCostFromPack(line.pricePerPackMinor, line.packQuantityBase));
    } else if (line.purchaseOrderLineId != null) {
      /*
       * ⚠️ FALLING BACK TO THE **ORDER LINE'S** COST AND NOT TO THE PRICE BOOK'S.
       *   The order is what the clinic agreed to pay; the price book is what the
       *   supplier currently advertises, and those diverge the moment a price list
       *   changes between ordering and delivery. Falling back to the price book
       *   would value stock at a price nobody agreed to.
       */
      const orderLine = await tx.purchaseOrderLine.findUnique({
        where: { id: line.purchaseOrderLineId },
        select: { unitCostBase: true },
      });
      if (!orderLine) throw new NotFoundError('Purchase order line');
      unitCostBase = orderLine.unitCostBase;
    } else {
      throw new ValidationError(
        `${product.name} has no cost on this receipt. Enter what was invoiced, or receive it against the purchase order line it was ordered on — stock received at no cost values the whole shelf at nothing.`
      );
    }

    const lineSubtotalMinor = valueOf(unitCostBase, receivedQuantityBase);
    const taxAmountMinor = BigInt(line.taxAmountMinor ?? 0);
    const expiresOn = line.expiresOn != null ? fromDateString(line.expiresOn) : null;

    await assertLotIsReceivable(tx, branchId, product.name, expiresOn);

    resolved.push({
      productId: product.id,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      receivedQuantityBase,
      quantityEntered: line.quantity,
      unitId: line.unitId ?? product.baseUnitId,
      lotNumber: line.lotNumber ?? null,
      manufacturedOn: line.manufacturedOn != null ? fromDateString(line.manufacturedOn) : null,
      expiresOn,
      retestOn: line.retestOn != null ? fromDateString(line.retestOn) : null,
      manufacturerId: line.manufacturerId ?? null,
      serialNumber: line.serialNumber ?? null,
      unitCostBase,
      currency,
      lineSubtotalMinor,
      taxRateBps: line.taxRateBps ?? null,
      taxAmountMinor,
      lineTotalMinor: lineSubtotalMinor + taxAmountMinor,
      notes: line.notes ?? null,
    });
  }

  assertNoDuplicateLines(
    resolved.map((l) => `${l.productId}|${l.lotNumber ?? '-'}|${l.serialNumber ?? '-'}`),
    'The same product, lot and serial appears on this receipt twice. Combine them into one line — two lines for one lot could mean the total or a duplicate, and neither should be guessed.'
  );

  return resolved;
}

/**
 * Landed cost, apportioned pro-rata by value and STORED on each line.
 *
 * ⚠️ STORED RATHER THAN RE-DERIVED, EXACTLY AS INVOICE DISCOUNT APPORTIONMENT IS.
 *   The rounding of an apportionment must be decided once, or two readers of the
 *   same document disagree by a paisa and neither is wrong. `apportionByValue` in
 *   `@rcln/inventory` is where the largest-remainder arithmetic lives, and why it is
 *   not `@rcln/invoicing`'s `apportion` is written out there.
 */
function apportionLanded(
  header: { freight: bigint; duty: bigint; handling: bigint },
  lines: ResolvedLine[]
): number[] {
  const total = header.freight + header.duty + header.handling;
  if (total === 0n) return lines.map(() => 0);
  return apportionByValue(
    Number(total),
    lines.map((l) => Number(l.lineSubtotalMinor))
  );
}

function headerTotals(
  lines: ResolvedLine[],
  landed: number[]
): { goodsValueMinor: bigint; taxAmountMinor: bigint; totalMinor: bigint } {
  const goodsValueMinor = lines.reduce((sum, l) => sum + l.lineSubtotalMinor, 0n);
  const taxAmountMinor = lines.reduce((sum, l) => sum + l.taxAmountMinor, 0n);
  const landedTotal = landed.reduce((sum, share) => sum + BigInt(share), 0n);
  return {
    goodsValueMinor,
    taxAmountMinor,
    // ⚠️ Landed cost IS part of what the clinic paid, so it is in the document
    //   total. It is NOT in `goodsValueMinor`, which is what the goods themselves
    //   came to — an accountant reconciling a supplier invoice needs both.
    totalMinor: goodsValueMinor + taxAmountMinor + landedTotal,
  };
}

function lineData(
  ctx: TenantContext,
  branchId: string,
  goodsReceiptId: string,
  lines: ResolvedLine[],
  landed: number[]
): Prisma.GoodsReceiptLineCreateManyInput[] {
  return lines.map((l, index) => ({
    organizationId: ctx.organizationId,
    branchId,
    goodsReceiptId,
    // 1-based, and it IS the order the document renders in. See the model.
    lineNumber: index + 1,
    purchaseOrderLineId: l.purchaseOrderLineId,
    productId: l.productId,
    receivedQuantityBase: l.receivedQuantityBase,
    quantityEntered: l.quantityEntered,
    unitId: l.unitId,
    lotNumber: l.lotNumber,
    manufacturedOn: l.manufacturedOn,
    expiresOn: l.expiresOn,
    retestOn: l.retestOn,
    manufacturerId: l.manufacturerId,
    serialNumber: l.serialNumber,
    unitCostBase: l.unitCostBase,
    currency: l.currency,
    landedCostMinor: BigInt(landed[index] ?? 0),
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

export async function listGoodsReceipts(
  ctx: TenantContext,
  query: GoodsReceiptQuery
): Promise<GoodsReceiptListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.GoodsReceiptWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.supplierId !== undefined ? { supplierId: query.supplierId } : {}),
      ...(query.purchaseOrderId !== undefined ? { purchaseOrderId: query.purchaseOrderId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      /*
       * "What is waiting for inspection". Expressed as a line-level EXISTS rather
       * than a header column, because a receipt is partly accepted and partly
       * pending all the time — inspection happens line by line, and a header flag
       * would have to be maintained by whichever code path happened to decide last.
       */
      ...(query.awaitingQuality
        ? { status: 'POSTED' as const, lines: { some: { qualityStatus: 'PENDING' } } }
        : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { receiptNumber: { contains: query.q, mode: 'insensitive' } },
              { supplierName: { contains: query.q, mode: 'insensitive' } },
              { supplierInvoiceNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.goodsReceipt.count({ where }),
      tx.goodsReceipt.findMany({
        where,
        include: detailInclude,
        orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      goodsReceipts: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getGoodsReceipt(ctx: TenantContext, id: string): Promise<GoodsReceiptDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findReceiptOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createGoodsReceipt(
  ctx: TenantContext,
  input: CreateGoodsReceiptRequest,
  options: CatalogueActionOptions = {}
): Promise<GoodsReceiptDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const supplier = await resolveSupplierForDocument(tx, input.supplierId);
    const location = await resolveLocation(
      tx,
      input.branchId,
      input.locationId,
      'be received into'
    );

    let currency = input.currency ?? supplier.currency;
    if (input.purchaseOrderId != null) {
      const order = await tx.purchaseOrder.findUnique({
        where: { id: input.purchaseOrderId },
        select: {
          id: true,
          branchId: true,
          supplierId: true,
          status: true,
          currency: true,
          orderNumber: true,
        },
      });
      if (!order) throw new NotFoundError('Purchase order');
      if (order.branchId !== input.branchId) {
        throw new ValidationError(
          'That purchase order was raised at a different branch. A delivery is received at the branch that ordered it.'
        );
      }
      if (order.supplierId !== supplier.id) {
        throw new ValidationError(
          `That purchase order is with a different supplier, so ${supplier.name} cannot be delivering against it.`
        );
      }
      /*
       * ⚠️ A DRAFT ORDER CANNOT BE RECEIVED AGAINST. It has no number, it was never
       *   sent, and receiving against it would produce stock delivered against an
       *   order the supplier has never seen.
       */
      if (order.status === 'DRAFT') {
        throw new ValidationError(
          'That purchase order has not been issued yet, so nothing can be delivered against it. Issue it first, or record this delivery without an order.'
        );
      }
      if (order.status === 'CANCELLED') {
        throw new ValidationError('That purchase order was cancelled.');
      }
      // A CLOSED or RECEIVED order taking a further delivery is unusual and not
      // wrong — a supplier who ships late after the buyer gave up — so it is
      // allowed, and the over-receipt tolerance is what constrains the quantity.
      currency = input.currency ?? order.currency;
    }

    if (currency == null) {
      throw new ValidationError(
        `${supplier.name} has no currency recorded, so say which currency this delivery was invoiced in. An amount with no currency is one that will eventually be added to a different one.`
      );
    }

    const lines = await resolveLines(
      tx,
      input.branchId,
      input.purchaseOrderId ?? null,
      currency,
      input.lines
    );
    const landedTotals = {
      freight: BigInt(input.freightMinor),
      duty: BigInt(input.dutyMinor),
      handling: BigInt(input.handlingMinor),
    };
    const landed = apportionLanded(landedTotals, lines);

    const header = await tx.goodsReceipt.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        supplierId: supplier.id,
        purchaseOrderId: input.purchaseOrderId ?? null,
        supplierName: supplier.name,
        supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
        supplierInvoiceDate:
          input.supplierInvoiceDate != null ? fromDateString(input.supplierInvoiceDate) : null,
        locationId: location.id,
        ...(input.receivedAt != null ? { receivedAt: new Date(input.receivedAt) } : {}),
        currency,
        freightMinor: landedTotals.freight,
        dutyMinor: landedTotals.duty,
        handlingMinor: landedTotals.handling,
        notes: input.notes ?? null,
        createdById: ctx.userId,
        ...headerTotals(lines, landed),
      },
      select: { id: true },
    });

    await tx.goodsReceiptLine.createMany({
      data: lineData(ctx, input.branchId, header.id, lines, landed),
    });

    const created = await findReceiptOrThrow(tx, header.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'goods_receipt',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        supplierId: supplier.id,
        purchaseOrderId: created.purchaseOrderId,
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
 * ⚠️ ONLY A DRAFT, AND HERE THAT IS NOT A CONVENIENCE — IT IS WHAT MAKES THE PHASE
 *   CORRECT. A posted receipt has written ledger rows, created lot rows and moved a
 *   moving average; changing its lines would leave all three standing while the
 *   document said something else. A posted receipt is corrected by a purchase
 *   return or an adjustment with a reason (PI-ADR-004 rule 3), and
 *   `goods_receipts_posted_states_complete` is the layer under this one.
 */
export async function updateGoodsReceipt(
  ctx: TenantContext,
  id: string,
  input: UpdateGoodsReceiptRequest,
  options: CatalogueActionOptions = {}
): Promise<GoodsReceiptDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReceiptOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        existing.status === 'CANCELLED'
          ? 'This receipt was cancelled, so it cannot be changed.'
          : 'This receipt has already been posted, so it cannot be changed. The stock is on a shelf and the ledger records it arriving — correct it with a purchase return or an adjustment with a reason.'
      );
    }
    assertBranchInScope(ctx, existing.branchId);

    const location =
      input.locationId !== undefined
        ? await resolveLocation(tx, existing.branchId, input.locationId, 'be received into')
        : null;

    const landedTotals = {
      freight: BigInt(input.freightMinor ?? toMinorNumber(existing.freightMinor)),
      duty: BigInt(input.dutyMinor ?? toMinorNumber(existing.dutyMinor)),
      handling: BigInt(input.handlingMinor ?? toMinorNumber(existing.handlingMinor)),
    };

    /*
     * ⚠️ THE LANDED COST IS RE-APPORTIONED WHENEVER **EITHER** THE CHARGES OR THE
     *   LINES CHANGE, AND THE FIRST VERSION ONLY DID IT WHEN THE LINES DID. Changing
     *   freight on a receipt whose lines stayed the same would have left every
     *   line's stored share at the old figure while the header said something else —
     *   a document that does not add up, which is the one thing a person checking it
     *   notices immediately.
     */
    const linesChanged = input.lines !== undefined;
    const chargesChanged =
      input.freightMinor !== undefined ||
      input.dutyMinor !== undefined ||
      input.handlingMinor !== undefined;

    let totals: ReturnType<typeof headerTotals> | undefined;
    if (linesChanged || chargesChanged) {
      const resolved = linesChanged
        ? await resolveLines(
            tx,
            existing.branchId,
            existing.purchaseOrderId,
            existing.currency,
            input.lines ?? []
          )
        : existing.lines.map<ResolvedLine>((l) => ({
            productId: l.productId,
            purchaseOrderLineId: l.purchaseOrderLineId,
            receivedQuantityBase: toQuantityString(l.receivedQuantityBase),
            quantityEntered: toQuantityString(l.quantityEntered),
            unitId: l.unitId,
            lotNumber: l.lotNumber,
            manufacturedOn: l.manufacturedOn,
            expiresOn: l.expiresOn,
            retestOn: l.retestOn,
            manufacturerId: l.manufacturerId,
            serialNumber: l.serialNumber,
            unitCostBase: l.unitCostBase,
            currency: l.currency,
            lineSubtotalMinor: l.lineSubtotalMinor,
            taxRateBps: l.taxRateBps,
            taxAmountMinor: l.taxAmountMinor,
            lineTotalMinor: l.lineTotalMinor,
            notes: l.notes,
          }));

      const landed = apportionLanded(landedTotals, resolved);
      totals = headerTotals(resolved, landed);

      await tx.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: id } });
      await tx.goodsReceiptLine.createMany({
        data: lineData(ctx, existing.branchId, id, resolved, landed),
      });
    }

    const updated = await tx.goodsReceipt.update({
      where: { id },
      data: {
        ...(location !== null ? { locationId: location.id } : {}),
        ...(input.receivedAt !== undefined ? { receivedAt: new Date(input.receivedAt) } : {}),
        ...(input.supplierInvoiceNumber !== undefined
          ? { supplierInvoiceNumber: input.supplierInvoiceNumber }
          : {}),
        ...(input.supplierInvoiceDate !== undefined
          ? {
              supplierInvoiceDate:
                input.supplierInvoiceDate === null
                  ? null
                  : fromDateString(input.supplierInvoiceDate),
            }
          : {}),
        ...(chargesChanged
          ? {
              freightMinor: landedTotals.freight,
              dutyMinor: landedTotals.duty,
              handlingMinor: landedTotals.handling,
            }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(totals ?? {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'goods_receipt',
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
 * How much of an order line this delivery may take.
 *
 * ⚠️ THE TOLERANCE IS A SETTING AND A CHECK CONSTRAINT CANNOT READ ONE, WHICH MAKES
 *   THIS THE ONE ENFORCEMENT IN THE PHASE WITH A SINGLE LAYER. A transfer can refuse
 *   over-receipt absolutely because the sender counted; a supplier legitimately
 *   over-ships, and how much slack is acceptable differs per clinic
 *   (PI-ADR-015). It has its own integration test for exactly that reason.
 *
 * ⚠️ `takenThisRequest` IS WHAT STOPS THIS LOOP MINTING STOCK, AND PI-3 PAID FOR THE
 *   LESSON. The order line is loaded ONCE, so two receipt lines against the same
 *   order line would each measure themselves against the same untouched
 *   `received_quantity_base` — each passing the check, each writing a leg, and the
 *   final write setting the column to `stale + last` rather than to the sum. The
 *   contract refuses a duplicate `(product, lot, serial)` and TWO lines may still
 *   legitimately cite one order line: two lots of the same product on one pallet.
 */
function assertWithinTolerance(
  orderLine: { orderedQuantityBase: Prisma.Decimal; receivedQuantityBase: Prisma.Decimal },
  takenThisRequest: Prisma.Decimal,
  receiving: Prisma.Decimal,
  tolerancePercent: number,
  productName: string,
  unitSymbol: string
): void {
  /*
   * The ceiling in base units. `mul` then `div` on Decimal, never
   * `Number(...) * 1.05` — these are `Decimal(18,6)` and a double has lost the
   * tail before the multiplication runs.
   */
  const allowed = orderLine.orderedQuantityBase
    .mul(new Prisma.Decimal(100 + tolerancePercent))
    .div(100);
  const wouldBe = orderLine.receivedQuantityBase.add(takenThisRequest).add(receiving);

  if (wouldBe.greaterThan(allowed)) {
    const ordered = orderLine.orderedQuantityBase.toString();
    throw new ValidationError(
      tolerancePercent === 0
        ? `${ordered} ${unitSymbol} of ${productName} was ordered and this would bring the delivered total to ${wouldBe.toString()}. Receive what was ordered and record the difference as an adjustment with a reason — a delivery bigger than the order is a discovery of stock, not a purchase. Your clinic can allow a margin under stock settings.`
        : `${ordered} ${unitSymbol} of ${productName} was ordered and this would bring the delivered total to ${wouldBe.toString()}, past the ${String(tolerancePercent)}% over-delivery your clinic allows. Receive up to ${allowed.toString()} and record the rest as an adjustment with a reason.`
    );
  }
}

/**
 * Post it: write the ledger, create the lots, roll the cost.
 *
 * ⚠️ EVERY LEG, EVERY LOT ROW, EVERY SERIAL, THE COST ROLL-UP AND THE STATUS CHANGE
 *   COMMIT TOGETHER OR NOT AT ALL. A receipt marked POSTED whose legs did not write
 *   is stock the clinic thinks it has and cannot find; lot rows without their legs
 *   are lots with no quantity that FEFO will offer and allocation will fail on.
 *
 * ⚠️ AND THE QUANTITY GOES INTO `QUARANTINED` RATHER THAN `AVAILABLE` WHEN THE
 *   BRANCH INSPECTS DELIVERIES. That is the whole quality feature (PI-4.6): the
 *   stock is counted and valued and NOT dispensable, which is exactly what
 *   `StockStatus` already means by that bucket, so no new movement type is needed —
 *   `PURCHASE_RECEIPT` names its own `statusTo`.
 */
export async function postGoodsReceipt(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<GoodsReceiptDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReceiptOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        existing.status === 'CANCELLED'
          ? 'This receipt was cancelled, so it cannot be posted.'
          : 'This receipt has already been posted.'
      );
    }
    assertBranchInScope(ctx, existing.branchId);
    if (existing.lines.length === 0) {
      throw new ValidationError('This receipt has no lines, so there is nothing to post.');
    }

    /*
     * ⚠️ RE-ASSERTED AT THE MOMENT OF ACTING, DAYS AFTER THE DRAFT ASSERTED THEM.
     *   PI-3's third CRITICAL in one line: anything a document asserts about the
     *   world has to be re-asserted when it ACTS. A supplier gets blacklisted, a
     *   shelf gets decommissioned, and a short-dated lot expires — all between
     *   keying a delivery in and posting it.
     */
    await resolveSupplierForDocument(tx, existing.supplierId);
    const location = await resolveLocation(
      tx,
      existing.branchId,
      existing.locationId,
      'be received into'
    );

    /*
     * ⚠️ BEFORE ANYTHING READS THE ORDER'S LINES. The over-receipt decision below and
     *   `refreshOrderStatus` at the end both read them and then write, and two receipts
     *   against one order are two different header rows — so the receipt lock above
     *   serialises nothing between them. See `lockPurchaseOrder` for both failure
     *   scenarios in full.
     */
    if (existing.purchaseOrderId !== null) {
      await lockPurchaseOrder(tx, existing.purchaseOrderId);
    }

    const policy = await resolveReceivingPolicy(tx, ctx, existing.branchId);
    const statusTo = policy.qualityHoldRequired ? 'QUARANTINED' : 'AVAILABLE';

    /*
     * ⚠️ SORTED INTO A CANONICAL ORDER BEFORE ANY BUCKET IS TOUCHED. Each leg takes
     *   an advisory bucket lock held until COMMIT, so the ACQUISITION ORDER here is
     *   whatever order the lines happen to be in — and two receipts touching
     *   overlapping buckets in opposite orders deadlock. `lockBuckets` sorts within
     *   ONE movement for exactly this reason; this is the same rule one level up,
     *   where the caller controls the sequence. Measured on PI-2's expiry sweep.
     */
    const ordered = [...existing.lines].sort((a, b) => (a.id < b.id ? -1 : 1));

    const takenPerOrderLine = new Map<string, Prisma.Decimal>();
    const now = new Date();

    for (const line of ordered) {
      await assertLotIsReceivable(tx, existing.branchId, line.product.name, line.expiresOn);

      if (line.purchaseOrderLineId !== null) {
        const orderLine = await tx.purchaseOrderLine.findUnique({
          where: { id: line.purchaseOrderLineId },
          select: { id: true, orderedQuantityBase: true, receivedQuantityBase: true },
        });
        if (!orderLine) throw new NotFoundError('Purchase order line');

        const taken = takenPerOrderLine.get(orderLine.id) ?? new Prisma.Decimal(0);
        assertWithinTolerance(
          orderLine,
          taken,
          line.receivedQuantityBase,
          policy.tolerancePercent,
          line.product.name,
          line.product.baseUnit.symbol
        );
        takenPerOrderLine.set(orderLine.id, taken.add(line.receivedQuantityBase));
      }

      /*
       * ⚠️ BEFORE THE BATCH EXISTS AND BEFORE THE LEDGER MOVES, SO A REFUSAL
       *   LEAVES NOTHING BEHIND. Asking after `recordMovementIn` would mean a
       *   blocked line had already minted stock and created a lot, and the
       *   rollback would depend on the transaction rather than on the order —
       *   true today, and exactly the assumption that breaks the first time
       *   somebody splits this loop.
       *
       * Nothing blocks yet: `consultForStockMovement` throws only for a pack a
       * human has signed off. See `regulatory/enforcement.ts`.
       */
      await consultForStockMovement(tx, ctx, {
        branchId: existing.branchId,
        productId: line.productId,
        locationId: location.id,
        quantityBase: toQuantityString(line.receivedQuantityBase),
        transaction: 'STOCK',
        occurredAt: existing.receivedAt,
        documentType: 'GOODS_RECEIPT',
        documentId: existing.id,
      });

      const batchId = await findOrCreateBatch(tx, ctx, existing.branchId, line);
      const serialId = await createSerialIfNeeded(
        tx,
        ctx,
        existing.branchId,
        location.id,
        batchId,
        line
      );

      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: existing.branchId,
          productId: line.productId,
          batchId,
          serialId,
          movementType: 'PURCHASE_RECEIPT',
          quantity: toQuantityString(line.receivedQuantityBase),
          locationId: location.id,
          statusTo,
          referenceType: 'GOODS_RECEIPT',
          referenceId: existing.id,
          unitCostBase: line.unitCostBase,
          currency: line.currency,
          /*
           * ⚠️ THE LEG'S `occurredAt` IS WHEN THE GOODS **ARRIVED**, NOT NOW. A
           *   receipt entered on Monday for a Friday delivery is ordinary, and the
           *   ledger's whole point is that `occurred_at` and `recorded_at` can
           *   differ so a backdated entry is visible as one.
           */
          occurredAt: existing.receivedAt,
        },
        options
      );

      /*
       * ⚠️ THE VALUE ROLLED IN IS GOODS + LANDED COST AND NEVER TAX. Input tax is a
       *   liability the clinic may reclaim, not a cost of the goods; folding it in
       *   would inflate every valuation by the tax rate.
       */
      await rollReceiptIntoAverage(tx, ctx, {
        branchId: existing.branchId,
        productId: line.productId,
        currency: line.currency,
        quantityBase: toQuantityString(line.receivedQuantityBase),
        valueMinor: line.lineSubtotalMinor + line.landedCostMinor,
        receivedAt: existing.receivedAt,
      });

      await tx.goodsReceiptLine.update({
        where: { id: line.id },
        data: {
          batchId,
          serialId,
          qualityStatus: policy.qualityHoldRequired ? 'PENDING' : 'NOT_REQUIRED',
        },
      });

      if (line.purchaseOrderLineId !== null) {
        /*
         * ⚠️ `increment`, NOT AN ABSOLUTE ASSIGNMENT, AND THIS IS THE SECOND HALF OF
         *   PI-3'S MINTED-STOCK BUG. `{ receivedQuantityBase: stale + n }` computed
         *   from a row read earlier in the loop is the version that silently loses a
         *   delivery; `increment` makes the database do the addition against the
         *   committed value.
         */
        await tx.purchaseOrderLine.update({
          where: { id: line.purchaseOrderLineId },
          data: { receivedQuantityBase: { increment: line.receivedQuantityBase } },
        });
      }
    }

    const number = await issueNumber(tx, ctx, {
      type: 'GOODS_RECEIPT',
      branchId: existing.branchId,
      periodKey: '',
      prefix: 'GRN-',
    });

    const updated = await tx.goodsReceipt.update({
      where: { id },
      data: {
        receiptNumber: number.formatted,
        status: 'POSTED',
        postedAt: now,
        postedById: ctx.userId,
        // The policy AS IT WAS at post. A snapshot, so a clinic turning inspection
        // on next month does not make this receipt look like it skipped a step.
        qualityHoldRequired: policy.qualityHoldRequired,
      },
      include: detailInclude,
    });

    if (existing.purchaseOrderId !== null) {
      await refreshOrderStatus(tx, existing.purchaseOrderId);
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'goods_receipt',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: {
        status: 'POSTED',
        receiptNumber: updated.receiptNumber,
        statusTo,
        lineCount: updated.lines.length,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * The branch's own lot row for what arrived.
 *
 * Idempotent by lot number, which is what `@@unique([organizationId, branchId,
 * productId, lotNumber])` is for: a second delivery of the same lot finds the row
 * the first one created and adds to it, which is the correct physical answer.
 *
 * ⚠️ THE COST OF THE **FIRST** RECEIPT OF A LOT IS THE ONE THAT STICKS ON
 *   `batches.unit_cost_base`, AND A SECOND DELIVERY OF THE SAME LOT AT A DIFFERENT
 *   PRICE DOES NOT REWRITE IT. That is deliberate: the column is what this lot cost,
 *   and rewriting it would restate the value of stock already on the shelf. The
 *   moving average is where the two prices are pooled, which is exactly the division
 *   of labour between the two.
 */
async function findOrCreateBatch(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  line: LineRow
): Promise<string | null> {
  if (line.lotNumber === null) return null;

  const existing = await tx.batch.findFirst({
    where: { branchId, productId: line.productId, lotNumber: line.lotNumber },
    select: { id: true, status: true, lotNumber: true },
  });
  if (existing) {
    /*
     * ⚠️ A RECALLED OR QUARANTINED LOT MAY NOT TAKE A FURTHER DELIVERY. The ledger
     *   would allow it — an ADD into the AVAILABLE bucket is a legal movement — and
     *   allowing it is how a recalled lot number quietly re-enters dispensable
     *   stock through the back door of a new delivery.
     */
    if (existing.status === 'RECALLED' || existing.status === 'QUARANTINED') {
      throw new ValidationError(
        `Lot ${existing.lotNumber} is ${existing.status.toLowerCase()} at this branch, so more of it cannot be received. If the supplier has sent replacement stock it has a different lot number; if it does not, do not accept it.`
      );
    }
    return existing.id;
  }

  const created = await tx.batch.create({
    data: {
      organizationId: ctx.organizationId,
      branchId,
      productId: line.productId,
      lotNumber: line.lotNumber,
      manufacturedOn: line.manufacturedOn,
      expiresOn: line.expiresOn,
      retestOn: line.retestOn,
      manufacturerId: line.manufacturerId,
      unitCostBase: line.unitCostBase,
      currency: line.currency,
      // `receivedAt` defaults to now: it is the FEFO tie-break, and it means "when
      // this lot arrived HERE".
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * The device's own row.
 *
 * ⚠️ ONE SERIAL PER LINE, WHICH IS WHY THERE IS NO CHILD TABLE. A serial IS one
 *   physical device, `recordMovementIn` takes exactly one `serialId`, and the
 *   `goods_receipt_lines_serial_quantity` CHECK pins the quantity at one.
 *
 * ⚠️ A DUPLICATE SERIAL IS REFUSED WITH A SENTENCE RATHER THAN A 23505. Two devices
 *   with one serial number is either a supplier's error or a keying error, and both
 *   need a person to look at the box — `@@unique([organizationId, productId,
 *   serialNumber])` would say the same thing in a way nobody can act on.
 */
async function createSerialIfNeeded(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  locationId: string,
  batchId: string | null,
  line: LineRow
): Promise<string | null> {
  if (line.serialNumber === null) return null;

  const clash = await tx.serial.findFirst({
    where: { productId: line.productId, serialNumber: line.serialNumber },
    select: { id: true, branchId: true },
  });
  if (clash) {
    throw new ValidationError(
      `Serial ${line.serialNumber} for ${line.product.name} is already recorded${clash.branchId === branchId ? ' at this branch' : ' at another branch'}. A serial number is one physical device — check the pack, because either the supplier has reused it or it has been keyed in twice.`
    );
  }

  const created = await tx.serial.create({
    data: {
      organizationId: ctx.organizationId,
      branchId,
      productId: line.productId,
      batchId,
      serialNumber: line.serialNumber,
      currentLocationId: locationId,
      expiresOn: line.expiresOn,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Move the order to `PARTIALLY_RECEIVED` or `RECEIVED`.
 *
 * ⚠️ RE-READ RATHER THAN COMPUTED FROM WHAT THE LOOP JUST DID. The lines were
 *   updated inside this transaction with `increment`, so the database is the only
 *   thing that knows the committed totals — the same reasoning `recordMovementIn`
 *   uses for reading the balances back rather than predicting them.
 *
 * ⚠️ A `CLOSED` OR `CANCELLED` ORDER IS LEFT ALONE. The buyer decided nothing more
 *   was coming, and a late delivery arriving afterwards must not silently reopen
 *   that judgement — the receipt is recorded either way, which is what matters.
 */
async function refreshOrderStatus(tx: TxClient, purchaseOrderId: string): Promise<void> {
  const order = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: { id: true, status: true },
  });
  if (!order) return;
  if (order.status !== 'ISSUED' && order.status !== 'PARTIALLY_RECEIVED') return;

  const lines = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId },
    select: { orderedQuantityBase: true, receivedQuantityBase: true },
  });
  const fullyReceived = lines.every((l) =>
    l.receivedQuantityBase.greaterThanOrEqualTo(l.orderedQuantityBase)
  );

  await tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
  });
}

/**
 * Abandon a draft.
 *
 * ⚠️ ONLY A DRAFT, AND THE `goods_receipts_posted_states_complete` CHECK IS WHAT
 *   MAKES THAT LITERAL — its `CANCELLED` branch requires `posted_at IS NULL`. There
 *   is deliberately no reversal: a posted receipt is corrected by a purchase return
 *   or an adjustment with a reason, because the stock is genuinely on the shelf and
 *   the ledger genuinely records it arriving (PI-ADR-004 rule 3).
 */
export async function cancelGoodsReceipt(
  ctx: TenantContext,
  id: string,
  input: CancelGoodsReceiptRequest,
  options: CatalogueActionOptions = {}
): Promise<GoodsReceiptDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReceiptOrThrow(tx, id);
    assertBranchInScope(ctx, existing.branchId);

    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This receipt has already been cancelled.');
    }
    if (existing.status === 'POSTED') {
      throw new ConflictError(
        'This receipt has been posted, so it cannot be cancelled — the stock is on a shelf and the ledger records it arriving. Send it back with a purchase return, or correct the count with an adjustment and a reason.'
      );
    }

    const updated = await tx.goodsReceipt.update({
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
      entityType: 'goods_receipt',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'CANCELLED', reason: input.reason },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * The inspection decision (PI-4.6).
 *
 * ── ACCEPTED MOVES QUARANTINED → AVAILABLE; REJECTED LEAVES IT WHERE IT IS ───
 *
 *   ACCEPTED  QUARANTINE_RELEASE  QUARANTINED ──▶ AVAILABLE   dispensable
 *   REJECTED  (no movement)       stays QUARANTINED           counted, not usable
 *
 * ⚠️ A REJECTION WRITES NO MOVEMENT, AND THAT IS THE POINT RATHER THAN AN OMISSION.
 *   The stock is already out of `AVAILABLE` — the receipt put it in `QUARANTINED` —
 *   so refusing it requires nothing to move. What happens NEXT is a purchase return
 *   or a disposal, and each of those is its own document with its own movement. A
 *   rejection that moved quantity somewhere would be guessing which.
 *
 * ⚠️ AND A PARTIAL REJECTION RELEASES THE REST. Ten boxes arrive, two are crushed:
 *   the eight good ones must become dispensable in the same act that records the two
 *   bad ones, or the clinic has to inspect twice to use what it inspected once.
 */
export async function decideGoodsReceiptQuality(
  ctx: TenantContext,
  id: string,
  input: DecideGoodsReceiptQualityRequest,
  options: CatalogueActionOptions = {}
): Promise<GoodsReceiptDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReceiptOrThrow(tx, id);
    assertBranchInScope(ctx, existing.branchId);

    if (existing.status !== 'POSTED') {
      throw new ConflictError(
        'This receipt has not been posted, so there is nothing on a shelf to inspect.'
      );
    }

    const location = await resolveLocation(
      tx,
      existing.branchId,
      existing.locationId,
      'be released from'
    );
    const byId = new Map(existing.lines.map((l) => [l.id, l]));
    const now = new Date();

    // Sorted for the same lock-ordering reason `postGoodsReceipt` sorts.
    const ordered = [...input.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : 1));

    for (const decision of ordered) {
      const line = byId.get(decision.lineId);
      if (!line) throw new NotFoundError('Goods receipt line');

      if (line.qualityStatus !== 'PENDING') {
        throw new ConflictError(
          line.qualityStatus === 'NOT_REQUIRED'
            ? `${line.product.name} was not held for inspection on this receipt, so there is nothing to decide.`
            : `${line.product.name} has already been ${line.qualityStatus.toLowerCase()} on this receipt. A decision is not revisited — quarantine it again if something has changed.`
        );
      }

      const rejected =
        decision.rejectedQuantityBase != null
          ? new Prisma.Decimal(decision.rejectedQuantityBase)
          : new Prisma.Decimal(0);

      if (decision.outcome === 'REJECTED') {
        if (rejected.lessThanOrEqualTo(0)) {
          throw new ValidationError(
            `Say how much of the ${line.product.name} is being refused. Rejecting nothing is accepting it.`
          );
        }
        if (decision.notes == null || decision.notes.trim().length === 0) {
          throw new ValidationError(
            `Say why the ${line.product.name} is being refused. "We refused it" with no reason is not something the supplier can be asked for a credit on.`
          );
        }
      }
      if (rejected.greaterThan(line.receivedQuantityBase)) {
        throw new ValidationError(
          `${rejected.toString()} ${line.product.baseUnit.symbol} of ${line.product.name} is being refused and only ${toQuantityString(line.receivedQuantityBase)} arrived.`
        );
      }

      /*
       * What passed inspection goes back to AVAILABLE. On an ACCEPTED line with a
       * rejected quantity — "eight of the ten are fine" — that is the difference,
       * which is why this is one subtraction rather than two branches.
       */
      const releasing = line.receivedQuantityBase.sub(rejected);
      if (releasing.greaterThan(0)) {
        await recordMovementIn(
          tx,
          ctx,
          {
            branchId: existing.branchId,
            productId: line.productId,
            batchId: line.batchId,
            serialId: line.serialId,
            movementType: 'QUARANTINE_RELEASE',
            quantity: releasing.toString(),
            locationId: location.id,
            statusFrom: 'QUARANTINED',
            statusTo: 'AVAILABLE',
            referenceType: 'GOODS_RECEIPT',
            referenceId: existing.id,
            reasonNote:
              decision.notes != null && decision.notes.trim().length > 0
                ? `Inspection: ${decision.notes}`
                : 'Passed inspection',
          },
          options
        );
      }

      await tx.goodsReceiptLine.update({
        where: { id: line.id },
        data: {
          qualityStatus: decision.outcome,
          rejectedQuantityBase: rejected,
          qualityDecidedAt: now,
          qualityDecidedById: ctx.userId,
          qualityNotes: decision.notes ?? null,
        },
      });
    }

    const updated = await findReceiptOrThrow(tx, id);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'goods_receipt',
      entityId: id,
      branchId: existing.branchId,
      after: {
        linesDecided: input.lines.length,
        awaitingQualityLineCount: updated.lines.filter((l) => l.qualityStatus === 'PENDING').length,
      },
      ...options,
    });

    return toDetail(updated);
  });
}
