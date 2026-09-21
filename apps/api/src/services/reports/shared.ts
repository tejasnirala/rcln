/**
 * The pieces every report needs, in one place so nine queries cannot drift.
 *
 * ⚠️ NO PHI IS READ OR LOGGED FROM ANY FILE IN THIS DIRECTORY. Two of the nine
 *   reports read `clinical_consumptions`, which carries a NOT NULL `patient_id`;
 *   both group it away before it reaches a response shape. `patient_id` appears
 *   in no SELECT list in this directory, and a test asserts it.
 *
 * ── WHY THESE ARE RAW QUERIES ───────────────────────────────────────────────
 * Every report here is a GROUP BY over hundreds of thousands of ledger rows with
 * a correlated cost lookup and two or three LEFT JOINs. Expressed through the
 * Prisma client each one becomes several round trips and a fold in Node — which
 * is how a valuation over a three-branch hospital becomes a screen nobody opens
 * twice. They are `$queryRaw` with every value parameterised, and they run
 * inside `withTenant`, so RLS applies to them exactly as it applies to the
 * client: `rcln_app` cannot see another clinic's rows from raw SQL either.
 *
 * ⚠️ AND EVERY ONE OF THEM STILL FILTERS `organization_id` AND `branch_id`
 *   EXPLICITLY. RLS is the guarantee; the predicate is the second of ADR-0003's
 *   three independent layers, and a report is exactly the sort of read where a
 *   policy gap would surface as somebody else's numbers rather than as an error.
 */
import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type { CostBasis, ReportCurrencyTotal, ReportFormat, ReportKey } from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { assertBranchInScope } from '../shared/branch.js';

/**
 * How many rows a CSV export will carry before it stops.
 *
 * ⚠️ A CAP AND NOT A PAGE, AND THE DIFFERENCE MATTERS. An export that silently
 *   returned the first fifty rows would be a file that looks complete and is
 *   not — the worst failure a spreadsheet can have, because nothing about it
 *   looks wrong. At the cap the response sets `truncated` and the CSV's last
 *   line is a comment saying so, so a reader who opens the file finds out.
 */
export const CSV_ROW_CAP = 5000;

/** Reports own no writes, so this is only ever what a route knows about a read. */
export interface ReportOptions {
  /** The branch the caller is acting at, used only when they name none. */
  actingBranchId?: string | null | undefined;
}

/**
 * Which places is this report about?
 *
 * ⚠️ THE OPPOSITE DEFAULT FROM `resolveBranchId`, AND DELIBERATELY. That helper
 *   refuses to guess because a WRITE happens at exactly one place. A report is
 *   the one read where "all of them" is the ordinary question — an owner asking
 *   what three sites are holding — so omitting `branchId` means every branch in
 *   scope rather than an error.
 *
 * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a branch outside scope. RLS has already
 *   made the rows invisible and a 403 would confirm the id is real.
 */
export function resolveReportBranches(ctx: TenantContext, named: string | undefined): string[] {
  if (named !== undefined) {
    assertBranchInScope(ctx, named);
    return [named];
  }
  if (ctx.branchIds.length === 0) throw new NotFoundError('Branch');
  return [...ctx.branchIds];
}

/**
 * A window of calendar days, checked before it reaches SQL.
 *
 * ⚠️ THE WINDOW IS NEVER TURNED INTO INSTANTS IN NODE, AND THAT IS THE WHOLE
 *   POINT OF RETURNING STRINGS. A report spanning three branches spans up to
 *   three timezones, and one pair of instants cannot be right for all of them:
 *   "March at the Kochi branch" and "March at the Dubai branch" are different
 *   spans. Every query below therefore compares
 *   `(x.occurred_at AT TIME ZONE b.timezone)::date` against these two dates, so
 *   each branch's rows are bucketed into that branch's own days — invariant 6,
 *   resolved in Postgres, which is the only place that knows all three zones at
 *   once.
 */
export function resolveWindow(from: string, to: string): { from: string; to: string } {
  if (from > to) {
    throw new ValidationError('The start of the window is after its end.');
  }
  return { from, to };
}

