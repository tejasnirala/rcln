/**
 * The four reports about what the clinic DID with its stock (PI-22).
 *
 *   dispensing              what went across the counter, by product
 *   consumption cost        what procedures used, valued, against what the
 *                           template expected
 *   procedure contribution  what those materials were billed for, less what
 *                           they cost
 *   supplier performance    whether a supplier delivers what was ordered, when
 *                           it was promised
 *
 * ⚠️ TWO OF THESE READ `clinical_consumptions`, WHICH CARRIES A NOT NULL
 *   `patient_id`, AND NEITHER RETURNS ONE. The grain is the product or the
 *   procedure ITEM; the person it was performed on is grouped away before the
 *   first projection. `patient_id` appears in no SELECT list in this file, no
 *   `data_access_logs` row is written, and a unit test asserts the first of
 *   those — because the day somebody adds "and show me who" to this report is
 *   the day it needs a different permission and an audit trail, not a new column.
 *
 * ⚠️ MONEY ARRIVES HERE AS `numeric(14,2)` MAJOR UNITS AND LEAVES AS INTEGER
 *   MINOR UNITS, THROUGH `toMoney` AND NOTHING ELSE. `charge_requests.unit_price`
 *   is a major-unit column — `240.00`, not `24000` — while `purchase_orders.
 *   total_minor` is already minor. Converting the first with `× 100` would be
 *   right in India and wrong in Japan, which has no minor unit at all, and this
 *   programme has already shipped packs for six countries.
 */
import { Prisma, withTenant, type TenantContext } from '@rcln/db';
import type {
  ConsumptionCostQuery,
  ConsumptionCostReport,
  ConsumptionCostRow,
  DispensingQuery,
  DispensingReport,
  DispensingRow,
  ProcedureContributionQuery,
  ProcedureContributionReport,
  ProcedureContributionRow,
  SupplierPerformanceQuery,
  SupplierPerformanceReport,
  SupplierPerformanceRow,
} from '@rcln/contracts';
import { toMoney } from '../invoicing/money.js';
import {
  costColumns,
  costJoins,
  costPerCurrency,
  count,
  countRows,
  envelope,
  foldTotals,
  minor,
  minorOrZero,
  qty,
  ratio,
  resolveReportBranches,
  resolveWindow,
  windowFor,
  type ReportOptions,
} from './shared.js';

function direction(order: 'asc' | 'desc'): Prisma.Sql {
  return order === 'asc' ? Prisma.sql`ASC NULLS LAST` : Prisma.sql`DESC NULLS LAST`;
}

