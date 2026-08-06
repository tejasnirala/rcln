/**
 * Razorpay webhook verification and event mapping.
 *
 * WHY THIS SUITE EXISTS BEFORE A LIVE DELIVERY, UNLIKE THE CASHFREE ONE
 *   The Cashfree suite was written after the first live delivery answered 401,
 *   when there was no way to tell a wrong secret from a wrong implementation.
 *   That lesson is cheap to reuse: the signature scheme is the part that fails
 *   first, fails identically to a misconfiguration, and is the one part of an
 *   adapter that can be pinned without a gateway account.
 *
 *   Razorpay's scheme differs from Cashfree's in both of the ways that are easy
 *   to get wrong by copying the sibling file — HEX not base64, and the BODY
 *   ALONE rather than timestamp-then-body. Both are pinned below, negatively as
 *   well as positively, because "it verifies" does not prove "it verifies only
 *   the right thing".
 *
 * WHAT IS NOT COVERED HERE
 *   Every request shape in the adapter is from documentation and not from a
 *   captured session, and no test can fix that — a wrong field name would pass
 *   these and fail against Razorpay. Run the flows in test mode before pointing
 *   production at it.
 */
import { createHmac } from 'node:crypto';
import { RazorpayProvider } from '../src/providers/razorpay.js';
import { PaymentConfigurationError, WebhookVerificationError } from '../src/errors.js';

const SECRET = 'test_webhook_secret_abc123';

function provider(): RazorpayProvider {
  return new RazorpayProvider({
    keyId: 'rzp_test_ABCDEF123456',
    keySecret: 'test_api_secret',
    webhookSecret: SECRET,
    environment: 'sandbox',
  });
}

