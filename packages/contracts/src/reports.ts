/**
 * Reporting & cost accounting (PI-22).
 *
 * Nine reads over tables nine other phases wrote, and NOT ONE NEW TABLE. Every
 * figure below is arithmetic over `stock_balances`, `stock_ledger`, `batches`,
 * `product_cost_averages`, `consumption_lines`, `charge_requests`,
 * `dispense_lines` and the procurement documents. A report that stored its own
 * answer would be a second source of truth for a number the ledger already
 * holds, free to disagree with it the moment anything is corrected — which is
 * PI-ADR-004's rule applied to reading rather than to writing.
 *
 * ── THE FOUR THINGS THESE NUMBERS ARE NOT ───────────────────────────────────
 *
 * ⚠️ 1. STOCK IN TRANSIT IS NOT IN `stock_balances` AT ALL, AND THE VALUATION
 *      READS IT OFF THE TRANSFER DOCUMENT. The `IN_TRANSIT` status exists in the
 *      enum and NOTHING EVER WRITES A BALANCE ROW WITH IT: PI-3 decided the
 *      transfer document holds the quantity, because a sender-owned bucket would
 *      force the receiver to write a removal against a branch RLS hides from
 *      them. So `includeInTransit` adds `sent − received` over the lines of
 *      `DISPATCHED` and `PARTIALLY_RECEIVED` transfers, held at the SENDING
 *      branch — which is what makes an organization-wide valuation count it
 *      exactly once, the receiving branch having no row for it.
 *
 *      ⚠️ THIS REPORT WAS FIRST WRITTEN THE OTHER WAY, FILTERING ON THE STATUS,
 *        AND IT IS WORTH RECORDING WHY THAT SURVIVED WRITING. The flag was
 *        honoured, the query returned rows, and the total looked entirely
 *        plausible — stock on a van was simply worth nothing.
 *        INVENTORY_ARCHITECTURE.md predicted exactly this ("⚠️ THE COST, FOR
 *        PI-22"), and the prediction was read only after the code was written.
 *
 * ⚠️ 2. A COST IS NOT A PRICE. Everything in these reports is what the clinic
 *      PAID — `batches.unit_cost_base` for the lot in hand, or the moving
 *      average in `product_cost_averages`. What a patient is CHARGED is
 *      `product_prices` and the invoice, and the two are joined in exactly one
 *      report (`procedure-contribution`) which says so in its own field names.
 *
 * ⚠️ 3. EVERY TOTAL IS PER CURRENCY AND NEVER SUMMED ACROSS ONE. PI-4 made
 *      multi-currency procurement explicit rather than fixing it —
 *      `product_cost_averages` is keyed BY currency, so one product at one
 *      branch can honestly carry two averages. A report that added them would
 *      produce a number in no currency at all. `totals` is therefore an ARRAY.
 *
 * ⚠️ 4. `procedure-contribution` DOES NOT CONTAIN THE PROCEDURE'S FEE, AND
 *      CANNOT. There is no per-procedure price anywhere in this schema:
 *      `fee_schedule_entries` prices a fee TYPE (`PROCEDURE` is one string for
 *      every procedure a clinic performs), `invoices` carries no reference on a
 *      `PROCEDURE` source by deliberate design, and `charge_requests` is CHECKed
 *      to `PHARMACY` and `INVENTORY`. So the revenue side of this report is what
 *      was billed FOR THE MATERIALS — every field says `consumable`, and the
 *      response carries `procedureFeeIncluded: false` as a fact rather than as a
 *      footnote. Widening it needs a per-procedure rate card, which is a
 *      charging-model change and not a reporting one.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ NOTHING ON THIS SURFACE NAMES A PATIENT, AND NO REPORT HERE WRITES A
 *   `data_access_logs` ROW. Every row is a product, a lot, a supplier or a
 *   procedure TYPE with a count beside it. `consumption-cost` and
 *   `procedure-contribution` read `clinical_consumptions`, which is the most
 *   patient-bound table in the programme, and they group it away: the grain is
 *   the procedure item, never the person it was performed on. A report that
 *   returned a patient id would be `recall.trace.patients` territory — a
 *   different permission, a different audit story, and not this file.
 */
import { z } from 'zod';
import { uuid, calendarDate } from './common.js';
import { decimalString } from './products.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Which report. The stable key a screen, a bookmark and a CSV filename all use.
 *
 * ⚠️ KEBAB-CASE AND NOT THE PATH, because the path is where the report lives and
 *   this is what it IS. `/reports/inventory/valuation` moving under a different
 *   prefix must not invalidate a saved link or rename a downloaded file.
 */
