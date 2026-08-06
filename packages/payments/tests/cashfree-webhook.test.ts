/**
 * Cashfree webhook verification.
 *
 * WHY THIS EXISTS, LATE
 *   Only the mock provider's verification was tested. The two implement the same
 *   scheme, so "the mock verifies" was taken as evidence that the Cashfree
 *   adapter would too — which proves nothing about whether the scheme matches
 *   what CASHFREE actually sends. The first live delivery answered 401 and there
 *   was no way to tell a wrong secret from a wrong implementation.
 *
 *   These cases pin the scheme itself: base64(HMAC-SHA256(timestamp + rawBody))
 *   over the EXACT bytes received, per Cashfree's PG webhook documentation.
 */
import { createHmac } from 'node:crypto';
import { CashfreeProvider } from '../src/providers/cashfree.js';
import { WebhookVerificationError } from '../src/errors.js';

const SECRET = 'test_secret_key_abc123';

function provider(): CashfreeProvider {
  return new CashfreeProvider({
    appId: 'TEST_APP_ID',
    secretKey: SECRET,
    environment: 'sandbox',
  });
}

/** Sign exactly as Cashfree documents it. */
function sign(body: string, secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac('sha256', secret)
    .update(timestamp)
    .update(Buffer.from(body, 'utf8'))
    .digest('base64');

  return {
    body: Buffer.from(body, 'utf8'),
    headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
  };
}

/** A PAYMENT_SUCCESS_WEBHOOK as documented for x-api-version 2023-08-01. */
const PAYMENT_SUCCESS = JSON.stringify({
  data: {
    order: { order_id: 'intent-1', order_amount: 4999.0, order_currency: 'INR' },
    payment: {
      cf_payment_id: '1234567890',
      payment_status: 'SUCCESS',
      payment_amount: 4999.0,
      payment_currency: 'INR',
      payment_time: '2026-08-05T18:52:40+05:30',
      payment_method: { card: { card_number: '424242XXXXXX4242', channel: 'link' } },
    },
    customer_details: { customer_id: 'org-1', customer_email: 'billing@example.test' },
  },
  event_time: '2026-08-05T18:52:40+05:30',
  type: 'PAYMENT_SUCCESS_WEBHOOK',
});

