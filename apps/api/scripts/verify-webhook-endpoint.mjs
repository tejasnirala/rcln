/**
 * Sign a webhook the way the configured provider does, post it at our own
 * endpoint, and say what the answer means.
 *
 * WHY THIS EXISTS
 *   A 401 from the webhook route has three causes that look identical from the
 *   outside: the secret in `.env` is not the one the provider signs with, the
 *   raw body is not reaching the handler, or the implementation is wrong. This
 *   isolates the first two, using the secret the API is actually configured with.
 *
 *     PASS  → the endpoint, the body parsing and the secret in `.env` are all
 *             fine, so the provider is signing with a DIFFERENT secret. Almost
 *             always sandbox keys against a production webhook or the reverse.
 *     401   → the secret here is the problem, or the raw body is not arriving.
 *             The API's own log now says which — check `bodyBytes`.
 *     404   → `PAYMENT_PROVIDER` does not match the path segment.
 *
 * Usage, from the repo root:
 *   node apps/api/scripts/verify-webhook-endpoint.mjs
 *   node apps/api/scripts/verify-webhook-endpoint.mjs https://abc.ngrok-free.app
 *
 * It posts a success event for a charge id that does not exist, so a verified
 * delivery is recorded and then ignored. Nothing is charged, and no subscription
 * is touched.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:5000').replace(/\/$/, '');
const provider = process.env.PAYMENT_PROVIDER ?? 'mock';

/**
 * The secret each adapter would actually verify with.
 *
 * Cashfree falls back to the API secret when no separate signing secret is set.
 * Razorpay has NO fallback — its signing secret is chosen in the dashboard and
 * is unrelated to the API secret, so an empty one here is the answer, not a
 * reason to substitute something else.
 */
const SECRETS = {
  cashfree: () => process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY,
  razorpay: () => process.env.RAZORPAY_WEBHOOK_SECRET,
  mock: () => process.env.MOCK_PAYMENTS_SECRET ?? 'mock-payments-development-secret',
};

const secret = (SECRETS[provider] ?? SECRETS.mock)();

if (!secret) {
  console.error(`No secret configured for PAYMENT_PROVIDER=${provider}.`);
  if (provider === 'razorpay') {
    console.error(
      'Razorpay needs RAZORPAY_WEBHOOK_SECRET — the value you typed into\n' +
        'Settings → Webhooks in the Razorpay dashboard. It is not the API secret.'
    );
  }
  process.exit(1);
}

// Reported so a trailing newline or a stray quote in .env is visible. The
// secret itself is never printed.
console.log(`provider   ${provider}`);
console.log(`endpoint   ${base}/api/v1/webhooks/payments/${provider}`);
console.log(`secret     ${secret.length} characters`);
if (secret !== secret.trim()) {
  console.warn('  ⚠ it has leading or trailing whitespace — that alone will fail every signature');
}

const probeId = `probe-${randomUUID()}`;

/**
 * One probe per signing scheme. The point is to reproduce the provider's scheme
 * EXACTLY — a probe that signs differently from the real provider proves nothing
 * about the real provider, which is the trap this script exists to avoid.
 */
function razorpayProbe() {
  // Razorpay: hex(HMAC-SHA256(rawBody)). Body only, no timestamp — see the long
  // comment on parseWebhook in providers/razorpay.ts for why.
  const body = JSON.stringify({
    entity: 'event',
    event: 'payment_link.paid',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment_link: {
        entity: {
          id: 'plink_probe',
          reference_id: probeId,
          amount: 100,
          currency: 'INR',
          status: 'paid',
        },
      },
      payment: {
        entity: {
          id: 'pay_probe',
          amount: 100,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
        },
      },
    },
  });

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret)
        .update(Buffer.from(body, 'utf8'))
        .digest('hex'),
      'x-razorpay-event-id': `evt_probe_${randomUUID()}`,
    },
  };
}

function cashfreeStyleProbe() {
  // Cashfree and the mock: base64(HMAC-SHA256(timestamp + rawBody)).
  const body = JSON.stringify({
    data: {
      order: { order_id: probeId, order_amount: 1.0, order_currency: 'INR' },
      payment: {
        cf_payment_id: 'probe',
        payment_status: 'SUCCESS',
        payment_amount: 1.0,
        payment_currency: 'INR',
      },
    },
    event_time: new Date().toISOString(),
    type: 'PAYMENT_SUCCESS_WEBHOOK',
  });

  const timestamp = String(Math.floor(Date.now() / 1000));

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': createHmac('sha256', secret)
        .update(timestamp)
        .update(Buffer.from(body, 'utf8'))
        .digest('base64'),
      'x-webhook-timestamp': timestamp,
    },
  };
}

const probe = provider === 'razorpay' ? razorpayProbe() : cashfreeStyleProbe();

const response = await fetch(`${base}/api/v1/webhooks/payments/${provider}`, {
  method: 'POST',
  headers: probe.headers,
  body: probe.body,
});

const text = await response.text();
console.log(`\n${String(response.status)} ${text}`);

if (response.status === 200) {
  console.log(
    '\n✓ Verification passed. The endpoint, the raw body and this secret all work.\n' +
      '  A 401 from the real provider therefore means it signs with a different\n' +
      '  secret — check you are using the SANDBOX keys with the sandbox dashboard.'
  );
} else if (response.status === 401) {
  console.log(
    '\n✗ Refused with the configured secret. Either the secret is wrong, or the raw\n' +
      '  body is not reaching the handler. The API log line "webhook signature\n' +
      '  rejected" now carries bodyBytes — -1 or 0 means the body, not the secret.'
  );
} else if (response.status === 404) {
  console.log(
    `\n✗ 404. PAYMENT_PROVIDER is "${provider}"; the path segment must match it,\n` +
      '  and both must match the URL registered in the provider dashboard.'
  );
}

process.exit(response.status === 200 ? 0 : 1);