export const reportKey = z.enum([
  'inventory-valuation',
  'inventory-aging',
  'inventory-movement',
  'dead-stock',
  'quarantine-exposure',
  'supplier-performance',
  'dispensing',
  'consumption-cost',
  'procedure-contribution',
]);
export type ReportKey = z.infer<typeof reportKey>;

/**
 * How the answer comes back.
 *
 * ⚠️ `csv` NEEDS `report.export` ON TOP OF THE REPORT'S OWN READ CODE, and the
 *   route enforces exactly that — two `authorize()` calls, which is an AND.
 *   Reading a figure on a screen and walking out of the building with the whole
 *   table are different acts: the second leaves the clinic's control entirely,
 *   and a clinic that lets a locum read valuations may still not let them
 *   export one.
 *
 * ⚠️ AND CSV IGNORES PAGINATION UP TO A HARD CAP. An export that returned page
 *   one would be a file that looks complete and is not — the worst failure a
 *   spreadsheet can have. `truncated` on the JSON shape and a final comment row
 *   in the CSV say when the cap was reached.
 */
export const reportFormat = z.enum(['json', 'csv']);
export type ReportFormat = z.infer<typeof reportFormat>;

/**
 * Which cost answers "what is this worth".
 *
 * ⚠️ `BATCH` IS THE DEFAULT AND IS THE MORE HONEST OF THE TWO. It values the lot
 *   in hand at what THAT lot cost, which is what a stock-take reconciles
 *   against. `MOVING_AVERAGE` values it at the branch's rolling average for the
 *   product, which is what a set of accounts is usually kept on.
 *
 * ⚠️ NEITHER IS EVER GUESSED. A lot with no `unit_cost_base` under `BATCH` falls
 *   back to the moving average, and a product with no average either is
 *   reported as UNVALUED with its quantity intact — never as zero. Zero is a
 *   number somebody will add up; `unvaluedQuantityBase` is a number somebody
 *   will go and fix.
 */
export const costBasis = z.enum(['BATCH', 'MOVING_AVERAGE']);
export type CostBasis = z.infer<typeof costBasis>;

// ---------------------------------------------------------------------------
// Shared query and response shapes
// ---------------------------------------------------------------------------

/**
 * The page an aggregate report answers on.
 *
 * ⚠️ ITS OWN SHAPE RATHER THAN `paginationQuery`, and the difference is
 *   `sortBy`. A report's sort keys are a closed set per report (a valuation
 *   sorts by value, an aging report by age) and a free-text `sortBy` on a query
 *   assembled with `Prisma.sql` is an invitation to interpolate a column name.
 *   Each report declares its own `sortBy` enum below.
 */
const reportPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** Every report is asked of a place, or of every place the caller can see. */
const reportScope = reportPage.extend({
  /**
   * ⚠️ OPTIONAL, AND OMITTING IT MEANS EVERY BRANCH IN SCOPE — which is the
   *   opposite of `resolveBranchId`'s rule for a WRITE. A movement happens at
   *   exactly one place and picking one arbitrarily is wrong about half the
   *   time; a report over three sites is the ordinary question an owner asks.
   *   Naming a branch outside scope is NOT FOUND, as everywhere else.
   */
  branchId: uuid.optional(),
  format: reportFormat.default('json'),
});

/**
 * A report over a window of time.
 *
 * ⚠️ TWO CALENDAR DATES, RESOLVED IN THE BRANCH'S ZONE, INCLUSIVE OF BOTH ENDS.
 *   Never two instants: "March" is a calendar question a clinic asks in its own
 *   timezone, and a UTC window at a clinic five and a half hours off UTC puts
 *   the first five and a half hours of every month in the previous one
 *   (invariant 6, and the bug PI-8 closed on the pharmacy dashboard).
 *
 * ⚠️ AND `to` IS RESOLVED TO THE END OF ITS DAY, not to its midnight. A window
 *   of `2026-03-01`..`2026-03-31` that stopped at the 31st's midnight would
 *   silently drop a day's dispensing every month.
 */
const datedReportScope = reportScope.extend({
  from: calendarDate,
  to: calendarDate,
});

/**
 * A money total, in one currency, in integer minor units.
 *
 * ⚠️ AN ARRAY OF THESE AND NEVER A SCALAR, for the reason the file header gives.
 *   `unvaluedQuantityBase` travels WITH the currency total rather than beside it
 *   so a reader can see that "₹4,80,000 over 12,000 units, plus 300 units nobody
 *   has costed" is one sentence about one branch.
 */
