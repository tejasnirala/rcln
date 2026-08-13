/**
 * Procurement: who we buy from, what we asked for, what arrived, what it cost.
 *
 * `products.ts` says what a thing IS, `inventory.ts` says where it is and how
 * much there is, and this is the third side: how it GOT there and at what price.
 *
 * ── QUANTITIES ARE STRINGS, MONEY IS AN INTEGER ─────────────────────────────
 * Both rules are inherited rather than restated. A quantity is
 * `decimalString`/`positiveQuantity` from the two files above, because a base
 * quantity is `Decimal(18,6)` and `0.1` does not survive a JSON double. Money is
 * `…Minor` as `z.int()`, because it is integer minor units in the database
 * (PI-ADR-010) and a float rupee is a rounding error waiting for a total.
 *
 * ⚠️ TWO SHAPES OF MONEY, AND CONFUSING THEM IS THE MISTAKE THIS PARAGRAPH
 *   EXISTS TO PREVENT:
 *
 *     `unitCostBase`   minor units per ONE BASE UNIT. Survives a supplier
 *                      changing their pack size, which is why `batches` stores
 *                      this one and nothing else.
 *     `…Minor`         an AMOUNT of money on a line or a header. Not per
 *                      anything.
 *
 * ── THE CALLER NEVER SENDS A SIGN, AND NEVER SENDS A BASE QUANTITY ──────────
 * The same rule inventory.ts states, for the same reason: a receipt line names a
 * positive quantity and the unit it was counted in, and the server converts
 * through the one `toBaseUnits` the ledger uses. There is deliberately no field
 * below through which a caller could state a negative quantity or a base
 * quantity directly — a receipt that converted differently from its own ledger
 * leg would put the delivery note and the shelves out of step at the exact
 * moment somebody reconciles them.
 *
 * ── TAX IS RECORDED, NEVER CALCULATED (PI-ADR-006) ──────────────────────────
 * Every tax field below is a number the SUPPLIER put on a piece of paper. The
 * server stores it and computes nothing from it; `@rcln/tax` prices SALES and is
 * never called from this surface. `taxRateBps` in particular is for the record
 * only and is applied to nothing.
 *
 * NO PHI ANYWHERE ON THIS SURFACE. A purchase names products, suppliers,
 * quantities and money. The one PHI-adjacent thing procurement touches is a
 * SERIAL — `serials.assigned_patient_id` — and a receipt only ever CREATES
 * serials, never reads a patient link.
 */
import { z } from 'zod';
import { currencyCode, uuid } from './common.js';
import { catalogueCode, decimalString, effectiveDate } from './products.js';
import { positiveQuantity, stockStatus } from './inventory.js';
import { taxScheme } from './tax.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in procurement.prisma
// ---------------------------------------------------------------------------

export const supplierStatus = z.enum(['ACTIVE', 'ON_HOLD', 'BLACKLISTED']);

export const purchaseRequisitionStatus = z.enum([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ORDERED',
]);

export const purchaseOrderStatus = z.enum([
  'DRAFT',
  'ISSUED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
]);

export const goodsReceiptStatus = z.enum(['DRAFT', 'POSTED', 'CANCELLED']);

export const goodsReceiptQualityStatus = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'ACCEPTED',
  'REJECTED',
]);

export const purchaseReturnStatus = z.enum(['DRAFT', 'SENT', 'CANCELLED']);

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * An amount of money in integer minor units. Never negative on this surface.
 *
 * ⚠️ A NEGATIVE AMOUNT ON A PURCHASE IS NOT A SUPPLIER'S PRICING DECISION, IT IS
 *   A BUG. A credit is a purchase RETURN, which is its own document with its own
 *   stock movement — because a credit that arrives as a negative line on the
 *   original order leaves the stock on the shelf while the money says it went
 *   back.
 */
export const minorAmount = z.int().min(0);

/**
 * How the quantity on a line was entered — a unit, or a level of the product's
 * own packaging ladder, never both.
 *
 * ⚠️ EXTRACTED RATHER THAN REPEATED SIX TIMES, AND THE `.refine` IS THE REASON.
 *   Every document in this file resolves quantities through the same
 *   `toBaseUnits`, and a copy of this shape that lost the refinement would let a
 *   caller send a unit AND a packaging level — a quantity with two answers, which
 *   the server would silently resolve by whichever branch it checked first.
 */
const enteredQuantity = {
  quantity: positiveQuantity,
  unitId: uuid.nullish(),
  packagingLevel: z.number().int().min(0).max(10).nullish(),
};

const oneQuantityBasis = (v: {
  unitId?: string | null | undefined;
  packagingLevel?: number | null | undefined;
}): boolean => v.unitId === null || v.unitId === undefined || v.packagingLevel == null;

const oneQuantityBasisMessage =
  'give either a unit or a packaging level, not both — a quantity that names both has two answers';

/** The page shape every list response below shares. */
const listMeta = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const documentPage = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// ===========================================================================
// Suppliers (PI-4.1)
// ===========================================================================

