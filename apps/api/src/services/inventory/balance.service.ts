/**
 * Reading stock: the balance cache, the ledger, and the verifier that checks one
 * against the other.
 *
 * ⚠️ NOTHING HERE WRITES ANYTHING. `stock_balances` is maintained by a trigger
 *   and `rcln_app` holds no INSERT, UPDATE or DELETE on it; `stock_ledger` is
 *   append-only and is written only by `recordMovement`. This file is the read
 *   half of PI-ADR-004 and it stays that way.
 *
 * ── THE LESSON PI-1 PAID FOR ────────────────────────────────────────────────
 * All three of PI-1's worst bugs were in the QUERY layer, and every one of them
 * returned a PLAUSIBLE ROW rather than failing — a dropped jurisdiction filter, a
 * NULLS-FIRST sort that made every regional override inert. An assertion that "a
 * row came back" passed on all three. So every filter below is written out
 * rather than composed by spreading, every sort states its NULL behaviour, and
 * `stock-ledger.test.ts` plants a decoy for each.
 *
 * NO PHI. Serial numbers appear; the patient a serial is fitted to does not —
 * that column is read only through serial.service.ts, which logs it.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  StockBalanceListResponse,
  StockBalanceQuery,
  StockBalanceRow,
  StockLedgerListResponse,
  StockLedgerQuery,
  StockLedgerRow,
  VerifyBalancesResponse,
} from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';

function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

const balanceInclude = Prisma.validator<Prisma.StockBalanceInclude>()({
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  location: { select: { name: true } },
  batch: { select: { lotNumber: true, expiresOn: true } },
  serial: { select: { serialNumber: true } },
});

const ledgerInclude = Prisma.validator<Prisma.StockLedgerEntryInclude>()({
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  batch: { select: { lotNumber: true } },
  serial: { select: { serialNumber: true } },
  unit: { select: { symbol: true } },
  fromLocation: { select: { name: true } },
  toLocation: { select: { name: true } },
  actor: { select: { fullName: true } },
});

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export async function listBalances(
  ctx: TenantContext,
  query: StockBalanceQuery
): Promise<StockBalanceListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.StockBalanceWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      /*
       * A fully-issued bucket leaves a zero row behind rather than being
       * deleted, because the trigger only ever adds — and a zero row is a fact
       * ("we used to hold this here") that a stock screen should not show by
       * default and a valuation report may want.
       */
      ...(query.hideEmpty ? { quantity: { gt: 0 } } : {}),
    };

    const [total, rows] = await Promise.all([
      tx.stockBalance.count({ where }),
      tx.stockBalance.findMany({
        where,
        include: balanceInclude,
        /*
         * ⚠️ `id` LAST, AND WITHOUT IT PAGINATION SKIPS AND REPEATS ROWS. A
         *   product with twelve lots on one shelf in one status is twelve rows
         *   whose (product, location, status) key is identical, so Postgres may
         *   order them differently between the page-1 and page-2 queries — and a
         *   storekeeper paging through genuinely misses some. A total order is
         *   what makes offset pagination mean anything.
         */
        orderBy: [{ productId: 'asc' }, { locationId: 'asc' }, { status: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      balances: rows.map((r): StockBalanceRow => ({
        productId: r.productId,
        productCode: r.product.code,
        productName: r.product.name,
        baseUnitSymbol: r.product.baseUnit.symbol,
        branchId: r.branchId,
        locationId: r.locationId,
        locationName: r.location.name,
        batchId: r.batchId,
        lotNumber: r.batch?.lotNumber ?? null,
        expiresOn: r.batch?.expiresOn?.toISOString().slice(0, 10) ?? null,
        serialId: r.serialId,
        serialNumber: r.serial?.serialNumber ?? null,
        status: r.status,
        quantity: r.quantity.toString(),
      })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export async function listLedger(
  ctx: TenantContext,
  query: StockLedgerQuery
): Promise<StockLedgerListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ `from` AND `to` ARE CALENDAR DAYS AND `occurred_at` IS AN INSTANT, so
     *   `to` is made EXCLUSIVE OF THE NEXT DAY rather than compared directly.
     *   `occurredAt <= '2026-08-15'` means "at or before midnight on the 15th",
     *   which silently drops everything that happened during the 15th — a
     *   whole-day-off filter that looks right and returns almost the right rows.
     *   `invoices.test.ts` shipped the same shape of bug and failed only between
     *   18:30 and midnight UTC.
     *
     *   The days are taken in UTC here, deliberately: a ledger filter is a
     *   reporting range over history rather than something a person experiences
     *   at a wall clock. Where the branch's zone genuinely decides the answer —
     *   has this lot expired TODAY — the expiry sweep resolves it there.
     */
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.from !== undefined) occurredAt.gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to !== undefined) {
      occurredAt.lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000);
    }

    const where: Prisma.StockLedgerEntryWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.serialId !== undefined ? { serialId: query.serialId } : {}),
      ...(query.movementType !== undefined ? { movementType: query.movementType } : {}),
      ...(query.referenceType !== undefined ? { referenceType: query.referenceType } : {}),
      ...(query.referenceId !== undefined ? { referenceId: query.referenceId } : {}),
      /*
       * ⚠️ A LOCATION FILTER MUST LOOK AT BOTH ENDS. A movement OUT of a shelf
       *   names it in `from_location_id` and one IN names it in
       *   `to_location_id`; filtering on either alone shows half the history of
       *   that shelf and looks complete.
       */
      ...(query.locationId !== undefined
        ? {
            OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }],
          }
        : {}),
      ...(Object.keys(occurredAt).length > 0 ? { occurredAt } : {}),
    };

    const [total, rows] = await Promise.all([
      tx.stockLedgerEntry.count({ where }),
      tx.stockLedgerEntry.findMany({
        where,
        include: ledgerInclude,
        /*
         * Newest first, with `recordedAt` breaking ties — two movements at the
         * same backdated instant have a real order and it is the order they were
         * written in.
         *
         * ⚠️ AND `id` UNDER BOTH, BECAUSE NEITHER IS UNIQUE. Both default to
         *   `now()`, which is the TRANSACTION's start time in Postgres — so
         *   every row written by one transaction shares both timestamps exactly.
         *   `setBatchHold` writes one per location in a single transaction, so a
         *   lot at four shelves is four rows with an identical sort key and no
         *   total order for the pager to rely on.
         */
        orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      movements: rows.map((r): StockLedgerRow => ({
        id: r.id,
        branchId: r.branchId,
        occurredAt: r.occurredAt.toISOString(),
        recordedAt: r.recordedAt.toISOString(),
        movementType: r.movementType,
        productId: r.productId,
        productCode: r.product.code,
        productName: r.product.name,
        batchId: r.batchId,
        lotNumber: r.batch?.lotNumber ?? null,
        serialId: r.serialId,
        serialNumber: r.serial?.serialNumber ?? null,
        quantityBase: r.quantityBase.toString(),
        quantityEntered: r.quantityEntered.toString(),
        unitSymbol: r.unit.symbol,
        baseUnitSymbol: r.product.baseUnit.symbol,
        fromLocationId: r.fromLocationId,
        fromLocationName: r.fromLocation?.name ?? null,
        toLocationId: r.toLocationId,
        toLocationName: r.toLocation?.name ?? null,
        statusFrom: r.statusFrom,
        statusTo: r.statusTo,
        reasonCode: r.reasonCode,
        reasonNote: r.reasonNote,
        referenceType: r.referenceType,
        referenceId: r.referenceId,
        actorUserId: r.actorUserId,
        actorName: r.actor.fullName,
        trackingMode: r.trackingMode,
      })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

interface ReplayRow {
  product_id: string;
  batch_id: string | null;
  serial_id: string | null;
  location_id: string;
  status: string;
  replayed: Prisma.Decimal;
  cached: Prisma.Decimal | null;
}

/**
 * Replay the ledger and compare it with the cache.
 *
 * ⚠️ IT REPORTS AND STOPS. It never silently repairs, because a cache that heals
 *   itself hides the bug that broke it — and the bug is in a trigger, which
 *   means it is broken for every clinic on the platform, not for this one row.
 *   PI-ADR-004 rule 4: a disagreement is resolved by the LEDGER, and it is a bug
 *   report, not a maintenance task.
 *
 * ⚠️ THE REPLAY MUST USE THE SAME RULE AS THE TRIGGER, WHICH IS WHY IT IS
 *   WRITTEN OUT IN SQL RATHER THAN IN TYPESCRIPT OVER FETCHED ROWS. Each ledger
 *   row contributes `-|quantity|` to `(from_location, status_from)` and
 *   `+|quantity|` to `(to_location, status_to)`. That is one UNION ALL and a
 *   GROUP BY, and doing it in the database also means the whole ledger never
 *   comes into memory — which it would not fit into at the clinics where this
 *   check matters.
 *
 * A FULL OUTER JOIN, not a left one: a bucket the cache holds and the ledger
 * never produced is exactly as much of a defect as the other way round, and it
 * is the direction a left join silently reports as clean.
 *
 * Parameterised throughout; RLS applies to both sides, so the answer is scoped
 * to this tenant and this caller's branches without a predicate of its own.
 */
export async function verifyBalances(
  ctx: TenantContext,
  scope: { branchId?: string | undefined; productId?: string | undefined } = {}
): Promise<VerifyBalancesResponse> {
  if (scope.branchId !== undefined) assertBranchInScope(ctx, scope.branchId);

  return withTenant(ctx, async (tx) => {
    const branchId = scope.branchId ?? null;
    const productId = scope.productId ?? null;

    const rows = await tx.$queryRaw<ReplayRow[]>`
      WITH effects AS (
        SELECT "product_id", "batch_id", "serial_id",
               "from_location_id" AS location_id, "status_from" AS status,
               -abs("quantity_base") AS delta
          FROM "stock_ledger"
         WHERE "status_from" IS NOT NULL
           AND (${branchId}::uuid  IS NULL OR "branch_id"  = ${branchId}::uuid)
           AND (${productId}::uuid IS NULL OR "product_id" = ${productId}::uuid)
        UNION ALL
        SELECT "product_id", "batch_id", "serial_id",
               "to_location_id" AS location_id, "status_to" AS status,
               abs("quantity_base") AS delta
          FROM "stock_ledger"
         WHERE "status_to" IS NOT NULL
           AND (${branchId}::uuid  IS NULL OR "branch_id"  = ${branchId}::uuid)
           AND (${productId}::uuid IS NULL OR "product_id" = ${productId}::uuid)
      ),
      replayed AS (
        SELECT "product_id", "batch_id", "serial_id", location_id, status,
               sum(delta) AS quantity
          FROM effects
         GROUP BY "product_id", "batch_id", "serial_id", location_id, status
      ),
      cached AS (
        SELECT "product_id", "batch_id", "serial_id", "location_id", "status", "quantity"
          FROM "stock_balances"
         WHERE (${branchId}::uuid  IS NULL OR "branch_id"  = ${branchId}::uuid)
           AND (${productId}::uuid IS NULL OR "product_id" = ${productId}::uuid)
      )
      SELECT COALESCE(r."product_id", c."product_id")   AS product_id,
             COALESCE(r."batch_id",   c."batch_id")     AS batch_id,
             COALESCE(r."serial_id",  c."serial_id")    AS serial_id,
             COALESCE(r.location_id,  c."location_id")  AS location_id,
             COALESCE(r.status,       c."status")       AS status,
             COALESCE(r.quantity, 0)                    AS replayed,
             c."quantity"                               AS cached
        FROM replayed r
        FULL OUTER JOIN cached c
          ON  r."product_id" = c."product_id"
         AND  r."batch_id"  IS NOT DISTINCT FROM c."batch_id"
         AND  r."serial_id" IS NOT DISTINCT FROM c."serial_id"
         AND  r.location_id  = c."location_id"
         AND  r.status       = c."status"
    `;

    const discrepancies = rows
      .filter((r) => (r.cached?.toString() ?? null) !== r.replayed.toString())
      /*
       * ⚠️ COMPARED AS DECIMALS, NOT AS STRINGS, ON THE SECOND PASS. `0` and
       *   `0.000000` are the same quantity and different strings, and the raw
       *   query returns the sum at whatever scale Postgres chose. The string
       *   test above is a cheap pre-filter; this is the one that decides.
       */
      .filter((r) => !(r.cached ?? new Prisma.Decimal(0)).equals(r.replayed))
      .map((r) => ({
        productId: r.product_id,
        batchId: r.batch_id,
        serialId: r.serial_id,
        locationId: r.location_id,
        status: r.status as VerifyBalancesResponse['discrepancies'][number]['status'],
        /*
         * ⚠️ `null`, NOT `'0'`, WHEN THE CACHE HAS NO ROW AT ALL. "The bucket is
         *   missing" and "the bucket exists and holds zero" are different
         *   defects with different causes — a trigger that never fired against
         *   one that fired with the wrong sign — and collapsing them into `'0'`
         *   hides which one happened from the person reading the report.
         */
        cached: r.cached === null ? null : r.cached.toString(),
        replayed: r.replayed.toString(),
      }));

    return {
      checkedAt: new Date().toISOString(),
      bucketsChecked: rows.length,
      discrepancies,
    };
  });
}

/** Exported for the worker and the tests, which already hold a transaction. */
export type { TxClient };
