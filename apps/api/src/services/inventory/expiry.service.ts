/**
 * Expiry: the near-expiry report, and the sweep that acts on the date itself.
 *
 * ── THE TWO ARE NOT THE SAME OPERATION, AND CONFLATING THEM IS THE BUG ──────
 * NEAR-EXPIRY PRODUCES AN ALERT AND NEVER A STATUS CHANGE. A lot expiring in
 * thirty days is perfectly dispensable and often should be dispensed first —
 * that is the entire point of FEFO. Quarantining it early would strand usable
 * stock and teach everyone to ignore the warning.
 *
 * THE SWEEP MOVES `AVAILABLE` -> `EXPIRED` ON THE DAY, and does it through
 * `recordMovement` like everything else. There is no status change without a
 * ledger row (PI-ADR-004).
 *
 * ── INVARIANT 6, AND THIS IS WHERE IT ACTUALLY BITES ────────────────────────
 * ⚠️ "TODAY" IS THE BRANCH'S TODAY, NOT UTC'S AND NOT THE CONTAINER'S. A lot
 *   expiring on the 31st is good until the end of the 31st AT THE CLINIC. The
 *   API and the worker both run in UTC containers, so a sweep that compared
 *   `expires_on <= CURRENT_DATE` would expire an Auckland clinic's stock thirteen
 *   hours early and a Los Angeles clinic's eight hours late — silently, and only
 *   for part of each day, which is the hardest kind of defect to be told about.
 *
 *   So the day is resolved IN SQL as `(now() AT TIME ZONE b.timezone)::date`,
 *   exactly as `availability.service.ts` already does for appointment slots. A
 *   `Date` composed in JavaScript would carry the container's zone into the
 *   comparison at whichever step nobody looked at.
 *
 * ── THRESHOLDS ARE SETTINGS, NOT CONSTANTS (PI-ADR-015) ─────────────────────
 * `inventory.expiry_alert_days` already exists in the setting catalogue as a
 * JSON array — `[90, 60, 30, 7]` by default — and resolves through
 * USER -> DOCTOR -> BRANCH -> ORGANIZATION -> PLATFORM. A vaccine fridge and a
 * dental store legitimately want different windows. There is no
 * `const NEAR_EXPIRY_DAYS` anywhere in this file.
 *
 * ⚠️ `setting_values` IS RLS-EXEMPT, so the `(scopeType, scopeId)` pairs passed
 *   to the resolver ARE the tenant isolation. Every scope id below comes from
 *   `TenantContext` or from a row already read under RLS — never from a request.
 *
 * NO PHI.
 */
import { type Prisma, withTenant, type TenantContext } from '@rcln/db';
import type { ExpiryReportQuery, ExpiryReportResponse } from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { sweepExpiredStock as sweepEngine, type SweepResult } from '@rcln/inventory';
import { resolveSettings } from '../settings/resolver.service.js';
import { movementDeps } from './movement.service.js';

/*
 * ⚠️ THE SWEEP ITSELF LIVES IN `@rcln/inventory`, NOT HERE, AND IS RE-EXPORTED
 *   AT THE BOTTOM OF THIS FILE. It writes ledger rows, and the worker is what
 *   actually runs it — see the package header. What stays in this file is the
 *   REPORT, which is a read, resolves a SETTING, and is only ever asked for by a
 *   screen.
 */

const ALERT_DAYS_KEY = 'inventory.expiry_alert_days';

/** The default the setting definition carries. Duplicated nowhere else. */
const FALLBACK_ALERT_DAYS = [90, 60, 30, 7];

function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

/**
 * The widest configured warning window, in days.
 *
 * ⚠️ THE MAXIMUM OF THE ARRAY, NOT ITS FIRST ELEMENT. `[90, 60, 30, 7]` is the
 *   set of moments a clinic wants warning AT, and the report shows everything
 *   inside the earliest of them. Reading `[0]` would work for the default and
 *   silently show a seven-day window to a clinic that wrote `[7, 30, 60, 90]`.
 */
function widestWindow(value: unknown): number {
  const days = Array.isArray(value)
    ? value.filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
    : [];
  const source = days.length > 0 ? days : FALLBACK_ALERT_DAYS;
  return Math.max(...source);
}

interface ExpiryRow {
  batch_id: string;
  branch_id: string;
  product_id: string;
  product_name: string;
  lot_number: string;
  expires_on: Date;
  days_remaining: number;
  quantity_available: Prisma.Decimal;
  base_unit_symbol: string;
  status: string;
}

