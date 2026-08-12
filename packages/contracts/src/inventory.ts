/**
 * Inventory: where a thing IS and how much of it there is.
 *
 * `products.ts` is the other half of this pair and carries no quantity
 * anywhere. Everything with a quantity is here, and every quantity resolves to
 * the product's BASE UNIT before it is stored (PI-ADR-004).
 *
 * ── QUANTITIES ARE STRINGS ON THE WIRE ──────────────────────────────────────
 * For exactly the reason products.ts states: a base quantity is
 * `Decimal(18,6)`, a JSON number is an IEEE-754 double, and `0.1` does not
 * survive the round trip. `decimalString` is imported from there rather than
 * redeclared — a second copy is how one of them ends up allowing seven decimal
 * places.
 *
 * ── THE CALLER NEVER SENDS A SIGN, AND NEVER SENDS A BASE QUANTITY ──────────
 * A movement request names a `movementType`, a positive `quantity` and the unit
 * it was counted in. The server derives the sign from the type, converts to
 * base units through `services/product/units.ts`, and refuses an inexact
 * conversion. There is deliberately no field on any request below through which
 * a caller could state `-5`, or state a base quantity directly.
 *
 * ⚠️ NO PHI ON THE WIRE EXCEPT ONE FIELD, AND IT IS MARKED. `serialDetail`
 *   carries `assignedPatientId` — "device 7742 is in this named person" — which
 *   is why every read that returns it writes a `data_access_logs` row
 *   (PI-ADR-016). No product name, no patient name, ever appears beside it in a
 *   log.
 */
import { z } from 'zod';
// `currencyCode` is `common.ts`'s, which additionally checks the code against
// `Intl.supportedValuesOf('currency')`. A second one here would have been three
// lines and one fewer check.
import { currencyCode, uuid } from './common.js';
import { catalogueCode, decimalString, effectiveDate, trackingMode } from './products.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in inventory.prisma
// ---------------------------------------------------------------------------

export const locationKind = z.enum([
  'MAIN_PHARMACY',
  'SATELLITE_PHARMACY',
  'REFRIGERATOR',
  'FREEZER',
  'CONTROLLED_CABINET',
  'DEPARTMENT_STORE',
  'PROCEDURE_ROOM',
  'LAB_STORE',
  'DENTAL_STORE',
  'VETERINARY_STORE',
  'CENTRAL_WAREHOUSE',
  'CONSIGNMENT',
  'DISPOSAL',
]);

export const batchStatus = z.enum([
  'ACTIVE',
  'QUARANTINED',
  'EXPIRED',
  'RECALLED',
  'DAMAGED',
  'DISPOSED',
]);

export const stockStatus = z.enum([
  'AVAILABLE',
  'RESERVED',
  'QUARANTINED',
  'BLOCKED',
  'EXPIRED',
  'DAMAGED',
  'RECALLED',
  'DISPOSED',
  'IN_TRANSIT',
]);

export const serialStatus = z.enum([
  'IN_STOCK',
  'ISSUED',
  'RETURNED',
  'QUARANTINED',
  'RECALLED',
  'DAMAGED',
  'DISPOSED',
]);

export const stockMovementType = z.enum([
  'PURCHASE_RECEIPT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'DISPENSING',
  'CLINICAL_CONSUMPTION',
  'ADJUSTMENT',
  'DAMAGE',
  'EXPIRY',
  'RECALL',
  'RETURN',
  'DISPOSAL',
  'RESERVATION',
  'RELEASE',
  'QUARANTINE',
  'QUARANTINE_RELEASE',
]);

export const stockReferenceType = z.enum([
  'MANUAL',
  'GOODS_RECEIPT',
  'PURCHASE_RETURN',
  'DISPENSE',
  'CONSUMPTION',
  'TRANSFER',
  'STOCK_TAKE',
  'RECALL',
  'EXPIRY_SWEEP',
  'ONLINE_ORDER',
]);

/**
 * The movement types a caller may ask for over HTTP in PI-2.
 *
 * ⚠️ DELIBERATELY A SUBSET OF `stockMovementType`. `DISPENSING` belongs to PI-7
 *   and must consult the regulatory engine first; `CLINICAL_CONSUMPTION` is
 *   PI-9; `TRANSFER_IN`/`TRANSFER_OUT` are PI-3 and are only ever written as a
 *   PAIR inside one transaction, which a single-movement endpoint cannot
 *   guarantee; `PURCHASE_RECEIPT` becomes a goods receipt in PI-4. Exposing them
 *   now would let a caller write one leg of a two-leg movement and leave stock
 *   that has left one branch and arrived at none.
 *
 *   The enum members exist in the database from today so none of those phases
 *   needs a migration. What is missing is the ROUTE, not the vocabulary.
 */
