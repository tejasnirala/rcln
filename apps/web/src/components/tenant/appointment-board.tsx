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
  PatientSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  bookAppointment,
  cancelBooking,
  loadAvailability,
  lookupPatients,
  markAbsent,
  moveAppointment,
  type BookingState,
  type LookupState,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

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

/**
 * The clock face for one instant, in the branch's timezone.
 *
 * ⚠️ THE TIMEZONE IS THE BRANCH'S, NOT THE BROWSER'S. A receptionist working
 *   remotely, or a laptop left on the wrong zone, would otherwise read every
 *   appointment shifted — and the times would look perfectly plausible. The API
 *   returns the branch's zone with the day precisely so this can be pinned.
 */
function clock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

/** `YYYY-MM-DD` shifted by whole days, without touching the browser's zone. */
function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

// ---------------------------------------------------------------------------

export function AppointmentBoard({
  slug,
  branchId,
  branchName,
  timezone,
  date,
  day,
  doctors,
  canBook,
  canCheckIn,
  canCancel,
}: {
  slug: string;
  branchId: string;
  branchName: string;
  timezone: string;
  date: string;
  day: AppointmentListResponse | null;
  doctors: DoctorSummary[];
  canBook: boolean;
  canCheckIn: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [booking, setBooking] = useState(false);

  const goToDate = (next: string) => {
    router.push(`/t/${slug}/appointments?date=${next}`);
  };

  const appointments = day?.appointments ?? [];
  const counts = day?.counts;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-2xl tracking-tight">{longDate(date)}</h1>
          <p className="text-muted mt-1 text-[0.8125rem]">
            {branchName} · times shown in {timezone.replace('_', ' ')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => goToDate(shiftDate(date, -1))}>
            <span aria-hidden="true">←</span>
            <span className="sr-only">Previous day</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => goToDate(new Date().toISOString().slice(0, 10))}
          >
            Today
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goToDate(shiftDate(date, 1))}>
            <span aria-hidden="true">→</span>
            <span className="sr-only">Next day</span>
          </Button>
          {canBook ? (
            <Button size="sm" onClick={() => setBooking((open) => !open)} aria-expanded={booking}>
              {booking ? 'Close' : 'Book an appointment'}
            </Button>
          ) : null}
        </div>
      </header>

      {counts ? <DayTally counts={counts} /> : null}

      {booking && canBook ? (
        <BookingPanel
          slug={slug}
          branchId={branchId}
          date={date}
          doctors={doctors}
          onBooked={() => {
            setBooking(false);
            router.refresh();
          }}
        />
      ) : null}

      {day === null ? (
        <Alert tone="error">The day could not be loaded. Try again in a moment.</Alert>
      ) : (
        <TimeRail
          slug={slug}
          timezone={timezone}
          appointments={appointments}
          canCheckIn={canCheckIn}
          canCancel={canCancel}
        />
      )}
    </div>
  );
}

/**
 * The header tally.
 *
 * Only the statuses with something in them are rendered — a row of zeroes is
 * noise — but the underlying counts are zero-filled by the API, so a status
 * dropping to zero removes its chip rather than leaving a stale one behind.
 */
