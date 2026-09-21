/**
 * Reporting & cost accounting (PI-22).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * with ONE addition, described below, and no reordering of anything else.
 *
 * ── WHICH CODE GATES WHAT ───────────────────────────────────────────────────
 *
 *   the menu of reports                        ->  `report.dashboard.read`
 *   seven reports about stock                  ->  `report.inventory.read`
 *   what procedures consumed, valued           ->  `report.clinical.read`
 *   what those materials earned                ->  `report.revenue.read`
 *   taking ANY of them away as a file          ->  `report.export`, ON TOP
 *
 * ⚠️ `report.export` IS A SECOND `authorize()` AND NOT A REPLACEMENT FOR THE
 *   FIRST, WHICH IS WHY IT IS APPLIED CONDITIONALLY RATHER THAN AS A THIRD
 *   ROUTE PER REPORT. `authorize(a, b)` requires BOTH — it is an AND — so the
 *   conjunction is expressible; what is not expressible is "and only when the
 *   caller asked for a file", because the format is a query parameter. The gate
 *   below reads `req.query.format` as a raw string, compares it to the one
 *   literal that matters, and delegates to the ordinary `authorize` when it
 *   matches. Nothing is reordered and nothing is skipped: on a JSON request the
 *   chain is exactly the standard one.
 *
 *   Reading a figure on a screen and walking out of the building with the whole
 *   table are different acts. The second leaves the clinic's control entirely,
 *   and a clinic that lets a locum read a valuation may still not let them
 *   export one.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ NOTHING ON THIS ROUTER DISCLOSES A PATIENT, AND NOTHING ON IT WRITES A
 *   `data_access_logs` ROW. Two of the nine read `clinical_consumptions`, which
 *   carries a NOT NULL `patient_id`, and both group it away before it reaches a
 *   response — the grain is the product or the procedure TYPE. That is the same
 *   line `/traceability/forward` draws against `/traceability/affected`: counts
 *   under one code, names under another. There is no "names" half here at all.
 *
 * ⚠️ AND NOTHING HERE CARRIES A `clinical.*` CODE (invariant 7). A report reads
 *   the clinical register and writes nothing anywhere; `route-gates.test.ts`
 *   asserts it.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from 'express';
import {
  agingQuery,
  consumptionCostQuery,
  deadStockQuery,
  dispensingQuery,
  movementQuery,
  procedureContributionQuery,
  quarantineQuery,
  supplierPerformanceQuery,
  valuationQuery,
  type AgingQuery,
  type AgingRow,
  type ConsumptionCostQuery,
  type ConsumptionCostRow,
  type DeadStockQuery,
  type DeadStockRow,
  type DispensingQuery,
  type DispensingRow,
  type MovementQuery,
  type MovementRow,
  type ProcedureContributionQuery,
  type ProcedureContributionRow,
  type QuarantineQuery,
  type QuarantineRow,
  type ReportKey,
  type SupplierPerformanceQuery,
  type SupplierPerformanceRow,
  type ValuationQuery,
  type ValuationRow,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';

import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import { buildCatalogue } from '../../services/reports/catalogue.js';
import { csvFilename, toCsv, type CsvColumn } from '../../services/reports/csv.js';
import {
  getAgingReport,
  getDeadStockReport,
  getMovementReport,
  getQuarantineReport,
  getValuationReport,
} from '../../services/reports/inventory-reports.service.js';
import {
  getConsumptionCostReport,
  getDispensingReport,
  getProcedureContributionReport,
  getSupplierPerformanceReport,
} from '../../services/reports/activity-reports.service.js';
import type { ReportOptions } from '../../services/reports/shared.js';
import { sendSuccess } from '../../utils/response.js';

const DASHBOARD = PERMISSIONS.REPORT_DASHBOARD;
const INVENTORY = PERMISSIONS.REPORT_INVENTORY;
const CLINICAL = PERMISSIONS.REPORT_CLINICAL;
const REVENUE = PERMISSIONS.REPORT_REVENUE;
const EXPORT = PERMISSIONS.REPORT_EXPORT;

const reportRoutes: IRouter = Router();
reportRoutes.use(requireTenant, authenticate, requireAuth);

/**
 * The export gate. See the header — a conditional `authorize`, never a bypass.
 *
 * ⚠️ IT READS THE RAW QUERY STRING BECAUSE IT RUNS BEFORE `validate`, AND THAT
 *   IS SAFE ONLY BECAUSE IT COMPARES AGAINST A LITERAL. `req.query.format` is
 *   unvalidated user input at this point; the one thing done with it is `===
 *   'csv'`. Anything else — a lookup keyed on it, a message containing it —
 *   would be reaching into unparsed input, which is what `validate` exists to
 *   stop. If the value is anything else the schema rejects it two links later.
 */
