import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import { branchesInScope, getSession } from '@/lib/session';
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

  const [branches, session] = await Promise.all([
    /*
     * ⚠️ FROM THE SESSION, NOT `GET /branches` — that endpoint is behind
     *   `branch.read`, which the front desk does not hold, so it 403'd and left
     *   this picker empty. An empty picker here means a receptionist cannot
     *   choose where to register a new patient, which is most of what this
     *   screen is for. See `branchesInScope`.
     */
    branchesInScope(slug),
    getSession(slug),
  ]);

  const permissions = session?.permissions ?? [];
  const membership = session?.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  const countryCode = membership?.countryCode ?? 'IN';

  /*
   * ⚠️ THE ACTIVE BRANCH'S ANSWER, FALLING BACK TO THE ORGANIZATION'S (CO-1).
   *   A group whose satellite is a small-animal practice registers animals there
   *   and people at the main site, and the resolved profile on each branch is
   *   what says so. An empty list — a clinic still in setup — leaves the picker
   *   showing, which is the safe direction.
   */
  const careContextCodes =
    membership?.branches.find((b) => b.id === session?.activeBranchId)?.profile.careContextCodes ??
    [];

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
      branches={branches}
      /*
       * The clinic's own country, off the session. It decides the address
       * labels, which identity documents the desk is offered, the postcode
       * lookup and the dialling code — none of which the front desk could
       * otherwise learn, because `GET /organization` is behind a permission
       * they do not hold.
       */
      countryCode={countryCode}
      /*
       * What this clinic treats. One context and the registration form stops
       * asking "person or animal?" and answers it — which is the entire reason
       * the onboarding wizard asks. Off the session for the same reason
       * `countryCode` is: the front desk holds no settings permission.
       */
      careContextCodes={careContextCodes}
      canCreate={permissions.includes(PERMISSIONS.PATIENT_CREATE)}
    />
  );
}
