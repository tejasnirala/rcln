/**
 * Cashfree Payments — the first implementation of `PaymentProvider`.
 *
 * ⚠️ NOT YET EXERCISED AGAINST A LIVE SANDBOX.
 *   This adapter is written against Cashfree's published Payment Gateway and
 *   Subscription APIs at the versions pinned in `API_VERSION` below. Every
 *   request and response shape here is from the documentation, not from a
 *   captured session. Before pointing production at it, run the flows against
 *   the sandbox and reconcile the field names — providers rename things between
 *   API versions, and the failure is a `undefined` amount rather than an error.
 *   Until then `PAYMENT_PROVIDER=mock` is the tested path.
 *
 * WHAT CASHFREE IS, HONESTLY
 *   An India-domiciled acquirer. It will accept a foreign card and present the
 *   cardholder a price in their own currency, and the merchant settles in INR at
 *   Cashfree's rate. That is why `settlementCurrency` is declared below and why
 *   `mandateCurrencies` is INR alone: UPI Autopay, eNACH and card mandates are
 *   Indian rails, and a EUR mandate is not a thing this provider can hold. A
 *   clinic in Dublin can therefore pay each invoice, but cannot be put on
 *   auto-renewal here. The billing engine reads that from `capabilities` and
 *   offers the right thing, rather than discovering it when a renewal fails.
 *
 *   Do not paper over this by pretending a EUR mandate exists. When there is a
 *   customer who needs it, the answer is a second adapter (Stripe, Adyen) beside
 *   this one — which is the entire reason `PaymentProvider` exists.
 *
 * TWO PRODUCTS, ONE INTERFACE
 *   `createCharge` without a mandate is a PG **order**: a hosted page, customer
 *   present. `createMandate` is a **subscription** in `ON_DEMAND` mode, which
 *   Cashfree uses purely as a mandate holder — no plan cycle, no amount, no
 *   schedule of its own. We keep the billing clock (ADR: our own renewal
 *   engine), so a renewal is `createCharge` WITH a mandate, which becomes a
 *   manual charge against that subscription. Cashfree never decides when a
 *   clinic is billed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentConfigurationError,
  PaymentDeclinedError,
  PaymentProviderError,
  PaymentUnavailableError,
  WebhookVerificationError,
} from '../errors.js';
import { fromMajor, money, toMajorString } from '../money.js';
import {
  blankToUndefined,
  headerValue,
  isoDate as date,
  num,
  obj,
  str,
  type Json,
} from './shared.js';
import type {
  ChargeResult,
  ChargeStatus,
  CreateChargeInput,
  CreateMandateInput,
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

/**
 * Pinned, never "latest".
 *
 * Cashfree's API version is a request header, and the response shape changes
 * with it. Leaving it unset means a shape change arrives on their deploy
 * schedule rather than ours, in production, silently.
 */
const API_VERSION = '2023-08-01';
const SUBSCRIPTION_API_VERSION = '2025-01-01';

const HOSTS = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
} as const;

/**
 * Where the hosted page lives.
 *
 * Overridable because it is the one URL Cashfree does not return in a documented
 * field for every flow, and hard-coding a host that later moves would break
 * checkout with no way to patch it without a deploy.
 */
const CHECKOUT_HOSTS = {
  sandbox: 'https://payments-test.cashfree.com/order/#',
  production: 'https://payments.cashfree.com/order/#',
} as const;

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  /** The webhook signing secret. Cashfree signs with the API secret by default. */
  webhookSecret?: string | undefined;
  environment: 'sandbox' | 'production';
  /** Override the hosted checkout host. See CHECKOUT_HOSTS. */
  checkoutBaseUrl?: string | undefined;
  /** Per-request timeout. A gateway that has not answered in 20s will not. */
  timeoutMs?: number | undefined;
  /**
   * How far out of date a webhook timestamp may be before it is refused.
   *
   * Replay protection: the signature covers `timestamp + body`, so a captured
   * delivery stays valid forever without this. Five minutes is Cashfree's own
   * retry granularity and leaves room for clock skew.
   */
  webhookToleranceSeconds?: number | undefined;
}

