import type { Metadata } from 'next';
import type {
  BranchListResponse,
  DoctorListResponse,
  MemberListResponse,
  SpecialtyListResponse,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DoctorList } from '@/components/tenant/doctor-list';
import { loadFeeSchedule } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

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
   * Fetched together, not in sequence. Five dependent awaits would serialise
   * five round trips before anything renders, and none of these needs the
   * others' answer.
   *
   * The clinic's own price sheet is here for the registration form: it supplies
   * the currency and the defaults a new doctor inherits, so the form can show
   * what a blank box will actually charge. Null when the caller may not read
   * fees, which removes that section of the form.
   */
  const [doctors, branches, masters, members, fees, session] = await Promise.all([
    api<DoctorListResponse>('/api/v1/doctors', { slug, accessToken }),
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
    api<SpecialtyListResponse>('/api/v1/doctors/masters', { slug, accessToken }),
    api<MemberListResponse>('/api/v1/members', { slug, accessToken }),
    loadFeeSchedule(slug, {}),
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

  /*
   * ⚠️ WORKING HOURS COME BACK ON THE ROSTER ITSELF NOW. This used to be a second
   *   HTTP call per doctor — thirty doctors, thirty extra round trips, each
   *   opening its own transaction — which is the N+1 `listSchedulesForDoctors`
   *   replaced with one query. The API decides whether to include them from
   *   `doctor.schedule.read` and omits the field entirely otherwise, so nothing
   *   here needs to ask twice.
   */
  return (
    <DoctorList
      slug={slug}
      doctors={doctors.data.doctors}
      // A secondary 403 degrades to an empty picker rather than erroring the page.
      branches={branches.ok && branches.data ? branches.data.branches : []}
      specialties={masters.ok && masters.data ? masters.data.specialties : []}
      qualifications={masters.ok && masters.data ? masters.data.qualifications : []}
      fees={fees}
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
      canReadSchedules={permissions.includes(PERMISSIONS.DOCTOR_SCHEDULE_READ)}
      /*
       * These four gate SECTIONS OF THE REGISTRATION FORM, not row actions —
       * there are none left. The API refuses a section the caller may not set
       * rather than dropping it silently, so a section that would 403 is not
       * offered in the first place.
       */
      canManageSchedules={permissions.includes(PERMISSIONS.DOCTOR_SCHEDULE_MANAGE)}
      canCreate={permissions.includes(PERMISSIONS.DOCTOR_CREATE)}
      canUpdate={permissions.includes(PERMISSIONS.DOCTOR_UPDATE)}
      canManageFees={permissions.includes(PERMISSIONS.FEE_SCHEDULE_MANAGE)}
      canManagePay={permissions.includes(PERMISSIONS.DOCTOR_COMPENSATION_MANAGE)}
    />
  );
}