/** Branch ids as a SQL list, always non-empty by the time it is called. */
export function branchList(branchIds: readonly string[]): Prisma.Sql {
  return Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`));
}

/** `LIMIT`/`OFFSET`, or the CSV cap when the caller asked for a file. */
export function windowFor(
  format: ReportFormat,
  page: number,
  limit: number
): { take: number; skip: number } {
  return format === 'csv'
    ? { take: CSV_ROW_CAP, skip: 0 }
    : { take: limit, skip: (page - 1) * limit };
}

/**
 * The unit cost of one base unit, per (branch, product, lot), in minor units.
 *
 * ⚠️ THE FALLBACK CHAIN IS THE HONEST PART OF THIS FILE, AND IT NEVER REACHES
 *   ZERO. Under `BATCH` a lot is valued at what THAT lot cost, and where the lot
 *   carries no cost the branch's moving average stands in. Under
 *   `MOVING_AVERAGE` the average leads and the lot's own cost stands in behind
 *   it. When neither exists the row comes back with a NULL cost and its quantity
 *   intact, and every caller here reports that quantity as `unvalued` — because
 *   valuing it at zero produces a number somebody will add up, and a NULL
 *   produces a number somebody will go and fix.
 *
 * ⚠️ AND THE CURRENCY TRAVELS WITH THE COST, NEVER SEPARATELY.
 *   `product_cost_averages` is keyed BY currency (PI-4), so one product at one
 *   branch can honestly hold two averages. Where the lot names a currency the
 *   average in THAT currency is the one used (`ac`); where it names none, the
 *   average backed by the most stock wins (`ad`) — the branch's dominant
 *   currency for that product, rather than whichever row the planner happened to
 *   return first.
 *
 * ── THE TWO ALIASES EVERY REPORT IS WRITTEN AGAINST ─────────────────────────
 * `src` is whatever row drives the report — a balance, a ledger aggregate, a
 * consumption grain. `bt` is the LEFT JOINed `batches` row, WHICH MAY BE ALL
 * NULLS.
 *
 * ⚠️ FIXED NAMES AND NOT PARAMETERS, DELIBERATELY. The obvious shape takes the
 *   alias as an argument and pastes it in with `Prisma.raw`, which puts an
 *   identifier-shaped hole in the middle of every report query in the codebase.
 *   Every value would be a literal written here today, and the first person to
 *   pass a variable would be interpolating into SQL with no compiler and no lint
 *   rule to stop them. Fixing the names removes the hole.
 *
 * ⚠️ AND THEY ARE LATERAL JOINS RATHER THAN CTEs, WHICH IS WHAT LETS THEM BE ONE
 *   FRAGMENT. A CTE has to be hoisted into a `WITH` on every statement that uses
 *   it — including the `COUNT(*)` that pages the same query — and a helper that
 *   silently requires a second helper at the top of the statement is a helper
 *   somebody will use half of. These joins carry their own scope.
 *
 * ⚠️ DRIVEN BY THE BALANCE OR LEDGER ROW AND **NOT** BY THE LOT, WHICH IS THE
 *   DIFFERENCE BETWEEN A CORRECT VALUATION AND ONE MISSING EVERY UNTRACKED
 *   PRODUCT. `batch_id` is nullable on `stock_balances`, `stock_ledger`,
 *   `dispense_allocations` and `consumption_allocations` — a product with
 *   `tracking_mode = NONE` has quantity and no lot at all. A cost lookup keyed
 *   off the batch would silently drop every one of them, and the total would
 *   look entirely plausible.
 */
export function costJoins(organizationId: string): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT a.currency,
             CASE WHEN a.valued_quantity_base > 0
                  THEN round(a.valued_cost_minor::numeric / a.valued_quantity_base)
             END AS unit_cost_minor
        FROM product_cost_averages a
       WHERE a.organization_id = ${organizationId}::uuid
         AND a.branch_id       = src.branch_id
         AND a.product_id      = src.product_id
         AND a.currency        = bt.currency
       ORDER BY a.valued_quantity_base DESC
       LIMIT 1
    ) ac ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.currency,
             CASE WHEN a.valued_quantity_base > 0
                  THEN round(a.valued_cost_minor::numeric / a.valued_quantity_base)
             END AS unit_cost_minor
        FROM product_cost_averages a
       WHERE a.organization_id = ${organizationId}::uuid
         AND a.branch_id       = src.branch_id
         AND a.product_id      = src.product_id
       ORDER BY a.valued_quantity_base DESC
       LIMIT 1
    ) ad ON TRUE
  `;
}

