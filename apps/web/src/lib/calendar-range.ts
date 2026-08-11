/**
 * Calendar arithmetic for the appointment board's day / week / month views.
 *
 * ⚠️ EVERY FUNCTION HERE TAKES AND RETURNS `YYYY-MM-DD`, AND NONE OF THEM READS
 *   A CLOCK. Two reasons, and both have already bitten this codebase:
 *
 *     - A `Date` in the browser is in the BROWSER's zone. A receptionist on a
 *       laptop left in another timezone would see "today" roll over at the
 *       wrong moment, and the board would look perfectly plausible while being
 *       a day out. The calendar day is the branch's, and it is decided once on
 *       the server (`todayIn`) and passed down.
 *     - Reading the clock in a render body is impure: the server pass and
 *       hydration disagree and React throws the subtree away. The board takes
 *       `today` as a prop for exactly this reason, as `asOf` already was.
 *
 *   So the arithmetic below runs on UTC midnights — a fixed 24-hour grid with no
 *   DST in it — which is safe precisely BECAUSE these strings are never instants.
 *   Turning a calendar day into an instant happens in Postgres, in the branch's
 *   zone. See `rangeBounds` in appointment.service.ts.
 */

/** How much of the diary is on screen. */
export type BoardView = 'day' | 'week' | 'month';

export const BOARD_VIEWS: BoardView[] = ['day', 'week', 'month'];

/** An inclusive span of calendar days, both ends `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string | undefined): value is string {
  return value !== undefined && DATE_PATTERN.test(value);
}

/** Anything else — a hand-edited URL, a missing parameter — is the day view. */
export function toBoardView(value: string | undefined): BoardView {
  return value === 'week' || value === 'month' ? value : 'day';
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function format(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole days. */
export function shiftDays(date: string, days: number): string {
  const at = parse(date);
  at.setUTCDate(at.getUTCDate() + days);
  return format(at);
}

/**
 * `YYYY-MM-DD` shifted by whole months, clamped to the end of the target month.
 *
 * ⚠️ THE CLAMP IS THE POINT. `setUTCMonth` on the 31st of March with a -1
 *   overflows into March again (there is no 31 February), so the "previous
 *   month" arrow would leave you where you started — a control that visibly
 *   does nothing. Clamping to the 28th/30th moves as the user asked.
 */
export function shiftMonths(date: string, months: number): string {
  const at = parse(date);
  const day = at.getUTCDate();
  at.setUTCDate(1);
  at.setUTCMonth(at.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)
  ).getUTCDate();
  at.setUTCDate(Math.min(day, lastDayOfTarget));
  return format(at);
}

/**
 * The Monday of the week containing `date`.
 *
 * Monday, not Sunday: it is what an Indian clinic's roster and every
 * `branch_operating_hours` row are already written against, and a week strip
 * that starts on a different day from the one the working hours are set on is a
 * week strip nobody can reconcile.
 */
export function startOfWeek(date: string): string {
  const at = parse(date);
  const weekday = at.getUTCDay(); // 0 = Sunday
  return shiftDays(date, weekday === 0 ? -6 : 1 - weekday);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const at = parse(date);
  return format(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)));
}

/**
 * Every date from `from` to `to`, inclusive.
 *
 * Guarded against a backwards range returning an infinite list — the caller is
 * always composing these from `startOfMonth`/`endOfMonth`, but a guard is
 * cheaper than the browser tab that never comes back.
 */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = from; at <= to; at = shiftDays(at, 1)) {
    days.push(at);
    if (days.length > 400) break;
  }
  return days;
}

/**
 * 0 = Monday … 6 = Sunday.
 *
 * ⚠️ NOT `getUTCDay()`, WHICH IS 0 = SUNDAY. Both conventions are in this
 *   codebase and they are each right in their place: Postgres's `EXTRACT(dow)`
 *   is Sunday-first and `doctor_schedules.day_of_week` stores that, so the API
 *   speaks it. A month grid drawn Monday-first needs the other, and mixing them
 *   silently shifts every cell by one column.
 */
