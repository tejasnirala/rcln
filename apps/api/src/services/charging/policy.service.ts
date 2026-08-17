/**
 * Charge policy — the clinic's standing answer to "is this billed?" (PI-8).
 *
 * ⚠️ THIS IS THE ONLY PLACE THE PRECEDENCE CHAIN IS WRITTEN DOWN. The supply
 *   path, the preview panel on the policy screen and the charge queue's
 *   "why?" all call `resolveChargePolicyWithin`. A second copy of "most
 *   specific wins" is how a screen promises one answer and the bill states
 *   another — `appointment-billing.service.ts` makes the same argument about
 *   fee resolution and got it right; `resolveTaxCategory`'s regional-override
 *   bug in PI-1 is what it looks like when a resolver is subtly wrong and
 *   nothing notices.
 *
 * ⚠️ THE CHAIN IS SHORTER THAN BILLING_INTEGRATION.md's EIGHT TIERS, AND
 *   DELIBERATELY SO. Five of those tiers name a `procedure` or a `payer`.
 *   Procedures are PI-9, blocked on `encounters`; there is no payer-contract
 *   model anywhere in this repository. Building a resolver tier against a table
 *   that does not exist means guessing at the shape of its join, and PI-5
 *   records exactly that mistake about `regulatory_decisions`. The three
 *   expressible tiers are here; `ChargePolicyScope` is where the others go.
 *
 * NO PHI. A policy is a fact about a catalogue row, never about a person.
 */
import type { Prisma, ProductType, TenantContext, TxClient } from '@rcln/db';
import { withTenant } from '@rcln/db';
import type {
  ChargePolicyRuleDetail,
  ChargePolicyRuleListResponse,
  ChargePolicyScopeValue,
  ChargePolicyValue,
  CreateChargePolicyRuleRequest,
  ListChargePolicyRulesQuery,
  ResolvedChargePolicy,
  UpdateChargePolicyRuleRequest,
} from '@rcln/contracts';

import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

/**
 * What a product costs the clinic to give away when nobody has said otherwise.
 *
 * ⚠️ THE DEFAULT IS A REAL DECISION AND NOT A FALLBACK. Every clinic starts with
 *   an empty policy table, so this function decides what happens at every clinic
 *   on the platform until somebody configures one — and both directions of
 *   getting it wrong are bad in a way nobody notices for a month. Defaulting
 *   everything to billable puts gauze on a patient's invoice; defaulting
 *   everything to `NEVER_BILL` gives away medicine.
 *
 * ⚠️ IT SPLITS ON `ProductType` AND NOTHING ELSE, WHICH IS THE ONLY FACT ABOUT A
 *   PRODUCT EVERY CLINIC HAS ALREADY SET. A default keyed on a category would
 *   depend on a taxonomy each clinic builds itself; one keyed on
 *   `is_stock_item` or on a price existing would make the answer depend on how
 *   complete somebody's data entry is, which is a different question.
 *
 * The split is BILLING_INTEGRATION.md's own test, verbatim: a consumed glove
 * produces no invoice line, an implant does.
 */
const BILLABLE_BY_DEFAULT: ReadonlySet<string> = new Set([
  /* Something a patient takes away and is charged for. */
  'MEDICINE',
  'VACCINE',
  'VETERINARY_MEDICINE',
  /*
   * ⚠️ A DEVICE AND AN IMPLANT ARE BILLED, AND THIS IS THE HALF PEOPLE ARGUE
   *   WITH. An implant's cost is not inside a procedure fee at any clinic that
   *   fits more than one kind, and a glucometer handed over the counter is a
   *   sale. A clinic whose procedure fee IS inclusive says so with one
   *   `INCLUDED_IN_SERVICE` rule — which is a row it can point at, rather than a
   *   default nobody can see.
   */
  'MEDICAL_DEVICE',
  'IMPLANT',
]);

/**
 * The default tier of the chain.
 *
 * Everything not in the set above is consumed rather than sold — gauze, gloves,
 * disinfectant, a lab reagent, a dental material used during the appointment.
 */
export function defaultChargePolicy(productType: ProductType): ChargePolicyValue {
  return BILLABLE_BY_DEFAULT.has(productType) ? 'SEPARATELY_BILLABLE' : 'NEVER_BILL';
}

/** Does this policy produce an invoice line without asking anybody? */
export function isBillable(policy: ChargePolicyValue): boolean {
  return policy === 'SEPARATELY_BILLABLE';
}

