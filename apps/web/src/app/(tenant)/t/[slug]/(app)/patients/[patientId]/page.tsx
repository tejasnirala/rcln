import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PatientDetail, PatientHistoryResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PatientChart } from '@/components/tenant/patient-chart';

/**
 * ⚠️ THE TAB TITLE IS NOT THE PATIENT'S NAME.
 *   Generating it from the record would put a patient's name in the browser
 *   tab, the window title, the history entry and every screenshot taken of this
 *   screen — including the one a colleague pastes into a support ticket. The
 *   page heading names them; the chrome does not.
 */
export const metadata: Metadata = {
  title: 'Patient record',
};

/**
 * <slug>.rcln.com/patients/<id>
 *
 * ⚠️ OPENING THIS PAGE WRITES A `data_access_logs` ROW. Two of them, in fact:
 *   one for the identity read and one for the medical history, because they are
 *   separate permissions and separate disclosures. That is the intended cost of
 *   the page and the reason there is no prefetch on the result rows.
 *
 * The history call is made only for a caller who may read it. A receptionist
 * gets the identity half and no clinical content, and the screen says so rather
 * than showing three empty panels — an empty list that actually means "you may
 * not see this" is how a permissions bug goes unnoticed.
 */
export default async function PatientPage({
  params,
}: {
  params: Promise<{ slug: string; patientId: string }>;
}) {
  const { slug, patientId } = await params;
  const accessToken = await getAccessToken();

  const [patient, session] = await Promise.all([
    api<PatientDetail>(`/api/v1/patients/${patientId}`, { slug, accessToken }),
    getSession(slug),
  ]);

  if (patient.status === 404) notFound();

  if (!patient.ok || !patient.data) {
    return (
      <Alert tone="error">
        {patient.status === 403
          ? 'You do not have access to patient records here.'
          : (patient.message ?? 'This record could not be loaded.')}
      </Alert>
    );
  }

  const permissions = session?.permissions ?? [];
  const canReadHistory = permissions.includes(PERMISSIONS.PATIENT_MEDICAL_HISTORY_READ);

  const [history, branches] = await Promise.all([
    canReadHistory
      ? api<PatientHistoryResponse>(`/api/v1/patients/${patientId}/history`, {
          slug,
          accessToken,
        })
      : Promise.resolve(null),
    // Session, not `GET /branches` — see `branchesInScope`. Registering a
    // patient at another branch is a front-desk act, and the front desk does
    // not hold `branch.read`.
    branchesInScope(slug),
  ]);

  return (
    <PatientChart
      slug={slug}
      patient={patient.data}
      history={history?.ok && history.data ? history.data : null}
      canReadHistory={canReadHistory}
      branches={branches}
      canUpdate={permissions.includes(PERMISSIONS.PATIENT_UPDATE)}
      canCreate={permissions.includes(PERMISSIONS.PATIENT_CREATE)}
      canWriteHistory={permissions.includes(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE)}
      canReadAudit={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
