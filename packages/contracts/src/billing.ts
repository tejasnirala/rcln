/**
 * The billing HTTP surface: what a client may send, and what it gets back.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT FROM EVERY REQUEST HERE
 *
 *   1. AN AMOUNT. Never. The client says which plan price it wants; the server
 *      computes what that costs, including the proration. A request that carried
 *      a figure would be a request the customer could edit.
 *
 *   2. A PROVIDER. The client does not choose the acquirer and cannot name one.
 *      `PAYMENT_PROVIDER` is server configuration, and swapping it changes no
 *      contract in this file — which is the whole point of the seam in
 *      `@rcln/payments`.
 *
 * MONEY CROSSES THE WIRE IN MINOR UNITS, AS AN INTEGER
 *   `amountMinor: 149900` with `currency: 'INR'`, never `1499.00` and never a
 *   float. JSON numbers are IEEE doubles; a two-decimal amount survives the
 *   round-trip today and stops surviving it the moment somebody adds a
 *   three-decimal currency. The client formats for display with the currency's
 *   own exponent — `formatMoney` in @rcln/payments does exactly that.
 */

import { z } from 'zod';
import { uuid } from './common.js';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Start paying for a plan.
 *
 * One field. Which currency, which interval and how much are all properties of
 * the `plan_prices` row, so naming the price names all three and there is no way
 * to ask for a combination the catalogue does not publish.
 */
export const startCheckoutRequest = z.object({
  planPriceId: uuid,
});

export type StartCheckoutRequest = z.infer<typeof startCheckoutRequest>;

/** What an upgrade would cost. Same shape as applying it, on purpose. */
export const upgradePreviewRequest = z.object({
  planPriceId: uuid,
});

export type UpgradePreviewRequest = z.infer<typeof upgradePreviewRequest>;

export const upgradeRequest = upgradePreviewRequest;
export type UpgradeRequest = UpgradePreviewRequest;

/**
 * Leave.
 *
 * `immediate` defaults to false: the clinic has paid for this period and keeps
 * it. The screen asks for confirmation and says plainly that neither form is
 * refunded — see the cancel dialog.
 *
 * `reason` is free text from the cancellation form and goes on the
 * `subscription_changes` row. It is a business answer, so it must never contain
 * anything patient-identifying; the field is short and the copy above it says so.
 */
export const cancelSubscriptionRequest = z.object({
  immediate: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
});

export type CancelSubscriptionRequest = z.infer<typeof cancelSubscriptionRequest>;

/** Turn unattended renewal on or off. Turning it on needs a live mandate. */
export const setAutoRenewRequest = z.object({
  enabled: z.boolean(),
});

export type SetAutoRenewRequest = z.infer<typeof setAutoRenewRequest>;

/**
 * Which currency to quote an unstarted subscription in.
 *
 * A HINT, NOT AN INSTRUCTION. The server takes the subscription's own currency
 * once it has one, and otherwise derives a default from the organization's
 * country — so this only helps a clinic that wants to be billed in something
 * other than its country's default before it has ever paid. Rejected outright
 * once money has moved, because an invoice history that changes denomination
 * halfway through cannot be reconciled.
 */
export const billingOverviewQuery = z.object({
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .toUpperCase()
    .optional(),
});

export type BillingOverviewQuery = z.infer<typeof billingOverviewQuery>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type BillingInterval = 'MONTH' | 'YEAR';

export interface PlanPriceSummary {
  id: string;
  currency: string;
  interval: BillingInterval;
  amountMinor: number;
}

export interface PlanSummary {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  trialDays: number;
  sortOrder: number;
  /** Resolved entitlements. `-1` means unlimited; booleans are modules. */
  features: Record<string, number | boolean>;
  /** Only prices in the currency this clinic is being quoted in. */
  prices: PlanPriceSummary[];
}

export interface MandateSummary {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'FAILED';
  method: string | null;
  /** Last four digits, or a UPI handle's domain. Never a full instrument. */
  instrumentLabel: string | null;
  maxAmountMinor: number;
  currency: string;
  activatedAt: string | null;
}

