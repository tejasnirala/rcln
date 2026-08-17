/**
 * Charging — the wire shapes for the seam between a supply and a bill (PI-8).
 *
 * ⚠️ NOTHING HERE IS A TAX SHAPE. A charge request carries a `taxCategory`
 *   STRING and no rate, no split, no component name and no amount — those are
 *   `@rcln/tax`'s and reach the wire through `invoices.ts`. If a field in this
 *   file ever needs to know what CGST is, the seam has been crossed in the wrong
 *   direction.
 *
 * ⚠️ MONEY CROSSES THE WIRE IN MINOR UNITS, AS AN INTEGER, ALWAYS — the same
 *   rule `invoices.ts` states and for the same reason. `…Minor` suffixes the
 *   field so nobody can mistake 1250 for twelve rupees fifty.
 *
 * ⚠️ QUANTITIES CROSS AS DECIMAL STRINGS, NEVER AS NUMBERS. A JSON number is a
 *   double, `0.1 + 0.2` is not `0.3`, and a base quantity that has been through
 *   one is a quantity that no longer reconciles against `stock_ledger`.
 *
 * ⚠️ A CHARGE REQUEST NAMES A PATIENT AND A MEDICINE, WHICH MAKES EVERY LIST
 *   HERE A PHI SURFACE. Filters are ids, dates and enums — never a name — so the
 *   query string stays safe to land in a proxy log, exactly as the invoice list
 *   is written. The read routes file `data_access_logs` rows.
 */
import { z } from 'zod';

import { uuid, calendarDate } from './common.js';
import { invoiceSourceType } from './invoices.js';
import { productType } from './products.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Should this reach a bill at all?
 *
 * ⚠️ THE LAST THREE ALL STOP AT A HUMAN TODAY, AND THAT IS HONEST RATHER THAN
 *   UNFINISHED. `OPTIONAL` always did. `CONTRACT_DEFINED` needs a payer-contract
 *   engine and `JURISDICTION_CONFIGURED` needs a billing-rule pack; neither
 *   exists, and neither is guessed at. They are separate members because the
 *   REASON the desk is being asked differs and because it is their call sites
 *   that change when the engines land — not `OPTIONAL`'s.
 */
export const chargePolicy = z.enum([
  'NEVER_BILL',
  'INCLUDED_IN_SERVICE',
  'SEPARATELY_BILLABLE',
  'OPTIONAL',
  'CONTRACT_DEFINED',
  'JURISDICTION_CONFIGURED',
]);
export type ChargePolicyValue = z.infer<typeof chargePolicy>;

/** Which tier of the precedence chain produced a policy. Most specific first. */
export const chargePolicyScope = z.enum(['PRODUCT', 'PRODUCT_CATEGORY', 'PRODUCT_TYPE', 'DEFAULT']);
export type ChargePolicyScopeValue = z.infer<typeof chargePolicyScope>;

export const chargeRequestStatus = z.enum(['PENDING', 'SUPPRESSED', 'INVOICED', 'CANCELLED']);
export type ChargeRequestStatusValue = z.infer<typeof chargeRequestStatus>;

export const chargeRequestKind = z.enum(['SUPPLY', 'REVERSAL']);
export type ChargeRequestKindValue = z.infer<typeof chargeRequestKind>;

// ---------------------------------------------------------------------------
// Charge policy rules
// ---------------------------------------------------------------------------

/**
 * A clinic's standing answer to "is this billed?".
 *
 * ⚠️ EXACTLY ONE SCOPE FIELD IS SET, AND THE UNION MAKES THE OTHER STATES
 *   UNREPRESENTABLE RATHER THAN MERELY REFUSED. The CHECK constraint on the row
 *   refuses two; a discriminated union means a client cannot construct one, and
 *   the reader of a rule never has to work out which tier it sits at. Same call
 *   `discountInput` makes in `invoices.ts`.
 */
export const chargePolicyRuleScope = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('PRODUCT'), productId: uuid }),
  z.object({ scope: z.literal('PRODUCT_CATEGORY'), productCategoryId: uuid }),
  z.object({ scope: z.literal('PRODUCT_TYPE'), productType }),
]);
export type ChargePolicyRuleScope = z.infer<typeof chargePolicyRuleScope>;

export const createChargePolicyRuleRequest = z.object({
  target: chargePolicyRuleScope,
  policy: chargePolicy,
  note: z.string().max(2000).optional(),
});
export type CreateChargePolicyRuleRequest = z.infer<typeof createChargePolicyRuleRequest>;

/**
 * ⚠️ THE TARGET IS NOT EDITABLE, DELIBERATELY. Moving a rule from one product to
 *   another is deleting one rule and writing another, and doing it in place
 *   would leave every charge request that cited it pointing at provenance for a
 *   decision it did not make. Only the answer and the note may change.
 */
