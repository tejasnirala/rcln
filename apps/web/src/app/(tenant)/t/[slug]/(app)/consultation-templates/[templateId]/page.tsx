import type { Metadata } from 'next';
import type { ConsultationTemplateDetail } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsultationTemplateEditor } from '@/components/tenant/consultation-template-editor';

export const metadata: Metadata = { title: 'Consultation template' };

/**
 * One template: its version history, and the document of one version.
 *
 * ⚠️ THE VERSION IS IN THE URL. A template's history is a real sequence and a
 *   real state machine — draft, live, retired — so which version somebody is
 *   looking at is a fact worth being able to link to and come back to, not
 *   component state that evaporates on refresh.
 *
 * NO PHI. Nothing on this screen names a patient.
 */
export default async function ConsultationTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; templateId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, templateId } = await params;
  const query = await searchParams;
  const session = await getSession(slug);

  if (!(session?.permissions ?? []).includes(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have access to the consultation configuration here. Ask an administrator at this
        clinic.
      </Alert>
    );
  }

  const rawVersion = query['versionId'];
  const search = typeof rawVersion === 'string' ? `?versionId=${rawVersion}` : '';

  const accessToken = await getAccessToken();
  const result = await api<ConsultationTemplateDetail>(
    `/api/v1/consultation-templates/${templateId}${search}`,
    { slug, accessToken }
  );

  if (!result.ok || result.data === undefined) {
    return (
      <Alert tone="error">
        {result.message ?? 'That consultation template could not be loaded.'}
      </Alert>
    );
  }

  const shown =
    typeof rawVersion === 'string'
      ? (result.data.versions.find((v) => v.id === rawVersion) ?? null)
      : (result.data.publishedVersion ?? result.data.draftVersion);

  return (
    <ConsultationTemplateEditor
      slug={slug}
      template={result.data}
      shownVersionId={shown?.id ?? null}
    />
  );
}
