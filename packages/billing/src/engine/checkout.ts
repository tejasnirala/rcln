/**
 * Taking money: starting a payment, and deciding what it bought.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *   Nothing is granted until a provider says the money arrived. Not when the
 *   customer clicks pay, not when they land back on the return URL with a
 *   success-looking query string — a browser can be told to visit any URL, and a
 *   return page that upgrades a subscription is a free upgrade button.
 *
 *   `settleIntent` is the only function in this repository that moves a
 *   subscription into ACTIVE, and it takes a `ChargeResult` that came either
 *   from a signature-verified webhook or from asking the provider directly.
 *
 * AND THE ONE PROPERTY IT MUST HAVE
 *   Idempotence. At-least-once is the only delivery guarantee any provider
 *   offers, the return page and the webhook race each other by design, and the
 *   worker reconciles anything both of them missed. All three call `settleIntent`
 *   with the same intent id, and the second and third must be no-ops.
 */

import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import {
  money,
  type ChargeResult,
  type EmbeddedCheckout,
  type HostedCharge,
  type MandateResult,
} from '@rcln/payments';
import { billingError } from '../errors.js';
import { CHECKOUT_TTL_MINUTES, canStartCheckout, graceEndFor, mandateCeiling } from '../policy.js';
import { addInterval, periodFrom } from '../periods.js';
import {
  clock,
  issueInvoice,
  loadSubscription,
  planDescription,
  presentationFor,
  priceWithTax,
  toDecimal,
  toMoney,
  type BillingRuntime,
} from './shared.js';

/** What the customer is paying for, in the invoice's own words. */
export interface PurchaseSummary {
  /** The invoice line's description — "Professional — billed monthly". */
  description: string;
  /** Whose service period this covers. ISO dates, inclusive of the start. */
  periodStart: string;
  periodEnd: string;
  /** So the customer can match this to the invoice they are sent. */
  invoiceNumber: string;
  /** What is supplied, before tax. */
  subtotalMinor: number;
  /** One per tax the jurisdiction charges — CGST and SGST are two lines. */
  taxLines: { name: string; rateBps: number; amountMinor: number }[];
  taxTotalMinor: number;
  /** Subtotal plus tax. What is actually charged. */
  totalMinor: number;
  /**
   * Why the tax is what it is, in one sentence.
   *
   * Shown whenever there is no tax to show. A zero-tax total with no explanation
   * is indistinguishable from a bug to the person reading it, and somebody will
   * eventually have to answer "why was I not charged GST?" from a screenshot.
   */
  taxNote: string;
}

