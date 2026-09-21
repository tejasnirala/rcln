/**
 * What each report looks like on screen: its columns, and the filters it takes.
 *
 * ⚠️ THIS IS NOT A COPY OF THE API'S CSV COLUMN LISTS, AND THE TWO ARE ALLOWED
 *   TO DIFFER. A file and a screen are different surfaces with different jobs: a
 *   CSV carries every field because somebody will pivot it, while a table has to
 *   fit and therefore drops the ids and the fields a person can already see in
 *   the row beside them. What they must NOT do is disagree about what a column
 *   MEANS, which is why both carry `_minor` in the heading of every money
 *   column and neither divides by a hundred on the way out.
 *
 * ⚠️ AND THE FILTER LIST IS DELIBERATELY SHORTER THAN THE CONTRACT'S QUERY. Ids
 *   — `productId`, `supplierId`, `categoryId`, `procedureItemId` — are honoured
 *   by the API and reachable from a URL, so a link from a product page lands
 *   filtered. They have no picker here because a picker on nine screens is nine
 *   more places to keep a catalogue search in sync; the URL is the contract.
 *
 * NO PHI: no field named here exists on any report.
 */
export type ReportFieldKind =
  | 'text'
  /** An identifier a person reads character by character — a lot, a code. */
  | 'mono'
  /** A quantity in base units, right-aligned. Arrives as a decimal string. */
  | 'qty'
  /** Integer minor units, rendered in the row's own currency. Right-aligned. */
  | 'money'
  | 'int'
  /** A 0–1 decimal string, shown as a percentage. */
  | 'ratio'
  | 'date'
  | 'datetime'
  /** A short lowercase label: a bucket, a hold, which cost basis applied. */
  | 'tag';

export interface ReportColumn {
  header: string;
  field: string;
  kind: ReportFieldKind;
}

export interface ReportFilter {
  name: string;
  label: string;
  kind: 'select' | 'number' | 'date';
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
}

export interface ReportSpec {
  title: string;
  blurb: string;
  dated: boolean;
  /**
   * The one sentence a reader must have before trusting the numbers. Rendered
   * above the table, not buried in a tooltip — every one of these is a limit
   * that would otherwise be discovered by somebody acting on a wrong figure.
   */
  caveat?: string;
  filters: readonly ReportFilter[];
  columns: readonly ReportColumn[];
}

const BASIS_FILTER: ReportFilter = {
  name: 'basis',
  label: 'Cost basis',
  kind: 'select',
  options: [
    { value: 'BATCH', label: 'What the lot cost' },
    { value: 'MOVING_AVERAGE', label: 'Rolling average' },
  ],
};

const BRANCH_COLUMN: ReportColumn = { header: 'Branch', field: 'branchName', kind: 'text' };
const PRODUCT_COLUMNS: readonly ReportColumn[] = [
  { header: 'Product', field: 'productName', kind: 'text' },
  { header: 'Code', field: 'productCode', kind: 'mono' },
];

