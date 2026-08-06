/**
 * The commercial decisions, in one file, as data.
 *
 * These are the numbers a founder changes and an engineer should not have to go
 * looking for: how long a failed payment buys you, how many times we retry, how
 * much headroom a mandate carries. They are constants rather than settings
 * because changing one changes what customers are owed, and that should be a
 * commit with a reviewer on it — not a row somebody edited in a console.
 */

import { money, scaleMoney, type Money } from '@rcln/payments';
import type { SubscriptionStatus } from '@rcln/db';
import { addDays } from './periods.js';

/**
 * How long a clinic keeps working after a renewal fails.
 *
 * ⚠️ THIS IS A CLINICAL SYSTEM, AND THAT CHANGES THE ANSWER.
 *   The instinct from consumer SaaS is to cut access quickly to force payment.
 *   Here, the thing behind the paywall is a waiting room with patients in it and
 *   a prescription somebody is mid-way through writing. A card that expired over
 *   a weekend must not close a clinic on Monday morning.
 *
 *   Fourteen days is long enough to reach a human, and the clinic sees the state
 *   on every screen throughout. Suspension at the end of it is still not
 *   deletion: the data stays, and paying restores access.
 */
export const GRACE_PERIOD_DAYS = 14;

/**
 * When to retry a failed renewal, in days after the first failure.
 *
 * Front-loaded, because the most common cause is a transient issuer decline that
 * clears within a day; then spaced out, because after the third attempt the
 * cause is almost always something only a human can fix. The last attempt lands
 * before the grace period ends, so the clinic is never suspended without a final
 * try having been made.
 */
export const DUNNING_SCHEDULE_DAYS = [1, 3, 7, 12] as const;

export const MAX_DUNNING_ATTEMPTS = DUNNING_SCHEDULE_DAYS.length;

/** Days before period end that a renewal may be attempted early. Zero: on time. */
export const RENEWAL_LEAD_DAYS = 0;

/** How long a hosted checkout stays payable before the intent expires. */
export const CHECKOUT_TTL_MINUTES = 30;

/**
 * How much more than one period's price a mandate is authorised for.
 *
 * A mandate is taken once and has to survive everything that happens afterwards:
 * an upgrade to a dearer plan, a price rise, an extra branch. Too tight and the
 * first renewal after any of those is declined for a reason the customer cannot
 * see. The ceiling is shown to them on the authorisation screen, so being
 * generous here is a matter of trust rather than of risk — they approve it or
 * they do not.
 *
 * Three times covers a two-tier jump and a rise, and is still recognisably
 * related to what they are buying.
 */
export const MANDATE_HEADROOM_MULTIPLIER = 3;

export function mandateCeiling(periodPrice: Money): Money {
  return scaleMoney(periodPrice, MANDATE_HEADROOM_MULTIPLIER, 1);
}

/**
 * Statuses that entitle a clinic to use the product.
 *
 * ⚠️ `INCOMPLETE` IS NOT ON THIS LIST AND MUST NEVER BE.
 *   It means checkout has started and no money has arrived. A subscription that
 *   grants access in that state is a subscription anyone can have for free by
 *   opening a payment page and closing it.
 *
 * PAST_DUE *is* on it. That is the grace period doing its job; whether the grace
 * period has expired is a separate question, asked by `isWithinGrace`.
 */
const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
]);

export interface EntitlementSubject {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  gracePeriodEnd: Date | null;
}

/**
 * May this clinic use the product right now?
 *
 * The single question every entitlement check reduces to. It reads the clock as
 * well as the status because a TRIALING row whose trial ended yesterday is not
 * entitled to anything, and the worker that would have moved it to EXPIRED may
 * not have run yet — the answer must not depend on a background job having
 * fired.
 */
export function isEntitled(subject: EntitlementSubject, at: Date = new Date()): boolean {
  if (!ENTITLED_STATUSES.has(subject.status)) return false;

  if (subject.status === 'TRIALING') {
    return subject.trialEndsAt !== null && at < subject.trialEndsAt;
  }

  if (subject.status === 'PAST_DUE') {
    return isWithinGrace(subject, at);
  }

  return true;
}

export function isWithinGrace(subject: EntitlementSubject, at: Date = new Date()): boolean {
  const until = subject.gracePeriodEnd ?? addDays(subject.currentPeriodEnd, GRACE_PERIOD_DAYS);
  return at < until;
}

export function graceEndFor(failedAt: Date): Date {
  return addDays(failedAt, GRACE_PERIOD_DAYS);
}

/**
 * When the next dunning attempt is due, or null when there are none left.
 *
 * `attempt` is how many have already been made. Returning null is the signal to
 * suspend rather than to keep retrying — a queue that retries forever is a queue
 * that never tells anyone the customer has gone.
 */
export function nextDunningAt(firstFailureAt: Date, attempt: number): Date | null {
  const offset = DUNNING_SCHEDULE_DAYS[attempt];
  return offset === undefined ? null : addDays(firstFailureAt, offset);
}

/**
 * Statuses a clinic may start a checkout from.
 *
 * ACTIVE is absent on purpose: an active subscription changes plan through the
 * upgrade flow, which prorates. Letting it start a fresh checkout would charge a
 * full period on top of one already paid for.
 */
const SUBSCRIBABLE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'TRIALING',
  'INCOMPLETE',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
]);

export function canStartCheckout(status: SubscriptionStatus): boolean {
  return SUBSCRIBABLE_STATUSES.has(status);
}

/** Statuses an upgrade may be applied to. A cancelled plan is re-subscribed to. */
const UPGRADABLE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
]);

export function canUpgrade(status: SubscriptionStatus): boolean {
  return UPGRADABLE_STATUSES.has(status);
}

/** Zero in the given currency. A trial upgrade owes nothing for the old plan. */
export function zeroIn(currency: string): Money {
  return money(0, currency);
}
