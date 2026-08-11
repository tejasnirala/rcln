'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import type {
  AppointmentListResponse,
  AppointmentStatusValue,
  AppointmentSummary,
  AvailabilitySlot,
  AvailabilityResponse,
  DoctorSummary,
  FeeQuote,
  PatientSummary,
  TimeFormat,
} from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { formatClinicTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Input, Select, Textarea, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  BOARD_VIEWS,
  longDate,
  rangeLabel,
  shortDate,
  stepAnchor,
  isWithin,
  type BoardView,
  type DateRange,
} from '@/lib/calendar-range';
import { GENDERS, ageLine } from '@/lib/patient-words';
import { WorkingDayPicker } from '@/components/tenant/working-day-picker';
import {
  bookAppointment,
  cancelBooking,
  deleteBooking,
  loadAvailability,
  lookupPatients,
  markAbsent,
  moveAppointment,
  registerAndPick,
  type BookingState,
  type LookupState,
  type QuickRegisterState,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';
import { loadFeeQuote } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

/**
 * The clinic's day.
 *
 * ⚠️ THE TIME RAIL IS THE ONE PIECE OF EMPHASIS ON THIS SCREEN, AND IT IS
 *   DELIBERATE. A clinic day is a timeline, not a list: what the front desk
 *   needs to see at a glance is not "eleven appointments" but WHERE THE GAPS
 *   ARE — the twenty free minutes at 11:20 that the person on the phone can
 *   have. A table of rows hides that; every row looks equally spaced whether
 *   the next patient is due in five minutes or ninety.
 *
 *   So the times run down a single rail and the bookings hang off it, and a gap
 *   in the day is rendered as a gap. Everything else on the screen is the same
 *   quiet card the rest of the app uses.
 *
 * ⚠️ STATUS IS NEVER CARRIED BY COLOUR ALONE (WCAG 1.4.1, and AGENTS.md lists it
 *   as a rule already got wrong once). Every row states its status in words.
 *
 * ⚠️ THE DATE IS A URL PARAMETER; THE PATIENT LOOKUP IS NOT. A date is nobody's
 *   surname. A search term is, and it never reaches the address bar.
 */

const IDLE_BOOKING: BookingState = { status: 'idle' };

/**
 * ⚠️ The client's own copy, and it has to be. A `'use server'` module may only
 *   export async functions, so this cannot be imported from `actions.ts` — the
 *   same reason `patient-search.tsx` keeps its own. `LookupState` is a TYPE and
 *   erases, so the two stay in step through that.
 */
const IDLE_LOOKUP: LookupState = { status: 'idle', patients: [] };

/** Same rule, same reason — see `IDLE_LOOKUP` above. */
const IDLE_REGISTER: QuickRegisterState = { status: 'idle' };

const STATUS_WORDS: Record<AppointmentStatusValue, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Arrived',
  IN_PROGRESS: 'With the doctor',
  COMPLETED: 'Seen',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not attend',
};

/** What the row's one button does next, and what it should say. */
const NEXT_STEP: Partial<
  Record<AppointmentStatusValue, { to: 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED'; label: string }>
> = {
  BOOKED: { to: 'CHECKED_IN', label: 'Arrived' },
  CONFIRMED: { to: 'CHECKED_IN', label: 'Arrived' },
  CHECKED_IN: { to: 'IN_PROGRESS', label: 'Start' },
  IN_PROGRESS: { to: 'COMPLETED', label: 'Seen' },
};

const VISIT_TYPES: SelectOption[] = [
  { value: 'NEW', label: 'First visit' },
  { value: 'FOLLOW_UP', label: 'Follow-up' },
  { value: 'PROCEDURE', label: 'Procedure' },
  { value: 'TELECONSULT', label: 'Video consultation' },
];

const SLOT_REASONS: Record<string, string> = {
  BOOKED: 'Taken',
  PAST: 'Gone',
  ON_LEAVE: 'On leave',
  BRANCH_CLOSED: 'Clinic closed',
  BLOCK_FULL: 'Session full',
};

/*
 * ⚠️ THE CLOCK FACE COMES FROM `formatClinicTime` IN @/lib/format, NOT FROM A
 *   LOCAL `Intl.DateTimeFormat`. There used to be one here — `en-IN`, `hour12:
 *   false`, hard-wired — which meant this board could not honour the clinic's
 *   `locale.time_format` choice however carefully the setting was resolved
 *   upstream. Every clinical time in the product goes through that one function
 *   so that the zone and the 12/24 choice are made in exactly one place.
 *
 *   Both arguments are passed, never defaulted: the branch's zone (a wrong zone
 *   is a wrong instant, plausibly rendered) and the branch's format.
 */

/**
 * Which calendar day a booking falls on, in the branch's zone.
 *
 * ⚠️ THE SAME ARGUMENT AS `clock` ABOVE, and it matters more here: the week and
 *   month views GROUP by this, so a browser in the wrong zone would not merely
 *   show a time an hour out, it would file a 09:00 Monday appointment under
 *   Sunday and put it under the wrong heading entirely.
 *
 * `en-CA` formats as YYYY-MM-DD, which is why it is used for a screen that is
 * otherwise entirely en-IN. Formatters are cached because a month view calls
 * this once per booking and `Intl.DateTimeFormat` is not cheap to construct.
 */
const DAY_KEY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayKey(iso: string, timezone: string): string {
  let formatter = DAY_KEY_FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    });
    DAY_KEY_FORMATTERS.set(timezone, formatter);
  }
  return formatter.format(new Date(iso));
}

// ---------------------------------------------------------------------------

