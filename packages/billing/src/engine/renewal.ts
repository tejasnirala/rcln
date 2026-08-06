/**
 * The billing clock: renewals, dunning, trial expiry, suspension.
 *
 * THIS IS WHY THE PROVIDER SEAM IS WORTH ITS WEIGHT
 *   Everything in this file is a decision about a clinic's subscription, made on
 *   a schedule we chose, using rules in `policy.ts`. None of it asks the provider
 *   what should happen — it tells the provider to take an amount we computed, at
 *   a moment we picked. Swapping acquirer changes one adapter and moves not one
 *   renewal date.
 *
 * IT RUNS IN THE WORKER, NOT THE API
 *   A renewal is a network call to a gateway plus several writes, for every
 *   clinic whose period ended in the same hour. On an API thread that is a
 *   request queue backing up behind billing; in the worker it is a job with
 *   retries and a dead-letter.
 *
 * EVERY OPERATION IS SAFE TO RUN TWICE
 *   The sweep can fire twice, a job can be retried after a partial failure, and
 *   an operator can run one by hand while the schedule is also running it. So
 *   each function re-reads the state it is about to change inside the same
 *   transaction and does nothing when the change has already been made. There is
 *   no "already renewed" error, because that is not an error — it is the answer.
 */

import type { TxClient } from '@rcln/db';
import { PaymentUnavailableError, type ChargeResult } from '@rcln/payments';
import { addDays, periodFrom } from '../periods.js';
import {
  DUNNING_SCHEDULE_DAYS,
  MAX_DUNNING_ATTEMPTS,
  RENEWAL_LEAD_DAYS,
  graceEndFor,
} from '../policy.js';
import {
  clock,
  issueInvoice,
  planDescription,
  systemContext,
  toDecimal,
  priceWithTax,
  toMoney,
  type BillingRuntime,
} from './shared.js';
import { recordChange, recordChargeOnIntent, settleIntent, type TenantRunner } from './checkout.js';

/** One row from the due-sweep. Deliberately thin: the job re-reads the rest. */
export interface DueSubscription {
  subscriptionId: string;
  organizationId: string;
  reason: 'RENEWAL' | 'DUNNING' | 'TRIAL_END' | 'SUSPEND' | 'CANCEL';
}

/**
 * Everything the billing clock needs to act on right now.
 *
 * ⚠️ THE ONLY CROSS-TENANT READ IN THE BILLING SYSTEM, AND IT IS A FUNCTION CALL
 *    RATHER THAN A QUERY — FOR A REASON THAT COST A DEBUGGING SESSION.
 *
 *   A scheduler has to look at every clinic; that is what makes it a scheduler.
 *   But `subscriptions` is RLS-enforced, and a read with no tenant context
 *   matches NOTHING. Written as a plain `SELECT` over the table, this returned
 *   an empty list forever: no error, no log, and renewals simply never happened.
 *   Exactly the silent failure RLS is known for, in the one place with nobody
 *   watching a screen.
 *
 *   So the question is asked of `billing_due_subscriptions()`, a SECURITY
 *   DEFINER function owned by `rcln_owner`. It is not a door — it is one
 *   question with one answer: three columns, for only the rows that are due,
 *   with no argument that widens it. `rcln_app` keeps NOBYPASSRLS and every
 *   other table stays exactly as protected as it was. See the migration for the
 *   alternatives that were rejected and why.
 *
 *   The rows grant nothing by themselves. The job that follows re-enters through
 *   `withTenant` for one organization, and does the real work under the ordinary
 *   policy.
 */
export async function findDue(tx: TxClient, at: Date, limit = 200): Promise<DueSubscription[]> {
  // The lead time is applied here rather than inside the function, so changing
  // "how early may we renew" stays a code change and not a migration.
  const cutoff = addDays(at, RENEWAL_LEAD_DAYS);

  const rows = await tx.$queryRaw<
    { id: string; organization_id: string; reason: DueSubscription['reason'] }[]
  >`SELECT id, organization_id, reason
      FROM billing_due_subscriptions(${cutoff}::timestamptz, ${limit}::int)`;

  return rows.map((row) => ({
    subscriptionId: row.id,
    organizationId: row.organization_id,
    reason: row.reason,
  }));
}

/**
 * Charge a clinic for its next period.
 *
 * ⚠️ THE ORDER OF THESE STEPS IS THE WHOLE CORRECTNESS ARGUMENT.
 *   The invoice and the intent are written BEFORE the provider is called, so the
 *   intent id is the idempotency key and a call that times out can be retried
 *   against the same order rather than creating a second one. A crash between
 *   the write and the call leaves an unpaid invoice and a CREATED intent, which
 *   grants nothing and is exactly what reconciliation is for.
 *
 * NO MANDATE MEANS NO SILENT FAILURE. A subscription with auto-renewal off, or
 * with a mandate that is no longer active, gets an invoice it can pay by hand
 * and enters the grace period. It does not get suspended for not having done
 * something nobody asked it to do.
 */
