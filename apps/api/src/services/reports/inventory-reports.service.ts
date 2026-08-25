/**
 * The five reports about stock the clinic HOLDS (PI-22).
 *
 *   valuation     what it is worth, lot by lot
 *   aging         how long it has been here, and how long it has left
 *   movement      what came in and what went out, over a window
 *   dead stock    money on a shelf nothing has asked for
 *   quarantine    what may not be sold, why, and what that costs
 *
 * ⚠️ NOT ONE OF THEM WRITES ANYTHING. There is no audit row, no
 *   `data_access_logs` row and no cached result — the first two because nothing
 *   here discloses a patient, the third because a cached valuation is a second
 *   answer to a question `stock_ledger` already answers exactly.
 *
 * ⚠️ AND NOT ONE OF THEM READS `stock_balances` FOR A HISTORICAL FIGURE.
 *   `movement`'s opening and closing balances are REPLAYED from the ledger,
 *   because the balance table is a cache of the present moment with no memory:
 *   asking it what a shelf held on 1 March is asking a question it cannot
 *   answer, and it would answer anyway. PI-ADR-004 rule 4 — the ledger wins.
 */
import { Prisma, withTenant, type TenantContext } from '@rcln/db';
import type {
  AgingBucket,
  AgingQuery,
  AgingReport,
  AgingRow,
  DeadStockQuery,
  DeadStockReport,
  DeadStockRow,
  MovementQuery,
  MovementReport,
  MovementRow,
  QuarantineQuery,
  QuarantineReport,
  QuarantineRow,
  ValuationQuery,
  ValuationReport,
  ValuationRow,
} from '@rcln/contracts';
import {
  costColumns,
  costJoins,
  count,
  countRows,
  envelope,
  foldTotals,
  minor,
  qty,
  resolveReportBranches,
  resolveWindow,
  windowFor,
  type ReportOptions,
} from './shared.js';

/**
 * Buckets a quantity can sit in and still be the clinic's stock.
 *
 * ⚠️ `DISPOSED` IS ABSENT FROM EVERY ONE OF THESE LISTS. It is the one status
 *   that means the quantity physically left the building — PI-2's enum says
 *   `DISPOSAL` is the `−` that actually removes stock, where `EXPIRY`, `DAMAGE`
 *   and `RECALL` only move it between buckets. Valuing disposed stock would put
 *   destroyed goods on a balance sheet.
 */
const SELLABLE_STATUSES = ['AVAILABLE', 'RESERVED'] as const;
const HELD_STATUSES = ['QUARANTINED', 'BLOCKED', 'EXPIRED', 'DAMAGED', 'RECALLED'] as const;

function valuationStatuses(query: ValuationQuery): string[] {
  const statuses: string[] = [...SELLABLE_STATUSES];
  if (query.includeNonSellable) statuses.push(...HELD_STATUSES);
  /*
   * ⚠️ `IN_TRANSIT` IS NOT IN THIS LIST AND MUST NOT BE ADDED. The status EXISTS
   *   in the enum and NOTHING EVER WRITES A BALANCE ROW WITH IT — PI-3 decided
   *   the transfer DOCUMENT holds stock in transit, because a sender-owned
   *   bucket would make the receiver write a removal against a branch RLS hides
   *   from them. See the header of `transfer.service.ts`. This report reached
   *   review with `IN_TRANSIT` in the list, which is the exact failure
   *   INVENTORY_ARCHITECTURE.md predicted PI-22 would make: the flag was
   *   honoured, the query returned rows, the total looked right, and stock on a
   *   van was worth nothing. `inTransitRows` below is the real answer.
   */
  return statuses;
}

/**
 * Stock that has left one of the clinic's branches and not arrived at another.
 *
 * ⚠️ `sent − received` OVER THE LINES OF DISPATCHED TRANSFERS, HELD AT THE
 *   SENDING BRANCH, AND NOT A BALANCE BUCKET. That is not a simplification: PI-3
 *   argues at length on `StockTransfer` that an `IN_TRANSIT` row owned by the
 *   sender would force the RECEIVER to write against a branch their tenant
 *   context cannot see, and the only ways round it are to widen the branch
 *   boundary or to write the ledger twice — the first punches the first hole in
 *   tenancy, the second reintroduces the second ledger writer PI-ADR-004 forbids.
 *
 * ⚠️ AT THE SENDING BRANCH IS WHAT MAKES AN ORG-WIDE VALUATION COUNT IT ONCE.
 *   The receiving branch has no row for it at all, so there is nothing to
 *   double.
 *
 * ⚠️ AND `PARTIALLY_RECEIVED` IS INCLUDED, WHICH `DISPATCHED` ALONE WOULD MISS.
 *   A transfer of ten boxes with four received is four on a shelf and six on a
 *   van; filtering to `DISPATCHED` would report the six as nowhere. The
 *   `sent − received` arithmetic is what makes one expression serve both.
 */