function DayTally({ counts }: { counts: Record<string, number> }) {
  const shown = (Object.keys(STATUS_WORDS) as AppointmentStatusValue[]).filter(
    (status) => (counts[status] ?? 0) > 0
  );
  if (shown.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map((status) => (
        <li
          key={status}
          className="border-rule bg-card text-muted rounded-sm border px-2.5 py-1 text-[0.75rem]"
        >
          <span className="text-ink font-medium">{counts[status]}</span> {STATUS_WORDS[status]}
        </li>
      ))}
    </ul>
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
  appointments,
  canCheckIn,
  canCancel,
}: {
  slug: string;
  timezone: string;
  appointments: AppointmentSummary[];
  canCheckIn: boolean;
  canCancel: boolean;
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
              appointment={appointment}
              canCheckIn={canCheckIn}
              canCancel={canCancel}
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
  appointment,
  canCheckIn,
  canCancel,
}: {
  slug: string;
  timezone: string;
  appointment: AppointmentSummary;
  canCheckIn: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);

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
    <div className="flex flex-wrap items-start gap-4 px-4 py-3">
      {/* The rail. Tabular figures so the times line up as a column. */}
      <p className="font-mono text-ink w-16 shrink-0 text-[0.875rem] tabular-nums">
        {clock(appointment.scheduledStart, timezone)}
      </p>

      <div className="min-w-48 flex-1">
        <p className="text-ink text-[0.9375rem]">
          <Link
            href={`/t/${slug}/patients/${appointment.patientId}`}
            className="hover:text-drape underline-offset-2 hover:underline"
          >
            {appointment.patientName}
          </Link>
          <span className="text-muted font-mono ml-2 text-[0.75rem]">{appointment.uhid}</span>
        </p>
        <p className="text-muted mt-0.5 text-[0.8125rem]">
          {appointment.doctorName} · {appointment.appointmentNumber} ·{' '}
          {/* ⚠️ The word, never colour alone. */}
          <span className={finished ? 'text-muted' : 'text-drape font-medium'}>
            {STATUS_WORDS[appointment.status]}
          </span>
        </p>
        {error !== undefined ? (
          <Alert tone="error" className="mt-2">
            {error}
          </Alert>
        ) : null}

        {cancelling ? (
          <CancelForm
            slug={slug}
            appointmentId={appointment.id}
            onDone={() => {
              setCancelling(false);
              router.refresh();
            }}
            onCancel={() => setCancelling(false)}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
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
      </div>
    </div>
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
 * Book: pick a doctor, pick a free slot, find the patient.
 *
 * In that order on purpose. The slot is the scarce thing and the reason the
 * person is on the phone; asking for the patient first means typing a surname
 * to discover there is nothing free.
 */
function BookingPanel({
  slug,
  branchId,
  date,
  doctors,
  onBooked,
}: {
  slug: string;
  branchId: string;
  date: string;
  doctors: DoctorSummary[];
  onBooked: () => void;
}) {
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');
  const [patient, setPatient] = useState<PatientSummary | null>(null);

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
        <Select name="visitType" label="Kind of visit" options={VISIT_TYPES} defaultValue="NEW" />
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
            selected={slot}
            onPick={(next) => setPicked({ key, slot: next })}
          />
        )}
      </fieldset>

      <div className="mt-4">
        <PatientPicker slug={slug} chosen={patient} onChoose={setPatient} />
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
  selected,
  onPick,
}: {
  slots: AvailabilitySlot[];
  timezone: string;
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
                  ? 'border-drape bg-drape text-white'
                  : slot.available
                    ? 'border-rule text-ink hover:border-drape hover:bg-drape-tint/60'
                    : 'border-rule text-muted bg-paper cursor-not-allowed',
              ].join(' ')}
            >
              {clock(slot.startsAt, timezone)}
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
 * Find the patient.
 *
 * ⚠️ A SERVER ACTION, NEVER A NAVIGATION. The term is somebody's surname, and a
 *   query parameter puts it in browser history, the next referrer and every
 *   proxy log in between. This is the same rule the patients screen is built
 *   around; it does not relax because the search is inside a panel.
 */
function PatientPicker({
  slug,
  chosen,
  onChoose,
}: {
  slug: string;
  chosen: PatientSummary | null;
  /** `null` clears the choice — "Change" is the same control as "pick". */
  onChoose: (patient: PatientSummary | null) => void;
}) {
  const [state, action, pending] = useActionState(lookupPatients.bind(null, slug), IDLE_LOOKUP);

  if (chosen !== null) {
    return (
      <div className="border-rule bg-paper flex items-center justify-between rounded-sm border px-3 py-2">
        <p className="text-ink text-[0.875rem]">
          {chosen.fullName}
          <span className="text-muted font-mono ml-2 text-[0.75rem]">{chosen.uhid}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={() => onChoose(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div>
      {/*
        A nested <form> is invalid HTML, so this is a plain field plus a button
        that calls the action — the booking form is the outer one. Enter inside
        this field would otherwise submit the booking with no patient chosen.
      */}
      <form action={action} className="flex items-end gap-2">
        <Input
          name="q"
          label="Patient"
          hint="Name, phone or UHID. Searched at this clinic."
          className="flex-1"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </form>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' ? (
        state.patients.length === 0 ? (
          <p className="text-muted mt-2 text-[0.8125rem]">
            Nobody matched. Register them first, then book.
          </p>
        ) : (
          <ul className="border-rule divide-rule mt-2 divide-y rounded-sm border">
            {state.patients.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => onChoose(patient)}
                  className="hover:bg-drape-tint/40 flex w-full items-center justify-between px-3 py-2 text-left"
                >
                  <span className="text-ink text-[0.875rem]">{patient.fullName}</span>
                  <span className="text-muted font-mono text-[0.75rem]">{patient.uhid}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