export interface SubscriptionSummary {
  id: string;
  status: 'TRIALING' | 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';
  /**
   * Whether the clinic may use the product right now.
   *
   * Computed by the server from status AND the clock, so a trial that ended an
   * hour ago reads false even if the sweep has not run. Clients gate on this,
   * never on `status` — "PAST_DUE but inside the grace period" is still working,
   * and re-deriving that rule in the browser is how it gets it wrong.
   */
  isActive: boolean;
  plan: { id: string; code: string; name: string; tagline: string | null };
  planPriceId: string;
  currency: string;
  interval: BillingInterval;
  amountMinor: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  /** Non-null only while a failed renewal is still inside its grace window. */
  gracePeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  autoRenew: boolean;
  entitlements: Record<string, number | boolean>;
  mandate: MandateSummary | null;
  /**
   * False when the configured provider cannot hold a mandate in this currency —
   * Cashfree cannot, outside INR. The screen offers manual invoices instead of a
   * toggle that would fail.
   */
  autoRenewAvailable: boolean;
}

export interface InvoiceLineSummary {
  kind: 'SUBSCRIPTION' | 'PRORATION_CREDIT' | 'PRORATION_CHARGE' | 'TAX' | 'ADJUSTMENT';
  description: string;
  /** Negative for a credit, so the lines sum to the total. */
  amountMinor: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  dueDate: string | null;
  lines: InvoiceLineSummary[];
}

/** Everything the billing screen renders, in one call. */
export interface BillingOverviewResponse {
  subscription: SubscriptionSummary | null;
  plans: PlanSummary[];
  invoices: InvoiceSummary[];
  currency: string;
}

/**
 * How the customer pays, when a widget is mounted on our own page.
 *
 * ⚠️ THE ONE EXCEPTION TO "THE CLIENT CANNOT NAME A PROVIDER" AT THE TOP OF THIS
 *    FILE, AND IT IS NARROW ON PURPOSE.
 *
 *   A widget cannot be rendered without loading that provider's script and
 *   identifying the merchant to it, so `provider` has to reach the browser. What
 *   does NOT change: the client still cannot CHOOSE an acquirer — there is no
 *   request field for it, `PAYMENT_PROVIDER` is server configuration, and so is
 *   whether this object is returned at all.
 *
 *   `publicKey` is the provider's publishable key. If a value that needs
 *   protecting ever appears in this interface, the flow is wrong, not the type.
 */
export interface EmbeddedCheckout {
  provider: string;
  publicKey: string;
  token: string;
}

/**
 * What to do with the customer next.
 *
 * Exactly one of `redirectUrl` and `embedded` is present on a charge that needs
 * the customer: send the browser there, or mount the widget here. BOTH absent
 * with status SUCCEEDED means it was taken off-session against a mandate and
 * there is nothing to show. Both absent with status PENDING should not happen
 * and is a bug in the adapter, not a state the screen has to render.
 */
/**
 * What the customer is buying, as the invoice states it.
 *
 * Sent so the checkout screen can show the purchase without deriving any of it.
 * A screen that computes its own service period will eventually disagree with
 * the invoice — over a month boundary, a leap day, or a plan renamed between the
 * two reads — and the customer is then reading one set of facts and paying for
 * another.
 */
export interface PurchaseSummary {
  description: string;
  /** ISO dates. The service period this payment covers. */
  periodStart: string;
  periodEnd: string;
  invoiceNumber: string;
  /** What is supplied, before tax. */
  subtotalMinor: number;
  /** One per tax the jurisdiction charges — CGST and SGST are two lines. */
  taxLines: { name: string; rateBps: number; amountMinor: number }[];
  taxTotalMinor: number;
  /** Subtotal plus tax. What is actually charged. */
  totalMinor: number;
  /**
   * Why the tax is what it is, in one sentence.
   *
   * Shown whenever there is no tax to show. A zero-tax total with no explanation
   * is indistinguishable from a bug to the person reading it, and somebody will
   * eventually have to answer "why was I not charged GST?" from a screenshot.
   */
  taxNote: string;
}

