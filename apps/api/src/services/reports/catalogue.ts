/**
 * Which reports exist, and which of them this caller may actually open.
 *
 * ⚠️ THE SERVER DECIDES `available`, NOT THE SCREEN, AND THAT IS THE WHOLE
 *   REASON THIS FILE EXISTS RATHER THAN A CONSTANT IN `apps/web`. A hard-coded
 *   list filtered against the session's permission array would be right until
 *   the first CUSTOM ROLE: a clinic that clones ACCOUNTANT and removes one code
 *   still sees the tile, clicks it, and gets a 403 with no explanation of which
 *   code is missing. One list, resolved where the permissions actually live, and
 *   `permission` is on the descriptor so an administrator can be told what to
 *   grant.
 *
 * ⚠️ IT IS ALSO THE LIST THE ROUTER IS BUILT FROM. `REPORTS` below is the single
 *   declaration of which code gates which path, and `reports.routes.ts` reads
 *   the same constant rather than restating it — so a report cannot be added to
 *   the menu under one permission and served under another.
 */
import { PERMISSIONS, type PermissionCode } from '@rcln/permissions';
import type { ReportCatalogue, ReportDescriptor, ReportKey } from '@rcln/contracts';

export interface ReportDefinition {
  key: ReportKey;
  title: string;
  summary: string;
  /** Relative to `/api/v1`, exactly as the router mounts it. */
  path: string;
  permission: PermissionCode;
  dated: boolean;
}

/**
 * ⚠️ THE PERMISSION SPLIT IS NOT ARBITRARY AND IS WORTH ARGUING WITH BEFORE
 *   CHANGING. Seven of the nine are `report.inventory.read` — they are questions
 *   about stock, asked by whoever runs the store. `consumption-cost` reads the
 *   clinical register and is therefore `report.clinical.read`, even though it
 *   returns no clinical content: the code says which BOOK was opened, not what
 *   came out of it. `procedure-contribution` carries what patients were charged
 *   and is `report.revenue.read`, which is the code an accountant holds and a
 *   storekeeper does not.
 *
 * ⚠️ AND `dispensing` IS `report.inventory.read`, NOT `report.clinical.read`,
 *   WHICH IS THE ONE MOST LIKELY TO BE CHALLENGED. It counts what left a
 *   counter, by product, and names nobody — the same shape as every other stock
 *   movement report. Gating it clinically would mean a stock controller cannot
 *   see what the pharmacy issued, which is half of what a stock controller does.
 */
export const REPORTS: readonly ReportDefinition[] = [
  {
    key: 'inventory-valuation',
    title: 'Stock valuation',
    summary: 'What the stock on the shelves is worth, lot by lot, at cost.',
    path: '/reports/inventory/valuation',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: false,
  },
  {
    key: 'inventory-aging',
    title: 'Stock aging',
    summary: 'How long stock has been held, and how long it has left before it expires.',
    path: '/reports/inventory/aging',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: false,
  },
  {
    key: 'inventory-movement',
    title: 'Stock movement',
    summary: 'What came in and what went out over a period, with opening and closing balances.',
    path: '/reports/inventory/movement',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: true,
  },
  {
    key: 'dead-stock',
    title: 'Dead stock',
    summary: 'Stock nothing has asked for, how long it has sat there, and what it is worth.',
    path: '/reports/inventory/dead-stock',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: false,
  },
  {
    key: 'quarantine-exposure',
    title: 'Held stock',
    summary: 'Everything quarantined, recalled, damaged or expired, and what it is costing.',
    path: '/reports/inventory/quarantine',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: false,
  },
  {
    key: 'supplier-performance',
    title: 'Supplier performance',
    summary: 'Whether each supplier delivered what was ordered, when they promised it.',
    path: '/reports/procurement/supplier-performance',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: true,
  },
  {
    key: 'dispensing',
    title: 'Dispensing',
    summary: 'What went across the counter over a period, by product. Names nobody.',
    path: '/reports/pharmacy/dispensing',
    permission: PERMISSIONS.REPORT_INVENTORY,
    dated: true,
  },
  {
    key: 'consumption-cost',
    title: 'Consumption cost',
    summary: 'What procedures used, valued, beside what the templates expected.',
    path: '/reports/consumption/cost',
    permission: PERMISSIONS.REPORT_CLINICAL,
    dated: true,
  },
  {
    key: 'procedure-contribution',
    title: 'Procedure contribution',
    summary:
      'What procedures billed for their materials, less what those materials cost. Does not include the procedure fee.',
    path: '/reports/consumption/procedure-contribution',
    permission: PERMISSIONS.REPORT_REVENUE,
    dated: true,
  },
];

/** The definition behind one key, for the router and the CSV filename. */
export function reportDefinition(key: ReportKey): ReportDefinition {
  const found = REPORTS.find((report) => report.key === key);
  /*
   * Unreachable through the contract, which types `key` as the enum. Stated
   * rather than left as a possibly-undefined read, for the day a second caller
   * reaches this without going through it.
   */
  if (!found) throw new Error(`No such report: ${key}`);
  return found;
}

export function buildCatalogue(granted: readonly string[]): ReportCatalogue {
  const canExport = granted.includes(PERMISSIONS.REPORT_EXPORT);
  const reports: ReportDescriptor[] = REPORTS.map((report) => ({
    key: report.key,
    title: report.title,
    summary: report.summary,
    path: report.path,
    permission: report.permission,
    dated: report.dated,
    available: granted.includes(report.permission),
    /*
     * ⚠️ EXPORTING NEEDS BOTH CODES, WHICH IS WHY THIS IS AN `&&` AND NOT
     *   `canExport` ALONE. `report.export` is a verb, not a scope: holding it
     *   does not make a report you cannot read exportable, and the route
     *   enforces the same conjunction with two `authorize()` calls.
     */
    exportable: canExport && granted.includes(report.permission),
  }));
  return { reports };
}