/**
 * ⚠️ `code` IS `catalogueCode` — UPPERCASE AND FLAT, LIKE EVERY OTHER CODE IN THE
 *   PROGRAMME. It is what a buyer types into a search box and what a report
 *   groups by, so `Medi-Dist`, `MEDI-DIST` and `medi dist ` as three suppliers is
 *   the failure it prevents.
 */
export const createSupplierRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(2).max(255),
  /** The name on the contract, when it differs from the name over the door. */
  legalName: z.string().trim().min(2).max(255).nullish(),
  status: supplierStatus.default('ACTIVE'),

  contactPerson: z.string().trim().max(255).nullish(),
  email: z.email().max(320).nullish(),
  phone: z.string().trim().max(32).nullish(),
  website: z.string().trim().max(255).nullish(),

  addressLine1: z.string().trim().max(255).nullish(),
  addressLine2: z.string().trim().max(255).nullish(),
  city: z.string().trim().max(128).nullish(),
  /**
   * ISO 3166-2 without the country prefix, the same vocabulary the tax domain
   * speaks. It decides intra- versus inter-state on an Indian purchase, which is
   * why it is a field rather than a line of the address.
   */
  regionCode: z.string().trim().max(10).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'two letters, e.g. IN')
    .toUpperCase()
    .nullish(),

  /** What they quote in. A DEFAULT for new orders, never a constraint on them. */
  defaultCurrency: currencyCode.nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

/**
 * ⚠️ NO `code` HERE, FOR THE REASON `stockReasonCode` HAS NONE. Purchase orders,
 *   receipts and returns are searched and reconciled by supplier code, and
 *   renaming one silently detaches three years of a buyer's muscle memory from
 *   the rows it refers to. The NAME is what a clinic wanted to change nine times
 *   in ten, and it is editable.
 */
export const updateSupplierRequest = createSupplierRequest.omit({ code: true }).partial();

export const supplierQuery = z.object({
  ...documentPage,
  status: supplierStatus.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  includeDeleted: z.stringbool().default(false),
});

export const supplierTaxIdentifierDetail = z.object({
  id: uuid,
  countryCode: z.string(),
  regionCode: z.string().nullable(),
  scheme: taxScheme,
  registrationNumber: z.string(),
  legalName: z.string().nullable(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullable(),
});

export const supplierSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  status: supplierStatus,
  contactPerson: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  regionCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  /** How many products the price book carries for them. */
  productCount: z.number().int(),
  isDeleted: z.boolean(),
});