export interface CheckoutResponse {
  intentId: string;
  /**
   * The billing contact, echoed back for the checkout widget's prefill.
   *
   * ⚠️ THE BILLING CONTACT — WHO IS THE SIGNED-IN USER — AND NEVER A PATIENT.
   *   It is `customerFrom(actor)`, i.e. the person doing the buying, so this is
   *   their own details returned to their own browser. Nothing patient-derived
   *   reaches it; see `CustomerDetails` in @rcln/payments.
   *
   * Not decoration: Razorpay offers a REDUCED set of UPI options to a checkout
   * with no contact prefilled, which is what hides the "UPI ID" field behind the
   * QR. It also spares the customer retyping what we already know.
   */
  customer?: { name: string; email: string; phone?: string | undefined };
  redirectUrl?: string;
  embedded?: EmbeddedCheckout;
  purchase?: PurchaseSummary;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amountMinor: number;
  currency: string;
  invoiceId?: string;
}

export interface ProrationSummary {
  periodDays: number;
  remainingDays: number;
  creditMinor: number;
  chargeMinor: number;
  /** The prorated supply, BEFORE tax. */
  amountDueMinor: number;
  isFree: boolean;
}

export interface UpgradeQuoteResponse {
  /**
   * Tax on the prorated amount, and what is actually collected.
   *
   * ⚠️ `proration.amountDueMinor` IS THE NET. It was previously shown as "Due
   *   today", which under-quoted every taxed upgrade — the customer read ₹4,999
   *   and was asked for ₹5,898.82. `totalDueMinor` is the figure to put next to
   *   a pay button; the lines are for the breakdown above it.
   */
  taxLines: { name: string; rateBps: number; amountMinor: number }[];
  taxTotalMinor: number;
  totalDueMinor: number;
  taxNote: string;
  fromPlan: { id: string; code: string; name: string };
  toPlan: { id: string; code: string; name: string };
  toPlanPriceId: string;
  currency: string;
  /** The full period price, for context beside the prorated figure. */
  fullAmountMinor: number;
  proration: ProrationSummary;
  effectiveAt: string;
  /** Unchanged by an upgrade. Shown so the customer can see it does not move. */
  nextRenewalAt: string;
}

export interface MandateSetupResponse {
  mandateId: string;
  redirectUrl?: string;
}

/**
 * The state of a payment authorisation.
 *
 * What the return page polls after the customer comes back from authorising.
 * PENDING is the normal state for a minute or two — an eNACH or UPI Autopay
 * mandate needs the customer's bank to confirm, and that is not instant. Only
 * CANCELLED and FAILED are bad news.
 */
export interface MandateStatusResponse {
  mandateId: string;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'FAILED';
  method: string | null;
  instrumentLabel: string | null;
  maxAmountMinor: number;
  currency: string;
  activatedAt: string | null;
}

/**
 * The answer the return page polls for.
 *
 * PENDING is the common case for a minute or two — a UPI collect sits there
 * while somebody opens their banking app — so the screen waits rather than
 * declaring failure. Only FAILED and EXPIRED are bad news.
 */
export interface PaymentStatusResponse {
  intentId: string;
  status: 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  purpose: 'SUBSCRIPTION_START' | 'UPGRADE' | 'RENEWAL' | 'MANDATE_SETUP' | 'INVOICE_PAYMENT';
  amountMinor: number;
  currency: string;
  failureMessage: string | null;
  /** Present once settled, so the screen can link to the receipt. */
  invoiceId: string | null;
}

export interface AutoRenewResponse {
  autoRenew: boolean;
}

export interface CancelSubscriptionResponse {
  status: string;
  /** When access actually stops. `now` for an immediate cancellation. */
  endsAt: string;
}

export interface ResumeSubscriptionResponse {
  nextRenewalAt: string;
}

/**
 * The platform console's view of one clinic's billing.
 *
 * Read-only, and it carries no instrument details beyond what the tenant already
 * sees — a support desk needs to know whether a clinic is past due, not what
 * card it holds.
 */
export interface PlatformSubscriptionView {
  organizationId: string;
  subscription: SubscriptionSummary | null;
  invoices: InvoiceSummary[];
}

// ---------------------------------------------------------------------------
// Platform: where rcln collects tax
// ---------------------------------------------------------------------------

