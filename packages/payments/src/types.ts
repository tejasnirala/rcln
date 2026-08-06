/**
 * The payment provider seam.
 *
 * THE POINT OF THIS FILE
 *   Everything above it — the billing engine, the API, the screens — is written
 *   against these types and has never heard of Cashfree. Swapping provider is
 *   then a new file under `providers/`, one line in the registry and an
 *   environment variable; it is not a change to the domain, the schema or the
 *   UI. That property only survives if nothing provider-shaped leaks through
 *   here, so:
 *
 *   - No provider's status strings. Statuses are normalised to the small closed
 *     sets below. `ACTIVE` means the same thing whoever is charging the card.
 *   - No provider's field names, and no `any`-shaped passthrough. `raw` exists
 *     for logging and support, and callers must not branch on it.
 *   - No HTTP. A provider that needs a redirect returns a URL; how the caller
 *     gets the customer there is the caller's business.
 *
 * WHAT A PROVIDER IS RESPONSIBLE FOR
 *   Talking to its API, verifying its own webhook signatures, and translating
 *   both directions. Nothing else. It holds no database handle, writes no rows,
 *   and decides no billing policy — proration, dunning and cancellation live in
 *   `@rcln/billing`, because they are the same rules whoever the acquirer is.
 *
 * IDEMPOTENCY IS THE CALLER'S KEY, NOT THE PROVIDER'S
 *   Every mutating call takes a `reference` the caller owns (a `payment_intents`
 *   row id). It is sent as the provider's order id where the provider allows a
 *   merchant-supplied one, and it comes back on the webhook. That is what makes
 *   a retried charge safe and a webhook attributable — never the provider's own
 *   id, which we do not know at the moment we need to be idempotent.
 */

/** Providers with an implementation in this package. */
export const PROVIDERS = ['cashfree', 'razorpay', 'mock'] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * What this provider can actually do, declared rather than discovered.
 *
 * The billing engine reads this to decide whether to offer auto-renewal at all.
 * Discovering "this provider cannot hold a mandate in EUR" by watching a renewal
 * fail at 03:00 is the failure mode this exists to prevent.
 */
export interface ProviderCapabilities {
  /** Can hold an authorisation for future off-session debits. */
  mandates: boolean;
  /** Currencies checkout accepts. `'*'` means "anything the caller prices in". */
  chargeCurrencies: readonly string[] | '*';
  /**
   * Currencies a mandate can be *held* in, which is routinely narrower than the
   * ones a one-off charge accepts — Cashfree is exactly this case.
   */
  mandateCurrencies: readonly string[];
  refunds: boolean;
  /** Currency the merchant is actually paid in, if it differs. Informational. */
  settlementCurrency?: string;
  /**
   * Can hand back a token our own page renders a widget against, instead of a
   * URL to send the browser to.
   *
   * Declared rather than discovered, like everything else here: the checkout
   * screen reads it to decide whether to mount a widget or fall back to the
   * redirect, so a provider without one degrades to a hosted page rather than
   * rendering an empty div.
   */
  embeddedCheckout: boolean;
}

// ---------------------------------------------------------------------------
// Normalised statuses
// ---------------------------------------------------------------------------

/**
 * PENDING is not a failure and must never be treated as one. A UPI collect
 * request sits here for minutes while a human opens their banking app; a
 * checkout page abandoned mid-flow sits here until it expires. Only EXPIRED and
 * FAILED are terminal-unsuccessful.
 */
export type ChargeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/**
 * PENDING covers "the customer has been shown the authorisation page and has not
 * finished". ACTIVE is the only state a debit may be attempted from.
 */
export type MandateStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'FAILED';

export type RefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

/** How the money moved. Free-form across providers, so kept coarse. */
export type PaymentMethodKind =
  'CARD' | 'UPI' | 'NETBANKING' | 'WALLET' | 'BANK_TRANSFER' | 'OTHER';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Who is paying.
 *
 * ⚠️ THIS IS THE BILLING CONTACT, NEVER A PATIENT.
 *   The name and email here belong to whoever administers the clinic's
 *   subscription. Nothing patient-derived may be placed in these fields, on this
 *   or any other object crossing into a provider's systems.
 */
export interface CustomerDetails {
  /** Our stable id for this payer — the organization id. */
  reference: string;
  name: string;
  email: string;
  /** E.164. Several Indian methods (UPI collect, some netbanking) require it. */
  phone?: string | undefined;
  /** ISO 3166-1 alpha-2, for the provider's own routing and risk checks. */
  countryCode?: string | undefined;
}