/**
 * Does this policy stop at a human?
 *
 * ⚠️ ALL THREE OF THESE STOP, AND THE LAST TWO ARE HONEST RATHER THAN
 *   UNFINISHED. `CONTRACT_DEFINED` needs a payer-contract engine and
 *   `JURISDICTION_CONFIGURED` needs a billing-rule pack. Neither exists. The
 *   alternative to asking a human is guessing, and a guess here either bills
 *   somebody a contract says is covered or waives a charge nobody agreed to
 *   waive. Recorded as accepted debt; see KNOWN_ISSUES.
 */
export function needsDecision(policy: ChargePolicyValue): boolean {
  return (
    policy === 'OPTIONAL' || policy === 'CONTRACT_DEFINED' || policy === 'JURISDICTION_CONFIGURED'
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedPolicy {
  policy: ChargePolicyValue;
  scope: ChargePolicyScopeValue;
  ruleId: string | null;
}

/**
 * The precedence chain, on the caller's transaction.
 *
 * ⚠️ `Within`, FOR THE REASON `evaluateWithin` AND `planStockAllocationWithin`
 *   ARE. A supply consults this in the middle of its own posting transaction,
 *   having already written ledger legs. A second transaction could not see that
 *   uncommitted work, would take its own snapshot, and on a pooled connection
 *   can deadlock against locks the outer one holds.
 *
 * ⚠️ ONE QUERY FOR ALL THREE TIERS, NOT THREE. Every candidate rule for a
 *   product comes back in one read and the tiers are ranked in memory. Three
 *   round trips per line inside a posting transaction is what makes a
 *   twelve-line dispense thirty-six queries, and — worse — three reads can see
 *   three different states of a table somebody is editing.
 *
 * ⚠️ THE CATEGORY TIER WALKS NO ANCESTRY. A rule on "Antibiotics" does not reach
 *   a product filed under its child "Penicillins", and that is a decision rather
 *   than an omission: `product_categories` is a recursive tree with no depth
 *   limit, an ancestry walk is a recursive CTE per line inside the posting
 *   transaction, and "which ancestor won?" is a question a clinic cannot answer
 *   from the screen. A clinic that wants the whole subtree covered writes the
 *   rule at the type tier or on each category. Stated here because the opposite
 *   is the natural assumption.
 */
export async function resolveChargePolicyWithin(
  tx: TxClient,
  ctx: TenantContext,
  product: { id: string; type: ProductType; categoryId: string | null }
): Promise<ResolvedPolicy> {
  const byProduct = await resolveChargePoliciesWithin(tx, ctx, [product]);
  /* One product is the batch of one; the chain lives in exactly one place. */
  return (
    byProduct.get(product.id) ?? {
      policy: defaultChargePolicy(product.type),
      scope: 'DEFAULT',
      ruleId: null,
    }
  );
}

/**
 * The same chain for many products, in one query (PI-8).
 *
 * ⚠️ IT EXISTS BECAUSE THE SUPPLY PATH ASKED IT PER LINE, INSIDE THE POSTING
 *   TRANSACTION, WHILE THAT TRANSACTION HELD STOCK LOCKS. Twelve lines was
 *   twelve round trips for this alone, on the highest-contention write in the
 *   programme.
 *
 * ⚠️ THE RANKING IS THE SINGULAR'S, UNCHANGED — an ordered search per product
 *   rather than a sort, because the unique index guarantees at most one rule per
 *   tier and a `find` per tier cannot get the tie-break wrong.
 */
export async function resolveChargePoliciesWithin(
  tx: TxClient,
  ctx: TenantContext,
  products: readonly { id: string; type: ProductType; categoryId: string | null }[]
): Promise<Map<string, ResolvedPolicy>> {
  const resolved = new Map<string, ResolvedPolicy>();
  if (products.length === 0) return resolved;

  const productIds = [...new Set(products.map((p) => p.id))];
  const categoryIds = [
    ...new Set(products.map((p) => p.categoryId).filter((id): id is string => id !== null)),
  ];
  const types = [...new Set(products.map((p) => p.type))];

  const rules = await tx.chargePolicyRule.findMany({
    where: {
      organizationId: ctx.organizationId,
      deletedAt: null,
      OR: [
        { productId: { in: productIds } },
        ...(categoryIds.length > 0 ? [{ productCategoryId: { in: categoryIds } }] : []),
        { productType: { in: types } },
      ],
    },
    select: { id: true, policy: true, productId: true, productCategoryId: true, productType: true },
  });

  /*
   * Most specific wins. Written as an ordered search rather than a sort so the
   * tie-break is impossible to get wrong: the unique index guarantees at most
   * one rule per (product | category | type), so the first match at each tier is
   * the only match at that tier.
   */
  for (const product of products) {
    const byProduct = rules.find((rule) => rule.productId === product.id);
    if (byProduct) {
      resolved.set(product.id, {
        policy: byProduct.policy,
        scope: 'PRODUCT',
        ruleId: byProduct.id,
      });
      continue;
    }

    if (product.categoryId !== null) {
      const byCategory = rules.find((rule) => rule.productCategoryId === product.categoryId);
      if (byCategory) {
        resolved.set(product.id, {
          policy: byCategory.policy,
          scope: 'PRODUCT_CATEGORY',
          ruleId: byCategory.id,
        });
        continue;
      }
    }

    const byType = rules.find((rule) => rule.productType === product.type);
    if (byType) {
      resolved.set(product.id, {
        policy: byType.policy,
        scope: 'PRODUCT_TYPE',
        ruleId: byType.id,
      });
      continue;
    }

    resolved.set(product.id, {
      policy: defaultChargePolicy(product.type),
      scope: 'DEFAULT',
      ruleId: null,
    });
  }

  return resolved;
}

/**
 * The same question from a screen, in its own transaction.
 *
 * The preview panel behind "what happens if I supply this?". It calls the
 * function above rather than restating the chain, which is the whole point of
 * the split.
 */
export async function resolveChargePolicyFor(
  ctx: TenantContext,
  productId: string
): Promise<ResolvedChargePolicy> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, type: true, categoryId: true },
    });
    if (!product) throw new NotFoundError('Product');

    const resolved = await resolveChargePolicyWithin(tx, ctx, product);
    return {
      productId,
      policy: resolved.policy,
      scope: resolved.scope,
      ruleId: resolved.ruleId,
      billable: isBillable(resolved.policy),
      needsDecision: needsDecision(resolved.policy),
    };
  });
}

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

