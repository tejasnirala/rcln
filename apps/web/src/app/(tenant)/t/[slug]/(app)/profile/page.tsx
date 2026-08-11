import type { Metadata } from 'next';
import type { DoctorDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DoctorProfile } from '@/components/tenant/doctor-profile';
import { loadCompensation, loadFeeSchedule } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

export const metadata: Metadata = {
  title: 'My profile',
};

/**
 * <slug>.rcln.com/profile — the caller's own practitioner profile.
 *
 * WHY THIS IS NOT UNDER `/doctors`
 *   `/doctors` is the roster, behind `doctor.directory.read`, which a doctor
 *   deliberately does not hold — that omission is what makes their navigation
 *   two tabs. Their own profile is a different thing reached a different way:
 *   from the user menu in the header, at a URL that needs no id because the API
 *   resolves it from the session.
 *
 * READ-ONLY, INCLUDING FOR THE PERSON IT DESCRIBES. Editing a doctor's profile
 * is `doctor.update`, which sits with the admin roles. That is the decision this
 * screen renders, not a temporary state.
 *
 * A 404 here means the caller is a member of staff who is not a practitioner —
 * an ordinary situation, not an error, so it is said in a sentence rather than
 * shown as a missing page.
 */
export default async function OwnProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const doctor = await api<DoctorDetail>('/api/v1/doctors/me', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (doctor.status === 404) {
    return (
      <Alert tone="info">
        You do not have a doctor profile at this clinic. If that is wrong, ask an administrator to
        set one up.
      </Alert>
    );
  }

  if (!doctor.ok || !doctor.data) {
    return <Alert tone="error">{doctor.message ?? 'Your profile could not be loaded.'}</Alert>;
  }

  /*
   * A doctor sees their own prices and their own pay, and changes neither
   * (§0.2 decision 5). No permission check is needed for the pay read: the API
   * resolves the profile against the caller and lets the owner through.
   */
  const [fees, compensation, branches, timezone] = await Promise.all([
    loadFeeSchedule(slug, { doctorProfileId: doctor.data.id }),
    loadCompensation(slug, doctor.data.id),
    branchesInScope(slug),
    timezoneOf(slug),
  ]);

  return (
    <DoctorProfile
      doctor={doctor.data}
      timezone={timezone}
      slug={slug}
      fees={fees}
      branches={branches}
      compensation={compensation}
    />
  );
}