/** What the caller does next: send the browser somewhere, or say it is done. */
export interface CheckoutStart {
  intentId: string;
  /** Absent when the charge settled off-session against a mandate. */
  redirectUrl?: string | undefined;
  /**
   * Mount a provider widget on our own page instead of redirecting. Exactly one
   * of this and `redirectUrl` is set on a customer-present charge.
   */
  embedded?: EmbeddedCheckout | undefined;
  /**
   * What is being bought, as the invoice states it.
   *
   * ⚠️ READ OFF THE ISSUED INVOICE, NEVER RECOMPUTED FOR DISPLAY.
   *   A checkout screen that derives its own period or its own description will
   *   eventually disagree with the invoice — a month boundary, a leap day, a
   *   plan renamed between the two reads — and the customer is then looking at
   *   one set of facts while paying for another. Everything here comes from the
   *   same transaction that wrote the invoice.
   */
  purchase?: PurchaseSummary | undefined;
  /**
   * The billing contact, echoed back for the checkout widget's prefill.
   *
   * ⚠️ THE BILLING CONTACT — WHO IS THE SIGNED-IN USER — AND NEVER A PATIENT.
   *   It is `customerFrom(actor)`, i.e. the person doing the buying, so this is
   *   their own details returned to their own browser. Nothing patient-derived
   *   reaches it; see `CustomerDetails` in @rcln/payments.
   *
   * Not decoration: Razorpay offers a REDUCED set of UPI options to a checkout
   * with no contact prefilled, which is what hides the "UPI ID" field behind the
   * QR. It also spares the customer retyping what we already know.
   */
  customer?: { name: string; email: string; phone?: string | undefined } | undefined;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amountMinor: number;
  currency: string;
  invoiceId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------

export interface StartCheckoutInput {
  planPriceId: string;
  /** Billing contact for the provider. NEVER a patient. */
  customer: { name: string; email: string; phone?: string | undefined };
}

/**
 * Begin the first payment for a subscription — from trial, or after it lapsed.
 *
 * THREE PHASES, THREE TRANSACTIONS. The provider call sits between them and is
 * not inside either; see the header of shared.ts for why.
 */
export async function startCheckout(
  ctx: TenantContext,
  runtime: BillingRuntime,
  input: StartCheckoutInput,
  run: TenantRunner
): Promise<CheckoutStart> {
  const now = clock(runtime);

  // -- phase 1: decide what is owed, and write the intent -------------------
  const prepared = await run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();

    if (!canStartCheckout(subscription.status)) {
      throw billingError.subscriptionState(
        'This subscription is already active. Change plan from the plans list instead.'
      );
    }

    const price = await tx.planPrice.findUnique({
      where: { id: input.planPriceId },
      include: { plan: true },
    });
    if (!price || !price.isActive) throw billingError.priceNotFound(subscription.currency);

    /*
     * The currency is the subscription's, not the request's.
     *
     * A subscription that has never been paid for has no history to protect, so
     * its currency may still be set here — that is the only moment it can be
     * chosen. Once money has moved it is fixed, because an invoice history that
     * changes denomination halfway through cannot be reconciled.
     */
    const hasPaid = subscription.startedAt !== null;
    if (hasPaid && price.currency !== subscription.currency) {
      throw billingError.currencyMismatch(subscription.currency, price.currency);
    }

    const period = periodFrom(now, price.billingInterval);
    const description = planDescription(price.plan.name, price.billingInterval);

    /*
     * The catalogue figure split into what is supplied and what is taxed on it.
     * `net` is the supply line; `tax.total` is what goes on top. For an
     * EXCLUSIVE price — every current row — `net` is the catalogue figure
     * unchanged.
     */
    const { net, tax } = await priceWithTax(
      tx,
      ctx,
      toMoney(price.amount, price.currency),
      price.taxBehavior,
      now
    );

    const invoice = await issueInvoice(tx, ctx, {
      subscriptionId: subscription.id,
      periodStart: period.start,
      periodEnd: period.end,
      currency: price.currency,
      dueDate: now,
      issuedAt: now,
      tax,
      lines: [
        {
          kind: 'SUBSCRIPTION',
          description,
          amount: net,
          periodStart: period.start,
          periodEnd: period.end,
        },
      ],
    });

    /*
     * ⚠️ THE GROSS, NOT THE NET. `settleIntent` refuses a payment smaller than
     *   the intent's amount, so an intent raised for the net would be settled by
     *   a payment short by exactly the tax — and the invoice would never be
     *   marked paid.
     */
    const amount = invoice.total;

    const intent = await tx.paymentIntent.create({
      data: {
        organizationId: ctx.organizationId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        provider: runtime.provider.name,
        purpose: 'SUBSCRIPTION_START',
        status: 'CREATED',
        amount: toDecimal(amount),
        currency: amount.currency,
        description,
        returnUrl: returnUrlFor(runtime),
        expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MINUTES * 60_000),
      },
      select: { id: true, expiresAt: true },
    });