function branchIn(branchIds: readonly string[]): Prisma.Sql {
  return Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`));
}

/**
 * A major-unit sum, as it came out of SQL, in minor units.
 *
 * ⚠️ VIA THE STRING FORM AND `toMoney`, NEVER `.toNumber() * 100`. `Decimal`
 *   exists precisely because binary floating point cannot hold `0.1`, and
 *   `fromMajor` is where this codebase decided the currency's own scale is
 *   applied — see `services/invoicing/money.ts`.
 */
function majorToMinor(value: string | null, currency: string | null): number | null {
  if (value === null || currency === null) return null;
  return toMoney(new Prisma.Decimal(value), currency).amountMinor;
}

// ===========================================================================
// 7 — Dispensing
// ===========================================================================

interface DispensingSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  supply_count: number;
  quantity_base: string;
  returned_quantity_base: string;
  override_count: number;
  billed_major: string | null;
  currency: string | null;
}

export async function getDispensingReport(
  ctx: TenantContext,
  query: DispensingQuery,
  _options: ReportOptions = {}
): Promise<DispensingReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const window = resolveWindow(query.from, query.to);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ `returned_quantity_base` IS READ OFF THE LINE, NOT SUMMED FROM
     *   `dispense_return_lines`. PI-7 maintains it on the line under a CHECK
     *   that keeps it at or below what went out, so the line is the number the
     *   database itself guarantees; re-deriving it through a join would produce
     *   a second answer with no constraint behind it, and the two would disagree
     *   the first time a return was recorded outside that path.
     *
     * ⚠️ AND THE WINDOW IS THE BRANCH'S OWN DAY. `dispensed_at` is an instant;
     *   "March at this counter" is a calendar question in the clinic's zone.
     */
    const base = Prisma.sql`
      FROM (
        SELECT d.branch_id,
               dl.product_id,
               COUNT(DISTINCT d.id)::int              AS supply_count,
               SUM(dl.quantity_base)                  AS quantity_base,
               SUM(dl.returned_quantity_base)         AS returned_quantity_base,
               COUNT(DISTINCT dl.id) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM dispense_allocations da
                    WHERE da.dispense_line_id = dl.id
                      AND da.organization_id  = ${ctx.organizationId}::uuid
                      AND da.is_override
                 )
               )::int                                 AS override_count
          FROM dispenses d
          JOIN dispense_lines dl
            ON dl.dispense_id = d.id AND dl.organization_id = d.organization_id
          JOIN branches b ON b.id = d.branch_id AND b.deleted_at IS NULL
         WHERE d.organization_id = ${ctx.organizationId}::uuid
           AND d.branch_id IN (${branchIn(branchIds)})
           AND (d.dispensed_at AT TIME ZONE b.timezone)::date
                 BETWEEN ${window.from}::date AND ${window.to}::date
           AND ${query.kind ? Prisma.sql`d.kind::text = ${query.kind}` : Prisma.sql`TRUE`}
         GROUP BY d.branch_id, dl.product_id
      ) src
      JOIN products         p ON p.id = src.product_id
      JOIN units_of_measure u ON u.id = p.base_unit_id
      JOIN branches         b ON b.id = src.branch_id AND b.deleted_at IS NULL
      /*
       * WHAT WAS BILLED, NOT WHAT IT IS WORTH. charge_requests is the only
       * honest source: invoices carries no line-level link back (PI-8 removed
       * invoice_item_id because finalisation deletes and re-inserts every line),
       * so an invoice-side join would have to guess at position. INVOICED alone
       * -- a PENDING request is money nobody has been asked for.
       */
      LEFT JOIN LATERAL (
        SELECT cr.currency,
               SUM(cr.unit_price * cr.quantity) AS billed_major
          FROM charge_requests cr
          JOIN dispense_lines dl2
            ON dl2.id = cr.dispense_line_id AND dl2.organization_id = cr.organization_id
          JOIN dispenses d2
            ON d2.id = dl2.dispense_id AND d2.organization_id = dl2.organization_id
         WHERE cr.organization_id = ${ctx.organizationId}::uuid
           AND cr.branch_id       = src.branch_id
           AND cr.product_id      = src.product_id
           AND cr.status          = 'INVOICED'
           AND cr.unit_price IS NOT NULL
           AND (d2.dispensed_at AT TIME ZONE b.timezone)::date
                 BETWEEN ${window.from}::date AND ${window.to}::date
         GROUP BY cr.currency
         ORDER BY SUM(cr.unit_price * cr.quantity) DESC
         LIMIT 1
      ) billed ON TRUE
     WHERE ${query.productId ? Prisma.sql`p.id = ${query.productId}::uuid` : Prisma.sql`TRUE`}
       AND ${query.categoryId ? Prisma.sql`p.category_id = ${query.categoryId}::uuid` : Prisma.sql`TRUE`}
    `;

    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name   AS branch_name,
             src.product_id,
             p.name   AS product_name,
             p.code   AS product_code,
             u.symbol AS base_unit_symbol,
             src.supply_count,
             src.quantity_base::text                       AS quantity_base,
             src.returned_quantity_base::text              AS returned_quantity_base,
             src.override_count,
             billed.billed_major::text                     AS billed_major,
             billed.currency
      ${base}
    `;

    const order = {
      quantity: Prisma.sql`(r.quantity_base::numeric - r.returned_quantity_base::numeric)`,
      supplies: Prisma.sql`r.supply_count`,
      product: Prisma.sql`r.product_name`,
      value: Prisma.sql`r.billed_major::numeric`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total] = await Promise.all([
      tx.$queryRaw<DispensingSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.product_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
    ]);

    const shaped: DispensingRow[] = rows.map((row) => {
      const out = new Prisma.Decimal(row.quantity_base);
      const back = new Prisma.Decimal(row.returned_quantity_base);
      return {
        branchId: row.branch_id,
        branchName: row.branch_name,
        productId: row.product_id,
        productName: row.product_name,
        productCode: row.product_code,
        baseUnitSymbol: row.base_unit_symbol,
        supplyCount: count(row.supply_count),
        quantityBase: out.toString(),
        returnedQuantityBase: back.toString(),
        netQuantityBase: out.minus(back).toString(),
        overrideCount: count(row.override_count),
        billedMinor: majorToMinor(row.billed_major, row.currency),
        currency: row.currency,
      };
    });

    /*
     * ⚠️ THE TOTALS BLOCK ON THIS REPORT IS MONEY BILLED AND QUANTITY DISPENSED,
     *   AND `unvaluedQuantityBase` THEREFORE MEANS "SUPPLIED AND NOT BILLED" —
     *   which is a real and useful figure rather than a gap. A ward issue is
     *   ordinarily not billed at all.
     */
    return {
      ...envelope({
        reportKey: 'dispensing',
        branchIds,
        window,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      rows: shaped,
      totals: foldTotals(
        shaped.map((row) => ({
          currency: row.currency,
          valueMinor: row.billedMinor,
          quantityBase: row.netQuantityBase,
        }))
      ),
    };
  });
}