describe('signature scheme', () => {
  it('accepts a correctly signed delivery', () => {
    const event = provider().parseWebhook(sign(PAYMENT_SUCCESS));

    expect(event.type).toBe('charge.succeeded');
    expect(event.reference).toBe('intent-1');
    // Major units on the wire, minor units in the domain.
    expect(event.charge?.amountMinor).toBe(499_900);
    expect(event.charge?.currency).toBe('INR');
    expect(event.charge?.instrumentLabel).toBe('4242');
    expect(event.charge?.method).toBe('CARD');
  });

  it('signs over timestamp THEN body, not body then timestamp', () => {
    // The most likely way to get this backwards, and it fails identically to a
    // wrong secret — which is why it is pinned rather than reasoned about.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const reversed = createHmac('sha256', SECRET)
      .update(Buffer.from(PAYMENT_SUCCESS, 'utf8'))
      .update(timestamp)
      .digest('base64');

    expect(() =>
      provider().parseWebhook({
        body: Buffer.from(PAYMENT_SUCCESS, 'utf8'),
        headers: { 'x-webhook-signature': reversed, 'x-webhook-timestamp': timestamp },
      })
    ).toThrow(WebhookVerificationError);
  });

  it('refuses a signature made with a different secret', () => {
    expect(() => provider().parseWebhook(sign(PAYMENT_SUCCESS, 'the_wrong_secret'))).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses an EMPTY body signed with the right secret', () => {
    /*
     * The failure this test exists for.
     *
     * If `express.raw()` does not run — mounted after `express.json()`, or a
     * content type the parser did not match — the handler gets `{}` rather than
     * a Buffer and hashes zero bytes. The HMAC then covers only the timestamp
     * and fails, presenting as "signature did not verify" and sending whoever
     * debugs it to check the secret, which is fine.
     */
    const real = sign(PAYMENT_SUCCESS);
    expect(() => provider().parseWebhook({ ...real, body: Buffer.from('') })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a body altered after signing', () => {
    const real = sign(PAYMENT_SUCCESS);
    // `JSON.stringify(4999.0)` emits `4999`, so tamper with a string that is
    // actually present — an earlier version of this test replaced "4999.00",
    // matched nothing, and passed a byte-identical body.
    const tampered = Buffer.from(
      real.body.toString('utf8').replace('"payment_amount":4999', '"payment_amount":1'),
      'utf8'
    );
    expect(tampered.equals(real.body)).toBe(false);
    expect(() => provider().parseWebhook({ ...real, body: tampered })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a re-serialised body, even with identical content', () => {
    // JSON.parse → JSON.stringify reorders keys and drops whitespace. This is
    // exactly why the route mounts express.raw() and nothing downstream touches
    // the bytes.
    const real = sign(PAYMENT_SUCCESS);
    const restringified = Buffer.from(
      JSON.stringify(JSON.parse(real.body.toString('utf8')), null, 2),
      'utf8'
    );
    expect(() => provider().parseWebhook({ ...real, body: restringified })).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a captured delivery replayed hours later', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() => provider().parseWebhook(sign(PAYMENT_SUCCESS, SECRET, stale))).toThrow(
      WebhookVerificationError
    );
  });

  it('refuses a delivery with no signature headers at all', () => {
    expect(() =>
      provider().parseWebhook({ body: Buffer.from(PAYMENT_SUCCESS, 'utf8'), headers: {} })
    ).toThrow(WebhookVerificationError);
  });

  it('reads headers case-insensitively, as Node lowercases them', () => {
    const real = sign(PAYMENT_SUCCESS);
    const upper = {
      body: real.body,
      headers: {
        'X-Webhook-Signature': real.headers['x-webhook-signature'],
        'X-Webhook-Timestamp': real.headers['x-webhook-timestamp'],
      },
    };
    expect(provider().parseWebhook(upper).type).toBe('charge.succeeded');
  });
});

describe('which secret verifies', () => {
  /*
   * The regression this suite was extended for.
   *
   * `.env` files carry optional keys with empty values — `CASHFREE_WEBHOOK_SECRET=`
   * is how the variable ships, because most deployments never set it. That
   * reaches the adapter as `''`, and `'' ?? secretKey` is `''`, not the API
   * secret. Every live delivery was then verified against a zero-length key and
   * answered 401, with a log line that said only "signature did not verify".
   */
  it('falls back to the API secret when no webhook secret is given', () => {
    const p = new CashfreeProvider({ appId: 'A', secretKey: SECRET, environment: 'sandbox' });
    expect(p.parseWebhook(sign(PAYMENT_SUCCESS, SECRET)).type).toBe('charge.succeeded');
  });

  it('falls back when the webhook secret is an EMPTY STRING, not just undefined', () => {
    const p = new CashfreeProvider({
      appId: 'A',
      secretKey: SECRET,
      webhookSecret: '',
      environment: 'sandbox',
    });
    expect(p.parseWebhook(sign(PAYMENT_SUCCESS, SECRET)).type).toBe('charge.succeeded');
  });

  it('falls back when it is whitespace only', () => {
    const p = new CashfreeProvider({
      appId: 'A',
      secretKey: SECRET,
      webhookSecret: '   ',
      environment: 'sandbox',
    });
    expect(p.parseWebhook(sign(PAYMENT_SUCCESS, SECRET)).type).toBe('charge.succeeded');
  });

  it('uses a real webhook secret in preference to the API secret', () => {
    const p = new CashfreeProvider({
      appId: 'A',
      secretKey: SECRET,
      webhookSecret: 'a_separate_signing_secret',
      environment: 'sandbox',
    });

    expect(p.parseWebhook(sign(PAYMENT_SUCCESS, 'a_separate_signing_secret')).type).toBe(
      'charge.succeeded'
    );
    // And the API secret must NOT verify once a signing secret is configured.
    expect(() => p.parseWebhook(sign(PAYMENT_SUCCESS, SECRET))).toThrow(WebhookVerificationError);
  });

  it('tolerates a trailing newline on the key, as copy-paste produces', () => {
    const p = new CashfreeProvider({
      appId: 'A\n',
      secretKey: `${SECRET}\n`,
      environment: 'sandbox',
    });
    expect(p.parseWebhook(sign(PAYMENT_SUCCESS, SECRET)).type).toBe('charge.succeeded');
  });
});

describe('event mapping', () => {
  it('reads a failure with its issuer code', () => {
    const failed = JSON.stringify({
      data: {
        order: { order_id: 'intent-2', order_amount: 4999.0, order_currency: 'INR' },
        payment: {
          cf_payment_id: '999',
          payment_status: 'FAILED',
          payment_amount: 4999.0,
          payment_currency: 'INR',
          error_details: {
            error_code: 'card_declined',
            error_description: 'Issuer declined the transaction',
          },
        },
      },
      event_time: '2026-08-05T18:52:40+05:30',
      type: 'PAYMENT_FAILED_WEBHOOK',
    });

    const event = provider().parseWebhook(sign(failed));
    expect(event.type).toBe('charge.failed');
    expect(event.charge?.failureCode).toBe('card_declined');
  });

  it('treats an unrecognised event type as unknown rather than throwing', () => {
    // Providers add event types without asking. A 500 here makes Cashfree retry
    // for hours and then disable the endpoint, taking the events we DO need.
    const odd = JSON.stringify({
      data: { order: { order_id: 'intent-3' } },
      event_time: '2026-08-05T18:52:40+05:30',
      type: 'SOME_FUTURE_WEBHOOK',
    });

    expect(provider().parseWebhook(sign(odd)).type).toBe('unknown');
  });

  it('deduplicates a re-delivery that carries no event id', () => {
    // Cashfree does not send an event id on every type. The signature is a
    // deterministic function of the timestamp and the bytes, so it stands in.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const first = provider().parseWebhook(sign(PAYMENT_SUCCESS, SECRET, timestamp));
    const second = provider().parseWebhook(sign(PAYMENT_SUCCESS, SECRET, timestamp));

    expect(first.id).toBe(second.id);
  });
});
