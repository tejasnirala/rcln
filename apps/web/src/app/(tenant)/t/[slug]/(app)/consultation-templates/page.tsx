import type { Metadata } from 'next';
import type { ConsultationTemplateListResponse, SpecialtyListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsultationTemplateList } from '@/components/tenant/consultation-template-list';

export const metadata: Metadata = { title: 'Consultations' };

/**
 * <slug>.rcln.com/consultation-templates — what a consultation is made of here.
 *
 * ⚠️ NO PHI ON THIS SCREEN. A template names no patient and no clinician; its
 *   labels are dictionary entries. It is safe in a URL and is not read-audited.
 *
 * ⚠️ ONE PERMISSION, BOTH DIRECTIONS, UNLIKE `/clinical-terms`. Every screen
 *   that renders a diagnosis needs the VOCABULARY, so that one is readable by
 *   anyone who can read an appointment. Nobody needs the TEMPLATE LIST except
 *   the person configuring it — a doctor gets the resolved configuration on the
 *   consultation screen itself, from an endpoint behind
 *   `clinical.encounter.read`.
 *
 * Server-rendered and SERVER-PAGINATED, like every list in this app.
 */
export default async function ConsultationTemplatesPage({
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

  if (!permissions.includes(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have access to the consultation configuration here. Ask an administrator at this
        clinic.
      </Alert>
    );
  }

  const rawPage = query['page'];
  const search = new URLSearchParams({ pageSize: '25', includeInactive: 'true' });
  if (typeof rawPage === 'string') search.set('page', rawPage);

  const accessToken = await getAccessToken();
  const [result, taxonomy] = await Promise.all([
    api<ConsultationTemplateListResponse>(`/api/v1/consultation-templates?${search.toString()}`, {
      slug,
      accessToken,
    }),
    /* The taxonomy, for the "applies to" pickers on the create form. Both the
       care contexts and the nodes beneath them come from this one call — see
       `lib/taxonomy.ts` for why it is not a drill-down. */
    api<SpecialtyListResponse>('/api/v1/doctors/masters', { slug, accessToken }),
  ]);

  if (!result.ok || result.data === undefined) {
    return (
      <Alert tone="error">
        {result.message ?? 'The consultation templates could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ConsultationTemplateList
      slug={slug}
      data={result.data}
      specialties={taxonomy.ok ? (taxonomy.data?.specialties ?? []) : []}
    />
  );
}
