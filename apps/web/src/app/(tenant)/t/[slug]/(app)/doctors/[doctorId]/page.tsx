import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { BranchListResponse, DoctorDetail, SpecialtyListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DoctorProfile } from '@/components/tenant/doctor-profile';
import { loadCompensation, loadFeeSchedule } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

export const metadata: Metadata = {
  title: 'Doctor',
};

/**
 * <slug>.rcln.com/doctors/<id> — one practitioner, read-only.
 *
 * Reached from the roster, which is behind `doctor.directory.read`. This page
 * itself is behind `doctor.read`, which is the weaker code: a doctor holds it
 * for their own profile and can therefore reach this route, but has no way to
 * obtain a colleague's id without the roster they cannot list. That is the
 * intended shape — the boundary is the directory, not this URL.
 *
 * ⚠️ NOT PHI, so no `data_access_logs` row and no warning banner. A colleague's
 *   registration number is staff information; the patient chart is the screen
 *   that carries that cost.
 */
export default async function DoctorPage({
  params,
}: {
  params: Promise<{ slug: string; doctorId: string }>;
}) {
  const { slug, doctorId } = await params;

  const doctor = await api<DoctorDetail>(`/api/v1/doctors/${doctorId}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (doctor.status === 404) notFound();

  if (!doctor.ok || !doctor.data) {
    return (
      <Alert tone="error">
        {doctor.status === 403
          ? 'You do not have access to doctor profiles here. Ask an administrator at this clinic.'
          : (doctor.message ?? 'This profile could not be loaded.')}
      </Alert>
    );
  }

  /*
   * The two money panels, fetched only once the profile is known to exist.
   * Both come back null when the caller may not read them, which removes the
   * panel rather than erroring the page — a receptionist opening a colleague's
   * profile should see the profile, not a permissions complaint.
   *
   * ⚠️ THE COMPENSATION READ IS SELF-SCOPED IN THE API. A doctor sees their own
   *   figure with no `doctor.compensation.read` anywhere, because the service
   *   compares the profile's user against the caller. Nothing here needs to know
   *   that, and nothing here should try to reproduce it.
   */
  const [fees, compensation, branches, masters, allBranches, session, timezone] = await Promise.all(
    [
      loadFeeSchedule(slug, { doctorProfileId: doctorId }),
      loadCompensation(slug, doctorId),
      branchesInScope(slug),
      /*
       * The catalogues and branches the editing panels post against. Both degrade
       * to empty on a 403 rather than erroring the page — a receptionist who may
       * not edit still gets the profile, and the panels they cannot open never
       * render anyway.
       */
      api<SpecialtyListResponse>('/api/v1/doctors/masters', {
        slug,
        accessToken: await getAccessToken(),
      }),
      api<BranchListResponse>('/api/v1/branches', { slug, accessToken: await getAccessToken() }),
      getSession(slug),
      timezoneOf(slug),
    ]
  );

  const permissions = session?.permissions ?? [];

  return (
    <DoctorProfile
      doctor={doctor.data}
      timezone={timezone}
      backHref="/doctors"
      backLabel="All doctors"
      slug={slug}
      fees={fees}
      branches={branches}
      compensation={compensation}
      canEditFees={permissions.includes(PERMISSIONS.FEE_SCHEDULE_MANAGE)}
      canEditPay={permissions.includes(PERMISSIONS.DOCTOR_COMPENSATION_MANAGE)}
      /*
       * ⚠️ EDITING LIVES ON THIS PAGE NOW, NOT ON THE ROSTER. Each panel is
       *   behind its own code because they are genuinely different people:
       *   `doctor.update` is an administrator fixing a council number,
       *   `doctor.schedule.manage` is whoever runs the rota, and
       *   `doctor.archive` is withheld from ORG_ADMIN entirely.
       */
      specialties={masters.ok && masters.data ? masters.data.specialties : []}
      qualifications={masters.ok && masters.data ? masters.data.qualifications : []}
      editableBranches={allBranches.ok && allBranches.data ? allBranches.data.branches : []}
      canUpdate={permissions.includes(PERMISSIONS.DOCTOR_UPDATE)}
      canManageSchedules={permissions.includes(PERMISSIONS.DOCTOR_SCHEDULE_MANAGE)}
      canArchive={permissions.includes(PERMISSIONS.DOCTOR_ARCHIVE)}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