export const reportCurrencyTotal = z.object({
  currency: z.string().length(3),
  valueMinor: z.int(),
  quantityBase: decimalString,
  /** Held, counted, and deliberately NOT valued at zero. See `costBasis`. */
  unvaluedQuantityBase: decimalString,
  lineCount: z.int(),
});
export type ReportCurrencyTotal = z.infer<typeof reportCurrencyTotal>;

/**
 * What every report answers with, around its own rows.
 *
 * ⚠️ `generatedAt` AND `window` ARE PART OF THE ANSWER, NOT METADATA. A
 *   valuation printed and filed is a statement about a moment; one with no
 *   moment on it is a page of numbers somebody will compare against a different
 *   moment's page of numbers next year.
 */
const reportEnvelope = z.object({
  reportKey,
  generatedAt: z.iso.datetime(),
  /** Named branch, or every branch the caller can see. */
  branchIds: z.array(uuid),
  /** Present on a dated report, absent on a point-in-time one. */
  window: z.object({ from: calendarDate, to: calendarDate }).nullable(),
  page: z.int(),
  limit: z.int(),
  total: z.int(),
  /** True when a CSV export hit the row cap. Always false on a JSON page. */
  truncated: z.boolean(),
});

/** The identity every product-grained row repeats. */
const productRef = z.object({
  productId: uuid,
  productName: z.string(),
  productCode: z.string().nullable(),
  baseUnitSymbol: z.string(),
});

const branchRef = z.object({
  branchId: uuid,
  branchName: z.string(),
});

// ---------------------------------------------------------------------------
// 1 — Stock valuation
// ---------------------------------------------------------------------------

export const valuationQuery = reportScope.extend({
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  basis: costBasis.default('BATCH'),
  /**
   * ⚠️ DEFAULTS TO TRUE, AND THE FLAG EXISTS BECAUSE THE ANSWER IS GENUINELY
   *   AMBIGUOUS. Stock on a van between two of the clinic's own sites is the
   *   clinic's asset and belongs in a balance sheet; it is also not on any shelf
   *   anybody can count, so a stock-take reconciliation wants it out. Both
   *   readers are right and neither may be assumed.
   */
  includeInTransit: z.stringbool().default(true),
  /** Buckets that are held but not sellable. Off by default — see the shape. */
  includeNonSellable: z.stringbool().default(true),
  sortBy: z.enum(['value', 'quantity', 'product']).default('value'),
});
export type ValuationQuery = z.infer<typeof valuationQuery>;

/**
 * One lot at one branch, valued.
 *
 * ⚠️ THE GRAIN IS THE LOT AND NOT THE PRODUCT, because the cost is. Two
 *   deliveries of the same medicine three months apart are two lots at two
 *   prices, and a product-grained valuation would have to pick one of them —
 *   which is precisely what `MOVING_AVERAGE` is for, and it is a basis a reader
 *   chooses rather than a rounding a report performs silently.
 */
export const valuationRow = productRef.extend(branchRef.shape).extend({
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: calendarDate.nullable(),
  /** Σ over every status this query included. */
  quantityBase: decimalString,
  /** The `AVAILABLE` share of it. Everything else is held for some reason. */
  quantityAvailableBase: decimalString,
  /** Per ONE base unit, in minor units. Null when nothing has costed this lot. */
  unitCostMinor: z.int().nullable(),
  /** Which basis actually produced `unitCostMinor` on THIS row. */
  appliedBasis: costBasis.nullable(),
  currency: z.string().length(3).nullable(),
  /** round(quantityBase × unitCostMinor). Null exactly when the cost is. */
  valueMinor: z.int().nullable(),
});
export type ValuationRow = z.infer<typeof valuationRow>;

export const valuationReport = reportEnvelope.extend({
  basis: costBasis,
  includeInTransit: z.boolean(),
  includeNonSellable: z.boolean(),
  rows: z.array(valuationRow),
  totals: z.array(reportCurrencyTotal),
});
export type ValuationReport = z.infer<typeof valuationReport>;

// ---------------------------------------------------------------------------
// 2 — Stock aging
// ---------------------------------------------------------------------------