/** Sign exactly as Razorpay documents it: hex(HMAC-SHA256(rawBody)). */
function sign(body: string, secret = SECRET, eventId = 'evt_00000000000001') {
  return {
    body: Buffer.from(body, 'utf8'),
    headers: {
      'x-razorpay-signature': createHmac('sha256', secret)
        .update(Buffer.from(body, 'utf8'))
        .digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}

/** A `payment_link.paid` as documented — a clinic completing hosted checkout. */
const LINK_PAID = JSON.stringify({
  entity: 'event',
  event: 'payment_link.paid',
  created_at: 1_785_000_000,
  payload: {
    payment_link: {
      entity: {
        id: 'plink_abc',
        reference_id: 'intent-1',
        amount: 499_900,
        amount_paid: 499_900,
        currency: 'INR',
        status: 'paid',
      },
    },
    payment: {
      entity: {
        id: 'pay_abc',
        amount: 499_900,
        currency: 'INR',
        status: 'captured',
        method: 'card',
        card: { last4: '4242', network: 'Visa' },
        created_at: 1_785_000_000,
        notes: { reference: 'intent-1' },
      },
    },
  },
});

describe('signature scheme', () => {
  it('accepts a correctly signed delivery', () => {
    const event = provider().parseWebhook(sign(LINK_PAID));

    expect(event.type).toBe('charge.succeeded');
    expect(event.reference).toBe('intent-1');
    // Minor units on the wire AND in the domain — no decimal conversion here,
    // which is the whole difference from the Cashfree adapter's amounts.
    expect(event.charge?.amountMinor).toBe(499_900);
    expect(event.charge?.currency).toBe('INR');
    expect(event.charge?.instrumentLabel).toBe('4242');
    expect(event.charge?.method).toBe('CARD');
  });

  it('signs in HEX, not the base64 Cashfree uses', () => {
    // The single most likely way to get this wrong is to copy the sibling
    // adapter. base64 and hex of the same HMAC differ in length, so this would
    // also exercise the length guard before timingSafeEqual.
    const base64 = createHmac('sha256', SECRET)
      .update(Buffer.from(LINK_PAID, 'utf8'))
      .digest('base64');

    expect(() =>
      provider().parseWebhook({
        body: Buffer.from(LINK_PAID, 'utf8'),
        headers: { 'x-razorpay-signature': base64 },
      })
    ).toThrow(WebhookVerificationError);
  });

  it('signs the BODY ALONE, not timestamp-then-body', () => {
    // The other way copying Cashfree goes wrong. Fails identically to a wrong
    // secret, which is exactly why it is pinned rather than reasoned about.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const withTimestamp = createHmac('sha256', SECRET)
      .update(timestamp)
      .update(Buffer.from(LINK_PAID, 'utf8'))
      .digest('hex');

    expect(() =>
      provider().parseWebhook({
        body: Buffer.from(LINK_PAID, 'utf8'),
        headers: { 'x-razorpay-signature': withTimestamp },
      })
    ).toThrow(WebhookVerificationError);
  });

  it('refuses a signature made with a different secret', () => {
    expect(() => provider().parseWebhook(sign(LINK_PAID, 'the_wrong_secret'))).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses the API secret, which does NOT sign Razorpay webhooks', () => {
    // Unlike Cashfree, where the API secret is the default signing key. Somebody
    // will try it; it must not work.
    expect(() => provider().parseWebhook(sign(LINK_PAID, 'test_api_secret'))).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses an EMPTY body signed with the right secret', () => {
    /*
     * The failure this test exists for: if `express.raw()` does not run —
     * mounted after `express.json()`, or a content type the parser did not match
     * — the handler gets `{}` rather than a Buffer and hashes zero bytes.
     */
    const real = sign(LINK_PAID);
    expect(() => provider().parseWebhook({ ...real, body: Buffer.from('') })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a body altered after signing', () => {
    const real = sign(LINK_PAID);
    const tampered = Buffer.from(
      real.body.toString('utf8').replace('"amount":499900', '"amount":100'),
      'utf8'
    );
    expect(tampered.equals(real.body)).toBe(false);
    expect(() => provider().parseWebhook({ ...real, body: tampered })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a re-serialised body, even with identical content', () => {
    const real = sign(LINK_PAID);
    const restringified = Buffer.from(
      JSON.stringify(JSON.parse(real.body.toString('utf8')), null, 2),
      'utf8'
    );
    expect(() => provider().parseWebhook({ ...real, body: restringified })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a delivery with no signature header at all', () => {
    expect(() =>
      provider().parseWebhook({ body: Buffer.from(LINK_PAID, 'utf8'), headers: {} })
    ).toThrow(WebhookVerificationError);
  });

  it('reads headers case-insensitively, as Node lowercases them', () => {
    const real = sign(LINK_PAID);
    expect(
      provider().parseWebhook({
        body: real.body,
        headers: {
          'X-Razorpay-Signature': real.headers['x-razorpay-signature'],
          'X-Razorpay-Event-Id': real.headers['x-razorpay-event-id'],
        },
      }).type
    ).toBe('charge.succeeded');
  });
});

describe('replay protection is the ledger, not a clock', () => {
  /*
   * ⚠️ THIS TEST ASSERTS AN ABSENCE ON PURPOSE. Read the comment on
   *   `parseWebhook` before "fixing" it.
   *
   *   Cashfree signs a timestamp, so a captured delivery expires and its suite
   *   asserts that. Razorpay signs the body alone and retries a failed delivery
   *   for 24 hours with byte-identical content — so any age window would refuse
   *   legitimate retries, and Razorpay disables an endpoint that keeps refusing.
   *   Replay safety comes from the unique index on
   *   `(provider, provider_event_id)` instead.
   */
  it('accepts a delivery whose created_at is a day old, because retries are', () => {
    const old = JSON.parse(LINK_PAID) as Record<string, unknown>;
    old['created_at'] = Math.floor(Date.now() / 1000) - 86_400;

    const event = provider().parseWebhook(sign(JSON.stringify(old)));
    expect(event.type).toBe('charge.succeeded');
  });

  it('carries the event id a redelivery deduplicates on', () => {
    expect(provider().parseWebhook(sign(LINK_PAID, SECRET, 'evt_XYZ')).id).toBe('evt_XYZ');
  });

  it('falls back to the signature when no event id header is sent', () => {
    // Deterministic in the bytes, so a redelivery of the same event collides on
    // the unique index exactly as an event id would.
    const real = sign(LINK_PAID);
    const withoutId = {
      body: real.body,
      headers: { 'x-razorpay-signature': real.headers['x-razorpay-signature'] },
    };

    const first = provider().parseWebhook(withoutId);
    const second = provider().parseWebhook(withoutId);

    expect(first.id).toBe(second.id);
    expect(first.id.startsWith('sig:')).toBe(true);
  });

  it('treats a BLANK event id header as absent rather than as an id', () => {
    // Every delivery would otherwise share the id `''`, collide on the unique
    // index, and the second real event would be silently dropped as a duplicate.
    const real = sign(LINK_PAID, SECRET, '');
    expect(provider().parseWebhook(real).id.startsWith('sig:')).toBe(true);
  });
});

describe('event mapping', () => {
  it('does NOT settle a partially paid link, even though its payment captured', () => {
    /*
     * The mapping that matters most. `payment_link.partially_paid` carries a
     * CAPTURED payment against an UNPAID link: reading the payment's status
     * would report a successful charge for less than the invoice.
     */
    const partial = JSON.stringify({
      entity: 'event',
      event: 'payment_link.partially_paid',
      created_at: 1_785_000_000,
      payload: {
        payment_link: {
          entity: {
            id: 'plink_abc',
            reference_id: 'intent-9',
            amount: 499_900,
            amount_paid: 100_000,
            currency: 'INR',
            status: 'partially_paid',
          },
        },
        payment: {
          entity: { id: 'pay_part', amount: 100_000, currency: 'INR', status: 'captured' },
        },
      },
    });

    const event = provider().parseWebhook(sign(partial));
    expect(event.type).toBe('charge.pending');
    expect(event.charge?.status).toBe('PENDING');
    // And the amount reported is what ARRIVED, not what was owed.
    expect(event.charge?.amountMinor).toBe(100_000);
  });

  it('reads a failed recurring debit, which has notes and no link', () => {
    // An unattended renewal: there is no payment link, so the reference can only
    // come from the notes the adapter puts on the order and the payment.
    const failed = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      created_at: 1_785_000_000,
      payload: {
        payment: {
          entity: {
            id: 'pay_fail',
            amount: 499_900,
            currency: 'INR',
            status: 'failed',
            method: 'upi',
            vpa: 'someone@okhdfcbank',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Insufficient funds in the account',
            notes: { reference: 'intent-2' },
          },
        },
      },
    });

    const event = provider().parseWebhook(sign(failed));
    expect(event.type).toBe('charge.failed');
    expect(event.reference).toBe('intent-2');
    expect(event.charge?.providerChargeId).toBe('pay_fail');
    expect(event.charge?.failureCode).toBe('BAD_REQUEST_ERROR');
    expect(event.charge?.failureMessage).toBe('Insufficient funds in the account');
    expect(event.charge?.method).toBe('UPI');
    // The handle, never the local part — that identifies a person.
    expect(event.charge?.instrumentLabel).toBe('@okhdfcbank');
  });

  it('activates a mandate from the auth link invoice, with a composite id', () => {
    /*
     * `invoice.paid` is the ONLY mandate event carrying our receipt, which is
     * why it — and not `token.confirmed` — is what activates a mandate. The id
     * changes from the invoice to `customer:token` here; see the adapter header.
     */
    const authorised = JSON.stringify({
      entity: 'event',
      event: 'invoice.paid',
      created_at: 1_785_000_000,
      payload: {
        invoice: {
          entity: {
            id: 'inv_abc',
            receipt: 'mandate-1',
            customer_id: 'cust_1',
            token_id: 'token_1',
            currency: 'INR',
            status: 'paid',
            paid_at: 1_785_000_000,
            subscription_registration: { max_amount: 1_000_000, expire_at: 1_900_000_000 },
          },
        },
      },
    });

    const event = provider().parseWebhook(sign(authorised));
    expect(event.type).toBe('mandate.activated');
    expect(event.reference).toBe('mandate-1');
    expect(event.mandate?.providerMandateId).toBe('cust_1:token_1');
    expect(event.mandate?.maxAmountMinor).toBe(1_000_000);
  });

  it('does not activate a mandate whose auth link expired unpaid', () => {
    const expired = JSON.stringify({
      entity: 'event',
      event: 'invoice.expired',
      created_at: 1_785_000_000,
      payload: {
        invoice: {
          entity: { id: 'inv_abc', receipt: 'mandate-2', customer_id: 'cust_1', status: 'expired' },
        },
      },
    });

    const event = provider().parseWebhook(sign(expired));
    expect(event.type).toBe('mandate.failed');
    expect(event.reference).toBe('mandate-2');
  });

  it('prefers recurring_details.status over a token that merely exists', () => {
    /*
     * The two disagree between the customer approving an e-mandate and the bank
     * confirming it. Trusting the token's own `active` would start renewals
     * against a mandate no bank has agreed to honour yet.
     */
    const unconfirmed = JSON.stringify({
      entity: 'event',
      event: 'token.confirmed',
      created_at: 1_785_000_000,
      payload: {
        token: {
          entity: {
            id: 'token_1',
            customer_id: 'cust_1',
            status: 'active',
            recurring_details: { status: 'initiated', max_amount: 1_000_000 },
            notes: { reference: 'mandate-3' },
          },
        },
      },
    });

    const event = provider().parseWebhook(sign(unconfirmed));
    expect(event.mandate?.status).toBe('PENDING');
    // PENDING is not an outcome we act on, so the event degrades to unknown and
    // `dispatch` records and ignores it.
    expect(event.type).toBe('unknown');
  });

  it('treats an unrecognised event type as unknown rather than throwing', () => {
    // Providers add event types without asking. A 500 here makes Razorpay retry
    // for 24 hours and then disable the endpoint, taking the events we DO need.
    const odd = JSON.stringify({
      entity: 'event',
      event: 'payment.downtime.started',
      created_at: 1_785_000_000,
      payload: {},
    });

    expect(provider().parseWebhook(sign(odd)).type).toBe('unknown');
  });

  it('records an informational event without acting on it', () => {
    // `payment.pending` is India's "the bank is thinking about it" state for
    // netbanking. It is NOT a failure and must not start dunning.
    const pending = JSON.stringify({
      entity: 'event',
      event: 'payment.pending',
      created_at: 1_785_000_000,
      payload: {
        payment: { entity: { id: 'pay_p', status: 'pending', notes: { reference: 'intent-4' } } },
      },
    });

    const event = provider().parseWebhook(sign(pending));
    expect(event.type).toBe('unknown');
    // Still attributed, so the ledger row is useful to an operator.
    expect(event.reference).toBe('intent-4');
  });

  it('maps a processed refund', () => {
    const refunded = JSON.stringify({
      entity: 'event',
      event: 'refund.processed',
      created_at: 1_785_000_000,
      payload: {
        refund: {
          entity: {
            id: 'rfnd_1',
            payment_id: 'pay_abc',
            amount: 100_000,
            currency: 'INR',
            status: 'processed',
            notes: { reference: 'refund-1' },
          },
        },
      },
    });

    const event = provider().parseWebhook(sign(refunded));
    expect(event.type).toBe('refund.succeeded');
    expect(event.refund?.amountMinor).toBe(100_000);
    expect(event.refund?.providerChargeId).toBe('pay_abc');
  });
});

describe('configuration guards', () => {
  const base = {
    keySecret: 'test_api_secret',
    webhookSecret: SECRET,
  };

  it('refuses a LIVE key in a sandbox deployment', () => {
    /*
     * The guard that replaces a sandbox hostname. Razorpay serves test and live
     * from the same URL, so without this a copy-pasted live key charges real
     * cards from staging and the first symptom is a customer's statement.
     */
    expect(
      () => new RazorpayProvider({ ...base, keyId: 'rzp_live_ABC', environment: 'sandbox' })
    ).toThrow(PaymentConfigurationError);
  });

  it('refuses a TEST key in production, where it would collect nothing', () => {
    expect(
      () => new RazorpayProvider({ ...base, keyId: 'rzp_test_ABC', environment: 'production' })
    ).toThrow(PaymentConfigurationError);
  });

  it('allows a key whose prefix it does not recognise', () => {
    // Refusing an unfamiliar prefix would block a legitimate deployment for no
    // security gain — Razorpay has used others historically.
    expect(
      () => new RazorpayProvider({ ...base, keyId: 'partner_key_ABC', environment: 'sandbox' })
    ).not.toThrow();
  });

  it('refuses to construct with NO webhook secret — there is nothing to fall back to', () => {
    expect(
      () =>
        new RazorpayProvider({
          keyId: 'rzp_test_ABC',
          keySecret: 'test_api_secret',
          webhookSecret: '',
          environment: 'sandbox',
        })
    ).toThrow(PaymentConfigurationError);
  });

  it('treats a whitespace-only webhook secret as absent', () => {
    // `.env` ships optional keys blank, and `'' ?? fallback` is `''`. On Cashfree
    // that silently verified every delivery against a zero-length key.
    expect(
      () =>
        new RazorpayProvider({
          keyId: 'rzp_test_ABC',
          keySecret: 'test_api_secret',
          webhookSecret: '   ',
          environment: 'sandbox',
        })
    ).toThrow(PaymentConfigurationError);
  });

  it('tolerates a trailing newline on the keys, as copy-paste produces', () => {
    const p = new RazorpayProvider({
      keyId: 'rzp_test_ABC\n',
      keySecret: 'test_api_secret\n',
      webhookSecret: `${SECRET}\n`,
      environment: 'sandbox',
    });

    expect(p.parseWebhook(sign(LINK_PAID)).type).toBe('charge.succeeded');
  });
});
