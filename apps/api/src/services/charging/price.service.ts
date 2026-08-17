/**
 * What a clinic sells a product for (PI-8).
 *
 * ⚠️ A SELLING PRICE IS NOT AN INVENTORY COST, AND NEITHER IS DERIVED FROM THE
 *   OTHER (PI-ADR-010). Nothing in this file reads `product_cost_averages` and
 *   nothing applies a margin. A margin that turned one into the other would make
 *   every purchase price change silently restate the shelf price — a commercial
 *   decision taken by whoever keyed in a delivery.
 *
 * ⚠️ AND IT IS NOT A SECOND FEE SCHEDULE. The precedence rule is deliberately
 *   the same shape as `resolveFee`'s — a scoped override beating an
 *   organization default — and gated by the same permission, because "what this
 *   clinic charges" is one concept whether the thing charged for is a
 *   consultation or a box of tablets. What is NOT shared is the table: a fee is
 *   keyed by (doctor, branch, visit type) and a price by (product, branch,
 *   unit), and forcing both through one row would give every product a
 *   `fee_type` and every consultation a unit.
 *
 * ⚠️ THE UNIT IS PART OF THE PRICE. "₹45" means nothing without "per strip", and
 *   the conversion from the base quantity that left the shelf into the priced
 *   unit happens once, in `charge-request.service.ts`, through the same
 *   conversion graph the ledger uses.
 *
 * NO PHI. A price is a fact about a catalogue row.
 */
import type { Prisma, TenantContext, TxClient } from '@rcln/db';
import { withTenant } from '@rcln/db';
import type {
  ListProductPricesQuery,
  ProductPriceDetail,
  ProductPriceListResponse,
  UpsertProductPriceRequest,
} from '@rcln/contracts';
import { money, type Money } from '@rcln/payments';
import { conversionFactor } from '@rcln/inventory';

import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { organizationCurrency } from '../invoicing/invoice-lifecycle.service.js';
import { toDecimal, toMoney } from '../invoicing/money.js';
import { assertBranchInScope } from '../pharmacy/shared.js';
import { loadUnitGraph } from '../product/unit.service.js';
import { auditMeta, type ChargingActionOptions } from './policy.service.js';

/**
 * Refuse a write to the ORGANIZATION-WIDE row from a branch-scoped caller.
 *
 * ⚠️ RLS CANNOT DO THIS ONE, AND THE REASON IS THE SAME THING THAT MAKES THE
 *   POLICY CORRECT. `branch_isolation` on `product_prices` is
 *   `branch_id IS NULL OR branch_id = ANY(app_branch_scope())`, and the nullable
 *   half is deliberately live: the org default is the row every branch inherits,
 *   so every branch must be able to READ it. But `WITH CHECK` runs the same
 *   predicate, so the policy that correctly lets one site read the default also
 *   lets it overwrite and delete the default — changing what every OTHER branch
 *   bills, from a session scoped to one of them.
 *
 * ⚠️ THERE IS NO `isOrgWide` ON `TenantContext`, SO THE QUESTION IS ANSWERED
 *   FROM THE SCOPE ITSELF. An org-wide grant (`membership_roles.branch_id IS
 *   NULL`) resolves to EVERY branch id in the organization; a branch-scoped one
 *   resolves to a subset. So "does this caller speak for the organization" is
 *   exactly "does their scope cover every branch", which is one count.
 *
 *   Deleted branches are excluded on both sides: a soft-deleted branch is not in
 *   anybody's scope and must not make an org-wide admin look branch-scoped.
 */
async function assertOrganizationWideScope(tx: TxClient, ctx: TenantContext): Promise<void> {
  const branches = await tx.branch.count({
    where: { organizationId: ctx.organizationId, deletedAt: null },
  });
  if (ctx.branchIds.length < branches) {
    throw new ValidationError(
      'A clinic-wide price is the default every branch inherits, so setting or removing it takes clinic-wide access. Set a price for your own branch instead.'
    );
  }
}

export interface ResolvedProductPrice {
  /** What one of `unitId` costs. */
  unitPrice: Money;
  /** The unit the price is PER — not necessarily the product's base unit. */
  unitId: string;
  /** Whether it came from a branch override rather than the org default. */
  fromBranchOverride: boolean;
}

