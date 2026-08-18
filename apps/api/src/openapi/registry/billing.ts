/**
 * Billing — what the CLINIC pays rcln, and how.
 *
 * **Not what the clinic bills a patient.** That is Invoicing & tax, a different
 * router with different permissions and a statutory document at the end of it.
 *
 * ⚠️ TWO PERMISSIONS, AND THE SPLIT IS ABOUT MONEY. `organization.billing.read`
 *   sees what the clinic is on and what it has been invoiced;
 *   `organization.billing.manage` changes it. A practice manager who needs last
 *   month's invoice should not thereby be able to upgrade the plan or cancel the
 *   subscription — those are the owner's decisions, and they cost money.
 *
 * ⚠️ THE CLIENT NAMES A PRICE, NEVER AN AMOUNT. Every request cites a
 *   `planPriceId`; what it costs, including proration, is computed server-side
 *   every time — **including on apply, which never trusts the quote it showed**.
 *
 * ⚠️ THREE FAILURE MODES, AND THE THIRD IS NOT A DECLINE. A broken rule is a
 *   `409`. An acquirer saying no is a `402`, and retrying will not help. But
 *   **`503` means we do not know** — and the customer must NOT be told the
 *   payment failed, because it may not have.
 */
import type { DocRegistry } from '../types.js';
import {
  MANDATE_ID,
  ORG_ID,
  PAYMENT_INTENT_ID,
  PLAN_PRICE_ID,
  SUBSCRIPTION_INVOICE_ID,
} from './fixtures.js';

