/**
 * What the Razorpay adapter asks for when the widget is mounted on our own page.
 *
 * WHY THESE ARE WORTH PINNING WITHOUT A GATEWAY
 *   The request SHAPES here are from documentation and a test cannot fix that.
 *   What a test can fix is the set of decisions that are ours rather than
 *   Razorpay's, and each of these has a specific failure behind it:
 *
 *     - an Order and not a Payment Link, or every abandoned checkout leaves a
 *       live payable link loose in the merchant account;
 *     - the reference in `receipt` AND `notes`, or the webhook cannot be
 *       attributed and `dispatch` silently ignores a successful payment;
 *     - the PUBLISHABLE key in the handoff and never the secret, which is the
 *       one mistake here that would be a genuine incident;
 *     - no redirect on the embedded path, or the screen would both mount a
 *       widget and navigate away from it.
 */
import { RazorpayProvider } from '../src/providers/razorpay.js';

const KEY_ID = 'rzp_test_ABCDEF123456';
const KEY_SECRET = 'super_secret_do_not_leak';

function provider(): RazorpayProvider {
  return new RazorpayProvider({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: 'test_webhook_secret',
    environment: 'sandbox',
  });
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let calls: Call[] = [];

/** Answer every request with `response`, recording what was asked. */
function stubFetch(response: Record<string, unknown>): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const REFERENCE = '7f3c1c4e-9a2b-4c1d-8e5f-0a1b2c3d4e5f';

const CHARGE = {
  reference: REFERENCE,
  amountMinor: 499_900,
  currency: 'INR',
  customer: {
    reference: 'org-1',
    name: 'Alpha Clinic',
    email: 'billing@example.test',
    phone: '+919000000000',
  },
  description: 'Professional plan, monthly',
  returnUrl: 'https://alpha.example.test/billing/return?kind=charge',
};

const ORDER = {
  id: 'order_ABC123',
  entity: 'order',
  amount: 499_900,
  currency: 'INR',
  receipt: REFERENCE,
  status: 'created',
};

describe('embedded checkout', () => {
  it('creates an ORDER, not a payment link', async () => {
    stubFetch(ORDER);
    await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/orders');
    expect(calls[0]?.url).not.toContain('payment_links');
    expect(calls[0]?.method).toBe('POST');
  });

  it('sends the amount in minor units, unconverted', async () => {
    stubFetch(ORDER);
    await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    // 499900 paise. Not "4999.00", which is what the Cashfree adapter sends and
    // what a copy of it would send here.
    expect(calls[0]?.body['amount']).toBe(499_900);
    expect(calls[0]?.body['currency']).toBe('INR');
  });

  it('carries the reference in BOTH receipt and notes', async () => {
    stubFetch(ORDER);
    await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    // `receipt` is on the order; `notes` is the one that survives onto the
    // payment, which is where `payment.captured` reads it from.
    expect(calls[0]?.body['receipt']).toBe(REFERENCE);
    expect(calls[0]?.body['notes']).toEqual({ reference: REFERENCE });
  });

  it('auto-captures, so an authorised payment cannot expire uncaptured', async () => {
    stubFetch(ORDER);
    await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    expect(calls[0]?.body['payment_capture']).toBe(true);
  });

  it('hands back the publishable key and the order, and no redirect', async () => {
    stubFetch(ORDER);
    const charge = await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    expect(charge.embedded).toEqual({
      provider: 'razorpay',
      publicKey: KEY_ID,
      token: 'order_ABC123',
    });
    // Exactly one of the two, or the screen mounts a widget and navigates away
    // from it in the same render.
    expect(charge.redirectUrl).toBeUndefined();
    expect(charge.providerChargeId).toBe('order_ABC123');
    expect(charge.status).toBe('PENDING');
  });

  it('NEVER puts the API secret in the handoff', async () => {
    /*
     * The one mistake in this file that would be an incident rather than a bug.
     * `publicKey` is sent to a browser; the secret authenticates every call to
     * Razorpay. Asserted over the whole serialised result, not just the field,
     * so a secret smuggled through `raw` fails this too.
     */
    stubFetch(ORDER);
    const charge = await provider().createCharge({ ...CHARGE, presentation: 'embedded' });

    expect(JSON.stringify(charge)).not.toContain(KEY_SECRET);
  });

  it('still uses a payment link when presentation is redirect', async () => {
    stubFetch({ id: 'plink_ABC', short_url: 'https://rzp.io/i/abc', status: 'created' });
    const charge = await provider().createCharge({ ...CHARGE, presentation: 'redirect' });

    expect(calls[0]?.url).toContain('/payment_links');
    expect(charge.redirectUrl).toBe('https://rzp.io/i/abc');
    expect(charge.embedded).toBeUndefined();
  });

  it('defaults to the hosted page when no presentation is given', async () => {
    // The floor: an older caller that has never heard of `presentation` keeps
    // the behaviour it had.
    stubFetch({ id: 'plink_ABC', short_url: 'https://rzp.io/i/abc', status: 'created' });
    const charge = await provider().createCharge(CHARGE);

    expect(calls[0]?.url).toContain('/payment_links');
    expect(charge.embedded).toBeUndefined();
  });

  it('ignores presentation entirely for an off-session mandate debit', async () => {
    /*
     * A renewal has no customer and no page. If `presentation: 'embedded'` ever
     * produced a widget handoff here, the worker would return one to a scheduler
     * at 03:00 and the renewal would never be charged.
     */
    stubFetch({ id: 'order_R1', razorpay_payment_id: 'pay_R1', status: 'created' });
    const charge = await provider().createCharge({
      ...CHARGE,
      presentation: 'embedded',
      mandateId: 'cust_1:token_1',
    });

    expect(charge.embedded).toBeUndefined();
    expect(charge.redirectUrl).toBeUndefined();
    expect(calls.some((call) => call.url.includes('/payments/create/recurring'))).toBe(true);
  });
});
