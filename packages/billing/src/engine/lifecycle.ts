/**
 * Changing plan, and leaving.
 *
 * TWO DECISIONS THIS FILE ENCODES, BOTH DELIBERATE
 *
 *   1. UPGRADES ONLY (ADR-0014). A downgrade is the one plan change that can
 *      take away a branch a clinic is running out of, or a login a nurse used
 *      this morning. Doing that automatically, at a moment chosen by a form
 *      submission, is not something a healthcare platform should do — so the
 *      engine refuses and the customer talks to a human. `classifyChange`
 *      decides by comparing entitlements, not prices.
 *
 *   2. CANCELLING DEFAULTS TO THE END OF THE PERIOD. The clinic has paid for
 *      this month; taking it away the instant they click is both wrong and
 *      hostile. Immediate cancellation exists and is a separate, explicit
 *      choice — with no refund, which the screen says before it is confirmed.
 *
 * NOTHING HERE MOVES THE RENEWAL DATE. An upgrade prorates against the period
 * already running; see proration.ts for why resetting it is worse in both
 * directions.
 */

import type { TenantContext, TxClient } from '@rcln/db';
import { subtractMoney, type Money } from '@rcln/payments';
import { billingError } from '../errors.js';
import { canUpgrade } from '../policy.js';
import { periodFrom } from '../periods.js';
import type { TaxQuote } from '../tax/engine.js';
import {
  classifyChange,
  prorate,
  type ChangeDirection,
  type ProrationQuote,
} from '../proration.js';
import { resolveEntitlements } from '../entitlements.js';
import {
  clock,
  issueInvoice,
  loadSubscription,
  presentationFor,
  taxFor,
  toDecimal,
  toMoney,
  zeroMoney,
  type BillingRuntime,
} from './shared.js';
import {
  recordChange,
  recordChargeOnIntent,
  returnUrlFor,
  type CheckoutStart,
  type TenantRunner,
} from './checkout.js';

export interface UpgradeQuote {
  direction: ChangeDirection;
  fromPlan: { id: string; code: string; name: string };
  toPlan: { id: string; code: string; name: string };
  toPlanPriceId: string;
  currency: string;
  /** Full period price of the new plan, for context next to the prorated figure. */
  fullAmountMinor: number;
  proration: ProrationQuote;
  /**
   * Tax on the prorated amount due — the SAME call `applyUpgrade` makes.
   *
   * ⚠️ THE QUOTE WAS PRE-TAX AND THE CHARGE WAS GROSS, WHICH IS A PRICE THAT
   *    CHANGES BETWEEN THE SCREEN AND THE PAYMENT.
   *   The confirmation panel showed "Due today ₹4,999" and the customer was then
   *   asked for ₹5,898.82. A quote whose figure is not the figure charged is
   *   worse than no quote — this is the same `taxFor` on the same net, so the
   *   two cannot disagree.
   */
  tax: TaxQuote;
  /** When the new plan's entitlements start. Always immediately on payment. */
  effectiveAt: Date;
  /** The renewal date, which an upgrade does not move. */
  nextRenewalAt: Date;
}

/**
 * What an upgrade would cost, without doing it.
 *
 * Shown to the customer before they commit, and re-computed on apply — never
 * trusted from the client. The quote is deterministic given the same clock, so
 * the two agree unless a day boundary passed between them, which is the one
 * case where the customer pays slightly less than they were quoted.
 */