export function AppointmentBoard({
  slug,
  branchId,
  branchName,
  timezone,
  timeFormat,
  view,
  anchor,
  doctorProfileId,
  range,
  today,
  day,
  doctors,
  canBook,
  canRegisterPatient,
  canCheckIn,
  canCancel,
  canDelete,
  asOf,
}: {
  slug: string;
  branchId: string;
  branchName: string;
  timezone: string;
  /**
   * The clinic's clock face — `12H` or `24H`, resolved from `locale.time_format`
   * for THIS branch and carried on the session beside the zone.
   *
   * ⚠️ DISPLAY ONLY, AND THREADED RATHER THAN LOOKED UP. Every instant on this
   *   board is UTC on the wire and rendered in `timezone`; this decides only
   *   whether the rail reads `4:40 pm` or `16:40`. It is a prop the whole way
   *   down for the same reason the zone is: a component that reached for a
   *   default would render one row differently from the one above it.
   */
  timeFormat: TimeFormat;
  /** Day, week or month. Off the URL, defaulted on the server. */
  view: BoardView;
  /** The day the view is centred on — what the arrows move. */
  anchor: string;
  /**
   * Whose list to show, or '' for the whole branch.
   *
   * ⚠️ FROM THE URL AND ALREADY CHECKED AGAINST THE ROSTER by the page — an id
   *   naming nobody at this branch arrives here as '' rather than as a filter
   *   that matches nothing, because an empty board reads as a quiet day and not
   *   as a bad link.
   */
  doctorProfileId: string;
  /** The span actually loaded, inclusive. Derived from `view` and `anchor`. */
  range: DateRange;
  /**
   * Today's calendar date IN THE BRANCH'S ZONE, resolved on the server.
   *
   * Passed rather than read here for the same reason as `asOf`: a clock read in
   * a render body differs between the server pass and hydration, and the
   * browser's zone is not the clinic's. It decides the earliest day the booking
   * panel will offer, and whether the "Today" shortcut is worth showing.
   */
  today: string;
  day: AppointmentListResponse | null;
  doctors: DoctorSummary[];
  canBook: boolean;
  /** Whether the booking panel may register the walk-in it could not find. */
  canRegisterPatient: boolean;
  canCheckIn: boolean;
  canCancel: boolean;
  canDelete: boolean;
  /**
   * When the server rendered this board, ISO-8601.
   *
   * Passed in rather than read from the browser's clock so the render stays
   * pure — see `AppointmentRow`. It decides which rows may offer a delete, and
   * nothing else.
   */
  asOf: string;
}) {
  const router = useRouter();
  const [booking, setBooking] = useState(false);

  /*
   * ⚠️ RELATIVE, WITHOUT `/t/<slug>`. `proxy.ts` has already rewritten
   *   `pmch.rcln.com/appointments` to `/t/pmch/appointments` on the way in, so
   *   pushing the internal path puts `/t/pmch/appointments` in the ADDRESS BAR —
   *   which the proxy then rewrites a second time, to
   *   `/t/pmch/t/pmch/appointments`, and 404s. The slug never belongs in a link;
   *   the Host header decides which clinic you are in. See apps/web/AGENTS.md.
   */
  const go = (nextView: BoardView, nextAnchor: string, nextDoctor = doctorProfileId) => {
    const query = new URLSearchParams({ view: nextView, date: nextAnchor });
    /*
     * Carried through every move, so stepping from Tuesday to Wednesday keeps
     * the doctor you were looking at. Dropping it on navigation would make the
     * filter feel like it kept switching itself off.
     */
    if (nextDoctor !== '') query.set('doctorProfileId', nextDoctor);
    router.push(`/appointments?${query.toString()}`);
  };

  /*
   * Which status the tally is filtered to, or null for all of them.
   *
   * ⚠️ CLIENT STATE, NOT THE URL — AND IT IS THE ONE PIECE OF BOARD STATE THAT
   *   IS NOT. `date` and `view` live in the URL because they decide WHICH ROWS
   *   ARE FETCHED: changing either is a different request, and a linkable one.
   *   This decides which of the rows already in hand are drawn, so putting it in
   *   the URL would mean a `router.push` and a full server round-trip on every
   *   chip press, re-fetching a day we already have to render a subset of it.
   *
   * ⚠️ AND IT MUST NOT REACH THE API, EVER. The counts come back derived from the
   *   rows the API returned, so a status filter sent to the server would filter
   *   the rows AND collapse the tally to `{ BOOKED: 3 }` — the strip would agree
   *   with itself and be wrong, which is worse than being obviously broken. The
   *   numbers are always the whole range; the list is what narrows.
   *
   * Resetting on `range` is deliberate: a filter is about the day you are
   * looking at, and one silently carried into next week reads as an empty week.
   */
  const [status, setStatus] = useState<AppointmentStatusValue | null>(null);
  const [filteredRange, setFilteredRange] = useState(range.from);

  const allAppointments = day?.appointments ?? [];
  const counts = day?.counts;

  /*
   * ⚠️ THE FILTER FOLLOWS THE DATA, AND BOTH CLAUSES ARE LOAD-BEARING.
   *
   *   The range change is the obvious one: an "Arrived" filter carried into next
   *   month is a screen that says nothing is booked when plenty is.
   *
   *   The second is the one that actually bites. Every row action —
   *   Arrived, Start, Seen — ends in `router.refresh()`, so pressing "Seen" on
   *   the last remaining With-the-doctor row while filtered to it drops that
   *   count to zero. The chip correctly disables itself; the FILTER would stay
   *   on, and the board would render its "Nothing booked for this day" empty
   *   state over a day that is perfectly full — with the only way out being a
   *   chip that is now greyed. Clearing it puts the reader back on the whole
   *   day, which is where finishing the last patient in a status should leave
   *   them anyway.
   *
   * Both are state adjusted during render rather than in an effect: React
   * re-runs this pass before committing anything, so nothing renders with the
   * stale filter and there is no flash of the wrong list.
   */
  if (filteredRange !== range.from) {
    setFilteredRange(range.from);
    setStatus(null);
  } else if (status !== null && (counts?.[status] ?? 0) === 0) {
    setStatus(null);
  }

  const appointments =
    status === null ? allAppointments : allAppointments.filter((a) => a.status === status);

  /*
   * The day the panel opens on: the day being looked at, unless that day has
   * gone — nothing can be booked into the past, and a week or month view has no
   * single day to mean anyway. Then it is today, which is what the desk means
   * when it books a walk-in.
   */
  const bookingDate = view === 'day' && anchor >= today ? anchor : today;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-2xl tracking-tight">
            {rangeLabel(view, range)}
          </h1>
          <p className="text-muted mt-1 text-[0.8125rem]">
            {branchName} · times shown in {timezone.replace('_', ' ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            ⚠️ FILTERED AT THE API, UNLIKE THE STATUS CHIPS BELOW, AND THE TALLY
              IS WHY. `counts` is computed from the rows the server returned, so
              narrowing to one doctor narrows the tally with it — "Dr Rao's day:
              four arrived, two done", which is the question being asked. A
              status filter must stay client-side for the mirror-image reason:
              the tally is the thing being filtered BY, and one that hid every
              status but the chosen one could never be clicked off again.

              It lives in the URL beside `date` and `view` because it decides
              which rows are FETCHED, and because a uuid names a clinician, not
              a patient — so "Dr Rao's Tuesday" is a link somebody can send.
          */}
          {doctors.length > 0 ? (
            <DoctorFilter
              doctors={doctors}
              selectedId={doctorProfileId}
              onSelect={(id) => go(view, anchor, id)}
            />
          ) : null}
          <RangeNav view={view} anchor={anchor} range={range} today={today} onGo={go} />
          {canBook ? (
            <Button size="sm" onClick={() => setBooking((open) => !open)} aria-expanded={booking}>
              {booking ? 'Close' : 'Book an appointment'}
            </Button>
          ) : null}
        </div>
      </header>

      {counts ? <DayTally counts={counts} selected={status} onSelect={setStatus} /> : null}

      {booking && canBook ? (
        <BookingPanel
          slug={slug}
          branchId={branchId}
          initialDate={bookingDate}
          today={today}
          doctors={doctors}
          canRegisterPatient={canRegisterPatient}
          timeFormat={timeFormat}
          onBooked={() => {
            setBooking(false);
            router.refresh();
          }}
        />
      ) : null}

      {day === null ? (
        <Alert tone="error">
          {view === 'day' ? 'The day' : 'The diary'} could not be loaded. Try again in a moment.
        </Alert>
      ) : view === 'day' ? (
        <TimeRail
          slug={slug}
          timezone={timezone}
          timeFormat={timeFormat}
          appointments={appointments}
          canCheckIn={canCheckIn}
          canCancel={canCancel}
          canDelete={canDelete}
          asOf={asOf}
        />
      ) : (
        <SpanListing
          slug={slug}
          status={status}
          timezone={timezone}
          timeFormat={timeFormat}
          view={view}
          appointments={appointments}
          today={today}
          onOpenDay={(date) => go('day', date)}
          canCheckIn={canCheckIn}
          canCancel={canCancel}
          canDelete={canDelete}
          asOf={asOf}
        />
      )}
    </div>
  );
}

/**
 * Where in the diary you are looking, and how much of it.
 *
 * ⚠️ ONE CONTROL, TWO AXES, AND THE ARROWS FOLLOW THE SEGMENT. The segments say
 *   how wide the window is; the arrows move that window by its own width — a
 *   day, a week, a month — so "previous" always means the obvious thing and the
 *   two halves never have to be reasoned about separately. That is also why they
 *   are one bordered group rather than two clusters with a gap: they are one
 *   answer to "which appointments am I looking at".
 *
 * ⚠️ `aria-pressed`, NOT COLOUR ALONE (WCAG 1.4.1). The selected segment is
 *   filled, and it also announces itself as pressed; the arrows carry `sr-only`
 *   text naming what they step, because "→" is not a sentence.
 *
 * The "Today" shortcut appears only when today is NOT in view. Offering it while
 * already on today is a control that does nothing, and after four taps of the
 * month arrow the walk back is the one thing the desk actually wants.
 */