/**
 * How old the stock on the shelf is, and how close it is to being worthless.
 *
 * ⚠️ TWO CLOCKS, AND THEY ARE NOT THE SAME QUESTION. `receivedAt` age is how
 *   long the clinic's money has been sitting on a shelf; `expiresOn` is how long
 *   before it has to be written off. A fast-moving product received a year ago
 *   and expiring next month is a different problem from a slow one received last
 *   week and expiring in 2031, and one bucket set cannot say both.
 */
export const agingQuery = reportScope.extend({
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  basis: costBasis.default('BATCH'),
  /** `receipt` buckets by how long it has been here; `expiry` by how long it has left. */
  clock: z.enum(['receipt', 'expiry']).default('expiry'),
  sortBy: z.enum(['value', 'quantity', 'bucket']).default('bucket'),
});
export type AgingQuery = z.infer<typeof agingQuery>;

/**
 * The buckets, as strings, because they are LABELS and not arithmetic.
 *
 * ⚠️ `EXPIRED` IS A BUCKET AND NOT AN OMISSION. Expired stock is on the shelf,
 *   undispensable, waiting to be destroyed, and needing to be counted and valued
 *   until it is — which is exactly why PI-2 made `EXPIRY` a MOVE rather than a
 *   removal. A report that dropped it would tell a clinic it has nothing to
 *   dispose of.
 */
export const agingBucket = z.enum([
  'EXPIRED',
  'D0_30',
  'D31_60',
  'D61_90',
  'D91_180',
  'D181_365',
  'OVER_365',
  'NO_DATE',
]);
export type AgingBucket = z.infer<typeof agingBucket>;

export const agingRow = productRef.extend(branchRef.shape).extend({
  bucket: agingBucket,
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: calendarDate.nullable(),
  receivedAt: z.iso.datetime().nullable(),
  /** Negative when the bucket is `EXPIRED`. Null when there is no date to count to. */
  daysToExpiry: z.int().nullable(),
  daysHeld: z.int().nullable(),
  quantityBase: decimalString,
  unitCostMinor: z.int().nullable(),
  currency: z.string().length(3).nullable(),
  valueMinor: z.int().nullable(),
});
export type AgingRow = z.infer<typeof agingRow>;

/** Per-bucket subtotals, so the screen can draw the shape without the rows. */
/**
 * One bucket's subtotal, per currency.
 *
 * ⚠️ `valueMinor` IS NULLABLE AND `unvaluedQuantityBase` IS NOT DECORATION —
 *   BOTH FOR THE REASON `reportCurrencyTotal` GIVES. Stock nobody has costed is
 *   stock the clinic HOLDS and cannot value, and a bucket used to report it as
 *   worth zero: the aggregate ran `SUM(COALESCE(value_minor, 0))`, which is
 *   never NULL for a non-empty group, so the unvalued mechanism could not fire
 *   and `buckets[]` dropped the uncosted quantity entirely by filtering out the
 *   currency-less row. The valuation report, over the same shelf on the same
 *   day, answered `null` plus a quantity — two reports, two answers. (PI-24.)
 */
export const agingBucketTotal = z.object({
  bucket: agingBucket,
  /** Null when nothing in this bucket could be costed at all. */
  currency: z.string().length(3).nullable(),
  quantityBase: decimalString,
  /** Null means "not valued", and must never be rendered as zero. */
  valueMinor: z.int().nullable(),
  /** How much of `quantityBase` carries no cost. */
  unvaluedQuantityBase: decimalString,
  lineCount: z.int(),
});

export const agingReport = reportEnvelope.extend({
  basis: costBasis,
  clock: z.enum(['receipt', 'expiry']),
  rows: z.array(agingRow),
  buckets: z.array(agingBucketTotal),
  totals: z.array(reportCurrencyTotal),
});
export type AgingReport = z.infer<typeof agingReport>;

// ---------------------------------------------------------------------------
// 3 — Stock movement
// ---------------------------------------------------------------------------

/**
 * What moved, in and out, over a window — with the opening and closing figures
 * that make it add up.
 *
 * ⚠️ OPENING AND CLOSING ARE REPLAYED FROM `stock_ledger`, NOT READ FROM
 *   `stock_balances`. The balance table is a CACHE of the present moment and has
 *   no memory: asking it what the shelf held on 1 March is asking a question it
 *   cannot answer. Σ of every signed `quantity_base` before the window IS the
 *   opening balance, and `verifyBalances()` proves that replay agrees with the
 *   cache at the one point both are defined.
 *
 * ⚠️ AND `opening + in − out ≡ closing` IS A TEST, NOT A HOPE. The suite asserts
 *   it per row, because the day it stops holding is the day one of PI-2's
 *   movement types acquired a sign nobody told the report about.
 */