export interface CreateChargeInput {
  /** Our id for this attempt, and the idempotency key. See the header. */
  reference: string;
  amountMinor: number;
  currency: string;
  customer: CustomerDetails;
  /** Shown to the customer on the hosted page and on their statement where possible. */
  description: string;
  /** Where the provider sends the browser when the customer is done. */
  returnUrl: string;
  /** Where the provider POSTs the outcome. Authoritative; the return is not. */
  webhookUrl?: string | undefined;
  /** After this the hosted page must stop accepting payment. */
  expiresAt?: Date | undefined;
  /**
   * Charge an existing authorisation instead of showing a page. When set, the
   * call is off-session and must not return a redirect.
   */
  mandateId?: string | undefined;
  /**
   * Whether the customer is going to the provider, or the provider is coming to
   * our page.
   *
   * ⚠️ SERVER CONFIGURATION, NOT A CLIENT CHOICE. It arrives from
   *   `BillingRuntime`, which reads it from the deployment's environment. A
   *   client that could pick this could pick the weaker of the two flows, and
   *   the contract in `@rcln/contracts` deliberately has no field for it.
   *
   * `redirect` is the default and the floor: every provider supports it, and
   *   a provider whose `embeddedCheckout` is false ignores this entirely.
   */
  presentation?: 'redirect' | 'embedded' | undefined;
}

export interface CreateMandateInput {
  reference: string;
  currency: string;
  customer: CustomerDetails;
  description: string;
  returnUrl: string;
  webhookUrl?: string | undefined;
  /**
   * The ceiling the customer authorises, not the amount charged.
   *
   * Set from the plan's price with headroom, because a mandate is taken once and
   * has to survive a later price rise and an upgrade to a dearer plan. Too tight
   * and every renewal after a change fails; the customer sees the ceiling on the
   * authorisation screen, so too loose is a trust problem rather than a
   * technical one.
   */
  maxAmountMinor: number;
  /** How often we intend to debit. Some providers bake this into the mandate. */
  interval: 'MONTH' | 'YEAR';
  /** When the authorisation should lapse if never revoked. */
  expiresAt?: Date | undefined;
}