/**
 * Adding a jurisdiction rcln is registered to collect tax in.
 *
 * ⚠️ A ROW HERE IS A LEGAL ASSERTION, NOT A SETTING.
 *   It says we hold a registration with that authority. From the moment it
 *   exists, every clinic whose place of supply it covers is charged — and tax
 *   collected without a registration cannot be remitted, because there is
 *   nobody to remit it to. The console says so; this comment is here so the
 *   next person to widen this contract knows what it is for.
 *
 * COUNTRY-WIDE AND REGION-SPECIFIC ARE BOTH FIRST-CLASS
 *   `regionCode` omitted (or blank) means the whole country — one national VAT
 *   number, which is how most regimes work. `regionCode` set means that
 *   subdivision only, which is how India (a GSTIN per state) and the US work.
 *   Holding both is normal and meaningful: the region-specific row wins for a
 *   customer in that region, and the country-wide row covers everyone else.
 */
export const createTaxRegistrationRequest = z.object({
  /** ISO 3166-1 alpha-2. Stored and compared uppercase. */
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'two letters, like IN or IE')
    .transform((value) => value.toUpperCase()),
  /**
   * ISO 3166-2 subdivision WITHOUT the country prefix — `KA`, not `IN-KA`.
   *
   * Empty string is accepted and normalised to null, because an untouched
   * optional text input submits `''` and "no region" is the common case rather
   * than the exceptional one.
   */
  regionCode: z
    .string()
    .max(10)
    .regex(/^[A-Za-z0-9-]*$/, 'letters, digits and hyphens only')
    .transform((value) => value.toUpperCase())
    .optional()
    .transform((value) => (value ? value : null))
    .nullable(),
  scheme: z.enum(['GST', 'VAT', 'SALES_TAX']),
  /** Our number with that authority. Printed on every invoice it covers. */
  registrationNumber: z.string().trim().min(3).max(64),
  /**
   * The rate, in basis points. 18% is 1800.
   *
   * Basis points and not a percentage for the same reason money crosses this
   * file in minor units: an integer survives a JSON round-trip and a rate of
   * 17.5% expressed as a float does not reliably.
   */
  standardRateBps: z.number().int().min(0).max(10_000),
  /**
   * When the registration took effect.
   *
   * Load-bearing rather than decorative: a supply made before this date is not
   * taxable by us even though the row exists, which is exactly the situation on
   * the first invoices after registering.
   */
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  /** When it lapsed, if it has. Null means still live. */
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
    .optional()
    .transform((value) => (value ? value : null))
    .nullable(),
});

export type CreateTaxRegistrationRequest = z.infer<typeof createTaxRegistrationRequest>;

/** Every field editable. The jurisdiction itself included — a typo in a country
 *  code is exactly the thing somebody needs to fix, and the unique index still
 *  refuses a move that would collide with an existing registration. */
export const updateTaxRegistrationRequest = createTaxRegistrationRequest.partial();
export type UpdateTaxRegistrationRequest = z.infer<typeof updateTaxRegistrationRequest>;

export interface TaxRegistrationSummary {
  id: string;
  countryCode: string;
  /** Null means the whole country. */
  regionCode: string | null;
  scheme: 'GST' | 'VAT' | 'SALES_TAX';
  registrationNumber: string;
  standardRateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Whether it applies today — derived from the dates, never stored. */
  isLive: boolean;
  /** `IN-KA` or `IN`. What it matches against a clinic's place of supply. */
  placeOfSupply: string;
}

export interface TaxRegistrationListResponse {
  registrations: TaxRegistrationSummary[];
}

// ---------------------------------------------------------------------------
// Default tax rules — the rate cards rcln maintains per country
// ---------------------------------------------------------------------------

/**
 * A row in the catalogue every clinic inherits until it overrides it.
 *
 * ⚠️ NOT A `tax_registration`, AND NOT A CLAIM THAT ANYBODY IS REGISTERED.
 *   A registration says "rcln collects tax here"; one of these says only "this
 *   country taxes this kind of thing this way". It has no effect at all on a
 *   clinic holding no registration of its own — the engine asks whether tax may
 *   be charged before it ever asks at what rate.
 *
 * ⚠️ BUT A WRONG ROW HERE IS WRONG INVOICES FOR EVERY CLINIC IN A COUNTRY AT
 *   ONCE, silently, because an inherited default looks configured. That is why
 *   `sourceNote` is required on create rather than optional: a rate with no
 *   stated basis cannot be reviewed by the next person, and this table is
 *   maintained by whoever is on shift when a rate notification lands.
 */