export const supplierDetail = supplierSummary.extend({
  website: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  postalCode: z.string().nullable(),
  paymentTermsDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  taxIdentifiers: z.array(supplierTaxIdentifierDetail),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const supplierListResponse = z.object({
  suppliers: z.array(supplierSummary),
  meta: listMeta,
});

/**
 * A supplier's registration in one jurisdiction.
 *
 * ⚠️ NOTHING PRICES ANYTHING FROM THIS. It is recorded so the purchase document
 *   is complete and so a supplier report can be filed; `@rcln/tax` prices SALES
 *   and never sees it. See the model comment on `supplier_tax_identifiers`.
 */
export const createSupplierTaxIdentifierRequest = z.object({
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'two letters, e.g. IN')
    .toUpperCase(),
  regionCode: z.string().trim().max(10).nullish(),
  scheme: taxScheme,
  registrationNumber: z.string().trim().min(4).max(64),
  legalName: z.string().trim().max(255).nullish(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullish(),
});

export const updateSupplierTaxIdentifierRequest = z
  .object({
    legalName: z.string().trim().max(255).nullable(),
    effectiveFrom: effectiveDate,
    effectiveTo: effectiveDate.nullable(),
  })
  .partial();

// ===========================================================================
// Supplier products — the translation layer (PI-4.2)
// ===========================================================================

/**
 * ⚠️ `quantityPerPack` IS IN THE PRODUCT'S **BASE UNIT**, NOT IN `packUnitId`,
 *   AND IT IS THE FIELD MOST LIKELY TO BE FILLED IN WRONG. It answers "how many
 *   base units come in one of the supplier's packs" — 100 capsules in a box of 10
 *   strips of 10. `packUnitId` is only the WORD the supplier uses, so the order
 *   prints "5 BOX" rather than "500 capsule".
 *
 *   Without this field every purchase order line re-enters the conversion by
 *   hand, and every one of them is a chance to order ten times too many.
 */
export const createSupplierProductRequest = z.object({
  productId: uuid,
  supplierSku: z.string().trim().min(1).max(128),
  supplierProductName: z.string().trim().max(255).nullish(),
  packUnitId: uuid,
  /** Base units in ONE pack. THE conversion. */
  quantityPerPack: positiveQuantity,
  /** What one pack costs. Per PACK, because that is what a supplier quotes. */
  pricePerPackMinor: minorAmount,
  currency: currencyCode,
  priceEffectiveFrom: effectiveDate,
  priceEffectiveTo: effectiveDate.nullish(),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  /** Their minimum, in PACKS. Warned about, never enforced — see the model. */
  minimumOrderPacks: positiveQuantity.nullish(),
  isPreferred: z.boolean().default(false),
  notes: z.string().trim().max(4000).nullish(),
});

/**
 * ⚠️ NEITHER `productId` NOR `supplierSku` IS EDITABLE. Together with the
 *   supplier they ARE the row's identity — repointing a price at a different
 *   product would silently restate what every past order line was priced from.
 *   A different SKU is a different row, which is exactly what a supplier
 *   splitting a 10-pack from a 100-pack means.
 */
export const updateSupplierProductRequest = createSupplierProductRequest
  .omit({ productId: true, supplierSku: true })
  .extend({ isActive: z.boolean() })
  .partial();

export const supplierProductQuery = z.object({
  ...documentPage,
  supplierId: uuid.optional(),
  productId: uuid.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  includeInactive: z.stringbool().default(false),
});

export const supplierProductSummary = z.object({
  id: uuid,
  supplierId: uuid,
  supplierCode: z.string(),
  supplierName: z.string(),
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  supplierSku: z.string(),
  supplierProductName: z.string().nullable(),
  packUnitId: uuid,
  packUnitSymbol: z.string(),
  quantityPerPack: decimalString,
  pricePerPackMinor: z.int(),
  currency: z.string(),
  /**
   * The per-base-unit cost this row implies, rounded HALF-UP to the minor unit.
   *
   * ⚠️ DERIVED FOR DISPLAY AND NEVER STORED FROM HERE. The figure a purchase
   *   order line records is computed at ordering time from the quantity actually
   *   ordered, so a rounding here can never leak into a cost on a shelf. It is
   *   returned because "₹4.12 per capsule" is the number a buyer compares two
   *   suppliers on, and making the screen do the division is how two screens end
   *   up rounding differently.
   */
  unitCostBase: z.int(),
  priceEffectiveFrom: effectiveDate,
  priceEffectiveTo: effectiveDate.nullable(),
  leadTimeDays: z.number().int().nullable(),
  minimumOrderPacks: decimalString.nullable(),
  isPreferred: z.boolean(),
  isActive: z.boolean(),
  notes: z.string().nullable(),
});

export const supplierProductListResponse = z.object({
  supplierProducts: z.array(supplierProductSummary),
  meta: listMeta,
});

// ===========================================================================
// Requisitions (PI-4.3)
// ===========================================================================

export const purchaseRequisitionLineRequest = z
  .object({
    productId: uuid,
    ...enteredQuantity,
    /** Advice to the buyer. The order records what actually happened. */
    suggestedSupplierId: uuid.nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine(oneQuantityBasis, oneQuantityBasisMessage);

export const createPurchaseRequisitionRequest = z.object({
  branchId: uuid,
  /** A DATE — "we need it by the 14th" is a fact about a day at the clinic. */
  requiredBy: effectiveDate.nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(purchaseRequisitionLineRequest).min(1).max(200),
});

/** A draft's lines are REPLACED wholesale, the way a transfer's are. */
export const updatePurchaseRequisitionRequest = z
  .object({
    requiredBy: effectiveDate.nullable(),
    notes: z.string().trim().max(2000).nullable(),
    lines: z.array(purchaseRequisitionLineRequest).min(1).max(200),
  })
  .partial();

/**
 * ⚠️ THE REJECTION REASON IS REQUIRED AND THE APPROVAL NOTE IS NOT, AND THAT
 *   ASYMMETRY IS DELIBERATE. A refusal the requester cannot act on gets raised
 *   again unchanged; an approval explains itself.
 */
export const rejectPurchaseRequisitionRequest = z.object({
  reason: z.string().trim().min(4).max(2000),
});

export const purchaseRequisitionQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  status: purchaseRequisitionStatus.optional(),
  /** "What is waiting for me to approve" — the reason the state exists. */
  awaitingApproval: z.stringbool().default(false),
  q: z.string().trim().min(1).max(120).optional(),
});

export const purchaseRequisitionLineDetail = z.object({
  id: uuid,
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  quantityBase: decimalString,
  quantityEntered: decimalString,
  unitSymbol: z.string(),
  suggestedSupplierId: uuid.nullable(),
  suggestedSupplierName: z.string().nullable(),
  notes: z.string().nullable(),
});

export const purchaseRequisitionSummary = z.object({
  id: uuid,
  requisitionNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  status: purchaseRequisitionStatus,
  requiredBy: effectiveDate.nullable(),
  lineCount: z.number().int(),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
  submittedAt: z.iso.datetime().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  approvedByName: z.string().nullable(),
  rejectedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  /**
   * Whether THIS caller may approve it.
   *
   * ⚠️ COMPUTED SERVER-SIDE, BECAUSE THE ANSWER DEPENDS ON WHO IS ASKING. It is
   *   false for the requisition's own creator however many permissions they hold
   *   — the `purchase_requisitions_approver_is_not_creator` CHECK would refuse the
   *   write, and a button that produces a 400 is worse than no button. It is
   *   presentation only: the service re-decides, and the CHECK decides again.
   */
  canApprove: z.boolean(),
});

export const purchaseRequisitionDetail = purchaseRequisitionSummary.extend({
  notes: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  rejectedByName: z.string().nullable(),
  cancelledByName: z.string().nullable(),
  lines: z.array(purchaseRequisitionLineDetail),
});

export const purchaseRequisitionListResponse = z.object({
  requisitions: z.array(purchaseRequisitionSummary),
  meta: listMeta,
});

// ===========================================================================
// Purchase orders (PI-4.4)
// ===========================================================================

/**
 * One line on an order.
 *
 * ⚠️ THE PRICE IS OPTIONAL AND THE PRICE BOOK IS THE FALLBACK, NOT THE REVERSE.
 *   A buyer who names a `supplierProductId` and no price gets the price book's,
 *   resolved at ordering time and copied onto the line; a buyer who names a price
 *   overrides it, because a phone negotiation beats a catalogue and refusing it
 *   would make the price book a gate rather than a convenience. Either way the
 *   line stores what was agreed, so a later price change rewrites nothing.
 */
export const purchaseOrderLineRequest = z
  .object({
    productId: uuid,
    supplierProductId: uuid.nullish(),
    ...enteredQuantity,
    /** Per PACK, as quoted. Needs `packQuantityBase` beside it. */
    pricePerPackMinor: minorAmount.nullish(),
    /** Base units in one of those packs. Half of a price is a price per nothing. */
    packQuantityBase: positiveQuantity.nullish(),
    /**
     * Per BASE UNIT. The alternative to the pack pair, for a buyer who thinks in
     * base units — and the canonical figure either way, because it is what
     * `batches.unit_cost_base` is set from at receipt.
     */
    unitCostBase: minorAmount.nullish(),
    /** For the record only. ⚠️ Applied to nothing (PI-ADR-006). */
    taxRateBps: z.number().int().min(0).max(10000).nullish(),
    /** What the supplier says the tax comes to. Recorded, never computed. */
    taxAmountMinor: minorAmount.nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine(oneQuantityBasis, oneQuantityBasisMessage)
  .refine(
    (v) => (v.pricePerPackMinor == null) === (v.packQuantityBase == null),
    'a price per pack needs the pack size beside it — half of it is a price per nothing'
  );

export const createPurchaseOrderRequest = z.object({
  branchId: uuid,
  supplierId: uuid,
  /** Where it came from, when it came from a requisition. */
  requisitionId: uuid.nullish(),
  /** Defaults to the supplier's `defaultCurrency` when they have one. */
  currency: currencyCode.nullish(),
  expectedDate: effectiveDate.nullish(),
  /** Where it should be delivered. The RECEIPT decides for certain. */
  deliverToLocationId: uuid.nullish(),
  terms: z.string().trim().max(4000).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(purchaseOrderLineRequest).min(1).max(200),
});

export const updatePurchaseOrderRequest = z
  .object({
    expectedDate: effectiveDate.nullable(),
    deliverToLocationId: uuid.nullable(),
    terms: z.string().trim().max(4000).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    lines: z.array(purchaseOrderLineRequest).min(1).max(200),
  })
  .partial();

/**
 * ⚠️ `CLOSED` IS THE ONE STATUS WHOSE WHOLE MEANING IS ITS REASON. It says "the
 *   buyer decided nothing more is coming", which is a judgement rather than an
 *   event, so the reason is not optional. Without this status a buyer's only
 *   options for a short shipment are a permanent phantom expectation on the
 *   "what are we waiting for" screen or a falsified receipt.
 */
export const closePurchaseOrderRequest = z.object({
  reason: z.string().trim().min(4).max(2000),
});

export const cancelPurchaseOrderRequest = z.object({
  reason: z.string().trim().min(4).max(2000),
});

export const purchaseOrderQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  supplierId: uuid.optional(),
  status: purchaseOrderStatus.optional(),
  /** "What are we still waiting for" — issued and not fully received. */
  outstandingOnly: z.stringbool().default(false),
  q: z.string().trim().min(1).max(120).optional(),
});

export const purchaseOrderLineDetail = z.object({
  id: uuid,
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  supplierProductId: uuid.nullable(),
  supplierSku: z.string().nullable(),
  orderedQuantityBase: decimalString,
  receivedQuantityBase: decimalString,
  /** `ordered − received`, computed with Decimal arithmetic and never a double. */
  outstandingQuantityBase: decimalString,
  quantityEntered: decimalString,
  unitSymbol: z.string(),
  unitCostBase: z.int(),
  pricePerPackMinor: z.int().nullable(),
  packQuantityBase: decimalString.nullable(),
  lineSubtotalMinor: z.int(),
  taxRateBps: z.number().int().nullable(),
  taxAmountMinor: z.int(),
  lineTotalMinor: z.int(),
  notes: z.string().nullable(),
});

export const purchaseOrderSummary = z.object({
  id: uuid,
  orderNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  supplierId: uuid,
  /** The SNAPSHOT this document names them by, not today's supplier row. */
  supplierName: z.string(),
  supplierTaxNumber: z.string().nullable(),
  requisitionId: uuid.nullable(),
  requisitionNumber: z.string().nullable(),
  status: purchaseOrderStatus,
  currency: z.string(),
  expectedDate: effectiveDate.nullable(),
  lineCount: z.number().int(),
  outstandingLineCount: z.number().int(),
  subtotalMinor: z.int(),
  taxAmountMinor: z.int(),
  totalMinor: z.int(),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
  issuedAt: z.iso.datetime().nullable(),
  issuedByName: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});

export const purchaseOrderDetail = purchaseOrderSummary.extend({
  deliverToLocationId: uuid.nullable(),
  deliverToLocationName: z.string().nullable(),
  terms: z.string().nullable(),
  notes: z.string().nullable(),
  closureReason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  lines: z.array(purchaseOrderLineDetail),
});

export const purchaseOrderListResponse = z.object({
  purchaseOrders: z.array(purchaseOrderSummary),
  meta: listMeta,
});

// ===========================================================================
// Goods receipts (PI-4.5)
// ===========================================================================

/**
 * One product, one lot, one serial, as read off the pack.
 *
 * ⚠️ A SERIAL-TRACKED PRODUCT GETS ONE LINE PER SERIAL, QUANTITY ONE. A serial is
 *   one physical device and the ledger takes one serial per movement, so five
 *   implants are five lines — and the
 *   `goods_receipt_lines_serial_quantity` CHECK refuses a line claiming "40 of
 *   serial ABC123", which would put 40 units into a bucket keyed by one device.
 *
 * ⚠️ `expiresOn` IS REQUIRED FOR AN EXPIRY-CONTROLLED PRODUCT, AND THE CONTRACT
 *   CANNOT KNOW WHICH THOSE ARE. Whether the product is expiry-controlled is a
 *   column on `products`, so the check is in the service with a sentence naming
 *   the product. Same for `lotNumber` against the tracking mode. This schema is
 *   the shape; the service is the rule.
 */
export const goodsReceiptLineRequest = z
  .object({
    productId: uuid,
    /** The order line this satisfies, when the receipt has an order. */
    purchaseOrderLineId: uuid.nullish(),
    ...enteredQuantity,

    lotNumber: z.string().trim().min(1).max(128).nullish(),
    manufacturedOn: effectiveDate.nullish(),
    expiresOn: effectiveDate.nullish(),
    retestOn: effectiveDate.nullish(),
    /** May differ from the product's default — contract manufacture, repackaging. */
    manufacturerId: uuid.nullish(),
    serialNumber: z.string().trim().min(1).max(128).nullish(),

    /** Per PACK, as invoiced, with the pack size beside it. */
    pricePerPackMinor: minorAmount.nullish(),
    packQuantityBase: positiveQuantity.nullish(),
    /** Per BASE UNIT. What `batches.unit_cost_base` is set from. */
    unitCostBase: minorAmount.nullish(),
    taxRateBps: z.number().int().min(0).max(10000).nullish(),
    taxAmountMinor: minorAmount.nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine(oneQuantityBasis, oneQuantityBasisMessage)
  .refine(
    (v) => (v.pricePerPackMinor == null) === (v.packQuantityBase == null),
    'a price per pack needs the pack size beside it — half of it is a price per nothing'
  );

export const createGoodsReceiptRequest = z.object({
  branchId: uuid,
  supplierId: uuid,
  purchaseOrderId: uuid.nullish(),
  /** Where it lands. Required — a delivery with no shelf has nowhere to go. */
  locationId: uuid,
  /**
   * When it PHYSICALLY ARRIVED, which is not when this was keyed in. Defaults to
   * now; a receipt entered on Monday for a Friday delivery says Friday, and the
   * ledger legs carry it as their `occurredAt`.
   */
  receivedAt: z.iso.datetime().nullish(),
  currency: currencyCode.nullish(),
  supplierInvoiceNumber: z.string().trim().max(64).nullish(),
  supplierInvoiceDate: effectiveDate.nullish(),

  /** Landed cost. Apportioned across the lines pro-rata by value at POST. */
  freightMinor: minorAmount.default(0),
  dutyMinor: minorAmount.default(0),
  handlingMinor: minorAmount.default(0),

  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(goodsReceiptLineRequest).min(1).max(200),
});

export const updateGoodsReceiptRequest = z
  .object({
    locationId: uuid,
    receivedAt: z.iso.datetime(),
    supplierInvoiceNumber: z.string().trim().max(64).nullable(),
    supplierInvoiceDate: effectiveDate.nullable(),
    freightMinor: minorAmount,
    dutyMinor: minorAmount,
    handlingMinor: minorAmount,
    notes: z.string().trim().max(2000).nullable(),
    lines: z.array(goodsReceiptLineRequest).min(1).max(200),
  })
  .partial();

export const cancelGoodsReceiptRequest = z.object({
  reason: z.string().trim().min(4).max(2000),
});

/**
 * The inspection decision (PI-4.6).
 *
 * ⚠️ A QUANTITY PER LINE AND NOT A "PASS ALL" FLAG, FOR THE REASON A TRANSFER
 *   RECEIPT TAKES ONE. Inspecting a delivery is the moment somebody looks at it,
 *   and a screen with one button for "yes, all of it" is a screen where nobody
 *   looks.
 *
 * ⚠️ `rejectedQuantityBase` MAY BE ZERO ON AN `ACCEPTED` LINE AND MUST BE ABOVE
 *   ZERO ON A `REJECTED` ONE. Rejecting nothing is accepting.
 */
export const decideGoodsReceiptQualityRequest = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid,
        outcome: z.enum(['ACCEPTED', 'REJECTED']),
        /** In the product's BASE UNIT. Required, and above zero, on a rejection. */
        rejectedQuantityBase: positiveQuantity.nullish(),
        /** Required on a rejection — see `goods_receipt_lines_quality_decision_complete`. */
        notes: z.string().trim().max(2000).nullish(),
      })
    )
    .min(1)
    .max(200)
    /*
     * ⚠️ ONE ENTRY PER LINE, AND THIS REFINEMENT IS THE FIRST OF TWO LAYERS. PI-3
     *   learned it the expensive way: its receipt loop measured every entry
     *   against a snapshot loaded once, so two entries naming one line both
     *   passed and both wrote a movement. The service here accumulates within the
     *   request as well, so it does not depend on the request being well-formed
     *   to be correct.
     */
    .refine(
      (lines) => new Set(lines.map((l) => l.lineId)).size === lines.length,
      'each line may appear only once — two decisions on one line have two readings and neither should be guessed'
    ),
});