// ===========================================================================
// 8 — Consumption cost
// ===========================================================================

/**
 * The sign a consumption row contributes.
 *
 * ⚠️ A REVERSAL IS SUBTRACTED AND IS NOT A NEGATIVE QUANTITY IN THE DATA.
 *   `consumption_lines.quantity_base` is positive on every row; the DIRECTION is
 *   on the parent's `kind`, for the same reason `ChargeRequestKind` keeps the
 *   sign out of its quantity and `stock_ledger` keeps it out of the caller's
 *   hands. A report that summed the column would count material that was put
 *   back as material that was used.
 */
const CONSUMPTION_SIGN = Prisma.sql`
  CASE WHEN cc.kind = 'CONSUMPTION_REVERSAL' THEN -1 ELSE 1 END
`;

interface ConsumptionCostSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string | null;
  product_name: string | null;
  product_code: string | null;
  base_unit_symbol: string | null;
  procedure_item_id: string | null;
  procedure_name: string | null;
  event_count: number;
  expected_base: string;
  actual_base: string;
  override_count: number;
  unit_cost_minor: string | null;
  currency: string | null;
  cost_minor: string | null;
  variance_cost_minor: string | null;
}

export async function getConsumptionCostReport(
  ctx: TenantContext,
  query: ConsumptionCostQuery,
  _options: ReportOptions = {}
): Promise<ConsumptionCostReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const window = resolveWindow(query.from, query.to);
  const byProduct = query.groupBy === 'product';

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ `patient_id` IS NOT IN THIS SELECT LIST AND MUST NOT BE ADDED. See the
     *   file header. The grain below is (branch, product) or (branch, procedure
     *   item) and the join to `clinical_consumptions` exists only to reach the
     *   kind, the date and the procedure — never the person.
     */
    /*
     * ⚠️ THE COST IS RESOLVED AT LINE GRAIN AND AGGREGATED AFTERWARDS, WHICH IS
     *   THE WHOLE REASON THIS QUERY HAS THREE LEVELS RATHER THAN ONE. Grouping
     *   to the procedure FIRST and then looking up a cost would be looking up
     *   the cost of a procedure — and `product_cost_averages` prices products.
     *   A hip replacement that used an implant, a drape and two pairs of gloves
     *   has four costs, and the earlier shape of this query resolved none of
     *   them: `src.product_id` was NULL on every procedure-grouped row, so the
     *   whole report came back costed at zero and looked fine.
     *
     * ⚠️ AND THE CURRENCY IS PART OF THE GRAIN. Two averages in two currencies
     *   for one product are two rows, never one sum — the rule the file header
     *   states and `foldTotals` relies on.
     */
    const lines = Prisma.sql`
      SELECT cl.branch_id,
             cl.product_id,
             ep.item_id,
             cc.id                                               AS consumption_id,
             cl.expected_quantity_base * ${CONSUMPTION_SIGN}     AS expected_base,
             cl.quantity_base * ${CONSUMPTION_SIGN}              AS actual_base,
             cl.is_override
        FROM consumption_lines cl
        JOIN clinical_consumptions cc
          ON cc.id = cl.consumption_id AND cc.organization_id = cl.organization_id
        LEFT JOIN encounter_procedures ep
          ON ep.id = cc.encounter_procedure_id AND ep.organization_id = cc.organization_id
        JOIN branches b ON b.id = cl.branch_id AND b.deleted_at IS NULL
       WHERE cl.organization_id = ${ctx.organizationId}::uuid
         AND cl.branch_id IN (${branchIn(branchIds)})
         AND (cc.occurred_at AT TIME ZONE b.timezone)::date
               BETWEEN ${window.from}::date AND ${window.to}::date
         AND ${query.productId ? Prisma.sql`cl.product_id = ${query.productId}::uuid` : Prisma.sql`TRUE`}
    `;

    const priced = Prisma.sql`
      SELECT src.branch_id,
             src.product_id,
             src.item_id,
             src.consumption_id,
             src.expected_base,
             src.actual_base,
             src.is_override,
             ${costColumns(query.basis)}
        FROM (${lines}) src
        /*
         * NO LOT, SO NO BATCH COST -- which is why this report defaults to the
         * moving average. Consumption allocates across lots line by line, in
         * consumption_allocations, so a line-grained cost has no single lot to
         * read. bt is joined as an all-NULL row so costColumns is the SAME
         * expression here as on the valuation, rather than a second fallback
         * chain free to drift from the first.
         */
        LEFT JOIN batches bt ON FALSE
        ${costJoins(ctx.organizationId)}
    `;

    const grain = byProduct
      ? Prisma.sql`pl.product_id, NULL::uuid AS procedure_item_id`
      : Prisma.sql`NULL::uuid AS product_id, pl.item_id AS procedure_item_id`;
    const groupBy = byProduct
      ? Prisma.sql`pl.branch_id, pl.product_id, pl.currency`
      : Prisma.sql`pl.branch_id, pl.item_id, pl.currency`;

    const base = Prisma.sql`
      FROM (
        SELECT pl.branch_id,
               ${grain},
               pl.currency,
               COUNT(DISTINCT pl.consumption_id)::int                      AS event_count,
               SUM(pl.expected_base)                                       AS expected_base,
               SUM(pl.actual_base)                                         AS actual_base,
               COUNT(*) FILTER (WHERE pl.is_override)::int                 AS override_count,
               ${byProduct ? Prisma.sql`MAX(pl.unit_cost_minor::numeric)` : Prisma.sql`NULL::numeric`}
                                                                           AS unit_cost_minor,
               SUM(round(pl.actual_base * pl.unit_cost_minor::numeric))     AS cost_minor,
               SUM(round((pl.actual_base - pl.expected_base) * pl.unit_cost_minor::numeric))
                                                                           AS variance_cost_minor
          FROM (${priced}) pl
         GROUP BY ${groupBy}
      ) src
      JOIN branches b ON b.id = src.branch_id AND b.deleted_at IS NULL
      LEFT JOIN products         p  ON p.id  = src.product_id
      LEFT JOIN units_of_measure u  ON u.id  = p.base_unit_id
      LEFT JOIN clinical_master_items mi ON mi.id = src.procedure_item_id
     WHERE ${query.categoryId ? Prisma.sql`p.category_id = ${query.categoryId}::uuid` : Prisma.sql`TRUE`}
    `;

    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name   AS branch_name,
             src.product_id,
             p.name   AS product_name,
             p.code   AS product_code,
             u.symbol AS base_unit_symbol,
             src.procedure_item_id,
             mi.name  AS procedure_name,
             src.event_count,
             COALESCE(src.expected_base, 0)::text AS expected_base,
             COALESCE(src.actual_base, 0)::text   AS actual_base,
             src.override_count,
             src.unit_cost_minor::text            AS unit_cost_minor,
             src.currency,
             src.cost_minor::text                 AS cost_minor,
             src.variance_cost_minor::text        AS variance_cost_minor
      ${base}
    `;

    const order = {
      cost: Prisma.sql`r.cost_minor::numeric`,
      quantity: Prisma.sql`r.actual_base::numeric`,
      variance: Prisma.sql`abs(r.actual_base::numeric - r.expected_base::numeric)`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total] = await Promise.all([
      tx.$queryRaw<ConsumptionCostSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.branch_id
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
    ]);

    const shaped: ConsumptionCostRow[] = rows.map((row) => {
      const expected = new Prisma.Decimal(row.expected_base);
      const actual = new Prisma.Decimal(row.actual_base);
      return {
        branchId: row.branch_id,
        branchName: row.branch_name,
        productId: row.product_id,
        productName: row.product_name,
        productCode: row.product_code,
        baseUnitSymbol: row.base_unit_symbol,
        procedureItemId: row.procedure_item_id,
        procedureName: row.procedure_name,
        eventCount: count(row.event_count),
        expectedQuantityBase: expected.toString(),
        actualQuantityBase: actual.toString(),
        varianceQuantityBase: actual.minus(expected).toString(),
        overrideCount: count(row.override_count),
        unitCostMinor: minor(row.unit_cost_minor),
        currency: row.currency,
        costMinor: minor(row.cost_minor),
        varianceCostMinor: minor(row.variance_cost_minor),
      };
    });

    return {
      ...envelope({
        reportKey: 'consumption-cost',
        branchIds,
        window,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      basis: query.basis,
      groupBy: query.groupBy,
      rows: shaped,
      totals: foldTotals(
        shaped.map((row) => ({
          currency: row.currency,
          valueMinor: row.costMinor,
          quantityBase: row.actualQuantityBase,
        }))
      ),
    };
  });
}

// ===========================================================================
// 9 — Procedure contribution
// ===========================================================================

interface ContributionSqlRow {
  branch_id: string;
  branch_name: string;
  procedure_item_id: string;
  procedure_name: string;
  performed_count: number;
  currency: string;
  revenue_major: string | null;
  cost_minor: string | null;
  unbilled_minor: string | null;
}

export async function getProcedureContributionReport(
  ctx: TenantContext,
  query: ProcedureContributionQuery,
  _options: ReportOptions = {}
): Promise<ProcedureContributionReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const window = resolveWindow(query.from, query.to);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ EVERY LINE THAT A NAMED PROCEDURE CONSUMED, AND NOTHING FILED AGAINST
     *   THE VISIT ITSELF. `clinical_consumptions.encounter_procedure_id` is NULL
     *   when the material was recorded against the consultation rather than
     *   against a procedure, which is an ordinary and correct thing to record —
     *   it simply cannot be attributed to a procedure, and attributing it to one
     *   anyway is how a contribution report acquires costs nobody performed.
     *
     * ⚠️ AND STILL NO `patient_id`. See the file header.
     */
    const procLines = Prisma.sql`
      SELECT cl.id          AS line_id,
             cl.branch_id,
             cl.product_id,
             ep.item_id,
             cc.encounter_procedure_id,
             cl.quantity_base * ${CONSUMPTION_SIGN} AS qty
        FROM consumption_lines cl
        JOIN clinical_consumptions cc
          ON cc.id = cl.consumption_id AND cc.organization_id = cl.organization_id
        JOIN encounter_procedures ep
          ON ep.id = cc.encounter_procedure_id AND ep.organization_id = cc.organization_id
        JOIN branches b ON b.id = cl.branch_id AND b.deleted_at IS NULL
       WHERE cl.organization_id = ${ctx.organizationId}::uuid
         AND cl.branch_id IN (${branchIn(branchIds)})
         AND ep.item_id IS NOT NULL
         AND (cc.occurred_at AT TIME ZONE b.timezone)::date
               BETWEEN ${window.from}::date AND ${window.to}::date
         AND ${query.procedureItemId ? Prisma.sql`ep.item_id = ${query.procedureItemId}::uuid` : Prisma.sql`TRUE`}
    `;

    /**
     * ⚠️ BOTH SIDES ARE PER CURRENCY AND THEY ARE JOINED ON IT, NOT COLLAPSED.
     *   `product_cost_averages` is keyed by currency and so is
     *   `charge_requests`, so a clinic that buys in USD and bills in INR gets
     *   two rows for one procedure — each internally consistent — rather than
     *   one row subtracting dollars from rupees. A FULL OUTER JOIN is what keeps
     *   a procedure that was billed and never costed, or costed and never
     *   billed, visible in both directions.
     */
    const base = Prisma.sql`
      FROM (
        SELECT COALESCE(c.branch_id, rv.branch_id)   AS branch_id,
               COALESCE(c.item_id,  rv.item_id)      AS procedure_item_id,
               COALESCE(c.currency, rv.currency)     AS currency,
               COALESCE(c.performed_count, rv.performed_count, 0)::int AS performed_count,
               rv.revenue_major,
               c.cost_minor,
               c.unbilled_minor
          FROM (
            SELECT pl.branch_id,
                   pl.item_id,
                   a.currency,
                   SUM(round(pl.qty * a.unit_cost_minor))                       AS cost_minor,
                   SUM(round(pl.qty * a.unit_cost_minor)) FILTER (
                     WHERE NOT EXISTS (
                       SELECT 1 FROM charge_requests cr
                        WHERE cr.consumption_line_id = pl.line_id
                          AND cr.organization_id     = ${ctx.organizationId}::uuid
                          AND cr.status              = 'INVOICED'
                     )
                   )                                                            AS unbilled_minor,
                   COUNT(DISTINCT pl.encounter_procedure_id)::int               AS performed_count
              FROM (${procLines}) pl
              JOIN (${costPerCurrency(ctx.organizationId)}) a
                ON a.branch_id = pl.branch_id AND a.product_id = pl.product_id
             GROUP BY pl.branch_id, pl.item_id, a.currency
          ) c
          FULL OUTER JOIN (
            SELECT pl.branch_id,
                   pl.item_id,
                   cr.currency,
                   SUM(cr.unit_price * cr.quantity)               AS revenue_major,
                   COUNT(DISTINCT pl.encounter_procedure_id)::int AS performed_count
              FROM (${procLines}) pl
              JOIN charge_requests cr
                ON cr.consumption_line_id = pl.line_id
               AND cr.organization_id     = ${ctx.organizationId}::uuid
               AND cr.status              = 'INVOICED'
               AND cr.unit_price IS NOT NULL
             GROUP BY pl.branch_id, pl.item_id, cr.currency
          ) rv
            ON  rv.branch_id = c.branch_id
            AND rv.item_id   = c.item_id
            AND rv.currency  = c.currency
      ) src
      JOIN branches                b  ON b.id  = src.branch_id AND b.deleted_at IS NULL
      JOIN clinical_master_items   mi ON mi.id = src.procedure_item_id
    `;

    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name  AS branch_name,
             src.procedure_item_id,
             mi.name AS procedure_name,
             src.performed_count,
             src.currency,
             src.revenue_major::text  AS revenue_major,
             src.cost_minor::text     AS cost_minor,
             src.unbilled_minor::text AS unbilled_minor
      ${base}
    `;

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    /*
     * ⚠️ ORDERED IN NODE AND NOT IN SQL, ALONE AMONG THE NINE. Contribution is
     *   `revenue − cost` with the revenue in MAJOR units and the cost in MINOR
     *   ones, and the conversion between them belongs to `toMoney` — which knows
     *   the currency's scale and lives in TypeScript. Reproducing that scale in
     *   an ORDER BY would be the `× 100` this file's header refuses, written
     *   somewhere nobody would look for it.
     *
     * ⚠️ WHICH MEANS THE WHOLE REPORT IS FETCHED, AND IT USED TO BE `LIMIT
     *   take + skip`. That limit was the PAGE window, not the report: Postgres
     *   returned the first fifty rows it happened to produce — no `ORDER BY`
     *   anywhere in the SQL — and those fifty were sorted in Node and returned
     *   as "the fifty procedures with the highest contribution". With 500
     *   procedures the most profitable one was absent nine times in ten, page
     *   two re-sorted a different overlapping set so rows both duplicated and
     *   vanished, and `totals` folded the same truncated slice — the subtotal
     *   wearing the word "total" that `foldTotals`' own header forbids.
     *
     *   Sorting in Node only works if Node sees everything, so the fetch is now
     *   the whole set. It is bounded by procedure × branch × currency — one row
     *   per procedure a clinic actually performed in the window, not per
     *   procedure PERFORMED — which is the smallest result set of the nine
     *   reports, and `countRows` below already runs the same `base`.
     *   (PI-24 review.)
     */
    const [allRows, total] = await Promise.all([
      tx.$queryRaw<ContributionSqlRow[]>(Prisma.sql`SELECT r.* FROM (${projection}) r`),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
    ]);

    const shaped: ProcedureContributionRow[] = allRows.map((row) => {
      const revenueMinor = majorToMinor(row.revenue_major, row.currency) ?? 0;
      const costMinor = minorOrZero(row.cost_minor);
      const contribution = revenueMinor - costMinor;
      const performed = count(row.performed_count);
      return {
        branchId: row.branch_id,
        branchName: row.branch_name,
        procedureItemId: row.procedure_item_id,
        procedureName: row.procedure_name,
        performedCount: performed,
        currency: row.currency,
        consumableRevenueMinor: revenueMinor,
        consumableCostMinor: costMinor,
        contributionMinor: contribution,
        marginRatio: ratio(contribution, revenueMinor),
        contributionPerProcedureMinor: performed === 0 ? 0 : Math.round(contribution / performed),
        unbilledCostMinor: minorOrZero(row.unbilled_minor),
      };
    });

    const key = {
      contribution: (row: ProcedureContributionRow): number => row.contributionMinor,
      revenue: (row: ProcedureContributionRow): number => row.consumableRevenueMinor,
      cost: (row: ProcedureContributionRow): number => row.consumableCostMinor,
      volume: (row: ProcedureContributionRow): number => row.performedCount,
      margin: (row: ProcedureContributionRow): number => Number(row.marginRatio ?? '-1'),
    }[query.sortBy];

    const sorted = [...shaped].sort((a, b) =>
      query.sortOrder === 'asc' ? key(a) - key(b) : key(b) - key(a)
    );
    const page = sorted.slice(skip, skip + take);

    return {
      ...envelope({
        reportKey: 'procedure-contribution',
        branchIds,
        window,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: page.length,
      }),
      basis: query.basis,
      procedureFeeIncluded: false as const,
      rows: page,
      totals: foldTotals(
        shaped.map((row) => ({
          currency: row.currency,
          valueMinor: row.contributionMinor,
          quantityBase: String(row.performedCount),
        }))
      ),
    };
  });
}

