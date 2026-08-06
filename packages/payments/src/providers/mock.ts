/**
 * A payment provider that behaves like one, without an acquirer.
 *
 * WHY THIS IS NOT A STUB
 *   A stub returns SUCCEEDED and teaches you nothing. Every bug this system can
 *   actually have lives in the seams a stub removes: the customer leaves the
 *   page and comes back before the webhook lands; the webhook arrives twice; the
 *   webhook arrives BEFORE the redirect; the mandate debit is declined at 03:00
 *   with nobody watching; the signature does not verify because something
 *   re-serialised the body.
 *
 *   So this provider does the real thing. It signs its webhooks with the same
 *   HMAC scheme Cashfree uses, over the same raw bytes, and they go through the
 *   same verification, the same idempotency ledger and the same handler. It
 *   redirects to a hosted page the operator has to actually interact with, and
 *   it can be told to decline, to stall, or to deliver the same event twice.
 *
 *   `PAYMENT_PROVIDER=mock` is therefore the *tested* path, and the one to
 *   develop against. Cashfree's adapter is the one that has to match it.
 *
 * WHERE THE STATE LIVES
 *   Injected, because the API and the worker are separate processes and an
 *   in-memory Map would give them different opinions about whether a clinic has
 *   paid. `MockStore` is two methods so the API can hand it Redis and a unit
 *   test can hand it a Map.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PaymentConfigurationError,
  PaymentDeclinedError,
  WebhookVerificationError,
} from '../errors.js';
import type {
  ChargeResult,
  ChargeStatus,
  CreateChargeInput,
  CreateMandateInput,
  HostedCharge,
  HostedMandate,
  MandateResult,
  MandateStatus,
  PaymentProvider,
  ProviderCapabilities,
  RawWebhook,
  RefundInput,
  RefundResult,
  WebhookEvent,
} from '../types.js';

/** Two methods, so Redis and a `Map` are both trivially conformant. */
export interface MockStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** For unit tests and single-process scripts. Never wire this into the API. */
export class InMemoryMockStore implements MockStore {
  private readonly entries = new Map<string, string>();