export const movementQuery = datedReportScope.extend({
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  sortBy: z.enum(['net', 'out', 'in', 'product']).default('out'),
});
export type MovementQuery = z.infer<typeof movementQuery>;

export const movementRow = productRef.extend(branchRef.shape).extend({
  openingBase: decimalString,
  /** Σ of the positive legs: receipts, transfers in, returns, positive adjustments. */
  receivedBase: decimalString,
  /** Σ |negative legs|: dispensing, consumption, transfers out, disposals, returns to supplier. */
  issuedBase: decimalString,
  /** Broken out of `issued`, because "we sold it" and "we threw it away" are different sentences. */
  dispensedBase: decimalString,
  consumedBase: decimalString,
  transferredOutBase: decimalString,
  disposedBase: decimalString,
  /** Signed. The one figure that is allowed to be negative on this surface. */
  adjustedBase: decimalString,
  closingBase: decimalString,
  movementCount: z.int(),
});
export type MovementRow = z.infer<typeof movementRow>;

export const movementReport = reportEnvelope.extend({
  rows: z.array(movementRow),
});
export type MovementReport = z.infer<typeof movementReport>;

// ---------------------------------------------------------------------------
// 4 — Dead stock
// ---------------------------------------------------------------------------

/**
 * Money on a shelf that nothing has asked for.
 *
 * ⚠️ "NO OUTBOUND MOVEMENT", NOT "NO MOVEMENT". A lot that was quarantined and
 *   released last week has moved twice and gone nowhere; counting that as
 *   activity would hide the slowest stock in the building behind the
 *   housekeeping performed on it.
 */
export const deadStockQuery = reportScope.extend({
  categoryId: uuid.optional(),
  basis: costBasis.default('BATCH'),
  /** How long with nothing going out before stock counts as dead. */
  idleDays: z.coerce.number().int().min(1).max(3650).default(180),
  /** Ignore rows worth less than this. A ₹4 dressing is not a management problem. */
  minValueMinor: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(['value', 'idleDays', 'quantity']).default('value'),
});
export type DeadStockQuery = z.infer<typeof deadStockQuery>;

export const deadStockRow = productRef.extend(branchRef.shape).extend({
  quantityBase: decimalString,
  /** Null when nothing has EVER gone out — which is the worst case, not a missing one. */
  lastIssuedAt: z.iso.datetime().nullable(),
  lastReceivedAt: z.iso.datetime().nullable(),
  /** Days since `lastIssuedAt`, or since the first receipt when nothing ever went out. */
  idleDays: z.int(),
  /** Days of cover at the last 365 days' rate. Null when that rate is zero. */
  daysOfCover: z.int().nullable(),
  unitCostMinor: z.int().nullable(),
  currency: z.string().length(3).nullable(),
  valueMinor: z.int().nullable(),
  /** The soonest expiry among the lots holding this quantity. */
  earliestExpiresOn: calendarDate.nullable(),
});
export type DeadStockRow = z.infer<typeof deadStockRow>;

export const deadStockReport = reportEnvelope.extend({
  basis: costBasis,
  idleDays: z.int(),
  rows: z.array(deadStockRow),
  totals: z.array(reportCurrencyTotal),
});
export type DeadStockReport = z.infer<typeof deadStockReport>;

// ---------------------------------------------------------------------------
// 5 — Quarantine & recall exposure
// ---------------------------------------------------------------------------

/**
 * What is being held, why, and what it is worth.
 *
 * ⚠️ ONE REPORT FOR BOTH, AND THE `hold` COLUMN IS WHAT SEPARATES THEM. A
 *   storekeeper's question is "what may I not sell, and how much of the clinic's
 *   money is it" — quarantine, recall, damage and expiry are four answers to one
 *   question. The regulator's question is narrower and is `GET /v1/recalls/:id`,
 *   which is a different screen with a different permission.
 */
export const holdKind = z.enum(['QUARANTINED', 'RECALLED', 'BLOCKED', 'DAMAGED', 'EXPIRED']);
export type HoldKind = z.infer<typeof holdKind>;

export const quarantineQuery = reportScope.extend({
  hold: holdKind.optional(),
  productId: uuid.optional(),
  basis: costBasis.default('BATCH'),
  sortBy: z.enum(['value', 'quantity', 'heldSince']).default('value'),
});
export type QuarantineQuery = z.infer<typeof quarantineQuery>;