/**
 * What is expiring, and what has.
 *
 * ⚠️ THE WHOLE QUERY IS ONE STATEMENT BECAUSE THE DAY ARITHMETIC HAS TO HAPPEN
 *   BESIDE `branches.timezone`. Fetching the lots and computing `daysRemaining`
 *   in TypeScript would need the branch's zone in memory per row and would put
 *   the container's zone one careless `new Date()` away from the answer.
 */
export async function expiryReport(
  ctx: TenantContext,
  query: ExpiryReportQuery
): Promise<ExpiryReportResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    let windowDays = query.withinDays;

    if (windowDays === undefined) {
      const resolved = await resolveSettings(tx, [ALERT_DAYS_KEY], {
        organizationId: ctx.organizationId,
        // Only when the caller narrowed to one branch. Passing an arbitrary
        // branch id would resolve another site's configuration.
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
        userId: ctx.userId,
      });
      windowDays = widestWindow(resolved.get(ALERT_DAYS_KEY));
    }

    const branchId = query.branchId ?? null;

    const rows = await tx.$queryRaw<ExpiryRow[]>`
      SELECT bt."id"                                   AS batch_id,
             bt."branch_id",
             bt."product_id",
             p."name"                                  AS product_name,
             bt."lot_number",
             bt."expires_on",
             (bt."expires_on" - (now() AT TIME ZONE b."timezone")::date)::int
                                                       AS days_remaining,
             COALESCE(sb.quantity, 0)                  AS quantity_available,
             u."symbol"                                AS base_unit_symbol,
             bt."status"::text                         AS status
        FROM "batches" bt
        JOIN "branches"          b ON b."id" = bt."branch_id"
        JOIN "products"          p ON p."id" = bt."product_id"
        JOIN "units_of_measure"  u ON u."id" = p."base_unit_id"
        LEFT JOIN LATERAL (
          SELECT sum(x."quantity") AS quantity
            FROM "stock_balances" x
           WHERE x."batch_id" = bt."id"
             AND x."status"   = 'AVAILABLE'
        ) sb ON true
       WHERE bt."expires_on" IS NOT NULL
         AND (${branchId}::uuid IS NULL OR bt."branch_id" = ${branchId}::uuid)
         AND bt."expires_on" <= (now() AT TIME ZONE b."timezone")::date
                                + make_interval(days => ${windowDays}::int)
         AND (${query.includeExpired}::boolean
              OR bt."expires_on" >= (now() AT TIME ZONE b."timezone")::date)
         AND COALESCE(sb.quantity, 0) > 0
       ORDER BY bt."expires_on" ASC
       LIMIT ${query.limit}
    `;

    return {
      windowDays,
      rows: rows.map((r) => ({
        batchId: r.batch_id,
        branchId: r.branch_id,
        productId: r.product_id,
        productName: r.product_name,
        lotNumber: r.lot_number,
        expiresOn: r.expires_on.toISOString().slice(0, 10),
        daysRemaining: r.days_remaining,
        quantityAvailable: r.quantity_available.toString(),
        baseUnitSymbol: r.base_unit_symbol,
        status: r.status as ExpiryReportResponse['rows'][number]['status'],
      })),
    };
  });
}

/**
 * Move everything that has expired at ONE branch into the `EXPIRED` bucket.
 *
 * ⚠️ THE IMPLEMENTATION IS IN `@rcln/inventory` BECAUSE THE WORKER RUNS IT. It
 *   is called from here so an operator-triggered sweep and the worker's hourly
 *   one are literally the same code, injected with the same audit hook. See
 *   `movement.service.ts` for why the dependencies are injected rather than
 *   imported.
 *
 * ⚠️ `withTenant` IS PASSED IN AS THE UNIT OF WORK, AND THE ENGINE CALLS IT ONCE
 *   PER BUCKET. It does NOT wrap the whole sweep: an advisory lock is held to
 *   COMMIT, so one transaction covering every expired bucket accumulates locks
 *   in expiry order and can deadlock against a concurrent status transition —
 *   taking the whole branch's sweep down with it. See the package's header.
 */
export async function sweepExpiredStock(
  ctx: TenantContext,
  branchId: string
): Promise<SweepResult> {
  assertBranchInScope(ctx, branchId);
  return sweepEngine(ctx, movementDeps, withTenant, branchId);
}
