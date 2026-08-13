/**
 * The moving average cost of what a branch holds (PI-4.8).
 *
 * ── WHAT THIS TABLE IS, AND WHAT IT IS NOT ──────────────────────────────────
 * ⚠️ `product_cost_averages` HOLDS A QUANTITY AND IS NOT A SOURCE OF QUANTITY
 *   TRUTH. `valued_quantity_base` is the DENOMINATOR OF AN AVERAGE — the quantity
 *   the running value was accumulated over — and it is not what the branch holds.
 *   `stock_balances` is what the branch holds (PI-ADR-004), and the two
 *   legitimately differ the moment anything is dispensed, expired, transferred or
 *   adjusted. A report that sums this column as stock is wrong.
 *
 * ── THE ARITHMETIC IS IN THE PACKAGE, ON PURPOSE ────────────────────────────
 * `@rcln/inventory`'s `costing.ts` owns every calculation; this file owns the
 * TRANSACTION. Costing arithmetic is wrong in a way no integration test notices —
 * a receipt that posts, lands stock on the right shelf and is one paisa out looks
 * correct from every angle a route test can see, and shows up a year later as a
 * valuation that does not reconcile. Same reasoning as PI-3's FEFO ordering, which
 * was immediately vindicated by its unit suite.
 *
 * ── IT IS REBUILDABLE, AND NOTHING DEPENDS ON IT BEING PRESENT ──────────────
 * Every input is on `goods_receipt_lines`, so a row lost or never written can be
 * recomputed. That is deliberate: a cache that the receipt path could FAIL on
 * would make costing able to block stock from being received, and stock arriving
 * is more important than stock being valued.
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { averageCostBase, removeFromAverage, rollIntoAverage } from '@rcln/inventory';
import type {
  ProductCostAverageListResponse,
  ProductCostAverageQuery,
  ProductCostAverageSummary,
} from '@rcln/contracts';
import { assertBranchInScope, toMinorNumber, toQuantityString } from './shared.js';

/**
 * Roll one received line into the branch's average.
 *
 * ⚠️ IT RUNS ON THE CALLER'S TRANSACTION, so the average and the ledger rows that
 *   justify it commit together. An average that could commit independently of its
 *   receipt is one that will, on the day the receipt rolls back.
 *
 * ⚠️ THE VALUE ADDED IS THE GOODS VALUE **PLUS THE LANDED COST**, and that is the
 *   point of tracking landed cost at all. A vial that cost ₹100 and ₹40 to fly in
 *   cost the clinic ₹140; valuing it at ₹100 makes every margin flatter than it is.
 *   ⚠️ TAX IS DELIBERATELY EXCLUDED: input tax is not a cost of the goods, it is a
 *   liability the clinic may reclaim, and folding it in would inflate every
 *   valuation by the tax rate. (Reclaim itself is out of scope — PI-ADR-006.)
 *
 * ⚠️ `upsert` RATHER THAN READ-THEN-WRITE, AND THE `update` BRANCH ADDS TO THE
 *   COLUMN'S CURRENT VALUE RATHER THAN TO A SNAPSHOT. Two receipts of one product
 *   at one branch commit concurrently; the unique index makes them serialise on the
 *   row, and the second reads the FIRST's committed value under READ COMMITTED. A
 *   read-then-write here would lose one delivery's value entirely — the exact shape
 *   of PI-3's third CRITICAL, in the one place in this phase where nothing would
 *   ever raise.
 */
export async function rollReceiptIntoAverage(
  tx: TxClient,
  ctx: TenantContext,
  input: {
    branchId: string;
    productId: string;
    currency: string;
    quantityBase: string;
    /** Goods value + landed cost, in minor units. Never tax. */
    valueMinor: bigint;
    receivedAt: Date;
  }
): Promise<void> {
  /*
   * ⚠️ THE ROW IS LOCKED BY `SELECT … FOR UPDATE` BEFORE IT IS READ, AND `upsert`
   *   ALONE WOULD NOT BE ENOUGH. Prisma's `upsert` cannot express "add to what is
   *   there" for a Decimal column in one statement — `increment` exists for
   *   numeric columns but the arithmetic here is exact-rational, done in
   *   TypeScript — so the read and the write are two statements and the lock is
   *   what makes them one operation. A row that does not exist yet locks nothing,
   *   which is why the create path relies on the unique index instead: two
   *   concurrent first-receipts, one wins the insert and the other is retried by
   *   the caller's transaction failing on 23505. That is a rare, loud, recoverable
   *   outcome, where losing a delivery's value silently is not.
   */
  const locked = await tx.$queryRaw<
    { valued_quantity_base: Prisma.Decimal; valued_cost_minor: bigint }[]
  >`
    SELECT "valued_quantity_base", "valued_cost_minor"
      FROM "product_cost_averages"
     WHERE "organization_id" = ${ctx.organizationId}::uuid
       AND "branch_id"       = ${input.branchId}::uuid
       AND "product_id"      = ${input.productId}::uuid
       AND "currency"        = ${input.currency}
     FOR UPDATE
  `;

  const current = locked[0];
  const rolled = rollIntoAverage(
    {
      valuedQuantityBase: current === undefined ? '0' : current.valued_quantity_base.toString(),
      valuedCostMinor: current === undefined ? 0n : current.valued_cost_minor,
    },
    { quantityBase: input.quantityBase, valueMinor: input.valueMinor }
  );

  if (current === undefined) {
    await tx.productCostAverage.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        currency: input.currency,
        valuedQuantityBase: rolled.valuedQuantityBase,
        valuedCostMinor: rolled.valuedCostMinor,
        receiptCount: 1,
        lastReceiptAt: input.receivedAt,
      },
    });
    return;
  }

  await tx.productCostAverage.update({
    where: {
      organizationId_branchId_productId_currency: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        currency: input.currency,
      },
    },
    data: {
      valuedQuantityBase: rolled.valuedQuantityBase,
      valuedCostMinor: rolled.valuedCostMinor,
      receiptCount: { increment: 1 },
      lastReceiptAt: input.receivedAt,
    },
  });
}