export const goodsReceiptQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  supplierId: uuid.optional(),
  purchaseOrderId: uuid.optional(),
  status: goodsReceiptStatus.optional(),
  /** "What is waiting for inspection" — the quality screen. */
  awaitingQuality: z.stringbool().default(false),
  q: z.string().trim().min(1).max(120).optional(),
});

export const goodsReceiptLineDetail = z.object({
  id: uuid,
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  purchaseOrderLineId: uuid.nullable(),
  batchId: uuid.nullable(),
  serialId: uuid.nullable(),
  receivedQuantityBase: decimalString,
  rejectedQuantityBase: decimalString,
  quantityEntered: decimalString,
  unitSymbol: z.string(),
  /**
   * The LINE's own snapshot of the lot, not a join to `batches`.
   *
   * ⚠️ THE JOIN IS THE ONE PI-3 GOT WRONG TWICE. A draft has no lot row at all,
   *   so the join is NULL for every unposted receipt — and the person keying a
   *   delivery in is exactly the person who needs to see the lot number they just
   *   typed. The columns are on the line for this.
   */
  lotNumber: z.string().nullable(),
  manufacturedOn: effectiveDate.nullable(),
  expiresOn: effectiveDate.nullable(),
  retestOn: effectiveDate.nullable(),
  manufacturerId: uuid.nullable(),
  manufacturerName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  unitCostBase: z.int(),
  currency: z.string(),
  /** This line's apportioned share of freight, duty and handling. Stored. */
  landedCostMinor: z.int(),
  lineSubtotalMinor: z.int(),
  taxRateBps: z.number().int().nullable(),
  taxAmountMinor: z.int(),
  lineTotalMinor: z.int(),
  qualityStatus: goodsReceiptQualityStatus,
  qualityDecidedAt: z.iso.datetime().nullable(),
  qualityDecidedByName: z.string().nullable(),
  qualityNotes: z.string().nullable(),
  notes: z.string().nullable(),
});

