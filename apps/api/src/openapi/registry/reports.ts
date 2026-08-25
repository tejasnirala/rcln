/**
 * Reporting & cost accounting — what all of the other phases add up to.
 *
 * Nine reads over tables nine other phases wrote, and not one new table. Every
 * figure is arithmetic over `stock_ledger`, `stock_balances`, `batches`,
 * `product_cost_averages`, the dispensing and consumption registers and the
 * procurement documents.
 *
 * ⚠️ FOUR THINGS A CONSUMER MUST KNOW BEFORE READING A NUMBER OFF THESE, and all
 *   four are stated on the endpoints below rather than only here: valuation
 *   counts stock in transit unless told not to; a cost is what the clinic paid
 *   and never what a patient is charged; totals are per currency and are never
 *   summed across one; and `procedure-contribution` does not contain the
 *   procedure's fee, because nothing in this product prices one.
 *
 * ⚠️ NOTHING HERE DISCLOSES A PATIENT. Two of the nine read the clinical
 *   consumption register and both group the person away — the grain is the
 *   product or the procedure type. No endpoint on this router writes a
 *   `data_access_logs` row, and none is marked `phi`.
 */
import {
  agingReport,
  consumptionCostReport,
  deadStockReport,
  dispensingReport,
  movementReport,
  procedureContributionReport,
  quarantineReport,
  reportCatalogue,
  supplierPerformanceReport,
  valuationReport,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH,
  BRANCH_ID,
  CURRENCY,
  DISPENSE_LINE_PAISE,
  ENCOUNTER_PROCEDURE_ID,
  PRODUCT,
  PRODUCT_ID,
  SUPPLIER,
  SUPPLIER_ID,
} from './fixtures.js';

/** Shared prose, so nine endpoints cannot describe the same rule nine ways. */
const BRANCH_PARAM =
  'One branch, or omit for **every branch you can see**. This is the opposite default from a write, where the branch must be named: a report across three sites is the ordinary question. A branch outside your scope answers `404`, never `403`.';
const FORMAT_PARAM =
  "`json` (default) or `csv`. **`csv` requires `report.export` on top of this endpoint's own read permission** and returns `text/csv` with a `Content-Disposition` attachment header rather than the JSON envelope. It ignores pagination up to 5,000 rows and says so in the file when it hits that cap.";
const BASIS_PARAM =
  "`BATCH` values each lot at what **that** lot cost; `MOVING_AVERAGE` values it at the branch's rolling average for the product. Where the chosen basis has no figure the other stands in, and `appliedBasis` on each row says which actually ran. Where neither exists the cost is `null` and the quantity is reported as unvalued — **never as zero**.";
const WINDOW_PARAM =
  "Inclusive calendar dates, resolved in **each branch's own timezone**. A report over three branches in three zones buckets each branch's rows into that branch's days, which one pair of instants could not do.";
const TOTALS_NOTE =
  '`totals` is an **array, one entry per currency**, and is computed over the whole report rather than over the page. `product_cost_averages` is keyed by currency, so one product at one branch can honestly carry two averages — adding them would produce a number in no currency at all.';

const PAGE_PARAMS = {
  page: 'Page number, from 1.',
  limit: 'Rows per page, up to 200.',
  sortOrder: '`asc` or `desc`.',
  branchId: BRANCH_PARAM,
  format: FORMAT_PARAM,
};

const DATED_PAGE_PARAMS = {
  ...PAGE_PARAMS,
  from: WINDOW_PARAM,
  to: WINDOW_PARAM,
};

const ENVELOPE = {
  branchIds: [BRANCH_ID],
  generatedAt: '2026-03-17T09:00:00.000Z',
  page: 1,
  limit: 50,
  total: 1,
  truncated: false,
};

const VALUATION_ROW = {
  branchId: BRANCH_ID,
  branchName: BRANCH.name,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  productCode: PRODUCT.code,
  baseUnitSymbol: 'cap',
  batchId: BATCH_ID,
  lotNumber: BATCH.batchNumber,
  expiresOn: BATCH.expiresOn,
  quantityBase: '480',
  quantityAvailableBase: '480',
  unitCostMinor: 500,
  appliedBasis: 'BATCH',
  currency: CURRENCY,
  valueMinor: 240000,
};