export const quarantineRow = productRef.extend(branchRef.shape).extend({
  hold: holdKind,
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: calendarDate.nullable(),
  quantityBase: decimalString,
  /**
   * When the hold started, from the lot's own column where one exists.
   *
   * ⚠️ NULL IS ORDINARY AND IS NOT AN ERROR. A quantity sitting in the
   *   `DAMAGED` bucket was put there by a movement, and a movement does not
   *   stamp the lot — only `quarantined_at` and `recalled_at` exist as columns.
   *   The rest is answerable from `stock_ledger` and is deliberately not joined
   *   here: a per-row ledger walk on a report that lists every held lot in the
   *   clinic is the query that takes the screen down.
   */
  heldSince: z.iso.datetime().nullable(),
  /** `quarantine_reason` or the recall's reference, as the lot recorded it. */
  reason: z.string().nullable(),
  unitCostMinor: z.int().nullable(),
  currency: z.string().length(3).nullable(),
  valueMinor: z.int().nullable(),
});
export type QuarantineRow = z.infer<typeof quarantineRow>;

export const quarantineReport = reportEnvelope.extend({
  basis: costBasis,
  rows: z.array(quarantineRow),
  totals: z.array(reportCurrencyTotal),
});
export type QuarantineReport = z.infer<typeof quarantineReport>;

// ---------------------------------------------------------------------------
// 6 — Supplier performance
// ---------------------------------------------------------------------------

/**
 * Whether a supplier delivers what was ordered, when it was promised.
 *
 * ⚠️ ON-TIME IS MEASURED AGAINST `expected_delivery_date` AND IS NULL WHERE
 *   THERE ISN'T ONE — never "on time by default". A purchase order with no
 *   promised date is a supplier nobody held to a date, and scoring it as a
 *   success would reward exactly the behaviour this report exists to expose.
 *   `ordersWithoutPromisedDate` is on the row for that reason.
 *
 * ⚠️ AND FILL RATE IS ORDERED-VS-RECEIVED ON THE LINE, NOT ON THE ORDER. An
 *   order 90% filled across ten lines is a different supplier from one that
 *   delivered nine lines and forgot the tenth, and an order-grained percentage
 *   cannot tell them apart.
 */
export const supplierPerformanceQuery = datedReportScope.extend({
  supplierId: uuid.optional(),
  sortBy: z.enum(['spend', 'onTime', 'fillRate', 'returnRate']).default('spend'),
});
export type SupplierPerformanceQuery = z.infer<typeof supplierPerformanceQuery>;

export const supplierPerformanceRow = z.object({
  supplierId: uuid,
  supplierName: z.string(),
  supplierCode: z.string().nullable(),
  /** Orders whose `orderedAt` falls in the window. */
  ordersPlaced: z.int(),
  ordersReceived: z.int(),
  ordersWithoutPromisedDate: z.int(),
  /** Of the orders that HAD a promised date and were received. */
  ordersOnTime: z.int(),
  ordersLate: z.int(),
  /** Mean days late over the late ones, to one decimal. Null when none were late. */
  averageDaysLate: decimalString.nullable(),
  /** Σ received ÷ Σ ordered, over lines, in base units. 0–1, to four decimals. */
  fillRate: decimalString.nullable(),
  /** Σ returned ÷ Σ received, over lines, in base units. */
  returnRate: decimalString.nullable(),
  /** Rejected at inspection, out of every receipt line in the window. */
  qualityRejectRate: decimalString.nullable(),
  currency: z.string().length(3),
  spendMinor: z.int(),
});
export type SupplierPerformanceRow = z.infer<typeof supplierPerformanceRow>;

export const supplierPerformanceReport = reportEnvelope.extend({
  rows: z.array(supplierPerformanceRow),
  totals: z.array(reportCurrencyTotal),
});
export type SupplierPerformanceReport = z.infer<typeof supplierPerformanceReport>;

// ---------------------------------------------------------------------------
// 7 — Dispensing
// ---------------------------------------------------------------------------

/**
 * What went across the counter, by product.
 *
 * ⚠️ COUNTS AND QUANTITIES, AND NOT ONE NAME — the same decision the pharmacy
 *   dashboard took and for the same reason. "1,204 supplies of amoxicillin" is a
 *   management figure; "these 1,204 people" is a `recall.trace.patients` answer
 *   that this permission does not buy.
 *
 * ⚠️ RETURNS ARE SUBTRACTED AND ALSO REPORTED, because they are two different
 *   facts. `netQuantityBase` is what actually left the building;
 *   `returnedQuantityBase` is how much came back, which is a quality signal in
 *   its own right and vanishes the moment it is only ever netted off.
 */
