/**
 * The billing clock, running.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 *   It is scheduling and plumbing: a repeatable sweep that asks which
 *   subscriptions are due, a fan-out onto per-subscription jobs, and the error
 *   handling that decides what BullMQ should retry. Every actual decision —
 *   what to charge, how long a grace period lasts, when to stop trying — is in
 *   `@rcln/billing`, which the API uses too. Two copies of a dunning schedule is
 *   two opinions about when a clinic gets suspended.
 *
 * WHY A SWEEP AND NOT A TIMER PER SUBSCRIPTION
 *   A delayed job per renewal means tens of thousands of scheduled jobs that
 *   have to be cancelled and rescheduled every time a customer upgrades,
 *   cancels, or pays late. The state that decides when to bill already lives in
 *   `subscriptions.current_period_end`; the sweep reads it, so there is one
 *   source of truth and nothing to keep in step.
 *
 * SAFE TO RUN TWICE, ALWAYS
 *   The sweep can overlap itself, a job can be retried after a partial failure,
 *   and an operator can trigger one by hand while the schedule is also running.
 *   Every engine operation re-reads the state it is about to change inside its
 *   own transaction and does nothing when the change has already been made, and
 *   the job ids below are deterministic so BullMQ drops an obvious duplicate
 *   before it ever runs.
 */

import type { Queue } from 'bullmq';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { withTenant } from '@rcln/db';
import {
  expireTrial,
  finaliseCancellation,
  findDue,
  renewSubscription,
  shouldRetryNow,
  suspendOverdue,
  systemContext,
  type BillingRuntime,
  type DueSubscription,
} from '@rcln/billing';
import { PaymentUnavailableError } from '@rcln/payments';
import type { Logger } from 'pino';
import { QUEUE, jobId, type BillingJob } from '../queues.js';

/** How the engine opens a scoped transaction here — the ordinary `withTenant`. */
const run: Parameters<typeof renewSubscription>[3] = (ctx, fn) => withTenant(ctx, fn);

export interface BillingProcessorDeps {
  runtimeFor: (organizationId: string) => Promise<BillingRuntime>;
  queues: Record<string, Queue>;
  logger: Logger;
}

/**
 * Ask which subscriptions need attention, and enqueue one job each.
 *
 * ⚠️ THE ONE UNSCOPED READ, AND IT IS AS NARROW AS THE QUESTION ALLOWS.
 *   A scheduler must look at every clinic; that is what makes it a scheduler.
 *   `findDue` selects three columns — an id, its organization, and why it is due
 *   — and nothing else. The job that follows re-enters `withTenant` for that one
 *   organization and does the real work under RLS. Widening that select would
 *   turn a scheduler into a cross-tenant data path, which is why it lives in
 *   `@rcln/billing` with a comment saying so rather than being written inline
 *   here where it would be easy to add "just one more column".
 *
 * The fan-out is deliberate. One job per subscription means one clinic's failed
 * gateway call retries on its own without holding up everyone else's renewal,
 * and a dead-letter that names exactly which customer needs a human.
 */
export async function sweepDueSubscriptions(deps: BillingProcessorDeps): Promise<number> {
  const at = new Date();
  // No transaction: it is one read of three columns, and wrapping it would hold
  // a connection open across the enqueue loop below for no benefit.
  const due = await findDue(unsafeDbClient(), at);

  const billing = deps.queues[QUEUE.BILLING];
  if (!billing) {
    deps.logger.error('billing queue is not registered; nothing was scheduled');
    return 0;
  }

  for (const item of due) {
    const job: BillingJob = {
      organizationId: item.organizationId,
      subscriptionId: item.subscriptionId,
      action: actionFor(item.reason),
    };

    /*
     * Deterministic, and bucketed by the DAY rather than by the instant.
     *
     * The sweep runs hourly. Without the bucket, twenty-four jobs a day would be
     * enqueued for the same overdue subscription; with it, BullMQ deduplicates
     * all but the first. The day is the right granularity because every action
     * below is idempotent within a day and none of them should be attempted
     * more often than that.
     */
    await billing.add(job.action, job, {
      jobId: jobId.billingAction(job.action, job.subscriptionId, at.toISOString().slice(0, 10)),
    });
  }

  if (due.length > 0) deps.logger.info({ count: due.length }, 'billing sweep scheduled work');
  return due.length;
}