export const reportDocs: DocRegistry = {
  'GET /api/v1/reports': {
    summary: 'List the reports available to you',
    description: `
The menu behind the Reports tab: which reports exist, what each answers, and
whether **you** may open it.

⚠️ **The server decides \`available\`, not the screen.** A hard-coded list
filtered client-side is right until the first custom role — a clinic that clones
ACCOUNTANT and removes one code would still see the tile, click it, and get a
\`403\` with no explanation. \`permission\` is on each descriptor so an
administrator can be told exactly what to grant.

\`exportable\` is true only when you hold **both** \`report.export\` and that
report's own read code. Holding the export verb does not make a report you
cannot read exportable.
`.trim(),
    response: reportCatalogue,
    responseExamples: [
      {
        summary: 'A storekeeper — stock reports, no revenue',
        value: {
          success: true,
          message: 'Success',
          data: {
            reports: [
              {
                key: 'inventory-valuation',
                title: 'Stock valuation',
                summary: 'What the stock on the shelves is worth, lot by lot, at cost.',
                path: '/reports/inventory/valuation',
                permission: 'report.inventory.read',
                dated: false,
                available: true,
                exportable: true,
              },
              {
                key: 'procedure-contribution',
                title: 'Procedure contribution',
                summary:
                  'What procedures billed for their materials, less what those materials cost. Does not include the procedure fee.',
                path: '/reports/consumption/procedure-contribution',
                permission: 'report.revenue.read',
                dated: true,
                available: false,
                exportable: false,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/inventory/valuation': {
    summary: 'Value the stock on hand',
    description: `
What the stock on the shelves is worth, at **cost**, one row per lot per branch.

${TOTALS_NOTE}

⚠️ **A cost is not a price.** Everything here is what the clinic paid. What a
patient is charged lives on \`product_prices\` and the invoice.

⚠️ **Stock in transit is included by default, and it does not come from a stock
bucket.** A quantity dispatched from one branch and not yet received at another
has no balance row anywhere: the transfer *document* holds it, because a
sender-owned bucket would make the receiver write against a branch they cannot
see. \`includeInTransit\` therefore adds \`sent − received\` over the lines of
\`DISPATCHED\` and \`PARTIALLY_RECEIVED\` transfers, attributed to the **sending**
branch — which is what makes an organization-wide valuation count it exactly
once. Turn it off for a stock-take reconciliation, where only what somebody can
physically count belongs.

⚠️ **Nothing is ever valued at zero to make the arithmetic work.** A lot with no
cost under either basis comes back with \`unitCostMinor: null\` and its quantity
intact, and that quantity appears in \`totals[].unvaluedQuantityBase\` — a number
somebody will go and fix, rather than one somebody will add up.

\`DISPOSED\` stock is excluded from every basis and every filter: it has left the
building.
`.trim(),
    response: valuationReport,
    params: {
      ...PAGE_PARAMS,
      productId: 'Narrow to one product.',
      categoryId: 'Narrow to one product category.',
      basis: BASIS_PARAM,
      includeInTransit: 'Default `true`. See the description.',
      includeNonSellable:
        'Default `true`. Quarantined, blocked, expired, damaged and recalled quantities are held, countable and valued until they are disposed of. Set `false` for a sellable-stock-only figure.',
      sortBy: '`value` (default), `quantity` or `product`.',
    },
    responseExamples: [
      {
        summary: 'One lot of amoxicillin, valued at what it cost',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'inventory-valuation',
            window: null,
            basis: 'BATCH',
            includeInTransit: true,
            includeNonSellable: true,
            rows: [VALUATION_ROW],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 240000,
                quantityBase: '480',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/inventory/aging': {
    summary: 'Age the stock on hand',
    description: `
How long stock has been held, or how long it has left, in buckets — with the
value of each bucket.

⚠️ **Two clocks, and they are not the same question.** \`clock=receipt\` is how
long the clinic's money has been sitting on a shelf. \`clock=expiry\` (the
default) is how long before it has to be written off. A fast-moving product
received a year ago and expiring next month is a different problem from a slow
one received last week and expiring in 2031.

⚠️ **\`EXPIRED\` is a bucket, not an omission.** Expired stock is on the shelf,
undispensable, and needs to be counted and valued until it is destroyed — which
is exactly why an expiry is recorded as a move between buckets rather than as a
removal. A report that dropped it would tell a clinic it has nothing to dispose
of.

Day counts are taken in **the branch's own timezone**. "Expires in two days" read
from a UTC server after 18:30 in India is "expires in one day", and that is the
one figure a storekeeper acts on.
`.trim(),
    response: agingReport,
    params: {
      ...PAGE_PARAMS,
      productId: 'Narrow to one product.',
      categoryId: 'Narrow to one product category.',
      basis: BASIS_PARAM,
      clock: '`expiry` (default) or `receipt`. See the description.',
      sortBy: '`bucket` (default), `value` or `quantity`.',
    },
    responseExamples: [
      {
        summary: 'One lot, expiring in more than a year',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'inventory-aging',
            window: null,
            basis: 'BATCH',
            clock: 'expiry',
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                bucket: 'OVER_365',
                batchId: BATCH_ID,
                lotNumber: BATCH.batchNumber,
                expiresOn: BATCH.expiresOn,
                receivedAt: '2025-09-04T05:30:00.000Z',
                daysToExpiry: 532,
                daysHeld: 194,
                quantityBase: '480',
                unitCostMinor: 500,
                currency: CURRENCY,
                valueMinor: 240000,
              },
            ],
            buckets: [
              {
                bucket: 'OVER_365',
                currency: CURRENCY,
                quantityBase: '480',
                valueMinor: 240000,
                lineCount: 1,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 240000,
                quantityBase: '480',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/inventory/movement': {
    summary: 'What moved in and out over a period',
    description: `
One row per product per branch: what the shelf held at the start, what came in,
what went out and where it went, and what it held at the end.

⚠️ **Opening and closing are replayed from the ledger, not read from the balance
cache.** \`stock_balances\` is a cache of the present moment with no memory —
asking it what a shelf held on 1 March is asking a question it cannot answer, and
it would answer anyway. \`opening + received − issued ≡ closing\` on every row,
and a test asserts it.

⚠️ **A quarantine is not an issue and an expiry is not a disposal.** Quarantine,
recall, reservation, expiry and damage move a quantity between buckets without
changing what the branch holds, and none of them appears in \`received\` or
\`issued\`. \`DISPOSAL\` is the movement that actually removes stock, and it has
its own column.

\`adjustedBase\` is the one signed figure on this report: an adjustment can go
either way, and it is the only movement type whose meaning is not already stated
by its name — which is why the ledger requires a reason code on it.
`.trim(),
    response: movementReport,
    params: {
      ...DATED_PAGE_PARAMS,
      productId: 'Narrow to one product.',
      categoryId: 'Narrow to one product category.',
      sortBy: '`out` (default), `in`, `net` or `product`.',
    },
    responseExamples: [
      {
        summary: 'A month at one counter',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'inventory-movement',
            window: { from: '2026-03-01', to: '2026-03-31' },
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                openingBase: '600',
                receivedBase: '0',
                issuedBase: '120',
                dispensedBase: '120',
                consumedBase: '0',
                transferredOutBase: '0',
                disposedBase: '0',
                adjustedBase: '0',
                closingBase: '480',
                movementCount: 14,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/inventory/dead-stock': {
    summary: 'Find stock nothing has asked for',
    description: `
Products with stock on hand and nothing going out for \`idleDays\` or longer,
with what that stock is worth.

⚠️ **"No outbound movement", not "no movement".** A lot quarantined on Monday and
released on Friday has moved twice and gone nowhere. Counting that as activity
would hide the slowest stock in the building behind the housekeeping performed on
it.

\`daysOfCover\` is how long the quantity on hand would last at the last 365
days' rate, and it is \`null\` — never a very large number — when nothing went
out all year. "Twelve thousand days of cover" is arithmetic pretending to be an
answer; \`idleDays\` beside it already says what a person needs to know.

\`minValueMinor\` filters out rows a manager will not act on. Rows whose cost
could **not** be resolved survive it: "we cannot tell you what this idle stock is
worth" is the row a clinic most needs to see.
`.trim(),
    response: deadStockReport,
    params: {
      ...PAGE_PARAMS,
      categoryId: 'Narrow to one product category.',
      basis: BASIS_PARAM,
      idleDays: 'Days with nothing going out before stock counts as dead. Default 180.',
      minValueMinor: 'Ignore rows worth less than this, in **minor units**. Default 0.',
      sortBy: '`value` (default), `idleDays` or `quantity`.',
    },
    responseExamples: [
      {
        summary: 'A product nothing has asked for since November',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'dead-stock',
            window: null,
            basis: 'BATCH',
            idleDays: 180,
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                quantityBase: '480',
                lastIssuedAt: '2025-09-08T06:10:00.000Z',
                lastReceivedAt: '2025-09-04T05:30:00.000Z',
                idleDays: 190,
                daysOfCover: null,
                unitCostMinor: 500,
                currency: CURRENCY,
                valueMinor: 240000,
                earliestExpiresOn: BATCH.expiresOn,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 240000,
                quantityBase: '480',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/inventory/quarantine': {
    summary: 'What is being held, and what it costs',
    description: `
Everything the clinic may not sell — quarantined, recalled, blocked, damaged or
expired — with the value tied up in it.

⚠️ **One report for all five, and \`hold\` is what separates them.** A
storekeeper's question is "what may I not sell, and how much of the clinic's
money is it". The regulator's narrower question is \`GET /api/v1/recalls/{id}\`,
which is a different screen behind a different permission.

\`heldSince\` and \`reason\` come from the lot's own columns and are \`null\` for
a \`DAMAGED\` or \`EXPIRED\` quantity — those were put in their bucket by a
movement, and only quarantine and recall stamp the batch. Answering "since when"
for the others means a ledger walk per held lot, which is the query that takes
the screen down; the honest \`null\` is cheaper than the confident guess.
`.trim(),
    response: quarantineReport,
    params: {
      ...PAGE_PARAMS,
      hold: 'One of `QUARANTINED`, `RECALLED`, `BLOCKED`, `DAMAGED`, `EXPIRED`. Omit for all five.',
      productId: 'Narrow to one product.',
      basis: BASIS_PARAM,
      sortBy: '`value` (default), `quantity` or `heldSince`.',
    },
    responseExamples: [
      {
        summary: 'One lot held under a manufacturer notice',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'quarantine-exposure',
            window: null,
            basis: 'BATCH',
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                hold: 'RECALLED',
                batchId: BATCH_ID,
                lotNumber: BATCH.batchNumber,
                expiresOn: BATCH.expiresOn,
                quantityBase: '480',
                heldSince: '2026-03-16T11:20:00.000Z',
                reason: 'CIPLA/REC/2026/018',
                unitCostMinor: 500,
                currency: CURRENCY,
                valueMinor: 240000,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 240000,
                quantityBase: '480',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/procurement/supplier-performance': {
    summary: 'Score suppliers on delivery, fill and quality',
    description: `
Whether each supplier delivered what was ordered, when they promised it.

⚠️ **On-time is measured against the promised date, and an order with no promised
date is neither on time nor late.** Scoring it as a success would reward exactly
the behaviour this report exists to expose, which is why
\`ordersWithoutPromisedDate\` is a column rather than a rounding.

⚠️ **Fill rate is ordered-vs-received on the LINE, not on the order.** An order
90% filled across ten lines is a different supplier from one that delivered nine
lines and forgot the tenth, and an order-grained percentage cannot tell them
apart.

An order enters the window by when it was **issued**, never when it was drafted
and never when it arrived — using the arrival date would move an order into
whichever month the supplier chose to deliver in. Cancelled orders are excluded:
cancelling is the clinic's act.

Returns and quality rejections are counted over the **window**, not over these
orders: a return in March is against a delivery that may have been ordered in
January, and pushing the signal back into a month whose report has been read
already helps nobody.

Every rate is \`null\` rather than \`0\` when there is nothing to divide by.
"This supplier filled 0% of what we ordered" and "we ordered nothing from this
supplier" are different sentences.
`.trim(),
    response: supplierPerformanceReport,
    params: {
      ...DATED_PAGE_PARAMS,
      supplierId: 'Narrow to one supplier.',
      sortBy: '`spend` (default), `onTime`, `fillRate` or `returnRate`.',
    },
    responseExamples: [
      {
        summary: 'One supplier, one late delivery',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'supplier-performance',
            window: { from: '2026-01-01', to: '2026-03-31' },
            rows: [
              {
                supplierId: SUPPLIER_ID,
                supplierName: SUPPLIER.name,
                supplierCode: SUPPLIER.code,
                ordersPlaced: 6,
                ordersReceived: 5,
                ordersWithoutPromisedDate: 1,
                ordersOnTime: 4,
                ordersLate: 1,
                averageDaysLate: '3.0',
                fillRate: '0.9820',
                returnRate: '0.0040',
                qualityRejectRate: '0.0000',
                currency: CURRENCY,
                spendMinor: 1840000,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 1840000,
                quantityBase: '6',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/pharmacy/dispensing': {
    summary: 'What went across the counter',
    description: `
Supplies by product over a period: how many, how much, how much came back, and
what was billed for it.

⚠️ **Counts and quantities, and not one name.** "1,204 supplies of amoxicillin"
is a management figure; "these 1,204 people" is a \`recall.trace.patients\`
answer that this permission does not buy. No patient reaches this response and no
disclosure is logged.

⚠️ **Returns are subtracted AND reported.** \`netQuantityBase\` is what actually
left the building; \`returnedQuantityBase\` is a quality signal in its own right
and vanishes the moment it is only ever netted off.

\`billedMinor\` is what reached an **invoice**, read from the charge requests
raised by these supplies. It is \`null\` where nothing did — a ward issue is
ordinarily not billed at all, and \`0\` would say the clinic charged nothing
rather than that it never tried.

\`overrideCount\` counts supplies where a pharmacist reached past the FEFO plan.
That is recorded, never prevented, and it is worth watching.
`.trim(),
    response: dispensingReport,
    params: {
      ...DATED_PAGE_PARAMS,
      productId: 'Narrow to one product.',
      categoryId: 'Narrow to one product category.',
      kind: '`PRESCRIPTION`, `COUNTER_SALE` or `ONLINE`.',
      sortBy: '`quantity` (default), `supplies`, `value` or `product`.',
    },
    responseExamples: [
      {
        summary: 'A month of one medicine',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'dispensing',
            window: { from: '2026-03-01', to: '2026-03-31' },
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                supplyCount: 12,
                quantityBase: '120',
                returnedQuantityBase: '10',
                netQuantityBase: '110',
                overrideCount: 1,
                billedMinor: DISPENSE_LINE_PAISE * 12,
                currency: CURRENCY,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: DISPENSE_LINE_PAISE * 12,
                quantityBase: '110',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/consumption/cost': {
    summary: 'What procedures used, valued',
    description: `
What was consumed during procedures, valued at cost, beside what the templates
expected.

⚠️ **The variance column is the point of this report.** A template that expects
two pairs of gloves for a procedure that uses three is not a block at the point
of care — a clinician does not stop to argue with a form — it is a report, and
this is it. \`expected\` is the snapshot the template supplied **at the moment of
recording**, never a re-read of today's template: re-reading it would restate
last month's variances every time somebody tidied a template.

⚠️ **A reversal is subtracted, not dropped.** A correction is recorded as its own
consumption row rather than as an edit, so a report filtered to plain
consumptions would count material that was put back and miss material that was
topped up — in opposite directions, on the same procedure.

Defaults to \`MOVING_AVERAGE\`, because consumption allocates across lots line by
line and a product-grained cost has no single lot to read.

⚠️ **The grain is the product or the procedure TYPE — never the patient.** This
endpoint reads the clinical consumption register and groups the person away
before anything is projected.
`.trim(),
    response: consumptionCostReport,
    params: {
      ...DATED_PAGE_PARAMS,
      productId: 'Narrow to one product.',
      categoryId: 'Narrow to one product category.',
      groupBy: '`product` (default) or `procedure`.',
      basis: BASIS_PARAM,
      sortBy: '`cost` (default), `quantity` or `variance`.',
    },
    responseExamples: [
      {
        summary: 'One consumable, used slightly more than expected',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'consumption-cost',
            window: { from: '2026-03-01', to: '2026-03-31' },
            basis: 'MOVING_AVERAGE',
            groupBy: 'product',
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCode: PRODUCT.code,
                baseUnitSymbol: 'cap',
                procedureItemId: null,
                procedureName: null,
                eventCount: 9,
                expectedQuantityBase: '18',
                actualQuantityBase: '21',
                varianceQuantityBase: '3',
                overrideCount: 2,
                unitCostMinor: 500,
                currency: CURRENCY,
                costMinor: 10500,
                varianceCostMinor: 1500,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 10500,
                quantityBase: '21',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/reports/consumption/procedure-contribution': {
    summary: 'What procedures earned on their materials',
    description: `
What each procedure billed for the materials it used, less what those materials
cost.

⚠️ **THIS DOES NOT CONTAIN THE PROCEDURE'S FEE, AND CANNOT.** There is no
per-procedure price anywhere in this product: the fee schedule prices a fee
*type* — \`PROCEDURE\` is one string covering every procedure a clinic performs —
a \`PROCEDURE\` invoice carries no reference back to the procedure it billed, and
charge requests exist only for pharmacy and inventory supplies. So the revenue
side here is **what was billed for the materials**. Every field says
\`consumable\`, and \`procedureFeeIncluded\` is \`false\` on every response as a
fact rather than a footnote. Widening it needs a per-procedure rate card, which
is a charging-model change and not a reporting one.

⚠️ **So \`contributionMinor\` is not profit.** It is the margin on materials —
whether consumable pricing covers consumable cost. A real question, and a
narrower one than "contribution" usually means in a set of accounts.

\`unbilledCostMinor\` is what makes a negative contribution readable: a clinic
whose policy is not to bill consumables sees its whole cost there and knows the
number is a policy rather than a leak.

Cost and revenue are joined **on currency**, so a clinic that buys in one and
bills in another gets two internally consistent rows for one procedure rather
than one row subtracting dollars from rupees.

Consumption filed against the visit rather than against a named procedure is not
in this report at all. It is an ordinary and correct thing to record, and it
cannot be attributed to a procedure.
`.trim(),
    response: procedureContributionReport,
    params: {
      ...DATED_PAGE_PARAMS,
      procedureItemId: 'Narrow to one procedure from the clinical master list.',
      basis: BASIS_PARAM,
      sortBy: '`contribution` (default), `revenue`, `cost`, `volume` or `margin`.',
    },
    responseExamples: [
      {
        summary: 'A procedure whose consumables are billed at a small margin',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENVELOPE,
            reportKey: 'procedure-contribution',
            window: { from: '2026-03-01', to: '2026-03-31' },
            basis: 'MOVING_AVERAGE',
            procedureFeeIncluded: false,
            rows: [
              {
                branchId: BRANCH_ID,
                branchName: BRANCH.name,
                procedureItemId: ENCOUNTER_PROCEDURE_ID,
                procedureName: 'Composite restoration',
                performedCount: 9,
                currency: CURRENCY,
                consumableRevenueMinor: 27000,
                consumableCostMinor: 10500,
                contributionMinor: 16500,
                marginRatio: '0.6111',
                contributionPerProcedureMinor: 1833,
                unbilledCostMinor: 0,
              },
            ],
            totals: [
              {
                currency: CURRENCY,
                valueMinor: 16500,
                quantityBase: '9',
                unvaluedQuantityBase: '0',
                lineCount: 1,
              },
            ],
          },
        },
      },
    ],
  },
};