export const updateChargePolicyRuleRequest = z.object({
  policy: chargePolicy.optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type UpdateChargePolicyRuleRequest = z.infer<typeof updateChargePolicyRuleRequest>;

export interface ChargePolicyRuleDetail {
  id: string;
  scope: ChargePolicyScopeValue;
  productId: string | null;
  /** For the screen, so it need not resolve the id itself. */
  productName: string | null;
  productCategoryId: string | null;
  productCategoryName: string | null;
  productType: string | null;
  policy: ChargePolicyValue;
  note: string | null;
  updatedAt: string;
}

export const listChargePolicyRulesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  scope: chargePolicyScope.optional(),
  productId: uuid.optional(),
});
export type ListChargePolicyRulesQuery = z.infer<typeof listChargePolicyRulesQuery>;

export interface ChargePolicyRuleListResponse {
  items: ChargePolicyRuleDetail[];
  total: number;
  page: number;
  limit: number;
}

/**
 * What the chain would answer for one product, and why.
 *
 * The preview behind the "what happens if I supply this?" panel — resolved with
 * the same function the supply path uses, never a second copy of the precedence
 * rule. A second copy is how a screen promises one answer and the bill states
 * another; `appointment-billing.service.ts` makes the same argument about fees.
 */
export const resolveChargePolicyQuery = z.object({ productId: uuid });
export type ResolveChargePolicyQuery = z.infer<typeof resolveChargePolicyQuery>;

export interface ResolvedChargePolicy {
  productId: string;
  policy: ChargePolicyValue;
  scope: ChargePolicyScopeValue;
  /** The rule that produced it. Null when the chain fell through to the default. */
  ruleId: string | null;
  /** Whether this policy produces an invoice line without asking anybody. */
  billable: boolean;
  /** Whether it stops at a human. */
  needsDecision: boolean;
}

// ---------------------------------------------------------------------------
// Product prices
// ---------------------------------------------------------------------------

/**
 * What a clinic sells a product for.
 *
 * ⚠️ THE UNIT IS PART OF THE PRICE AND IS REQUIRED. "₹45" means nothing without
 *   "per strip", and a price whose unit was implied would be applied to a base
 *   quantity in tablets the first time somebody dispensed by the box.
 */
export const upsertProductPriceRequest = z.object({
  productId: uuid,
  /** NULL — omitted — is the organization default every branch inherits. */
  branchId: uuid.nullable().optional(),
  unitId: uuid,
  /** Minor units. Zero is legal and means "supplied free of charge". */
  amountMinor: z.int().min(0),
});
export type UpsertProductPriceRequest = z.infer<typeof upsertProductPriceRequest>;

export interface ProductPriceDetail {
  id: string;
  productId: string;
  productName: string;
  branchId: string | null;
  branchName: string | null;
  unitId: string;
  unitSymbol: string;
  amountMinor: number;
  currency: string;
  updatedAt: string;
}

export const listProductPricesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  productId: uuid.optional(),
  branchId: uuid.optional(),
});
export type ListProductPricesQuery = z.infer<typeof listProductPricesQuery>;

export interface ProductPriceListResponse {
  items: ProductPriceDetail[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Charge requests
// ---------------------------------------------------------------------------

/**
 * One row of the charge queue.
 *
 * ⚠️ `patientName` IS HERE AND IS WHY THE READ ROUTES LOG. The desk cannot work
 *   a queue of uuids, so the name crosses the wire in the BODY — never in a
 *   filter, never in a path. That is the same line the invoice list draws.
 */
export interface ChargeRequestSummary {
  id: string;
  branchId: string;
  sourceType: 'PHARMACY' | 'INVENTORY';
  kind: ChargeRequestKindValue;
  status: ChargeRequestStatusValue;
  productId: string;
  productName: string;
  patientId: string | null;
  patientName: string | null;
  occurredAt: string;
  /** In `unitSymbol`. The quantity that reaches the invoice line. */
  quantity: string;
  unitId: string;
  unitSymbol: string;
  /** In the product's base unit. Reconciles against the ledger; never billed. */
  quantityBase: string;
  policy: ChargePolicyValue;
  policyScope: ChargePolicyScopeValue;
  policyRuleId: string | null;
  description: string;
  /**
   * ⚠️ NULL IS A CONFIGURATION GAP THE SCREEN MUST SHOW, NOT A ZERO. A NULL
   *   price means nobody has priced this product and a NULL category means the
   *   invoice will refuse to issue. Rendering either as blank-and-carry-on is
   *   how a clinic discovers at month end that it gave stock away.
   */
  unitPriceMinor: number | null;
  currency: string;
  taxCategory: string | null;
  itemCode: string | null;
  /** `unitPrice × quantity`, or null when unpriced. Indicative — the engine prices. */
  estimatedTotalMinor: number | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  suppressedReason: string | null;
  decidedAt: string | null;
  /** The dispense this came from, so the queue can link back to the supply. */
  dispenseId: string | null;
  dispenseNumber: string | null;
}

export const listChargeRequestsQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    branchId: uuid.optional(),
    patientId: uuid.optional(),
    status: chargeRequestStatus.optional(),
    kind: chargeRequestKind.optional(),
    sourceType: invoiceSourceType.optional(),
    /**
     * Only the ones that cannot be billed as they stand — no price, no tax
     * category, or a policy waiting on a human.
     *
     * ⚠️ A CONVENIENCE OVER THE OTHER FILTERS AND NOT A SECOND SOURCE OF TRUTH:
     *   it is `unitPrice IS NULL OR taxCategory IS NULL OR policy needs a
     *   decision`, evaluated in the same query. The screen's "needs attention"
     *   tab is this.
     */
    needsAttention: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from !== undefined && v.to !== undefined && v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the first day' });
    }
  });
