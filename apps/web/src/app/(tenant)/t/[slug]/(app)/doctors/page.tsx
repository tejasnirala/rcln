import type { Metadata } from 'next';
import type {
  BranchListResponse,
  DoctorListResponse,
  DoctorScheduleDetail,
  MemberListResponse,
  SpecialtyListResponse,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DoctorList } from '@/components/tenant/doctor-list';

export const metadata: Metadata = {
  title: 'Doctors',
};

/**
 * <slug>.rcln.com/doctors
 *
 * The auth guard, header and branch switcher come from the `(app)` layout.
 *
 * A caller without `doctor.read` gets 403 from the API rather than an empty
 * list, so the two are told apart below — an empty state that actually means
 * "you may not see this" is how a permissions bug goes unnoticed.
 */
export default async function DoctorsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const accessToken = await getAccessToken();

  /*
   * Fetched together, not in sequence. Four dependent awaits would serialise
   * four round trips before anything renders, and none of these needs the
   * others' answer.
   */
  const [doctors, branches, masters, members, session] = await Promise.all([
    api<DoctorListResponse>('/api/v1/doctors', { slug, accessToken }),
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
    api<SpecialtyListResponse>('/api/v1/doctors/masters', { slug, accessToken }),
    api<MemberListResponse>('/api/v1/members', { slug, accessToken }),
    getSession(slug),
  ]);

  if (!doctors.ok || !doctors.data) {
    return (
      <Alert tone="error">
        {doctors.status === 403
          ? 'You do not have access to the doctor roster. Ask an administrator at this clinic.'
          : (doctors.message ?? 'Doctors could not be loaded.')}
      </Alert>
    );
  }

  const permissions = session?.permissions ?? [];
  const canReadSchedules = permissions.includes(PERMISSIONS.DOCTOR_SCHEDULE_READ);

  /*
   * Working hours are a second call per doctor, and only worth making for a
   * caller who may read them. Fetched in parallel across the roster; a clinic
   * has tens of doctors, not thousands.
   */
  const schedules = new Map<string, DoctorScheduleDetail[]>();
  if (canReadSchedules) {
    const results = await Promise.all(
      doctors.data.doctors.map(async (doctor) => {
        const res = await api<{ schedules: DoctorScheduleDetail[] }>(
          `/api/v1/doctors/${doctor.id}/schedules`,
          { slug, accessToken }
        );
        return [doctor.id, res.ok && res.data ? res.data.schedules : []] as const;
      })
    );
    for (const [id, rows] of results) schedules.set(id, rows);
  }

  return (
    <DoctorList
      slug={slug}
      doctors={doctors.data.doctors}
      schedules={Object.fromEntries(schedules)}
      // A secondary 403 degrades to an empty picker rather than erroring the page.
      branches={branches.ok && branches.data ? branches.data.branches : []}
      specialties={masters.ok && masters.data ? masters.data.specialties : []}
      /*
       * Who can be made a doctor: an ACTIVE member who does not already have a
       * profile. Filtered here rather than in the picker so the "add" button can
       * be hidden when there is nobody left to add — an empty picker is a dead
       * end with no explanation.
       */
      candidates={
        members.ok && members.data
          ? members.data.members
              .filter((m) => m.status === 'ACTIVE')
              .filter((m) => !doctors.data!.doctors.some((d) => d.userId === m.userId))
              .map((m) => ({ userId: m.userId, fullName: m.fullName }))
          : []
      }
      canReadSchedules={canReadSchedules}
      canManageSchedules={permissions.includes(PERMISSIONS.DOCTOR_SCHEDULE_MANAGE)}
      canCreate={permissions.includes(PERMISSIONS.DOCTOR_CREATE)}
      canUpdate={permissions.includes(PERMISSIONS.DOCTOR_UPDATE)}
      canArchive={permissions.includes(PERMISSIONS.DOCTOR_ARCHIVE)}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
