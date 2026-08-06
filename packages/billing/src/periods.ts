/**
 * Billing periods, and the calendar arithmetic that decides when money moves.
 *
 * EVERYTHING HERE IS UTC. Not because clinics live in UTC — they emphatically
 * do not, and `organizations.timezone` exists for exactly that reason — but
 * because a billing period is a stored interval between two instants, and
 * local-time arithmetic on a stored instant introduces a one-hour error twice a
 * year in every country that observes DST. A clinic in São Paulo whose period
 * ends "1 March" must not be billed on 28 February because the clock moved.
 *
 * Presentation is a separate job, done at the edge with the clinic's timezone.
 *
 * THE ANCHOR DAY IS THE WHOLE PROBLEM
 *   Naively adding a month to 31 January gives 31 February, which does not
 *   exist. Clamping it to 28 February is right; then adding a month to THAT
 *   gives 28 March, and a clinic that signed up on the 31st is now billed on the
 *   28th forever. The drift is silent, permanent and cumulative.
 *
 *   So every period is computed from an ANCHOR — the day of the month the
 *   subscription started — and clamped only for the month it is being placed in.
 *   31 Jan -> 28 Feb -> 31 Mar, which is what the customer expects and what
 *   every other billing system does.
 */

export type Interval = 'MONTH' | 'YEAR';

export interface Period {
  start: Date;
  end: Date;
}

const MS_PER_DAY = 86_400_000;

/** Days in a UTC month. Handles February and leap years by asking the calendar. */
function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add whole months, clamped to the target month's length and anchored to a day
 * that does not drift.
 *
 * `anchorDay` is the day of the month the subscription started on. Pass it on
 * every call — omitting it re-derives the anchor from a date that may itself
 * have been clamped, which is the drift described in the header.
 */
export function addMonths(from: Date, months: number, anchorDay?: number): Date {
  const anchor = anchorDay ?? from.getUTCDate();
  const targetMonth = from.getUTCMonth() + months;
  const year = from.getUTCFullYear() + Math.floor(targetMonth / 12);
  // Modulo can go negative for a backwards step; normalise it.
  const monthIndex = ((targetMonth % 12) + 12) % 12;

  return new Date(
    Date.UTC(
      year,
      monthIndex,
      Math.min(anchor, daysInMonth(year, monthIndex)),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds()
    )
  );
}

/**
 * Advance by one billing interval.
 *
 * A year is twelve months rather than 365 days, so 29 February renews on
 * 28 February — the same clamping rule, applied once instead of twelve times.
 */
export function addInterval(from: Date, interval: Interval, count = 1, anchorDay?: number): Date {
  return addMonths(from, interval === 'YEAR' ? 12 * count : count, anchorDay);
}

/** The period that starts at `start`. */
export function periodFrom(start: Date, interval: Interval, anchorDay?: number): Period {
  return { start, end: addInterval(start, interval, 1, anchorDay) };
}

/**
 * Whole days between two instants, rounded UP.
 *
 * Rounded up because a partial day is a day the clinic had the software. It
 * makes the denominator and the numerator of a proration consistent — both are
 * measured the same way — and it errs towards the customer on the credit side,
 * which is the side to err on.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Days left in a period at a given instant, clamped to [0, length].
 *
 * Clamped rather than trusted: a renewal that runs late, or a clock that has
 * skewed, must not produce a negative credit or a credit larger than the period
 * that was paid for.
 */
export function daysRemaining(period: Period, at: Date): number {
  const total = daysBetween(period.start, period.end);
  if (at <= period.start) return total;
  if (at >= period.end) return 0;
  return Math.min(total, Math.max(0, daysBetween(at, period.end)));
}

/** Has this period run out at `at`? The due-sweep's question. */
export function isPeriodOver(period: Period, at: Date = new Date()): boolean {
  return at >= period.end;
}

/** Midnight UTC on the same calendar day. For `date`-typed invoice columns. */
export function toDateOnly(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0)
  );
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}
