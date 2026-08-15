'use client';

import { useActionState, useEffect, useState } from 'react';
import type { AvailabilitySlot, TimeFormat } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { SlotGrid } from '@/components/tenant/appointment-board';
import { WorkingDayPicker } from '@/components/tenant/working-day-picker';
import { formatClinicDate, formatClinicTime } from '@/lib/format';
import {
  bookFollowUp,
  loadAvailability,
  type BookingState,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

/**
 * Book the next visit in the same chain (CE-5).
 *
 * The action and the API have taken `fulfilsRecommendationId` since CE-4 and
 * nothing sent one, because this form did not exist. It does two jobs and they
 * are the same job: the doctor books the review at the end of the consultation,
 * and the front desk books it off the recall list weeks later. Both post to
 * `POST /appointments/:id/follow-up` against the RECOMMENDING appointment.
 *
 * ⚠️ THE TIME COMES FROM THE AVAILABILITY ENGINE, NEVER FROM A `datetime-local`.
 *   That control hands back a wall-clock string with no zone attached, so
 *   turning it into an instant means guessing whose clock it was — the
 *   browser's, in practice, which is the container's UTC on a server-rendered
 *   page. Every slot here is an exact instant the engine already decided is
 *   free, which is also the only way the GiST no-overlap constraint can be
 *   satisfied without a race. Same rule as the booking panel (invariant 6).
 *
 * ⚠️ ONLY THE TIME COMES FROM THIS FORM. The patient and the branch are read off
 *   the parent booking by the API and cannot be sent from here — which is what
 *   stops a follow-up quietly becoming a booking for somebody else.
 *
 * ⚠️ NO PATIENT NAME IN ANY COPY ON THIS COMPONENT, including the confirmation.
 *   It renders inside a recall list that is already a list of named people; the
 *   form itself says "this patient" and the row above it says who.
 */

const EMPTY: BookingState = { status: 'idle' };

export function FollowUpForm({
  slug,
  /** The visit being followed up — the API reads patient and branch off it. */
  sourceAppointmentId,
  branchId,
  doctorProfileId,
  doctorName,
  timezone,
  timeFormat,
  /** Today in the BRANCH's zone, resolved on the server. Never `new Date()`. */
  today,
  /**
   * The recommendation this booking satisfies (CD-13).
   *
   * ⚠️ OPTIONAL IN BOTH DIRECTIONS AND NEITHER ABSENCE IS AN ERROR. A patient
   *   may book a follow-up nobody recommended, and a recommendation may never be
   *   booked at all — the second is the entire recall list.
   */
  fulfilsRecommendationId,
  /** What the doctor asked for, so the desk books the right distance out. */
  recommendedFor,
  onBooked,
}: {
  slug: string;
  sourceAppointmentId: string;
  branchId: string;
  doctorProfileId: string;
  doctorName: string;
  timezone: string;
  timeFormat: TimeFormat;
  today: string;
  fulfilsRecommendationId?: string | undefined;
  recommendedFor?: string | undefined;
  onBooked?: (() => void) | undefined;
}) {
  const [date, setDate] = useState(today);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);

  /*
   * ⚠️ THE ANSWER IS TAGGED WITH THE DAY IT WAS ASKED FOR, and "loading" is
   *   derived from that tag rather than stored. The booking panel and the
   *   working-day picker both do this and both record why: a `setLoading(true)`
   *   at the top of an effect is a synchronous setState inside an effect, and a
   *   slow answer for Tuesday landing after Wednesday's would paint the wrong
   *   day's slots. Comparing tags makes a reply for the wrong key simply never
   *   the one rendered.
   */
  const key = `${doctorProfileId}|${date}`;
  const [loaded, setLoaded] = useState<{ key: string; slots: AvailabilitySlot[] } | null>(null);
  const loading = loaded?.key !== key;
  const slots = loaded?.key === key ? loaded.slots : [];

  useEffect(() => {
    let live = true;
    void loadAvailability(slug, branchId, doctorProfileId, date).then((result) => {
      if (live) setLoaded({ key, slots: result?.slots ?? [] });
    });
    return () => {
      live = false;
    };
  }, [slug, branchId, doctorProfileId, date, key]);

  const [state, action, pending] = useActionState(
    bookFollowUp.bind(null, slug, sourceAppointmentId),
    EMPTY
  );

  useEffect(() => {
    if (state.status === 'booked') onBooked?.();
  }, [state.status, onBooked]);

  if (state.status === 'booked') {
    return (
      <Alert tone="success">
        Booked as{' '}
        <span className="font-mono">{state.appointmentNumber ?? 'the next appointment'}</span>.
      </Alert>
    );
  }

  return (
    <form action={action} className="mt-3">
      {/* The instant, not a wall clock. See the component note. */}
      <input type="hidden" name="startsAt" value={slot?.startsAt ?? ''} />
      {fulfilsRecommendationId === undefined ? null : (
        <input type="hidden" name="fulfilsRecommendationId" value={fulfilsRecommendationId} />
      )}

      {recommendedFor === undefined ? null : (
        <p className="text-muted text-[0.8125rem]">The doctor asked for {recommendedFor}.</p>
      )}

      <p className="text-muted mt-2 text-[0.8125rem]">
        With {doctorName} · times at {timezone.replace('_', ' ')}
      </p>

      <div className="mt-3">
        <WorkingDayPicker
          slug={slug}
          branchId={branchId}
          doctorProfileId={doctorProfileId}
          value={date}
          today={today}
          onChange={(next) => {
            setDate(next);
            setSlot(null);
          }}
        />
      </div>

      <div className="mt-3">
        {/* The day itself is named by the picker above; this labels the grid. */}
        <p className="eyebrow text-drape">What is free</p>
        {loading ? (
          <p className="text-muted mt-2 text-[0.8125rem]">Checking what is free…</p>
        ) : slots.length === 0 ? (
          <p className="text-muted mt-2 text-[0.8125rem]">
            {doctorName} does not consult on this day. Pick another.
          </p>
        ) : (
          <SlotGrid
            slots={slots}
            timezone={timezone}
            timeFormat={timeFormat}
            selected={slot}
            onPick={setSlot}
          />
        )}
      </div>

      <Textarea
        name="reason"
        label="Why they are coming back"
        hint="Optional. It appears on the booking, not on the clinical record."
        rows={2}
        className="mt-3"
        {...(state.fieldErrors?.['reason'] !== undefined
          ? { errors: state.fieldErrors['reason'] }
          : {})}
      />

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-3">
          {state.message ?? 'The follow-up could not be booked.'}
        </Alert>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" disabled={pending || slot === null}>
          {pending ? 'Booking…' : 'Book the follow-up'}
        </Button>
        {slot === null ? (
          <span className="text-muted text-[0.8125rem]">Pick a time above.</span>
        ) : (
          <span className="text-muted text-[0.8125rem]">
            {formatClinicDate(slot.startsAt, timezone)} at{' '}
            {formatClinicTime(slot.startsAt, timezone, timeFormat)}
          </span>
        )}
      </div>
    </form>
  );
}