export async function quoteUpgrade(
  ctx: TenantContext,
  runtime: BillingRuntime,
  planPriceId: string,
  run: TenantRunner
): Promise<UpgradeQuote> {
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();
    if (!canUpgrade(subscription.status)) {
      throw billingError.subscriptionState(
        'This subscription is not active. Start it again from the plans list.'
      );
    }

    const target = await tx.planPrice.findUnique({
      where: { id: planPriceId },
      include: { plan: { include: { features: true } } },
    });
    if (!target || !target.isActive) throw billingError.priceNotFound(subscription.currency);

    if (target.currency !== subscription.currency) {
      throw billingError.currencyMismatch(subscription.currency, target.currency);
    }

    const direction = classifyChange(
      {
        features: resolveEntitlements(subscription.plan.features, subscription.featureOverrides),
        interval: subscription.planPrice.billingInterval,
      },
      // The target's overrides are not applied: overrides belong to the
      // subscription, not the plan, and they follow the clinic across a change.
      // Comparing the new plan WITH the old plan's overrides would call every
      // change a lateral move for a customer who has any.
      { features: resolveEntitlements(target.plan.features), interval: target.billingInterval }
    );

    if (direction !== 'UPGRADE') throw billingError.notAnUpgrade();

    const nextAmount = toMoney(target.amount, target.currency);

    /*
     * A clinic still in its trial has paid nothing, so there is nothing to
     * credit — the quote is the full price of the new plan and the period starts
     * fresh on payment. Crediting an unpaid trial against a real charge would be
     * giving away up to a month of the dearer plan.
     */
    const inTrial = subscription.status === 'TRIALING';
    const currentAmount = inTrial
      ? zeroMoney(subscription.currency)
      : toMoney(subscription.planPrice.amount, subscription.currency);

    const period = inTrial
      ? periodFrom(now, target.billingInterval)
      : { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };

    const proration = prorate({
      period,
      at: inTrial ? period.start : now,
      currentAmount,
      nextAmount,
    });

    return {
      direction,
      fromPlan: {
        id: subscription.plan.id,
        code: subscription.plan.code,
        name: subscription.plan.name,
      },
      toPlan: { id: target.plan.id, code: target.plan.code, name: target.plan.name },
      toPlanPriceId: target.id,
      currency: subscription.currency,
      fullAmountMinor: nextAmount.amountMinor,
      proration,
      // The same call `applyUpgrade` makes, on the same net. See `UpgradeQuote`.
      tax: await taxFor(tx, ctx, proration.amountDue, now),
      effectiveAt: now,
      nextRenewalAt: period.end,
    };
  });
}

export interface StartUpgradeInput {
  planPriceId: string;
  customer: { name: string; email: string; phone?: string | undefined };
  actorUserId?: string | undefined;
}

/**
 * Accept a quote and collect the difference.
 *
 * THE PENDING CHANGE ROW IS THE CONTRACT. It records the plan, the price and the
 * arithmetic the customer was shown, and `settleIntent` reads the target from it
 * rather than from any later request. That is what makes "pay for GROWTH, get
 * switched to ENTERPRISE by a second call" unrepresentable.
 *
 * Three outcomes:
 *   - nothing owed (an upgrade on the last day of a period): applied at once.
 *   - a mandate is live: debited off-session, no page, no redirect.
 *   - otherwise: a hosted page, and the change applies when the money lands.
 */
