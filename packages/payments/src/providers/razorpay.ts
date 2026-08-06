/**
 * Razorpay — the second implementation of `PaymentProvider`.
 *
 * ⚠️ NOT YET EXERCISED AGAINST A LIVE SANDBOX.
 *   Written against Razorpay's published Payment Links, Orders, Recurring
 *   Payments and Webhooks documentation. Every request and response shape here
 *   is from the documentation, not from a captured session. Before pointing
 *   production at it, run the flows in test mode and reconcile the field names —
 *   the failure mode of a renamed field is an `undefined` amount, not an error.
 *   Until then `PAYMENT_PROVIDER=mock` is the tested path. The webhook signature
 *   scheme IS pinned by tests, because that is the part that fails first and
 *   fails identically to a wrong secret.
 *
 * FOUR WAYS IT DIFFERS FROM CASHFREE, ALL OF THEM LOAD-BEARING
 *
 *   1. AMOUNTS ARE ALREADY MINOR UNITS. Razorpay quotes paise as an integer, so
 *      there is no `toMajorString` round-trip here and no place for a decimal to
 *      go missing. `amountMinor` goes on the wire unchanged.
 *
 *   2. THERE IS NO SANDBOX HOST. Test and live are the SAME base URL, selected
 *      by the key's `rzp_test_` / `rzp_live_` prefix. A live key in a staging
 *      deployment therefore takes real money from real cards with nothing in the
 *      URL to notice, so the constructor refuses a key whose prefix disagrees
 *      with the declared environment. That guard is the only thing standing
 *      between a copy-pasted key and a real charge.
 *
 *   3. THE WEBHOOK SECRET IS SEPARATE AND MANDATORY. Cashfree signs with the API
 *      secret unless told otherwise, so an absent signing secret falls back.
 *      Razorpay's is chosen by the merchant when the webhook is created in the
 *      dashboard and is unrelated to the API secret — there is nothing to fall
 *      back to, so a missing one is a configuration error at construction rather
 *      than a 401 on every delivery.
 *
 *   4. THE SIGNATURE DOES NOT COVER A TIMESTAMP, so it cannot expire. See the
 *      long comment on `parseWebhook` — replay protection here is the event-id
 *      ledger, deliberately, and adding a time window would break Razorpay's
 *      24-hour retry schedule.
 *
 * WHICH RAZORPAY PRODUCTS, AND WHY NOT THE OBVIOUS ONES
 *   `createCharge` uses **Payment Links**, not Orders + Checkout.js. The seam in
 *   `types.ts` says a provider that needs the customer present returns a URL;
 *   Razorpay's standard checkout is a JS widget with no URL, and adopting it
 *   would push a Razorpay script into `apps/web` and put the provider's name in
 *   a screen. Payment Links are the same rails behind a hosted page.
 *
 *   `createMandate` uses an **auth link** (`subscription_registration/auth_links`)
 *   rather than Razorpay Subscriptions. Subscriptions carry their own plan and
 *   their own cycle, and ADR-0013 says we own the billing clock. The auth link
 *   is Razorpay's mandate-holder-only product: it authorises a ceiling with
 *   `frequency: as_presented` and never decides when a clinic is billed. A
 *   renewal is then `createCharge` WITH a mandate, which becomes a recurring
 *   debit against the resulting token.
 *
 * THE MANDATE ID CHANGES SHAPE ONCE, ON PURPOSE
 *   A mandate does not have a usable id until the customer has authorised it: at
 *   creation there is only the auth link's invoice (`inv_…`), and the thing a
 *   debit actually needs is a token plus the customer that owns it. So
 *   `providerMandateId` is the invoice id while PENDING and becomes
 *   `cust_…:token_…` on activation — `applyMandateResult` writes back whatever
 *   the activation event carries, which is what makes that transition safe.
 *   `getMandate` and `cancelMandate` accept both forms; see `splitMandateId`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentConfigurationError,
  PaymentDeclinedError,
  PaymentProviderError,
  PaymentUnavailableError,
  WebhookVerificationError,
} from '../errors.js';
import { money } from '../money.js';
import type {
  ChargeResult,
  ChargeStatus,
  CreateChargeInput,
  CreateMandateInput,
  CustomerDetails,
  HostedCharge,
  HostedMandate,
  MandateResult,
  MandateStatus,
  PaymentMethodKind,
  PaymentProvider,
  ProviderCapabilities,
  RawWebhook,
  RefundInput,
  RefundResult,
  WebhookEvent,
  WebhookEventType,
} from '../types.js';
import {
  arr,
  blankToUndefined,
  headerValue,
  num,
  obj,
  str,
  unixDate,
  type Json,
} from './shared.js';

/**
 * One base URL for both modes. See difference (2) in the header — this is not an
 * oversight, it is how Razorpay works, and it is why `assertKeyMatchesEnvironment`
 * exists.
 */
const API_BASE = 'https://api.razorpay.com/v1';

const KEY_PREFIX = { sandbox: 'rzp_test_', production: 'rzp_live_' } as const;

/**
 * Razorpay refuses a payment link expiring sooner than this, with a 400 that
 * reads as a validation failure on `expire_by`. The caller's `expiresAt` comes
 * from our own checkout policy and can legitimately be shorter, so it is clamped
 * rather than rejected: a checkout window slightly longer than we asked for is
 * harmless, a checkout that cannot be created is not.
 */
const MIN_LINK_LIFETIME_SECONDS = 16 * 60;

/** Razorpay's field limits, applied here so a long clinic name is not a 400. */
const LIMITS = { description: 2048, receipt: 40, note: 255 } as const;

export interface RazorpayConfig {
  /** `rzp_test_…` or `rzp_live_…`. Its prefix selects test or live mode. */
  keyId: string;
  keySecret: string;
  /**
   * The secret entered when creating the webhook in the Razorpay dashboard.
   *
   * NOT the API secret and NOT optional — see difference (3) in the header.
   */
  webhookSecret: string;
  /**
   * Declared, and checked against the key's prefix. It selects no host; it exists
   * so that a live key in a non-production deployment fails at boot.
   */
  environment: 'sandbox' | 'production';
  /**
   * Which rail a mandate is taken on.
   *
   * `upi` (UPI Autopay) is the default because it has the widest coverage in
   * India and needs no bank-side registration from the payer. `emandate` is
   * netbanking-based and settles more reliably for larger amounts but requires
   * the bank to support it; `card` is a card-on-file mandate and is the only one
   * of the three a customer without an Indian bank account can use.
   */
  mandateMethod?: 'upi' | 'emandate' | 'card' | undefined;
  /**
   * What the authorisation transaction itself charges, in minor units.
   *
   * Zero is a genuine zero-amount authorisation and is what UPI Autopay and
   * e-mandate use. Some card issuers will not authorise for zero and need a
   * token charge — ₹1, refunded automatically by Razorpay — which is why this is
   * a knob rather than a constant. It is NOT the ceiling; the ceiling is
   * `maxAmountMinor` on the input.
   */
  mandateAuthAmountMinor?: number | undefined;
  /** Per-request timeout. A gateway that has not answered in 20s will not. */
  timeoutMs?: number | undefined;
  /** Override the API host. For a local stub; never set in a deployment. */
  apiBaseUrl?: string | undefined;
}

