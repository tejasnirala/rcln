import type { Metadata } from 'next';
import type { BranchListResponse, DoctorListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { AppointmentBoard } from '@/components/tenant/appointment-board';
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
 * The date lives in the URL so the board is linkable and refreshable. That is
 * safe for the same reason the patient search term is not: a date discloses
 * nobody.
 */
export default async function AppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { slug } = await params;
  const { date } = await searchParams;
  const accessToken = await getAccessToken();

  const [branches, doctors, session] = await Promise.all([
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
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
   */
  const inScope = branches.ok && branches.data ? branches.data.branches : [];
  const branch = inScope.find((b) => b.id === session?.activeBranchId) ?? inScope[0];

  if (branch === undefined) {
    return <Alert tone="info">No clinic is in scope for you yet. Ask an administrator.</Alert>;
  }

  /*
   * A bad `?date=` is treated as today rather than as an error. It is a URL
   * anybody can edit, and a 400 on a hand-typed date helps nobody.
   */
  const requested = date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const day = requested ?? new Date().toISOString().slice(0, 10);

  const board = await loadDay(slug, branch.id, day);

  return (
    <AppointmentBoard
      slug={slug}
      branchId={branch.id}
      branchName={branch.name}
      timezone={branch.timezone}
      date={day}
      day={board}
      // A secondary 403 degrades to an empty picker rather than erroring the page.
      doctors={doctors.ok && doctors.data ? doctors.data.doctors : []}
      canBook={permissions.includes(PERMISSIONS.APPOINTMENT_CREATE)}
      canCheckIn={permissions.includes(PERMISSIONS.APPOINTMENT_CHECKIN)}
      canCancel={permissions.includes(PERMISSIONS.APPOINTMENT_CANCEL)}
    />
  );
}