export async function startUpgrade(
  ctx: TenantContext,
  runtime: BillingRuntime,
  input: StartUpgradeInput,
  run: TenantRunner
): Promise<CheckoutStart & { direction: ChangeDirection }> {
  const now = clock(runtime);
  const quote = await quoteUpgrade(ctx, runtime, input.planPriceId, run);

  // -- nothing to collect: apply immediately -------------------------------
  if (quote.proration.isFree) {
    await run(ctx, async (tx) => {
      const subscription = await loadSubscription(tx, ctx);
      if (!subscription) throw billingError.subscriptionNotFound();

      await tx.subscription.update({
        where: { id: subscription.id },
        data: { planId: quote.toPlan.id, planPriceId: quote.toPlanPriceId },
      });

      await recordChange(tx, ctx, {
        subscriptionId: subscription.id,
        changeType: 'UPGRADE',
        currency: quote.currency,
        fromPlanId: quote.fromPlan.id,
        fromPlanPriceId: subscription.planPriceId,
        toPlanId: quote.toPlan.id,
        toPlanPriceId: quote.toPlanPriceId,
        effectiveAt: now,
        actorUserId: input.actorUserId,
      });

      await runtime.audit?.(tx, ctx, {
        action: 'UPDATE',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { planId: quote.fromPlan.id },
        after: { planId: quote.toPlan.id },
      });
    });

    return {
      direction: quote.direction,
      intentId: '',
      status: 'SUCCEEDED',
      amountMinor: 0,
      currency: quote.currency,
    };
  }

  // -- phase 1: invoice the difference and write the pending change ---------
  const prepared = await run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();

    const description = `Upgrade to ${quote.toPlan.name}`;

    /*
     * Tax on the NET amount due, after the credit — not on the gross charge.
     *
     * A prorated upgrade is one supply of `amountDue`, not a supply of `charge`
     * with a separate refund of `credit`. Taxing the charge and ignoring the
     * credit would over-collect by the tax on the credit, on every upgrade.
     */
    const tax = quote.tax;

    const invoice = await issueInvoice(tx, ctx, {
      subscriptionId: subscription.id,
      periodStart: now,
      periodEnd: quote.nextRenewalAt,
      currency: quote.currency,
      dueDate: now,
      issuedAt: now,
      tax,
      lines: [
        {
          kind: 'PRORATION_CHARGE',
          description: `${quote.toPlan.name} — ${String(quote.proration.remainingDays)} of ${String(quote.proration.periodDays)} days`,
          amount: quote.proration.charge,
          periodStart: now,
          periodEnd: quote.nextRenewalAt,
        },
        // A negative line, so the invoice total IS the amount charged and a
        // customer can check the arithmetic without being told to trust it.
        ...(quote.proration.credit.amountMinor > 0
          ? [
              {
                kind: 'PRORATION_CREDIT' as const,
                description: `Unused ${quote.fromPlan.name} — ${String(quote.proration.remainingDays)} of ${String(quote.proration.periodDays)} days`,
                amount: negative(quote.proration.credit),
                periodStart: now,
                periodEnd: quote.nextRenewalAt,
              },
            ]
          : []),
      ],
    });

    const change = await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'UPGRADE',
      currency: quote.currency,
      fromPlanId: quote.fromPlan.id,
      fromPlanPriceId: subscription.planPriceId,
      toPlanId: quote.toPlan.id,
      toPlanPriceId: quote.toPlanPriceId,
      prorationCredit: toDecimal(quote.proration.credit),
      prorationCharge: toDecimal(quote.proration.charge),
      amountDue: toDecimal(quote.proration.amountDue),
      invoiceId: invoice.id,
      // Set to now on settlement. Until then this row is a pending change and is
      // filtered out of the history the clinic reads.
      effectiveAt: quote.nextRenewalAt,
      actorUserId: input.actorUserId,
    });

    /*
     * Debit the mandate only if it can actually cover this.
     *
     * ⚠️ THE CEILING IS CHECKED HERE, NOT LEFT TO THE PROVIDER.
     *   A mandate is authorised for a multiple of what the clinic was paying at
     *   the time (policy.ts). A big enough upgrade — monthly to annual, two
     *   tiers at once — exceeds it, and asking the provider anyway produces a
     *   decline that reaches the customer as "the amount exceeds the authorised
     *   mandate ceiling": true, unactionable, and about a mechanism they never
     *   saw. Checking first turns that into a hosted page, which is what they
     *   would have got had they never set up auto-renewal at all.
     *
     *   Their existing mandate is untouched. It still covers the renewals it was
     *   taken for; it simply is not the instrument for this one payment.
     */
    const mandate = subscription.mandate;
    const mandateCovers =
      subscription.autoRenew &&
      mandate?.status === 'ACTIVE' &&
      mandate.providerMandateId !== null &&
      // Against the GROSS, because the gross is what the bank is asked for. A
      // ceiling that only covers the net would pass here and decline there.
      toMoney(mandate.maxAmount, quote.currency).amountMinor >= invoice.total.amountMinor;

    const intent = await tx.paymentIntent.create({
      data: {
        organizationId: ctx.organizationId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        provider: runtime.provider.name,
        purpose: 'UPGRADE',
        status: 'CREATED',
        // The gross. See the warning in `issueInvoice`.
        amount: toDecimal(invoice.total),
        currency: quote.currency,
        description,
        returnUrl: returnUrlFor(runtime),
        ...(mandateCovers ? { mandateId: subscription.mandateId } : {}),
      },
      select: { id: true, mandateId: true },
    });

    return {
      intent,
      invoice,
      change,
      description,
      tax,
      mandate: subscription.mandate,
    };
  });

  // -- phase 2: charge -------------------------------------------------------
  const charge = await runtime.provider.createCharge({
    reference: prepared.intent.id,
    /*
     * ⚠️ THE GROSS — `invoice.total`, NOT `proration.amountDue`.
     *
     *   This asked the provider for the NET while the intent was raised for the
     *   gross. The customer was shown ₹11,800 on the page, charged ₹10,000 by
     *   Razorpay, and `settleIntent` then compared what arrived against the
     *   intent and failed it as AMOUNT_MISMATCH — money taken, upgrade refused,
     *   and nothing anywhere naming the tax as the cause.
     *
     *   Every amount downstream of `issueInvoice` is the gross. There is exactly
     *   one net in this function and it is the invoice's supply line.
     */
    amountMinor: prepared.invoice.total.amountMinor,
    currency: quote.currency,
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
    ...(prepared.intent.mandateId && prepared.mandate?.providerMandateId
      ? { mandateId: prepared.mandate.providerMandateId }
      : {}),
  });

  await run(ctx, (tx) => recordChargeOnIntent(tx, prepared.intent.id, charge));

  return {
    direction: quote.direction,
    intentId: prepared.intent.id,
    redirectUrl: charge.redirectUrl,
    embedded: charge.embedded,
    /*
     * An upgrade's service period runs from NOW to the unchanged renewal date,
     * not from the start of the current period — that is exactly what the
     * customer is paying the prorated amount for, and it is the period written
     * onto the invoice a few lines above.
     */
    purchase: {
      description: prepared.description,
      periodStart: now.toISOString(),
      periodEnd: quote.nextRenewalAt.toISOString(),
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
    // The gross, so the pay button names what is actually collected.
    amountMinor: prepared.invoice.total.amountMinor,
    currency: quote.currency,
    invoiceId: prepared.invoice.id,
  };
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

export interface CancelInput {
  /**
   * End it now instead of at the end of the paid period.
   *
   * No refund is issued either way, and the screen says so before confirming.
   * The option exists because a clinic closing down should not have to wait
   * three weeks for its data to stop being live.
   */
  immediate?: boolean | undefined;
  reason?: string | undefined;
  actorUserId?: string | undefined;
}

export async function cancelSubscription(
  ctx: TenantContext,
  runtime: BillingRuntime,
  input: CancelInput,
  run: TenantRunner
): Promise<{ status: string; endsAt: Date }> {
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();

    if (subscription.status === 'CANCELED') throw billingError.alreadyCancelled();
    if (subscription.cancelAtPeriodEnd && !input.immediate) throw billingError.alreadyCancelled();

    const endsAt = input.immediate ? now : subscription.currentPeriodEnd;

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        cancelAtPeriodEnd: true,
        cancelAt: endsAt,
        // Auto-renewal off in both cases. Leaving a mandate armed on a
        // subscription that is ending is a charge nobody expects.
        autoRenew: false,
        ...(input.reason ? { cancelReason: input.reason.slice(0, 500) } : {}),
        ...(input.immediate ? { status: 'CANCELED' as const, canceledAt: now, endedAt: now } : {}),
      },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: input.immediate ? 'CANCEL_IMMEDIATE' : 'CANCEL_AT_PERIOD_END',
      currency: subscription.currency,
      fromPlanId: subscription.planId,
      fromPlanPriceId: subscription.planPriceId,
      effectiveAt: endsAt,
      actorUserId: input.actorUserId,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    await runtime.audit?.(tx, ctx, {
      action: 'UPDATE',
      entityType: 'subscription',
      entityId: subscription.id,
      before: { status: subscription.status, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd },
      after: {
        status: input.immediate ? 'CANCELED' : subscription.status,
        cancelAtPeriodEnd: true,
      },
    });

    return { status: input.immediate ? 'CANCELED' : subscription.status, endsAt };
  });
}