function exportGate(req: Request, res: Response, next: NextFunction): void {
  if (req.query.format !== 'csv') {
    next();
    return;
  }
  authorize(EXPORT)(req, res, next);
}

/** Reports own no writes, so a route hands its service nothing but the branch. */
function options(req: Request): ReportOptions {
  return { actingBranchId: req.auth?.branchId ?? null };
}

/**
 * One answer, in whichever of the two shapes was asked for.
 *
 * ⚠️ THE CSV IS THE SAME OBJECT THE JSON WOULD HAVE BEEN, SERIALISED
 *   DIFFERENTLY — never a second query with different filters. A report whose
 *   export disagreed with its screen would be discovered by an auditor rather
 *   than by us.
 */
function respond<Row extends Record<string, unknown>>(
  res: Response,
  report: {
    reportKey: ReportKey;
    window: { from: string; to: string } | null;
    truncated: boolean;
    rows: Row[];
  },
  columns: readonly CsvColumn<Row>[],
  format: 'json' | 'csv'
): void {
  if (format !== 'csv') {
    sendSuccess(res, report);
    return;
  }
  res
    .status(200)
    .type('text/csv; charset=utf-8')
    .set(
      'Content-Disposition',
      `attachment; filename="${csvFilename(report.reportKey, report.window)}"`
    )
    .send(toCsv(columns, report.rows, report.truncated));
}

// ---------------------------------------------------------------------------
// The columns each export carries. A contract with the spreadsheet — see csv.ts.
// ---------------------------------------------------------------------------

const BRANCH_COLUMNS = [{ header: 'Branch', field: 'branchName' }] as const;
const PRODUCT_COLUMNS = [
  { header: 'Product', field: 'productName' },
  { header: 'Code', field: 'productCode' },
  { header: 'Unit', field: 'baseUnitSymbol' },
] as const;

const VALUATION_COLUMNS: readonly CsvColumn<ValuationRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Lot', field: 'lotNumber' },
  { header: 'Expires on', field: 'expiresOn' },
  { header: 'Quantity', field: 'quantityBase' },
  { header: 'Available', field: 'quantityAvailableBase' },
  { header: 'Unit cost_minor', field: 'unitCostMinor' },
  { header: 'Cost basis applied', field: 'appliedBasis' },
  { header: 'Currency', field: 'currency' },
  { header: 'Value_minor', field: 'valueMinor' },
];

const AGING_COLUMNS: readonly CsvColumn<AgingRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Bucket', field: 'bucket' },
  { header: 'Lot', field: 'lotNumber' },
  { header: 'Expires on', field: 'expiresOn' },
  { header: 'Days to expiry', field: 'daysToExpiry' },
  { header: 'Days held', field: 'daysHeld' },
  { header: 'Quantity', field: 'quantityBase' },
  { header: 'Currency', field: 'currency' },
  { header: 'Value_minor', field: 'valueMinor' },
];

const MOVEMENT_COLUMNS: readonly CsvColumn<MovementRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Opening', field: 'openingBase' },
  { header: 'Received', field: 'receivedBase' },
  { header: 'Issued', field: 'issuedBase' },
  { header: 'Dispensed', field: 'dispensedBase' },
  { header: 'Consumed', field: 'consumedBase' },
  { header: 'Transferred out', field: 'transferredOutBase' },
  { header: 'Disposed', field: 'disposedBase' },
  { header: 'Adjusted', field: 'adjustedBase' },
  { header: 'Closing', field: 'closingBase' },
  { header: 'Movements', field: 'movementCount' },
];

const DEAD_STOCK_COLUMNS: readonly CsvColumn<DeadStockRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Quantity', field: 'quantityBase' },
  { header: 'Idle days', field: 'idleDays' },
  { header: 'Last issued at', field: 'lastIssuedAt' },
  { header: 'Last received at', field: 'lastReceivedAt' },
  { header: 'Days of cover', field: 'daysOfCover' },
  { header: 'Earliest expiry', field: 'earliestExpiresOn' },
  { header: 'Currency', field: 'currency' },
  { header: 'Value_minor', field: 'valueMinor' },
];

