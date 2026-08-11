'use client';

import { useEffect, useState } from 'react';
import type { WorkingDay, WorkingDayReason } from '@rcln/contracts';
import { Button } from '@/components/ui/button';
import {
  WEEKDAY_INITIALS,
  eachDay,
  endOfMonth,
  longDate,
  monthLabel,
  shiftMonths,
  startOfMonth,
  weekdayIndex,
  weekdayName,
} from '@/lib/calendar-range';
import { loadWorkingDays } from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

/**
 * Which day to book on — a month at a time, with the days this doctor does not
 * consult on greyed out.
 *
 * ⚠️ IT REPLACES `<input type="date">`, AND IT HAD TO. A native date input takes
 *   `min` and `max` and nothing else: there is no way to tell it "every
 *   Wednesday is out". So the field offered the front desk a Thursday for a
 *   doctor who works Sunday to Tuesday, took it, and only the empty slot grid
 *   underneath said otherwise — after the click, in a different part of the
 *   screen, in a sentence nobody was looking at.
 *
 * ⚠️ THE GREYING IS PER DOCTOR AND RE-READ WHEN THE DOCTOR CHANGES. That is the
 *   whole point: "which days are available" has no answer that is not about one
 *   practitioner. Changing the doctor in the panel above re-reads the month, and
 *   the previously chosen day may stop being bookable — which the panel says in
 *   words rather than silently moving the booking.
 *
 * ⚠️ IT IS NOT THE AUTHORITY, THE SLOT GRID IS, AND BEHIND THAT THE EXCLUDE
 *   CONSTRAINT. A day here is "the doctor has hours that have not gone", never
 *   "there is something free" — a fully booked Monday stays selectable, because
 *   greying it out would hide the day somebody has just cancelled out of.
 *
 * ACCESSIBILITY
 *   Unbookable days use `aria-disabled`, not `disabled`, so they keep their
 *   place in the tab order and announce WHY — "Wednesday 12 August, not
 *   consulting". A `disabled` button is skipped silently, which tells a screen
 *   reader user nothing about the shape of the week. Colour never carries it
 *   either way: every cell's label states its condition in words.
 */

const REASON_WORDS: Record<WorkingDayReason, string> = {
  PAST: 'in the past',
  NOT_SCHEDULED: 'not consulting',
  ON_LEAVE: 'on leave',
  BRANCH_CLOSED: 'clinic closed',
};

/** A month grid is six weeks of seven days, always — a fixed height never jumps. */
const GRID_CELLS = 42;

