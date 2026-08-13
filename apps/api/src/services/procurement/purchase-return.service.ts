/**
 * Purchase returns: stock going back to the supplier (PI-4.7).
 *
 * ── A RETURN IS A MOVEMENT CITING THE RECEIPT, NEVER A DELETION OF IT ───────
 *
 *   goods_receipt ──PURCHASE_RECEIPT──▶ AVAILABLE / QUARANTINED
 *         │                                    │
 *         └── cited by ──▶ purchase_return ──PURCHASE_RETURN──▶ (gone)
 *
 * The goods arrived; the ledger recorded that they arrived; and a correction is a
 * compensating movement with a reason (PI-ADR-004 rule 3). Deleting the receipt
 * would leave a lot row nobody received, a cost nobody paid, and a recall query
 * that cannot say where the stock went.
 *
 * ── `PURCHASE_RETURN` IS A NEW MOVEMENT TYPE, AND WHY MATTERS ────────────────
 * ⚠️ PI-2'S SCHEMA SAID A PURCHASE RETURN WOULD BE A `TRANSFER_OUT` TO THE
 *   SUPPLIER. It cannot be. `TRANSFER_OUT` means "went to another branch of ours"
 *   to every report that reads the column, and the outstanding-quantity arithmetic
 *   over `stock_transfers` reads exactly those rows — a purchase return written as
 *   one shows up as stock in transit between two of the clinic's own sites, on a van
 *   that does not exist.
 *
 * ⚠️ AND IT HAS NO DEFAULT `statusFrom`, WHICH IS WHY EVERY LINE MUST NAME ONE. It is
 *   the second movement type after `DISPOSAL` that refuses to guess: what is going
 *   back — sound stock ordered in error, stock rejected at inspection, stock damaged
 *   in the box — IS the content of the record, and defaulting to `AVAILABLE` would
 *   let a mis-click send sellable stock away and file it as routine.
 *
 * NO PHI. ⚠️ A SERIAL ASSIGNED TO A PATIENT IS REFUSED, and the message does not name
 *   the patient — "device 7742 has been issued to a patient" is what the storekeeper
 *   needs; "device 7742 is in Mrs Rao" is a clinical fact about a named person on a
 *   stock screen. PI-3's `assertSerialIsStillStock` is the same check for the same
 *   reason.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { valueOf } from '@rcln/inventory';
import type {
  CancelPurchaseReturnRequest,
  CreatePurchaseReturnRequest,
  PurchaseReturnDetail,
  PurchaseReturnLineDetail,
  PurchaseReturnLineRequest,
  PurchaseReturnListResponse,
  PurchaseReturnQuery,
  PurchaseReturnSummary,
  UpdatePurchaseReturnRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { recordMovementIn } from '../inventory/movement.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { removeReturnFromAverage } from './costing.service.js';
import {
  assertBranchInScope,
  assertNoDuplicateLines,
  resolveLocation,
  resolveProductForLine,
  resolveSupplierForDocument,
  toBase,
  toDateString,
  toMinorNumber,
  toQuantityString,
} from './shared.js';

const detailInclude = Prisma.validator<Prisma.PurchaseReturnInclude>()({
  branch: { select: { name: true } },
  goodsReceipt: { select: { receiptNumber: true } },
  location: { select: { name: true } },
  createdBy: { select: { fullName: true } },
  sentBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    include: {
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      batch: { select: { lotNumber: true, expiresOn: true } },
      serial: { select: { serialNumber: true } },
    },
    orderBy: { lineNumber: 'asc' },
  },
});

type DetailRow = Prisma.PurchaseReturnGetPayload<{ include: typeof detailInclude }>;
type LineRow = DetailRow['lines'][number];

function toLineDetail(line: LineRow): PurchaseReturnLineDetail {
  return {
    id: line.id,
    productId: line.productId,
    productCode: line.product.code,
    productName: line.product.name,
    baseUnitSymbol: line.product.baseUnit.symbol,
    goodsReceiptLineId: line.goodsReceiptLineId,
    batchId: line.batchId,
    /*
     * ⚠️ THE JOIN IS SAFE HERE, UNLIKE ON A TRANSFER LINE, AND THE DIFFERENCE IS THAT
     *   BOTH ENDS ARE ONE BRANCH. A return leaves the branch that received it, so the
     *   lot row is inside the reader's own scope and `batches.branch_isolation` never
     *   hides it. On a transfer the two ends are different branches, which is why
     *   those lines carry a snapshot.
     */
    lotNumber: line.batch?.lotNumber ?? null,
    expiresOn: toDateString(line.batch?.expiresOn ?? null),
    serialId: line.serialId,
    serialNumber: line.serial?.serialNumber ?? null,
    quantityBase: toQuantityString(line.quantityBase),
    quantityEntered: toQuantityString(line.quantityEntered),
    unitSymbol: line.unit.symbol,
    statusFrom: line.statusFrom,
    unitCostBase: line.unitCostBase === null ? null : toMinorNumber(line.unitCostBase),
    currency: line.currency,
    lineTotalMinor: toMinorNumber(line.lineTotalMinor),
    notes: line.notes,
  };
}