/**
 * Change your mind, before the period actually ends.
 *
 * Does NOT re-arm auto-renewal. The mandate may still be live, but a clinic that
 * asked to leave and then stayed should say so explicitly rather than have an
 * unattended debit switched back on for them.
 */
export async function resumeSubscription(
  ctx: TenantContext,
  runtime: BillingRuntime,
  input: { actorUserId?: string | undefined },
  run: TenantRunner
): Promise<{ nextRenewalAt: Date }> {
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();
    if (!subscription.cancelAtPeriodEnd || subscription.status === 'CANCELED') {
      throw billingError.nothingToResume();
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: false, cancelAt: null, cancelReason: null },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'RESUME',
      currency: subscription.currency,
      effectiveAt: now,
      actorUserId: input.actorUserId,
    });

    await runtime.audit?.(tx, ctx, {
      action: 'UPDATE',
      entityType: 'subscription',
      entityId: subscription.id,
      before: { cancelAtPeriodEnd: true },
      after: { cancelAtPeriodEnd: false },
    });

    return { nextRenewalAt: subscription.currentPeriodEnd };
  });
}

// ---------------------------------------------------------------------------
// Automatic renewal
// ---------------------------------------------------------------------------

/**
 * Turn unattended debits on or off.
 *
 * Turning them ON requires a live mandate — there is nothing to debit otherwise,
 * and a subscription flagged auto-renew with no authorisation behind it is a
 * failure scheduled for a date nobody is watching. Turning them OFF leaves the
 * mandate alone, so the customer can switch back without re-authorising.
 */