export const manualMovementType = z.enum([
  'ADJUSTMENT',
  'RETURN',
  'DAMAGE',
  'DISPOSAL',
  'QUARANTINE',
  'QUARANTINE_RELEASE',
]);

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * A quantity a human typed into a form. Strictly positive.
 *
 * ⚠️ THE SIGN IS NOT NEGOTIABLE HERE AND IS NOT A VALIDATION DETAIL. A caller
 *   that could send `-5` on a receipt would produce a row indistinguishable from
 *   a genuine issue in every report that reads the ledger. The direction comes
 *   from `movementType` and from nowhere else — see the file header and the
 *   `stock_ledger_direction` CHECK.
 */
export const positiveQuantity = decimalString.refine(
  (v) => Number.parseFloat(v) > 0,
  'must be greater than zero'
);

/**
 * A SIGNED decimal string, for reading the ledger back.
 *
 * ⚠️ THERE IS NO REQUEST FIELD OF THIS TYPE, AND THERE MUST NOT BE. `quantityBase`
 *   is negative on every issue, so the response shape needs a sign that
 *   `decimalString` deliberately refuses. That refusal is the point on the way
 *   IN — see `positiveQuantity` — so the two are separate schemas rather than one
 *   permissive schema used in both directions.
 */
export const signedDecimalString = z
  .string()
  .regex(/^-?\d+(\.\d{1,6})?$/, 'a signed number with up to 6 decimal places');

/**
 * A reason code for an adjustment. Uppercase and flat, like every other code in
 * the programme — it is aggregated in reports, so free text would produce
 * "Damaged", "damaged" and "DAMAGED " as three categories.
 */
export const reasonCode = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'uppercase letters, digits and underscores only');

/**
 * A ledger quantity, trimmed to what a person reads. `100.000000` -> `100`.
 *
 * ⚠️ IT LIVES IN THE CONTRACTS PACKAGE, BESIDE `decimalString`, BECAUSE THAT IS
 *   WHERE IT CAN BE TESTED. It began in `apps/web`, where it shipped a bug that
 *   rendered `100` as `1` — and `apps/web` has no test suite at all, so nothing
 *   could have caught it there. This is the display inverse of the wire format
 *   defined two dozen lines up; both halves of one rule belong together, and
 *   `apps/api`'s unit suite covers it.
 *
 * ⚠️ THE FRACTION IS ANCHORED TO A DECIMAL POINT. The first version was
 *   `/\.?0+$/` — an OPTIONAL point — so on an integer it ate the trailing zeros
 *   of the NUMBER: `'100'` became `'1'`, `'500'` became `'5'`, `'-30'` became
 *   `'-3'`. Every quantity on every stock screen, wrong by an order of
 *   magnitude, on a screen a pharmacist reconciles against a shelf.
 *
 *   A bare integer is a legitimate wire value — `decimalString` accepts one and
 *   Prisma's `Decimal.toString()` drops the fractional zeros before the string
 *   leaves the server — so it was not a theoretical input. It broke no test
 *   because it returned a plausible number.
 */
export function readableQuantity(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  const trimmed = quantity.replace(/0+$/, '').replace(/\.$/, '');
  // `-0.000000` trims to `-0`, which is a quantity nobody writes. The empty and
  // bare-sign cases cannot arise from a valid decimal string, and are caught for
  // the same reason: this renders a number a pharmacist counts against.
  if (trimmed === '' || trimmed === '-' || trimmed === '-0') return '0';
  return trimmed;
}

// ---------------------------------------------------------------------------
// Locations, areas and bins
// ---------------------------------------------------------------------------

export const createInventoryLocationRequest = z.object({
  /*
   * ⚠️ REQUIRED, AND NOT DEFAULTED FROM THE CALLER'S FIRST BRANCH. A location
   *   belongs to one site, and an org-wide administrator has every branch in
   *   scope — picking one for them would silently create the fridge at head
   *   office. The route checks it is in scope.
   */
  branchId: uuid,
  kind: locationKind,
  code: catalogueCode,
  name: z.string().trim().min(1).max(255),
  isDispensingPoint: z.boolean().default(false),
  requiresControlledAccess: z.boolean().default(false),
  storageProfileId: uuid.nullish(),
});