/**
 * Whose list to show, typed rather than picked.
 *
 * ⚠️ IT RESOLVES A NAME TO AN ID IN THE BROWSER, AND SENDS ONLY THE ID. The
 *   roster is already here — the booking panel needs it — so matching happens
 *   against rows in hand and the URL keeps carrying `doctorProfileId=<uuid>`.
 *   No new query parameter, no name in the address bar, no round trip to work
 *   out who was meant.
 *
 * ⚠️ A `<datalist>` AND NOT A CUSTOM POPUP, for the reason `Select` gives for
 *   staying a native `<select>`: the platform's keyboard handling, type-ahead
 *   and mobile behaviour come free, and none of it has to be re-earned. The
 *   receptionist types three letters, sees the matching names, and picks one.
 *
 * ⚠️ AND IT APPLIES ON BLUR AND ENTER, NEVER PER KEYSTROKE. Each apply is a
 *   `router.push` and a server round trip; doing that on every character would
 *   fetch the day five times to answer one question.
 *
 * A name that matches nothing leaves the board unfiltered rather than emptying
 * it — an empty board reads as a quiet day, and a typo should not be able to
 * impersonate one. A name that matches SEVERAL is the same: ambiguous is not a
 * filter, and the list stays whole until the typing narrows it to one person.
 */
function DoctorFilter({
  doctors,
  selectedId,
  onSelect,
}: {
  doctors: DoctorSummary[];
  selectedId: string;
  onSelect: (doctorProfileId: string) => void;
}) {
  const selectedName = doctors.find((entry) => entry.id === selectedId)?.fullName ?? '';
  const [typed, setTyped] = useState(selectedName);

  /*
   * The URL is the truth: an arrow press, a Clear, or a shared link all change
   * `selectedId` under this box, and the text has to follow. Held rather than
   * derived because it is also what the receptionist is mid-way through typing.
   */
  const [lastSelected, setLastSelected] = useState(selectedName);
  if (lastSelected !== selectedName) {
    setLastSelected(selectedName);
    setTyped(selectedName);
  }

  /** The one doctor this text means, or null for none and for several. */
  function resolve(text: string): string | null {
    const term = text.trim().toLowerCase();
    if (term === '') return '';

    const exact = doctors.filter((entry) => entry.fullName.toLowerCase() === term);
    if (exact.length === 1) return exact[0]?.id ?? null;

    const partial = doctors.filter((entry) => entry.fullName.toLowerCase().includes(term));
    return partial.length === 1 ? (partial[0]?.id ?? null) : null;
  }

  function commit(): void {
    const next = resolve(typed);
    // Null is "I could not tell who you meant" — leave the board as it is.
    if (next === null || next === selectedId) return;
    onSelect(next);
  }

  return (
    <>
      <Input
        name="doctorFilter"
        aria-label="Doctor"
        placeholder="Doctor"
        list="board-doctor-names"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        className={cn('w-[12rem]', selectedId ? undefined : 'text-muted')}
      />
      <datalist id="board-doctor-names">
        {doctors.map((entry) => (
          <option key={entry.id} value={entry.fullName} />
        ))}
      </datalist>
    </>
  );
}

function RangeNav({
  view,
  anchor,
  range,
  today,
  onGo,
}: {
  view: BoardView;
  anchor: string;
  range: DateRange;
  today: string;
  onGo: (view: BoardView, anchor: string) => void;
}) {
  const stepWord: Record<BoardView, string> = { day: 'day', week: 'week', month: 'month' };

  return (
    <div className="flex items-center gap-2">
      {/*
        ⚠️ BEFORE THE ARROWS, AND IT APPEARS AND DISAPPEARS. "Today" only exists
          while the board is showing some other date, so wherever it sits it
          reflows its neighbours the moment somebody steps off today. On the
          right that reflow pushed the arrows themselves sideways — the control
          you had just clicked moved out from under the pointer, so a second
          press to keep stepping landed somewhere else. On the left the arrows
          and the view switcher keep their place and only the group's start
          edge moves.
      */}
      {isWithin(range, today) ? null : (
        <Button variant="secondary" size="sm" onClick={() => onGo(view, today)}>
          Today
        </Button>
      )}

      <div className="border-rule divide-rule flex divide-x overflow-hidden rounded-md border">
        <NavArrow
          label={`Previous ${stepWord[view]}`}
          glyph="←"
          onClick={() => onGo(view, stepAnchor(view, anchor, -1))}
        />
        {BOARD_VIEWS.map((option) => {
          const selected = option === view;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              /*
               * Switching view keeps the day you are on: from a week you are
               * reading, "Day" means the day that week is anchored to, not
               * today. `rangeFor` re-derives the span from it either way.
               */
              onClick={() => onGo(option, anchor)}
              className={[
                'px-3 py-1.5 text-[0.8125rem] capitalize transition-colors',
                selected
                  ? 'bg-drape text-paper'
                  : 'text-ink hover:bg-drape-tint/60 cursor-pointer bg-transparent',
              ].join(' ')}
            >
              {option}
            </button>
          );
        })}
        <NavArrow
          label={`Next ${stepWord[view]}`}
          glyph="→"
          onClick={() => onGo(view, stepAnchor(view, anchor, 1))}
        />
      </div>
    </div>
  );
}