/**
 * The three cost expressions, applied to the driving row.
 *
 * Returns the cost per base unit, the currency it is in, and WHICH basis
 * actually produced it — the last so a reader can see that a valuation asked
 * for "on batch cost" fell back to the moving average for a third of its rows.
 *
 * ⚠️ `bt` MAY BE A ROW OF NULLS, and every expression below survives it.
 */
export function costColumns(basis: CostBasis): Prisma.Sql {
  return basis === 'BATCH'
    ? Prisma.sql`
        COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor)::text AS unit_cost_minor,
        COALESCE(bt.currency, ac.currency, ad.currency)                           AS currency,
        CASE WHEN bt.unit_cost_base IS NOT NULL THEN 'BATCH'
             WHEN COALESCE(ac.unit_cost_minor, ad.unit_cost_minor) IS NOT NULL THEN 'MOVING_AVERAGE'
        END                                                                       AS applied_basis`
    : Prisma.sql`
        COALESCE(ac.unit_cost_minor, ad.unit_cost_minor, bt.unit_cost_base)::text AS unit_cost_minor,
        COALESCE(ac.currency, ad.currency, bt.currency)                           AS currency,
        CASE WHEN COALESCE(ac.unit_cost_minor, ad.unit_cost_minor) IS NOT NULL THEN 'MOVING_AVERAGE'
             WHEN bt.unit_cost_base IS NOT NULL THEN 'BATCH'
        END                                                                       AS applied_basis`;
}

/**
 * The same cost, expressed per (branch, product, currency) for a report whose
 * grain has no lot at all.
 *
 * ⚠️ A JOIN AND NOT A LATERAL PICK, BECAUSE THE CURRENCY IS PART OF THE GRAIN
 *   HERE. `procedure-contribution` reports one row per currency on purpose — a
 *   clinic that buys in USD and bills in INR gets two internally consistent rows
 *   rather than one that subtracts dollars from rupees — so this must MULTIPLY
 *   rows by currency where two exist, which is exactly what a lateral `LIMIT 1`
 *   is written to prevent.
 */