export async function renewSubscription(
  organizationId: string,
  subscriptionId: string,
  runtime: BillingRuntime,
  run: TenantRunner
): Promise<{ outcome: 'RENEWED' | 'INVOICED' | 'CHARGING' | 'SKIPPED'; intentId?: string }> {
  const ctx = systemContext(organizationId);
  const now = clock(runtime);

  const prepared = await run(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: subscriptionId, organizationId },
      include: { plan: true, planPrice: true, mandate: true },
    });

    // Re-read inside the transaction: the sweep's snapshot may be minutes old,
    // and a customer who paid by hand in between must not be charged again.
    if (!subscription) return null;
    if (subscription.status !== 'ACTIVE' && subscription.status !== 'PAST_DUE') return null;
    if (subscription.currentPeriodEnd > addDays(now, RENEWAL_LEAD_DAYS)) return null;
    if (subscription.cancelAtPeriodEnd) return null;

    const period = periodFrom(
      subscription.currentPeriodEnd,
      subscription.planPrice.billingInterval,
      (subscription.startedAt ?? subscription.currentPeriodStart).getUTCDate()
    );
    const description = planDescription(
      subscription.plan.name,
      subscription.planPrice.billingInterval
    );

    /*
     * Tax is recomputed for every renewal, never copied from the last invoice.
     *
     * A clinic can move state, register for GST, or have its number validated
     * between one period and the next, and the rate itself can change by statute.
     * Each renewal is a fresh supply and is taxed as one.
     */
    const { net, tax } = await priceWithTax(
      tx,
      ctx,
      toMoney(subscription.planPrice.amount, subscription.currency),
      subscription.planPrice.taxBehavior,
      now
    );

    const invoice = await issueInvoice(tx, ctx, {
      subscriptionId: subscription.id,
      periodStart: period.start,
      periodEnd: period.end,
      currency: net.currency,
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
     * ⚠️ THE GROSS — and on this path it is the amount DEBITED FROM A MANDATE.
     *   The mandate ceiling is checked against it below, which is correct: the
     *   bank is asked for the gross, so a ceiling that only covers the net would
     *   decline at 03:00 with nobody watching.
     */
    const amount = invoice.total;

    const usable =
      subscription.autoRenew &&
      subscription.mandate?.status === 'ACTIVE' &&
      subscription.mandate.providerMandateId !== null &&
      // Checked here as well as at the provider, so a debit that is certain to
      // be declined becomes an invoice the customer can pay instead of a
      // dunning cycle they cannot escape.
      toMoney(subscription.mandate.maxAmount, subscription.currency).amountMinor >=
        amount.amountMinor;

    if (!usable) {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'PAST_DUE',
          lastRenewalAt: now,
          gracePeriodEnd: subscription.gracePeriodEnd ?? graceEndFor(now),
        },
      });
      return { kind: 'invoiced' as const, invoiceId: invoice.id };
    }

    const intent = await tx.paymentIntent.create({
      data: {
        organizationId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        mandateId: subscription.mandateId,
        provider: runtime.provider.name,
        purpose: 'RENEWAL',
        status: 'CREATED',
        amount: toDecimal(amount),
        currency: amount.currency,
        description,
      },
      select: { id: true },
    });

    return {
      kind: 'charging' as const,
      intentId: intent.id,
      invoiceId: invoice.id,
      amount,
      description,
      providerMandateId: subscription.mandate?.providerMandateId ?? null,
      billingEmail: subscription.organizationId,
    };
  });

  if (!prepared) return { outcome: 'SKIPPED' };
  if (prepared.kind === 'invoiced') return { outcome: 'INVOICED' };

  let charge: ChargeResult;
  try {
    charge = await runtime.provider.createCharge({
      reference: prepared.intentId,
      amountMinor: prepared.amount.amountMinor,
      currency: prepared.amount.currency,
      customer: {
        reference: organizationId,
        // Off-session: the provider already holds the customer record behind the
        // mandate. Nothing identifying is re-sent, and nothing patient-derived
        // has ever been sent.
        name: 'rcln subscription',
        email: 'billing@rcln.invalid',
      },
      description: prepared.description,
      returnUrl: `${runtime.tenantUrl.replace(/\/$/, '')}/billing/return`,
      webhookUrl: runtime.webhookUrl,
      ...(prepared.providerMandateId ? { mandateId: prepared.providerMandateId } : {}),
    });
  } catch (error) {
    /*
     * An outage is NOT a decline. We do not know whether the money moved, so the
     * intent is left PENDING for reconciliation and the job is rethrown for
     * BullMQ to retry with the same reference — which the provider deduplicates.
     * Marking this as a failed payment would start dunning against a customer
     * who may well have paid.
     */
    if (error instanceof PaymentUnavailableError) {
      await run(ctx, (tx) =>
        tx.paymentIntent.update({
          where: { id: prepared.intentId },
          data: { status: 'PENDING' },
        })
      );
      throw error;
    }

    // A genuine decline. Settle it as failed, which starts the grace period.
    await settleIntent(
      ctx,
      runtime,
      prepared.intentId,
      {
        provider: runtime.provider.name,
        reference: prepared.intentId,
        providerChargeId: prepared.intentId,
        status: 'FAILED',
        amountMinor: prepared.amount.amountMinor,
        currency: prepared.amount.currency,
        failureCode: 'DECLINED',
        failureMessage: error instanceof Error ? error.message : 'The payment was declined.',
      },
      run
    );
    return { outcome: 'INVOICED', intentId: prepared.intentId };
  }

  await run(ctx, (tx) =>
    recordChargeOnIntent(tx, prepared.intentId, { ...charge, redirectUrl: undefined })
  );

  const settled = await settleIntent(ctx, runtime, prepared.intentId, charge, run);

  return {
    outcome: settled.status === 'SUCCEEDED' ? 'RENEWED' : 'CHARGING',
    intentId: prepared.intentId,
  };
}