export const createTaxRuleDefaultRequest = z.object({
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'two letters, like IN or IE')
    .transform((value) => value.toUpperCase()),
  /** ISO 3166-2 without the country prefix. Null/empty means country-wide. */
  regionCode: z
    .string()
    .max(10)
    .regex(/^[A-Za-z0-9-]*$/, 'letters, digits and hyphens only')
    .transform((value) => value.toUpperCase())
    .optional()
    .transform((value) => (value ? value : null))
    .nullable(),
  scheme: z.enum(['GST', 'VAT', 'SALES_TAX']),
  /** The item key. An HSN/SAC code or a category. Matched EXACTLY. */
  taxCategory: z.string().trim().min(1).max(64),
  description: z.string().trim().max(255).optional().nullable(),
  /** Basis points. 5% is 500. Must be 0 unless the treatment is STANDARD. */
  rateBps: z.number().int().min(0).max(10_000),
  /**
   * ⚠️ Only the three an ITEM can be. `REVERSE_CHARGE` is a fact about two
   *   parties and `NOT_REGISTERED` / `UNRATED` / `PROVIDER_REQUIRED` are facts
   *   about the issuer — none is something a consultation can be. Mirrored by a
   *   CHECK constraint, which is what holds when a row arrives from psql.
   */
  treatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']).default('STANDARD'),
  /** What the authority calls it. Printed verbatim; "Tax" is compliant nowhere. */
  lineName: z.string().trim().min(1).max(32),
  /** The state half's name when splitting. Null derives `S` + lineName. */
  regionalLineName: z.string().trim().max(32).optional().nullable(),
  /** `INTRA_STATE_HALVES` is India's constitutional split and nothing else. */
  split: z.enum(['NONE', 'INTRA_STATE_HALVES']).default('NONE'),
  /** Charges IN ADDITION to the country-wide rule — Canada's provincial taxes. */
  stacks: z.boolean().default(false),
  /** Where the figure came from, in words a reviewer can check. */
  sourceNote: z.string().trim().min(1).max(500),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
    .optional()
    .transform((value) => (value ? value : null))
    .nullable(),
});

export type CreateTaxRuleDefaultRequest = z.infer<typeof createTaxRuleDefaultRequest>;

/**
 * ⚠️ THE DEFAULTED FIELDS ARE RE-DECLARED WITHOUT THEIR DEFAULTS, BECAUSE
 *   `.partial()` KEEPS THEM AND THAT IS A SILENT REWRITE. Zod's `.partial()`
 *   makes a key optional and leaves any `.default()` in place, so a PATCH sending
 *   only `{ description }` parses to `{ description, treatment: 'STANDARD',
 *   split: 'NONE', stacks: false }` — and `updateTaxRuleDefault` writes exactly
 *   the keys it receives. Renaming India's split GST rule would have unsplit it,
 *   and unsplitting a rule in this table changes what every clinic in the country
 *   charges. Found while building the tenant equivalent in `tax.ts`; the same
 *   note is on that one.
 */
export const updateTaxRuleDefaultRequest = createTaxRuleDefaultRequest.partial().extend({
  treatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']).optional(),
  split: z.enum(['NONE', 'INTRA_STATE_HALVES']).optional(),
  stacks: z.boolean().optional(),
});
export type UpdateTaxRuleDefaultRequest = z.infer<typeof updateTaxRuleDefaultRequest>;

export interface TaxRuleDefaultSummary {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: 'GST' | 'VAT' | 'SALES_TAX';
  taxCategory: string;
  description: string | null;
  rateBps: number;
  treatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  lineName: string;
  regionalLineName: string | null;
  split: 'NONE' | 'INTRA_STATE_HALVES';
  stacks: boolean;
  sourceNote: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Whether it applies today — derived from the dates, never stored. */
  isLive: boolean;
  /** `IN-KA` or `IN`. What it matches against a clinic's place of supply. */
  jurisdiction: string;
}

export interface TaxRuleDefaultListResponse {
  defaults: TaxRuleDefaultSummary[];
}
