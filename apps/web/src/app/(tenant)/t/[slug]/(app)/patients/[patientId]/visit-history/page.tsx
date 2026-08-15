import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PatientDetail, VisitHistoryResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timeFormatOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { VisitHistory } from '@/components/tenant/visit-history';

export const metadata: Metadata = {
  /**
   * ⚠️ NEVER THE PATIENT'S NAME, for the reason the chart's title is not: a tab
   *   title is read over a shoulder, screenshotted into a support ticket and
   *   written into browser history. The heading names them; the chrome does not.
   */
  title: 'Visit history',
};

/**
 * <slug>.rcln.com/patients/<id>/visit-history
 *
 * ⚠️ ITS OWN ROUTE RATHER THAN A PANEL ON THE CHART, AND THE REASON IS THE AUDIT
 *   TRAIL. This is the most concentrated PHI read on the platform — one person's
 *   entire clinical past — and it writes a `data_access_logs` row. Folding it
 *   into the chart would mean every receptionist opening a record to check a
 *   telephone number logged a read of the whole clinical history, which buries
 *   the reads that matter under the ones that do not.
 *
 * ⚠️ `clinical.encounter.read`, NOT `patient.read` AND NOT
 *   `patient.medical_history.read` (CD-14). The first is not enough: this
 *   response carries diagnoses. The second is a DIFFERENT record — the
 *   allergies, conditions and long-term medications that are true of the person
 *   between visits — and holding one has never implied the other.
 *
 * ⚠️ TWO READS, TWO LOG ROWS. The identity comes from `GET /patients/:id`
 *   because the heading names them and the history endpoint deliberately does
 *   not carry a name: a response full of diagnoses should not also be the thing
 *   that says whose they are more times than it has to.
 */
export default async function VisitHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; patientId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug, patientId } = await params;
  const { page: rawPage } = await searchParams;
  const accessToken = await getAccessToken();

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.ENCOUNTER_READ)) {
    return (
      <Alert tone="error">
        You do not have access to consultation records here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const page = Number.parseInt(rawPage ?? '1', 10);
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const pageSize = 10;

  const [patient, history, timeFormat] = await Promise.all([
    api<PatientDetail>(`/api/v1/patients/${patientId}`, { slug, accessToken }),
    api<VisitHistoryResponse>(
      `/api/v1/patients/${patientId}/visit-history?page=${safePage}&pageSize=${pageSize}`,
      { slug, accessToken }
    ),
    timeFormatOf(slug),
  ]);

  if (patient.status === 404 || history.status === 404) notFound();

  if (!patient.ok || !patient.data || !history.ok || !history.data) {
    return (
      <Alert tone="error">
        {history.message ?? patient.message ?? 'This history could not be loaded.'}
      </Alert>
    );
  }

  return (
    <VisitHistory
      patientId={patientId}
      patientName={patient.data.fullName}
      episodes={history.data.episodes}
      total={history.data.total}
      page={history.data.page}
      pageSize={history.data.pageSize}
      /*
       * ⚠️ THE CLINIC'S CLOCK FACE, AND THE ZONE COMES OFF EACH ROW. A history
       *   spans branches — a patient treated at the main clinic and the
       *   satellite has one journey across both — so the zone cannot be a page
       *   constant. It travels on every visit; only the 12H/24H preference is
       *   resolved here.
       */
      timeFormat={timeFormat}
      canReadEpisode={permissions.includes(PERMISSIONS.APPOINTMENT_READ)}
    />
  );
}