export const dispensingQuery = datedReportScope.extend({
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  /** Against a prescription, over the counter, or in a parcel — `DispenseKind`. */
  kind: z.enum(['PRESCRIPTION', 'COUNTER_SALE', 'ONLINE']).optional(),
  sortBy: z.enum(['quantity', 'supplies', 'product', 'value']).default('quantity'),
});
export type DispensingQuery = z.infer<typeof dispensingQuery>;

export const dispensingRow = productRef.extend(branchRef.shape).extend({
  /** Distinct `dispenses` rows this product appeared on. */
  supplyCount: z.int(),
  quantityBase: decimalString,
  returnedQuantityBase: decimalString,
  netQuantityBase: decimalString,
  /** Supplies where a pharmacist reached past the FEFO plan. A quality signal. */
  overrideCount: z.int(),
  /**
   * What the clinic BILLED for it, from `charge_requests` that reached an
   * invoice. Null where nothing did — a ward issue is ordinarily not billed, and
   * zero would say the clinic charged nothing rather than that it never tried.
   */
  billedMinor: z.int().nullable(),
  currency: z.string().length(3).nullable(),
});
export type DispensingRow = z.infer<typeof dispensingRow>;

export const dispensingReport = reportEnvelope.extend({
  rows: z.array(dispensingRow),
  totals: z.array(reportCurrencyTotal),
});
export type DispensingReport = z.infer<typeof dispensingReport>;

// ---------------------------------------------------------------------------
// 8 — Consumption cost
// ---------------------------------------------------------------------------

/**
 * What procedures actually used, valued.
 *
 * ⚠️ THE VARIANCE COLUMN IS THE POINT OF THIS REPORT AND PI-9 SAID SO. A
 *   template that expects two pairs of gloves for a procedure that uses three is
 *   not a block at the point of care — a clinician does not stop to argue with a
 *   form — it is a REPORT, and this is it. `expected` is the snapshot the
 *   template supplied at the moment of recording, never a re-read of today's
 *   template: re-reading it would restate last month's variances every time
 *   somebody tidied a template.
 *
 * ⚠️ AND A REVERSAL IS SUBTRACTED, NOT DROPPED. `ClinicalConsumptionKind` has
 *   three members: `CONSUMPTION`, `ADDITIONAL_CONSUMPTION` — more material was
 *   needed part-way through — and `CONSUMPTION_REVERSAL`, which is a row of its
 *   own with its own lines rather than an edit of the first. A report filtered
 *   to `CONSUMPTION` alone would miss the top-up AND count material that was
 *   put back, in opposite directions, on the same procedure.
 */
export const consumptionCostQuery = datedReportScope.extend({
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  /** Group by the product used, or by the procedure that used it. */
  groupBy: z.enum(['product', 'procedure']).default('product'),
  basis: costBasis.default('MOVING_AVERAGE'),
  sortBy: z.enum(['cost', 'quantity', 'variance']).default('cost'),
});
export type ConsumptionCostQuery = z.infer<typeof consumptionCostQuery>;

export const consumptionCostRow = branchRef.extend({
  /** Set when `groupBy` is `product`. */
  productId: uuid.nullable(),
  productName: z.string().nullable(),
  productCode: z.string().nullable(),
  baseUnitSymbol: z.string().nullable(),
  /** Set when `groupBy` is `procedure` — the `clinical_master_items` row. */
  procedureItemId: uuid.nullable(),
  procedureName: z.string().nullable(),

  /** Distinct `clinical_consumptions` rows. Never a patient count. */
  eventCount: z.int(),
  expectedQuantityBase: decimalString,
  actualQuantityBase: decimalString,
  /** actual − expected. Signed, and the only signed quantity on this shape. */
  varianceQuantityBase: decimalString,
  /** Lines a clinician recorded as a departure from the template. */
  overrideCount: z.int(),

  unitCostMinor: z.int().nullable(),
  currency: z.string().length(3).nullable(),
  costMinor: z.int().nullable(),
  /** round(varianceQuantityBase × unitCostMinor). Signed. What the variance COST. */
  varianceCostMinor: z.int().nullable(),
});
export type ConsumptionCostRow = z.infer<typeof consumptionCostRow>;

