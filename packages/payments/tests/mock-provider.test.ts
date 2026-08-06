/**
 * The mock provider is the tested path, so it is tested like a real one: the
 * webhooks it emits go through the same verification the Cashfree adapter's do,
 * and the failure modes exercised here (declines, mandate ceilings, replays) are
 * the ones that actually happen in production.
 */
import { InMemoryMockStore, MockProvider } from '../src/providers/mock.js';
import { PaymentDeclinedError, WebhookVerificationError } from '../src/errors.js';

function provider(): MockProvider {
  return new MockProvider({
    store: new InMemoryMockStore(),
    checkoutUrl: 'http://lvh.me:3000/billing/sandbox',
    webhookSecret: 'test-secret',
  });
}

const customer = {
  reference: 'org-1',
  name: 'Test Clinic Billing',
  email: 'billing@example.test',
  countryCode: 'IN',
};

const chargeInput = {
  reference: 'intent-1',
  amountMinor: 499_900,
  currency: 'INR',
  customer,
  description: 'Growth, monthly',
  returnUrl: 'http://alpha.lvh.me:3000/billing/return',
};

describe('hosted checkout', () => {
  it('starts pending and sends the customer somewhere', async () => {
    const charge = await provider().createCharge(chargeInput);

    expect(charge.status).toBe('PENDING');
    expect(charge.redirectUrl).toContain('/billing/sandbox');
    expect(charge.redirectUrl).toContain('id=intent-1');
  });

  it('is not marked paid until the provider says so', async () => {
    const p = provider();
    await p.createCharge(chargeInput);

    // The return URL is a browser hint and grants nothing on its own.
    expect((await p.getCharge('intent-1')).status).toBe('PENDING');
  });

  it('reports SUCCEEDED once settled, with the amount unchanged', async () => {
    const p = provider();
    await p.createCharge(chargeInput);
    await p.simulate('charge', 'intent-1', 'SUCCEED');

    const charge = await p.getCharge('intent-1');
    expect(charge.status).toBe('SUCCEEDED');
    expect(charge.amountMinor).toBe(499_900);
    expect(charge.paidAt).toBeInstanceOf(Date);
  });

  it('carries a failure code a support desk can act on', async () => {
    const p = provider();
    await p.createCharge(chargeInput);
    await p.simulate('charge', 'intent-1', 'DECLINE');

    const charge = await p.getCharge('intent-1');
    expect(charge.status).toBe('FAILED');
    expect(charge.failureCode).toBe('CARD_DECLINED');
  });

  it('treats an unknown charge as EXPIRED, never as paid', async () => {
    expect((await provider().getCharge('never-created')).status).toBe('EXPIRED');
  });
});

describe('webhooks', () => {
  it('emits an event the provider can verify and read back', async () => {
    const p = provider();
    await p.createCharge(chargeInput);
    const raw = await p.simulate('charge', 'intent-1', 'SUCCEED');

    const event = p.parseWebhook(raw);
    expect(event.type).toBe('charge.succeeded');
    expect(event.reference).toBe('intent-1');
    expect(event.charge?.amountMinor).toBe(499_900);
  });

  it('refuses a body that was tampered with after signing', async () => {
    const p = provider();
    await p.createCharge(chargeInput);
    const raw = await p.simulate('charge', 'intent-1', 'SUCCEED');

    const tampered = {
      ...raw,
      body: Buffer.from(raw.body.toString('utf8').replace('499900', '1')),
    };
    expect(() => p.parseWebhook(tampered)).toThrow(WebhookVerificationError);
  });

  it('refuses a body with no signature at all', async () => {
    const p = provider();
    await p.createCharge(chargeInput);
    const raw = await p.simulate('charge', 'intent-1', 'SUCCEED');

    expect(() => p.parseWebhook({ body: raw.body, headers: {} })).toThrow(WebhookVerificationError);
  });

  it('gives a re-delivery the same event id, so the ledger can dedupe it', async () => {
    const p = provider();
    await p.createCharge(chargeInput);

    const first = p.parseWebhook(
      await p.simulate('charge', 'intent-1', 'SUCCEED', { eventId: 'evt-7' })
    );
    const replay = p.parseWebhook(
      await p.simulate('charge', 'intent-1', 'SUCCEED', { eventId: 'evt-7' })
    );

    expect(replay.id).toBe(first.id);
  });
});