export const goodsReceiptSummary = z.object({
  id: uuid,
  receiptNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  supplierId: uuid,
  supplierName: z.string(),
  purchaseOrderId: uuid.nullable(),
  purchaseOrderNumber: z.string().nullable(),
  status: goodsReceiptStatus,
  locationId: uuid,
  locationName: z.string(),
  receivedAt: z.iso.datetime(),
  currency: z.string(),
  supplierInvoiceNumber: z.string().nullable(),
  supplierInvoiceDate: effectiveDate.nullable(),
  lineCount: z.number().int(),
  /** How many lines are still `PENDING` inspection. */
  awaitingQualityLineCount: z.number().int(),
  goodsValueMinor: z.int(),
  taxAmountMinor: z.int(),
  totalMinor: z.int(),
  /** What the inspection policy WAS at post. A snapshot, not a live read. */
  qualityHoldRequired: z.boolean(),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
  postedAt: z.iso.datetime().nullable(),
  postedByName: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});

export const goodsReceiptDetail = goodsReceiptSummary.extend({
  freightMinor: z.int(),
  dutyMinor: z.int(),
  handlingMinor: z.int(),
  notes: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  cancelledByName: z.string().nullable(),
  lines: z.array(goodsReceiptLineDetail),
});

export const goodsReceiptListResponse = z.object({
  goodsReceipts: z.array(goodsReceiptSummary),
  meta: listMeta,
});