export const updateInventoryLocationRequest = z
  .object({
    kind: locationKind,
    name: z.string().trim().min(1).max(255),
    isDispensingPoint: z.boolean(),
    requiresControlledAccess: z.boolean(),
    storageProfileId: uuid.nullable(),
    isActive: z.boolean(),
  })
  /*
   * ⚠️ NEITHER `branchId` NOR `code` IS EDITABLE. Moving a location to another
   *   branch would move every balance and every historical movement under it to
   *   a site they never happened at, with no row updated and nothing to detect
   *   it — the same class of silent reinterpretation as changing a product's
   *   base unit. A location at the wrong branch is deactivated and recreated,
   *   which leaves the history where it happened.
   */
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const inventoryLocationQuery = z.object({
  branchId: uuid.optional(),
  kind: locationKind.optional(),
  includeInactive: z.stringbool().default(false),
});

export const storageBinDetail = z.object({
  id: uuid,
  code: z.string(),
  label: z.string().nullable(),
  isActive: z.boolean(),
});

export const storageAreaDetail = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  bins: z.array(storageBinDetail),
});

export const inventoryLocationSummary = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  kind: locationKind,
  code: z.string(),
  name: z.string(),
  isDispensingPoint: z.boolean(),
  requiresControlledAccess: z.boolean(),
  storageProfileId: uuid.nullable(),
  storageProfileName: z.string().nullable(),
  isActive: z.boolean(),
  /** How many areas hang off it. The list does not load them. */
  areaCount: z.number().int(),
});

export const inventoryLocationDetail = inventoryLocationSummary.extend({
  areas: z.array(storageAreaDetail),
});

export const inventoryLocationListResponse = z.object({
  locations: z.array(inventoryLocationSummary),
});

/**
 * Areas and bins are REPLACED WHOLESALE, not patched one at a time.
 *
 * The same call `replacePackagings` makes, for a weaker version of the same
 * reason: a location's shelving is edited as a layout on one screen, and
 * per-row endpoints turn one save into n requests that can half-apply. Bins are
 * nested inside their area so the two can never be posted inconsistently.
 */
export const storageAreaRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(1).max(255),
  isActive: z.boolean().default(true),
  bins: z
    .array(
      z.object({
        code: catalogueCode,
        label: z.string().trim().max(255).nullish(),
        isActive: z.boolean().default(true),
      })
    )
    .max(500)
    .default([]),
});