    /*
     * The pending change row: WHICH plan this payment is for.
     *
     * Written now and applied by `settleIntent`, exactly as an upgrade is. It
     * has to exist, because the customer is paying for a plan they are not on
     * yet — a trial on STARTER checking out at the GROWTH price. Without it,
     * settlement would set the subscription ACTIVE on whatever plan it already
     * had and the clinic would have paid ₹4999 for ₹1499 of product, with an
     * invoice that says GROWTH and a subscription that says STARTER.
     *
     * `effectiveAt` is the period end until it is paid; the history read filters
     * on that, so an abandoned checkout does not appear as a plan change that
     * happened.
     */
    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'SUBSCRIBE',
      currency: price.currency,
      fromPlanId: subscription.planId,
      fromPlanPriceId: subscription.planPriceId,
      toPlanId: price.planId,
      toPlanPriceId: price.id,
      amountDue: toDecimal(amount),
      invoiceId: invoice.id,
      effectiveAt: period.end,
    });

    // INCOMPLETE, not ACTIVE. The plan is NOT switched here — a customer who
    // abandons checkout must be left exactly where they were.
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'INCOMPLETE', provider: runtime.provider.name },
    });

    return { intent, invoice, amount, description, period, tax };
  });

  // -- phase 2: ask the provider -------------------------------------------
  const charge = await runtime.provider.createCharge({
    reference: prepared.intent.id,
    amountMinor: prepared.amount.amountMinor,
    currency: prepared.amount.currency,
    customer: {
      reference: ctx.organizationId,
      name: input.customer.name,
      email: input.customer.email,
      phone: input.customer.phone,
    },
    description: prepared.description,
    returnUrl: returnUrlFor(runtime),
    webhookUrl: runtime.webhookUrl,
    presentation: presentationFor(runtime),
    ...(prepared.intent.expiresAt ? { expiresAt: prepared.intent.expiresAt } : {}),
  });

  // -- phase 3: record what it said -----------------------------------------
  await run(ctx, (tx) => recordChargeOnIntent(tx, prepared.intent.id, charge));

  return {
    intentId: prepared.intent.id,
    redirectUrl: charge.redirectUrl,
    embedded: charge.embedded,
    purchase: {
      description: prepared.description,
      periodStart: prepared.period.start.toISOString(),
      periodEnd: prepared.period.end.toISOString(),
      invoiceNumber: prepared.invoice.invoiceNumber,
      subtotalMinor: prepared.invoice.subtotal.amountMinor,
      taxLines: prepared.tax.lines.map((line) => ({
        name: line.name,
        rateBps: line.rateBps,
        amountMinor: line.amount.amountMinor,
      })),
      taxTotalMinor: prepared.invoice.tax.amountMinor,
      totalMinor: prepared.invoice.total.amountMinor,
      taxNote: prepared.tax.reason,
    },
    customer: input.customer,
    status: charge.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING',
    amountMinor: prepared.amount.amountMinor,
    currency: prepared.amount.currency,
    invoiceId: prepared.invoice.id,
  };
}

/**
 * Ask the customer to authorise future debits.
 *
 * Separate from paying, deliberately. Combining them into one hosted page is
 * possible with some providers and means a customer who only wanted to pay this
 * month's invoice has also signed a standing authorisation — which is the kind
 * of thing that produces chargebacks and regulator letters. Here, paying is
 * paying, and turning on automatic renewal is a second, explicit act.
 */
export async function startMandateSetup(
  ctx: TenantContext,
  runtime: BillingRuntime,
  input: { customer: StartCheckoutInput['customer'] },
  run: TenantRunner
): Promise<{ mandateId: string; redirectUrl?: string | undefined }> {
  const now = clock(runtime);
  const capabilities = runtime.provider.capabilities;

  const prepared = await run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();

    if (!capabilities.mandates || !capabilities.mandateCurrencies.includes(subscription.currency)) {
      // Asked here rather than discovered when the provider refuses, so the
      // screen can say "not available in EUR yet" instead of "payment failed".
      throw billingError.mandateUnavailable(subscription.currency);
    }

    const price = toMoney(subscription.planPrice.amount, subscription.currency);
    const ceiling = mandateCeiling(price);

    const mandate = await tx.paymentMandate.create({
      data: {
        organizationId: ctx.organizationId,
        provider: runtime.provider.name,
        status: 'PENDING',
        currency: ceiling.currency,
        maxAmount: toDecimal(ceiling),
      },
      select: { id: true },
    });

    return { mandate, ceiling, interval: subscription.planPrice.billingInterval };
  });

  const hosted = await runtime.provider.createMandate({
    reference: prepared.mandate.id,
    currency: prepared.ceiling.currency,
    customer: {
      reference: ctx.organizationId,
      name: input.customer.name,
      email: input.customer.email,
      phone: input.customer.phone,
    },
    description: 'rcln subscription',
    returnUrl: returnUrlFor(runtime, 'mandate'),
    webhookUrl: runtime.webhookUrl,
    maxAmountMinor: prepared.ceiling.amountMinor,
    interval: prepared.interval,
    // A year out. Long enough not to interrupt an annual customer, short enough
    // that an abandoned authorisation does not sit live indefinitely.
    expiresAt: addInterval(now, 'YEAR'),
  });

  await run(ctx, (tx) =>
    tx.paymentMandate.update({
      where: { id: prepared.mandate.id },
      data: {
        providerMandateId: hosted.providerMandateId,
        status: hosted.status,
      },
    })
  );

  return { mandateId: prepared.mandate.id, redirectUrl: hosted.redirectUrl };
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/**
 * Apply a provider's verdict to the domain. The only path to ACTIVE.
 *
 * IDEMPOTENT BY THE FIRST CHECK. An intent already in a terminal state is
 * returned untouched, so a webhook redelivered an hour later, the return page,
 * and the reconciliation sweep can all call this and only the first one does
 * anything.
 */