export function WorkingDayPicker({
  slug,
  branchId,
  doctorProfileId,
  value,
  today,
  onChange,
}: {
  slug: string;
  branchId: string;
  /** Empty when no doctor is chosen yet — the grid then has nothing to say. */
  doctorProfileId: string;
  /** The chosen day, `YYYY-MM-DD`. */
  value: string;
  /** Today in the branch's zone, from the server. See the board's `today`. */
  today: string;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(startOfMonth(value));

  /*
   * ⚠️ THE MONTH AND ITS ANSWER ARE TAGGED WITH THE (doctor, month) THEY BELONG
   *   TO, AND "loading" IS DERIVED FROM THAT TAG RATHER THAN STORED. The same
   *   arrangement, for the same two reasons, as the slot diary in
   *   `BookingPanel`: a `setLoading(true)` at the top of the effect is a
   *   synchronous setState inside an effect, and a slow answer for last month
   *   landing after this month's would repaint the grid with the wrong days.
   *   Comparing tags makes both disappear — a reply for the wrong key is simply
   *   never the one rendered.
   */
  const key = `${doctorProfileId}|${month}`;
  const [loaded, setLoaded] = useState<{ key: string; days: WorkingDay[] | null } | null>(null);

  const loading = doctorProfileId !== '' && loaded?.key !== key;
  const days = loaded?.key === key ? loaded.days : null;

  useEffect(() => {
    if (doctorProfileId === '') return;
    let live = true;
    void loadWorkingDays(slug, branchId, doctorProfileId, month, endOfMonth(month)).then(
      (result) => {
        if (live) setLoaded({ key, days: result?.days ?? null });
      }
    );
    return () => {
      live = false;
    };
  }, [slug, branchId, doctorProfileId, month, key]);

  const byDate = new Map((days ?? []).map((day) => [day.date, day]));
  const chosen = byDate.get(value);

  /*
   * The next day this doctor could actually be booked on, from the chosen day
   * onwards, within the month on screen. Offered as a button rather than applied
   * silently: moving somebody's booking to a different day without being asked
   * is exactly the kind of help that gets noticed a week later.
   */
  const nextBookable = (days ?? []).find((day) => day.bookable && day.date >= value)?.date;

  return (
    <div>
      <p className="text-ink block text-sm font-medium">Day</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {longDate(value)}
          <span aria-hidden="true" className="ml-2">
            {open ? '▲' : '▼'}
          </span>
          <span className="sr-only">— change the day</span>
        </Button>
        {value === today ? <span className="text-muted text-[0.8125rem]">Today</span> : null}
      </div>

      {/*
       * The consulting week, stated in words above the grid. It is what the
       * front desk actually needs to know before they open a calendar at all —
       * "he is here Sunday, Monday and Tuesday" answers the question on the
       * phone without a single click.
       */}
      {days !== null ? (
        <p className="text-muted mt-1.5 text-[0.8125rem] leading-snug">{consultingWeek(days)}</p>
      ) : null}

      {chosen !== undefined && !chosen.bookable ? (
        <div className="border-rule mt-2 rounded-sm border border-dashed px-3 py-2">
          <p className="text-ink text-[0.8125rem]">
            This doctor is {REASON_WORDS[chosen.reason ?? 'NOT_SCHEDULED']} on {longDate(value)}.
          </p>
          {nextBookable !== undefined ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onChange(nextBookable)}
            >
              Use {longDate(nextBookable)} instead
            </Button>
          ) : (
            <p className="text-muted mt-0.5 text-[0.8125rem]">
              Nothing later this month either — try the next month.
            </p>
          )}
        </div>
      ) : null}

      {open ? (
        <div className="border-rule bg-card mt-2 max-w-xs rounded-md border p-3">
          <div className="flex items-center justify-between">
            <MonthArrow
              label="Previous month"
              glyph="←"
              /* Nothing before this month can be booked, so there is nothing
                 back there to look at. */
              disabled={month <= startOfMonth(today)}
              onClick={() => setMonth(shiftMonths(month, -1))}
            />
            <p className="text-ink text-[0.875rem] font-medium">{monthLabel(month)}</p>
            <MonthArrow
              label="Next month"
              glyph="→"
              onClick={() => setMonth(shiftMonths(month, 1))}
            />
          </div>

          <div className="mt-2 grid grid-cols-7 gap-0.5" aria-hidden="true">
            {WEEKDAY_INITIALS.map((initial, index) => (
              <p
                key={`${initial}-${String(index)}`}
                className="text-muted py-1 text-center text-[0.6875rem]"
              >
                {initial}
              </p>
            ))}
          </div>

          {loading ? (
            <p className="text-muted px-1 py-6 text-center text-[0.8125rem]">Reading the rota…</p>
          ) : doctorProfileId === '' ? (
            <p className="text-muted px-1 py-6 text-center text-[0.8125rem]">
              Choose a doctor first.
            </p>
          ) : days === null ? (
            <p className="text-signal px-1 py-6 text-center text-[0.8125rem]">
              The rota could not be read. Try again in a moment.
            </p>
          ) : (
            <div className="grid grid-cols-7 gap-0.5">
              {monthCells(month).map((date, index) =>
                date === null ? (
                  <span key={`blank-${String(index)}`} />
                ) : (
                  <DayCell
                    key={date}
                    date={date}
                    day={byDate.get(date)}
                    selected={date === value}
                    isToday={date === today}
                    onPick={() => {
                      onChange(date);
                      setOpen(false);
                    }}
                  />
                )
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MonthArrow({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-ink hover:bg-drape-tint/60 disabled:text-muted cursor-pointer rounded-sm px-2.5 py-1.5 text-[0.8125rem] transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * One day in the grid.
 *
 * ⚠️ `aria-disabled`, NOT `disabled` — see the component header. The click is
 *   dropped in the handler instead, which is what makes the cell both inert and
 *   still announceable.
 */
function DayCell({
  date,
  day,
  selected,
  isToday,
  onPick,
}: {
  date: string;
  /** Absent while a month is loading, or if the API skipped it. Treated as shut. */
  day: WorkingDay | undefined;
  selected: boolean;
  isToday: boolean;
  onPick: () => void;
}) {
  const bookable = day?.bookable ?? false;
  const reason = day?.reason ?? 'NOT_SCHEDULED';
  const number = Number(date.slice(8));

  return (
    <button
      type="button"
      aria-disabled={!bookable}
      aria-pressed={selected}
      aria-label={`${weekdayName(date)} ${String(number)}${bookable ? '' : `, ${REASON_WORDS[reason]}`}`}
      onClick={() => {
        if (bookable) onPick();
      }}
      className={[
        'rounded-sm py-1.5 text-center text-[0.8125rem] tabular-nums transition-colors',
        selected
          ? 'bg-drape font-medium text-paper'
          : bookable
            ? 'text-ink hover:bg-drape-tint/60 cursor-pointer'
            : /* Not a colour cue on its own: the label says why, and the cursor
                 says it is not for clicking. */
              'text-muted bg-paper cursor-not-allowed',
        isToday && !selected ? 'ring-drape/40 ring-1' : '',
      ].join(' ')}
    >
      {number}
    </button>
  );
}

/**
 * The days of a month, laid out Monday-first, with leading and trailing blanks.
 *
 * Always 42 cells so the panel's height never changes between a month that
 * needs five rows and one that needs six — a grid that resizes under the cursor
 * makes people click the wrong day.
 */
function monthCells(month: string): (string | null)[] {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const lead = weekdayIndex(first);

  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (const date of eachDay(first, last)) cells.push(date);
  while (cells.length < GRID_CELLS) cells.push(null);

  return cells;
}

/**
 * "Consults on Sun, Mon and Tue." — the consulting week in one sentence.
 *
 * ⚠️ DERIVED FROM WHAT THE ROTA SAYS, NOT FROM WHAT IS BOOKABLE. A Monday the
 *   doctor is on leave, or the clinic is shut, or that has simply gone, is still
 *   a Monday they consult on — reading this off `bookable` would tell the desk
 *   "he does not work Mondays" on the strength of one week's leave.
 */
function consultingWeek(days: WorkingDay[]): string {
  const scheduled = new Set<number>();
  for (const day of days) {
    if (day.reason === 'NOT_SCHEDULED') continue;
    scheduled.add(weekdayIndex(day.date));
  }

  if (scheduled.size === 0) return 'No consulting days at this clinic in this month.';
  if (scheduled.size === 7) return 'Consults every day at this clinic.';

  const names = [...scheduled]
    .sort((a, b) => a - b)
    .map((index) => WEEKDAY_SHORT[index] ?? '')
    .filter((name) => name !== '');

  const last = names.pop();
  return names.length === 0
    ? `Consults on ${String(last)}.`
    : `Consults on ${names.join(', ')} and ${String(last)}.`;
}

/** Monday-first, matching `weekdayIndex`. */
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