export const REPORT_SPECS: Record<string, ReportSpec> = {
  'inventory-valuation': {
    title: 'Stock valuation',
    blurb: 'What the stock on the shelves is worth, lot by lot, at what the clinic paid.',
    dated: false,
    caveat:
      'At cost, never at what a patient is charged. Stock on a van between two of your own sites is read off the transfer note and counted at the branch that sent it. A lot nobody has costed is reported unvalued, never as zero.',
    filters: [
      BASIS_FILTER,
      {
        name: 'includeNonSellable',
        label: 'Held stock',
        kind: 'select',
        options: [
          { value: 'true', label: 'Include what cannot be sold' },
          { value: 'false', label: 'Sellable stock only' },
        ],
      },
      {
        name: 'includeInTransit',
        label: 'In transit',
        kind: 'select',
        options: [
          { value: 'true', label: 'Include stock in transit' },
          { value: 'false', label: 'On the shelf only' },
        ],
      },
    ],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'Lot', field: 'lotNumber', kind: 'mono' },
      { header: 'Expires', field: 'expiresOn', kind: 'date' },
      { header: 'On hand', field: 'quantityBase', kind: 'qty' },
      { header: 'Available', field: 'quantityAvailableBase', kind: 'qty' },
      { header: 'Unit cost', field: 'unitCostMinor', kind: 'money' },
      { header: 'Basis', field: 'appliedBasis', kind: 'tag' },
      { header: 'Value', field: 'valueMinor', kind: 'money' },
    ],
  },

  'inventory-aging': {
    title: 'Stock aging',
    blurb: 'How long stock has been held, and how long it has left.',
    dated: false,
    caveat:
      'Day counts are taken in each branch’s own timezone. Expired stock is a bucket, not an omission — it is still on the shelf and still has to be disposed of.',
    filters: [
      BASIS_FILTER,
      {
        name: 'clock',
        label: 'Measure',
        kind: 'select',
        options: [
          { value: 'expiry', label: 'Time left before expiry' },
          { value: 'receipt', label: 'Time held since receipt' },
        ],
      },
    ],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'Bucket', field: 'bucket', kind: 'tag' },
      { header: 'Lot', field: 'lotNumber', kind: 'mono' },
      { header: 'Expires', field: 'expiresOn', kind: 'date' },
      { header: 'Days left', field: 'daysToExpiry', kind: 'int' },
      { header: 'Days held', field: 'daysHeld', kind: 'int' },
      { header: 'On hand', field: 'quantityBase', kind: 'qty' },
      { header: 'Value', field: 'valueMinor', kind: 'money' },
    ],
  },

  'inventory-movement': {
    title: 'Stock movement',
    blurb: 'What came in, what went out, and where it went.',
    dated: true,
    caveat:
      'Opening and closing are replayed from the ledger, not read off today’s balances. A quarantine is not an issue and an expiry is not a disposal — neither changes what the branch holds, so neither appears in received or issued.',
    filters: [],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'Opening', field: 'openingBase', kind: 'qty' },
      { header: 'Received', field: 'receivedBase', kind: 'qty' },
      { header: 'Issued', field: 'issuedBase', kind: 'qty' },
      { header: 'Dispensed', field: 'dispensedBase', kind: 'qty' },
      { header: 'Consumed', field: 'consumedBase', kind: 'qty' },
      { header: 'Transferred out', field: 'transferredOutBase', kind: 'qty' },
      { header: 'Disposed', field: 'disposedBase', kind: 'qty' },
      { header: 'Adjusted', field: 'adjustedBase', kind: 'qty' },
      { header: 'Closing', field: 'closingBase', kind: 'qty' },
    ],
  },

  'dead-stock': {
    title: 'Dead stock',
    blurb: 'Money on a shelf that nothing has asked for.',
    dated: false,
    caveat:
      'Idle means nothing has gone OUT. A lot quarantined and released has moved twice and gone nowhere, and that does not count as activity.',
    filters: [
      BASIS_FILTER,
      {
        name: 'idleDays',
        label: 'Idle for at least',
        kind: 'number',
        placeholder: '180 days',
      },
    ],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'On hand', field: 'quantityBase', kind: 'qty' },
      { header: 'Idle days', field: 'idleDays', kind: 'int' },
      { header: 'Last issued', field: 'lastIssuedAt', kind: 'datetime' },
      { header: 'Days of cover', field: 'daysOfCover', kind: 'int' },
      { header: 'Earliest expiry', field: 'earliestExpiresOn', kind: 'date' },
      { header: 'Value', field: 'valueMinor', kind: 'money' },
    ],
  },

  'quarantine-exposure': {
    title: 'Held stock',
    blurb: 'What cannot be sold, why, and what it is costing.',
    dated: false,
    caveat:
      '"Held since" is blank for damaged and expired quantities. Only a quarantine and a recall stamp the lot itself; the rest is answerable from the ledger, one lot at a time.',
    filters: [
      BASIS_FILTER,
      {
        name: 'hold',
        label: 'Hold',
        kind: 'select',
        options: [
          { value: '', label: 'Any hold' },
          { value: 'QUARANTINED', label: 'Quarantined' },
          { value: 'RECALLED', label: 'Recalled' },
          { value: 'BLOCKED', label: 'Blocked' },
          { value: 'DAMAGED', label: 'Damaged' },
          { value: 'EXPIRED', label: 'Expired' },
        ],
      },
    ],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'Hold', field: 'hold', kind: 'tag' },
      { header: 'Lot', field: 'lotNumber', kind: 'mono' },
      { header: 'Expires', field: 'expiresOn', kind: 'date' },
      { header: 'Quantity', field: 'quantityBase', kind: 'qty' },
      { header: 'Held since', field: 'heldSince', kind: 'datetime' },
      { header: 'Reason', field: 'reason', kind: 'text' },
      { header: 'Value', field: 'valueMinor', kind: 'money' },
    ],
  },

  'supplier-performance': {
    title: 'Supplier performance',
    blurb: 'Whether each supplier delivered what was ordered, when they promised it.',
    dated: true,
    caveat:
      'An order with no promised date is neither on time nor late — it is counted separately, because scoring it as a success would reward exactly what this report exists to show. A blank rate means there was nothing to divide by, not zero.',
    filters: [],
    columns: [
      { header: 'Supplier', field: 'supplierName', kind: 'text' },
      { header: 'Code', field: 'supplierCode', kind: 'mono' },
      { header: 'Placed', field: 'ordersPlaced', kind: 'int' },
      { header: 'Received', field: 'ordersReceived', kind: 'int' },
      { header: 'No date', field: 'ordersWithoutPromisedDate', kind: 'int' },
      { header: 'On time', field: 'ordersOnTime', kind: 'int' },
      { header: 'Late', field: 'ordersLate', kind: 'int' },
      { header: 'Avg days late', field: 'averageDaysLate', kind: 'text' },
      { header: 'Fill rate', field: 'fillRate', kind: 'ratio' },
      { header: 'Returned', field: 'returnRate', kind: 'ratio' },
      { header: 'Rejected', field: 'qualityRejectRate', kind: 'ratio' },
      { header: 'Spend', field: 'spendMinor', kind: 'money' },
    ],
  },

  dispensing: {
    title: 'Dispensing',
    blurb: 'What went across the counter, by product.',
    dated: true,
    caveat:
      'Counts and quantities. This report names nobody, and it never will — who received a medicine is a different question behind a different permission.',
    filters: [
      {
        name: 'kind',
        label: 'Kind',
        kind: 'select',
        options: [
          { value: '', label: 'Every supply' },
          { value: 'PRESCRIPTION', label: 'Against a prescription' },
          { value: 'COUNTER_SALE', label: 'Over the counter' },
          { value: 'ONLINE', label: 'Sent in a parcel' },
        ],
      },
    ],
    columns: [
      BRANCH_COLUMN,
      ...PRODUCT_COLUMNS,
      { header: 'Supplies', field: 'supplyCount', kind: 'int' },
      { header: 'Out', field: 'quantityBase', kind: 'qty' },
      { header: 'Back', field: 'returnedQuantityBase', kind: 'qty' },
      { header: 'Net', field: 'netQuantityBase', kind: 'qty' },
      { header: 'Overrides', field: 'overrideCount', kind: 'int' },
      { header: 'Billed', field: 'billedMinor', kind: 'money' },
    ],
  },

  'consumption-cost': {
    title: 'Consumption cost',
    blurb: 'What procedures used, valued, beside what the templates expected.',
    dated: true,
    caveat:
      'Expected is what the template said at the moment of recording, never a re-read of today’s template — otherwise tidying a template would restate last month’s variances.',
    filters: [
      {
        name: 'groupBy',
        label: 'Group by',
        kind: 'select',
        options: [
          { value: 'product', label: 'The product used' },
          { value: 'procedure', label: 'The procedure that used it' },
        ],
      },
      BASIS_FILTER,
    ],
    columns: [
      BRANCH_COLUMN,
      { header: 'Product', field: 'productName', kind: 'text' },
      { header: 'Procedure', field: 'procedureName', kind: 'text' },
      { header: 'Times', field: 'eventCount', kind: 'int' },
      { header: 'Expected', field: 'expectedQuantityBase', kind: 'qty' },
      { header: 'Actual', field: 'actualQuantityBase', kind: 'qty' },
      { header: 'Variance', field: 'varianceQuantityBase', kind: 'qty' },
      { header: 'Overrides', field: 'overrideCount', kind: 'int' },
      { header: 'Cost', field: 'costMinor', kind: 'money' },
      { header: 'Variance cost', field: 'varianceCostMinor', kind: 'money' },
    ],
  },

  'procedure-contribution': {
    title: 'Procedure contribution',
    blurb: 'What procedures billed for their materials, less what those materials cost.',
    dated: true,
    caveat:
      'This does NOT include the procedure’s own fee — nothing in this product prices one procedure differently from another. It is the margin on materials, and a negative figure usually means a clinic that does not bill consumables. The unbilled column is where to look first.',
    filters: [BASIS_FILTER],
    columns: [
      BRANCH_COLUMN,
      { header: 'Procedure', field: 'procedureName', kind: 'text' },
      { header: 'Performed', field: 'performedCount', kind: 'int' },
      { header: 'Materials billed', field: 'consumableRevenueMinor', kind: 'money' },
      { header: 'Materials cost', field: 'consumableCostMinor', kind: 'money' },
      { header: 'Contribution', field: 'contributionMinor', kind: 'money' },
      { header: 'Per procedure', field: 'contributionPerProcedureMinor', kind: 'money' },
      { header: 'Margin', field: 'marginRatio', kind: 'ratio' },
      { header: 'Unbilled cost', field: 'unbilledCostMinor', kind: 'money' },
    ],
  },
};

/** Where each report is served from, relative to `/api/v1`. */
export const REPORT_PATHS: Record<string, string> = {
  'inventory-valuation': '/reports/inventory/valuation',
  'inventory-aging': '/reports/inventory/aging',
  'inventory-movement': '/reports/inventory/movement',
  'dead-stock': '/reports/inventory/dead-stock',
  'quarantine-exposure': '/reports/inventory/quarantine',
  'supplier-performance': '/reports/procurement/supplier-performance',
  dispensing: '/reports/pharmacy/dispensing',
  'consumption-cost': '/reports/consumption/cost',
  'procedure-contribution': '/reports/consumption/procedure-contribution',
};