export async function settleIntent(
  ctx: TenantContext,
  runtime: BillingRuntime,
  intentId: string,
  charge: ChargeResult,
  run: TenantRunner
): Promise<{ applied: boolean; status: string }> {
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const intent = await tx.paymentIntent.findFirst({
      where: { id: intentId, organizationId: ctx.organizationId },
    });
    if (!intent) throw billingError.intentNotFound();

    if (intent.status === 'SUCCEEDED' || intent.status === 'FAILED') {
      return { applied: false, status: intent.status };
    }

    /*
     * The provider's amount is checked against ours before anything is granted.
     *
     * A mismatch means either a bug in the conversion at the boundary or an
     * attempt to settle a large invoice with a small payment. Neither should
     * quietly succeed, and the intent is failed rather than partially applied.
     */
    const expected = toMoney(intent.amount, intent.currency);
    const paid = money(charge.amountMinor, charge.currency);

    if (
      charge.status === 'SUCCEEDED' &&
      (paid.currency !== expected.currency || paid.amountMinor < expected.amountMinor)
    ) {
      await failIntent(
        tx,
        intent.id,
        'AMOUNT_MISMATCH',
        'The amount received did not match the amount due.',
        now
      );
      return { applied: false, status: 'FAILED' };
    }

    if (charge.status !== 'SUCCEEDED') {
      const terminal =
        charge.status === 'FAILED' || charge.status === 'EXPIRED' || charge.status === 'CANCELLED';
      if (!terminal) return { applied: false, status: intent.status };

      await failIntent(
        tx,
        intent.id,
        charge.failureCode ?? charge.status,
        charge.failureMessage ?? 'The payment did not complete.',
        now
      );
      await onPaymentFailed(tx, ctx, intent.subscriptionId, intent.purpose, intent.invoiceId, now);
      return { applied: true, status: 'FAILED' };
    }

    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'SUCCEEDED',
        providerChargeId: charge.providerChargeId,
        settledAt: charge.paidAt ?? now,
        ...(charge.method ? { method: charge.method } : {}),
        ...(charge.instrumentLabel ? { instrumentLabel: charge.instrumentLabel } : {}),
      },
    });

    if (intent.invoiceId) {
      await tx.subscriptionPayment.create({
        data: {
          subscriptionInvoiceId: intent.invoiceId,
          paymentIntentId: intent.id,
          amount: toDecimal(expected),
          currency: expected.currency,
          gateway: intent.provider,
          gatewayPaymentId: charge.providerChargeId,
          status: 'SUCCESS',
          paidAt: charge.paidAt ?? now,
          ...(charge.method ? { method: charge.method } : {}),
          ...(charge.instrumentLabel ? { instrumentLabel: charge.instrumentLabel } : {}),
        },
      });

      await tx.subscriptionInvoice.update({
        where: { id: intent.invoiceId },
        data: {
          status: 'PAID',
          amountPaid: toDecimal(expected),
          paidAt: charge.paidAt ?? now,
        },
      });
    }

    if (intent.subscriptionId) {
      await grantForPurpose(
        tx,
        ctx,
        runtime,
        intent.subscriptionId,
        intent.purpose,
        intent.invoiceId,
        now
      );
    }

    return { applied: true, status: 'SUCCEEDED' };
  });
}

/**
 * What a successful payment actually buys, by purpose.
 *
 * The purpose is a column rather than something inferred from which foreign keys
 * are set, precisely so this switch is exhaustive and a new purpose cannot be
 * added without deciding what it grants.
 */