function toSummary(row: DetailRow): PurchaseReturnSummary {
  return {
    id: row.id,
    returnNumber: row.returnNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    goodsReceiptId: row.goodsReceiptId,
    goodsReceiptNumber: row.goodsReceipt?.receiptNumber ?? null,
    status: row.status,
    locationId: row.locationId,
    locationName: row.location.name,
    reason: row.reason,
    currency: row.currency,
    lineCount: row.lines.length,
    totalMinor: toMinorNumber(row.totalMinor),
    supplierCreditNoteNumber: row.supplierCreditNoteNumber,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy.fullName,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentByName: row.sentBy?.fullName ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

function toDetail(row: DetailRow): PurchaseReturnDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    cancelledByName: row.cancelledBy?.fullName ?? null,
    lines: row.lines.map(toLineDetail),
  };
}

async function findReturnOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.purchaseReturn.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Purchase return');
  return row;
}

/** The header's row lock. See the requisition service for the full argument. */
async function lockReturnOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "purchase_returns" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Purchase return');
  return findReturnOrThrow(tx, id);
}

/**
 * A serial that is still stock, at the moment it is about to leave.
 *
 * ⚠️ CHECKED AT DRAFT **AND** AGAIN AT SEND, BECAUSE THE TWO MOMENTS ARE DAYS APART
 *   AND THE FACT CHANGES IN BETWEEN. `assignSerial` sets `assigned_patient_id` and
 *   writes NO ledger movement — the quantity stays in AVAILABLE — so nothing in
 *   `recordMovementIn` notices: its serial read selects the product, branch, lot and
 *   number, and neither the patient link nor the status. PI-3 found this the
 *   expensive way; here the consequence is a device being posted back to a
 *   distributor after it was fitted to somebody.
 *
 * ⚠️ THE MESSAGE DOES NOT NAME THE PATIENT, AND MUST NOT.
 */
async function assertSerialIsStillStock(tx: TxClient, serialId: string): Promise<void> {
  const serial = await tx.serial.findUnique({
    where: { id: serialId },
    select: { serialNumber: true, status: true, assignedPatientId: true },
  });
  if (!serial) throw new NotFoundError('Serial');

  if (serial.assignedPatientId !== null) {
    throw new ValidationError(
      `Serial ${serial.serialNumber} has been issued to a patient, so it is no longer stock and cannot be sent back to the supplier.`
    );
  }
  if (serial.status === 'DISPOSED' || serial.status === 'ISSUED') {
    throw new ValidationError(
      `Serial ${serial.serialNumber} is ${serial.status.toLowerCase()} and is no longer stock, so it cannot be returned.`
    );
  }
}

interface ResolvedLine {
  productId: string;
  goodsReceiptLineId: string | null;
  batchId: string | null;
  serialId: string | null;
  quantityBase: string;
  quantityEntered: string;
  unitId: string;
  statusFrom: PurchaseReturnLineRequest['statusFrom'];
  unitCostBase: bigint | null;
  currency: string | null;
  lineTotalMinor: bigint;
  notes: string | null;
}