export const replaceStorageAreasRequest = z.object({
  areas: z.array(storageAreaRequest).max(100),
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export const createBatchRequest = z.object({
  branchId: uuid,
  productId: uuid,
  lotNumber: z.string().trim().min(1).max(128),
  manufacturedOn: effectiveDate.nullish(),
  /*
   * Nullable here and REQUIRED BY THE DATABASE for an expiry-controlled product
   * — the `batches_expiry_required` trigger. It is not required by this schema
   * because whether it is required depends on the product, which the contract
   * cannot see. The service checks it first so the caller gets a sentence.
   */
  expiresOn: effectiveDate.nullish(),
  retestOn: effectiveDate.nullish(),
  manufacturerId: uuid.nullish(),
  /**
   * Cost per BASE UNIT in integer minor units — 1250 is ₹12.50 per tablet, not
   * per strip. Per base unit so a supplier changing pack size does not restate
   * the value of what is already on the shelf.
   */
  unitCostBase: z.number().int().min(0).nullish(),
  currency: currencyCode.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export const updateBatchRequest = z
  .object({
    manufacturedOn: effectiveDate.nullable(),
    expiresOn: effectiveDate.nullable(),
    retestOn: effectiveDate.nullable(),
    manufacturerId: uuid.nullable(),
    unitCostBase: z.number().int().min(0).nullable(),
    currency: currencyCode.nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  /*
   * ⚠️ `status` IS NOT EDITABLE HERE, AND THAT IS THE WHOLE POINT OF THE LEDGER.
   *   Quarantining or recalling a lot MOVES QUANTITY between status buckets, so
   *   it is a movement with a reason and an audit row, not a column edit. A
   *   `PATCH { status: 'QUARANTINED' }` would leave `stock_balances` saying the
   *   stock is still available and the batch saying it is not — two answers to
   *   one question, and the dispensing screen reads the one that lets it
   *   dispense. Use POST /v1/stock/movements.
   *
   * ⚠️ `lotNumber`, `productId` and `branchId` are not editable either: they are
   *   the identity of the row, and every movement already written cites it.
   */
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const batchQuery = z.object({
  branchId: uuid.optional(),
  productId: uuid.optional(),
  status: batchStatus.optional(),
  q: z.string().trim().min(1).max(128).optional(),
  /** Lots expiring within N days. The near-expiry report, as a filter. */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  /**
   * Hide lots with nothing left.
   *
   * ⚠️ DEFAULT FALSE, AND DELIBERATELY. A lot has to stay answerable long after
   *   its stock is gone — a recall asks about lots that were fully dispensed
   *   years ago, which is the one question this list must never hide. Callers
   *   that want "what is on the shelf" ask for it.
   */
  onlyWithStock: z.stringbool().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['expiresOn', 'lotNumber', 'receivedAt']).default('expiresOn'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const batchSummary = z.object({
  id: uuid,
  branchId: uuid,
  productId: uuid,
  productName: z.string(),
  productCode: z.string(),
  lotNumber: z.string(),
  manufacturedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  retestOn: z.string().nullable(),
  manufacturerId: uuid.nullable(),
  manufacturerName: z.string().nullable(),
  unitCostBase: z.number().int().nullable(),
  currency: z.string().nullable(),
  status: batchStatus,
  receivedAt: z.string(),
  /** Sum across every status bucket, in base units. A string — see the header. */
  quantityOnHand: decimalString,
  /** The allocatable part of it. What FEFO may actually take. */
  quantityAvailable: decimalString,
  baseUnitSymbol: z.string(),
  quarantinedAt: z.string().nullable(),
  quarantineReason: z.string().nullable(),
  recalledAt: z.string().nullable(),
  recallReference: z.string().nullable(),
});

export const batchListResponse = z.object({
  batches: z.array(batchSummary),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const batchDetail = batchSummary.extend({
  notes: z.string().nullable(),
  /** Per location and status, so "where is this lot" is answered outright. */
  balances: z.array(
    z.object({
      locationId: uuid,
      locationName: z.string(),
      status: stockStatus,
      quantity: decimalString,
    })
  ),
});

/**
 * Hold a lot, or let it go again.
 *
 * ⚠️ ITS OWN ENDPOINT RATHER THAN A FIELD ON THE PATCH, because it is not a
 *   column edit. Quarantining a lot MOVES its quantity between status buckets in
 *   the same transaction as the flag, and the two must commit together: a batch
 *   marked QUARANTINED whose quantity still sits in AVAILABLE is dispensable,
 *   because allocation reads the balance and not the batch.
 *
 * `reason` is required and is not free-form decoration — "why is this stock
 * held?" is the entire question a quarantine exists to answer, and the
 * `batches_quarantine_reasoned` CHECK refuses the row without one.
 */
export const batchHoldRequest = z
  .object({
    action: z.enum(['QUARANTINE', 'QUARANTINE_RELEASE', 'RECALL']),
    reason: z.string().trim().min(3).max(2000),
    /** The regulator's or manufacturer's notice number, on a recall. */
    recallReference: z.string().trim().max(128).nullish(),
  })
  .refine(
    (v) => v.action === 'RECALL' || v.recallReference == null,
    'a recall reference belongs to a recall'
  );

// ---------------------------------------------------------------------------
// Serials
// ---------------------------------------------------------------------------

export const createSerialRequest = z.object({
  branchId: uuid,
  productId: uuid,
  batchId: uuid.nullish(),
  serialNumber: z.string().trim().min(1).max(128),
  currentLocationId: uuid.nullish(),
  expiresOn: effectiveDate.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export const updateSerialRequest = z
  .object({
    batchId: uuid.nullable(),
    currentLocationId: uuid.nullable(),
    expiresOn: effectiveDate.nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

/**
 * Assigning a serial to a patient is its own request, and not part of the patch
 * above.
 *
 * ⚠️ IT IS A PHI WRITE, and folding it into a general update would mean every
 *   note correction ran through the same audit and access path as "this implant
 *   went into this named person". Separating it keeps the narrow thing narrow —
 *   the same reasoning that gives `clinical.vitals.record` its own code.
 */
export const assignSerialRequest = z.object({
  patientId: uuid,
  /** When it was actually fitted or issued. Defaults to now. */
  assignedAt: z.iso.datetime().optional(),
});

export const serialQuery = z.object({
  branchId: uuid.optional(),
  productId: uuid.optional(),
  batchId: uuid.optional(),
  status: serialStatus.optional(),
  q: z.string().trim().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const serialSummary = z.object({
  id: uuid,
  branchId: uuid,
  productId: uuid,
  productName: z.string(),
  serialNumber: z.string(),
  status: serialStatus,
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  currentLocationId: uuid.nullable(),
  currentLocationName: z.string().nullable(),
  expiresOn: z.string().nullable(),
  /**
   * ⚠️ PHI. An id and nothing else — never a name, here or in any log line that
   *   records this read (PI-ADR-016).
   */
  assignedPatientId: uuid.nullable(),
  assignedAt: z.string().nullable(),
});

export const serialListResponse = z.object({
  serials: z.array(serialSummary),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const serialDetail = serialSummary.extend({
  notes: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Movements — the write path into the ledger
// ---------------------------------------------------------------------------

/**
 * One movement.
 *
 * ⚠️ THERE IS NO SIGN FIELD AND NO BASE-QUANTITY FIELD, DELIBERATELY. The
 *   caller says WHAT happened and HOW MUCH of what they were holding; the server
 *   derives the direction from `movementType`, converts through the product's
 *   packaging or unit graph, and refuses a conversion that does not come out
 *   exactly. See `recordMovement`.
 *
 * `quantity` is in `unitId` if one is given, and in the product's base unit
 * otherwise. Giving a PACKAGING LEVEL instead of a unit is how "2 boxes" is
 * entered; the two are mutually exclusive because a quantity that named both
 * would have two different answers.
 */
export const recordMovementRequest = z
  .object({
    branchId: uuid,
    productId: uuid,
    batchId: uuid.nullish(),
    serialId: uuid.nullish(),
    movementType: manualMovementType,
    /**
     * Which way an ADJUSTMENT goes. Required for `ADJUSTMENT` and refused for
     * everything else, because every other type already says its own direction.
     *
     * ⚠️ AN EXPLICIT FIELD RATHER THAN A NEGATIVE `quantity`. Letting the sign
     *   ride on the number is exactly what the ledger's direction CHECK exists
     *   to prevent — a caller that can send `-5` here is one keystroke from
     *   sending it on a receipt. It is also not inferred from which status field
     *   was filled in, which would work and would make the one genuinely
     *   ambiguous movement the one nobody can read.
     */
    adjustmentDirection: z.enum(['INCREASE', 'DECREASE']).nullish(),
    quantity: positiveQuantity,
    /** The unit the quantity was counted in. Defaults to the product's base. */
    unitId: uuid.nullish(),
    /** A packaging level on the product — 1 is a strip, 2 a box. */
    packagingLevel: z.number().int().min(0).max(10).nullish(),
    locationId: uuid,
    /**
     * Which bucket to take from. Required for the types that remove or move
     * quantity, and refused for the ones that only add — the server derives
     * what it needs from `movementType` and validates the pair.
     */
    statusFrom: stockStatus.nullish(),
    /** Which bucket to put it in. Same rule, other direction. */
    statusTo: stockStatus.nullish(),
    reasonCode: reasonCode.nullish(),
    reasonNote: z.string().trim().max(2000).nullish(),
    /** Defaults to now. A receipt entered on Monday for Friday's delivery. */
    occurredAt: z.iso.datetime().optional(),
    referenceType: stockReferenceType.default('MANUAL'),
    referenceId: uuid.nullish(),
  })
  .refine(
    (v) => v.unitId === null || v.unitId === undefined || v.packagingLevel == null,
    'give either a unit or a packaging level, not both — a quantity that names both has two answers'
  )
  .refine(
    (v) => (v.movementType === 'ADJUSTMENT') === (v.adjustmentDirection != null),
    'adjustmentDirection is required for an adjustment and is not accepted for any other movement'
  )
  .refine(
    (v) => v.movementType !== 'ADJUSTMENT' || (v.reasonCode != null && v.reasonCode.length > 0),
    'an adjustment must carry a reason code — it is the only movement whose meaning is not stated by its name'
  );

/**
 * The result of a movement: the row that was written, and the buckets it moved.
 *
 * The balances come back so the caller never has to re-read to find out what it
 * just did — and so a UI cannot show a number that a concurrent writer has
 * already changed, which is what a follow-up GET would give it.
 */
export const recordMovementResponse = z.object({
  movementId: uuid,
  /**
   * ⚠️ `signedDecimalString`, NOT `decimalString`. This is negative on every
   *   issue — dispensing, disposal, transfer out, an adjustment downwards — and
   *   `decimalString` refuses a sign by design, because refusing one is the
   *   whole point on the way IN. It was the wrong schema here and would have
   *   become a 500 the first time anything parsed the response.
   */
  quantityBase: signedDecimalString,
  balances: z.array(
    z.object({
      locationId: uuid,
      status: stockStatus,
      quantity: decimalString,
    })
  ),
});

// ---------------------------------------------------------------------------
// Reading stock
// ---------------------------------------------------------------------------

export const stockBalanceQuery = z.object({
  branchId: uuid.optional(),
  locationId: uuid.optional(),
  productId: uuid.optional(),
  batchId: uuid.optional(),
  status: stockStatus.optional(),
  /** Hide the zero rows a fully-issued bucket leaves behind. */
  hideEmpty: z.stringbool().default(true),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const stockBalanceRow = z.object({
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  baseUnitSymbol: z.string(),
  branchId: uuid,
  locationId: uuid,
  locationName: z.string(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.string().nullable(),
  serialId: uuid.nullable(),
  serialNumber: z.string().nullable(),
  status: stockStatus,
  quantity: decimalString,
});

export const stockBalanceListResponse = z.object({
  balances: z.array(stockBalanceRow),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

/**
 * The ledger view.
 *
 * ⚠️ PAGINATED SERVER-SIDE, ALWAYS. This table only grows, and it grows fastest
 *   at the clinics with the most stock — the ones whose ledger screen matters.
 *   There is no "load all" mode and no client-side filter.
 */
export const stockLedgerQuery = z.object({
  branchId: uuid.optional(),
  productId: uuid.optional(),
  batchId: uuid.optional(),
  serialId: uuid.optional(),
  locationId: uuid.optional(),
  movementType: stockMovementType.optional(),
  referenceType: stockReferenceType.optional(),
  referenceId: uuid.optional(),
  from: effectiveDate.optional(),
  to: effectiveDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const stockLedgerRow = z.object({
  id: uuid,
  branchId: uuid,
  occurredAt: z.string(),
  recordedAt: z.string(),
  movementType: stockMovementType,
  productId: uuid,
  productCode: z.string(),
  productName: z.string(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  serialId: uuid.nullable(),
  serialNumber: z.string().nullable(),
  quantityBase: signedDecimalString,
  quantityEntered: signedDecimalString,
  unitSymbol: z.string(),
  baseUnitSymbol: z.string(),
  fromLocationId: uuid.nullable(),
  fromLocationName: z.string().nullable(),
  toLocationId: uuid.nullable(),
  toLocationName: z.string().nullable(),
  statusFrom: stockStatus.nullable(),
  statusTo: stockStatus.nullable(),
  reasonCode: z.string().nullable(),
  reasonNote: z.string().nullable(),
  referenceType: stockReferenceType,
  referenceId: uuid.nullable(),
  actorUserId: uuid,
  actorName: z.string().nullable(),
  trackingMode,
});

export const stockLedgerListResponse = z.object({
  movements: z.array(stockLedgerRow),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

/**
 * The replay verifier's answer.
 *
 * `verifyBalances()` replays the ledger and compares. It NEVER silently repairs
 * — a cache that heals itself hides the bug that broke it — so this reports and
 * stops.
 */
export const verifyBalancesResponse = z.object({
  checkedAt: z.string(),
  bucketsChecked: z.number().int(),
  /** Empty means the cache and the ledger agree. Anything here is a trigger bug. */
  discrepancies: z.array(
    z.object({
      productId: uuid,
      batchId: uuid.nullable(),
      serialId: uuid.nullable(),
      locationId: uuid,
      status: stockStatus,
      /**
       * What the cache says, or `null` when it holds no row for this bucket at
       * all. The two are different defects — a trigger that never fired against
       * one that fired with the wrong sign — so they are not collapsed.
       */
      cached: z.string().nullable(),
      /** What the ledger replays to. This one is right (PI-ADR-004 rule 4). */
      replayed: z.string(),
    })
  ),
});

/**
 * The expiry report. Two questions, one shape.
 *
 * Near-expiry produces an ALERT and never a status change; only the sweep, on
 * the day itself and in the branch's timezone, moves stock to EXPIRED. The
 * window is a SETTING and not a constant (PI-ADR-015) — a vaccine fridge and a
 * dental store legitimately differ — and it resolves through
 * USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default.
 */
export const expiryReportQuery = z.object({
  branchId: uuid.optional(),
  /** Overrides the resolved near-expiry setting for this one request. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  includeExpired: z.stringbool().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const expiryReportResponse = z.object({
  /** The window actually used, and where it came from. Shown in the UI. */
  windowDays: z.number().int(),
  rows: z.array(
    z.object({
      batchId: uuid,
      branchId: uuid,
      productId: uuid,
      productName: z.string(),
      lotNumber: z.string(),
      expiresOn: z.string(),
      /** Negative once it is past. Computed in the BRANCH's timezone. */
      daysRemaining: z.number().int(),
      quantityAvailable: decimalString,
      baseUnitSymbol: z.string(),
      status: batchStatus,
    })
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocationKind = z.infer<typeof locationKind>;
export type BatchStatus = z.infer<typeof batchStatus>;
export type StockStatus = z.infer<typeof stockStatus>;
export type SerialStatus = z.infer<typeof serialStatus>;
export type StockMovementType = z.infer<typeof stockMovementType>;
export type StockReferenceType = z.infer<typeof stockReferenceType>;
export type ManualMovementType = z.infer<typeof manualMovementType>;

export type CreateInventoryLocationRequest = z.infer<typeof createInventoryLocationRequest>;
export type UpdateInventoryLocationRequest = z.infer<typeof updateInventoryLocationRequest>;
export type InventoryLocationQuery = z.infer<typeof inventoryLocationQuery>;
export type InventoryLocationSummary = z.infer<typeof inventoryLocationSummary>;
export type InventoryLocationDetail = z.infer<typeof inventoryLocationDetail>;
export type InventoryLocationListResponse = z.infer<typeof inventoryLocationListResponse>;
export type StorageAreaDetail = z.infer<typeof storageAreaDetail>;
export type StorageBinDetail = z.infer<typeof storageBinDetail>;
export type ReplaceStorageAreasRequest = z.infer<typeof replaceStorageAreasRequest>;

export type CreateBatchRequest = z.infer<typeof createBatchRequest>;
export type UpdateBatchRequest = z.infer<typeof updateBatchRequest>;
export type BatchQuery = z.infer<typeof batchQuery>;
export type BatchSummary = z.infer<typeof batchSummary>;
export type BatchDetail = z.infer<typeof batchDetail>;
export type BatchListResponse = z.infer<typeof batchListResponse>;
export type BatchHoldRequest = z.infer<typeof batchHoldRequest>;

export type CreateSerialRequest = z.infer<typeof createSerialRequest>;
export type UpdateSerialRequest = z.infer<typeof updateSerialRequest>;
export type AssignSerialRequest = z.infer<typeof assignSerialRequest>;
export type SerialQuery = z.infer<typeof serialQuery>;
export type SerialSummary = z.infer<typeof serialSummary>;
export type SerialDetail = z.infer<typeof serialDetail>;
export type SerialListResponse = z.infer<typeof serialListResponse>;

export type RecordMovementRequest = z.infer<typeof recordMovementRequest>;
export type RecordMovementResponse = z.infer<typeof recordMovementResponse>;

export type StockBalanceQuery = z.infer<typeof stockBalanceQuery>;
export type StockBalanceRow = z.infer<typeof stockBalanceRow>;
export type StockBalanceListResponse = z.infer<typeof stockBalanceListResponse>;

export type StockLedgerQuery = z.infer<typeof stockLedgerQuery>;
export type StockLedgerRow = z.infer<typeof stockLedgerRow>;
export type StockLedgerListResponse = z.infer<typeof stockLedgerListResponse>;

export type VerifyBalancesResponse = z.infer<typeof verifyBalancesResponse>;
export type ExpiryReportQuery = z.infer<typeof expiryReportQuery>;
export type ExpiryReportResponse = z.infer<typeof expiryReportResponse>;
