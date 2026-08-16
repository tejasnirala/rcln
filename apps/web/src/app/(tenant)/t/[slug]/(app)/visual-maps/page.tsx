import type { Metadata } from 'next';
import type { SpecialtyListResponse, VisualMapListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { VisualMapList } from '@/components/tenant/visual-map-list';

export const metadata: Metadata = { title: 'Charts' };

/**
 * <slug>.rcln.com/visual-maps — the pictures a consultation draws on (CE-6).
 *
 * ⚠️ NO PHI ON THIS SCREEN. A chart names no patient: it is safe in a URL and is
 *   not read-audited.
 *
 * ⚠️ ONE PERMISSION, BOTH DIRECTIONS, LIKE THE CONSULTATION TEMPLATES AND UNLIKE
 *   `/clinical-terms`. Every screen that renders a diagnosis needs the
 *   VOCABULARY, so that one is readable by anyone who can read an appointment.
 *   Nobody needs the CHART LIST except the person configuring one — a doctor
 *   gets the chart already resolved onto the consultation.
 *
 * Server-rendered and SERVER-PAGINATED, like every list in this app.
 */
export default async function VisualMapsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have access to the charts here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const rawPage = query['page'];
  const search = new URLSearchParams({ pageSize: '25', includeInactive: 'true' });
  if (typeof rawPage === 'string') search.set('page', rawPage);

  const accessToken = await getAccessToken();
  const [result, taxonomy] = await Promise.all([
    api<VisualMapListResponse>(`/api/v1/visual-maps?${search.toString()}`, { slug, accessToken }),
    /* The taxonomy, for the "especially for" pickers on the create form. Both
       the care contexts and the nodes beneath them come from this one call. */
    api<SpecialtyListResponse>('/api/v1/doctors/masters', { slug, accessToken }),
  ]);

  if (!result.ok || result.data === undefined) {
    return (
      <Alert tone="error">
        {result.message ?? 'The charts could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <VisualMapList
      slug={slug}
      data={result.data}
      specialties={taxonomy.ok ? (taxonomy.data?.specialties ?? []) : []}
    />
  );
}