export function costPerCurrency(organizationId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT a.branch_id,
           a.product_id,
           a.currency,
           CASE WHEN a.valued_quantity_base > 0
                THEN round(a.valued_cost_minor::numeric / a.valued_quantity_base)
           END AS unit_cost_minor
      FROM product_cost_averages a
     WHERE a.organization_id = ${organizationId}::uuid
  `;
}

/**
 * A `numeric` or `bigint` column that came back as text, as a number of minor
 * units.
 *
 * ⚠️ EVERY MONEY COLUMN IN THIS DIRECTORY IS CAST `::text` IN SQL AND PARSED
 *   HERE, rather than left to the driver. Postgres `bigint` reaches Node as a
 *   `BigInt` and `numeric` as a `Prisma.Decimal`, and the two do not compare,
 *   serialise or add the same way — a report that mixed them would produce
 *   `"4800"` on one row and `4800` on the next through the same field. One cast,
 *   one parse, one type on the wire.
 */
export function minor(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/** The same, where the absence of a figure means zero rather than "unknown". */
export function minorOrZero(value: string | null | undefined): number {
  return minor(value) ?? 0;
}

/** A quantity as the wire wants it: a string, never a float. */
export function qty(value: string | null | undefined): string {
  return value ?? '0';
}

/** A count column, cast `::int` in SQL and therefore already a number. */
export function count(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * A ratio, to four decimal places, or null when the denominator is zero.
 *
 * ⚠️ NULL AND NOT ZERO WHEN THERE IS NOTHING TO DIVIDE BY. "This supplier filled
 *   0% of what we ordered" and "we ordered nothing from this supplier" are
 *   different sentences, and a report that renders both as `0.0000` invites
 *   somebody to terminate a contract over an empty month.
 */
export function ratio(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  return (numerator / denominator).toFixed(4);
}

/** Rows the totals block is folded from, whatever report produced them. */
export interface TotalledRow {
  currency: string | null;
  valueMinor: number | null;
  quantityBase: string;
}

/**
 * Per-currency totals, folded in Node from the PAGE'S OWN rows or from a
 * separate whole-report aggregate — never mixed.
 *
 * ⚠️ EVERY CALLER PASSES THE WHOLE-REPORT AGGREGATE, AND THAT IS NOT AN
 *   ACCIDENT. A totals block computed over the fifty rows a page happened to
 *   contain is a subtotal wearing the word "total", and the first person to
 *   print page two of a valuation would file two different answers to the same
 *   question.
 */
export function foldTotals(rows: readonly TotalledRow[]): ReportCurrencyTotal[] {
  const byCurrency = new Map<string, ReportCurrencyTotal>();
  /*
   * Rows whose cost could not be resolved carry no currency, so they cannot be
   * filed under one. They are counted in `unvaluedQuantityBase` on EVERY
   * currency present — because the clinic holds that stock whichever set of
   * books is being read — and, where the report found no currency at all, under
   * a single unvalued entry so the quantity is never lost.
   */
  let unvalued = new Prisma.Decimal(0);
  let unvaluedLines = 0;

  for (const row of rows) {
    if (row.currency === null || row.valueMinor === null) {
      unvalued = unvalued.plus(new Prisma.Decimal(row.quantityBase));
      unvaluedLines += 1;
      continue;
    }
    const current = byCurrency.get(row.currency);
    if (current) {
      byCurrency.set(row.currency, {
        currency: row.currency,
        valueMinor: current.valueMinor + row.valueMinor,
        quantityBase: new Prisma.Decimal(current.quantityBase)
          .plus(new Prisma.Decimal(row.quantityBase))
          .toString(),
        unvaluedQuantityBase: '0',
        lineCount: current.lineCount + 1,
      });
    } else {
      byCurrency.set(row.currency, {
        currency: row.currency,
        valueMinor: row.valueMinor,
        quantityBase: new Prisma.Decimal(row.quantityBase).toString(),
        unvaluedQuantityBase: '0',
        lineCount: 1,
      });
    }
  }

  const totals = [...byCurrency.values()].map((total) => ({
    ...total,
    unvaluedQuantityBase: unvalued.toString(),
  }));

  if (totals.length === 0 && unvaluedLines > 0) {
    totals.push({
      currency: 'XXX',
      valueMinor: 0,
      quantityBase: '0',
      unvaluedQuantityBase: unvalued.toString(),
      lineCount: unvaluedLines,
    });
  }

  return totals.sort((a, b) => b.valueMinor - a.valueMinor);
}

/** What every report's envelope is built from, so the nine cannot disagree. */
export interface EnvelopeInput {
  reportKey: ReportKey;
  branchIds: string[];
  window: { from: string; to: string } | null;
  page: number;
  limit: number;
  total: number;
  format: ReportFormat;
  rowsReturned: number;
}

export function envelope(input: EnvelopeInput): {
  reportKey: ReportKey;
  generatedAt: string;
  branchIds: string[];
  window: { from: string; to: string } | null;
  page: number;
  limit: number;
  total: number;
  truncated: boolean;
} {
  return {
    reportKey: input.reportKey,
    generatedAt: new Date().toISOString(),
    branchIds: input.branchIds,
    window: input.window,
    page: input.format === 'csv' ? 1 : input.page,
    limit: input.format === 'csv' ? CSV_ROW_CAP : input.limit,
    total: input.total,
    truncated: input.format === 'csv' && input.rowsReturned >= CSV_ROW_CAP,
  };
}

/**
 * `COUNT(*)` over the same query the page came from.
 *
 * Each report passes its own assembled FROM/WHERE, so the count and the page can
 * never be filtered differently — which is the failure that makes a list say
 * "203 results" and show four pages of them.
 */
export async function countRows(tx: TxClient, query: Prisma.Sql): Promise<number> {
  const rows = await tx.$queryRaw<{ total: number }[]>(query);
  return count(rows[0]?.total);
}