// ===========================================================================
// 6 — Supplier performance
// ===========================================================================

interface SupplierSqlRow {
  supplier_id: string;
  supplier_name: string;
  supplier_code: string | null;
  currency: string;
  orders_placed: number;
  orders_received: number;
  orders_without_promised_date: number;
  orders_on_time: number;
  orders_late: number;
  total_days_late: string | null;
  ordered_base: string;
  received_base: string;
  receipt_received_base: string;
  receipt_rejected_base: string;
  returned_base: string;
  spend_minor: string;
}

export async function getSupplierPerformanceReport(
  ctx: TenantContext,
  query: SupplierPerformanceQuery,
  _options: ReportOptions = {}
): Promise<SupplierPerformanceReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const window = resolveWindow(query.from, query.to);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ AN ORDER ENTERS THIS REPORT WHEN IT WAS ISSUED, NOT WHEN IT WAS DRAFTED
     *   AND NOT WHEN IT ARRIVED. A draft is a document nobody has been held to;
     *   using the receipt date instead would move an order into whichever month
     *   the supplier chose to deliver in, which is the behaviour being measured.
     *
     * ⚠️ AND A CANCELLED ORDER IS OUT. Cancelling is the clinic's act, and
     *   scoring a supplier down for an order the clinic withdrew would be a
     *   number that punishes the wrong party.
     */
    const orders = Prisma.sql`
      SELECT po.id,
             po.supplier_id,
             po.currency,
             po.total_minor,
             po.expected_date,
             (SELECT MAX((gr.received_at AT TIME ZONE b.timezone)::date)
                FROM goods_receipts gr
               WHERE gr.purchase_order_id = po.id
                 AND gr.organization_id   = ${ctx.organizationId}::uuid
                 AND gr.status            = 'POSTED') AS last_received_on
        FROM purchase_orders po
        JOIN branches b ON b.id = po.branch_id AND b.deleted_at IS NULL
       WHERE po.organization_id = ${ctx.organizationId}::uuid
         AND po.branch_id IN (${branchIn(branchIds)})
         AND po.status <> 'CANCELLED'
         AND po.issued_at IS NOT NULL
         AND (po.issued_at AT TIME ZONE b.timezone)::date
               BETWEEN ${window.from}::date AND ${window.to}::date
         AND ${query.supplierId ? Prisma.sql`po.supplier_id = ${query.supplierId}::uuid` : Prisma.sql`TRUE`}
    `;

    const base = Prisma.sql`
      FROM (
        SELECT o.supplier_id,
               o.currency,
               COUNT(*)::int                                                          AS orders_placed,
               COUNT(*) FILTER (WHERE o.last_received_on IS NOT NULL)::int            AS orders_received,
               COUNT(*) FILTER (WHERE o.expected_date IS NULL)::int                   AS orders_without_promised_date,
               COUNT(*) FILTER (WHERE o.expected_date IS NOT NULL
                                  AND o.last_received_on IS NOT NULL
                                  AND o.last_received_on <= o.expected_date)::int     AS orders_on_time,
               COUNT(*) FILTER (WHERE o.expected_date IS NOT NULL
                                  AND o.last_received_on IS NOT NULL
                                  AND o.last_received_on >  o.expected_date)::int     AS orders_late,
               SUM(GREATEST(o.last_received_on - o.expected_date, 0)) FILTER (
                 WHERE o.expected_date IS NOT NULL AND o.last_received_on IS NOT NULL
               )                                                                      AS total_days_late,
               SUM(o.total_minor)                                                     AS spend_minor,
               COALESCE(SUM(l.ordered_base), 0)                                       AS ordered_base,
               COALESCE(SUM(l.received_base), 0)                                      AS received_base
          FROM (${orders}) o
          LEFT JOIN LATERAL (
            SELECT SUM(pol.ordered_quantity_base)  AS ordered_base,
                   SUM(pol.received_quantity_base) AS received_base
              FROM purchase_order_lines pol
             WHERE pol.purchase_order_id = o.id
               AND pol.organization_id   = ${ctx.organizationId}::uuid
          ) l ON TRUE
         GROUP BY o.supplier_id, o.currency
      ) src
      JOIN suppliers s ON s.id = src.supplier_id AND s.deleted_at IS NULL
      /*
       * ⚠️ RECEIPTS AND RETURNS ARE COUNTED OVER THE WINDOW AND **NOT** OVER THE
       *   ORDERS ABOVE, DELIBERATELY. A return in March is against a delivery
       *   that may have been ordered in January; tying it to the order would
       *   push the quality signal back into a month whose report has already
       *   been read. "What came back this month" is the question a buyer asks.
       */
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(grl.received_quantity_base), 0) AS received_base,
               COALESCE(SUM(grl.rejected_quantity_base), 0) AS rejected_base
          FROM goods_receipts gr
          JOIN goods_receipt_lines grl
            ON grl.goods_receipt_id = gr.id AND grl.organization_id = gr.organization_id
          JOIN branches gb ON gb.id = gr.branch_id AND gb.deleted_at IS NULL
         WHERE gr.organization_id = ${ctx.organizationId}::uuid
           AND gr.branch_id IN (${branchIn(branchIds)})
           AND gr.supplier_id = src.supplier_id
           AND gr.status = 'POSTED'
           AND (gr.received_at AT TIME ZONE gb.timezone)::date
                 BETWEEN ${window.from}::date AND ${window.to}::date
      ) rc ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(prl.quantity_base), 0) AS returned_base
          FROM purchase_returns pr
          JOIN purchase_return_lines prl
            ON prl.purchase_return_id = pr.id AND prl.organization_id = pr.organization_id
          JOIN branches rb ON rb.id = pr.branch_id AND rb.deleted_at IS NULL
         WHERE pr.organization_id = ${ctx.organizationId}::uuid
           AND pr.branch_id IN (${branchIn(branchIds)})
           AND pr.supplier_id = src.supplier_id
           AND pr.status = 'SENT'
           AND (pr.created_at AT TIME ZONE rb.timezone)::date
                 BETWEEN ${window.from}::date AND ${window.to}::date
      ) rt ON TRUE
    `;

    const projection = Prisma.sql`
      SELECT src.supplier_id,
             s.name AS supplier_name,
             s.code AS supplier_code,
             src.currency,
             src.orders_placed,
             src.orders_received,
             src.orders_without_promised_date,
             src.orders_on_time,
             src.orders_late,
             src.total_days_late::text        AS total_days_late,
             src.ordered_base::text           AS ordered_base,
             src.received_base::text          AS received_base,
             rc.received_base::text           AS receipt_received_base,
             rc.rejected_base::text           AS receipt_rejected_base,
             rt.returned_base::text           AS returned_base,
             src.spend_minor::text            AS spend_minor
      ${base}
    `;

    const order = {
      spend: Prisma.sql`r.spend_minor::numeric`,
      onTime: Prisma.sql`CASE WHEN (r.orders_on_time + r.orders_late) = 0 THEN NULL
                              ELSE r.orders_on_time::numeric / (r.orders_on_time + r.orders_late) END`,
      fillRate: Prisma.sql`CASE WHEN r.ordered_base::numeric = 0 THEN NULL
                                ELSE r.received_base::numeric / r.ordered_base::numeric END`,
      returnRate: Prisma.sql`CASE WHEN r.receipt_received_base::numeric = 0 THEN NULL
                                  ELSE r.returned_base::numeric / r.receipt_received_base::numeric END`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total] = await Promise.all([
      tx.$queryRaw<SupplierSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.supplier_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
    ]);

    const shaped: SupplierPerformanceRow[] = rows.map((row) => {
      const ordered = Number(row.ordered_base);
      const received = Number(row.received_base);
      const receiptReceived = Number(row.receipt_received_base);
      const rejected = Number(row.receipt_rejected_base);
      const returned = Number(row.returned_base);
      const late = count(row.orders_late);
      return {
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        supplierCode: row.supplier_code,
        ordersPlaced: count(row.orders_placed),
        ordersReceived: count(row.orders_received),
        ordersWithoutPromisedDate: count(row.orders_without_promised_date),
        ordersOnTime: count(row.orders_on_time),
        ordersLate: late,
        averageDaysLate: late === 0 ? null : (Number(row.total_days_late ?? 0) / late).toFixed(1),
        fillRate: ratio(received, ordered),
        returnRate: ratio(returned, receiptReceived),
        qualityRejectRate: ratio(rejected, receiptReceived),
        currency: row.currency,
        spendMinor: minorOrZero(row.spend_minor),
      };
    });

    return {
      ...envelope({
        reportKey: 'supplier-performance',
        branchIds,
        window,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      rows: shaped,
      totals: foldTotals(
        shaped.map((row) => ({
          currency: row.currency,
          valueMinor: row.spendMinor,
          quantityBase: qty(String(row.ordersPlaced)),
        }))
      ),
    };
  });
}