/** Cashfree's terminal payment states, mapped onto ours. */
const CHARGE_STATUS: Readonly<Record<string, ChargeStatus>> = {
  SUCCESS: 'SUCCEEDED',
  PAID: 'SUCCEEDED',
  FAILED: 'FAILED',
  // Cashfree distinguishes "the customer walked away" from "the bank said no".
  // Both are unsuccessful and neither is retryable without the customer, so both
  // land on FAILED — but the code is preserved on `failureCode` so the support
  // desk can still tell them apart.
  USER_DROPPED: 'FAILED',
  CANCELLED: 'CANCELLED',
  VOID: 'CANCELLED',
  PENDING: 'PENDING',
  NOT_ATTEMPTED: 'PENDING',
  ACTIVE: 'PENDING',
  EXPIRED: 'EXPIRED',
  TERMINATED: 'CANCELLED',
};

const MANDATE_STATUS: Readonly<Record<string, MandateStatus>> = {
  INITIALIZED: 'PENDING',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  ON_HOLD: 'PAUSED',
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'CANCELLED',
  BANK_APPROVAL_PENDING: 'PENDING',
  FAILED: 'FAILED',
};

const METHOD_KIND: Readonly<Record<string, PaymentMethodKind>> = {
  card: 'CARD',
  upi: 'UPI',
  netbanking: 'NETBANKING',
  app: 'WALLET',
  wallet: 'WALLET',
  banktransfer: 'BANK_TRANSFER',
  emi: 'CARD',
  cardless_emi: 'OTHER',
  paylater: 'OTHER',
};

/**
 * What KIND of thing an event is about — not what it says happened.
 *
 * ⚠️ THE PREVIOUS VERSION MAPPED NAMES STRAIGHT TO OUTCOMES, AND THAT WAS WRONG
 *    IN TWO WAYS AT ONCE.
 *
 *   The names were guessed from documentation and several did not exist:
 *   `SUBSCRIPTION_NEW_PAYMENT`, `SUBSCRIPTION_PAYMENT_DECLINED` and
 *   `SUBSCRIPTION_CANCELLED` are not events Cashfree sends. A name that is not
 *   in the table becomes `unknown`, which is recorded and ignored — so a
 *   subscription would have gone on renewing with nothing ever confirming it,
 *   silently.
 *
 *   And mapping a NAME to an OUTCOME is the wrong shape regardless.
 *   `SUBSCRIPTION_AUTH_STATUS` is fired whether the authorisation succeeded or
 *   failed; `..._STATUS_CHANGED` covers activation, pause and cancellation. The
 *   name tells you which object moved. Only the payload tells you where it moved
 *   to, and the payload's status fields are far more stable across API versions
 *   than the event names are.
 *
 *   So the table now answers one question — charge, mandate, refund, or nothing
 *   we act on — and `toEvent` reads the outcome off the body. A name we have
 *   never seen still degrades to `unknown`: recorded, acknowledged with a 200,
 *   and visible in `payment_webhook_events` for whoever adds it here.
 *
 * The names come from the Cashfree dashboard's own webhook catalogue:
 * Configuration → Payment Gateway, and Configuration → Subscriptions. They are
 * the labels uppercased and underscored, which is Cashfree's convention — still
 * an inference until a live delivery confirms each one, and the ledger is what
 * confirms it.
 */
type EventFamily = 'charge' | 'mandate' | 'refund' | 'informational';