describe('mandates', () => {
  const mandateInput = {
    reference: 'mandate-1',
    currency: 'INR',
    customer,
    description: 'rcln subscription',
    returnUrl: 'http://alpha.lvh.me:3000/billing/return',
    maxAmountMinor: 1_000_000,
    interval: 'MONTH' as const,
  };

  it('is not debitable until the customer has authorised it', async () => {
    const p = provider();
    await p.createMandate(mandateInput);

    await expect(
      p.createCharge({ ...chargeInput, reference: 'intent-2', mandateId: 'mandate-1' })
    ).rejects.toThrow(PaymentDeclinedError);
  });

  it('debits off-session once active, with no redirect', async () => {
    const p = provider();
    await p.createMandate(mandateInput);
    await p.simulate('mandate', 'mandate-1', 'SUCCEED');

    const charge = await p.createCharge({
      ...chargeInput,
      reference: 'intent-2',
      mandateId: 'mandate-1',
    });

    expect(charge.status).toBe('SUCCEEDED');
    expect(charge.redirectUrl).toBeUndefined();
  });

  it('refuses a debit above the authorised ceiling', async () => {
    const p = provider();
    await p.createMandate(mandateInput);
    await p.simulate('mandate', 'mandate-1', 'SUCCEED');

    await expect(
      p.createCharge({
        ...chargeInput,
        reference: 'intent-3',
        amountMinor: 2_000_000,
        mandateId: 'mandate-1',
      })
    ).rejects.toMatchObject({ providerCode: 'MANDATE_LIMIT_EXCEEDED' });
  });

  it('cancels idempotently, including one that was never created', async () => {
    const p = provider();
    await p.createMandate(mandateInput);
    await p.simulate('mandate', 'mandate-1', 'SUCCEED');

    expect((await p.cancelMandate('mandate-1')).status).toBe('CANCELLED');
    expect((await p.cancelMandate('mandate-1')).status).toBe('CANCELLED');
    expect((await p.cancelMandate('never-existed')).status).toBe('CANCELLED');
  });

  it('stops debits once cancelled', async () => {
    const p = provider();
    await p.createMandate(mandateInput);
    await p.simulate('mandate', 'mandate-1', 'SUCCEED');
    await p.cancelMandate('mandate-1');

    await expect(
      p.createCharge({ ...chargeInput, reference: 'intent-4', mandateId: 'mandate-1' })
    ).rejects.toThrow(PaymentDeclinedError);
  });
});

describe('embedded mode', () => {
  /*
   * The mock has a widget path so that `PAYMENT_PROVIDER=mock` exercises the
   * SAME branch production takes. Without it the embedded flow would only ever
   * run against a real gateway — which is the arrangement that lets a broken
   * checkout ship.
   */
  it('hands back a token instead of a redirect', async () => {
    const charge = await provider().createCharge({ ...chargeInput, presentation: 'embedded' });

    expect(charge.redirectUrl).toBeUndefined();
    expect(charge.embedded?.provider).toBe('mock');
    // The charge id, which is what the sandbox component posts to /simulate.
    expect(charge.embedded?.token).toBe(charge.providerChargeId);
    expect(charge.status).toBe('PENDING');
  });

  it('still redirects when asked to', async () => {
    const charge = await provider().createCharge({ ...chargeInput, presentation: 'redirect' });

    expect(charge.embedded).toBeUndefined();
    expect(charge.redirectUrl).toContain('/billing/sandbox');
  });

  it('declares the capability, so the engine does not degrade it', async () => {
    expect(provider().capabilities.embeddedCheckout).toBe(true);
  });
});
