import type { Metadata } from 'next';
import type { BranchListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PatientSearch } from '@/components/tenant/patient-search';

export const metadata: Metadata = {
  title: 'Patients',
};

/**
 * <slug>.rcln.com/patients
 *
 * ⚠️ THIS PAGE RENDERS NO PATIENTS.
 *   Every other list in this app loads its rows on the server and hands them to
 *   a client component. This one deliberately does not, for two reasons that
 *   both come back to the same thing:
 *
 *     - A patient list is a LOOKUP, not a browse. A clinic has thousands of
 *       records and the front desk wants exactly one of them. Rendering the
 *       first twenty on arrival answers a question nobody asked and discloses
 *       twenty people's details to do it.
 *     - Every read of a patient record writes a `data_access_logs` row. A list
 *       that loads on navigation would log a disclosure every time somebody
 *       clicked the nav link — burying the reads that are actually worth
 *       looking at under the ones that mean nothing.
 *
 *   So the screen opens on a search field and stays empty until someone asks a
 *   question. The empty state is the design, not a fallback.
 *
 * The branch list IS fetched here: it is not PHI, and the registration form
 * needs it before it can be opened.
 */
export default async function PatientsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const accessToken = await getAccessToken();

  const [branches, session] = await Promise.all([
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
    getSession(slug),
  ]);

  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PATIENT_READ)) {
    return (
      <Alert tone="error">
        You do not have access to patient records here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  return (
    <PatientSearch
      slug={slug}
      // A secondary 403 degrades to an empty picker rather than erroring the page.
      branches={branches.ok && branches.data ? branches.data.branches : []}
      canCreate={permissions.includes(PERMISSIONS.PATIENT_CREATE)}
    />
  );
}