function inTransitRows(organizationId: string, branchIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT t.from_branch_id AS branch_id,
           tl.product_id,
           tl.batch_id,
           SUM(tl.sent_quantity_base - tl.received_quantity_base) AS quantity_base,
           0::numeric                                             AS available_base
      FROM stock_transfer_lines tl
      JOIN stock_transfers t
        ON t.id = tl.transfer_id AND t.organization_id = tl.organization_id
     WHERE tl.organization_id = ${organizationId}::uuid
       AND t.from_branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
       AND t.status::text IN ('DISPATCHED', 'PARTIALLY_RECEIVED')
       AND tl.sent_quantity_base > tl.received_quantity_base
     GROUP BY t.from_branch_id, tl.product_id, tl.batch_id
  `;
}

/** A closed set of sort keys per report — see the note on `reportPage`. */
function direction(order: 'asc' | 'desc'): Prisma.Sql {
  return order === 'asc' ? Prisma.sql`ASC NULLS LAST` : Prisma.sql`DESC NULLS LAST`;
}

// ===========================================================================
// 1 — Stock valuation
// ===========================================================================

interface ValuationSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  batch_id: string | null;
  lot_number: string | null;
  expires_on: Date | null;
  quantity_base: string;
  available_base: string;
  unit_cost_minor: string | null;
  currency: string | null;
  applied_basis: 'BATCH' | 'MOVING_AVERAGE' | null;
  value_minor: string | null;
}

export async function getValuationReport(
  ctx: TenantContext,
  query: ValuationQuery,
  _options: ReportOptions = {}
): Promise<ValuationReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const statuses = valuationStatuses(query);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ TWO SOURCES SUMMED, NOT ONE FILTERED: the shelf, and the van. See
     *   `inTransitRows` — a quantity in transit has no balance row anywhere, so
     *   no status filter can reach it. The outer GROUP BY is what makes a lot
     *   that is PART on a shelf and PART on a van one row rather than two.
     */
    const source = query.includeInTransit
      ? Prisma.sql`
          SELECT u.branch_id,
                 u.product_id,
                 u.batch_id,
                 SUM(u.quantity_base)  AS quantity_base,
                 SUM(u.available_base) AS available_base
            FROM (
              SELECT sb.branch_id,
                     sb.product_id,
                     sb.batch_id,
                     SUM(sb.quantity)                                        AS quantity_base,
                     SUM(sb.quantity) FILTER (WHERE sb.status = 'AVAILABLE') AS available_base
                FROM stock_balances sb
               WHERE sb.organization_id = ${ctx.organizationId}::uuid
                 AND sb.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
                 AND sb.quantity > 0
                 AND sb.status::text IN (${Prisma.join(statuses)})
               GROUP BY sb.branch_id, sb.product_id, sb.batch_id
              UNION ALL
              ${inTransitRows(ctx.organizationId, branchIds)}
            ) u
           GROUP BY u.branch_id, u.product_id, u.batch_id
        `
      : Prisma.sql`
          SELECT sb.branch_id,
                 sb.product_id,
                 sb.batch_id,
                 SUM(sb.quantity)                                        AS quantity_base,
                 SUM(sb.quantity) FILTER (WHERE sb.status = 'AVAILABLE') AS available_base
            FROM stock_balances sb
           WHERE sb.organization_id = ${ctx.organizationId}::uuid
             AND sb.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
             AND sb.quantity > 0
             AND sb.status::text IN (${Prisma.join(statuses)})
           GROUP BY sb.branch_id, sb.product_id, sb.batch_id
        `;

    const base = Prisma.sql`
      FROM (${source}) src
      JOIN products        p  ON p.id  = src.product_id
      JOIN units_of_measure u ON u.id  = p.base_unit_id
      JOIN branches        b  ON b.id  = src.branch_id AND b.deleted_at IS NULL
      LEFT JOIN batches    bt ON bt.id = src.batch_id
      ${costJoins(ctx.organizationId)}
     WHERE ${query.productId ? Prisma.sql`p.id = ${query.productId}::uuid` : Prisma.sql`TRUE`}
       AND ${query.categoryId ? Prisma.sql`p.category_id = ${query.categoryId}::uuid` : Prisma.sql`TRUE`}
    `;

    /*
     * ⚠️ ORDERED IN AN OUTER SELECT OVER THE PROJECTION, NOT ON ITS OWN ALIASES.
     *   Every money and quantity column is cast `::text` on the way out (see
     *   `minor`), and Postgres will only accept a bare output alias in ORDER BY
     *   — `value_minor::numeric` in the same SELECT resolves against the FROM
     *   clause instead and fails. Ordering text money is worse than failing:
     *   `9` sorts above `10000`, so the most valuable stock in the clinic falls
     *   to the bottom of page one and nobody notices.
     */
    const order = {
      value: Prisma.sql`r.value_minor::numeric`,
      quantity: Prisma.sql`r.quantity_base::numeric`,
      product: Prisma.sql`r.product_name`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    /*
     * ⚠️ THE VALUE IS COMPUTED IN SQL AND ROUNDED THERE. Doing it in Node would
     *   mean a float multiplication of a Decimal(18,6) quantity by an integer
     *   cost — which is exactly the "never a float for money" rule, one layer
     *   removed and just as wrong.
     */
    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name  AS branch_name,
             src.product_id,
             p.name  AS product_name,
             p.code  AS product_code,
             u.symbol AS base_unit_symbol,
             src.batch_id,
             bt.lot_number,
             bt.expires_on,
             src.quantity_base::text                    AS quantity_base,
             COALESCE(src.available_base, 0)::text      AS available_base,
             ${costColumns(query.basis)},
             round(src.quantity_base * COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor))::text
                                                        AS value_minor
      ${base}
    `;

    const [rows, total, totalsRows] = await Promise.all([
      tx.$queryRaw<ValuationSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.product_name, r.batch_id
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
      /*
       * ⚠️ THE WHOLE REPORT, NOT THE PAGE. A totals block folded from the fifty
       *   rows a page happened to contain is a subtotal wearing the word
       *   "total" — see `foldTotals`.
       */
      tx.$queryRaw<
        { currency: string | null; value_minor: string | null; quantity_base: string }[]
      >(
        Prisma.sql`
          SELECT COALESCE(bt.currency, ac.currency, ad.currency) AS currency,
                 round(src.quantity_base * COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor))::text AS value_minor,
                 src.quantity_base::text AS quantity_base
          ${base}
        `
      ),
    ]);

    const shaped: ValuationRow[] = rows.map((row) => ({
      branchId: row.branch_id,
      branchName: row.branch_name,
      productId: row.product_id,
      productName: row.product_name,
      productCode: row.product_code,
      baseUnitSymbol: row.base_unit_symbol,
      batchId: row.batch_id,
      lotNumber: row.lot_number,
      expiresOn: row.expires_on ? row.expires_on.toISOString().slice(0, 10) : null,
      quantityBase: qty(row.quantity_base),
      quantityAvailableBase: qty(row.available_base),
      unitCostMinor: minor(row.unit_cost_minor),
      appliedBasis: row.applied_basis,
      currency: row.currency,
      valueMinor: minor(row.value_minor),
    }));

    return {
      ...envelope({
        reportKey: 'inventory-valuation',
        branchIds,
        window: null,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      basis: query.basis,
      includeInTransit: query.includeInTransit,
      includeNonSellable: query.includeNonSellable,
      rows: shaped,
      totals: foldTotals(
        totalsRows.map((row) => ({
          currency: row.currency,
          valueMinor: minor(row.value_minor),
          quantityBase: qty(row.quantity_base),
        }))
      ),
    };
  });
}