async function resolveLines(
  tx: TxClient,
  branchId: string,
  goodsReceiptId: string | null,
  currency: string,
  lines: PurchaseReturnLineRequest[]
): Promise<ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const product = await resolveProductForLine(tx, line.productId);
    const quantityBase = await toBase(tx, product, line);

    /*
     * ⚠️ REFUSED HERE AS WELL AS BY THE `purchase_return_lines_status_from_returnable`
     *   CHECK, BECAUSE THE ENUM IS WIDER THAN THE ANSWER. `RESERVED` is spoken for by
     *   somebody and returning it would empty a reservation nothing released;
     *   `DISPOSED` has already gone; `IN_TRANSIT` is not a bucket this programme ever
     *   fills (PI-3 decision 1).
     */
    if (
      line.statusFrom === 'RESERVED' ||
      line.statusFrom === 'DISPOSED' ||
      line.statusFrom === 'IN_TRANSIT'
    ) {
      throw new ValidationError(
        line.statusFrom === 'RESERVED'
          ? `The ${product.name} being returned is reserved for something. Release the reservation first — sending it back would leave a hold on stock that is no longer there.`
          : `Stock recorded as ${line.statusFrom.toLowerCase().replace('_', ' ')} cannot be sent back to a supplier.`
      );
    }

    const mode = product.trackingMode;
    if ((mode === 'LOT_BATCH' || mode === 'LOT_AND_SERIAL') && line.batchId == null) {
      throw new ValidationError(
        `${product.name} is batch-tracked, so every line of it must name the lot being sent back.`
      );
    }
    if ((mode === 'SERIAL' || mode === 'LOT_AND_SERIAL') && line.serialId == null) {
      throw new ValidationError(
        `${product.name} is serial-tracked, so every line of it must name the device being sent back.`
      );
    }

    /*
     * The lot and the serial are re-read rather than trusted, for the reason
     * `recordMovementIn` re-reads them: the composite FK proves they belong to this
     * tenant and this branch, and says nothing about whether they belong to this
     * PRODUCT.
     */
    let unitCostBase: bigint | null = line.unitCostBase != null ? BigInt(line.unitCostBase) : null;

    if (line.batchId != null) {
      const batch = await tx.batch.findUnique({
        where: { id: line.batchId },
        select: {
          id: true,
          productId: true,
          branchId: true,
          lotNumber: true,
          unitCostBase: true,
          currency: true,
        },
      });
      if (!batch) throw new NotFoundError('Batch');
      if (batch.productId !== product.id) {
        throw new ValidationError(`Lot ${batch.lotNumber} is not a lot of ${product.name}.`);
      }
      if (batch.branchId !== branchId) {
        throw new ValidationError(`Lot ${batch.lotNumber} is held at a different branch.`);
      }
      /*
       * ⚠️ THE LOT'S OWN COST IS THE FALLBACK AND NOT THE MOVING AVERAGE. What the
       *   clinic expects to be credited is what it PAID for this lot, which is
       *   exactly what `batches.unit_cost_base` records. The average pools two
       *   deliveries at two prices and cannot answer "what did this box cost".
       *
       *   ⚠️ AND A CURRENCY MISMATCH FALLS BACK TO NO COST RATHER THAN CONVERTING.
       *     Nothing in this programme applies an FX rate; a lot bought in USD and
       *     returned on an INR document is recorded without a value, and the buyer
       *     enters what they are claiming.
       */
      if (unitCostBase === null && batch.unitCostBase !== null && batch.currency === currency) {
        unitCostBase = batch.unitCostBase;
      }
    }

    if (line.serialId != null) {
      const serial = await tx.serial.findUnique({
        where: { id: line.serialId },
        select: { id: true, productId: true, branchId: true, batchId: true, serialNumber: true },
      });
      if (!serial) throw new NotFoundError('Serial');
      if (serial.productId !== product.id) {
        throw new ValidationError(`Serial ${serial.serialNumber} is not a ${product.name}.`);
      }
      if (serial.branchId !== branchId) {
        throw new ValidationError(`Serial ${serial.serialNumber} is held at a different branch.`);
      }
      if (line.batchId != null && serial.batchId !== line.batchId) {
        throw new ValidationError(
          `Serial ${serial.serialNumber} does not belong to the lot this line names.`
        );
      }
      await assertSerialIsStillStock(tx, line.serialId);
    }

    if (line.goodsReceiptLineId != null) {
      const receiptLine = await tx.goodsReceiptLine.findUnique({
        where: { id: line.goodsReceiptLineId },
        select: { id: true, goodsReceiptId: true, productId: true, branchId: true },
      });
      if (!receiptLine) throw new NotFoundError('Goods receipt line');
      if (receiptLine.branchId !== branchId) {
        throw new ValidationError(
          'That delivery was received at a different branch, so stock cannot be returned against it from here.'
        );
      }
      if (receiptLine.productId !== product.id) {
        throw new ValidationError(
          `The delivery line this ${product.name} is being returned against is for a different product.`
        );
      }
      if (goodsReceiptId !== null && receiptLine.goodsReceiptId !== goodsReceiptId) {
        throw new ValidationError(
          'One of these lines cites a different delivery. A return goes back against one delivery.'
        );
      }
    }

    resolved.push({
      productId: product.id,
      goodsReceiptLineId: line.goodsReceiptLineId ?? null,
      batchId: line.batchId ?? null,
      serialId: line.serialId ?? null,
      quantityBase,
      quantityEntered: line.quantity,
      unitId: line.unitId ?? product.baseUnitId,
      statusFrom: line.statusFrom,
      unitCostBase,
      // Paired with the cost by the `purchase_return_lines_cost_currency_paired`
      // CHECK: a number with no currency is a number that will be added to a
      // different one.
      currency: unitCostBase === null ? null : currency,
      lineTotalMinor: unitCostBase === null ? 0n : valueOf(unitCostBase, quantityBase),
      notes: line.notes ?? null,
    });
  }

  assertNoDuplicateLines(
    resolved.map((l) => `${l.productId}|${l.batchId ?? '-'}|${l.serialId ?? '-'}`),
    'The same product and lot appears on this return twice. Combine them into one line — two lines for one lot could mean the total or a duplicate, and neither should be guessed.'
  );

  return resolved;
}