export const consumptionCostReport = reportEnvelope.extend({
  basis: costBasis,
  groupBy: z.enum(['product', 'procedure']),
  rows: z.array(consumptionCostRow),
  totals: z.array(reportCurrencyTotal),
});
export type ConsumptionCostReport = z.infer<typeof consumptionCostReport>;

// ---------------------------------------------------------------------------
// 9 — Procedure contribution
// ---------------------------------------------------------------------------

/**
 * What a procedure billed for its materials, less what those materials cost.
 *
 * ⚠️ READ POINT 4 OF THIS FILE'S HEADER BEFORE READING A NUMBER OFF THIS REPORT.
 *   The procedure's own FEE is not in it and cannot be: nothing in this schema
 *   prices one procedure differently from another. Every field says
 *   `consumable`, and `procedureFeeIncluded` is on the response as a hard false
 *   rather than as prose somebody will skip.
 *
 * ⚠️ SO `contributionMinor` IS NOT PROFIT. It is the margin on materials, which
 *   is the number that tells a clinic whether its consumable pricing covers its
 *   consumable costs — a real and useful question, and a narrower one than the
 *   name "contribution" usually carries in a set of accounts.
 */
export const procedureContributionQuery = datedReportScope.extend({
  procedureItemId: uuid.optional(),
  basis: costBasis.default('MOVING_AVERAGE'),
  sortBy: z.enum(['contribution', 'revenue', 'cost', 'volume', 'margin']).default('contribution'),
});
export type ProcedureContributionQuery = z.infer<typeof procedureContributionQuery>;

export const procedureContributionRow = branchRef.extend({
  /** Null on consumption filed against the visit rather than a named procedure. */
  procedureItemId: uuid.nullable(),
  procedureName: z.string(),
  /** Distinct `encounter_procedures` rows that consumed anything. */
  performedCount: z.int(),
  currency: z.string().length(3),
  /** Σ INVOICED charge requests raised from this procedure's consumption lines. */
  consumableRevenueMinor: z.int(),
  /** Σ valued consumption, at `basis`. */
  consumableCostMinor: z.int(),
  /** revenue − cost. Signed, and routinely negative where consumables are not billed. */
  contributionMinor: z.int(),
  /** contribution ÷ revenue, to four decimals. Null when revenue is zero. */
  marginRatio: decimalString.nullable(),
  /** contribution ÷ performedCount, rounded to the minor unit. */
  contributionPerProcedureMinor: z.int(),
  /**
   * Consumption whose charge request was SUPPRESSED or never raised, valued.
   *
   * ⚠️ THE FIELD THAT MAKES A NEGATIVE CONTRIBUTION READABLE. A clinic whose
   *   policy is not to bill consumables sees its whole cost here and knows the
   *   number is a policy rather than a leak.
   */
  unbilledCostMinor: z.int(),
});
export type ProcedureContributionRow = z.infer<typeof procedureContributionRow>;

export const procedureContributionReport = reportEnvelope.extend({
  basis: costBasis,
  /** ⚠️ Always `false`. See the shape's header, and point 4 of the file's. */
  procedureFeeIncluded: z.literal(false),
  rows: z.array(procedureContributionRow),
  totals: z.array(reportCurrencyTotal),
});
export type ProcedureContributionReport = z.infer<typeof procedureContributionReport>;

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Which reports exist, what each answers, and whether the caller may open it.
 *
 * ⚠️ THE SERVER DECIDES `available`, NOT THE SCREEN. The web app could filter a
 *   hard-coded list against the session's permissions and would get it right
 *   until the first custom role — a clinic that clones ACCOUNTANT and removes
 *   one code would still see the tile, click it, and get a 403 with no
 *   explanation. One list, resolved where the permissions actually live.
 */
export const reportDescriptor = z.object({
  key: reportKey,
  title: z.string(),
  /** One sentence, written for the person opening it rather than for a developer. */
  summary: z.string(),
  /** The path a client calls, relative to `/api/v1`. */
  path: z.string(),
  /** The code this report is gated on. Shown so an admin can grant it. */
  permission: z.string(),
  /** True when the report takes `from` and `to`. */
  dated: z.boolean(),
  available: z.boolean(),
  /** True when the caller also holds `report.export`. */
  exportable: z.boolean(),
});
export type ReportDescriptor = z.infer<typeof reportDescriptor>;

export const reportCatalogue = z.object({
  reports: z.array(reportDescriptor),
});
export type ReportCatalogue = z.infer<typeof reportCatalogue>;