// ===========================================================================
// 2 — Stock aging
// ===========================================================================

/**
 * The bucket expression, built once for each clock.
 *
 * ⚠️ THE DAY COUNT IS TAKEN IN THE BRANCH'S OWN ZONE AND NOT IN UTC. "Expires in
 *   two days" at a clinic five and a half hours ahead of UTC is "expires in one
 *   day" read from a UTC container after 18:30 local — which is the shape of
 *   the bug PI-8 closed on the pharmacy dashboard, and it lands here on the one
 *   figure a storekeeper acts on.
 */
const EXPIRY_DAYS = Prisma.sql`
  (bt.expires_on - (now() AT TIME ZONE b.timezone)::date)
`;
const HELD_DAYS = Prisma.sql`
  ((now() AT TIME ZONE b.timezone)::date - (bt.received_at AT TIME ZONE b.timezone)::date)
`;

function bucketExpression(clock: 'receipt' | 'expiry'): Prisma.Sql {
  const days = clock === 'expiry' ? EXPIRY_DAYS : HELD_DAYS;
  const anchor = clock === 'expiry' ? Prisma.sql`bt.expires_on` : Prisma.sql`bt.received_at`;
  return Prisma.sql`
    CASE WHEN ${anchor} IS NULL           THEN 'NO_DATE'
         WHEN ${days} <  0                THEN 'EXPIRED'
         WHEN ${days} <= 30               THEN 'D0_30'
         WHEN ${days} <= 60               THEN 'D31_60'
         WHEN ${days} <= 90               THEN 'D61_90'
         WHEN ${days} <= 180              THEN 'D91_180'
         WHEN ${days} <= 365              THEN 'D181_365'
         ELSE 'OVER_365'
    END
  `;
}

/** Sort order for the buckets, so `bucket` sorts as time rather than as text. */
const BUCKET_RANK = Prisma.sql`
  CASE bucket
    WHEN 'EXPIRED'   THEN 0
    WHEN 'D0_30'     THEN 1
    WHEN 'D31_60'    THEN 2
    WHEN 'D61_90'    THEN 3
    WHEN 'D91_180'   THEN 4
    WHEN 'D181_365'  THEN 5
    WHEN 'OVER_365'  THEN 6
    ELSE 7
  END
`;

interface AgingSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  bucket: AgingBucket;
  batch_id: string | null;
  lot_number: string | null;
  expires_on: Date | null;
  received_at: Date | null;
  days_to_expiry: number | null;
  days_held: number | null;
  quantity_base: string;
  unit_cost_minor: string | null;
  currency: string | null;
  value_minor: string | null;
}