export interface RefundInput {
  reference: string;
  /** The provider's id for the charge being refunded. */
  providerChargeId: string;
  amountMinor: number;
  currency: string;
  reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * `raw` on every result is the provider's own payload, for the support desk and
 * the logs. It is deliberately `unknown`: reading it requires a cast, which is a
 * visible act a reviewer can object to, rather than a property access that
 * quietly re-couples the engine to one provider.
 */
export interface ChargeResult {
  provider: ProviderName;
  /** Our reference, echoed back. Present whenever the provider preserved it. */
  reference: string | null;
  providerChargeId: string;
  status: ChargeStatus;
  amountMinor: number;
  currency: string;
  method?: PaymentMethodKind | undefined;
  /** Last four digits or a UPI handle's suffix. Never a full instrument. */
  instrumentLabel?: string | undefined;
  paidAt?: Date | undefined;
  /** Provider's own failure code and message, for the support desk. */
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
  raw?: unknown;
}

/**
 * Everything our own checkout page needs to mount a provider's widget.
 *
 * ⚠️ THIS IS THE ONE PLACE A PROVIDER'S NAME LEGITIMATELY CROSSES INTO THE
 *    CLIENT, AND IT IS A CONCESSION RATHER THAN A DESIGN.
 *
 *   An embedded checkout cannot be provider-agnostic in the browser: rendering a
 *   widget means loading THAT provider's script and identifying the merchant to
 *   it. So `provider` is here, and `apps/web` switches on it — in exactly one
 *   component directory, which is the frontend mirror of `providers/` and the
 *   whole of the leak. If it ever appears anywhere else in `apps/web`, that is
 *   the bug.
 *
 *   The properties that DO survive: the client still cannot choose an acquirer
 *   (see `presentation` above), still never sends an amount, and the outcome is
 *   still settled by a signed webhook rather than by anything the browser says.
 */
export interface EmbeddedCheckout {
  /** Which provider's widget to mount. */
  provider: ProviderName;
  /**
   * The provider's PUBLISHABLE key — the one meant to be read by anybody.
   *
   * Never the API secret. A provider whose widget needs a genuine secret in the
   * browser is a provider whose widget we do not use.
   */
  publicKey: string;
  /** The provider's handle for this attempt: an order id, a session token. */
  token: string;
}

/** A charge that needs the customer present. */
export interface HostedCharge extends ChargeResult {
  /**
   * Send the browser here.
   *
   * Absent for an off-session mandate debit, and absent when `embedded` is
   * present instead. Exactly one of the two is set on a customer-present charge.
   */
  redirectUrl?: string | undefined;
  /**
   * Mount a widget on our own page instead of sending the browser away. Set only
   * when the caller asked for `presentation: 'embedded'` AND the provider
   * declares `embeddedCheckout`.
   */
  embedded?: EmbeddedCheckout | undefined;
  /**
   * A provider's own session handle, where it hands one back as well as a URL.
   *
   * Informational and unrendered — `embedded.token` is what the checkout page
   * actually uses. Kept because it is the id a support desk quotes at Cashfree.
   */
  sessionToken?: string | undefined;
}

export interface MandateResult {
  provider: ProviderName;
  reference: string | null;
  providerMandateId: string;
  status: MandateStatus;
  currency: string;
  maxAmountMinor?: number | undefined;
  method?: PaymentMethodKind | undefined;
  instrumentLabel?: string | undefined;
  activatedAt?: Date | undefined;
  expiresAt?: Date | undefined;
  raw?: unknown;
}

export interface HostedMandate extends MandateResult {
  /** Where the customer authorises the mandate. */
  redirectUrl?: string | undefined;
  sessionToken?: string | undefined;
}

export interface RefundResult {
  provider: ProviderName;
  reference: string | null;
  providerRefundId: string;
  providerChargeId: string;
  status: RefundStatus;
  amountMinor: number;
  currency: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * The raw request, before any parsing.
 *
 * `body` is a Buffer and not a parsed object because every provider signs the
 * bytes it sent. `JSON.parse` followed by `JSON.stringify` reorders keys and
 * changes whitespace, and the signature then fails for reasons that look like a
 * wrong secret. The Express route therefore mounts `express.raw()` for this path
 * only — see the header of the webhook router.
 */
export interface RawWebhook {
  body: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The closed set of things we act on.
 *
 * `unknown` is a first-class member, not an error: providers add event types
 * without asking, and receiving one must be a no-op that is acknowledged with a
 * 200 — not a 500 that makes the provider retry forever and eventually disable
 * the endpoint.
 */
export type WebhookEventType =
  | 'charge.succeeded'
  | 'charge.failed'
  | 'charge.pending'
  | 'mandate.activated'
  | 'mandate.cancelled'
  | 'mandate.failed'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'unknown';

export interface WebhookEvent {
  provider: ProviderName;
  /**
   * The provider's own event id, which is the deduplication key.
   *
   * Providers retry, and at-least-once is the only delivery guarantee any of
   * them offers. When a provider sends no id, the adapter synthesises a stable
   * one by hashing the signed bytes — two identical deliveries then collide on
   * the unique index, which is exactly what is wanted.
   */
  id: string;
  type: WebhookEventType;
  occurredAt: Date;
  /** Our reference, when the event carries one. */
  reference: string | null;
  charge?: ChargeResult | undefined;
  mandate?: MandateResult | undefined;
  refund?: RefundResult | undefined;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

export interface PaymentProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /**
   * Start a payment.
   *
   * With `mandateId` set this is an off-session debit and resolves to a terminal
   * or pending charge with no redirect. Without it, the customer must be sent to
   * `redirectUrl`.
   */
  createCharge(input: CreateChargeInput): Promise<HostedCharge>;

  /**
   * The authoritative state of a charge, asked directly.
   *
   * The return URL is a hint from a browser and is trivially forged; the webhook
   * can be late. Anything that grants entitlement calls this first.
   */
  getCharge(providerChargeId: string): Promise<ChargeResult>;

  /** Ask the customer to authorise future debits. */
  createMandate(input: CreateMandateInput): Promise<HostedMandate>;
  getMandate(providerMandateId: string): Promise<MandateResult>;
  /** Revoke. Must be idempotent — an already-cancelled mandate is not an error. */
  cancelMandate(providerMandateId: string): Promise<MandateResult>;

  refund(input: RefundInput): Promise<RefundResult>;

  /** Verify the signature and normalise. Throws `WebhookVerificationError`. */
  parseWebhook(input: RawWebhook): WebhookEvent;
}