// ---------------------------------------------------------------------------
// Status tables
// ---------------------------------------------------------------------------

/**
 * A payment's own lifecycle.
 *
 * `refunded` maps to SUCCEEDED and that is deliberate: the money DID move, and a
 * refund is a separate event with its own row. Mapping it to FAILED would make a
 * refunded invoice look unpaid and re-trigger dunning.
 */
const PAYMENT_STATUS: Readonly<Record<string, ChargeStatus>> = {
  created: 'PENDING',
  // Authorised but not captured. Everything here is created with auto-capture,
  // so this is a moment in flight, not an outcome.
  authorized: 'PENDING',
  captured: 'SUCCEEDED',
  refunded: 'SUCCEEDED',
  failed: 'FAILED',
};

/** A payment link's lifecycle. `partially_paid` is not payment — see below. */
const LINK_STATUS: Readonly<Record<string, ChargeStatus>> = {
  created: 'PENDING',
  /*
   * Someone paid less than the invoice.
   *
   * PENDING, not SUCCEEDED. `settleIntent` refuses a payment smaller than the
   * amount due anyway, so mapping this to SUCCEEDED would only move the refusal
   * one layer later and record a successful charge that did not cover the bill.
   */
  partially_paid: 'PENDING',
  paid: 'SUCCEEDED',
  cancelled: 'CANCELLED',
  expired: 'EXPIRED',
};

const ORDER_STATUS: Readonly<Record<string, ChargeStatus>> = {
  created: 'PENDING',
  attempted: 'PENDING',
  paid: 'SUCCEEDED',
};

/**
 * A recurring token's state, which is what a mandate actually is here.
 *
 * Read from `recurring_details.status` where present and from the token's own
 * `status` otherwise — the two disagree in the window between authorisation and
 * the bank confirming an e-mandate, and `recurring_details` is the one that says
 * whether a debit may be attempted.
 */
const TOKEN_STATUS: Readonly<Record<string, MandateStatus>> = {
  initiated: 'PENDING',
  pending: 'PENDING',
  confirmed: 'ACTIVE',
  active: 'ACTIVE',
  paused: 'PAUSED',
  cancelled: 'CANCELLED',
  deleted: 'CANCELLED',
  rejected: 'FAILED',
  failed: 'FAILED',
  expired: 'CANCELLED',
};

/** The auth link's invoice, before there is a token to read. */
const INVOICE_STATUS: Readonly<Record<string, MandateStatus>> = {
  draft: 'PENDING',
  issued: 'PENDING',
  partially_paid: 'PENDING',
  paid: 'ACTIVE',
  cancelled: 'CANCELLED',
  expired: 'FAILED',
  deleted: 'CANCELLED',
};

const METHOD_KIND: Readonly<Record<string, PaymentMethodKind>> = {
  card: 'CARD',
  upi: 'UPI',
  netbanking: 'NETBANKING',
  wallet: 'WALLET',
  app: 'WALLET',
  bank_transfer: 'BANK_TRANSFER',
  nach: 'BANK_TRANSFER',
  emandate: 'BANK_TRANSFER',
  emi: 'CARD',
  cardless_emi: 'OTHER',
  paylater: 'OTHER',
};

/**
 * What KIND of thing an event is about — never what it says happened.
 *
 * The same shape as the Cashfree table and for the same reason: an event name
 * tells you which object moved, and only the payload says where it moved to. A
 * name that is not here becomes `unknown`, which is recorded in
 * `payment_webhook_events`, acknowledged with a 200, and visible to whoever adds
 * it. A 500 would make Razorpay retry for 24 hours and then disable the endpoint.
 */
type EventFamily = 'charge' | 'mandate' | 'refund' | 'informational';

const EVENT_FAMILY: Readonly<Record<string, EventFamily>> = {
  // -- Hosted checkout (Payment Links) ---------------------------------------
  'payment_link.paid': 'charge',
  'payment_link.partially_paid': 'charge',
  'payment_link.expired': 'charge',
  'payment_link.cancelled': 'charge',

  // -- The payment underneath, and the recurring debits, which have no link ---
  'payment.captured': 'charge',
  'payment.failed': 'charge',
  'payment.authorized': 'charge',
  'order.paid': 'charge',

  // -- Mandates --------------------------------------------------------------
  /**
   * The auth link was completed. THE event that activates a mandate: it is the
   * only one carrying our `receipt`, so it is the only one we can attribute.
   */
  'invoice.paid': 'mandate',
  'invoice.expired': 'mandate',
  'invoice.partially_paid': 'mandate',

  /*
   * ⚠️ RECORDED BUT NOT ATTRIBUTABLE — A KNOWN GAP, NOT AN OVERSIGHT.
   *   `token.*` fires when the CUSTOMER revokes a UPI Autopay mandate in their
   *   banking app, which is the one mandate change we do not initiate. The token
   *   entity carries no field we control, so unless Razorpay propagates the
   *   `notes` we set on the auth link (best-effort, read in `toEvent`) there is
   *   no reference and `dispatch` ignores it.
   *
   *   The consequence is bounded: the next renewal debit fails, dunning starts,
   *   and the clinic is told. The cost is that it is discovered a period late
   *   rather than the moment it happens. Closing it properly needs a lookup by
   *   provider mandate id, which is a webhook-service change and not an adapter
   *   one — `payment_mandates` already has `@@unique([provider, providerMandateId])`
   *   for it.
   */
  'token.confirmed': 'mandate',
  'token.rejected': 'mandate',
  'token.cancelled': 'mandate',
  'token.paused': 'mandate',
  'token.resumed': 'mandate',

  // -- Refunds ---------------------------------------------------------------
  'refund.created': 'refund',
  'refund.processed': 'refund',
  'refund.failed': 'refund',

  /*
   * Recorded, never acted on. `refund.speed_changed` is Razorpay downgrading an
   * instant refund to a normal one — the refund still lands, so there is nothing
   * to do, but the delivery record is the evidence of when it changed.
   *
   * `payment.pending` is the India-specific "the bank is thinking about it"
   * state for netbanking and some UPI collect flows. It is not a failure and
   * must not start dunning; the terminal event follows.
   */
  'refund.speed_changed': 'informational',
  'payment.pending': 'informational',
  'payment.dispute.created': 'informational',
  'settlement.processed': 'informational',
};