const EVENT_FAMILY: Readonly<Record<string, EventFamily>> = {
  // -- Payment Gateway -------------------------------------------------------
  PAYMENT_SUCCESS_WEBHOOK: 'charge',
  PAYMENT_FAILED_WEBHOOK: 'charge',
  PAYMENT_USER_DROPPED_WEBHOOK: 'charge',
  REFUND_STATUS_WEBHOOK: 'refund',

  // -- Subscriptions ---------------------------------------------------------
  /** The mandate authorisation came back. Success AND failure arrive as this. */
  SUBSCRIPTION_AUTH_STATUS: 'mandate',
  /** Activation, pause, cancellation, completion — the status says which. */
  SUBSCRIPTION_STATUS_CHANGED: 'mandate',
  SUBSCRIPTION_PAYMENT_SUCCESS: 'charge',
  SUBSCRIPTION_PAYMENT_FAILED: 'charge',
  SUBSCRIPTION_PAYMENT_CANCELLED: 'charge',
  /** The outcome of a debit we asked for. */
  SUBSCRIPTION_PAYMENT_EXECUTION_STATUS: 'charge',
  SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS: 'charge',
  SUBSCRIPTION_REFUND_STATUS: 'refund',

  /*
   * Recorded, never acted on.
   *
   * The notification events are India's pre-debit notice for e-mandates: the
   * customer must be told 24 hours before an auto-debit. Cashfree sends it, so
   * there is nothing for us to do — but the delivery record is the evidence it
   * happened, which is the kind of thing a regulator asks for.
   *
   * The card-expiry reminder is genuinely useful and is NOT wired up: it is the
   * "your card is about to expire" nudge, and rcln has no notification delivery
   * yet (see .kb/STATUS.md). Recording it now means the data is there when it
   * does. Acting on it would need an email that does not exist.
   */
  SUBSCRIPTION_CARD_EXPIRY_REMINDER: 'informational',
  SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED: 'informational',
  SUBSCRIPTION_PAYMENT_NOTIFICATION_STATUS: 'informational',
  SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS: 'informational',

  /*
   * Aliases kept deliberately.
   *
   * Cashfree has renamed subscription events across API versions, and an older
   * merchant account can still be emitting the earlier spellings. Listing both
   * costs a line each and removes a silent failure mode.
   */
  SUBSCRIPTION_STATUS_CHANGE: 'mandate',
  SUBSCRIPTION_NEW_PAYMENT: 'charge',
  SUBSCRIPTION_PAYMENT_DECLINED: 'charge',
  SUBSCRIPTION_CANCELLED: 'mandate',
};

export class CashfreeProvider implements PaymentProvider {
  readonly name = 'cashfree' as const;

  /**
   * Declared, not discovered. `chargeCurrencies` is `'*'` because Cashfree's
   * International Payments will present most currencies to a cardholder and the
   * real constraint is which ones the *merchant account* is enabled for — which
   * this package cannot know. The catalogue (`plan_prices`) is the honest limit.
   */
  readonly capabilities: ProviderCapabilities = {
    mandates: true,
    chargeCurrencies: '*',
    mandateCurrencies: ['INR'],
    refunds: true,
    settlementCurrency: 'INR',
    /*
     * False, though Cashfree does have a drop-in JS SDK.
     *
     * `payment_session_id` is already returned above and would be most of what a
     * widget needs — but nothing renders it, and declaring a capability nobody
     * has implemented would make the checkout screen mount an empty container
     * instead of falling back to the hosted page that works. Flip this in the
     * same commit that adds the component, not before.
     */
    embeddedCheckout: false,
  };

  /*
   * Not `Required<CashfreeConfig>`: the optional fields are declared
   * `?: T | undefined` for exactOptionalPropertyTypes, and `Required` strips the
   * question mark while leaving the `| undefined` in place. Spelling out the
   * resolved shape is what makes every default below actually a default.
   */
  private readonly config: {
    appId: string;
    secretKey: string;
    webhookSecret: string;
    environment: 'sandbox' | 'production';
    checkoutBaseUrl: string;
    timeoutMs: number;
    webhookToleranceSeconds: number;
  };