async function grantForPurpose(
  tx: TxClient,
  ctx: TenantContext,
  runtime: BillingRuntime,
  subscriptionId: string,
  purpose: string,
  invoiceId: string | null,
  now: Date
): Promise<void> {
  const subscription = await tx.subscription.findFirst({
    where: { id: subscriptionId, organizationId: ctx.organizationId },
    include: { planPrice: true },
  });
  if (!subscription) return;

  switch (purpose) {
    case 'SUBSCRIPTION_START':
    case 'INVOICE_PAYMENT': {
      /*
       * The plan the customer actually paid for, from the pending change row
       * written at checkout — not whatever the subscription happens to be on.
       *
       * A clinic trialling STARTER can check out at the GROWTH price, and
       * reading the plan off the subscription here would set them ACTIVE on
       * STARTER holding a paid GROWTH invoice. That is a real bug this path had:
       * the invoice said ₹4999, the subscription said ₹1499, and nothing
       * complained.
       */
      const pending = invoiceId
        ? await tx.subscriptionChange.findFirst({
            where: {
              organizationId: ctx.organizationId,
              subscriptionId: subscription.id,
              invoiceId,
              changeType: 'SUBSCRIBE',
            },
            orderBy: { createdAt: 'desc' },
          })
        : null;

      const targetPriceId = pending?.toPlanPriceId ?? subscription.planPriceId;
      const targetPrice =
        targetPriceId === subscription.planPriceId
          ? subscription.planPrice
          : await tx.planPrice.findUnique({ where: { id: targetPriceId } });

      if (!targetPrice) break;

      const anchor = subscription.startedAt ?? now;
      const period = periodFrom(now, targetPrice.billingInterval, anchor.getUTCDate());

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          planId: targetPrice.planId,
          planPriceId: targetPrice.id,
          // Fixed here and never again: the currency of the first payment is the
          // currency of the contract. See the column comment on subscriptions.
          currency: targetPrice.currency,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          startedAt: subscription.startedAt ?? now,
          gracePeriodEnd: null,
          dunningAttempts: 0,
          endedAt: null,
        },
      });

      if (pending) {
        // It happened. Stamp it, which is also what takes it out of the
        // "pending" half of the history the clinic reads.
        await tx.subscriptionChange.update({
          where: { id: pending.id },
          data: { effectiveAt: now },
        });
      } else {
        await recordChange(tx, ctx, {
          subscriptionId: subscription.id,
          changeType: 'SUBSCRIBE',
          currency: targetPrice.currency,
          toPlanId: targetPrice.planId,
          toPlanPriceId: targetPrice.id,
          effectiveAt: now,
          invoiceId,
        });
      }
      break;
    }

    case 'RENEWAL': {
      // The new period starts where the old one ENDED, not at `now`. A renewal
      // that ran six hours late must not shorten the period the clinic paid for.
      const anchor = subscription.startedAt ?? subscription.currentPeriodStart;
      const period = periodFrom(
        subscription.currentPeriodEnd,
        subscription.planPrice.billingInterval,
        anchor.getUTCDate()
      );

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          gracePeriodEnd: null,
          dunningAttempts: 0,
          lastRenewalAt: now,
        },
      });

      await recordChange(tx, ctx, {
        subscriptionId: subscription.id,
        changeType: 'RENEW',
        currency: subscription.currency,
        toPlanId: subscription.planId,
        toPlanPriceId: subscription.planPriceId,
        effectiveAt: now,
        invoiceId,
      });
      break;
    }

    case 'UPGRADE': {
      /*
       * The target plan lives on the pending `subscription_changes` row written
       * when the quote was accepted — see startUpgrade. It is the record of what
       * the customer agreed to, at the price they were shown, and reading the
       * target from it rather than from the request is what stops a customer
       * paying for GROWTH and being switched to ENTERPRISE by a second call.
       */
      const pending = invoiceId
        ? await tx.subscriptionChange.findFirst({
            where: {
              organizationId: ctx.organizationId,
              subscriptionId: subscription.id,
              invoiceId,
              changeType: 'UPGRADE',
            },
            orderBy: { createdAt: 'desc' },
          })
        : null;

      if (!pending?.toPlanId || !pending.toPlanPriceId) break;

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: pending.toPlanId,
          planPriceId: pending.toPlanPriceId,
          status: 'ACTIVE',
          gracePeriodEnd: null,
          dunningAttempts: 0,
        },
      });

      await tx.subscriptionChange.update({
        where: { id: pending.id },
        data: { effectiveAt: now },
      });
      break;
    }

    case 'MANDATE_SETUP':
      // Nothing to grant. The mandate is activated by its own webhook.
      break;

    default:
      break;
  }

  await runtime.audit?.(tx, ctx, {
    action: 'UPDATE',
    entityType: 'subscription',
    entityId: subscriptionId,
    after: { purpose, invoiceId },
  });
}