function lineData(
  ctx: TenantContext,
  branchId: string,
  purchaseReturnId: string,
  lines: ResolvedLine[]
): Prisma.PurchaseReturnLineCreateManyInput[] {
  return lines.map((l, index) => ({
    organizationId: ctx.organizationId,
    branchId,
    purchaseReturnId,
    // 1-based, and it IS the order the document renders in. See the model.
    lineNumber: index + 1,
    goodsReceiptLineId: l.goodsReceiptLineId,
    productId: l.productId,
    batchId: l.batchId,
    serialId: l.serialId,
    quantityBase: l.quantityBase,
    quantityEntered: l.quantityEntered,
    unitId: l.unitId,
    statusFrom: l.statusFrom,
    unitCostBase: l.unitCostBase,
    currency: l.currency,
    lineTotalMinor: l.lineTotalMinor,
    notes: l.notes,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPurchaseReturns(
  ctx: TenantContext,
  query: PurchaseReturnQuery
): Promise<PurchaseReturnListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.PurchaseReturnWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.supplierId !== undefined ? { supplierId: query.supplierId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { returnNumber: { contains: query.q, mode: 'insensitive' } },
              { supplierName: { contains: query.q, mode: 'insensitive' } },
              { reason: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.purchaseReturn.count({ where }),
      tx.purchaseReturn.findMany({
        where,
        include: detailInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      purchaseReturns: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getPurchaseReturn(
  ctx: TenantContext,
  id: string
): Promise<PurchaseReturnDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findReturnOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createPurchaseReturn(
  ctx: TenantContext,
  input: CreatePurchaseReturnRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseReturnDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const supplier = await resolveSupplierForDocument(tx, input.supplierId);
    const location = await resolveLocation(tx, input.branchId, input.locationId, 'leave');

    let currency = input.currency ?? supplier.currency;

    if (input.goodsReceiptId != null) {
      const receipt = await tx.goodsReceipt.findUnique({
        where: { id: input.goodsReceiptId },
        select: {
          id: true,
          branchId: true,
          supplierId: true,
          status: true,
          currency: true,
          receiptNumber: true,
        },
      });
      if (!receipt) throw new NotFoundError('Goods receipt');
      if (receipt.branchId !== input.branchId) {
        throw new ValidationError(
          'That delivery was received at a different branch. Stock goes back from the branch that received it.'
        );
      }
      if (receipt.supplierId !== supplier.id) {
        throw new ValidationError(
          `That delivery came from a different supplier, so stock from it cannot go back to ${supplier.name}.`
        );
      }
      /*
       * ⚠️ ONLY A POSTED RECEIPT MAY BE RETURNED AGAINST. A draft never put stock on
       *   a shelf, so there is nothing to send back — and citing one would produce a
       *   return whose traceability points at a delivery that never happened.
       */
      if (receipt.status !== 'POSTED') {
        throw new ValidationError(
          `Delivery ${receipt.receiptNumber ?? ''} has not been posted, so nothing from it is on a shelf to send back.`.trim()
        );
      }
      currency = input.currency ?? receipt.currency;
    }

    if (currency == null) {
      throw new ValidationError(
        `${supplier.name} has no currency recorded, so say which currency the credit is expected in.`
      );
    }

    const lines = await resolveLines(
      tx,
      input.branchId,
      input.goodsReceiptId ?? null,
      currency,
      input.lines
    );

    const header = await tx.purchaseReturn.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        supplierId: supplier.id,
        goodsReceiptId: input.goodsReceiptId ?? null,
        supplierName: supplier.name,
        reason: input.reason,
        locationId: location.id,
        currency,
        totalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0n),
        notes: input.notes ?? null,
        createdById: ctx.userId,
      },
      select: { id: true },
    });

    await tx.purchaseReturnLine.createMany({
      data: lineData(ctx, input.branchId, header.id, lines),
    });

    const created = await findReturnOrThrow(tx, header.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'purchase_return',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        supplierId: supplier.id,
        goodsReceiptId: created.goodsReceiptId,
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
 * ⚠️ ONLY A DRAFT. A sent return has written `PURCHASE_RETURN` legs and the stock has
 *   left; changing its lines would leave those movements citing lines that no longer
 *   exist. Stock that comes back from a supplier is a new GOODS RECEIPT, which is
 *   what it physically is.
 */
export async function updatePurchaseReturn(
  ctx: TenantContext,
  id: string,
  input: UpdatePurchaseReturnRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseReturnDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReturnOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        existing.status === 'CANCELLED'
          ? 'This return was cancelled, so it cannot be changed.'
          : 'This return has already been sent, so its lines cannot be changed. Stock coming back from a supplier is recorded as a new delivery.'
      );
    }
    assertBranchInScope(ctx, existing.branchId);

    const location =
      input.locationId !== undefined
        ? await resolveLocation(tx, existing.branchId, input.locationId, 'leave')
        : null;

    let totalMinor: bigint | undefined;
    if (input.lines !== undefined) {
      const lines = await resolveLines(
        tx,
        existing.branchId,
        existing.goodsReceiptId,
        existing.currency,
        input.lines
      );
      totalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0n);
      await tx.purchaseReturnLine.deleteMany({ where: { purchaseReturnId: id } });
      await tx.purchaseReturnLine.createMany({
        data: lineData(ctx, existing.branchId, id, lines),
      });
    }

    const updated = await tx.purchaseReturn.update({
      where: { id },
      data: {
        ...(location !== null ? { locationId: location.id } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.supplierCreditNoteNumber !== undefined
          ? { supplierCreditNoteNumber: input.supplierCreditNoteNumber }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(totalMinor !== undefined ? { totalMinor } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_return',
      entityId: id,
      branchId: existing.branchId,
      before: { lineCount: existing.lines.length },
      after: { lineCount: updated.lines.length },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Send it back.
 *
 * ⚠️ EVERY LEG AND THE STATUS CHANGE COMMIT TOGETHER OR NOT AT ALL. A return marked
 *   SENT whose legs did not write is stock the clinic still shows on its shelves and
 *   the supplier has in their warehouse.
 */
export async function sendPurchaseReturn(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<PurchaseReturnDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReturnOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        existing.status === 'CANCELLED'
          ? 'This return was cancelled, so it cannot be sent.'
          : 'This return has already been sent.'
      );
    }
    assertBranchInScope(ctx, existing.branchId);
    if (existing.lines.length === 0) {
      throw new ValidationError('This return has no lines, so there is nothing to send back.');
    }

    // Re-asserted at the moment of acting. See `postGoodsReceipt`.
    await resolveSupplierForDocument(tx, existing.supplierId);
    const location = await resolveLocation(tx, existing.branchId, existing.locationId, 'leave');

    // Sorted for the lock-ordering reason `postGoodsReceipt` sorts.
    const ordered = [...existing.lines].sort((a, b) => (a.id < b.id ? -1 : 1));

    for (const line of ordered) {
      // Re-checked here as well as at draft time: a device can be fitted to a
      // patient in between. See `assertSerialIsStillStock`.
      if (line.serialId !== null) await assertSerialIsStillStock(tx, line.serialId);

      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: existing.branchId,
          productId: line.productId,
          batchId: line.batchId,
          serialId: line.serialId,
          movementType: 'PURCHASE_RETURN',
          quantity: toQuantityString(line.quantityBase),
          locationId: location.id,
          // ⚠️ NAMED EXPLICITLY, BECAUSE `PURCHASE_RETURN` HAS NO DEFAULT
          //   `statusFrom` — see the file header and `DEFAULT_STATUS`.
          statusFrom: line.statusFrom,
          referenceType: 'PURCHASE_RETURN',
          referenceId: existing.id,
          unitCostBase: line.unitCostBase,
          currency: line.currency,
          reasonNote: `Returned to supplier: ${existing.reason}`,
        },
        options
      );

      /*
       * ⚠️ THE POOL SHRINKS AND THE AVERAGE DOES NOT MOVE, WHICH IS WHAT A MOVING
       *   AVERAGE MEANS. Value comes out at the CURRENT average rather than at what
       *   this lot cost, because once two deliveries at two prices are pooled "what
       *   did this box cost" has no answer the pool can give. See
       *   `removeFromAverage` in the package.
       */
      await removeReturnFromAverage(tx, ctx, {
        branchId: existing.branchId,
        productId: line.productId,
        currency: existing.currency,
        quantityBase: toQuantityString(line.quantityBase),
      });

      /*
       * A returned device leaves the clinic. `RETURNED` is the serial status that
       * says so, and it keeps the row — a serial IS the device, and its history has
       * to survive it going back.
       */
      if (line.serialId !== null) {
        await tx.serial.update({
          where: { id: line.serialId },
          data: { status: 'RETURNED', currentLocationId: null },
        });
      }
    }

    const number = await issueNumber(tx, ctx, {
      type: 'PURCHASE_RETURN',
      branchId: existing.branchId,
      periodKey: '',
      prefix: 'PRN-',
    });

    const updated = await tx.purchaseReturn.update({
      where: { id },
      data: {
        returnNumber: number.formatted,
        status: 'SENT',
        sentAt: new Date(),
        sentById: ctx.userId,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'purchase_return',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: {
        status: 'SENT',
        returnNumber: updated.returnNumber,
        lineCount: updated.lines.length,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Abandon a draft.
 *
 * ⚠️ ONLY A DRAFT, AND `purchase_returns_sent_states_complete` MAKES IT LITERAL. A
 *   sent return has moved stock out of the building; "cancelling" it would say the
 *   clinic still has what it posted back. Stock a supplier refuses and sends back is
 *   a new goods receipt.
 */
export async function cancelPurchaseReturn(
  ctx: TenantContext,
  id: string,
  input: CancelPurchaseReturnRequest,
  options: CatalogueActionOptions = {}
): Promise<PurchaseReturnDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await lockReturnOrThrow(tx, id);
    assertBranchInScope(ctx, existing.branchId);

    if (existing.status === 'CANCELLED') {
      throw new ConflictError('This return has already been cancelled.');
    }
    if (existing.status === 'SENT') {
      throw new ConflictError(
        'This return has been sent, so it cannot be cancelled — the stock has left. If the supplier sends it back, record that as a new delivery.'
      );
    }

    const updated = await tx.purchaseReturn.update({
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
      entityType: 'purchase_return',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status },
      after: { status: 'CANCELLED', reason: input.reason },
      ...options,
    });

    return toDetail(updated);
  });
}