const RULE_SELECT = {
  id: true,
  policy: true,
  note: true,
  productId: true,
  productCategoryId: true,
  productType: true,
  updatedAt: true,
  product: { select: { name: true } },
  productCategory: { select: { name: true } },
} satisfies Prisma.ChargePolicyRuleSelect;

type RuleRow = Prisma.ChargePolicyRuleGetPayload<{ select: typeof RULE_SELECT }>;

function scopeOf(row: RuleRow): ChargePolicyScopeValue {
  if (row.productId !== null) return 'PRODUCT';
  if (row.productCategoryId !== null) return 'PRODUCT_CATEGORY';
  return 'PRODUCT_TYPE';
}

function toDetail(row: RuleRow): ChargePolicyRuleDetail {
  return {
    id: row.id,
    scope: scopeOf(row),
    productId: row.productId,
    productName: row.product?.name ?? null,
    productCategoryId: row.productCategoryId,
    productCategoryName: row.productCategory?.name ?? null,
    productType: row.productType,
    policy: row.policy,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ChargingActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  route?: string | undefined;
  /** The branch the request is acting on, when the body does not name one. */
  actingBranchId?: string | null | undefined;
}

export async function listChargePolicyRules(
  ctx: TenantContext,
  query: ListChargePolicyRulesQuery
): Promise<ChargePolicyRuleListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.ChargePolicyRuleWhereInput = {
      organizationId: ctx.organizationId,
      deletedAt: null,
      ...(query.productId ? { productId: query.productId } : {}),
      /*
       * Scope is a derived fact — which column is non-null — so it filters on
       * the columns rather than on a stored discriminator. A stored one would be
       * a second answer to a question the data already answers, free to
       * disagree with it.
       */
      ...(query.scope === 'PRODUCT' ? { productId: { not: null } } : {}),
      ...(query.scope === 'PRODUCT_CATEGORY' ? { productCategoryId: { not: null } } : {}),
      ...(query.scope === 'PRODUCT_TYPE' ? { productType: { not: null } } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.chargePolicyRule.findMany({
        where,
        select: RULE_SELECT,
        /* Total order: `updatedAt` alone ties on a bulk edit. */
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.chargePolicyRule.count({ where }),
    ]);

    return { items: rows.map(toDetail), total, page: query.page, limit: query.limit };
  });
}

