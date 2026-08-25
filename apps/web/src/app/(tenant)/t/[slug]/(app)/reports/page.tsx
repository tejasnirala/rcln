import type { Metadata } from 'next';
import type { ReportCatalogue } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ReportCatalogueList } from '@/components/tenant/report-catalogue';

export const metadata: Metadata = {
  title: 'Reports',
};

/**
 * <slug>.rcln.com/reports
 *
 * ⚠️ THE LIST COMES FROM THE API, NOT FROM A CONSTANT HERE. Which reports this
 *   caller may open depends on codes that can be granted per membership and
 *   removed from a cloned role — a client-side filter would be right until the
 *   first custom role. See the route's own note.
 *
 * The one check made here is on `report.dashboard.read`, which gates the MENU
 * rather than any report. It is the same check the API makes; duplicating it
 * saves a round trip and lets the refusal say something a person can act on.
 */
export default async function ReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.REPORT_DASHBOARD)) {
    return (
      <Alert tone="error">
        You do not have access to reports here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const catalogue = await api<ReportCatalogue>('/api/v1/reports', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!catalogue.ok || !catalogue.data) {
    return (
      <Alert tone="error">
        {catalogue.message ?? 'Reports could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return <ReportCatalogueList catalogue={catalogue.data} />;
}