/**
 * The price for one product at one counter, on the caller's transaction.
 *
 * ⚠️ `Within`, FOR THE REASON EVERY OTHER `…Within` IN THIS PROGRAMME IS: a
 *   supply resolves this in the middle of its own posting transaction, and a
 *   second transaction could not see the uncommitted work, would take its own
 *   snapshot, and can deadlock against locks the outer one holds.
 *
 * ⚠️ NULL IS A VISIBLE CONFIGURATION GAP AND NEVER A ZERO. A clinic that has not
 *   priced a product gets `null` here, the charge request is written with a NULL
 *   `unit_price`, and the charge-review screen shows it as something to fix.
 *   Returning zero would put a settled-looking line on a bill for something the
 *   clinic meant to charge for — the same failure `resolveTaxCategory` refuses
 *   in the tax direction, and the same reasoning:
 *   `appointment-billing.service.ts` refuses to bill a consultation at zero
 *   rather than invent one.
 *
 * ⚠️ IT MUST NOT THROW ON A MISSING PRICE. This runs inside `createDispense`,
 *   and a pharmacist handing somebody their medicine must never be stopped
 *   because an accountant has not filled in a grid.
 *
 * ⚠️ ONE QUERY FOR BOTH TIERS, RANKED IN MEMORY, AND THE ORDERING IS NOT LEFT TO
 *   SQL. `ORDER BY branch_id DESC NULLS LAST` with `take: 1` is the obvious
 *   implementation and it is the bug PI-1 shipped in `resolveTaxCategory`:
 *   Postgres sorts NULLs FIRST on DESC, so the org default beat every branch
 *   override and the override was silently inert. An explicit `find` cannot get
 *   that wrong.
 */
export async function resolveProductPriceWithin(
  tx: TxClient,
  ctx: TenantContext,
  productId: string,
  branchId: string,
  currency: string
): Promise<ResolvedProductPrice | null> {
  /* One product is the batch of one; the precedence lives in one place. */
  const byProduct = await resolveProductPricesWithin(tx, ctx, [productId], branchId, currency);
  return byProduct.get(productId) ?? null;
}

/**
 * The same precedence for many products, in one query (PI-8).
 *
 * ⚠️ IT EXISTS BECAUSE THE SUPPLY PATH ASKED IT PER LINE, INSIDE THE POSTING
 *   TRANSACTION, WHILE THAT TRANSACTION HELD STOCK LOCKS.
 *
 * ⚠️ AND THE RANKING IS STILL AN EXPLICIT `find` PER TIER RATHER THAN AN
 *   `ORDER BY … NULLS LAST` WITH `take: 1` — see the singular's header for the
 *   PI-1 bug that shape produced. `take: 1` also cannot mean "one per product",
 *   so batching would have forced the in-memory rank anyway.
 */