/**
 * Write a rule.
 *
 * ⚠️ A SOFT-DELETED RULE ON THE SAME TARGET IS REVIVED RATHER THAN DUPLICATED.
 *   The unique index is over the target columns and does NOT include
 *   `deleted_at`, so a plain insert after a delete raises 23505 — and the
 *   honest reading of "set this product to NEVER_BILL" from somebody who deleted
 *   that exact rule last week is that they want it back, not an error about a
 *   row they cannot see.
 */
export async function createChargePolicyRule(
  ctx: TenantContext,
  input: CreateChargePolicyRuleRequest,
  options: ChargingActionOptions = {}
): Promise<ChargePolicyRuleDetail> {
  return withTenant(ctx, async (tx) => {
    const target = {
      productId: input.target.scope === 'PRODUCT' ? input.target.productId : null,
      productCategoryId:
        input.target.scope === 'PRODUCT_CATEGORY' ? input.target.productCategoryId : null,
      productType: input.target.scope === 'PRODUCT_TYPE' ? input.target.productType : null,
    };

    const existing = await tx.chargePolicyRule.findFirst({
      where: { organizationId: ctx.organizationId, ...target },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.deletedAt === null) {
      throw new ConflictError(
        'This clinic already has a charge policy for that. Edit the existing rule rather than adding a second one.'
      );
    }

    const row = existing
      ? await tx.chargePolicyRule.update({
          where: { id: existing.id },
          data: {
            policy: input.policy,
            note: input.note ?? null,
            deletedAt: null,
            updatedBy: ctx.userId,
          },
          select: RULE_SELECT,
        })
      : await tx.chargePolicyRule.create({
          data: {
            organizationId: ctx.organizationId,
            ...target,
            policy: input.policy,
            note: input.note ?? null,
            updatedBy: ctx.userId,
          },
          select: RULE_SELECT,
        });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'charge_policy_rule',
      entityId: row.id,
      after: { ...target, policy: input.policy },
      ...auditMeta(options),
    });

    return toDetail(row);
  });
}

export async function updateChargePolicyRule(
  ctx: TenantContext,
  ruleId: string,
  input: UpdateChargePolicyRuleRequest,
  options: ChargingActionOptions = {}
): Promise<ChargePolicyRuleDetail> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.chargePolicyRule.findFirst({
      where: { id: ruleId, organizationId: ctx.organizationId, deletedAt: null },
      select: RULE_SELECT,
    });
    if (!before) throw new NotFoundError('Charge policy rule');

    const row = await tx.chargePolicyRule.update({
      where: { id: ruleId },
      data: {
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedBy: ctx.userId,
      },
      select: RULE_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'charge_policy_rule',
      entityId: ruleId,
      before: { policy: before.policy, note: before.note },
      after: { policy: row.policy, note: row.note },
      ...auditMeta(options),
    });

    return toDetail(row);
  });
}

/**
 * Retire a rule.
 *
 * ⚠️ SOFT, AND NOT BECAUSE SOFT DELETE IS THE HOUSE STYLE. `charge_requests`
 *   cites the rule that decided it, with `onDelete: Restrict` and no `SetNull`
 *   available on a composite FK — see the model. A hard delete would either fail
 *   at the constraint or, if the constraint were relaxed, orphan the provenance
 *   of every bill that rule ever produced.
 */
export async function deleteChargePolicyRule(
  ctx: TenantContext,
  ruleId: string,
  options: ChargingActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.chargePolicyRule.findFirst({
      where: { id: ruleId, organizationId: ctx.organizationId, deletedAt: null },
      select: RULE_SELECT,
    });
    if (!before) throw new NotFoundError('Charge policy rule');

    await tx.chargePolicyRule.update({
      where: { id: ruleId },
      data: { deletedAt: new Date(), updatedBy: ctx.userId },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'charge_policy_rule',
      entityId: ruleId,
      before: { policy: before.policy, scope: scopeOf(before) },
      ...auditMeta(options),
    });
  });
}

/** The audit metadata a route hands down, narrowed to what `audit_logs` holds. */
export function auditMeta(options: ChargingActionOptions): {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
} {
  return { ipAddress: options.ipAddress, userAgent: options.userAgent };
}