export function weekdayIndex(date: string): number {
  const sundayFirst = parse(date).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** Column headings for a Monday-first grid. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** "Monday", "Tuesday" … for the day a date falls on. */
export function weekdayName(date: string): string {
  return WEEKDAY_NAME.format(parse(date));
}

/** The span a view covers around its anchor day. */
export function rangeFor(view: BoardView, anchor: string): DateRange {
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: shiftDays(from, 6) };
  }
  if (view === 'month') {
    return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }
  return { from: anchor, to: anchor };
}

/** Where the arrows go: one day, one week or one month either side. */
export function stepAnchor(view: BoardView, anchor: string, direction: -1 | 1): string {
  if (view === 'week') return shiftDays(anchor, 7 * direction);
  if (view === 'month') return shiftMonths(anchor, direction);
  return shiftDays(anchor, direction);
}

export function isWithin(range: DateRange, date: string): boolean {
  return date >= range.from && date <= range.to;
}

/**
 * Today's calendar date in a named timezone.
 *
 * ⚠️ SERVER-SIDE ONLY, and the result is passed down as a prop rather than
 *   recomputed in the browser — see the header. The zone is the BRANCH's, so a
 *   clinic in Kolkata rolls over at midnight IST whatever the laptop thinks.
 */
export function todayIn(timezone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is the whole reason it is used here.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date());
}

/**
 * Which calendar day an instant falls on, where the clinic is standing.
 *
 * ⚠️ THIS IS ARITHMETIC, NOT DISPLAY, WHICH IS WHY IT IS HERE AND NOT IN
 *   `lib/format.ts`. Its output is never read by a person: it fills a
 *   `<input type="date">` and it goes back to the API as `suppliedOn`, a
 *   calendar date the server reads in the branch's zone. Formatting a date FOR
 *   somebody is `formatClinicDate`, which also honours the clinic's chosen
 *   format — and a fresh `Intl.DateTimeFormat` there would be the bug
 *   apps/web/AGENTS.md warns about.
 *
 * ⚠️ AND THE ZONE IS NOT OPTIONAL. `iso.slice(0, 10)` is the same string in UTC
 *   and looks right for most of the day, then silently reports the previous day
 *   for every evening supply in India — which would re-date the invoice the
 *   moment somebody opened the draft and saved it without touching the field.
 *   Pure: it reads the instant it is given and never a clock, so it is safe on
 *   either side of hydration.
 */
export function calendarDateIn(instant: string, timezone: string): string {
  // `en-CA` formats as YYYY-MM-DD, the same reason `todayIn` uses it.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(instant));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const LONG_DAY = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const SHORT_DAY = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const DAY_MONTH = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const WEEKDAY_NAME = new Intl.DateTimeFormat('en-IN', { weekday: 'long', timeZone: 'UTC' });

/** "August 2026" — the heading over a month grid. */
export function monthLabel(date: string): string {
  return MONTH_YEAR.format(parse(date));
}

/** "Monday, 9 August 2026". */
export function longDate(date: string): string {
  return LONG_DAY.format(parse(date));
}

/** "Mon, 9 Aug" — the heading on a day inside a week or month listing. */
export function shortDate(date: string): string {
  return SHORT_DAY.format(parse(date));
}

/**
 * What the range is called at the top of the board.
 *
 * A week reads as "3 Aug – 9 Aug 2026" and a month as "August 2026", because
 * those are what somebody says out loud. The day keeps its full weekday: it is
 * the view the front desk works in all day, and "which day is this" is the one
 * question the heading has to answer without being read twice.
 */
export function rangeLabel(view: BoardView, range: DateRange): string {
  if (view === 'month') return MONTH_YEAR.format(parse(range.from));
  if (view === 'week') {
    return `${DAY_MONTH.format(parse(range.from))} – ${DAY_MONTH.format(parse(range.to))} ${range.to.slice(0, 4)}`;
  }
  return longDate(range.from);
}
