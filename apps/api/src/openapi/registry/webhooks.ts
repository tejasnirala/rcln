/**
 * Webhooks — payment providers posting to us.
 *
 * ⚠️ MOUNTED AHEAD OF THE BODY PARSERS, and the order is load-bearing. A
 *   signature covers the exact bytes the provider sent; `express.json()` would
 *   parse and discard them, and re-serializing produces different bytes and a
 *   failing check for reasons nobody can see in the request.
 *
 * ⚠️ AUTHENTICATED BY SIGNATURE, NOT BY TOKEN. There is no session here, no
 *   tenant guard and no permission — the provider's shared secret is the whole
 *   authentication story, which is why an unverifiable body is dropped rather
 *   than investigated.
 */
import type { DocRegistry } from '../types.js';

const INGEST_RESULT = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['processed', 'duplicate', 'ignored'],
      description:
        '`processed` — the ledger moved. `duplicate` — this `eventId` was already recorded and nothing happened again. `ignored` — a well-formed event this system has no handler for.',
    },
  },
} as const;

export const webhookDocs: DocRegistry = {
  'POST /api/v1/webhooks/payments/{provider}': {
    summary: 'Receive a payment event',
    description: `
The endpoint a payment provider posts to. **Not for client use** — it is
documented so the delivery contract is legible when a webhook goes missing, not
so anything in your application calls it.

The raw body is verified against the provider's signing secret before it is
parsed. An unverifiable body is dropped.

⚠️ **A provider this process is not configured for is answered \`404\`, not
\`401\`.** The path names a provider; the process has exactly one. A mismatch
means the deployment's \`PAYMENT_PROVIDER\` and the URL registered in the
provider's dashboard disagree — verifying with the wrong secret would present as
a *signature* failure and send whoever debugs it looking in entirely the wrong
place.

**Delivery is at-least-once, so handling is idempotent.** Every event is
recorded by its provider event id; a redelivery is recognised and answered
\`duplicate\` without touching the ledger a second time. Providers retry on any
non-2xx, so a transient failure here is safe — and an event we have no handler
for is deliberately \`ignored\` rather than failed, so it is not retried forever.

The most common \`401\` that is nobody's bug is sandbox keys pointed at a
production dashboard or the reverse, and neither the request nor the signature
shows it.
`.trim(),
    response: INGEST_RESULT,
    errors: [400, 401, 404],
    params: {
      provider:
        'The provider posting — `razorpay`, `cashfree` or `mock`. Must match the one this process is configured with, or the call is `404`.',
    },
    responseExamples: [
      {
        summary: 'Applied',
        value: { success: true, message: 'Success', data: { outcome: 'processed' } },
      },
      {
        summary: 'Redelivery',
        description: 'Same event id as one already recorded. The ledger did not move again.',
        value: { success: true, message: 'Success', data: { outcome: 'duplicate' } },
      },
    ],
  },

  'POST /api/v1/webhooks/payments/mock/simulate': {
    summary: 'Simulate a payment event (sandbox only)',
    description: `
Drive a payment to an outcome without any money, so the billing flow can be
exercised end to end in development.

⚠️ **This moves a payment to succeeded for free, so it is guarded twice.** The
configured provider must be the mock — production cannot boot with it at all —
and this handler answers \`404\` whenever it is not. Neither guard alone would be
enough, and it is a \`404\` rather than a \`403\` because an endpoint that admits
it exists is an endpoint somebody keeps prodding.

**It takes no shortcut.** The mock builds a genuinely signed webhook and puts it
through the same ingest path as a real delivery — the same signature check, the
same ledger, the same handler. That is what makes it the tested path rather than
a bypass around the tested path.

\`STALL\` emits a pending event, which is recorded and ignored — exactly what a
real UPI collect request produces while somebody is still hunting for their
phone.
`.trim(),
    response: INGEST_RESULT,
    message: 'Sandbox event delivered',
    errors: [400, 404],
    requestExamples: [
      {
        summary: 'Settle a payment',
        value: { kind: 'payment', id: 'pay_R7x2Kd8mQ1nZ', outcome: 'SUCCESS' },
      },
      {
        summary: 'Fail a payment',
        value: { kind: 'payment', id: 'pay_R7x2Kd8mQ1nZ', outcome: 'FAILURE' },
      },
      {
        summary: 'Leave it pending',
        description: 'A collect request nobody has approved yet. Recorded, then ignored.',
        value: { kind: 'payment', id: 'pay_R7x2Kd8mQ1nZ', outcome: 'STALL' },
      },
    ],
    responseExamples: [
      {
        summary: 'Delivered',
        value: {
          success: true,
          message: 'Sandbox event delivered',
          data: { outcome: 'processed' },
        },
      },
    ],
  },
};