  read(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  write(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

/** What the operator chose on the sandbox checkout page. */
export type MockOutcome = 'SUCCEED' | 'DECLINE' | 'ABANDON' | 'STALL';

export interface MockConfig {
  store: MockStore;
  /**
   * The sandbox checkout page customers are redirected to. A real screen in
   * `apps/web` with Approve and Decline on it — that is what makes the return
   * race reproducible rather than theoretical.
   */
  checkoutUrl: string;
  /** Signs the simulated webhooks. Any string; it is not protecting money. */
  webhookSecret: string;
  /** How long a pending charge record survives. Default one day. */
  recordTtlSeconds?: number | undefined;
}

interface ChargeRecord {
  kind: 'charge';
  reference: string;
  providerChargeId: string;
  status: ChargeStatus;
  amountMinor: number;
  currency: string;
  description: string;
  mandateId?: string;
  paidAt?: string;
  failureCode?: string;
  failureMessage?: string;
}

interface MandateRecord {
  kind: 'mandate';
  reference: string;
  providerMandateId: string;
  status: MandateStatus;
  currency: string;
  maxAmountMinor: number;
  activatedAt?: string;
}

const KEY = {
  charge: (id: string): string => `mockpay:charge:${id}`,
  mandate: (id: string): string => `mockpay:mandate:${id}`,
};

export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  /**
   * Deliberately unrestricted. The mock's job is to let every path be exercised,
   * including the ones Cashfree cannot serve — so a EUR mandate works here and
   * is refused there, and the code that has to cope with the difference gets
   * written and tested rather than discovered later.
   */
  readonly capabilities: ProviderCapabilities = {
    mandates: true,
    chargeCurrencies: '*',
    mandateCurrencies: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'],
    refunds: true,
    /*
     * True, so that `PAYMENT_PROVIDER=mock` remains the tested path for the
     * embedded flow as well as the redirect one.
     *
     * If this were false, the checkout screen would silently fall back to the
     * hosted page in development and the widget branch would only ever run
     * against a real gateway — which is precisely the arrangement that lets a
     * broken flow reach production. The mock's "widget" is the same sandbox
     * choices rendered inline; it still produces a genuinely signed webhook.
     */
    embeddedCheckout: true,
  };

  // Spelled out rather than `Required<MockConfig>` — see the note on the same
  // field in the Cashfree adapter.
  private readonly config: {
    store: MockStore;
    checkoutUrl: string;
    webhookSecret: string;
    recordTtlSeconds: number;
  };

  constructor(config: MockConfig) {
    if (!config.checkoutUrl || !config.webhookSecret) {
      throw new PaymentConfigurationError(
        'the mock provider needs a checkoutUrl and a webhookSecret'
      );
    }
    this.config = {
      store: config.store,
      checkoutUrl: config.checkoutUrl,
      webhookSecret: config.webhookSecret,
      recordTtlSeconds: config.recordTtlSeconds ?? 86_400,
    };
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(input: CreateChargeInput): Promise<HostedCharge> {
    const record: ChargeRecord = {
      kind: 'charge',
      reference: input.reference,
      providerChargeId: input.reference,
      // Off-session debits are decided immediately, exactly as a real mandate
      // debit is: there is no page for the customer to visit and no redirect.
      status: 'PENDING',
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
      description: input.description,
      ...(input.mandateId ? { mandateId: input.mandateId } : {}),
    };

    if (input.mandateId) {
      const mandate = await this.readMandate(input.mandateId);
      if (!mandate || mandate.status !== 'ACTIVE') {
        throw new PaymentDeclinedError(
          'the mandate is not active, so it cannot be debited',
          this.name,
          'MANDATE_NOT_ACTIVE'
        );
      }
      if (input.amountMinor > mandate.maxAmountMinor) {
        // The single most common real-world renewal failure, and the reason
        // CreateMandateInput.maxAmountMinor carries headroom.
        throw new PaymentDeclinedError(
          'the amount exceeds the authorised mandate ceiling',
          this.name,
          'MANDATE_LIMIT_EXCEEDED'
        );
      }

      record.status = 'SUCCEEDED';
      record.paidAt = new Date().toISOString();
      await this.write(KEY.charge(record.providerChargeId), record);

      return {
        provider: this.name,
        reference: record.reference,
        providerChargeId: record.providerChargeId,
        status: 'SUCCEEDED',
        amountMinor: record.amountMinor,
        currency: record.currency,
        method: 'CARD',
        instrumentLabel: '4242',
        paidAt: new Date(record.paidAt),
        raw: record,
      };
    }

    await this.write(KEY.charge(record.providerChargeId), record);

    /*
     * The embedded flow, standing in for a real widget.
     *
     * No `publicKey` that means anything — there is no merchant to identify —
     * but the field is populated rather than left blank so the checkout page's
     * handling of it is genuinely exercised. The `token` is the charge id, which
     * is what the sandbox component posts back to `/webhooks/payments/mock/simulate`.
     */
    if (input.presentation === 'embedded') {
      return {
        provider: this.name,
        reference: record.reference,
        providerChargeId: record.providerChargeId,
        status: 'PENDING',
        amountMinor: record.amountMinor,
        currency: record.currency,
        embedded: {
          provider: this.name,
          publicKey: 'mock_public_key',
          token: record.providerChargeId,
        },
        raw: record,
      };
    }

    return {
      provider: this.name,
      reference: record.reference,
      providerChargeId: record.providerChargeId,
      status: 'PENDING',
      amountMinor: record.amountMinor,
      currency: record.currency,
      redirectUrl: this.hostedUrl('charge', record.providerChargeId, input.returnUrl),
      raw: record,
    };
  }

  async getCharge(providerChargeId: string): Promise<ChargeResult> {
    const record = await this.readCharge(providerChargeId);
    if (!record) {
      return {
        provider: this.name,
        reference: null,
        providerChargeId,
        // Unknown to the provider is not "failed" — for a real gateway it means
        // the order was never created, and the caller must not grant anything.
        status: 'EXPIRED',
        amountMinor: 0,
        currency: 'INR',
        failureCode: 'NOT_FOUND',
        failureMessage: 'no such charge',
      };
    }

    return {
      provider: this.name,
      reference: record.reference,
      providerChargeId: record.providerChargeId,
      status: record.status,
      amountMinor: record.amountMinor,
      currency: record.currency,
      ...(record.status === 'SUCCEEDED'
        ? { method: 'CARD' as const, instrumentLabel: '4242' }
        : {}),
      ...(record.paidAt ? { paidAt: new Date(record.paidAt) } : {}),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
      raw: record,
    };
  }

  // -------------------------------------------------------------------------
  // Mandates
  // -------------------------------------------------------------------------

  async createMandate(input: CreateMandateInput): Promise<HostedMandate> {
    const record: MandateRecord = {
      kind: 'mandate',
      reference: input.reference,
      providerMandateId: input.reference,
      status: 'PENDING',
      currency: input.currency.toUpperCase(),
      maxAmountMinor: input.maxAmountMinor,
    };
    await this.write(KEY.mandate(record.providerMandateId), record);

    return {
      provider: this.name,
      reference: record.reference,
      providerMandateId: record.providerMandateId,
      status: 'PENDING',
      currency: record.currency,
      maxAmountMinor: record.maxAmountMinor,
      redirectUrl: this.hostedUrl('mandate', record.providerMandateId, input.returnUrl),
      raw: record,
    };
  }

  async getMandate(providerMandateId: string): Promise<MandateResult> {
    const record = await this.readMandate(providerMandateId);
    if (!record) {
      return {
        provider: this.name,
        reference: null,
        providerMandateId,
        status: 'FAILED',
        currency: 'INR',
      };
    }
    return this.toMandate(record);
  }

  async cancelMandate(providerMandateId: string): Promise<MandateResult> {
    const record = await this.readMandate(providerMandateId);
    if (!record) {
      // Idempotent: revoking something that is not there has already achieved
      // what the caller wanted.
      return {
        provider: this.name,
        reference: null,
        providerMandateId,
        status: 'CANCELLED',
        currency: 'INR',
      };
    }

    record.status = 'CANCELLED';
    await this.write(KEY.mandate(providerMandateId), record);
    return this.toMandate(record);
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  refund(input: RefundInput): Promise<RefundResult> {
    return Promise.resolve({
      provider: this.name,
      reference: input.reference,
      providerRefundId: `mock_rfnd_${randomUUID()}`,
      providerChargeId: input.providerChargeId,
      status: 'SUCCEEDED' as const,
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
    });
  }

  // -------------------------------------------------------------------------
  // The sandbox: turning an operator's click into a real signed webhook
  // -------------------------------------------------------------------------

  /**
   * Advance a charge or mandate and hand back the webhook a provider would send.
   *
   * The caller feeds the returned `RawWebhook` straight into `parseWebhook`, so
   * the signature check, the deduplication and the handler are all genuinely
   * exercised — this method takes no shortcut past any of them.
   *
   * `deliveries` exists because at-least-once is the only guarantee real
   * providers offer, and the way to know the ledger holds is to send the same
   * event twice on purpose.
   */
  async simulate(
    kind: 'charge' | 'mandate',
    id: string,
    outcome: MockOutcome,
    options: { eventId?: string } = {}
  ): Promise<RawWebhook> {
    const eventId = options.eventId ?? `mock_evt_${randomUUID()}`;

    if (kind === 'mandate') {
      const record = await this.readMandate(id);
      if (!record) throw new PaymentDeclinedError('no such mandate', this.name, 'NOT_FOUND');

      record.status =
        outcome === 'SUCCEED' ? 'ACTIVE' : outcome === 'STALL' ? 'PENDING' : 'CANCELLED';
      if (outcome === 'SUCCEED') record.activatedAt = new Date().toISOString();
      await this.write(KEY.mandate(id), record);

      return this.sign({
        event_id: eventId,
        type:
          record.status === 'ACTIVE'
            ? 'mandate.activated'
            : record.status === 'CANCELLED'
              ? 'mandate.cancelled'
              : 'mandate.pending',
        event_time: new Date().toISOString(),
        data: { mandate: record },
      });
    }

    const record = await this.readCharge(id);
    if (!record) throw new PaymentDeclinedError('no such charge', this.name, 'NOT_FOUND');

    switch (outcome) {
      case 'SUCCEED':
        record.status = 'SUCCEEDED';
        record.paidAt = new Date().toISOString();
        break;
      case 'DECLINE':
        record.status = 'FAILED';
        record.failureCode = 'CARD_DECLINED';
        record.failureMessage = 'The card issuer declined this payment.';
        break;
      case 'ABANDON':
        record.status = 'EXPIRED';
        record.failureCode = 'USER_DROPPED';
        record.failureMessage = 'The customer left the payment page.';
        break;
      case 'STALL':
        // Deliberately no change and no terminal event. This is the state a UPI
        // collect request sits in, and the screens have to cope with it.
        record.status = 'PENDING';
        break;
    }
    await this.write(KEY.charge(id), record);

    return this.sign({
      event_id: eventId,
      type:
        record.status === 'SUCCEEDED'
          ? 'charge.succeeded'
          : record.status === 'PENDING'
            ? 'charge.pending'
            : 'charge.failed',
      event_time: new Date().toISOString(),
      data: { charge: record },
    });
  }

  /**
   * Same scheme as Cashfree: base64(HMAC-SHA256(timestamp + rawBody)). Identical
   * on purpose — if the mock's webhooks verify and Cashfree's do not, the fault
   * is in the secret, not in the plumbing.
   */
  private sign(payload: Record<string, unknown>): RawWebhook {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp)
      .update(body)
      .digest('base64');

    return {
      body,
      headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
    };
  }

  parseWebhook(input: RawWebhook): WebhookEvent {
    const signature = single(input.headers['x-webhook-signature']);
    const timestamp = single(input.headers['x-webhook-timestamp']);
    if (!signature || !timestamp) {
      throw new WebhookVerificationError('missing signature headers', this.name);
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp)
      .update(input.body)
      .digest('base64');

    const given = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (given.length !== computed.length || !timingSafeEqual(given, computed)) {
      throw new WebhookVerificationError('signature did not verify', this.name);
    }

    let payload: { event_id?: string; type?: string; event_time?: string; data?: unknown };
    try {
      payload = JSON.parse(input.body.toString('utf8')) as typeof payload;
    } catch {
      throw new WebhookVerificationError('body is not JSON', this.name);
    }

    const data = (payload.data ?? {}) as { charge?: ChargeRecord; mandate?: MandateRecord };
    const occurredAt = payload.event_time ? new Date(payload.event_time) : new Date();

    if (data.mandate) {
      const mandate = this.toMandate(data.mandate);
      return {
        provider: this.name,
        id: payload.event_id ?? `sig:${signature}`,
        type:
          mandate.status === 'ACTIVE'
            ? 'mandate.activated'
            : mandate.status === 'CANCELLED'
              ? 'mandate.cancelled'
              : 'unknown',
        occurredAt,
        reference: mandate.reference,
        mandate,
        raw: payload,
      };
    }

    if (data.charge) {
      const record = data.charge;
      return {
        provider: this.name,
        id: payload.event_id ?? `sig:${signature}`,
        type:
          record.status === 'SUCCEEDED'
            ? 'charge.succeeded'
            : record.status === 'PENDING'
              ? 'charge.pending'
              : 'charge.failed',
        occurredAt,
        reference: record.reference,
        charge: {
          provider: this.name,
          reference: record.reference,
          providerChargeId: record.providerChargeId,
          status: record.status,
          amountMinor: record.amountMinor,
          currency: record.currency,
          ...(record.status === 'SUCCEEDED'
            ? { method: 'CARD' as const, instrumentLabel: '4242' }
            : {}),
          ...(record.paidAt ? { paidAt: new Date(record.paidAt) } : {}),
          ...(record.failureCode ? { failureCode: record.failureCode } : {}),
          ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
          raw: record,
        },
        raw: payload,
      };
    }

    return {
      provider: this.name,
      id: payload.event_id ?? `sig:${signature}`,
      type: 'unknown',
      occurredAt,
      reference: null,
      raw: payload,
    };
  }

  // -------------------------------------------------------------------------

  private hostedUrl(kind: 'charge' | 'mandate', id: string, returnUrl: string): string {
    const url = new URL(this.config.checkoutUrl);
    url.searchParams.set('kind', kind);
    url.searchParams.set('id', id);
    url.searchParams.set('return', returnUrl);
    return url.toString();
  }

  private toMandate(record: MandateRecord): MandateResult {
    return {
      provider: this.name,
      reference: record.reference,
      providerMandateId: record.providerMandateId,
      status: record.status,
      currency: record.currency,
      maxAmountMinor: record.maxAmountMinor,
      ...(record.status === 'ACTIVE' ? { method: 'CARD' as const, instrumentLabel: '4242' } : {}),
      ...(record.activatedAt ? { activatedAt: new Date(record.activatedAt) } : {}),
      raw: record,
    };
  }

  private async readCharge(id: string): Promise<ChargeRecord | null> {
    const raw = await this.config.store.read(KEY.charge(id));
    return raw ? (JSON.parse(raw) as ChargeRecord) : null;
  }

  private async readMandate(id: string): Promise<MandateRecord | null> {
    const raw = await this.config.store.read(KEY.mandate(id));
    return raw ? (JSON.parse(raw) as MandateRecord) : null;
  }

  private async write(key: string, value: ChargeRecord | MandateRecord): Promise<void> {
    await this.config.store.write(key, JSON.stringify(value), this.config.recordTtlSeconds);
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