export type ListChargeRequestsQuery = z.infer<typeof listChargeRequestsQuery>;

export interface ChargeRequestListResponse {
  items: ChargeRequestSummary[];
  total: number;
  page: number;
  limit: number;
}

/**
 * A human's answer to a charge the policy would not decide.
 *
 * ⚠️ `SUPPRESS` REQUIRES A REASON AND `BILL` DOES NOT, WHICH IS NOT AN
 *   ASYMMETRY WORTH REMOVING. Billing is what the clinic does; not billing is
 *   the exception somebody has to be able to explain. The database refuses a
 *   `SUPPRESSED` row with a null reason, so this union is the same constraint
 *   made unrepresentable rather than merely refused.
 */
export const decideChargeRequest = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('BILL'),
    /**
     * Override the resolved price, in minor units. For the counter that agreed
     * something different — the same escape hatch `unitPriceMinor` is on an
     * appointment invoice, and the same reason: what was actually agreed beats
     * what the grid says.
     *
     * ⚠️ THIS IS A PRICING POWER BEHIND `billing.charge_request.manage`, NOT
     *   `billing.fee_schedule.manage`, AND THE ROUTER'S HEADER DOES NOT SAY SO.
     *   Recorded here rather than re-gated: RECEPTIONIST and BRANCH_ADMIN hold
     *   both this code and `billing.invoice.create`, and a holder of the latter
     *   can already type any price onto a manual invoice — so it confers no
     *   authority they lack. What it is NOT is a second copy of the PRICE LIST:
     *   it moves one line on one bill and is recorded against a named person on
     *   the charge request, where the grid is silent and applies to everything.
     */
    unitPriceMinor: z.int().min(0).optional(),
  }),
  z.object({
    decision: z.literal('SUPPRESS'),
    reason: z.string().min(1).max(500),
  }),
]);
export type DecideChargeRequest = z.infer<typeof decideChargeRequest>;

/**
 * Raise one invoice from a set of pending charges.
 *
 * ⚠️ THE CALLER NAMES THE CHARGES, AND THE SERVICE DOES NOT GUESS. "Bill
 *   everything outstanding for this patient" is a query the SCREEN runs and a
 *   set the human then confirms; doing it server-side from a patient id would
 *   mean a charge raised one second before the click silently joining a bill
 *   nobody reviewed.
 *
 * ⚠️ EVERY CHARGE MUST SHARE A BRANCH, A CURRENCY AND A PATIENT. The branch is
 *   the place of supply and the number series; the patient is who the document
 *   is addressed to. The service refuses a mixed set with a sentence rather than
 *   picking one — an invoice that billed two patients' supplies is a disclosure
 *   of one to the other.
 */
export const createInvoiceFromChargesRequest = z.object({
  /**
   * ⚠️ DISTINCT, BECAUSE A DUPLICATE PRODUCES A MISLEADING DIAGNOSIS. The service
   *   refuses the whole request when `charges.length !== ids.length`, which is
   *   the right refusal for an id that does not exist — but a repeated id trips
   *   the same count check and answers `404 Charge request` for a set in which
   *   every id is real. Safe, and thirty minutes of somebody's afternoon.
   */
  chargeRequestIds: z
    .array(uuid)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'name each charge once'),
  /** Anything the desk wants printed on the bill. */
  notes: z.string().max(2000).optional(),
});
export type CreateInvoiceFromChargesRequest = z.infer<typeof createInvoiceFromChargesRequest>;

/**
 * The charge queue at a glance, for the review screen's header.
 *
 * ⚠️ COUNTS AND A SUM, AND NO NAMES. It is rendered on every poll of the screen,
 *   so it deliberately carries nothing that would put a patient in a response
 *   the desk did not ask a question about. `estimatedValueMinor` is indicative —
 *   nothing has been priced by the engine yet.
 */
export interface ChargeQueueSummary {
  branchId: string | null;
  pending: number;
  needsAttention: number;
  suppressed: number;
  invoiced: number;
  estimatedValueMinor: number;
  currency: string;
}