export async function getAgingReport(
  ctx: TenantContext,
  query: AgingQuery,
  _options: ReportOptions = {}
): Promise<AgingReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ HELD STATUSES ARE IN, DISPOSED IS OUT. Aging is asked about stock the
     *   clinic still has to do something with, and an expired lot awaiting
     *   destruction is the single most important row on this report.
     */
    const statuses = [...SELLABLE_STATUSES, ...HELD_STATUSES];

    const base = Prisma.sql`
      FROM (
        SELECT sb.branch_id, sb.product_id, sb.batch_id, SUM(sb.quantity) AS quantity_base
          FROM stock_balances sb
         WHERE sb.organization_id = ${ctx.organizationId}::uuid
           AND sb.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
           AND sb.quantity > 0
           AND sb.status::text IN (${Prisma.join(statuses)})
         GROUP BY sb.branch_id, sb.product_id, sb.batch_id
      ) src
      JOIN products        p  ON p.id  = src.product_id
      JOIN units_of_measure u ON u.id  = p.base_unit_id
      JOIN branches        b  ON b.id  = src.branch_id AND b.deleted_at IS NULL
      LEFT JOIN batches    bt ON bt.id = src.batch_id
      ${costJoins(ctx.organizationId)}
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
             ${bucketExpression(query.clock)}          AS bucket,
             src.batch_id,
             bt.lot_number,
             bt.expires_on,
             bt.received_at,
             ${EXPIRY_DAYS}::int                       AS days_to_expiry,
             ${HELD_DAYS}::int                         AS days_held,
             src.quantity_base::text                   AS quantity_base,
             ${costColumns(query.basis)},
             round(src.quantity_base * COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor))::text
                                                       AS value_minor
      ${base}
    `;

    const order = {
      value: Prisma.sql`r.value_minor::numeric`,
      quantity: Prisma.sql`r.quantity_base::numeric`,
      bucket: Prisma.sql`bucket_rank`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total, bucketTotals] = await Promise.all([
      tx.$queryRaw<AgingSqlRow[]>(
        Prisma.sql`
          SELECT r.*, ${BUCKET_RANK} AS bucket_rank
            FROM (${projection}) r
           ORDER BY ${order} ${query.sortBy === 'bucket' ? Prisma.sql`ASC` : direction(query.sortOrder)},
                    r.product_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
      tx.$queryRaw<
        {
          bucket: AgingBucket;
          currency: string | null;
          quantity_base: string;
          value_minor: string | null;
          line_count: number;
        }[]
      >(
        Prisma.sql`
          SELECT r.bucket,
                 r.currency,
                 SUM(r.quantity_base::numeric)::text            AS quantity_base,
                 SUM(COALESCE(r.value_minor::numeric, 0))::text AS value_minor,
                 COUNT(*)::int                                  AS line_count
            FROM (${projection}) r
           GROUP BY r.bucket, r.currency
        `
      ),
    ]);

    const shaped: AgingRow[] = rows.map((row) => ({
      branchId: row.branch_id,
      branchName: row.branch_name,
      productId: row.product_id,
      productName: row.product_name,
      productCode: row.product_code,
      baseUnitSymbol: row.base_unit_symbol,
      bucket: row.bucket,
      batchId: row.batch_id,
      lotNumber: row.lot_number,
      expiresOn: row.expires_on ? row.expires_on.toISOString().slice(0, 10) : null,
      receivedAt: row.received_at ? row.received_at.toISOString() : null,
      daysToExpiry: row.days_to_expiry,
      daysHeld: row.days_held,
      quantityBase: qty(row.quantity_base),
      unitCostMinor: minor(row.unit_cost_minor),
      currency: row.currency,
      valueMinor: minor(row.value_minor),
    }));

    return {
      ...envelope({
        reportKey: 'inventory-aging',
        branchIds,
        window: null,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      basis: query.basis,
      clock: query.clock,
      rows: shaped,
      buckets: bucketTotals
        .filter((row) => row.currency !== null)
        .map((row) => ({
          bucket: row.bucket,
          currency: row.currency as string,
          quantityBase: qty(row.quantity_base),
          valueMinor: minor(row.value_minor) ?? 0,
          lineCount: count(row.line_count),
        })),
      totals: foldTotals(
        bucketTotals.map((row) => ({
          currency: row.currency,
          valueMinor: minor(row.value_minor),
          quantityBase: qty(row.quantity_base),
        }))
      ),
    };
  });
}

// ===========================================================================
// 3 — Stock movement
// ===========================================================================

/**
 * Which ledger rows change what the branch HOLDS.
 *
 * ⚠️ A `MOVE` IS NOT A CHANGE IN HOLDING, AND SUMMING IT WOULD DOUBLE THE
 *   CLINIC'S STOCK. PI-2's `stock_ledger_direction` CHECK gives three shapes:
 *   an ADD carries `status_to` alone, a REMOVE carries `status_from` alone, and
 *   a MOVE carries BOTH with a POSITIVE quantity — quarantine, expiry, recall,
 *   reservation and damage are all moves. Their net effect on the shelf is zero;
 *   the quantity changes which bucket it sits in, not whether it exists. So the
 *   test for "did this change the holding" is the SHAPE of the status pair and
 *   not the sign, and a report that used the sign would report an expiry sweep
 *   as a delivery.
 */
const CHANGES_HOLDING = Prisma.sql`(l.status_from IS NULL OR l.status_to IS NULL)`;

interface MovementSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  opening_base: string;
  received_base: string;
  issued_base: string;
  dispensed_base: string;
  consumed_base: string;
  transferred_out_base: string;
  disposed_base: string;
  adjusted_base: string;
  movement_count: number;
}

export async function getMovementReport(
  ctx: TenantContext,
  query: MovementQuery,
  _options: ReportOptions = {}
): Promise<MovementReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const window = resolveWindow(query.from, query.to);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE WINDOW IS APPLIED IN EACH BRANCH'S OWN ZONE. Three branches can be
     *   in three timezones, and one pair of instants cannot be "March" for all
     *   of them — see `resolveWindow`. `local_day` is what every comparison
     *   below runs against.
     */
    const scoped = Prisma.sql`
      SELECT l.branch_id,
             l.product_id,
             l.quantity_base,
             l.movement_type,
             (l.occurred_at AT TIME ZONE b.timezone)::date AS local_day,
             ${CHANGES_HOLDING}                            AS changes_holding
        FROM stock_ledger l
        JOIN branches b ON b.id = l.branch_id AND b.deleted_at IS NULL
       WHERE l.organization_id = ${ctx.organizationId}::uuid
         AND l.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
    `;

    const base = Prisma.sql`
      FROM (
        SELECT e.branch_id,
               e.product_id,
               SUM(e.quantity_base) FILTER (WHERE e.changes_holding AND e.local_day <  ${window.from}::date)                     AS opening_base,
               SUM(e.quantity_base) FILTER (WHERE e.changes_holding AND e.quantity_base > 0 AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS received_base,
               -SUM(e.quantity_base) FILTER (WHERE e.changes_holding AND e.quantity_base < 0 AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS issued_base,
               -SUM(e.quantity_base) FILTER (WHERE e.movement_type = 'DISPENSING'           AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS dispensed_base,
               -SUM(e.quantity_base) FILTER (WHERE e.movement_type = 'CLINICAL_CONSUMPTION' AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS consumed_base,
               -SUM(e.quantity_base) FILTER (WHERE e.movement_type = 'TRANSFER_OUT'         AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS transferred_out_base,
               -SUM(e.quantity_base) FILTER (WHERE e.movement_type = 'DISPOSAL'             AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS disposed_base,
               SUM(e.quantity_base)  FILTER (WHERE e.movement_type = 'ADJUSTMENT'           AND e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) AS adjusted_base,
               COUNT(*) FILTER (WHERE e.local_day BETWEEN ${window.from}::date AND ${window.to}::date)::int AS movement_count
          FROM (${scoped}) e
         GROUP BY e.branch_id, e.product_id
        HAVING COUNT(*) FILTER (WHERE e.local_day BETWEEN ${window.from}::date AND ${window.to}::date) > 0
      ) src
      JOIN products         p ON p.id = src.product_id
      JOIN units_of_measure u ON u.id = p.base_unit_id
      JOIN branches         b ON b.id = src.branch_id AND b.deleted_at IS NULL
     WHERE ${query.productId ? Prisma.sql`p.id = ${query.productId}::uuid` : Prisma.sql`TRUE`}
       AND ${query.categoryId ? Prisma.sql`p.category_id = ${query.categoryId}::uuid` : Prisma.sql`TRUE`}
    `;

    /*
     * ⚠️ `closing = opening + received − issued` IS COMPUTED HERE AND ASSERTED IN
     *   THE TEST SUITE. The day it stops holding is the day one of PI-2's
     *   movement types acquired a shape nobody told this file about — which is
     *   precisely the failure that would otherwise show up as a valuation being
     *   quietly wrong rather than as anything raising.
     */
    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name   AS branch_name,
             src.product_id,
             p.name   AS product_name,
             p.code   AS product_code,
             u.symbol AS base_unit_symbol,
             COALESCE(src.opening_base, 0)::text          AS opening_base,
             COALESCE(src.received_base, 0)::text         AS received_base,
             COALESCE(src.issued_base, 0)::text           AS issued_base,
             COALESCE(src.dispensed_base, 0)::text        AS dispensed_base,
             COALESCE(src.consumed_base, 0)::text         AS consumed_base,
             COALESCE(src.transferred_out_base, 0)::text  AS transferred_out_base,
             COALESCE(src.disposed_base, 0)::text         AS disposed_base,
             COALESCE(src.adjusted_base, 0)::text         AS adjusted_base,
             src.movement_count
      ${base}
    `;

    const order = {
      net: Prisma.sql`(COALESCE(r.received_base::numeric, 0) - COALESCE(r.issued_base::numeric, 0))`,
      out: Prisma.sql`r.issued_base::numeric`,
      in: Prisma.sql`r.received_base::numeric`,
      product: Prisma.sql`r.product_name`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total] = await Promise.all([
      tx.$queryRaw<MovementSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.product_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
    ]);

    const shaped: MovementRow[] = rows.map((row) => {
      const opening = new Prisma.Decimal(row.opening_base);
      const received = new Prisma.Decimal(row.received_base);
      const issued = new Prisma.Decimal(row.issued_base);
      return {
        branchId: row.branch_id,
        branchName: row.branch_name,
        productId: row.product_id,
        productName: row.product_name,
        productCode: row.product_code,
        baseUnitSymbol: row.base_unit_symbol,
        openingBase: opening.toString(),
        receivedBase: received.toString(),
        issuedBase: issued.toString(),
        dispensedBase: qty(row.dispensed_base),
        consumedBase: qty(row.consumed_base),
        transferredOutBase: qty(row.transferred_out_base),
        disposedBase: qty(row.disposed_base),
        adjustedBase: qty(row.adjusted_base),
        closingBase: opening.plus(received).minus(issued).toString(),
        movementCount: count(row.movement_count),
      };
    });

    return {
      ...envelope({
        reportKey: 'inventory-movement',
        branchIds,
        window,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      rows: shaped,
    };
  });
}

// ===========================================================================
// 4 — Dead stock
// ===========================================================================

interface DeadStockSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  quantity_base: string;
  last_issued_at: Date | null;
  last_received_at: Date | null;
  first_seen_at: Date;
  idle_days: number;
  issued_last_year: string;
  unit_cost_minor: string | null;
  currency: string | null;
  value_minor: string | null;
  earliest_expires_on: Date | null;
}

export async function getDeadStockReport(
  ctx: TenantContext,
  query: DeadStockQuery,
  _options: ReportOptions = {}
): Promise<DeadStockReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ "NO OUTBOUND MOVEMENT", NOT "NO MOVEMENT". A lot quarantined on Monday
     *   and released on Friday has two ledger rows and has gone nowhere;
     *   counting either as activity would hide the slowest stock in the building
     *   behind the housekeeping performed on it. `last_issued_at` therefore
     *   looks at negative, holding-changing legs alone.
     */
    const activity = Prisma.sql`
      SELECT l.branch_id,
             l.product_id,
             MAX(l.occurred_at) FILTER (WHERE ${CHANGES_HOLDING} AND l.quantity_base < 0) AS last_issued_at,
             MAX(l.occurred_at) FILTER (WHERE ${CHANGES_HOLDING} AND l.quantity_base > 0) AS last_received_at,
             MIN(l.occurred_at)                                                           AS first_seen_at,
             COALESCE(-SUM(l.quantity_base) FILTER (
               WHERE ${CHANGES_HOLDING} AND l.quantity_base < 0
                 AND l.occurred_at >= now() - interval '365 days'
             ), 0)                                                                        AS issued_last_year
        FROM stock_ledger l
       WHERE l.organization_id = ${ctx.organizationId}::uuid
         AND l.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
       GROUP BY l.branch_id, l.product_id
    `;

    const onHand = Prisma.sql`
      SELECT sb.branch_id,
             sb.product_id,
             SUM(sb.quantity) AS quantity_base,
             MIN(bx.expires_on) AS earliest_expires_on
        FROM stock_balances sb
        LEFT JOIN batches bx ON bx.id = sb.batch_id
       WHERE sb.organization_id = ${ctx.organizationId}::uuid
         AND sb.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
         AND sb.quantity > 0
         AND sb.status::text IN (${Prisma.join([...SELLABLE_STATUSES])})
       GROUP BY sb.branch_id, sb.product_id
    `;

    /*
     * ⚠️ THE COST LOOKUP HANGS OFF A ROW WITH NO LOT, WHICH IS WHY `bt` IS A
     *   LATERAL PICK OF THE OLDEST LOT STILL IN HAND RATHER THAN A JOIN. Dead
     *   stock is product-grained by definition — "nothing has asked for this
     *   product in six months" — and the lot whose cost best represents what is
     *   sitting there is the one that has been sitting there longest.
     */
    const base = Prisma.sql`
      FROM (
        SELECT oh.branch_id,
               oh.product_id,
               oh.quantity_base,
               oh.earliest_expires_on,
               act.last_issued_at,
               act.last_received_at,
               COALESCE(act.first_seen_at, now()) AS first_seen_at,
               act.issued_last_year
          FROM (${onHand}) oh
          LEFT JOIN (${activity}) act
                 ON act.branch_id = oh.branch_id AND act.product_id = oh.product_id
      ) src
      JOIN products         p ON p.id = src.product_id
      JOIN units_of_measure u ON u.id = p.base_unit_id
      JOIN branches         b ON b.id = src.branch_id AND b.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT bl.unit_cost_base, bl.currency
          FROM batches bl
          JOIN stock_balances sbl
            ON sbl.batch_id = bl.id
           AND sbl.organization_id = ${ctx.organizationId}::uuid
           AND sbl.quantity > 0
         WHERE bl.organization_id = ${ctx.organizationId}::uuid
           AND bl.branch_id  = src.branch_id
           AND bl.product_id = src.product_id
         ORDER BY bl.received_at ASC
         LIMIT 1
      ) bt ON TRUE
      ${costJoins(ctx.organizationId)}
     WHERE ${query.categoryId ? Prisma.sql`p.category_id = ${query.categoryId}::uuid` : Prisma.sql`TRUE`}
       AND (now() AT TIME ZONE b.timezone)::date
             - (COALESCE(src.last_issued_at, src.first_seen_at) AT TIME ZONE b.timezone)::date
             >= ${query.idleDays}
    `;

    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name   AS branch_name,
             src.product_id,
             p.name   AS product_name,
             p.code   AS product_code,
             u.symbol AS base_unit_symbol,
             src.quantity_base::text                     AS quantity_base,
             src.last_issued_at,
             src.last_received_at,
             src.first_seen_at,
             ((now() AT TIME ZONE b.timezone)::date
               - (COALESCE(src.last_issued_at, src.first_seen_at) AT TIME ZONE b.timezone)::date)::int
                                                         AS idle_days,
             COALESCE(src.issued_last_year, 0)::text     AS issued_last_year,
             src.earliest_expires_on,
             ${costColumns(query.basis)},
             round(src.quantity_base * COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor))::text
                                                         AS value_minor
      ${base}
    `;

    /* Aliased `f`, because this report orders the FILTERED set rather than the
       projection — see `minValueMinor` immediately below. */
    const order = {
      value: Prisma.sql`f.value_minor::numeric`,
      idleDays: Prisma.sql`f.idle_days`,
      quantity: Prisma.sql`f.quantity_base::numeric`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    /*
     * ⚠️ `minValueMinor` IS APPLIED OUTSIDE THE PROJECTION, NOT IN ITS WHERE
     *   CLAUSE, because the value does not exist until the cost chain has run. A
     *   row whose cost could not be resolved has a NULL value and is KEPT: "we
     *   cannot tell you what this idle stock is worth" is the row a clinic most
     *   needs to see, and a `>= 0` filter would drop exactly those.
     */
    const filtered = Prisma.sql`
      SELECT r.* FROM (${projection}) r
       WHERE r.value_minor IS NULL OR r.value_minor::numeric >= ${query.minValueMinor}
    `;

    const [rows, total, totalsRows] = await Promise.all([
      tx.$queryRaw<DeadStockSqlRow[]>(
        Prisma.sql`
          SELECT f.* FROM (${filtered}) f
           ORDER BY ${order} ${direction(query.sortOrder)}, f.product_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total FROM (${filtered}) f`),
      tx.$queryRaw<
        { currency: string | null; value_minor: string | null; quantity_base: string }[]
      >(Prisma.sql`SELECT f.currency, f.value_minor, f.quantity_base FROM (${filtered}) f`),
    ]);

    const shaped: DeadStockRow[] = rows.map((row) => {
      const issuedLastYear = new Prisma.Decimal(row.issued_last_year);
      const onHandQty = new Prisma.Decimal(row.quantity_base);
      return {
        branchId: row.branch_id,
        branchName: row.branch_name,
        productId: row.product_id,
        productName: row.product_name,
        productCode: row.product_code,
        baseUnitSymbol: row.base_unit_symbol,
        quantityBase: qty(row.quantity_base),
        lastIssuedAt: row.last_issued_at ? row.last_issued_at.toISOString() : null,
        lastReceivedAt: row.last_received_at ? row.last_received_at.toISOString() : null,
        idleDays: count(row.idle_days),
        /*
         * ⚠️ NULL WHEN NOTHING WENT OUT ALL YEAR, NEVER INFINITY AND NEVER A
         *   VERY LARGE NUMBER. "Twelve thousand days of cover" is arithmetic
         *   pretending to be an answer; the honest answer is that there is no
         *   rate to divide by, and the `idleDays` column beside it already says
         *   so in the units a person thinks in.
         */
        daysOfCover: issuedLastYear.isZero()
          ? null
          : Math.round(onHandQty.div(issuedLastYear.div(365)).toNumber()),
        unitCostMinor: minor(row.unit_cost_minor),
        currency: row.currency,
        valueMinor: minor(row.value_minor),
        earliestExpiresOn: row.earliest_expires_on
          ? row.earliest_expires_on.toISOString().slice(0, 10)
          : null,
      };
    });

    return {
      ...envelope({
        reportKey: 'dead-stock',
        branchIds,
        window: null,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      basis: query.basis,
      idleDays: query.idleDays,
      rows: shaped,
      totals: foldTotals(
        totalsRows.map((row) => ({
          currency: row.currency,
          valueMinor: minor(row.value_minor),
          quantityBase: qty(row.quantity_base),
        }))
      ),
    };
  });
}

// ===========================================================================
// 5 — Quarantine & recall exposure
// ===========================================================================

interface QuarantineSqlRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  product_code: string | null;
  base_unit_symbol: string;
  hold: 'QUARANTINED' | 'RECALLED' | 'BLOCKED' | 'DAMAGED' | 'EXPIRED';
  batch_id: string | null;
  lot_number: string | null;
  expires_on: Date | null;
  quantity_base: string;
  held_since: Date | null;
  reason: string | null;
  unit_cost_minor: string | null;
  currency: string | null;
  value_minor: string | null;
}

export async function getQuarantineReport(
  ctx: TenantContext,
  query: QuarantineQuery,
  _options: ReportOptions = {}
): Promise<QuarantineReport> {
  const branchIds = resolveReportBranches(ctx, query.branchId);
  const holds = query.hold ? [query.hold] : [...HELD_STATUSES];

  return withTenant(ctx, async (tx) => {
    const base = Prisma.sql`
      FROM (
        SELECT sb.branch_id,
               sb.product_id,
               sb.batch_id,
               sb.status::text  AS hold,
               SUM(sb.quantity) AS quantity_base
          FROM stock_balances sb
         WHERE sb.organization_id = ${ctx.organizationId}::uuid
           AND sb.branch_id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
           AND sb.quantity > 0
           AND sb.status::text IN (${Prisma.join(holds)})
         GROUP BY sb.branch_id, sb.product_id, sb.batch_id, sb.status
      ) src
      JOIN products         p  ON p.id  = src.product_id
      JOIN units_of_measure u  ON u.id  = p.base_unit_id
      JOIN branches         b  ON b.id  = src.branch_id AND b.deleted_at IS NULL
      LEFT JOIN batches     bt ON bt.id = src.batch_id
      ${costJoins(ctx.organizationId)}
     WHERE ${query.productId ? Prisma.sql`p.id = ${query.productId}::uuid` : Prisma.sql`TRUE`}
    `;

    /*
     * ⚠️ `held_since` COMES FROM THE LOT'S OWN COLUMNS AND IS NULL WHERE THERE IS
     *   NONE — see the contract. Only quarantine and recall stamp the batch;
     *   `DAMAGED` and `EXPIRED` quantities were put in their buckets by a
     *   movement, and answering "since when" for those means a per-row ledger
     *   walk over every held lot in the clinic. That is the query that takes the
     *   screen down, and the honest NULL is cheaper than the dishonest guess.
     */
    const projection = Prisma.sql`
      SELECT src.branch_id,
             b.name   AS branch_name,
             src.product_id,
             p.name   AS product_name,
             p.code   AS product_code,
             u.symbol AS base_unit_symbol,
             src.hold,
             src.batch_id,
             bt.lot_number,
             bt.expires_on,
             src.quantity_base::text AS quantity_base,
             CASE src.hold
               WHEN 'RECALLED'    THEN bt.recalled_at
               WHEN 'QUARANTINED' THEN bt.quarantined_at
             END AS held_since,
             CASE src.hold
               WHEN 'RECALLED'    THEN bt.recall_reference
               WHEN 'QUARANTINED' THEN bt.quarantine_reason
             END AS reason,
             ${costColumns(query.basis)},
             round(src.quantity_base * COALESCE(bt.unit_cost_base, ac.unit_cost_minor, ad.unit_cost_minor))::text
                                     AS value_minor
      ${base}
    `;

    const order = {
      value: Prisma.sql`r.value_minor::numeric`,
      quantity: Prisma.sql`r.quantity_base::numeric`,
      heldSince: Prisma.sql`r.held_since`,
    }[query.sortBy];

    const { take, skip } = windowFor(query.format, query.page, query.limit);

    const [rows, total, totalsRows] = await Promise.all([
      tx.$queryRaw<QuarantineSqlRow[]>(
        Prisma.sql`
          SELECT r.* FROM (${projection}) r
           ORDER BY ${order} ${direction(query.sortOrder)}, r.product_name
           LIMIT ${take} OFFSET ${skip}
        `
      ),
      countRows(tx, Prisma.sql`SELECT COUNT(*)::int AS total ${base}`),
      tx.$queryRaw<
        { currency: string | null; value_minor: string | null; quantity_base: string }[]
      >(Prisma.sql`SELECT r.currency, r.value_minor, r.quantity_base FROM (${projection}) r`),
    ]);

    const shaped: QuarantineRow[] = rows.map((row) => ({
      branchId: row.branch_id,
      branchName: row.branch_name,
      productId: row.product_id,
      productName: row.product_name,
      productCode: row.product_code,
      baseUnitSymbol: row.base_unit_symbol,
      hold: row.hold,
      batchId: row.batch_id,
      lotNumber: row.lot_number,
      expiresOn: row.expires_on ? row.expires_on.toISOString().slice(0, 10) : null,
      quantityBase: qty(row.quantity_base),
      heldSince: row.held_since ? row.held_since.toISOString() : null,
      reason: row.reason,
      unitCostMinor: minor(row.unit_cost_minor),
      currency: row.currency,
      valueMinor: minor(row.value_minor),
    }));

    return {
      ...envelope({
        reportKey: 'quarantine-exposure',
        branchIds,
        window: null,
        page: query.page,
        limit: query.limit,
        total,
        format: query.format,
        rowsReturned: rows.length,
      }),
      basis: query.basis,
      rows: shaped,
      totals: foldTotals(
        totalsRows.map((row) => ({
          currency: row.currency,
          valueMinor: minor(row.value_minor),
          quantityBase: qty(row.quantity_base),
        }))
      ),
    };
  });
}