export async function resolveProductPricesWithin(
  tx: TxClient,
  ctx: TenantContext,
  productIds: readonly string[],
  branchId: string,
  currency: string
): Promise<Map<string, ResolvedProductPrice>> {
  const resolved = new Map<string, ResolvedProductPrice>();
  if (productIds.length === 0) return resolved;

  const rows = await tx.productPrice.findMany({
    where: {
      organizationId: ctx.organizationId,
      productId: { in: [...new Set(productIds)] },
      currency,
      deletedAt: null,
      OR: [{ branchId }, { branchId: null }],
    },
    select: { productId: true, branchId: true, unitId: true, amount: true },
  });

  for (const productId of new Set(productIds)) {
    const mine = rows.filter((row) => row.productId === productId);
    const chosen =
      mine.find((row) => row.branchId === branchId) ?? mine.find((row) => row.branchId === null);
    if (!chosen) continue;

    resolved.set(productId, {
      unitPrice: toMoney(chosen.amount, currency),
      unitId: chosen.unitId,
      fromBranchOverride: chosen.branchId !== null,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Maintaining the grid
// ---------------------------------------------------------------------------

const PRICE_SELECT = {
  id: true,
  productId: true,
  branchId: true,
  unitId: true,
  amount: true,
  currency: true,
  updatedAt: true,
  product: { select: { name: true } },
  branch: { select: { name: true } },
  unit: { select: { symbol: true } },
} satisfies Prisma.ProductPriceSelect;

type PriceRow = Prisma.ProductPriceGetPayload<{ select: typeof PRICE_SELECT }>;

function toDetail(row: PriceRow): ProductPriceDetail {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    branchId: row.branchId,
    branchName: row.branch?.name ?? null,
    unitId: row.unitId,
    unitSymbol: row.unit.symbol,
    amountMinor: toMoney(row.amount, row.currency).amountMinor,
    currency: row.currency,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProductPrices(
  ctx: TenantContext,
  query: ListProductPricesQuery
): Promise<ProductPriceListResponse> {
  return withTenant(ctx, async (tx) => {
    if (query.branchId) assertBranchInScope(ctx, query.branchId);

    const where: Prisma.ProductPriceWhereInput = {
      organizationId: ctx.organizationId,
      deletedAt: null,
      ...(query.productId ? { productId: query.productId } : {}),
      /*
       * ⚠️ A BRANCH FILTER INCLUDES THE ORG DEFAULT, AND THAT IS NOT SLOPPINESS.
       *   "What does this branch charge?" is answered by its overrides AND the
       *   defaults it inherits — a grid that showed only the overrides would
       *   read as "nothing is priced here" at a clinic that prices centrally,
       *   which is most of them.
       */
      ...(query.branchId ? { OR: [{ branchId: query.branchId }, { branchId: null }] } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.productPrice.findMany({
        where,
        select: PRICE_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.productPrice.count({ where }),
    ]);

    return { items: rows.map(toDetail), total, page: query.page, limit: query.limit };
  });
}

/**
 * Set a price.
 *
 * ⚠️ AN UPSERT RATHER THAN A CREATE, BECAUSE THE UNIQUE IS THE POINT. One clinic
 *   holds exactly one price per (product, branch, currency) — NULLS NOT DISTINCT
 *   in the migration makes that true of the org default too — and "set the price
 *   to 45" from a screen is the same request whether or not a row exists.
 *   Handing back a 409 telling somebody to use a different button would be the
 *   API narrating its own storage.
 *
 * ⚠️ THE UNIT IS VALIDATED AGAINST THE PRODUCT'S OWN CONVERSION GRAPH, NOT
 *   MERELY EXISTS-CHECKED. A price of "₹45 per litre" on a product measured in
 *   tablets is a row that cannot be converted at supply time, so the charge
 *   request would silently come out unpriced weeks later. Refused here, where
 *   somebody is looking at the screen that caused it.
 */
export async function upsertProductPrice(
  ctx: TenantContext,
  input: UpsertProductPriceRequest,
  options: ChargingActionOptions = {}
): Promise<ProductPriceDetail> {
  return withTenant(ctx, async (tx) => {
    const branchId = input.branchId ?? null;
    if (branchId !== null) assertBranchInScope(ctx, branchId);
    else await assertOrganizationWideScope(tx, ctx);

    const product = await tx.product.findFirst({
      where: { id: input.productId, deletedAt: null },
      select: { id: true, baseUnitId: true },
    });
    if (!product) throw new NotFoundError('Product');

    await assertUnitPriceable(tx, product, input.unitId);

    const currency = await organizationCurrency(tx, ctx);
    const amount = toDecimal(money(input.amountMinor, currency));

    const existing = await tx.productPrice.findFirst({
      where: {
        organizationId: ctx.organizationId,
        productId: input.productId,
        branchId,
        currency,
      },
      select: { id: true, amount: true, unitId: true, deletedAt: true },
    });

    const row = existing
      ? await tx.productPrice.update({
          where: { id: existing.id },
          data: { amount, unitId: input.unitId, deletedAt: null, updatedBy: ctx.userId },
          select: PRICE_SELECT,
        })
      : await tx.productPrice.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            productId: input.productId,
            unitId: input.unitId,
            amount,
            currency,
            updatedBy: ctx.userId,
          },
          select: PRICE_SELECT,
        });

    await recordAudit(tx, ctx, {
      action: existing && existing.deletedAt === null ? 'UPDATE' : 'CREATE',
      entityType: 'product_price',
      entityId: row.id,
      ...(branchId !== null ? { branchId } : {}),
      ...(existing
        ? { before: { amount: existing.amount.toString(), unitId: existing.unitId } }
        : {}),
      after: { amount: amount.toString(), unitId: input.unitId, productId: input.productId },
      ...auditMeta(options),
    });

    return toDetail(row);
  });
}

export async function deleteProductPrice(
  ctx: TenantContext,
  priceId: string,
  options: ChargingActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.productPrice.findFirst({
      where: { id: priceId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, branchId: true, amount: true, productId: true },
    });
    if (!before) throw new NotFoundError('Product price');

    /*
     * ⚠️ THE BRANCH CHECK IS ON THE ROW, NOT ON THE REQUEST, AND WITHOUT IT RLS
     *   DOES NOT COVER THIS. `branch_isolation` on `product_prices` is
     *   `branch_id IS NULL OR branch_id = ANY(app_branch_scope())` — the nullable
     *   half is live here, deliberately, because NULL is the clinic-wide default
     *   every branch inherits. Which means the policy permits any member of the
     *   organization to delete that default, including one scoped to a single
     *   site. A branch row is covered by RLS; the org-wide one is covered by
     *   nothing, so it is checked here.
     *
     *   The read path is safe either way — inheriting the default is the point.
     *   It is the WRITE that has to be the organization's.
     *
     * ⚠️ AND UNTIL THE PI-8 REVIEW THIS COMMENT DESCRIBED CODE THAT DID NOT EXIST.
     *   It said the org-wide row "is covered by nothing, so it is checked here"
     *   above a line reading `if (before.branchId !== null) assertBranchInScope(…)`
     *   — which checks the BRANCH row and skips the org-wide one, the exact
     *   inverse of the paragraph above it. The reasoning was right; the branch it
     *   was attached to was not. Recorded rather than quietly corrected, because
     *   a comment that documents an intention as though it were an implementation
     *   is the failure mode PI-7 wrote up and this is the same one again.
     */
    if (before.branchId !== null) assertBranchInScope(ctx, before.branchId);
    else await assertOrganizationWideScope(tx, ctx);

    await tx.productPrice.update({
      where: { id: priceId },
      data: { deletedAt: new Date(), updatedBy: ctx.userId },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'product_price',
      entityId: priceId,
      ...(before.branchId !== null ? { branchId: before.branchId } : {}),
      before: { amount: before.amount.toString(), productId: before.productId },
      ...auditMeta(options),
    });
  });
}

/**
 * Can a quantity of this product be expressed in this unit, exactly?
 *
 * The base unit always can, trivially. Anything else has to be reachable through
 * the tenant's conversion graph — and a price that could never be applied is
 * refused at the screen rather than discovered weeks later as a NULL on a charge
 * request nobody can explain.
 *
 * ⚠️ THE GRAPH, NOT A DIRECT EDGE. `case → box → strip → tablet` is the ordinary
 *   shape of a packaging ladder (PI-1.1), so "is there a `unit_conversions` row
 *   joining these two?" answers no for most of the units a clinic would actually
 *   price in. `conversionFactor` walks it, which is what the ledger does with
 *   the same question.
 *
 * ⚠️ AND IT USES THE SAME `loadUnitGraph` THE LEDGER USES, so a unit this
 *   accepts is by construction a unit `toBaseUnits` can convert. A second
 *   reachability rule here would be free to disagree with the one that matters.
 */
async function assertUnitPriceable(
  tx: TxClient,
  product: { id: string; baseUnitId: string },
  unitId: string
): Promise<void> {
  if (unitId === product.baseUnitId) return;

  const graph = await loadUnitGraph(tx);
  if (!graph.units.has(unitId)) throw new NotFoundError('Unit');

  try {
    conversionFactor(graph, unitId, product.baseUnitId);
  } catch {
    /*
     * `conversionFactor` throws on an unreachable pair and on a cross-class one
     * (you cannot convert millilitres to tablets). Both are the same answer to
     * the caller — this price could never be applied — and the engine's own
     * message is written for a movement rather than for a pricing screen.
     */
    throw new ValidationError(
      'That unit cannot be converted to this product’s base unit, so a quantity could never be priced in it. Price it in the base unit, or add the conversion first.'
    );
  }
}