function NavArrow({
  label,
  glyph,
  onClick,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      /* 24×24 minimum for a pointer target (WCAG 2.5.8) — an arrow glyph alone
         is about half that. */
      className="text-ink hover:bg-drape-tint/60 cursor-pointer px-3 py-1.5 text-[0.8125rem] transition-colors"
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * A week or a month: the same rail, once per day that has anything in it.
 *
 * ⚠️ EMPTY DAYS ARE OMITTED, WHICH IS THE OPPOSITE OF WHAT THE DAY VIEW DOES
 *   WITH EMPTY TIME, AND DELIBERATELY SO. Inside a day, a gap is the answer to
 *   "when can this patient come in?" and has to be drawn. Across a month, thirty
 *   "nothing booked" cards bury the eleven days that have something on them, and
 *   the question being asked is the other one — "which days are busy?". The
 *   heading counts the bookings for the same reason.
 *
 * Each heading opens that day in the day view, because the moment a week tells
 * you Thursday is full, Thursday is where you want to be.
 */
function SpanListing({
  slug,
  timezone,
  timeFormat,
  view,
  appointments,
  status,
  today,
  onOpenDay,
  canCheckIn,
  canCancel,
  canDelete,
  asOf,
}: {
  slug: string;
  timezone: string;
  timeFormat: TimeFormat;
  view: BoardView;
  appointments: AppointmentSummary[];
  /** The tally filter in force, so each day's count can name what it counted. */
  status: AppointmentStatusValue | null;
  today: string;
  onOpenDay: (date: string) => void;
  canCheckIn: boolean;
  canCancel: boolean;
  canDelete: boolean;
  asOf: string;
}) {
  // The API orders by start time, so pushing in order leaves each day's list
  // sorted and the days themselves in date order without a second sort.
  const byDay = new Map<string, AppointmentSummary[]>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.scheduledStart, timezone);
    const existing = byDay.get(key);
    if (existing === undefined) byDay.set(key, [appointment]);
    else existing.push(appointment);
  }

  if (byDay.size === 0) {
    return (
      <div className="border-rule bg-card rounded-md border p-8 text-center">
        <p className="text-ink text-[0.9375rem]">
          Nothing booked {view === 'week' ? 'this week' : 'this month'}.
        </p>
        <p className="text-muted mt-1 text-[0.8125rem]">
          Move to another {view} with the arrows, or book the first appointment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {[...byDay].map(([date, rows]) => (
        <section key={date}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <h2 className="text-ink text-[0.9375rem] font-medium">
              <button
                type="button"
                onClick={() => onOpenDay(date)}
                className="hover:text-drape cursor-pointer underline-offset-2 hover:underline"
              >
                {shortDate(date)}
              </button>
              {/* The word, not a highlight — colour is never the only carrier. */}
              {date === today ? (
                <span className="text-drape ml-2 text-[0.75rem]">Today</span>
              ) : null}
            </h2>
            {/*
              "booked" is only the right word for the unfiltered list. Under a
              Cancelled filter "3 booked" is a plain lie about three rows the
              reader can see are cancelled.
            */}
            <p className="text-muted text-[0.75rem]">
              {rows.length} {status === null ? 'booked' : STATUS_WORDS[status].toLowerCase()}
            </p>
          </div>
          <TimeRail
            slug={slug}
            timezone={timezone}
            timeFormat={timeFormat}
            appointments={rows}
            canCheckIn={canCheckIn}
            canCancel={canCancel}
            canDelete={canDelete}
            asOf={asOf}
          />
        </section>
      ))}
    </div>
  );
}

/**
 * The header tally: a Total, then every status, always.
 *
 * ⚠️ THE SHAPE IS FIXED AND ZEROES ARE RENDERED. This used to drop any status
 *   with nothing in it, which made the strip a different length on every
 *   navigation — "Booked · Arrived" one afternoon, "Booked · With the doctor ·
 *   Seen" the next — so the number you wanted was never in the same place twice,
 *   and the reading a clinic actually cares about ("how many have we not seen
 *   yet?") was invisible precisely when the answer was none. A row of seven
 *   chips in a known order is scannable; a row that reflows is not.
 *
 *   The counts are zero-filled by the API, so a `?? 0` here is belt-and-braces
 *   against a status the server has not learnt about yet, not the mechanism.
 *
 * ⚠️ `Total` IS SUMMED HERE, NOT SENT. It is the sum of the counts on screen and
 *   must stay that by construction — a separately-supplied total that disagreed
 *   with the chips beside it would be read as a bug in the board, and it would
 *   be right.
 *
 * It counts whatever the board is showing: a day, a week or a month, following
 * `range`. There is no separate period selector, deliberately — one range,
 * one set of numbers.
 *
 * ⚠️ AND IT IS THE FILTER. The numbers a clinic reads off this strip are exactly
 *   the lists it then wants to see — "four still booked" is a question about
 *   which four — so the chip that answers it is the control that shows them.
 *   Total is the unfiltered state rather than an eighth option: it is already
 *   the sum of the rest, so "all of them" and "the total" are the same idea and
 *   should not be two controls.
 *
 * ⚠️ THE COUNTS NEVER CHANGE WHEN A FILTER IS ON. They describe the range, not
 *   the visible list — a strip that collapsed to "3 Total · 3 Booked" the moment
 *   you pressed Booked would destroy the only thing it is for, and would take
 *   the way back out with it.
 *
 * ⚠️ A ZERO CHIP IS DISABLED, NOT HIDDEN. Hiding it breaks the fixed shape the
 *   comment above is about; leaving it live offers a filter whose only possible
 *   result is an empty board, which reads as a broken screen rather than as an
 *   answer.
 *
 * ⚠️ SELECTION IS NOT CARRIED BY COLOUR (WCAG 1.4.1). `aria-pressed` states it
 *   for assistive technology, the ring and weight state it visually, and the
 *   line underneath says in words which filter is on and how to clear it.
 */
function DayTally({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<string, number>;
  selected: AppointmentStatusValue | null;
  onSelect: (status: AppointmentStatusValue | null) => void;
}) {
  const statuses = Object.keys(STATUS_WORDS) as AppointmentStatusValue[];
  const total = statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  const chip = (active: boolean, enabled: boolean): string =>
    [
      'rounded-sm border px-2.5 py-1 text-[0.75rem] transition-colors',
      active
        ? 'border-drape bg-drape/10 text-ink ring-drape/40 font-medium ring-1'
        : 'border-rule bg-card text-muted',
      enabled ? 'hover:border-drape/60 cursor-pointer' : 'cursor-default opacity-60',
    ].join(' ');

  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {/*
         * Total first — the one number read at a glance — and it doubles as the
         * way back to the unfiltered board.
         */}
        <li>
          <button
            type="button"
            aria-pressed={selected === null}
            onClick={() => onSelect(null)}
            className={chip(selected === null, true)}
          >
            <span className="text-ink font-medium">{total}</span> Total
          </button>
        </li>
        {statuses.map((status) => {
          const count = counts[status] ?? 0;
          return (
            <li key={status}>
              <button
                type="button"
                disabled={count === 0}
                aria-pressed={selected === status}
                /* Pressing the active chip again clears it — a toggle, not a radio. */
                onClick={() => onSelect(selected === status ? null : status)}
                className={chip(selected === status, count > 0)}
              >
                <span className="text-ink font-medium">{count}</span> {STATUS_WORDS[status]}
              </button>
            </li>
          );
        })}
      </ul>

      {selected !== null ? (
        /*
         * ⚠️ `role="status"` SO THE CHANGE IS ANNOUNCED. Pressing a chip changes
         *   a list somewhere below it; without this, a screen-reader user gets
         *   `aria-pressed` on the button they just pressed and no statement of
         *   what happened to the board.
         */
        <p className="text-muted mt-2 text-[0.75rem]" role="status">
          Showing {STATUS_WORDS[selected].toLowerCase()} appointments only.{' '}
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-drape cursor-pointer py-1 underline underline-offset-2"
          >
            Show all {total}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The signature element: one rail, times down the left, bookings hanging off it.
 *
 * A break of more than the gap between two consecutive appointments is drawn as
 * an explicit "free" marker rather than left as whitespace, because whitespace
 * is ambiguous — it reads as either "nothing booked" or "the list ended".
 */
function TimeRail({
  slug,
  timezone,
  timeFormat,
  appointments,
  canCheckIn,
  canCancel,
  canDelete,
  asOf,
}: {
  slug: string;
  timezone: string;
  timeFormat: TimeFormat;
  appointments: AppointmentSummary[];
  canCheckIn: boolean;
  canCancel: boolean;
  canDelete: boolean;
  asOf: string;
}) {
  if (appointments.length === 0) {
    return (
      <div className="border-rule bg-card rounded-md border p-8 text-center">
        <p className="text-ink text-[0.9375rem]">Nothing booked for this day.</p>
        <p className="text-muted mt-1 text-[0.8125rem]">
          Pick a doctor and a time to make the first booking.
        </p>
      </div>
    );
  }

  return (
    <ol className="border-rule bg-card divide-rule divide-y rounded-md border">
      {appointments.map((appointment, index) => {
        const previous = appointments[index - 1];
        const gap =
          previous === undefined
            ? 0
            : (new Date(appointment.scheduledStart).getTime() -
                new Date(previous.scheduledEnd).getTime()) /
              60_000;

        return (
          <li key={appointment.id}>
            {gap > 0 ? (
              <p className="text-muted border-rule border-b border-dashed px-4 py-1.5 text-[0.75rem]">
                {gap} min free
              </p>
            ) : null}
            <AppointmentRow
              slug={slug}
              timezone={timezone}
              timeFormat={timeFormat}
              appointment={appointment}
              canCheckIn={canCheckIn}
              canCancel={canCancel}
              canDelete={canDelete}
              asOf={asOf}
            />
          </li>
        );
      })}
    </ol>
  );
}

function AppointmentRow({
  slug,
  timezone,
  timeFormat,
  appointment,
  canCheckIn,
  canCancel,
  canDelete,
  asOf,
}: {
  slug: string;
  timezone: string;
  timeFormat: TimeFormat;
  appointment: AppointmentSummary;
  canCheckIn: boolean;
  canCancel: boolean;
  canDelete: boolean;
  asOf: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);

  /*
   * Whether this slot is still ahead of us, for deciding whether to OFFER the
   * delete.
   *
   * ⚠️ MEASURED AGAINST `asOf`, WHICH THE SERVER STAMPED — not against
   *   `Date.now()`. Reading the clock in a render body is impure: the React
   *   Compiler rejects it, and rightly, because the value differs between the
   *   server render and hydration and would flip this button on any row sitting
   *   near the current minute. A prop is stable across every re-render of the
   *   same page.
   *
   *   It goes stale on a board left open, and that is fine — this only keeps a
   *   button off a row it would fail on. The check that matters is the API's,
   *   against Postgres' `now()`; a browser clock is not something to gate a
   *   deletion on.
   */
  const isFuture = appointment.scheduledStart > asOf;

  const step = NEXT_STEP[appointment.status];
  const finished =
    appointment.status === 'COMPLETED' ||
    appointment.status === 'CANCELLED' ||
    appointment.status === 'NO_SHOW';

  const run = (action: () => Promise<BookingState>) => {
    startTransition(async () => {
      const result = await action();
      setError(result.status === 'error' ? result.message : undefined);
      if (result.status !== 'error') router.refresh();
    });
  };

  return (
    /*
     * ⚠️ THE WHOLE ROW IS THE LINK, AND IT IS THE ONLY ONE ON IT. This row used
     *   to carry two: the patient's name went to the chart and the appointment
     *   number went to the visit. Both were wrong for this screen. A day board is
     *   a list of VISITS — the record is the appointment, so clicking the record
     *   opens the appointment, and the number is an identifier to read out in the
     *   waiting room rather than a control. Two competing targets a few pixels
     *   apart also meant the obvious click (the name, the biggest text on the
     *   row) took you somewhere other than the thing you were looking at.
     *
     * ⚠️ IT IS A REAL `<Link>` STRETCHED OVER THE ROW, NOT AN `onClick` ON THE
     *   `<div>`. A div with a click handler is not focusable, not announced as a
     *   link, has no href to middle-click, copy or open in a new tab, and does
     *   not work from the keyboard. The overlay keeps every one of those and
     *   costs one absolutely-positioned element.
     *
     *   Everything genuinely interactive on the row therefore has to sit ABOVE
     *   the overlay — `relative z-10` on the button cluster and on the cancel
     *   form below. A control that forgets it becomes unclickable, and the
     *   symptom is a button that silently navigates instead of acting.
     *
     * ⚠️ NO PERMISSION PROP, AND THAT IS NOT AN OMISSION. Reaching this board at
     *   all requires `appointment.read`, which is exactly what the detail page
     *   requires — so everyone who can see a row can open it. What differs
     *   between a doctor and the front desk is what that page SHOWS, and that is
     *   decided there, by permission, not by hiding the way in.
     */
    <div className="relative flex flex-wrap items-start gap-4 px-4 py-3 transition-colors hover:bg-[color-mix(in_oklab,var(--color-drape)_6%,transparent)] focus-within:bg-[color-mix(in_oklab,var(--color-drape)_6%,transparent)]">
      <Link
        href={`/appointments/${appointment.id}`}
        className="absolute inset-0 rounded-sm"
        /*
         * The row's own text is the visible label, but it is spread across three
         * elements and reads as a fragment out of context. This names the target
         * once, in full, for anybody arriving by keyboard or screen reader.
         */
        aria-label={`Open visit ${appointment.appointmentNumber} — ${appointment.patientName} with ${appointment.doctorName}`}
      >
        <span className="sr-only">Open this visit</span>
      </Link>

      {/* The rail. Tabular figures so the times line up as a column. */}
      <p className="font-mono text-ink w-16 shrink-0 text-[0.875rem] tabular-nums">
        {formatClinicTime(appointment.scheduledStart, timezone, timeFormat)}
      </p>

      <div className="min-w-48 flex-1">
        <p className="text-ink text-[0.9375rem]">
          {appointment.patientName}
          <span className="text-muted font-mono ml-2 text-[0.75rem]">{appointment.uhid}</span>
        </p>
        <p className="text-muted mt-0.5 text-[0.8125rem]">
          {appointment.doctorName} · {/* An identifier, not a control — see the row link above. */}
          <span className="font-mono">{appointment.appointmentNumber}</span> ·{' '}
          {/* ⚠️ The word, never colour alone. */}
          <span className={finished ? 'text-muted' : 'text-drape font-medium'}>
            {STATUS_WORDS[appointment.status]}
          </span>
        </p>
        {error !== undefined ? (
          <Alert tone="error" className="relative z-10 mt-2">
            {error}
          </Alert>
        ) : null}

        {cancelling ? (
          /* Above the row overlay — see the row link. */
          <div className="relative z-10">
            <CancelForm
              slug={slug}
              appointmentId={appointment.id}
              onDone={() => {
                setCancelling(false);
                router.refresh();
              }}
              onCancel={() => setCancelling(false)}
            />
          </div>
        ) : null}
      </div>

      {/* Above the stretched link, because it contains one of its own. */}
      <BillingCell liveInvoice={appointment.liveInvoice} />

      {/* Every control on the row sits above the stretched link. */}
      <div className="relative z-10 flex shrink-0 flex-wrap gap-2">
        {step && canCheckIn ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => moveAppointment(slug, appointment.id, step.to))}
          >
            {step.label}
          </Button>
        ) : null}
        {!finished && canCancel ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setCancelling((open) => !open)}>
              Cancel
            </Button>
            {/* Only offered before arrival: a patient at the desk cannot
                retrospectively not have turned up, and the API refuses it. */}
            {appointment.status === 'BOOKED' || appointment.status === 'CONFIRMED' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => markAbsent(slug, appointment.id))}
              >
                Did not attend
              </Button>
            ) : null}
          </>
        ) : null}
        {/*
         * ⚠️ A DIFFERENT ACT FROM CANCEL, AND IT MUST NOT LOOK LIKE THE SAME ONE.
         *   Cancelling records that a real appointment was called off, with a
         *   reason, and feeds the utilisation reports. This withdraws a mis-click
         *   so it never enters them. Offered only where it would actually work —
         *   a future booking nobody has confirmed — but the API is the check:
         *   it re-tests the status AND the time against the database clock, and
         *   refuses anything with a follow-up hanging off it.
         */}
        {canDelete && appointment.status === 'BOOKED' && isFuture ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (
                !confirm(
                  `Delete booking ${appointment.appointmentNumber}? This is for a booking that should never have been made — cancel it instead if the patient called off.`
                )
              ) {
                return;
              }
              run(() => deleteBooking(slug, appointment.id));
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What this visit is billed on, on the day board.
 *
 * ⚠️ THREE STATES, AND THE THIRD IS THE FIELD NOT BEING THERE. An object means
 *   billed, `null` means unbilled, and `undefined` means nobody asked — the API
 *   omits `liveInvoice` entirely for a caller without `billing.invoice.read`,
 *   because sending `null` to somebody who was never allowed to know would read
 *   as "nothing has been billed today". That is a claim, where absence is a
 *   silence. So this renders nothing at all in that case, and the column simply
 *   is not on their board.
 *
 * ⚠️ AND "BILLED" MEANS THE LIVE INVOICE. A cancelled or voided one leaves the
 *   visit unbilled and billable again, which is why a row can go back to "Not
 *   billed" after having shown a number.
 */
function BillingCell({ liveInvoice }: { liveInvoice: AppointmentSummary['liveInvoice'] }) {
  if (liveInvoice === undefined) return null;

  if (liveInvoice === null) {
    return (
      <p className="text-muted w-32 shrink-0 text-[0.8125rem]">
        Not billed
        {/* The word carries the meaning; nothing here is colour-only. */}
      </p>
    );
  }

  return (
    <p className="relative z-10 w-32 shrink-0 text-[0.8125rem]">
      <Link
        href={`/invoices/${liveInvoice.invoiceId}`}
        className="text-drape font-mono hover:underline focus-visible:underline"
      >
        {/* A draft has no number by construction. */}
        {liveInvoice.invoiceNumber ?? 'Draft'}
      </Link>
      <span className="text-ink mt-0.5 block font-mono">
        {formatMoney(money(liveInvoice.grandTotalMinor, liveInvoice.currency))}
      </span>
    </p>
  );
}

function CancelForm({
  slug,
  appointmentId,
  onDone,
  onCancel,
}: {
  slug: string;
  appointmentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(
    cancelBooking.bind(null, slug, appointmentId),
    IDLE_BOOKING
  );
  const region = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, region);

  useEffect(() => {
    if (state.status === 'booked') onDone();
  }, [state.status, onDone]);

  return (
    <form ref={region} action={action} className="mt-3 flex flex-col gap-2">
      <Input
        name="reason"
        label="Why is it being cancelled?"
        hint="The patient may ask. Recorded against the booking."
        errors={state.fieldErrors?.['reason']}
        required
      />
      {state.message !== undefined ? <Alert tone="error">{state.message}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Cancelling…' : 'Cancel the booking'}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

/**
 * Book: pick a doctor, pick a day, pick a free slot, find the patient.
 *
 * In that order on purpose. The slot is the scarce thing and the reason the
 * person is on the phone; asking for the patient first means typing a surname
 * to discover there is nothing free.
 *
 * ⚠️ THE DAY IS PART OF THE BOOKING, NOT INHERITED FROM WHAT IS ON SCREEN. It
 *   used to be exactly the board's date with no control at all, so every
 *   booking silently became a booking for whichever day happened to be showing —
 *   normally today — and "can she come in on Thursday?" had no answer on this
 *   screen. The field starts on the day being looked at and cannot go earlier
 *   than today; the diary below re-reads for whatever day is chosen, so what is
 *   offered is that doctor's actual working hours on THAT date.
 */
function BookingPanel({
  slug,
  branchId,
  initialDate,
  today,
  doctors,
  canRegisterPatient,
  timeFormat,
  onBooked,
}: {
  slug: string;
  branchId: string;
  /** The day the panel opens on — the board's day, or today if that has gone. */
  initialDate: string;
  /** The clinic's clock face, for the free-slot grid. Display only. */
  timeFormat: TimeFormat;
  /** Today in the branch's zone. The earliest day that can be booked. */
  today: string;
  doctors: DoctorSummary[];
  canRegisterPatient: boolean;
  onBooked: () => void;
}) {
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');
  const [visitType, setVisitType] = useState('NEW');
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  /*
   * ⚠️ CLAMPED HERE AS WELL AS IN THE PICKER. The picker will not offer a day
   *   that has gone, but this state is also seeded from the board's anchor,
   *   which can be any day the arrows have reached. The API refuses a past slot
   *   regardless; this keeps the diary below from showing a wall of "Gone" with
   *   no explanation.
   */
  const [date, setDate] = useState(initialDate < today ? today : initialDate);

  /*
   * ⚠️ THE DIARY AND THE PICKED SLOT ARE BOTH TAGGED WITH THE (doctor, day) THEY
   *   BELONG TO, AND "loading" IS DERIVED FROM THAT TAG RATHER THAN STORED.
   *   The obvious shape — setLoading(true); setSlot(null) at the top of the
   *   effect — is a synchronous setState inside an effect, which cascades a
   *   render and which the lint rule refuses. It is also how a stale answer
   *   wins: a slow response for yesterday landing after today's would replace
   *   the diary on screen with slots that are not in it. Comparing tags makes
   *   both problems disappear, because a response for the wrong key is simply
   *   never the one rendered.
   */
  const key = `${doctorId}|${date}`;
  const [loaded, setLoaded] = useState<{ key: string; data: AvailabilityResponse | null } | null>(
    null
  );
  const [picked, setPicked] = useState<{ key: string; slot: AvailabilitySlot } | null>(null);

  const loading = doctorId !== '' && loaded?.key !== key;
  const availability = loaded?.key === key ? loaded.data : null;
  const slot = picked?.key === key ? picked.slot : null;

  const [state, action, pending] = useActionState(bookAppointment.bind(null, slug), IDLE_BOOKING);
  const region = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, region);

  useEffect(() => {
    if (state.status === 'booked') onBooked();
  }, [state.status, onBooked]);

  useEffect(() => {
    if (doctorId === '') return;
    let live = true;
    void loadAvailability(slug, branchId, doctorId, date).then((result) => {
      if (live) setLoaded({ key, data: result });
    });
    return () => {
      live = false;
    };
  }, [slug, branchId, doctorId, date, key]);

  const doctorOptions: SelectOption[] = doctors.map((doctor) => ({
    value: doctor.id,
    label: doctor.primarySpecialty
      ? `${doctor.fullName} · ${doctor.primarySpecialty}`
      : doctor.fullName,
  }));

  return (
    <form ref={region} action={action} className="border-rule bg-card rounded-md border p-4">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="doctorProfileId" value={doctorId} />
      <input type="hidden" name="startsAt" value={slot?.startsAt ?? ''} />
      <input type="hidden" name="patientId" value={patient?.id ?? ''} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          name="doctor"
          label="Doctor"
          options={doctorOptions}
          value={doctorId}
          onChange={(event) => setDoctorId(event.target.value)}
        />
        <Select
          name="visitType"
          label="Kind of visit"
          options={VISIT_TYPES}
          value={visitType}
          onChange={(event) => setVisitType(event.target.value)}
        />
      </div>

      <FeeLine slug={slug} branchId={branchId} doctorProfileId={doctorId} visitType={visitType} />

      {/*
       * ⚠️ THE DAY IS NOT SUBMITTED, AND THE PICKER CARRIES NO `name`. The
       *   booking sends `startsAt` — the exact instant the availability engine
       *   handed back for the slot that was clicked. A date alongside it would be
       *   a second statement of the same fact that could disagree with the first,
       *   and the engine's answer is the one that was checked against the
       *   doctor's hours.
       *
       * ⚠️ AFTER THE DOCTOR AND BEFORE THE TIMES, IN THAT ORDER, BECAUSE THAT IS
       *   THE ORDER THE ANSWERS DEPEND ON EACH OTHER IN. Which days exist is a
       *   fact about the doctor; which times exist is a fact about the day.
       */}
      <div className="mt-4">
        <WorkingDayPicker
          slug={slug}
          branchId={branchId}
          doctorProfileId={doctorId}
          value={date}
          today={today}
          onChange={(next) => setDate(next < today ? today : next)}
        />
      </div>

      <fieldset className="mt-4">
        <legend className="text-ink text-[0.8125rem] font-medium">Free times</legend>
        {loading ? (
          <p className="text-muted mt-2 text-[0.8125rem]">Checking the diary…</p>
        ) : availability === null ? (
          <Alert tone="error" className="mt-2">
            The diary could not be read for this doctor.
          </Alert>
        ) : availability.notWorking ? (
          <p className="text-muted mt-2 text-[0.8125rem]">
            This doctor is not consulting here on {longDate(date)}.
          </p>
        ) : (
          <SlotGrid
            slots={availability.slots}
            timezone={availability.timezone}
            timeFormat={timeFormat}
            selected={slot}
            onPick={(next) => setPicked({ key, slot: next })}
          />
        )}
      </fieldset>

      <div className="mt-4">
        <PatientPicker
          slug={slug}
          branchId={branchId}
          chosen={patient}
          canRegister={canRegisterPatient}
          onChoose={setPatient}
        />
      </div>

      <Textarea
        name="reason"
        label="Why are they coming?"
        hint="Optional. Shown on the booking, never in the day list."
        rows={2}
        className="mt-4"
      />

      {state.message !== undefined ? (
        <Alert tone="error" className="mt-4">
          {state.message}
        </Alert>
      ) : null}

      <Button
        type="submit"
        className="mt-4"
        disabled={pending || slot === null || patient === null}
      >
        {pending ? 'Booking…' : 'Book the appointment'}
      </Button>
    </form>
  );
}

/**
 * What this visit will cost, while it is still being booked.
 *
 * ⚠️ THE QUOTE AND THE FROZEN PRICE COME FROM THE SAME FUNCTION ON THE SERVER.
 *   This calls `GET /fee-schedule/quote`, and the booking a moment later freezes
 *   that same resolution onto the appointment. A fee that nobody sees until the
 *   invoice is a quote the patient was never given — and a number computed here
 *   in the browser is how the desk says 500 and the bill says 600.
 *
 * ⚠️ AN UNPRICED VISIT IS SAID PLAINLY AND DOES NOT BLOCK THE BOOKING. A clinic
 *   that has not priced teleconsults still has to be able to book one; the
 *   cashier types the amount when the bill is raised. Silence would read as
 *   free.
 */
function FeeLine({
  slug,
  branchId,
  doctorProfileId,
  visitType,
}: {
  slug: string;
  branchId: string;
  doctorProfileId: string;
  visitType: string;
}) {
  const key = `${doctorProfileId}|${visitType}`;
  const [quote, setQuote] = useState<{ key: string; data: FeeQuote | null } | null>(null);

  useEffect(() => {
    if (doctorProfileId === '') return;
    let live = true;
    void loadFeeQuote(slug, { doctorProfileId, branchId, feeType: visitType }).then((data) => {
      if (live) setQuote({ key, data });
    });
    return () => {
      live = false;
    };
  }, [slug, branchId, doctorProfileId, visitType, key]);

  if (doctorProfileId === '') return null;

  /* Nothing yet, or an answer for a doctor who has since been changed. */
  if (quote?.key !== key) {
    return <p className="text-muted mt-3 text-[0.8125rem]">Checking the price…</p>;
  }

  if (quote.data === null) {
    return (
      <p className="text-muted mt-3 text-[0.8125rem]">
        The price could not be read. The booking still goes through.
      </p>
    );
  }

  if (quote.data.amountMinor === null) {
    return (
      <p className="text-muted mt-3 text-[0.8125rem]">
        No price is set for this kind of visit. It can still be booked — the amount is entered when
        the bill is raised.
      </p>
    );
  }

  return (
    <p className="text-ink mt-3 text-[0.9375rem]">
      This visit costs{' '}
      <span className="font-mono">
        {formatMoney(money(quote.data.amountMinor, quote.data.currency))}
      </span>
      .{' '}
      <span className="text-muted text-[0.8125rem]">
        Fixed onto the booking, so a later price change will not move it.
      </span>
    </p>
  );
}

/**
 * The slot grid.
 *
 * A taken slot is shown, disabled, with the word for why — not hidden. A grid
 * that silently omits 10:20 makes the day look shorter than it is, and the
 * front desk cannot tell "fully booked" from "not working that morning".
 * ⚠️ It never says WHO holds a slot, and the API never sends it.
 */
function SlotGrid({
  slots,
  timezone,
  timeFormat,
  selected,
  onPick,
}: {
  slots: AvailabilitySlot[];
  timezone: string;
  timeFormat: TimeFormat;
  selected: AvailabilitySlot | null;
  onPick: (slot: AvailabilitySlot) => void;
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {slots.map((slot) => {
        const chosen = selected?.startsAt === slot.startsAt;
        const word = slot.reason === null ? null : (SLOT_REASONS[slot.reason] ?? 'Not available');
        return (
          <li key={slot.startsAt}>
            <button
              type="button"
              disabled={!slot.available}
              aria-pressed={chosen}
              onClick={() => onPick(slot)}
              className={[
                'font-mono rounded-sm border px-2.5 py-2 text-[0.8125rem] tabular-nums transition-colors',
                chosen
                  ? 'border-drape bg-drape text-paper'
                  : slot.available
                    ? 'border-rule text-ink hover:border-drape hover:bg-drape-tint/60'
                    : 'border-rule text-muted bg-paper cursor-not-allowed',
              ].join(' ')}
            >
              {formatClinicTime(slot.startsAt, timezone, timeFormat)}
              {/* Colour alone never says "taken". */}
              {word === null ? null : <span className="sr-only"> — {word}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Find the patient — or register them, right here, and carry on booking.
 *
 * ⚠️ A SERVER ACTION, NEVER A NAVIGATION. The term is somebody's surname, and a
 *   query parameter puts it in browser history, the next referrer and every
 *   proxy log in between. This is the same rule the patients screen is built
 *   around; it does not relax because the search is inside a panel.
 *
 * ⚠️ THERE IS NO <form> IN HERE, AND THAT IS THE BUG THIS REPLACED. It used to
 *   be a `<form action={lookup}>` sitting INSIDE the booking form. Nested forms
 *   are invalid HTML: the parser drops the inner tag and re-parents its children
 *   onto the outer form, so the "Find" button — a submit button, now belonging
 *   to the booking form — submitted the BOOKING on every click and the search
 *   never ran. The markup read plausibly and typechecked, which is why it
 *   survived; the comment above it even claimed it was not a nested form.
 *
 *   So: no form, plain fields, and buttons that call the action themselves.
 *   Enter is caught in the field and routed to the lookup rather than being left
 *   to submit a booking with no patient on it.
 *
 * ⚠️ THE WALK-IN IS REGISTERED WITHOUT LEAVING THIS PANEL. Someone at the desk
 *   with no record was previously a dead end — "register them first, then book"
 *   meant another screen, a long form, and a walk back to a slot that may have
 *   gone. Registration IS the same call the patients screen makes, behind the
 *   same permission; what is shorter is the form, not the record. Everything the
 *   short form omits is an edit somebody can make later, when they are not
 *   holding up a queue.
 */
function PatientPicker({
  slug,
  branchId,
  chosen,
  canRegister,
  onChoose,
}: {
  slug: string;
  branchId: string;
  chosen: PatientSummary | null;
  canRegister: boolean;
  /** `null` clears the choice — "Change" is the same control as "pick". */
  onChoose: (patient: PatientSummary | null) => void;
}) {
  const [term, setTerm] = useState('');
  const [state, setState] = useState<LookupState>(IDLE_LOOKUP);
  const [pending, startTransition] = useTransition();
  const [registering, setRegistering] = useState(false);

  const find = () => {
    const asked = term.trim();
    if (asked.length < 2) {
      setState({
        status: 'error',
        message: 'Type at least two characters — part of a name, a phone number or the UHID.',
        patients: [],
      });
      return;
    }
    startTransition(async () => {
      setRegistering(false);
      setState(await lookupPatients(slug, asked));
    });
  };

  if (chosen !== null) {
    return (
      <div className="border-rule bg-paper flex flex-wrap items-center justify-between gap-3 rounded-sm border px-3 py-2">
        <p className="text-ink text-[0.875rem]">
          {chosen.fullName}
          <span className="text-muted font-mono ml-2 text-[0.75rem]">{chosen.uhid}</span>
          <span className="text-muted ml-2 text-[0.75rem]">{identityLine(chosen)}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={() => onChoose(null)}>
          Change
        </Button>
      </div>
    );
  }

  const nobodyMatched = state.status === 'done' && state.patients.length === 0;

  return (
    <div>
      {/*
       * ⚠️ THE HINT IS OUTSIDE THE ROW, NOT ON THE FIELD, AND THAT IS WHAT MAKES
       *   THE BUTTON LINE UP. `Field` renders its hint INSIDE the wrapper, below
       *   the control — so a field with a hint is a line taller than its own box,
       *   and `items-end` dutifully aligned "Find" to the bottom of the hint
       *   instead of the bottom of the input. The search form on /patients was
       *   fixed the same way; this is that fix, applied to the panel that missed
       *   it. `fieldClassName` (the wrapper), not `className` (the input), is
       *   what makes the field take the free width.
       */}
      <div className="flex flex-wrap items-end gap-3">
        <Input
          id="patientLookup"
          type="search"
          label="Patient"
          autoComplete="off"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            /* Enter means "find", never "book" — see the header. */
            if (event.key === 'Enter') {
              event.preventDefault();
              find();
            }
          }}
          fieldClassName="min-w-[14rem] flex-1"
          aria-describedby="patientLookup-note"
        />
        <Button type="button" variant="secondary" onClick={find} disabled={pending}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </div>
      <p id="patientLookup-note" className="text-muted mt-1.5 text-[0.8125rem] leading-snug">
        Name, phone or UHID. Searched at this clinic.
      </p>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' && state.patients.length > 0 ? (
        <ul className="border-rule divide-rule mt-2 divide-y rounded-sm border">
          {state.patients.map((patient) => (
            <li key={patient.id}>
              <button
                type="button"
                onClick={() => onChoose(patient)}
                className="hover:bg-drape-tint/40 flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="text-ink text-[0.875rem]">
                  {patient.fullName}
                  <span className="text-muted ml-2 text-[0.75rem]">{identityLine(patient)}</span>
                </span>
                <span className="text-muted font-mono text-[0.75rem]">{patient.uhid}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
       * Registering is offered in two places, because "not here" arrives in two
       * ways: nobody matched at all, or three people matched and none of them is
       * the person standing at the desk.
       */}
      {nobodyMatched && !registering ? (
        canRegister ? (
          <div className="border-rule mt-2 rounded-sm border border-dashed px-3 py-3">
            <p className="text-ink text-[0.875rem]">Nobody matched.</p>
            <p className="text-muted mt-0.5 text-[0.8125rem]">
              Register them now and the booking carries straight on.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => setRegistering(true)}
            >
              Register this patient
            </Button>
          </div>
        ) : (
          <p className="text-muted mt-2 text-[0.8125rem]">
            Nobody matched, and you cannot register a patient here. Ask the front desk to create the
            record first.
          </p>
        )
      ) : null}

      {state.status === 'done' && state.patients.length > 0 && canRegister && !registering ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => setRegistering(true)}
        >
          None of these — register a new patient
        </Button>
      ) : null}

      {registering && canRegister ? (
        <QuickRegister
          slug={slug}
          branchId={branchId}
          term={state.term ?? term}
          onRegistered={(patient) => {
            setRegistering(false);
            onChoose(patient);
          }}
          onCancel={() => setRegistering(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * "34 · Female · 98765 43210" — enough to tell two similar names apart.
 *
 * The phone is here because it is what the desk actually confirms against when
 * two records read "R. Kumar". It is already on `patientSummary`, which is the
 * deliberately narrow list row — no address, no email, no ID.
 */
function identityLine(patient: PatientSummary): string {
  return patient.phone === null ? ageLine(patient) : `${ageLine(patient)} · ${patient.phone}`;
}

/**
 * Register the person standing at the desk, in the panel that is booking them.
 *
 * ⚠️ SIX FIELDS, AND THE SHORT LIST IS THE DESIGN. This is the walk-in path: the
 *   full registration form asks for an address, an ID document, next of kin and
 *   a blood group, all of which are worth having and none of which is worth a
 *   queue. `POST /patients` requires a first name and a branch and nothing else,
 *   so that is what is asked — the record is complete enough to be a record, and
 *   `/patients/<id>` is where the rest gets filled in.
 *
 * ⚠️ NOT A <form>, FOR THE REASON THE PICKER ABOVE EXISTS — it would be nested
 *   inside the booking form. The inputs deliberately carry `id` and no `name`,
 *   so nothing here can be swept into the booking's own submission, and Enter is
 *   caught and routed to this button instead.
 *
 * The org-wide duplicate check still runs at the API. If this person turns out to
 * be registered already, the registration is refused and the API's own sentence
 * is what the desk reads — the answer then is to search again, not to force a
 * second record for the same human being.
 */
function QuickRegister({
  slug,
  branchId,
  term,
  onRegistered,
  onCancel,
}: {
  slug: string;
  branchId: string;
  /** What was searched for. A phone number seeds the phone, a word the name. */
  term: string;
  onRegistered: (patient: PatientSummary) => void;
  onCancel: () => void;
}) {
  const seededPhone = looksLikePhone(term);
  const [firstName, setFirstName] = useState(seededPhone ? '' : term);
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState(seededPhone ? term : '');
  const [gender, setGender] = useState('UNKNOWN');
  const [age, setAge] = useState('');
  const [state, setState] = useState<QuickRegisterState>(IDLE_REGISTER);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      const years = age.trim() === '' ? undefined : Number(age);
      const result = await registerAndPick(slug, branchId, {
        firstName: firstName.trim(),
        ...(lastName.trim() === '' ? {} : { lastName: lastName.trim() }),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        gender,
        ...(years !== undefined && Number.isFinite(years) ? { approxAgeYears: years } : {}),
      });
      setState(result);
      if (result.status === 'created' && result.patient !== undefined) onRegistered(result.patient);
    });
  };

  /* Enter anywhere in this block registers, rather than submitting the booking
     that this block is sitting inside. */
  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const errors = (field: string): string[] | undefined => state.fieldErrors?.[field];

  return (
    <div className="border-drape bg-drape-tint/30 mt-3 rounded-sm border p-3">
      <p className="text-ink text-[0.875rem] font-medium">New patient</p>
      <p className="text-muted mt-0.5 text-[0.8125rem]">
        Enough to book. The address, ID and next of kin can be added to the record afterwards.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input
          id="walkInFirstName"
          label="First name"
          autoComplete="off"
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
          onKeyDown={onEnter}
          {...(errors('firstName') ? { errors: errors('firstName') } : {})}
        />
        <Input
          id="walkInLastName"
          label="Last name"
          autoComplete="off"
          value={lastName}
          onChange={(event) => setLastName(event.target.value)}
          onKeyDown={onEnter}
          {...(errors('lastName') ? { errors: errors('lastName') } : {})}
        />
        <Input
          id="walkInPhone"
          label="Mobile"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          onKeyDown={onEnter}
          {...(errors('phone') ? { errors: errors('phone') } : {})}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            id="walkInGender"
            label="Sex"
            options={GENDERS}
            value={gender}
            onChange={(event) => setGender(event.target.value)}
          />
          <Input
            id="walkInAge"
            label="Age"
            type="number"
            inputMode="numeric"
            min={0}
            max={130}
            autoComplete="off"
            value={age}
            onChange={(event) => setAge(event.target.value)}
            onKeyDown={onEnter}
            {...(errors('approxAgeYears') ? { errors: errors('approxAgeYears') } : {})}
          />
        </div>
      </div>
      {/*
       * ⚠️ AN AGE, NOT A DATE OF BIRTH, ON THIS FORM. A walk-in usually knows one
       *   and not the other, and `patients` carries a CHECK constraint that
       *   refuses both at once — so the short form asks for the one that is
       *   always answerable and the record page takes the exact date later.
       */}
      <p className="text-muted mt-1.5 text-[0.8125rem]">
        An approximate age is fine. A date of birth can be recorded on the patient&rsquo;s file.
      </p>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-3">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={pending || firstName.trim() === ''}
        >
          {pending ? 'Registering…' : 'Register and use'}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Whether what was typed into the lookup was a phone number.
 *
 * Only decides which box of the short form it seeds, so being wrong costs a
 * retype and nothing else. Digits, spaces and hyphens with an optional leading
 * `+`, which is what `contactPhone` accepts at the counter.
 */
function looksLikePhone(term: string): boolean {
  return /^[+0-9][0-9\s-]{5,}$/.test(term.trim());
}