  constructor(config: CashfreeConfig) {
    if (!config.appId || !config.secretKey) {
      throw new PaymentConfigurationError(
        'Cashfree needs CASHFREE_APP_ID and CASHFREE_SECRET_KEY. Set PAYMENT_PROVIDER=mock to run without them.'
      );
    }

    // Trimmed once, up front, because a value copied out of a dashboard routinely
    // carries a trailing newline — and an HMAC key that differs by one byte
    // fails in exactly the same way as the wrong key entirely. Computed before
    // the object literal so the webhook fallback below cannot pick up the
    // untrimmed original, which is what it did on the first attempt.
    const secretKey = config.secretKey.trim();

    this.config = {
      appId: config.appId.trim(),
      secretKey,
      /*
       * Cashfree signs webhooks with the API secret unless a separate signing
       * secret is configured in their dashboard, so an absent one falls back.
       *
       * ⚠️ BLANK COUNTS AS ABSENT, AND `??` DOES NOT KNOW THAT.
       *   `CASHFREE_WEBHOOK_SECRET=` in a `.env` — which is how the variable
       *   ships, because most deployments do not set it — reaches here as an
       *   empty string, and `'' ?? secretKey` is `''`. Every signature was then
       *   verified against a zero-length key and every delivery answered 401,
       *   with the log saying only "signature did not verify".
       */
      webhookSecret: blankToUndefined(config.webhookSecret) ?? secretKey,
      environment: config.environment,
      checkoutBaseUrl: config.checkoutBaseUrl ?? CHECKOUT_HOSTS[config.environment],
      timeoutMs: config.timeoutMs ?? 20_000,
      webhookToleranceSeconds: config.webhookToleranceSeconds ?? 300,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * One place that talks to Cashfree, so timeouts, error classification and the
   * auth headers exist once.
   *
   * THE CLASSIFICATION IS THE IMPORTANT PART. A 4xx is a verdict — the caller
   * must not retry it. A 5xx, a timeout or a dropped socket is *no verdict*, and
   * the caller must retry with the same reference and then reconcile. Collapsing
   * the two into one error type is how a customer gets charged twice.
   */
  private async request<T = Json>(
    method: 'GET' | 'POST',
    path: string,
    body?: Json,
    options: { apiVersion?: string; idempotencyKey?: string } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-client-id': this.config.appId,
      'x-client-secret': this.config.secretKey,
      'x-api-version': options.apiVersion ?? API_VERSION,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Cashfree deduplicates on this for POSTs, which is what makes the retry
    // above safe rather than merely hopeful.
    if (options.idempotencyKey) headers['x-idempotency-key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${HOSTS[this.config.environment]}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      throw new PaymentUnavailableError(
        `Cashfree did not answer ${method} ${path}: ${cause instanceof Error ? cause.message : 'network error'}`,
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
          `Cashfree returned a non-JSON body for ${method} ${path}`,
          this.name
        );
      }
    }

    if (response.ok) return payload as T;

    const code = str(payload, 'code') ?? str(payload, 'type') ?? String(response.status);
    const message = str(payload, 'message') ?? `Cashfree returned ${String(response.status)}`;

    if (response.status >= 500 || response.status === 429) {
      throw new PaymentUnavailableError(message, this.name, code);
    }
    throw new PaymentDeclinedError(message, this.name, code);
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(input: CreateChargeInput): Promise<HostedCharge> {
    if (input.mandateId) return this.chargeMandate(input, input.mandateId);

    const amount = money(input.amountMinor, input.currency);

    const payload: Json = {
      // OUR id, so a retry hits the same order and the webhook is attributable.
      order_id: input.reference,
      // Cashfree wants a number here, not the string the ledger stores. The
      // conversion goes through toMajorString so the scale is the currency's,
      // then back to a number exactly once, at the boundary.
      order_amount: Number(toMajorString(amount)),
      order_currency: amount.currency,
      customer_details: this.customerPayload(input.customer),
      order_meta: {
        return_url: input.returnUrl,
        ...(input.webhookUrl ? { notify_url: input.webhookUrl } : {}),
      },
      order_note: input.description.slice(0, 200),
      ...(input.expiresAt ? { order_expiry_time: input.expiresAt.toISOString() } : {}),
    };

    const order = await this.request('POST', '/orders', payload, {
      idempotencyKey: input.reference,
    });

    const sessionId = str(order, 'payment_session_id');
    if (!sessionId) {
      throw new PaymentProviderError(
        'Cashfree created an order without a payment_session_id — there is nowhere to send the customer',
        this.name
      );
    }

    return {
      provider: this.name,
      reference: str(order, 'order_id') ?? input.reference,
      providerChargeId: str(order, 'order_id') ?? input.reference,
      status: CHARGE_STATUS[str(order, 'order_status') ?? ''] ?? 'PENDING',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      redirectUrl: `${this.config.checkoutBaseUrl}${sessionId}`,
      sessionToken: sessionId,
      raw: order,
    };
  }

  /**
   * An off-session debit against an authorised mandate.
   *
   * Cashfree models this as a manual payment on the subscription that holds the
   * mandate. No redirect comes back and none should — if this ever returns a URL,
   * the mandate was not actually usable and the caller must not treat the charge
   * as in flight.
   */
  private async chargeMandate(input: CreateChargeInput, mandateId: string): Promise<HostedCharge> {
    const amount = money(input.amountMinor, input.currency);

    const payload: Json = {
      payment_id: input.reference,
      payment_amount: Number(toMajorString(amount)),
      payment_type: 'CHARGE',
      payment_remarks: input.description.slice(0, 100),
      // Today. Cashfree requires the field; scheduling is ours, not theirs.
      payment_schedule_date: new Date().toISOString(),
    };

    const result = await this.request(
      'POST',
      `/subscriptions/${encodeURIComponent(mandateId)}/payments`,
      payload,
      { apiVersion: SUBSCRIPTION_API_VERSION, idempotencyKey: input.reference }
    );

    const status = CHARGE_STATUS[str(result, 'payment_status') ?? ''] ?? 'PENDING';

    return {
      provider: this.name,
      reference: str(result, 'payment_id') ?? input.reference,
      providerChargeId: str(result, 'cf_payment_id') ?? input.reference,
      status,
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      ...(status === 'FAILED'
        ? {
            failureCode: str(result, 'failure_reason') ?? 'MANDATE_DEBIT_FAILED',
            failureMessage: str(result, 'payment_remarks') ?? 'The mandate debit was declined.',
          }
        : {}),
      raw: result,
    };
  }

  /**
   * The authoritative state of an order.
   *
   * Two calls, not one: the order says whether it was PAID, and the payments
   * list says HOW and with what failure. The order alone cannot tell an expired
   * checkout from a declined card, and both look identical to a customer asking
   * why their subscription did not start.
   */
  async getCharge(providerChargeId: string): Promise<ChargeResult> {
    const id = encodeURIComponent(providerChargeId);
    const order = await this.request('GET', `/orders/${id}`);

    const currency = str(order, 'order_currency') ?? 'INR';
    const orderAmount = num(order, 'order_amount');
    const amount =
      orderAmount === undefined ? money(0, currency) : fromMajor(orderAmount, currency);

    let payments: Json[] = [];
    try {
      payments = await this.request<Json[]>('GET', `/orders/${id}/payments`);
    } catch (error) {
      // An order with no payment attempt answers 404 on this path at some API
      // versions. That is "nobody has tried yet", not a failure of the lookup —
      // the order status below is still the answer.
      if (error instanceof PaymentUnavailableError) throw error;
    }

    // The successful attempt if there is one, otherwise the most recent, so a
    // customer who failed twice and then succeeded reads as SUCCEEDED.
    const attempt =
      (Array.isArray(payments) ? payments : []).find(
        (p) => str(p, 'payment_status') === 'SUCCESS'
      ) ?? (Array.isArray(payments) ? payments[payments.length - 1] : undefined);

    const status =
      CHARGE_STATUS[str(attempt, 'payment_status') ?? ''] ??
      CHARGE_STATUS[str(order, 'order_status') ?? ''] ??
      'PENDING';

    const errorDetails = obj(attempt, 'error_details');

    return {
      provider: this.name,
      reference: str(order, 'order_id') ?? null,
      providerChargeId,
      status,
      amountMinor: amount.amountMinor,
      currency,
      ...this.instrument(attempt),
      ...(date(str(attempt, 'payment_time')) ? { paidAt: date(str(attempt, 'payment_time')) } : {}),
      ...(status === 'FAILED' || status === 'EXPIRED'
        ? {
            failureCode:
              str(errorDetails, 'error_code') ?? str(attempt, 'payment_status') ?? 'UNKNOWN',
            failureMessage:
              str(errorDetails, 'error_description') ?? 'The payment did not complete.',
          }
        : {}),
      raw: { order, payment: attempt },
    };
  }

  // -------------------------------------------------------------------------
  // Mandates
  // -------------------------------------------------------------------------

  /**
   * An `ON_DEMAND` Cashfree subscription, used purely to hold an authorisation.
   *
   * The plan is defined inline rather than referencing a `plans` object in
   * Cashfree, because our plan catalogue already lives in Postgres and mirroring
   * it into a provider is a second source of truth that goes stale the first
   * time a price changes. Cashfree never learns what a clinic pays; it learns
   * only the ceiling the customer authorised.
   */
  async createMandate(input: CreateMandateInput): Promise<HostedMandate> {
    if (!this.capabilities.mandateCurrencies.includes(input.currency.toUpperCase())) {
      throw new PaymentDeclinedError(
        `Cashfree cannot hold a mandate in ${input.currency}; auto-renewal is unavailable for this currency.`,
        this.name,
        'MANDATE_CURRENCY_UNSUPPORTED'
      );
    }

    const ceiling = money(input.maxAmountMinor, input.currency);

    const payload: Json = {
      subscription_id: input.reference,
      customer_details: this.customerPayload(input.customer),
      plan_details: {
        plan_name: input.description.slice(0, 50),
        plan_type: 'ON_DEMAND',
        plan_currency: ceiling.currency,
        plan_max_amount: Number(toMajorString(ceiling)),
      },
      authorization_details: {
        authorization_amount: Number(toMajorString(ceiling)),
        authorization_amount_refund: true,
      },
      subscription_meta: {
        return_url: input.returnUrl,
        ...(input.webhookUrl ? { notification_channels: ['EMAIL'] } : {}),
      },
      subscription_note: input.description.slice(0, 200),
      ...(input.expiresAt ? { subscription_expiry_time: input.expiresAt.toISOString() } : {}),
    };

    const created = await this.request('POST', '/subscriptions', payload, {
      apiVersion: SUBSCRIPTION_API_VERSION,
      idempotencyKey: input.reference,
    });

    const auth = obj(created, 'authorization_details');
    const redirectUrl = str(auth, 'authorization_link');
    const sessionToken = str(created, 'subscription_session_id');

    if (!redirectUrl && !sessionToken) {
      throw new PaymentProviderError(
        'Cashfree created a subscription with no authorisation link — the customer cannot approve it',
        this.name
      );
    }

    return {
      provider: this.name,
      reference: str(created, 'subscription_id') ?? input.reference,
      providerMandateId: str(created, 'subscription_id') ?? input.reference,
      status: MANDATE_STATUS[str(created, 'subscription_status') ?? ''] ?? 'PENDING',
      currency: ceiling.currency,
      maxAmountMinor: ceiling.amountMinor,
      ...(redirectUrl ? { redirectUrl } : {}),
      ...(sessionToken ? { sessionToken } : {}),
      raw: created,
    };
  }

  async getMandate(providerMandateId: string): Promise<MandateResult> {
    const found = await this.request(
      'GET',
      `/subscriptions/${encodeURIComponent(providerMandateId)}`,
      undefined,
      { apiVersion: SUBSCRIPTION_API_VERSION }
    );

    return this.toMandate(providerMandateId, found);
  }

  /**
   * Idempotent by construction: an already-cancelled mandate is read back and
   * returned rather than re-cancelled. Cashfree answers 4xx for a CANCEL on a
   * cancelled subscription, and a revoke endpoint that throws when the thing is
   * already revoked makes every retry a failure.
   */
  async cancelMandate(providerMandateId: string): Promise<MandateResult> {
    const id = encodeURIComponent(providerMandateId);
    try {
      const result = await this.request(
        'POST',
        `/subscriptions/${id}/manage`,
        { action: 'CANCEL' },
        { apiVersion: SUBSCRIPTION_API_VERSION }
      );
      return this.toMandate(providerMandateId, result);
    } catch (error) {
      if (error instanceof PaymentUnavailableError) throw error;
      const current = await this.getMandate(providerMandateId);
      if (current.status === 'CANCELLED') return current;
      throw error;
    }
  }

  private toMandate(providerMandateId: string, source: Json): MandateResult {
    const auth = obj(source, 'authorization_details');
    const currency =
      str(source, 'plan_currency') ?? str(obj(source, 'plan_details'), 'plan_currency') ?? 'INR';
    const ceiling = num(auth, 'authorization_amount');

    return {
      provider: this.name,
      reference: str(source, 'subscription_id') ?? null,
      providerMandateId,
      status: MANDATE_STATUS[str(source, 'subscription_status') ?? ''] ?? 'PENDING',
      currency,
      ...(ceiling !== undefined
        ? { maxAmountMinor: fromMajor(ceiling, currency).amountMinor }
        : {}),
      ...this.instrument(obj(source, 'payment_method') ?? source),
      ...(date(str(source, 'subscription_first_charge_time'))
        ? { activatedAt: date(str(source, 'subscription_first_charge_time')) }
        : {}),
      ...(date(str(source, 'subscription_expiry_time'))
        ? { expiresAt: date(str(source, 'subscription_expiry_time')) }
        : {}),
      raw: source,
    };
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  async refund(input: RefundInput): Promise<RefundResult> {
    const amount = money(input.amountMinor, input.currency);

    const result = await this.request(
      'POST',
      `/orders/${encodeURIComponent(input.providerChargeId)}/refunds`,
      {
        refund_id: input.reference,
        refund_amount: Number(toMajorString(amount)),
        refund_note: (input.reason ?? 'Subscription adjustment').slice(0, 100),
        refund_speed: 'STANDARD',
      },
      { idempotencyKey: input.reference }
    );

    const status = str(result, 'refund_status') ?? 'PENDING';

    return {
      provider: this.name,
      reference: str(result, 'refund_id') ?? input.reference,
      providerRefundId: String(
        num(result, 'cf_refund_id') ?? str(result, 'cf_refund_id') ?? input.reference
      ),
      providerChargeId: input.providerChargeId,
      status: status === 'SUCCESS' ? 'SUCCEEDED' : status === 'FAILED' ? 'FAILED' : 'PENDING',
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      raw: result,
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify, then read. Never the other way round.
   *
   * The signature is base64(HMAC-SHA256(timestamp + rawBody, secret)) over the
   * EXACT bytes Cashfree sent. That is why `RawWebhook.body` is a Buffer: a
   * parse-and-restringify reorders keys and the HMAC no longer matches, which
   * presents as "wrong secret" and costs an afternoon.
   *
   * The timestamp is checked as well as the signature. Without it, one captured
   * delivery is a permanently valid "mark this subscription paid" message.
   */
  parseWebhook(input: RawWebhook): WebhookEvent {
    const signature = headerValue(input.headers, 'x-webhook-signature');
    const timestamp = headerValue(input.headers, 'x-webhook-timestamp');

    if (!signature || !timestamp) {
      throw new WebhookVerificationError(
        'missing x-webhook-signature or x-webhook-timestamp',
        this.name
      );
    }

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > this.config.webhookToleranceSeconds) {
      throw new WebhookVerificationError(
        'webhook timestamp is outside the accepted window',
        this.name
      );
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp)
      .update(input.body)
      .digest('base64');

    const given = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    // Length is compared first because timingSafeEqual throws on a mismatch,
    // and a thrown error is itself a timing signal.
    if (given.length !== computed.length || !timingSafeEqual(given, computed)) {
      throw new WebhookVerificationError('webhook signature did not verify', this.name);
    }

    let payload: Json;
    try {
      payload = JSON.parse(input.body.toString('utf8')) as Json;
    } catch {
      throw new WebhookVerificationError('webhook body is not JSON', this.name);
    }

    return this.toEvent(payload, signature);
  }

  private toEvent(payload: Json, signature: string): WebhookEvent {
    const family = EVENT_FAMILY[str(payload, 'type') ?? ''];
    const data = obj(payload, 'data') ?? {};
    const order = obj(data, 'order');
    const refund = obj(data, 'refund') ?? obj(data, 'subscription_refund');

    /*
     * Subscription payloads nest differently from Payment Gateway ones, and not
     * consistently between them. Both shapes are accepted, and `data` itself is
     * the last resort because some subscription events put their fields flat.
     *
     * Written as a fallback chain rather than a branch on the event name: the
     * names are the part we are least sure of, and a shape that is absent simply
     * yields undefined and lands the event in `unknown` — recorded, not guessed.
     */
    const payment =
      obj(data, 'payment') ?? obj(data, 'subscription_payment') ?? obj(data, 'payment_details');
    const subscription =
      obj(data, 'subscription') ??
      (str(data, 'subscription_status') !== undefined ? data : undefined);

    const occurredAt = date(str(payload, 'event_time')) ?? new Date();

    /*
     * Cashfree does not send an event id on every webhook type. The signature is
     * a deterministic function of the timestamp and the exact bytes, so it is a
     * perfectly good deduplication key: a re-delivery of the same event carries
     * the same one, and a genuinely new event cannot collide.
     */
    const id = str(payload, 'event_id') ?? `sig:${signature}`;

    /*
     * Our own id, echoed back — the thing every event is matched to.
     *
     * `payment_id` is ours on a subscription debit (`chargeMandate` sends it),
     * `order_id` on a hosted checkout, `subscription_id` on anything about the
     * mandate itself. Checked most specific first: a subscription PAYMENT event
     * carries both a payment id and a subscription id, and the payment is what
     * the intent was created for.
     */
    const reference =
      str(payment, 'payment_id') ??
      str(order, 'order_id') ??
      str(subscription, 'subscription_id') ??
      str(data, 'subscription_id') ??
      str(refund, 'refund_id') ??
      null;

    const currency =
      str(order, 'order_currency') ??
      str(payment, 'payment_currency') ??
      str(refund, 'refund_currency') ??
      str(subscription, 'plan_currency') ??
      'INR';

    const base = {
      provider: this.name,
      id,
      type: 'unknown' as WebhookEventType,
      occurredAt,
      reference,
      raw: payload,
    };

    // Nothing we act on, or a name we have never seen. Recorded and dropped.
    if (family === undefined || family === 'informational') return base;

    if (family === 'refund') {
      const amount = num(refund, 'refund_amount');
      const status = str(refund, 'refund_status');
      return {
        ...base,
        type: status === 'FAILED' ? 'refund.failed' : 'refund.succeeded',
        refund: {
          provider: this.name,
          reference,
          providerRefundId: str(refund, 'refund_id') ?? id,
          providerChargeId: str(order, 'order_id') ?? '',
          status: status === 'FAILED' ? 'FAILED' : status === 'SUCCESS' ? 'SUCCEEDED' : 'PENDING',
          amountMinor: amount === undefined ? 0 : fromMajor(amount, currency).amountMinor,
          currency,
          raw: refund,
        },
      };
    }

    if (family === 'mandate') {
      const mandate = this.toMandate(
        str(subscription, 'subscription_id') ?? '',
        subscription ?? {}
      );
      return {
        ...base,
        // The event name says "status changed"; the status itself says to what.
        type:
          mandate.status === 'ACTIVE'
            ? 'mandate.activated'
            : mandate.status === 'CANCELLED'
              ? 'mandate.cancelled'
              : mandate.status === 'FAILED'
                ? 'mandate.failed'
                : 'unknown',
        mandate,
      };
    }

    if (family === 'charge') {
      const amount = num(payment, 'payment_amount') ?? num(order, 'order_amount');
      const status = CHARGE_STATUS[str(payment, 'payment_status') ?? ''] ?? 'PENDING';
      const errorDetails = obj(payment, 'error_details');

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
          providerChargeId: str(order, 'order_id') ?? str(payment, 'cf_payment_id') ?? id,
          status,
          amountMinor: amount === undefined ? 0 : fromMajor(amount, currency).amountMinor,
          currency,
          ...this.instrument(payment),
          ...(date(str(payment, 'payment_time'))
            ? { paidAt: date(str(payment, 'payment_time')) }
            : {}),
          ...(status === 'FAILED'
            ? {
                failureCode:
                  str(errorDetails, 'error_code') ?? str(payment, 'payment_status') ?? 'UNKNOWN',
                failureMessage:
                  str(errorDetails, 'error_description') ?? 'The payment did not complete.',
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

  private customerPayload(customer: CreateChargeInput['customer']): Json {
    return {
      customer_id: customer.reference,
      customer_name: customer.name.slice(0, 100),
      customer_email: customer.email,
      // Cashfree rejects an order with no phone on several methods and accepts
      // a placeholder for the rest. A real number is passed when we have one.
      customer_phone: customer.phone ?? '',
    };
  }

  /**
   * What the customer paid with, reduced to a coarse kind and a label.
   *
   * Cashfree returns `payment_method` as an object keyed by the method name
   * (`{ card: { card_number: '411111XXXXXX1111', ... } }`), so the key IS the
   * method. Only the tail of an instrument is ever kept, and never the rest.
   */
  private instrument(source: Json | undefined): {
    method?: PaymentMethodKind;
    instrumentLabel?: string;
  } {
    const methodObject = obj(source, 'payment_method');
    const key = methodObject ? Object.keys(methodObject)[0] : undefined;
    if (!key) return {};

    const detail = obj(methodObject, key);
    const kind = METHOD_KIND[key] ?? 'OTHER';

    const label =
      str(detail, 'card_number')?.slice(-4) ??
      str(detail, 'upi_id')?.replace(/^[^@]*/, '') ??
      str(detail, 'channel') ??
      str(detail, 'netbanking_bank_name');

    return { method: kind, ...(label ? { instrumentLabel: label } : {}) };
  }
}
