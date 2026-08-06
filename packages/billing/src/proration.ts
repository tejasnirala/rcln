/**
 * What an upgrade costs in the middle of a period.
 *
 * THE RULE, IN ONE SENTENCE
 *   Credit the unused part of what they already paid for, charge the same
 *   fraction of the new plan, collect the difference now, and leave the renewal
 *   date exactly where it was.
 *
 * WHY THE RENEWAL DATE DOES NOT MOVE
 *   Resetting the period on an upgrade is the other common choice and it is
 *   worse in both directions: a clinic that upgrades on day 29 gets a nearly
 *   free extra month, and one that upgrades on day 2 loses 28 days it paid for
 *   unless you credit them anyway — at which point you are prorating regardless,
 *   with an extra moving part. Keeping the anchor means the invoice history
 *   stays on a rhythm a finance team can reconcile.
 *
 * ROUNDING, STATED ONCE
 *   Both sides round half away from zero, on the whole line rather than per day.
 *   The largest possible discrepancy is one minor unit, and it is symmetric —
 *   which matters because the credit and the charge appear as separate lines on
 *   the same invoice and a customer will add them up.
 *
 * NO DOWNGRADE, SO NO REFUND
 *   `amountDue` floors at zero. A change whose credit exceeds its charge is a
 *   downgrade, and `classifyChange` refuses those before this function is
 *   reached (ADR-0014). If a floor ever actually bites, the arithmetic upstream
 *   is wrong and the quote should be treated as a bug, not as a free upgrade.
 */

import { money, scaleMoney, subtractMoney, type Money } from '@rcln/payments';
import { daysBetween, daysRemaining, type Period } from './periods.js';

export interface ProrationInput {
  /** The period the subscription is currently in. */
  period: Period;
  /** When the change takes effect. Almost always "now". */
  at: Date;
  /** What the current plan costs for one whole period. */
  currentAmount: Money;
  /** What the new plan costs for one whole period, same currency. */
  nextAmount: Money;
}

export interface ProrationQuote {
  /** Total days in the period being prorated. The denominator. */
  periodDays: number;
  /** Days the clinic has not used yet. The numerator. */
  remainingDays: number;
  /** Unused value on the old plan, as a positive amount. */
  credit: Money;
  /** The same stretch of time on the new plan, as a positive amount. */
  charge: Money;
  /** charge - credit, floored at zero. What to collect today. */
  amountDue: Money;
  /** True when nothing is owed — an upgrade taken on the last day of a period. */
  isFree: boolean;
}

export class ProrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProrationError';
  }
}

export function prorate(input: ProrationInput): ProrationQuote {
  const { period, at, currentAmount, nextAmount } = input;

  if (currentAmount.currency !== nextAmount.currency) {
    // Not a rounding problem — there is no honest exchange rate to apply here,
    // and inventing one would make the invoice unreconcilable. The caller must
    // find a price in the subscription's own currency or refuse the change.
    throw new ProrationError(
      `cannot prorate ${currentAmount.currency} against ${nextAmount.currency}`
    );
  }

  const periodDays = daysBetween(period.start, period.end);
  if (periodDays <= 0) {
    throw new ProrationError(
      'the current period has no length; nothing can be prorated against it'
    );
  }

  const remainingDays = daysRemaining(period, at);

  const credit = scaleMoney(currentAmount, remainingDays, periodDays);
  const charge = scaleMoney(nextAmount, remainingDays, periodDays);
  const difference = subtractMoney(charge, credit);
  const amountDue = difference.amountMinor > 0 ? difference : money(0, difference.currency);

  return {
    periodDays,
    remainingDays,
    credit,
    charge,
    amountDue,
    isFree: amountDue.amountMinor === 0,
  };
}

// ---------------------------------------------------------------------------
// Is this change actually an upgrade?
// ---------------------------------------------------------------------------

export type ChangeDirection = 'UPGRADE' | 'LATERAL' | 'DOWNGRADE';

/**
 * A plan's entitlements, flattened. `-1` is the schema's "unlimited".
 *
 * Read from `plan_features`, not from price. Price is the wrong test: an annual
 * plan costs more up front and less per day than the monthly one, so any
 * comparison of amounts calls a monthly-to-annual switch a downgrade in one
 * direction and an upgrade in the other depending on which number you pick.
 * What a customer means by "upgrade" is "I get more", and that is a question
 * about features.
 */
export type FeatureMap = Readonly<Record<string, number | boolean>>;

/** `-1` means unlimited, which compares greater than every finite limit. */
function asComparable(value: number | boolean): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value < 0 ? Number.POSITIVE_INFINITY : value;
}

/**
 * Compare two plans by what they give you, then break ties on commitment.
 *
 * The three answers mean different things to the caller:
 *   UPGRADE   — allowed, prorated, charged now.
 *   LATERAL   — the same product. Refused, because there is nothing to sell and
 *               a "change" that costs nothing and grants nothing is a support
 *               ticket waiting to happen.
 *   DOWNGRADE — refused. rcln does not do downgrades (ADR-0014): they are the
 *               one plan change that can strip a clinic of a branch or a user it
 *               is actively using, and doing that automatically at a moment
 *               nobody chose is not something a healthcare system should do.
 */
export function classifyChange(
  from: { features: FeatureMap; interval: 'MONTH' | 'YEAR' },
  to: { features: FeatureMap; interval: 'MONTH' | 'YEAR' }
): ChangeDirection {
  const keys = new Set([...Object.keys(from.features), ...Object.keys(to.features)]);

  let anyBetter = false;
  let anyWorse = false;

  for (const key of keys) {
    // A key the new plan does not mention is a key it does not grant. Treating a
    // missing feature as "unchanged" is how a plan that quietly dropped the
    // pharmacy module passed as a lateral move.
    const before = asComparable(from.features[key] ?? 0);
    const after = asComparable(to.features[key] ?? 0);

    if (after > before) anyBetter = true;
    if (after < before) anyWorse = true;
  }

  // Any loss at all is a downgrade, even alongside a gain. "More users but no
  // lab module" is not something to decide on the customer's behalf.
  if (anyWorse) return 'DOWNGRADE';
  if (anyBetter) return 'UPGRADE';

  // Identical entitlements. Committing to a longer term is still an upgrade —
  // it is the one plan change that is unambiguously more of the product.
  if (from.interval === 'MONTH' && to.interval === 'YEAR') return 'UPGRADE';
  if (from.interval === 'YEAR' && to.interval === 'MONTH') return 'DOWNGRADE';

  return 'LATERAL';
}