const QUARANTINE_COLUMNS: readonly CsvColumn<QuarantineRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Hold', field: 'hold' },
  { header: 'Lot', field: 'lotNumber' },
  { header: 'Expires on', field: 'expiresOn' },
  { header: 'Quantity', field: 'quantityBase' },
  { header: 'Held since', field: 'heldSince' },
  { header: 'Reason', field: 'reason' },
  { header: 'Currency', field: 'currency' },
  { header: 'Value_minor', field: 'valueMinor' },
];

const SUPPLIER_COLUMNS: readonly CsvColumn<SupplierPerformanceRow>[] = [
  { header: 'Supplier', field: 'supplierName' },
  { header: 'Code', field: 'supplierCode' },
  { header: 'Orders placed', field: 'ordersPlaced' },
  { header: 'Orders received', field: 'ordersReceived' },
  { header: 'No promised date', field: 'ordersWithoutPromisedDate' },
  { header: 'On time', field: 'ordersOnTime' },
  { header: 'Late', field: 'ordersLate' },
  { header: 'Average days late', field: 'averageDaysLate' },
  { header: 'Fill rate', field: 'fillRate' },
  { header: 'Return rate', field: 'returnRate' },
  { header: 'Quality reject rate', field: 'qualityRejectRate' },
  { header: 'Currency', field: 'currency' },
  { header: 'Spend_minor', field: 'spendMinor' },
];

const DISPENSING_COLUMNS: readonly CsvColumn<DispensingRow>[] = [
  ...BRANCH_COLUMNS,
  ...PRODUCT_COLUMNS,
  { header: 'Supplies', field: 'supplyCount' },
  { header: 'Quantity', field: 'quantityBase' },
  { header: 'Returned', field: 'returnedQuantityBase' },
  { header: 'Net', field: 'netQuantityBase' },
  { header: 'Overrides', field: 'overrideCount' },
  { header: 'Currency', field: 'currency' },
  { header: 'Billed_minor', field: 'billedMinor' },
];

const CONSUMPTION_COLUMNS: readonly CsvColumn<ConsumptionCostRow>[] = [
  ...BRANCH_COLUMNS,
  { header: 'Product', field: 'productName' },
  { header: 'Procedure', field: 'procedureName' },
  { header: 'Unit', field: 'baseUnitSymbol' },
  { header: 'Events', field: 'eventCount' },
  { header: 'Expected', field: 'expectedQuantityBase' },
  { header: 'Actual', field: 'actualQuantityBase' },
  { header: 'Variance', field: 'varianceQuantityBase' },
  { header: 'Overrides', field: 'overrideCount' },
  { header: 'Currency', field: 'currency' },
  { header: 'Cost_minor', field: 'costMinor' },
  { header: 'Variance cost_minor', field: 'varianceCostMinor' },
];

const CONTRIBUTION_COLUMNS: readonly CsvColumn<ProcedureContributionRow>[] = [
  ...BRANCH_COLUMNS,
  { header: 'Procedure', field: 'procedureName' },
  { header: 'Performed', field: 'performedCount' },
  { header: 'Currency', field: 'currency' },
  { header: 'Consumable revenue_minor', field: 'consumableRevenueMinor' },
  { header: 'Consumable cost_minor', field: 'consumableCostMinor' },
  { header: 'Contribution_minor', field: 'contributionMinor' },
  { header: 'Contribution per procedure_minor', field: 'contributionPerProcedureMinor' },
  { header: 'Margin ratio', field: 'marginRatio' },
  { header: 'Unbilled cost_minor', field: 'unbilledCostMinor' },
];

// ---------------------------------------------------------------------------
// The menu  ->  GET /v1/reports
// ---------------------------------------------------------------------------

/**
 * ⚠️ GATED ON `report.dashboard.read` AND NOT ON THE UNION OF THE NINE. The menu
 *   is a list of titles and permission codes; it discloses nothing except which
 *   reports this product has. Gating it on the widest report code would hide the
 *   menu from somebody who holds exactly one of them, and gating it on the
 *   narrowest would be a code chosen at random.
 */