/**
 * A failed payment, by purpose.
 *
 * A failed RENEWAL starts dunning; access continues through the grace period,
 * because the thing behind the paywall is a waiting room (see policy.ts). A
 * failed first payment simply leaves the clinic where it was — still in trial,
 * or still expired — with nothing taken and nothing granted.
 */
async function onPaymentFailed(
  tx: TxClient,
  ctx: TenantContext,
  subscriptionId: string | null,
  purpose: string,
  invoiceId: string | null,
  now: Date
): Promise<void> {
  /*
   * An invoice for something that did not happen is VOIDED, not left OPEN.
   *
   * A declined upgrade used to leave its invoice open forever: it appeared on
   * the clinic's billing page as money owed for a plan they are not on, it
   * would eventually be swept into UNCOLLECTIBLE by the dunning path, and it
   * inflated every report that sums open invoices. Nothing was ever going to
   * collect it, because the way to retry an upgrade is to start a new one.
   *
   * A RENEWAL invoice is the opposite case and is deliberately left OPEN — the
   * clinic really does owe that period, and dunning is retrying against it.
   */
  if (invoiceId && (purpose === 'UPGRADE' || purpose === 'SUBSCRIPTION_START')) {
    await tx.subscriptionInvoice.updateMany({
      where: { id: invoiceId, organizationId: ctx.organizationId, status: 'OPEN' },
      data: { status: 'VOID', voidedAt: now },
    });

    // And the change it was for did not happen either. Deleted rather than
    // marked, because `subscription_changes` is what a customer is shown as
    // their billing history, and a plan change that was declined is not history.
    await tx.subscriptionChange.deleteMany({
      where: {
        organizationId: ctx.organizationId,
        invoiceId,
        changeType: purpose === 'UPGRADE' ? 'UPGRADE' : 'SUBSCRIBE',
      },
    });
  }

  if (!subscriptionId) return;

  const subscription = await tx.subscription.findFirst({
    where: { id: subscriptionId, organizationId: ctx.organizationId },
  });
  if (!subscription) return;

  if (purpose === 'RENEWAL') {
    const attempts = subscription.dunningAttempts + 1;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'PAST_DUE',
        dunningAttempts: attempts,
        lastRenewalAt: now,
        gracePeriodEnd: subscription.gracePeriodEnd ?? graceEndFor(now),
      },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'PAYMENT_FAILED',
      currency: subscription.currency,
      effectiveAt: now,
      reason: `renewal attempt ${String(attempts)} failed`,
    });
    return;
  }

  if (subscription.status === 'INCOMPLETE') {
    // Back where they were. Trial if the trial is still running, expired if not.
    const stillInTrial = subscription.trialEndsAt !== null && now < subscription.trialEndsAt;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: stillInTrial ? 'TRIALING' : 'EXPIRED' },
    });
  }
}