export const billingDocs: DocRegistry = {
  'GET /api/v1/billing': {
    summary: 'Get the billing overview',
    description: `
What the clinic is on, what it has been invoiced, and where its subscription
stands.

One call rather than several, because a billing screen needs the plan, the
period, the next renewal, the mandate state and the invoice history together —
and a screen assembled from five requests shows five different moments.

\`currency\` presents plan prices in a currency other than the organization's,
for a clinic comparing options.
`.trim(),
    params: { currency: "Present prices in this currency instead of the organization's." },
    responseExamples: [
      {
        summary: 'An active subscription',
        value: {
          success: true,
          message: 'Success',
          data: {
            organizationId: ORG_ID,
            subscription: {
              status: 'ACTIVE',
              planCode: 'GROWTH',
              planName: 'Growth',
              planPriceId: PLAN_PRICE_ID,
              currency: 'INR',
              amountMinor: 499000,
              interval: 'MONTHLY',
              currentPeriodStart: '2026-03-01T00:00:00.000Z',
              currentPeriodEnd: '2026-04-01T00:00:00.000Z',
              autoRenew: true,
              cancelAtPeriodEnd: false,
            },
            mandate: { id: MANDATE_ID, status: 'ACTIVE', provider: 'razorpay' },
            invoices: [
              {
                id: SUBSCRIPTION_INVOICE_ID,
                number: 'RCLN-2026-03-00412',
                status: 'PAID',
                amountMinor: 499000,
                currency: 'INR',
                issuedOn: '2026-03-01',
                paidAt: '2026-03-01T04:12:00.000Z',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/billing/payments/{intentId}': {
    summary: 'Get a payment',
    description:
      'The state of one payment attempt. `PENDING` is a real and common state — a UPI collect request sits there while somebody looks for their phone.',
    params: { intentId: 'The payment intent, as returned by checkout.' },
    responseExamples: [
      {
        summary: 'Settled',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: PAYMENT_INTENT_ID,
            status: 'SUCCEEDED',
            amountMinor: 499000,
            currency: 'INR',
            provider: 'razorpay',
            createdAt: '2026-03-01T04:10:00.000Z',
            settledAt: '2026-03-01T04:12:00.000Z',
          },
        },
      },
      {
        summary: 'Still pending',
        description: 'Not a failure — a collect request nobody has approved yet.',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: PAYMENT_INTENT_ID,
            status: 'PENDING',
            amountMinor: 499000,
            currency: 'INR',
            provider: 'razorpay',
            createdAt: '2026-03-01T04:10:00.000Z',
            settledAt: null,
          },
        },
      },
    ],
  },

  'POST /api/v1/billing/payments/{intentId}/reconcile': {
    summary: 'Reconcile a payment with the provider',
    description: `
Ask the provider directly what happened to a payment, and apply the answer.

**The repair path when a webhook did not arrive.** Delivery is at-least-once but
not at-all-costs: a webhook endpoint that was down, misconfigured, or pointed at
the wrong environment leaves a payment stuck \`PENDING\` with nothing reporting a
fault.

Idempotent — reconciling a payment already settled changes nothing.
`.trim(),
    errors: [402, 409, 503],
    params: { intentId: 'The payment intent to reconcile.' },
  },

  'GET /api/v1/billing/mandate/{mandateId}': {
    summary: 'Get a mandate',
    description:
      'The state of the standing authority to collect renewals. `PENDING` means the customer has not finished authorising it, and automatic renewal will not work until they do.',
    params: { mandateId: 'The mandate.' },
    responseExamples: [
      {
        summary: 'Authorised',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: MANDATE_ID,
            status: 'ACTIVE',
            provider: 'razorpay',
            currency: 'INR',
            maxAmountMinor: 1000000,
            createdAt: '2026-01-04T05:30:00.000Z',
          },
        },
      },
    ],
  },

  'POST /api/v1/billing/mandate/{mandateId}/reconcile': {
    summary: 'Reconcile a mandate with the provider',
    description: `
Ask the provider whether the mandate was actually authorised, and apply the
answer.

⚠️ **NOT AN OPTIMISATION — ON CASHFREE IT IS THE ONLY PATH.** Their Payment
Gateway webhook catalogue contains no subscription events at all; those belong to
a separate product configured separately. A merchant with only PG webhooks set up
would otherwise have a mandate stuck \`PENDING\` for ever and automatic renewal
permanently unavailable, **with nothing reporting a fault**.

Idempotent.
`.trim(),
    errors: [409, 503],
    params: { mandateId: 'The mandate to reconcile.' },
  },

  'POST /api/v1/billing/checkout': {
    summary: 'Start checkout',
    description: `
Begin paying for a plan. Returns a payment intent and whatever the provider needs
to take the customer through authorisation.

**The client names a \`planPriceId\`, never an amount.** What it costs is
computed server-side, so a tampered or stale price cannot become a discount.

A \`402\` means the acquirer declined and retrying will not help. A \`503\` means
we do not know whether it went through — **do not tell the customer it failed.**
`.trim(),
    status: 201,
    errors: [402, 409, 503],
    requestExamples: [{ summary: 'Subscribe to a plan', value: { planPriceId: PLAN_PRICE_ID } }],
  },

  'POST /api/v1/billing/subscription/upgrade/preview': {
    summary: 'Preview an upgrade',
    description: `
What changing plan would cost, including proration for the part-period.

⚠️ **A \`POST\` because it names a resource in the body and is not cacheable —
nothing is written.**

⚠️ **The quote is not binding, and apply does not trust it.** The same
calculation runs again on \`POST /subscription/upgrade\`, because a preview taken
this morning and applied this evening spans a different part-period.
`.trim(),
    requestExamples: [
      { summary: 'Preview moving to Growth', value: { planPriceId: PLAN_PRICE_ID } },
    ],
    responseExamples: [
      {
        summary: 'A prorated upgrade',
        value: {
          success: true,
          message: 'Success',
          data: {
            planPriceId: PLAN_PRICE_ID,
            currency: 'INR',
            newAmountMinor: 499000,
            prorationCreditMinor: 82000,
            amountDueNowMinor: 417000,
            effectiveFrom: '2026-03-17T00:00:00.000Z',
          },
        },
      },
    ],
  },

  'POST /api/v1/billing/subscription/upgrade': {
    summary: 'Upgrade the subscription',
    description:
      'Move to a different plan. **Priced server-side again, from scratch** — never from the preview the client was shown. Takes effect immediately; the proration is charged against the mandate or collected now.',
    errors: [402, 409, 503],
    requestExamples: [{ summary: 'Move to Growth', value: { planPriceId: PLAN_PRICE_ID } }],
  },

  'POST /api/v1/billing/subscription/cancel': {
    summary: 'Cancel the subscription',
    description: `
Stop the subscription.

**\`immediate: false\` (the default) cancels at the end of the paid period** —
the clinic keeps what it has already paid for. \`immediate: true\` ends it now,
which is the destructive option and should be an explicit choice rather than a
default.

Behind \`organization.billing.manage\`, deliberately separate from the code that
reads an invoice.

Resume with \`POST /subscription/resume\` while the period is still running.
`.trim(),
    errors: [409],
    requestExamples: [
      {
        summary: 'At the end of the period',
        value: { immediate: false, reason: 'Moving to an in-house system' },
      },
      { summary: 'Immediately', value: { immediate: true } },
    ],
  },

  'POST /api/v1/billing/subscription/resume': {
    summary: 'Resume a cancelled subscription',
    description:
      'Undo a cancellation scheduled for the end of the period. **Only while that period is still running** — once it has lapsed, coming back is a fresh checkout.',
    errors: [409],
  },

  'PUT /api/v1/billing/subscription/auto-renew': {
    summary: 'Turn automatic renewal on or off',
    description: `
Whether the subscription renews itself at the end of the period.

**Distinct from cancelling.** Turning auto-renew off leaves the subscription
active and simply stops it renewing; cancelling schedules its end. The difference
matters to a clinic that wants to decide later.

Enabling it needs an \`ACTIVE\` mandate — without one there is nothing to collect
against, so this is \`409\`.
`.trim(),
    errors: [409],
    requestExamples: [
      { summary: 'Turn it off', value: { enabled: false } },
      { summary: 'Turn it back on', value: { enabled: true } },
    ],
  },

  'POST /api/v1/billing/mandate': {
    summary: 'Create a mandate',
    description:
      'Set up the standing authority to collect renewals. Returns what the provider needs to take the customer through authorisation — the mandate is `PENDING` until they finish, and `POST /mandate/{mandateId}/reconcile` is how that is confirmed when no webhook arrives.',
    status: 201,
    errors: [402, 409, 503],
  },

  'DELETE /api/v1/billing/mandate': {
    summary: 'Revoke the mandate',
    description:
      'Withdraw the standing authority. **Automatic renewal stops with it** — the subscription stays active to the end of the paid period and then lapses unless it is paid manually or a new mandate is created.',
    errors: [409],
  },
};