function actionFor(reason: DueSubscription['reason']): BillingJob['action'] {
  switch (reason) {
    case 'RENEWAL':
      return 'RENEW';
    case 'DUNNING':
      return 'DUNNING_RETRY';
    case 'SUSPEND':
      return 'SUSPEND';
    case 'TRIAL_END':
      return 'EXPIRE_TRIAL';
    case 'CANCEL':
      return 'FINALISE_CANCELLATION';
  }
}

/**
 * Do one clinic's billing.
 *
 * WHAT RETHROWS AND WHAT DOES NOT, AND WHY IT MATTERS
 *   `PaymentUnavailableError` means we asked the gateway and got no verdict —
 *   NOT that the payment failed. The money may have moved. Rethrowing puts the
 *   job back on BullMQ's exponential backoff, which retries with the same intent
 *   id, which the provider deduplicates against the order it may already have
 *   created. Swallowing it would mark a customer past due who has paid; treating
 *   it as a decline would start dunning against them.
 *
 *   A decline is handled inside the engine and is not an exception here — it is
 *   an outcome, and it starts the grace period.
 */
export async function processBillingJob(
  job: BillingJob,
  deps: BillingProcessorDeps
): Promise<void> {
  const runtime = await deps.runtimeFor(job.organizationId);
  const log = deps.logger.child({
    organizationId: job.organizationId,
    subscriptionId: job.subscriptionId,
    action: job.action,
  });

  try {
    switch (job.action) {
      case 'RENEW': {
        const result = await renewSubscription(
          job.organizationId,
          job.subscriptionId,
          runtime,
          run
        );
        log.info({ outcome: result.outcome }, 'renewal processed');
        return;
      }

      case 'DUNNING_RETRY': {
        // The schedule is consulted here rather than encoded in a delayed job,
        // so a customer who pays by hand mid-cycle simply stops being due and
        // no cancellation of a scheduled job is required.
        const subscription = await run(systemContext(job.organizationId), (tx) =>
          tx.subscription.findFirst({
            where: { id: job.subscriptionId, organizationId: job.organizationId },
            select: { dunningAttempts: true, lastRenewalAt: true },
          })
        );

        if (!subscription) return;
        if (!shouldRetryNow(subscription, new Date())) {
          log.debug('not due for a retry yet');
          return;
        }

        const result = await renewSubscription(
          job.organizationId,
          job.subscriptionId,
          runtime,
          run
        );
        log.info(
          { outcome: result.outcome, attempt: subscription.dunningAttempts },
          'dunning retry'
        );
        return;
      }

      case 'SUSPEND': {
        const suspended = await suspendOverdue(
          job.organizationId,
          job.subscriptionId,
          runtime,
          run
        );
        if (suspended) log.warn('subscription suspended after the grace period');
        return;
      }

      case 'EXPIRE_TRIAL': {
        const expired = await expireTrial(job.organizationId, job.subscriptionId, runtime, run);
        if (expired) log.info('trial expired');
        return;
      }

      case 'FINALISE_CANCELLATION': {
        const ended = await finaliseCancellation(
          job.organizationId,
          job.subscriptionId,
          runtime,
          run
        );
        if (ended) log.info('scheduled cancellation completed');
        return;
      }
    }
  } catch (error) {
    if (error instanceof PaymentUnavailableError) {
      // No verdict. Retry with the same reference; see the note above.
      log.warn({ err: error.message }, 'payment provider unavailable; will retry');
      throw error;
    }
    throw error;
  }
}
