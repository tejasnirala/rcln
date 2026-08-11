import type { Metadata } from 'next';
import type { DoctorListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { AppointmentBoard } from '@/components/tenant/appointment-board';
import { isCalendarDate, rangeFor, toBoardView, todayIn } from '@/lib/calendar-range';
import { loadDay } from './actions';

export const metadata: Metadata = {
  /**
   * ⚠️ NEVER A PATIENT'S NAME, and never the clinic's either. A browser tab
   *   title is read over a shoulder, screenshotted into a support ticket and
   *   saved into browser history. The patient chart follows the same rule.
   */
  title: 'Appointments',
};

/**
 * <slug>.rcln.com/appointments?date=YYYY-MM-DD
 *
 * ⚠️ UNLIKE /patients, THIS PAGE DOES LOAD ITS ROWS, and the difference is
 *   deliberate. A patient list is a lookup — rendering twenty records on
 *   navigation discloses twenty people to answer a question nobody asked. A day
 *   board is the opposite: it is the screen the front desk works from, it is
 *   bounded by one day at one branch, and the API writes no `data_access_logs`
 *   row for it precisely because polling it would drown the reads that matter.
 *
 * The date and the view live in the URL so the board is linkable and
 * refreshable. That is safe for the same reason the patient search term is not:
 * a date discloses nobody, and neither does "week".
 */
export default async function AppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; view?: string; doctorProfileId?: string }>;
}) {
  const { slug } = await params;
  const { date, view: rawView, doctorProfileId: rawDoctor } = await searchParams;
  const accessToken = await getAccessToken();

  const [doctors, session] = await Promise.all([
    api<DoctorListResponse>('/api/v1/doctors', { slug, accessToken }),
    getSession(slug),
  ]);

  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.APPOINTMENT_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the appointment diary here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  /*
   * The branch the session is scoped to, falling back to the first one in
   * scope. A caller with several branches switches with the existing scope
   * switcher in the header rather than a second picker on this screen.
   *
   * ⚠️ FROM THE SESSION, NOT FROM `GET /branches`. This used to call that
   *   endpoint, which is behind `branch.read` — a permission only the org-wide
   *   roles and BRANCH_ADMIN hold, because it opens the branch MANAGEMENT
   *   screen. So for a receptionist or a doctor the call 403'd, the list fell
   *   back to empty, and this page told the person whose main screen it is that
   *   they had no clinic. The session's `memberships[].branches` is the
   *   authoritative statement of what a caller may work in — it is what the
   *   header's own branch switcher renders — and it needs no permission,
   *   because being told the branches you already have access to discloses
   *   nothing you did not have.
   */
  const inScope = await branchesInScope(slug);
  const branch = inScope.find((b) => b.id === session?.activeBranchId) ?? inScope[0];

  if (branch === undefined) {
    return <Alert tone="info">No clinic is in scope for you yet. Ask an administrator.</Alert>;
  }

  /*
   * ⚠️ "TODAY" IS THE BRANCH'S TODAY, NOT THE CONTAINER'S. This used to be
   *   `new Date().toISOString().slice(0, 10)`, which is today in UTC — so from
   *   half past five in the evening IST onwards the board opened on YESTERDAY
   *   for every clinic in India, with no clue on screen that it had. The zone is
   *   the one the branch keeps its diary in, and it is resolved once here so the
   *   board, the range arithmetic and the booking panel's earliest bookable day
   *   all agree on which day it is.
   */
  const today = todayIn(branch.timezone);

  /*
   * A bad `?date=` or `?view=` is treated as today / the day view rather than as
   * an error. It is a URL anybody can edit, and a 400 on a hand-typed date helps
   * nobody.
   */
  const view = toBoardView(rawView);
  const anchor = isCalendarDate(date) ? date : today;
  const range = rangeFor(view, anchor);

  const roster = doctors.ok && doctors.data ? doctors.data.doctors : [];

  /*
   * ⚠️ CHECKED AGAINST THE ROSTER RATHER THAN TRUSTED. A hand-edited
   *   `?doctorProfileId=` that names nobody at this branch would otherwise reach
   *   the API as a filter matching nothing, and an empty board reads as a quiet
   *   day rather than as a bad URL. Unknown means unfiltered — the same
   *   forgiving treatment a bad `?date=` already gets above.
   *
   *   It is safe in the URL for the same reason the date is: a uuid names a
   *   clinician, not a patient, and it is what makes "Dr Rao's Tuesday" a link
   *   somebody can send.
   */
  const doctorProfileId =
    rawDoctor !== undefined && roster.some((entry) => entry.id === rawDoctor)
      ? rawDoctor
      : undefined;

  const board = await loadDay(slug, branch.id, range.from, range.to, doctorProfileId);

  return (
    <AppointmentBoard
      slug={slug}
      branchId={branch.id}
      branchName={branch.name}
      timezone={branch.timezone}
      /*
       * ⚠️ THE BRANCH'S CLOCK FACE, NOT A CONSTANT AND NOT THE READER'S. It rides
       *   on the session beside `timezone` for the same reason that does: this
       *   board is the front desk's main screen and they hold no settings
       *   permission, so fetching `locale.time_format` from `GET /settings` here
       *   would 403. Display only — every instant is UTC on the wire.
       */
      timeFormat={branch.timeFormat}
      view={view}
      anchor={anchor}
      doctorProfileId={doctorProfileId ?? ''}
      range={range}
      today={today}
      day={board}
      // A secondary 403 degrades to an empty picker rather than erroring the page.
      doctors={roster}
      /*
       * ⚠️ AND WITH A ROSTER TO BOOK AGAINST. A doctor holds `appointment.create`
       *   but not `doctor.directory.read`, so `/doctors` answers 403 for them and
       *   `roster` is empty — offering them a booking panel whose only picker has
       *   nothing in it is a dead end with no explanation. The permission is
       *   still the gate; this is the difference between a control being absent
       *   and a control being useless.
       */
      canBook={permissions.includes(PERMISSIONS.APPOINTMENT_CREATE) && roster.length > 0}
      /*
       * ⚠️ THE SAME PERMISSION THE REGISTRATION SCREEN IS BEHIND, not a lighter
       *   one. Registering the walk-in from inside the booking panel is the same
       *   act as registering them on /patients — same endpoint, same UHID, same
       *   duplicate check — so it asks the same code. Without it the panel still
       *   books, it just cannot create.
       */
      canRegisterPatient={permissions.includes(PERMISSIONS.PATIENT_CREATE)}
      canCheckIn={permissions.includes(PERMISSIONS.APPOINTMENT_CHECKIN)}
      canCancel={permissions.includes(PERMISSIONS.APPOINTMENT_CANCEL)}
      /* A different code from cancel, deliberately — see APPOINTMENT_DELETE. */
      canDelete={permissions.includes(PERMISSIONS.APPOINTMENT_DELETE)}
      /*
       * Stamped here so the board can tell a future booking from a past one
       * without reading a clock during render, which is impure and differs
       * between the server pass and hydration. It only decides which rows offer
       * a delete; the API re-checks against Postgres' own `now()`.
       */
      asOf={new Date().toISOString()}
    />
  );
}