/**
 * A trial that ran out with nothing behind it.
 *
 * EXPIRED, not CANCELED: the clinic did not leave, it just never started paying,
 * and the two read differently to a salesperson looking at the console. Access
 * stops (EXPIRED is not an entitled status) but nothing is deleted, and paying
 * from the plans screen brings it straight back.
 */
export async function expireTrial(
  organizationId: string,
  subscriptionId: string,
  runtime: BillingRuntime,
  run: TenantRunner
): Promise<boolean> {
  const ctx = systemContext(organizationId);
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: subscriptionId, organizationId, status: 'TRIALING' },
    });
    if (!subscription?.trialEndsAt || subscription.trialEndsAt > now) return false;

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED', endedAt: now },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'TRIAL_EXPIRED',
      currency: subscription.currency,
      fromPlanId: subscription.planId,
      fromPlanPriceId: subscription.planPriceId,
      effectiveAt: now,
    });

    return true;
  });
}

/**
 * The grace period ran out.
 *
 * Fourteen days after the first failed renewal, with the state visible on every
 * screen throughout and up to four retries made (see policy.ts). Suspension
 * stops access; it does not delete anything, and paying restores it.
 */
export async function suspendOverdue(
  organizationId: string,
  subscriptionId: string,
  runtime: BillingRuntime,
  run: TenantRunner
): Promise<boolean> {
  const ctx = systemContext(organizationId);
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: subscriptionId, organizationId, status: 'PAST_DUE' },
    });
    if (!subscription?.gracePeriodEnd || subscription.gracePeriodEnd > now) return false;

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED', endedAt: now, autoRenew: false },
    });

    // Every unpaid invoice is written off rather than left OPEN forever. An open
    // invoice on a suspended account is a debt nobody is collecting and a number
    // that quietly distorts every revenue report that sums OPEN invoices.
    await tx.subscriptionInvoice.updateMany({
      where: { organizationId, subscriptionId: subscription.id, status: 'OPEN' },
      data: { status: 'UNCOLLECTIBLE' },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'SUSPENDED',
      currency: subscription.currency,
      effectiveAt: now,
      reason: `grace period ended after ${String(subscription.dunningAttempts)} attempts`,
    });

    return true;
  });
}

/**
 * A scheduled cancellation whose date has arrived.
 *
 * Separate from suspension because the clinic asked for this one. Its invoices
 * are not written off — they were paid, which is why the period ran to term.
 */
export async function finaliseCancellation(
  organizationId: string,
  subscriptionId: string,
  runtime: BillingRuntime,
  run: TenantRunner
): Promise<boolean> {
  const ctx = systemContext(organizationId);
  const now = clock(runtime);

  return run(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: subscriptionId, organizationId, cancelAtPeriodEnd: true },
    });
    if (!subscription || subscription.status === 'CANCELED') return false;
    if (subscription.currentPeriodEnd > now) return false;

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED', canceledAt: now, endedAt: now, autoRenew: false },
    });

    await recordChange(tx, ctx, {
      subscriptionId: subscription.id,
      changeType: 'CANCEL_IMMEDIATE',
      currency: subscription.currency,
      effectiveAt: now,
      reason: 'scheduled cancellation reached its date',
    });

    return true;
  });
}

/**
 * Is another dunning attempt due, and is there any road left?
 *
 * Returns null when the schedule is exhausted, which is the signal to suspend
 * rather than to keep retrying. A queue that retries forever never tells anyone
 * the customer has gone.
 */
export function shouldRetryNow(
  subscription: { dunningAttempts: number; lastRenewalAt: Date | null },
  at: Date
): boolean {
  if (subscription.dunningAttempts >= MAX_DUNNING_ATTEMPTS) return false;
  if (!subscription.lastRenewalAt) return true;

  // Spacing is measured from the LAST attempt rather than from the first
  // failure, so a retry that itself failed does not immediately trigger the next
  // one on the following sweep.
  const spacing = DUNNING_SCHEDULE_DAYS[subscription.dunningAttempts] ?? 1;
  const previous = DUNNING_SCHEDULE_DAYS[subscription.dunningAttempts - 1] ?? 0;
  return at >= addDays(subscription.lastRenewalAt, Math.max(1, spacing - previous));
}