export async function setAutoRenew(
  ctx: TenantContext,
  runtime: BillingRuntime,
  enabled: boolean,
  run: TenantRunner
): Promise<{ autoRenew: boolean }> {
  return run(ctx, async (tx) => {
    const subscription = await loadSubscription(tx, ctx);
    if (!subscription) throw billingError.subscriptionNotFound();

    if (enabled && subscription.mandate?.status !== 'ACTIVE') {
      throw billingError.mandateRequired();
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { autoRenew: enabled },
    });

    await runtime.audit?.(tx, ctx, {
      action: 'UPDATE',
      entityType: 'subscription',
      entityId: subscription.id,
      before: { autoRenew: subscription.autoRenew },
      after: { autoRenew: enabled },
    });

    return { autoRenew: enabled };
  });
}

/**
 * Revoke the authorisation, at the provider and here.
 *
 * The provider is told first. If that fails we have not lied to the customer
 * about a mandate that is still live at the acquirer and could still be debited
 * — which is the failure that matters, and the one worth surfacing an error for.
 */
export async function revokeMandate(
  ctx: TenantContext,
  runtime: BillingRuntime,
  run: TenantRunner
): Promise<void> {
  const subscription = await run(ctx, (tx) => loadSubscription(tx, ctx));
  const mandate = subscription?.mandate;
  if (!subscription || !mandate) return;

  if (mandate.providerMandateId) {
    await runtime.provider.cancelMandate(mandate.providerMandateId);
  }

  const now = clock(runtime);
  await run(ctx, async (tx) => {
    await tx.paymentMandate.update({
      where: { id: mandate.id },
      data: { status: 'CANCELLED', revokedAt: now },
    });
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { autoRenew: false },
    });
  });
}

/**
 * Move a subscription that has never been charged onto another currency.
 *
 * WHY THIS IS NOT A HOLE IN "CURRENCY IS FIXED AT SUBSCRIBE TIME"
 *   That rule protects a CUSTOMER — someone who agreed a price and must never be
 *   re-quoted in another currency because the catalogue or their address moved.
 *   `started_at` is precisely when that agreement happened: null means no money
 *   has changed hands and the only thing the currency has ever done is decide
 *   what the pricing screen showed. A clinic still in trial that corrects its
 *   country is not being re-priced; it is being quoted for the first time.
 *
 *   So: started subscriptions are never touched, and neither is one whose plan
 *   publishes no active price in the new currency — a subscription pointing at a
 *   price that does not exist is worse than one quoted in the wrong currency.
 *
 * No `subscription_changes` row. That table is the money ledger — what was
 * charged, credited and when — and nothing here charges anything. The edit that
 * causes it is audited on the organization, which is where a reader would look.
 */
export async function realignUnbilledCurrency(
  tx: TxClient,
  ctx: TenantContext,
  currency: string
): Promise<{ subscriptionId: string; from: string; to: string } | null> {
  const subscription = await tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      currency: true,
      startedAt: true,
      planId: true,
      planPrice: { select: { billingInterval: true } },
    },
  });

  if (!subscription || subscription.startedAt) return null;
  if (subscription.currency === currency) return null;

  const price = await tx.planPrice.findFirst({
    where: {
      planId: subscription.planId,
      currency,
      billingInterval: subscription.planPrice.billingInterval,
      isActive: true,
    },
    select: { id: true },
  });

  if (!price) return null;

  await tx.subscription.update({
    where: { id: subscription.id },
    // Both, together. The row's own `currency` is what every read quotes from;
    // leaving the price behind is how you get a EUR subscription billed off a
    // rupee amount.
    data: { planPriceId: price.id, currency },
  });

  return { subscriptionId: subscription.id, from: subscription.currency, to: currency };
}

/** A credit, as a negative invoice line. */
function negative(amount: Money): Money {
  return subtractMoney({ amountMinor: 0, currency: amount.currency }, amount);
}