// ===========================================================================
// Purchase returns (PI-4.7)
// ===========================================================================

/**
 * ⚠️ `statusFrom` IS REQUIRED AND HAS NO DEFAULT ON THE WIRE, WHICH IS THE ONLY
 *   PLACE IN THIS FILE A CALLER MUST NAME A STOCK BUCKET. `PURCHASE_RETURN` is
 *   the second movement type in the programme with no default `statusFrom`, for
 *   the reason `DISPOSAL` has none: what is going back — sound stock ordered in
 *   error, stock rejected at inspection, stock damaged in the box — IS the
 *   content of the record, and defaulting it to `AVAILABLE` would let a mis-click
 *   send sellable stock back and file it as routine.
 */
export const purchaseReturnLineRequest = z
  .object({
    productId: uuid,
    /** The receipt line this goes back against. THE traceability join. */
    goodsReceiptLineId: uuid.nullish(),
    batchId: uuid.nullish(),
    serialId: uuid.nullish(),
    ...enteredQuantity,
    statusFrom: stockStatus,
    unitCostBase: minorAmount.nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine(oneQuantityBasis, oneQuantityBasisMessage);

export const createPurchaseReturnRequest = z.object({
  branchId: uuid,
  supplierId: uuid,
  goodsReceiptId: uuid.nullish(),
  /** Where it leaves from. */
  locationId: uuid,
  currency: currencyCode.nullish(),
  /** Required. A return with no reason is one the supplier refuses. */
  reason: z.string().trim().min(4).max(2000),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(purchaseReturnLineRequest).min(1).max(200),
});

export const updatePurchaseReturnRequest = z
  .object({
    locationId: uuid,
    reason: z.string().trim().min(4).max(2000),
    supplierCreditNoteNumber: z.string().trim().max(64).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    lines: z.array(purchaseReturnLineRequest).min(1).max(200),
  })
  .partial();

export const cancelPurchaseReturnRequest = z.object({
  reason: z.string().trim().min(4).max(2000),
});

export const purchaseReturnQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  supplierId: uuid.optional(),
  status: purchaseReturnStatus.optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const purchaseReturnLineDetail = z.object({
  id: uuid,
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  goodsReceiptLineId: uuid.nullable(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: effectiveDate.nullable(),
  serialId: uuid.nullable(),
  serialNumber: z.string().nullable(),
  quantityBase: decimalString,
  quantityEntered: decimalString,
  unitSymbol: z.string(),
  statusFrom: stockStatus,
  unitCostBase: z.int().nullable(),
  currency: z.string().nullable(),
  lineTotalMinor: z.int(),
  notes: z.string().nullable(),
});

export const purchaseReturnSummary = z.object({
  id: uuid,
  returnNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  supplierId: uuid,
  supplierName: z.string(),
  goodsReceiptId: uuid.nullable(),
  goodsReceiptNumber: z.string().nullable(),
  status: purchaseReturnStatus,
  locationId: uuid,
  locationName: z.string(),
  reason: z.string(),
  currency: z.string(),
  lineCount: z.number().int(),
  totalMinor: z.int(),
  supplierCreditNoteNumber: z.string().nullable(),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
  sentAt: z.iso.datetime().nullable(),
  sentByName: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});

export const purchaseReturnDetail = purchaseReturnSummary.extend({
  notes: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  cancelledByName: z.string().nullable(),
  lines: z.array(purchaseReturnLineDetail),
});

export const purchaseReturnListResponse = z.object({
  purchaseReturns: z.array(purchaseReturnSummary),
  meta: listMeta,
});

// ===========================================================================
// Costing (PI-4.8)
// ===========================================================================

export const productCostAverageQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  productId: uuid.optional(),
});

/**
 * What a product has cost, on average, at one branch, in one currency.
 *
 * ⚠️ `valuedQuantityBase` IS THE DENOMINATOR OF AN AVERAGE AND IS **NOT** WHAT THE
 *   BRANCH HOLDS. `stock_balances` is what the branch holds (PI-ADR-004), and the
 *   two legitimately differ the moment anything is dispensed, expired,
 *   transferred or adjusted. A screen that labels this "stock on hand" is wrong.
 *
 * ⚠️ AND THERE MAY BE TWO ROWS FOR ONE PRODUCT AT ONE BRANCH, one per currency,
 *   because this programme applies no FX policy. Averaging across currencies
 *   would invent an exchange rate nobody chose.
 */
export const productCostAverageSummary = z.object({
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  branchId: uuid,
  branchName: z.string(),
  currency: z.string(),
  /** ⚠️ The denominator, not stock on hand. See the schema comment. */
  valuedQuantityBase: decimalString,
  valuedCostMinor: z.int(),
  /** `valuedCostMinor / valuedQuantityBase`, rounded HALF-UP at read. */
  averageCostBase: z.int(),
  receiptCount: z.number().int(),
  lastReceiptAt: z.iso.datetime().nullable(),
});

export const productCostAverageListResponse = z.object({
  costAverages: z.array(productCostAverageSummary),
  meta: listMeta,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupplierStatus = z.infer<typeof supplierStatus>;
export type PurchaseRequisitionStatus = z.infer<typeof purchaseRequisitionStatus>;
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatus>;
export type GoodsReceiptStatus = z.infer<typeof goodsReceiptStatus>;
export type GoodsReceiptQualityStatus = z.infer<typeof goodsReceiptQualityStatus>;
export type PurchaseReturnStatus = z.infer<typeof purchaseReturnStatus>;

export type CreateSupplierRequest = z.infer<typeof createSupplierRequest>;
export type UpdateSupplierRequest = z.infer<typeof updateSupplierRequest>;
export type SupplierQuery = z.infer<typeof supplierQuery>;
export type SupplierTaxIdentifierDetail = z.infer<typeof supplierTaxIdentifierDetail>;
export type SupplierSummary = z.infer<typeof supplierSummary>;
export type SupplierDetail = z.infer<typeof supplierDetail>;
export type SupplierListResponse = z.infer<typeof supplierListResponse>;
export type CreateSupplierTaxIdentifierRequest = z.infer<typeof createSupplierTaxIdentifierRequest>;
export type UpdateSupplierTaxIdentifierRequest = z.infer<typeof updateSupplierTaxIdentifierRequest>;

export type CreateSupplierProductRequest = z.infer<typeof createSupplierProductRequest>;
export type UpdateSupplierProductRequest = z.infer<typeof updateSupplierProductRequest>;
export type SupplierProductQuery = z.infer<typeof supplierProductQuery>;
export type SupplierProductSummary = z.infer<typeof supplierProductSummary>;
export type SupplierProductListResponse = z.infer<typeof supplierProductListResponse>;

export type PurchaseRequisitionLineRequest = z.infer<typeof purchaseRequisitionLineRequest>;
export type CreatePurchaseRequisitionRequest = z.infer<typeof createPurchaseRequisitionRequest>;
export type UpdatePurchaseRequisitionRequest = z.infer<typeof updatePurchaseRequisitionRequest>;
export type RejectPurchaseRequisitionRequest = z.infer<typeof rejectPurchaseRequisitionRequest>;
export type PurchaseRequisitionQuery = z.infer<typeof purchaseRequisitionQuery>;
export type PurchaseRequisitionLineDetail = z.infer<typeof purchaseRequisitionLineDetail>;
export type PurchaseRequisitionSummary = z.infer<typeof purchaseRequisitionSummary>;
export type PurchaseRequisitionDetail = z.infer<typeof purchaseRequisitionDetail>;
export type PurchaseRequisitionListResponse = z.infer<typeof purchaseRequisitionListResponse>;

export type PurchaseOrderLineRequest = z.infer<typeof purchaseOrderLineRequest>;
export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderRequest>;
export type UpdatePurchaseOrderRequest = z.infer<typeof updatePurchaseOrderRequest>;
export type ClosePurchaseOrderRequest = z.infer<typeof closePurchaseOrderRequest>;
export type CancelPurchaseOrderRequest = z.infer<typeof cancelPurchaseOrderRequest>;
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuery>;
export type PurchaseOrderLineDetail = z.infer<typeof purchaseOrderLineDetail>;
export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummary>;
export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetail>;
export type PurchaseOrderListResponse = z.infer<typeof purchaseOrderListResponse>;

export type GoodsReceiptLineRequest = z.infer<typeof goodsReceiptLineRequest>;
export type CreateGoodsReceiptRequest = z.infer<typeof createGoodsReceiptRequest>;
export type UpdateGoodsReceiptRequest = z.infer<typeof updateGoodsReceiptRequest>;
export type CancelGoodsReceiptRequest = z.infer<typeof cancelGoodsReceiptRequest>;
export type DecideGoodsReceiptQualityRequest = z.infer<typeof decideGoodsReceiptQualityRequest>;
export type GoodsReceiptQuery = z.infer<typeof goodsReceiptQuery>;
export type GoodsReceiptLineDetail = z.infer<typeof goodsReceiptLineDetail>;
export type GoodsReceiptSummary = z.infer<typeof goodsReceiptSummary>;
export type GoodsReceiptDetail = z.infer<typeof goodsReceiptDetail>;
export type GoodsReceiptListResponse = z.infer<typeof goodsReceiptListResponse>;

export type PurchaseReturnLineRequest = z.infer<typeof purchaseReturnLineRequest>;
export type CreatePurchaseReturnRequest = z.infer<typeof createPurchaseReturnRequest>;
export type UpdatePurchaseReturnRequest = z.infer<typeof updatePurchaseReturnRequest>;
export type CancelPurchaseReturnRequest = z.infer<typeof cancelPurchaseReturnRequest>;
export type PurchaseReturnQuery = z.infer<typeof purchaseReturnQuery>;
export type PurchaseReturnLineDetail = z.infer<typeof purchaseReturnLineDetail>;
export type PurchaseReturnSummary = z.infer<typeof purchaseReturnSummary>;
export type PurchaseReturnDetail = z.infer<typeof purchaseReturnDetail>;
export type PurchaseReturnListResponse = z.infer<typeof purchaseReturnListResponse>;

export type ProductCostAverageQuery = z.infer<typeof productCostAverageQuery>;
export type ProductCostAverageSummary = z.infer<typeof productCostAverageSummary>;
export type ProductCostAverageListResponse = z.infer<typeof productCostAverageListResponse>;