reportRoutes.get('/', authorize(DASHBOARD), async (req: Request, res: Response): Promise<void> => {
  const ctx = tenantContextFrom(req);
  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  /*
   * `authorize()` has already warmed this cache on the way in, so it is a hit.
   * The same pattern `procurement.routes.ts` uses, and for the same reason:
   * `TenantContext` deliberately carries no permissions — it is an isolation
   * boundary, not an authorization one.
   */
  const granted = access
    ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false)
    : [];
  /*
   * ⚠️ A PLATFORM ADMIN HOLDS EVERYTHING, AND `permissionsFor` IS ASKED WITH
   *   `false` ABOVE — so the menu they see is the CLINIC'S, which is the
   *   honest answer for somebody looking at a clinic's screen. `authorize`
   *   still lets them through every report; this list is what the clinic's own
   *   staff would see.
   */
  sendSuccess(res, buildCatalogue(req.auth?.isPlatformAdmin === true ? [] : granted));
});

// ---------------------------------------------------------------------------
// Stock  ->  /v1/reports/inventory/*
// ---------------------------------------------------------------------------

reportRoutes.get(
  '/inventory/valuation',
  authorize(INVENTORY),
  exportGate,
  validate(valuationQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ValuationQuery;
    const report = await getValuationReport(tenantContextFrom(req), query, options(req));
    respond(res, report, VALUATION_COLUMNS, query.format);
  }
);

reportRoutes.get(
  '/inventory/aging',
  authorize(INVENTORY),
  exportGate,
  validate(agingQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AgingQuery;
    const report = await getAgingReport(tenantContextFrom(req), query, options(req));
    respond(res, report, AGING_COLUMNS, query.format);
  }
);

reportRoutes.get(
  '/inventory/movement',
  authorize(INVENTORY),
  exportGate,
  validate(movementQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as MovementQuery;
    const report = await getMovementReport(tenantContextFrom(req), query, options(req));
    respond(res, report, MOVEMENT_COLUMNS, query.format);
  }
);

reportRoutes.get(
  '/inventory/dead-stock',
  authorize(INVENTORY),
  exportGate,
  validate(deadStockQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as DeadStockQuery;
    const report = await getDeadStockReport(tenantContextFrom(req), query, options(req));
    respond(res, report, DEAD_STOCK_COLUMNS, query.format);
  }
);

reportRoutes.get(
  '/inventory/quarantine',
  authorize(INVENTORY),
  exportGate,
  validate(quarantineQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as QuarantineQuery;
    const report = await getQuarantineReport(tenantContextFrom(req), query, options(req));
    respond(res, report, QUARANTINE_COLUMNS, query.format);
  }
);

// ---------------------------------------------------------------------------
// Buying and the counter
// ---------------------------------------------------------------------------

reportRoutes.get(
  '/procurement/supplier-performance',
  authorize(INVENTORY),
  exportGate,
  validate(supplierPerformanceQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as SupplierPerformanceQuery;
    const report = await getSupplierPerformanceReport(tenantContextFrom(req), query, options(req));
    respond(res, report, SUPPLIER_COLUMNS, query.format);
  }
);

reportRoutes.get(
  '/pharmacy/dispensing',
  authorize(INVENTORY),
  exportGate,
  validate(dispensingQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as DispensingQuery;
    const report = await getDispensingReport(tenantContextFrom(req), query, options(req));
    respond(res, report, DISPENSING_COLUMNS, query.format);
  }
);

// ---------------------------------------------------------------------------
// What procedures used, and what it earned
// ---------------------------------------------------------------------------

reportRoutes.get(
  '/consumption/cost',
  authorize(CLINICAL),
  exportGate,
  validate(consumptionCostQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ConsumptionCostQuery;
    const report = await getConsumptionCostReport(tenantContextFrom(req), query, options(req));
    respond(res, report, CONSUMPTION_COLUMNS, query.format);
  }
);

/**
 * ⚠️ `report.revenue.read`, WHICH IS NOT WHAT THE OTHER EIGHT CARRY. This is the
 *   only report on the router that says what patients were CHARGED, and the code
 *   an accountant holds is not the code a storekeeper holds.
 *
 * ⚠️ AND IT DOES NOT CONTAIN THE PROCEDURE'S FEE. Nothing in this schema prices
 *   one procedure differently from another — see the contract's header, point 4.
 *   The response carries `procedureFeeIncluded: false` so a consumer cannot miss
 *   it.
 */
reportRoutes.get(
  '/consumption/procedure-contribution',
  authorize(REVENUE),
  exportGate,
  validate(procedureContributionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ProcedureContributionQuery;
    const report = await getProcedureContributionReport(
      tenantContextFrom(req),
      query,
      options(req)
    );
    respond(res, report, CONTRIBUTION_COLUMNS, query.format);
  }
);

export default reportRoutes;