/**
 * Take returned quantity back out of the pool.
 *
 * ⚠️ IT REMOVES VALUE AT THE **CURRENT AVERAGE**, NOT AT WHAT THAT STOCK COST WHEN
 *   IT ARRIVED, AND THAT IS WHAT A MOVING AVERAGE MEANS. Once two deliveries at two
 *   prices are pooled, "what did THIS box cost" has no answer the pool can give.
 *   `batches.unit_cost_base` still records what each lot actually cost, which is
 *   where that question is answered — this table answers a different one.
 *
 * ⚠️ A MISSING ROW IS A NO-OP RATHER THAN AN ERROR. Stock received before this
 *   phase existed, or a row rebuilt away, must not make a return impossible: the
 *   ledger is authoritative about the quantity and it has already allowed the
 *   movement. Failing here would let a valuation cache block stock from leaving.
 */
export async function removeReturnFromAverage(
  tx: TxClient,
  ctx: TenantContext,
  input: { branchId: string; productId: string; currency: string; quantityBase: string }
): Promise<void> {
  const locked = await tx.$queryRaw<
    { valued_quantity_base: Prisma.Decimal; valued_cost_minor: bigint }[]
  >`
    SELECT "valued_quantity_base", "valued_cost_minor"
      FROM "product_cost_averages"
     WHERE "organization_id" = ${ctx.organizationId}::uuid
       AND "branch_id"       = ${input.branchId}::uuid
       AND "product_id"      = ${input.productId}::uuid
       AND "currency"        = ${input.currency}
     FOR UPDATE
  `;

  const current = locked[0];
  if (current === undefined) return;

  const reduced = removeFromAverage(
    {
      valuedQuantityBase: current.valued_quantity_base.toString(),
      valuedCostMinor: current.valued_cost_minor,
    },
    input.quantityBase
  );

  await tx.productCostAverage.update({
    where: {
      organizationId_branchId_productId_currency: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        currency: input.currency,
      },
    },
    data: {
      valuedQuantityBase: reduced.valuedQuantityBase,
      valuedCostMinor: reduced.valuedCostMinor,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCostAverages(
  ctx: TenantContext,
  query: ProductCostAverageQuery
): Promise<ProductCostAverageListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.ProductCostAverageWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
    };

    const include = Prisma.validator<Prisma.ProductCostAverageInclude>()({
      branch: { select: { name: true } },
      product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
    });

    const [total, rows] = await Promise.all([
      tx.productCostAverage.count({ where }),
      tx.productCostAverage.findMany({
        where,
        include,
        orderBy: [{ product: { name: 'asc' } }, { currency: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    const costAverages: ProductCostAverageSummary[] = rows.map((row) => ({
      productId: row.productId,
      productCode: row.product.code,
      productName: row.product.name,
      baseUnitSymbol: row.product.baseUnit.symbol,
      branchId: row.branchId,
      branchName: row.branch.name,
      currency: row.currency,
      valuedQuantityBase: toQuantityString(row.valuedQuantityBase),
      valuedCostMinor: toMinorNumber(row.valuedCostMinor),
      /*
       * ⚠️ DIVIDED AT READ, NEVER STORED. Storing the average would round at every
       *   receipt and compound: after twenty deliveries it drifts from the
       *   arithmetic by an amount each individual rounding could justify. See the
       *   model comment and `averageCostBase` in the package.
       */
      averageCostBase: averageCostBase(
        row.valuedCostMinor,
        toQuantityString(row.valuedQuantityBase)
      ),
      receiptCount: row.receiptCount,
      lastReceiptAt: row.lastReceiptAt?.toISOString() ?? null,
    }));

    return {
      costAverages,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}