/** Razorpay signs the raw body only, hex-encoded. See `parseWebhook`. */
const SIGNATURE_HEADER = 'x-razorpay-signature';
/** Unique per event and stable across the retries — the deduplication key. */
const EVENT_ID_HEADER = 'x-razorpay-event-id';

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  /**
   * Declared, not discovered.
   *
   * `mandateCurrencies` is INR alone for the same reason it is on Cashfree: UPI
   * Autopay, e-mandate and Indian card mandates are domestic rails. Razorpay
   * will present a foreign cardholder a price in their own currency through
   * International Payments and settle to us in INR, so a clinic outside India
   * can pay each invoice — it just cannot be put on auto-renewal here, and the
   * billing engine reads that from this object rather than discovering it when a
   * renewal fails at 03:00.
   */
  readonly capabilities: ProviderCapabilities = {
    mandates: true,
    chargeCurrencies: '*',
    mandateCurrencies: ['INR'],
    refunds: true,
    settlementCurrency: 'INR',
    /*
     * Razorpay Standard Checkout, mounted on our own page.
     *
     * ⚠️ STANDARD CHECKOUT, NOT CUSTOM CHECKOUT — AND THAT IS A COMPLIANCE
     *    BOUNDARY, NOT A PREFERENCE.
     *
     *   The card number, expiry and CVV are entered inside Razorpay's overlay
     *   and go from the browser straight to Razorpay. They never touch our
     *   markup, our JS or our servers, which keeps this system at PCI DSS
     *   SAQ-A. Razorpay's Custom Checkout would let us render those fields
     *   ourselves, and would drag cardholder data into the same compliance
     *   boundary as PHI — two audits over one codebase, permanently, to control
     *   the styling of three inputs. If that is ever proposed, it needs an ADR
     *   and a reviewer, not a commit.
     */
    embeddedCheckout: true,
  };

  /*
   * Not `Required<RazorpayConfig>`: the optional fields are declared
   * `?: T | undefined` for exactOptionalPropertyTypes, and `Required` strips the
   * question mark while leaving the `| undefined`. Spelling out the resolved
   * shape is what makes every default below actually a default.
   */
  private readonly config: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    environment: 'sandbox' | 'production';
    mandateMethod: 'upi' | 'emandate' | 'card';
    mandateAuthAmountMinor: number;
    timeoutMs: number;
    apiBaseUrl: string;
  };

  private readonly authorization: string;

  constructor(config: RazorpayConfig) {
    // Trimmed before anything else. A value copied out of a dashboard routinely
    // carries a trailing newline, and an HMAC key that differs by one byte fails
    // in exactly the same way as the wrong key entirely.
    const keyId = blankToUndefined(config.keyId);
    const keySecret = blankToUndefined(config.keySecret);
    const webhookSecret = blankToUndefined(config.webhookSecret);

    if (!keyId || !keySecret) {
      throw new PaymentConfigurationError(
        'Razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. Set PAYMENT_PROVIDER=mock to run without them.'
      );
    }

    /*
     * No fallback, unlike Cashfree. Razorpay's webhook secret is whatever the
     * merchant typed into the dashboard when creating the webhook; the API
     * secret would verify nothing. Failing here rather than at the first
     * delivery means a missing secret stops a deployment instead of quietly
     * 401-ing every event until somebody notices no subscription ever activates.
     */
    if (!webhookSecret) {
      throw new PaymentConfigurationError(
        'Razorpay needs RAZORPAY_WEBHOOK_SECRET — the secret entered when creating the ' +
          'webhook in the Razorpay dashboard. It is not the API secret and there is nothing ' +
          'to fall back to; without it every delivery would be refused.'
      );
    }

    assertKeyMatchesEnvironment(keyId, config.environment);

    this.config = {
      keyId,
      keySecret,
      webhookSecret,
      environment: config.environment,
      mandateMethod: config.mandateMethod ?? 'upi',
      mandateAuthAmountMinor: config.mandateAuthAmountMinor ?? 0,
      timeoutMs: config.timeoutMs ?? 20_000,
      apiBaseUrl: (config.apiBaseUrl ?? API_BASE).replace(/\/$/, ''),
    };

    // Built once. Basic auth, which is all Razorpay's REST API offers.
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * One place that talks to Razorpay, so timeouts, auth and error classification
   * exist once.
   *
   * THE CLASSIFICATION IS THE IMPORTANT PART. A 4xx is a verdict and must not be
   * retried. A 5xx, a timeout or a dropped socket is *no verdict at all*: the
   * money may have moved, and the only safe response is to retry with the same
   * reference and then reconcile with `getCharge`. Collapsing the two is how a
   * customer is charged twice.
   */
  private async request<T = Json>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Json,
    options: { idempotencyKey?: string } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: this.authorization,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    /*
     * Razorpay documents this for refunds and ignores it elsewhere. Sent anyway
     * because an unrecognised header costs nothing, and NOT relied upon: the
     * genuine idempotency on orders and links is `receipt` / `reference_id`,
     * which is why `createCharge` recovers a duplicate rather than trusting a
     * header to have deduplicated for it.
     */
    if (options.idempotencyKey) headers['x-payment-idempotency'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      throw new PaymentUnavailableError(
        `Razorpay did not answer ${method} ${path}: ${cause instanceof Error ? cause.message : 'network error'}`,
        this.name
      );
    }

    const text = await response.text();
    let payload: Json = {};
    try {
      payload = text ? (JSON.parse(text) as Json) : {};
    } catch {
      if (response.ok) {
        throw new PaymentProviderError(
          `Razorpay returned a non-JSON body for ${method} ${path}`,
          this.name
        );
      }
    }

    if (response.ok) return payload as T;

    // `{ "error": { "code", "description", "reason", "source", "step" } }`
    const error = obj(payload, 'error');
    const code = str(error, 'code') ?? String(response.status);
    const description = str(error, 'description') ?? `Razorpay returned ${String(response.status)}`;

    if (response.status >= 500 || response.status === 429) {
      throw new PaymentUnavailableError(description, this.name, code);
    }
    throw new PaymentDeclinedError(description, this.name, code);
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(input: CreateChargeInput): Promise<HostedCharge> {
    if (input.mandateId) return this.chargeMandate(input, input.mandateId);
    if (input.presentation === 'embedded') return this.createEmbeddedCharge(input);

    const amount = money(input.amountMinor, input.currency);
    const reference = input.reference.slice(0, LIMITS.receipt);

    const payload: Json = {
      // Minor units, straight through. No decimal conversion anywhere here.
      amount: amount.amountMinor,
      currency: amount.currency,
      description: input.description.slice(0, LIMITS.description),
      /*
       * OUR id. Razorpay will not accept a merchant-supplied primary id, but
       * `reference_id` is unique per merchant — which makes it both the
       * idempotency key and the field that comes back on the webhook, and
       * therefore the thing the whole reconciliation hangs on.
       */
      reference_id: reference,
      customer: this.customerPayload(input.customer),
      /*
       * Razorpay charges per SMS and per email, and would send its own branded
       * notifications about a clinic's subscription. Our own notifications are
       * the product's job.
       */
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { reference },
      callback_url: input.returnUrl,
      callback_method: 'get',
      expire_by: this.linkExpiry(input.expiresAt),
    };

    let link: Json;
    try {
      link = await this.request('POST', '/payment_links', payload, {
        idempotencyKey: input.reference,
      });
    } catch (error) {
      /*
       * The retry path, and the reason `reference_id` is our own id.
       *
       * A `PaymentUnavailableError` above means the caller will retry with the
       * SAME reference. If the first attempt actually reached Razorpay, the
       * second is refused for a duplicate `reference_id` — which is a 4xx, and
       * would surface as a decline for a checkout that exists and is perfectly
       * payable. So a duplicate is recovered rather than reported.
       */
      const existing = await this.recoverLinkByReference(error, reference);
      if (!existing) throw error;
      link = existing;
    }

    const redirectUrl = str(link, 'short_url');
    if (!redirectUrl) {
      throw new PaymentProviderError(
        'Razorpay created a payment link without a short_url — there is nowhere to send the customer',
        this.name
      );
    }

    return {
      provider: this.name,
      reference: str(link, 'reference_id') ?? input.reference,
      providerChargeId: str(link, 'id') ?? input.reference,
      status: LINK_STATUS[str(link, 'status') ?? ''] ?? 'PENDING',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      redirectUrl,
      raw: link,
    };
  }

  /**
   * A bare Order, for a widget mounted on our own checkout page.
   *
   * An Order and not a Payment Link, because a link's whole purpose is the
   * hosted page we are deliberately not using — creating one and then ignoring
   * its `short_url` would leave a live payable link loose in the account for
   * every abandoned checkout.
   *
   * ATTRIBUTION IS THE SAME AS A RECURRING DEBIT, WHICH IS WHY THIS COSTS SO
   * LITTLE. There is no `reference_id` on an Order, so the reference travels as
   * `receipt` and, again, in `notes` — and `notes` is the one that survives onto
   * the payment. Both are already read by `toEvent` and both are already the
   * mandate-debit path, so no webhook handling is new here.
   *
   * NO REDIRECT COMES BACK, AND NONE SHOULD. The caller mounts the widget; the
   * browser never leaves our origin. `returnUrl` is unused on this path — the
   * page handles its own completion — but is still honoured by the redirect
   * branch above, so nothing that reads it needs to know which flow ran.
   */
  private async createEmbeddedCharge(input: CreateChargeInput): Promise<HostedCharge> {
    const amount = money(input.amountMinor, input.currency);
    const reference = input.reference.slice(0, LIMITS.receipt);

    const order = await this.request(
      'POST',
      '/orders',
      {
        amount: amount.amountMinor,
        currency: amount.currency,
        receipt: reference,
        // Auto-capture. An authorised-but-uncaptured payment expires and the
        // money goes back, which reads to a clinic as "I paid and nothing
        // happened" — the worst available failure mode.
        payment_capture: true,
        notes: { reference },
      },
      { idempotencyKey: input.reference }
    );

    const orderId = str(order, 'id');
    if (!orderId) {
      throw new PaymentProviderError(
        'Razorpay created a checkout order without an id — there is nothing for the widget to pay',
        this.name
      );
    }

    return {
      provider: this.name,
      reference: str(order, 'receipt') ?? input.reference,
      providerChargeId: orderId,
      status: ORDER_STATUS[str(order, 'status') ?? ''] ?? 'PENDING',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      embedded: {
        provider: this.name,
        // The publishable half of the key pair. `keySecret` must never appear
        // on anything returned from this method.
        publicKey: this.config.keyId,
        token: orderId,
      },
      raw: order,
    };
  }

  /**
   * Recover the payment link a previous attempt already created, or `null` if
   * this error was not a duplicate at all.
   *
   * Matched on the description rather than a code because Razorpay reports this
   * as a generic `BAD_REQUEST_ERROR` whose description is the only thing that
   * distinguishes it. A description change would make this return `null` and the
   * original error would be rethrown — which is the safe direction to be wrong
   * in: a visible failure to create a checkout, not a silent second one.
   */
  private async recoverLinkByReference(error: unknown, reference: string): Promise<Json | null> {
    if (!(error instanceof PaymentDeclinedError)) return null;
    if (!/reference[ _]id/i.test(error.message) || !/exist|duplicate|unique/i.test(error.message)) {
      return null;
    }

    const found = await this.request(
      'GET',
      `/payment_links?reference_id=${encodeURIComponent(reference)}`
    );
    return arr(found, 'payment_links')[0] ?? null;
  }

  /**
   * An off-session debit against an authorised mandate.
   *
   * Two calls, because Razorpay separates the amount from the instrument: an
   * order says what is owed, and the recurring payment charges a token for it.
   * Neither returns a redirect and neither should — if a URL ever comes back the
   * mandate was not usable and the caller must not treat the charge as in flight.
   *
   * The result is PENDING, not SUCCEEDED. `payments/create/recurring` answers
   * with an id and no terminal status; the outcome arrives as `payment.captured`
   * or `payment.failed`. Guessing SUCCEEDED here would grant a clinic a period
   * before the bank has agreed to pay for it.
   */
  private async chargeMandate(input: CreateChargeInput, mandateId: string): Promise<HostedCharge> {
    const { customerId, tokenId } = splitMandateId(mandateId);
    if (!customerId || !tokenId) {
      throw new PaymentDeclinedError(
        'this mandate has no authorised token yet — it cannot be debited',
        this.name,
        'MANDATE_NOT_AUTHORISED'
      );
    }

    const amount = money(input.amountMinor, input.currency);
    const reference = input.reference.slice(0, LIMITS.receipt);
    const notes = { reference };

    const order = await this.request(
      'POST',
      '/orders',
      {
        amount: amount.amountMinor,
        currency: amount.currency,
        receipt: reference,
        payment_capture: true,
        notes,
      },
      { idempotencyKey: input.reference }
    );

    const orderId = str(order, 'id');
    if (!orderId) {
      throw new PaymentProviderError('Razorpay created a recurring order without an id', this.name);
    }

    const payment = await this.request(
      'POST',
      '/payments/create/recurring',
      {
        email: input.customer.email,
        // Razorpay rejects a recurring payment with no contact. A mandate cannot
        // have been taken without one, so an absent phone here means the billing
        // contact was edited after authorisation.
        contact: input.customer.phone ?? '',
        amount: amount.amountMinor,
        currency: amount.currency,
        order_id: orderId,
        customer_id: customerId,
        token: tokenId,
        recurring: '1',
        description: input.description.slice(0, LIMITS.note),
        notes,
      },
      { idempotencyKey: input.reference }
    );

    return {
      provider: this.name,
      reference,
      providerChargeId: str(payment, 'razorpay_payment_id') ?? str(payment, 'id') ?? orderId,
      status: PAYMENT_STATUS[str(payment, 'status') ?? ''] ?? 'PENDING',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      raw: { order, payment },
    };
  }

  /**
   * The authoritative state of a charge, asked directly.
   *
   * Polymorphic on the id's prefix because a charge is a payment link when the
   * customer was present and a bare payment when it was a mandate debit, and the
   * caller stores whichever one it was given. Guessing wrong would be a 404 that
   * reads as "this payment does not exist" on a payment that plainly does.
   */
  async getCharge(providerChargeId: string): Promise<ChargeResult> {
    const id = encodeURIComponent(providerChargeId);

    if (providerChargeId.startsWith('plink_')) {
      const link = await this.request('GET', `/payment_links/${id}`);
      return this.chargeFromLink(providerChargeId, link);
    }

    if (providerChargeId.startsWith('order_')) {
      const order = await this.request('GET', `/orders/${id}`);
      const payments = arr(await this.request('GET', `/orders/${id}/payments`), 'items');
      const attempt = pickAttempt(payments);
      const currency = str(order, 'currency') ?? 'INR';

      return {
        ...this.chargeFromPayment(providerChargeId, attempt ?? {}, currency),
        status:
          (attempt ? PAYMENT_STATUS[str(attempt, 'status') ?? ''] : undefined) ??
          ORDER_STATUS[str(order, 'status') ?? ''] ??
          'PENDING',
        reference: str(order, 'receipt') ?? null,
        amountMinor: num(order, 'amount') ?? 0,
        raw: { order, payment: attempt },
      };
    }

    const payment = await this.request('GET', `/payments/${id}`);
    return this.chargeFromPayment(providerChargeId, payment, str(payment, 'currency') ?? 'INR');
  }

  /** A payment link, plus whichever attempt against it is the answer. */
  private chargeFromLink(providerChargeId: string, link: Json): ChargeResult {
    const currency = str(link, 'currency') ?? 'INR';
    const status = LINK_STATUS[str(link, 'status') ?? ''] ?? 'PENDING';
    const attempt = pickAttempt(arr(link, 'payments'));

    return {
      provider: this.name,
      reference: str(link, 'reference_id') ?? null,
      providerChargeId,
      status,
      amountMinor: num(link, 'amount') ?? 0,
      currency,
      ...this.instrument(attempt),
      ...(unixDate(num(attempt, 'created_at')) && status === 'SUCCEEDED'
        ? { paidAt: unixDate(num(attempt, 'created_at')) }
        : {}),
      ...(status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED'
        ? {
            failureCode: str(link, 'status') ?? 'UNKNOWN',
            failureMessage: 'The hosted checkout did not complete.',
          }
        : {}),
      raw: link,
    };
  }

  private chargeFromPayment(
    providerChargeId: string,
    payment: Json,
    currency: string
  ): ChargeResult {
    const status = PAYMENT_STATUS[str(payment, 'status') ?? ''] ?? 'PENDING';

    return {
      provider: this.name,
      /*
       * `notes.reference` first, `receipt` nowhere — a payment carries no
       * receipt, only the order does. Every payment we create carries the note,
       * so an absent one means this payment was made outside our flow.
       */
      reference: str(obj(payment, 'notes'), 'reference') ?? null,
      providerChargeId,
      status,
      amountMinor: num(payment, 'amount') ?? 0,
      currency,
      ...this.instrument(payment),
      ...(status === 'SUCCEEDED' && unixDate(num(payment, 'created_at'))
        ? { paidAt: unixDate(num(payment, 'created_at')) }
        : {}),
      ...(status === 'FAILED'
        ? {
            /*
             * Razorpay's three-level failure detail, most specific first.
             * `error_reason` names the cause a human can act on ("payment_failed
             * because the customer's account had insufficient funds"), which is
             * what the support desk needs; the code alone is opaque.
             */
            failureCode: str(payment, 'error_code') ?? 'UNKNOWN',
            failureMessage:
              str(payment, 'error_description') ??
              str(payment, 'error_reason') ??
              'The payment did not complete.',
          }
        : {}),
      raw: payment,
    };
  }

  // -------------------------------------------------------------------------
  // Mandates
  // -------------------------------------------------------------------------

  /**
   * An authorisation link — Razorpay's mandate holder, with no cycle of its own.
   *
   * The ceiling the customer approves is `max_amount`; `amount` is the
   * authorisation transaction, usually zero. `frequency: as_presented` is the
   * part that matters for ADR-0013: it tells the bank we will present debits on
   * our own schedule, so Razorpay never learns what a clinic pays or when.
   */
  async createMandate(input: CreateMandateInput): Promise<HostedMandate> {
    if (!this.capabilities.mandateCurrencies.includes(input.currency.toUpperCase())) {
      throw new PaymentDeclinedError(
        `Razorpay cannot hold a mandate in ${input.currency}; auto-renewal is unavailable for this currency.`,
        this.name,
        'MANDATE_CURRENCY_UNSUPPORTED'
      );
    }

    const ceiling = money(input.maxAmountMinor, input.currency);
    const reference = input.reference.slice(0, LIMITS.receipt);
    const expireAt = this.linkExpiry(input.expiresAt);

    const registration: Json = {
      method: this.config.mandateMethod,
      // The customer sees this number on the authorisation screen. It is a
      // ceiling, not a charge — see `mandateCeiling` in @rcln/billing for how
      // much headroom it carries and why.
      max_amount: ceiling.amountMinor,
      expire_at: expireAt,
      // "We will tell you each time." The alternative is a fixed cycle held by
      // the bank, which is the billing clock we deliberately do not delegate.
      frequency: 'as_presented',
      // e-mandate is the only method that needs the authorisation channel named.
      ...(this.config.mandateMethod === 'emandate' ? { auth_type: 'netbanking' } : {}),
    };

    const created = await this.request(
      'POST',
      '/subscription_registration/auth_links',
      {
        customer: this.customerPayload(input.customer),
        type: 'link',
        amount: this.config.mandateAuthAmountMinor,
        currency: ceiling.currency,
        description: input.description.slice(0, LIMITS.description),
        subscription_registration: registration,
        receipt: reference,
        expire_by: expireAt,
        // Best-effort attribution for `token.*` events, which carry nothing else
        // of ours. See the EVENT_FAMILY comment on the token events.
        notes: { reference },
        sms_notify: 0,
        email_notify: 0,
        callback_url: input.returnUrl,
        callback_method: 'get',
      },
      { idempotencyKey: input.reference }
    );

    const redirectUrl = str(created, 'short_url');
    if (!redirectUrl) {
      throw new PaymentProviderError(
        'Razorpay created an auth link with no short_url — the customer cannot approve the mandate',
        this.name
      );
    }

    return {
      ...this.mandateFromInvoice(created, ceiling.currency),
      reference: str(created, 'receipt') ?? input.reference,
      maxAmountMinor: ceiling.amountMinor,
      redirectUrl,
    };
  }

  /**
   * Read a mandate, from whichever half of its life the id names.
   *
   * Before authorisation there is only the auth link's invoice; after it, the
   * token is the thing that can be debited and the thing that can be revoked.
   * See the header for why the id changes shape.
   */
  async getMandate(providerMandateId: string): Promise<MandateResult> {
    const { customerId, tokenId, invoiceId } = splitMandateId(providerMandateId);

    if (customerId && tokenId) {
      const token = await this.request(
        'GET',
        `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`
      );
      return this.mandateFromToken(providerMandateId, token, customerId);
    }

    const invoice = await this.request(
      'GET',
      `/invoices/${encodeURIComponent(invoiceId ?? providerMandateId)}`
    );

    /*
     * An authorised auth link names its token. Returning the composite id here
     * — not just on the webhook — means a reconciliation sweep that polls
     * `getMandate` reaches the same state as a delivery that never arrived.
     */
    return this.mandateFromInvoice(invoice, undefined);
  }

  /**
   * Revoke. Idempotent by construction — an already-cancelled mandate is read
   * back and returned rather than re-cancelled, because a revoke that throws
   * when the thing is already revoked makes every retry a failure.
   */
  async cancelMandate(providerMandateId: string): Promise<MandateResult> {
    const { customerId, tokenId, invoiceId } = splitMandateId(providerMandateId);

    try {
      if (customerId && tokenId) {
        await this.request(
          'DELETE',
          `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`
        );
      } else {
        /*
         * Never authorised, so there is no token to revoke — cancelling the
         * invoice is what stops the customer completing a mandate we no longer
         * want. Razorpay refuses to cancel a paid invoice, which the catch below
         * turns into a read of the token that payment created.
         */
        await this.request(
          'POST',
          `/invoices/${encodeURIComponent(invoiceId ?? providerMandateId)}/cancel`
        );
      }
    } catch (error) {
      // No verdict means no verdict. Retrying a revoke is always safe; assuming
      // it worked is not.
      if (error instanceof PaymentUnavailableError) throw error;

      const current = await this.getMandate(providerMandateId);
      if (current.status === 'CANCELLED' || current.status === 'FAILED') return current;
      throw error;
    }

    return this.getMandate(providerMandateId);
  }

  /** The auth link's invoice, which is the mandate until a token exists. */
  private mandateFromInvoice(invoice: Json, fallbackCurrency: string | undefined): MandateResult {
    const invoiceId = str(invoice, 'id') ?? '';
    const customerId = str(invoice, 'customer_id');
    const tokenId = str(invoice, 'token_id');
    const registration = obj(invoice, 'subscription_registration');
    const currency = str(invoice, 'currency') ?? fallbackCurrency ?? 'INR';
    const ceiling = num(registration, 'max_amount');

    // Once both halves exist the composite is the id, because that is what a
    // debit and a revoke need. Until then the invoice is all there is.
    const id = customerId && tokenId ? composeMandateId(customerId, tokenId) : invoiceId;

    return {
      provider: this.name,
      reference: str(invoice, 'receipt') ?? null,
      providerMandateId: id,
      status: INVOICE_STATUS[str(invoice, 'status') ?? ''] ?? 'PENDING',
      currency,
      ...(ceiling !== undefined ? { maxAmountMinor: ceiling } : {}),
      ...(unixDate(num(invoice, 'paid_at'))
        ? { activatedAt: unixDate(num(invoice, 'paid_at')) }
        : {}),
      ...(unixDate(num(registration, 'expire_at'))
        ? { expiresAt: unixDate(num(registration, 'expire_at')) }
        : {}),
      raw: invoice,
    };
  }

  /** The token, which is the mandate once the customer has authorised it. */
  private mandateFromToken(
    providerMandateId: string,
    token: Json,
    customerId: string
  ): MandateResult {
    const recurring = obj(token, 'recurring_details');
    const currency = str(token, 'currency') ?? 'INR';
    const ceiling = num(recurring, 'max_amount') ?? num(token, 'max_amount');

    /*
     * `recurring_details.status` in preference to the token's own `status`.
     *
     * They disagree in the window between the customer approving an e-mandate
     * and the bank confirming it: the token reads `active` while
     * `recurring_details` still reads `initiated`, and only the latter says
     * whether a debit may be attempted. Trusting the token would start renewals
     * against an unconfirmed mandate.
     */
    const status =
      TOKEN_STATUS[str(recurring, 'status') ?? ''] ?? TOKEN_STATUS[str(token, 'status') ?? ''];

    return {
      provider: this.name,
      reference: str(obj(token, 'notes'), 'reference') ?? null,
      providerMandateId: providerMandateId.includes(':')
        ? providerMandateId
        : composeMandateId(customerId, str(token, 'id') ?? providerMandateId),
      status: status ?? 'PENDING',
      currency,
      ...(ceiling !== undefined ? { maxAmountMinor: ceiling } : {}),
      ...this.instrument(token),
      ...(unixDate(num(token, 'created_at'))
        ? { activatedAt: unixDate(num(token, 'created_at')) }
        : {}),
      ...(unixDate(num(token, 'expired_at'))
        ? { expiresAt: unixDate(num(token, 'expired_at')) }
        : {}),
      raw: token,
    };
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Razorpay refunds a PAYMENT, never an order or a link.
   *
   * The caller holds whichever id `createCharge` returned, which for a hosted
   * checkout is the link. So the payment is resolved first — one extra GET, and
   * the alternative is a 404 on every refund of a hosted charge.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const amount = money(input.amountMinor, input.currency);
    const paymentId = await this.resolvePaymentId(input.providerChargeId);

    const result = await this.request(
      'POST',
      `/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        amount: amount.amountMinor,
        // `normal` and not `optimum`: an instant refund costs a fee and can be
        // silently downgraded anyway (`refund.speed_changed`). A subscription
        // adjustment is not urgent enough to pay for.
        speed: 'normal',
        receipt: input.reference.slice(0, LIMITS.receipt),
        notes: {
          reference: input.reference.slice(0, LIMITS.receipt),
          reason: (input.reason ?? 'Subscription adjustment').slice(0, LIMITS.note),
        },
      },
      { idempotencyKey: input.reference }
    );

    const status = str(result, 'status') ?? 'pending';

    return {
      provider: this.name,
      reference: str(obj(result, 'notes'), 'reference') ?? input.reference,
      providerRefundId: str(result, 'id') ?? input.reference,
      providerChargeId: str(result, 'payment_id') ?? paymentId,
      status: status === 'processed' ? 'SUCCEEDED' : status === 'failed' ? 'FAILED' : 'PENDING',
      amountMinor: num(result, 'amount') ?? amount.amountMinor,
      currency: str(result, 'currency') ?? amount.currency,
      raw: result,
    };
  }

  /** `pay_…` is already the answer; anything else has to be looked up. */
  private async resolvePaymentId(providerChargeId: string): Promise<string> {
    if (providerChargeId.startsWith('pay_')) return providerChargeId;

    const id = encodeURIComponent(providerChargeId);
    const attempts = providerChargeId.startsWith('plink_')
      ? arr(await this.request('GET', `/payment_links/${id}`), 'payments')
      : arr(await this.request('GET', `/orders/${id}/payments`), 'items');

    const attempt = pickAttempt(attempts);
    const paymentId = str(attempt, 'payment_id') ?? str(attempt, 'id');

    if (!paymentId) {
      throw new PaymentDeclinedError(
        `no captured payment found for ${providerChargeId}; there is nothing to refund`,
        this.name,
        'NO_PAYMENT_TO_REFUND'
      );
    }
    return paymentId;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify, then read. Never the other way round.
   *
   * The signature is hex(HMAC-SHA256(rawBody, webhookSecret)) over the EXACT
   * bytes Razorpay sent — body only, no timestamp, and hex rather than the
   * base64 Cashfree uses. That is why `RawWebhook.body` is a Buffer: a
   * parse-and-restringify reorders keys and the HMAC no longer matches, which
   * presents as "wrong secret" and costs an afternoon.
   *
   * ⚠️ THERE IS DELIBERATELY NO TIMESTAMP WINDOW HERE, AND THAT IS NOT AN
   *    OVERSIGHT COPIED FROM THE CASHFREE ADAPTER'S ABSENCE OF ONE.
   *
   *   Cashfree signs `timestamp + body`, so a captured delivery expires. Razorpay
   *   signs the body alone; the only timestamp available is `created_at` INSIDE
   *   the payload. It is signed, so it could be trusted — but Razorpay retries a
   *   failed delivery for up to 24 hours with the same bytes and therefore the
   *   same `created_at`. Any window shorter than that would 401 every legitimate
   *   retry, and Razorpay disables an endpoint that keeps refusing.
   *
   *   So replay protection is the LEDGER, not the clock: `X-Razorpay-Event-Id` is
   *   unique per event and stable across retries, and the unique index on
   *   `(provider, provider_event_id)` in `payment_webhook_events` means a replayed
   *   capture — malicious or not — collides and does nothing. That index is
   *   load-bearing for this provider in a way it is not for Cashfree. Do not
   *   "optimise" it away, and do not add a window here without solving the retry
   *   problem first.
   */
  parseWebhook(input: RawWebhook): WebhookEvent {
    const signature = headerValue(input.headers, SIGNATURE_HEADER);

    if (!signature) {
      throw new WebhookVerificationError(`missing ${SIGNATURE_HEADER}`, this.name);
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(input.body)
      .digest('hex');

    const given = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Length is compared first because timingSafeEqual throws on a mismatch, and
    // a thrown error is itself a timing signal.
    if (given.length !== computed.length || !timingSafeEqual(given, computed)) {
      throw new WebhookVerificationError('webhook signature did not verify', this.name);
    }

    let payload: Json;
    try {
      payload = JSON.parse(input.body.toString('utf8')) as Json;
    } catch {
      throw new WebhookVerificationError('webhook body is not JSON', this.name);
    }

    return this.toEvent(payload, signature, headerValue(input.headers, EVENT_ID_HEADER));
  }

  private toEvent(
    payload: Json,
    signature: string,
    headerEventId: string | undefined
  ): WebhookEvent {
    const family = EVENT_FAMILY[str(payload, 'event') ?? ''];

    /*
     * Razorpay nests every entity under `payload.<name>.entity`, and an event
     * routinely carries several: `payment_link.paid` has the link AND the
     * payment, `invoice.paid` has the invoice AND the payment AND the order.
     * Pulled out once here so the branches below read the shape rather than
     * navigate it.
     */
    const container = obj(payload, 'payload');
    const payment = entity(container, 'payment');
    const link = entity(container, 'payment_link');
    const invoice = entity(container, 'invoice');
    const token = entity(container, 'token');
    const refund = entity(container, 'refund');
    const order = entity(container, 'order');

    /*
     * `X-Razorpay-Event-Id` is the documented deduplication key and is stable
     * across the 24-hour retry schedule. The signature is a deterministic
     * function of the exact bytes, so it stands in when the header is absent —
     * a re-delivery carries the same one, and a genuinely different event
     * cannot collide.
     */
    const id = blankToUndefined(headerEventId) ?? `sig:${signature}`;

    /*
     * Our own id, echoed back — the thing every event is matched to, and the
     * only capability that lets a verified webhook read the row it is about.
     *
     * Checked most specific first. A payment link event carries `reference_id`;
     * a recurring debit has only the `notes` we set on its order and payment; an
     * auth link comes back as the invoice's `receipt`.
     */
    const reference =
      str(link, 'reference_id') ??
      str(obj(payment, 'notes'), 'reference') ??
      str(invoice, 'receipt') ??
      str(order, 'receipt') ??
      str(obj(order, 'notes'), 'reference') ??
      str(obj(token, 'notes'), 'reference') ??
      str(obj(refund, 'notes'), 'reference') ??
      null;

    const currency =
      str(link, 'currency') ??
      str(payment, 'currency') ??
      str(refund, 'currency') ??
      str(invoice, 'currency') ??
      'INR';

    const base = {
      provider: this.name,
      id,
      type: 'unknown' as WebhookEventType,
      occurredAt: unixDate(num(payload, 'created_at')) ?? new Date(),
      reference,
      raw: payload,
    };

    // Nothing we act on, or a name we have never seen. Recorded and dropped.
    if (family === undefined || family === 'informational') return base;

    if (family === 'refund') {
      const status = str(refund, 'status') ?? '';
      return {
        ...base,
        type: status === 'failed' ? 'refund.failed' : 'refund.succeeded',
        refund: {
          provider: this.name,
          reference,
          providerRefundId: str(refund, 'id') ?? id,
          providerChargeId: str(refund, 'payment_id') ?? str(payment, 'id') ?? '',
          status: status === 'processed' ? 'SUCCEEDED' : status === 'failed' ? 'FAILED' : 'PENDING',
          amountMinor: num(refund, 'amount') ?? 0,
          currency,
          raw: refund,
        },
      };
    }

    if (family === 'mandate') {
      /*
       * The invoice is the attributable half and the token is the authoritative
       * half, and a completed auth link delivers both. Prefer the token for the
       * STATE, but keep the invoice's reference — which `mandateFromInvoice`
       * already carries, and a token does not.
       */
      const mandate =
        token !== undefined
          ? this.mandateFromToken(
              composeMandateId(
                str(token, 'customer_id') ?? str(invoice, 'customer_id') ?? '',
                str(token, 'id') ?? ''
              ),
              token,
              str(token, 'customer_id') ?? str(invoice, 'customer_id') ?? ''
            )
          : this.mandateFromInvoice(invoice ?? {}, currency);

      return {
        ...base,
        // The event name says which object moved; the status says where to.
        type:
          mandate.status === 'ACTIVE'
            ? 'mandate.activated'
            : mandate.status === 'CANCELLED'
              ? 'mandate.cancelled'
              : mandate.status === 'FAILED'
                ? 'mandate.failed'
                : 'unknown',
        mandate: { ...mandate, reference },
      };
    }

    if (family === 'charge') {
      /*
       * The status comes from the most specific object present, because the two
       * disagree in exactly one case that matters: `payment_link.partially_paid`
       * carries a CAPTURED payment on an UNPAID link. Reading the payment there
       * would settle an invoice that was underpaid.
       */
      const status =
        (link !== undefined ? LINK_STATUS[str(link, 'status') ?? ''] : undefined) ??
        (payment !== undefined ? PAYMENT_STATUS[str(payment, 'status') ?? ''] : undefined) ??
        (order !== undefined ? ORDER_STATUS[str(order, 'status') ?? ''] : undefined) ??
        'PENDING';

      /*
       * The id the caller already stored, so a later `getCharge` finds the same
       * object: the link when the customer was present, the payment when it was
       * an off-session mandate debit.
       */
      const providerChargeId = str(link, 'id') ?? str(payment, 'id') ?? str(order, 'id') ?? id;

      return {
        ...base,
        type:
          status === 'SUCCEEDED'
            ? 'charge.succeeded'
            : status === 'PENDING'
              ? 'charge.pending'
              : 'charge.failed',
        charge: {
          provider: this.name,
          reference,
          providerChargeId,
          status,
          // The LINK's amount is what was owed; the payment's is what arrived.
          // `settleIntent` compares against the invoice, so the amount reported
          // must be what actually arrived.
          amountMinor: num(payment, 'amount') ?? num(link, 'amount') ?? num(order, 'amount') ?? 0,
          currency,
          ...this.instrument(payment),
          ...(status === 'SUCCEEDED' && unixDate(num(payment, 'created_at'))
            ? { paidAt: unixDate(num(payment, 'created_at')) }
            : {}),
          ...(status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED'
            ? {
                failureCode:
                  str(payment, 'error_code') ??
                  str(link, 'status') ??
                  str(payload, 'event') ??
                  'UNKNOWN',
                failureMessage:
                  str(payment, 'error_description') ??
                  str(payment, 'error_reason') ??
                  'The payment did not complete.',
              }
            : {}),
          raw: payload,
        },
      };
    }

    return base;
  }

  // -------------------------------------------------------------------------
  // Shared shaping
  // -------------------------------------------------------------------------

  /**
   * ⚠️ THE BILLING CONTACT, NEVER A PATIENT. See `CustomerDetails` in types.ts —
   *   nothing patient-derived may reach a provider's systems through here.
   */
  private customerPayload(customer: CustomerDetails): Json {
    return {
      name: customer.name.slice(0, 100),
      email: customer.email,
      // Razorpay's field is `contact`, and several Indian methods reject a
      // payment without one. Empty rather than absent, matching what the API
      // accepts for card-only flows.
      contact: customer.phone ?? '',
    };
  }

  /**
   * What the customer paid with, reduced to a coarse kind and a label.
   *
   * ONLY THE TAIL OF AN INSTRUMENT IS EVER KEPT. Razorpay returns the full
   * `card` object including the network and issuer; `last4` is the only part
   * that goes anywhere near our database, and a VPA is kept as its handle
   * (`@okhdfcbank`) rather than the local part, which identifies a person.
   */
  private instrument(source: Json | undefined): {
    method?: PaymentMethodKind;
    instrumentLabel?: string;
  } {
    if (!source) return {};

    const method = str(source, 'method');
    const card = obj(source, 'card');
    const upi = obj(source, 'upi');

    const label =
      str(card, 'last4') ??
      str(source, 'vpa')?.replace(/^[^@]*/, '') ??
      str(upi, 'vpa')?.replace(/^[^@]*/, '') ??
      str(source, 'bank') ??
      str(source, 'wallet');

    // A token from `createMandate` has no `method` until it is confirmed, but it
    // does have a card or a VPA — so the kind is inferred rather than dropped.
    const kind = method
      ? (METHOD_KIND[method] ?? 'OTHER')
      : card
        ? 'CARD'
        : upi || str(source, 'vpa')
          ? 'UPI'
          : undefined;

    if (!kind && !label) return {};

    return { ...(kind ? { method: kind } : {}), ...(label ? { instrumentLabel: label } : {}) };
  }

  /** Unix seconds, never sooner than Razorpay will accept. See the constant. */
  private linkExpiry(expiresAt: Date | undefined): number {
    const floor = Math.floor(Date.now() / 1000) + MIN_LINK_LIFETIME_SECONDS;
    if (!expiresAt) return floor;
    return Math.max(floor, Math.floor(expiresAt.getTime() / 1000));
  }
}

// ---------------------------------------------------------------------------
// The mandate id
// ---------------------------------------------------------------------------

/**
 * `cust_…:token_…`.
 *
 * A debit needs the token AND the customer that owns it, and Razorpay's token
 * endpoints are all nested under the customer. Storing only the token would mean
 * every renewal had to look the customer up first — an extra call on the one
 * path that runs unattended at 03:00 — or a schema column for something the
 * provider seam deliberately keeps opaque. One string, split at the boundary.
 */
function composeMandateId(customerId: string, tokenId: string): string {
  return `${customerId}:${tokenId}`;
}

function splitMandateId(providerMandateId: string): {
  customerId: string | undefined;
  tokenId: string | undefined;
  invoiceId: string | undefined;
} {
  const separator = providerMandateId.indexOf(':');
  if (separator === -1) {
    // A pending mandate: the auth link's invoice, with no token yet.
    return { customerId: undefined, tokenId: undefined, invoiceId: providerMandateId };
  }

  const customerId = providerMandateId.slice(0, separator);
  const tokenId = providerMandateId.slice(separator + 1);

  // Both halves or neither. A half-formed id would produce a request to
  // `/customers//tokens/x`, which 404s in a way that reads like a missing
  // mandate rather than a malformed id.
  if (!customerId || !tokenId) {
    return { customerId: undefined, tokenId: undefined, invoiceId: providerMandateId };
  }
  return { customerId, tokenId, invoiceId: undefined };
}

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

/** `payload.<name>.entity`, Razorpay's uniform webhook nesting. */
function entity(container: Json | undefined, name: string): Json | undefined {
  return obj(obj(container, name), 'entity');
}

/**
 * The attempt that is the answer: the successful one if there is one, otherwise
 * the most recent — so a customer who failed twice and then succeeded reads as
 * SUCCEEDED rather than as their last failure.
 */
function pickAttempt(attempts: Json[]): Json | undefined {
  return (
    attempts.find((attempt) => {
      const status = str(attempt, 'status');
      return status === 'captured' || status === 'refunded';
    }) ?? attempts[attempts.length - 1]
  );
}

/**
 * Refuse a key whose prefix disagrees with the declared environment.
 *
 * ⚠️ THIS IS THE GUARD THAT REPLACES A SANDBOX HOSTNAME.
 *   Razorpay serves test and live from the same URL, so nothing else in the
 *   request distinguishes them. A `rzp_live_` key pasted into a staging `.env`
 *   would charge real cards from a staging deployment, and the first symptom
 *   would be a customer's statement. Fatal at construction, so it stops a
 *   deployment rather than surfacing as a real charge.
 *
 *   An unrecognised prefix is allowed through: Razorpay has used others
 *   historically, and refusing a key we simply do not recognise would block a
 *   legitimate deployment for no security gain.
 */
function assertKeyMatchesEnvironment(keyId: string, environment: 'sandbox' | 'production'): void {
  const isTest = keyId.startsWith(KEY_PREFIX.sandbox);
  const isLive = keyId.startsWith(KEY_PREFIX.production);

  if (!isTest && !isLive) return;

  if (environment === 'sandbox' && isLive) {
    throw new PaymentConfigurationError(
      'RAZORPAY_KEY_ID is a LIVE key (rzp_live_) but RAZORPAY_ENVIRONMENT is sandbox. ' +
        'Razorpay serves test and live from the same URL, so this would take real money ' +
        'from real cards. Use the test key, or set RAZORPAY_ENVIRONMENT=production.'
    );
  }

  if (environment === 'production' && isTest) {
    throw new PaymentConfigurationError(
      'RAZORPAY_KEY_ID is a TEST key (rzp_test_) but RAZORPAY_ENVIRONMENT is production. ' +
        'Every payment would succeed and collect nothing.'
    );
  }
}