async function failIntent(
  tx: TxClient,
  intentId: string,
  code: string,
  message: string,
  now: Date
): Promise<void> {
  await tx.paymentIntent.update({
    where: { id: intentId },
    data: {
      status: 'FAILED',
      failureCode: code.slice(0, 64),
      failureMessage: message.slice(0, 500),
      settledAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

/**
 * Record what the provider says about a mandate.
 *
 * Turning auto-renewal ON is a consequence of the customer authorising it, so it
 * happens here rather than on a separate button they would have to find. Turning
 * it OFF when the mandate stops being usable is the same idea in reverse: a
 * subscription set to renew automatically against a cancelled authorisation is a
 * failure scheduled for a date nobody is watching.
 */
export async function applyMandateResult(
  ctx: TenantContext,
  runtime: BillingRuntime,
  mandateId: string,
  result: MandateResult,
  run: TenantRunner
): Promise<void> {
  const now = clock(runtime);

  await run(ctx, async (tx) => {
    const mandate = await tx.paymentMandate.findFirst({
      where: { id: mandateId, organizationId: ctx.organizationId },
    });
    if (!mandate) return;

    await tx.paymentMandate.update({
      where: { id: mandate.id },
      data: {
        status: result.status,
        ...(result.providerMandateId ? { providerMandateId: result.providerMandateId } : {}),
        ...(result.method ? { method: result.method } : {}),
        ...(result.instrumentLabel ? { instrumentLabel: result.instrumentLabel } : {}),
        ...(result.status === 'ACTIVE' ? { activatedAt: result.activatedAt ?? now } : {}),
        ...(result.status === 'CANCELLED' ? { revokedAt: now } : {}),
      },
    });

    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) return;

    if (result.status === 'ACTIVE') {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { mandateId: mandate.id, autoRenew: true, provider: runtime.provider.name },
      });
    } else if (subscription.mandateId === mandate.id && result.status !== 'PENDING') {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { autoRenew: false },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Internals shared with the other engine modules
// ---------------------------------------------------------------------------

/**
 * How the engine opens a scoped transaction.
 *
 * Passed in rather than importing `withTenant` directly so a test can run the
 * whole engine against one open transaction and roll it back, and so the worker
 * and the API can differ in nothing but their runtime.
 */
export type TenantRunner = <T>(ctx: TenantContext, fn: (tx: TxClient) => Promise<T>) => Promise<T>;

/**
 * The provider has accepted the request; the customer has not paid yet.
 *
 * PENDING even when the provider already reports SUCCEEDED — which happens on an
 * off-session mandate debit that clears immediately. Granting entitlement is
 * `settleIntent`'s job and only its job, so this records the provider's id and
 * where to send the browser, and nothing else. The caller settles straight
 * afterwards with the same result.
 */
export async function recordChargeOnIntent(
  tx: TxClient,
  intentId: string,
  charge: HostedCharge
): Promise<void> {
  await tx.paymentIntent.update({
    where: { id: intentId },
    data: {
      providerChargeId: charge.providerChargeId,
      status: 'PENDING',
      ...(charge.redirectUrl ? { redirectUrl: charge.redirectUrl } : {}),
    },
  });
}

export interface ChangeRecord {
  subscriptionId: string;
  changeType:
    | 'SUBSCRIBE'
    | 'UPGRADE'
    | 'RENEW'
    | 'CANCEL_AT_PERIOD_END'
    | 'CANCEL_IMMEDIATE'
    | 'RESUME'
    | 'REACTIVATE'
    | 'TRIAL_EXPIRED'
    | 'PAYMENT_FAILED'
    | 'SUSPENDED';
  currency: string;
  fromPlanId?: string | null | undefined;
  fromPlanPriceId?: string | null | undefined;
  toPlanId?: string | null | undefined;
  toPlanPriceId?: string | null | undefined;
  prorationCredit?: Prisma.Decimal | undefined;
  prorationCharge?: Prisma.Decimal | undefined;
  amountDue?: Prisma.Decimal | undefined;
  invoiceId?: string | null | undefined;
  effectiveAt: Date;
  actorUserId?: string | null | undefined;
  reason?: string | undefined;
}

/** The commercial record. Written for every change, including automatic ones. */
export async function recordChange(
  tx: TxClient,
  ctx: TenantContext,
  record: ChangeRecord
): Promise<{ id: string }> {
  return tx.subscriptionChange.create({
    data: {
      organizationId: ctx.organizationId,
      subscriptionId: record.subscriptionId,
      changeType: record.changeType,
      currency: record.currency,
      fromPlanId: record.fromPlanId ?? null,
      fromPlanPriceId: record.fromPlanPriceId ?? null,
      toPlanId: record.toPlanId ?? null,
      toPlanPriceId: record.toPlanPriceId ?? null,
      prorationCredit: record.prorationCredit ?? new Prisma.Decimal(0),
      prorationCharge: record.prorationCharge ?? new Prisma.Decimal(0),
      amountDue: record.amountDue ?? new Prisma.Decimal(0),
      invoiceId: record.invoiceId ?? null,
      effectiveAt: record.effectiveAt,
      actorUserId: record.actorUserId ?? null,
      ...(record.reason ? { reason: record.reason.slice(0, 500) } : {}),
    },
    select: { id: true },
  });
}

/**
 * Where a customer lands after the hosted page. Always their own subdomain.
 *
 * ⚠️ THE `kind` IS LOAD-BEARING, NOT DECORATION.
 *   A charge and a mandate authorisation come back to the same page, and the id
 *   in the query string is a `payment_intents` id in one case and a
 *   `payment_mandates` id in the other. Without knowing which, the return page
 *   looked the id up as an intent, missed, and told the customer their payment
 *   could not be checked — while their mandate sat PENDING.
 */
export function returnUrlFor(
  runtime: BillingRuntime,
  kind: 'charge' | 'mandate' = 'charge'
): string {
  return `${runtime.tenantUrl.replace(/\/$/, '')}/billing/return?kind=${kind}`;
}
