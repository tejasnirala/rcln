import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { VisualMapDetail } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { VisualMapEditor } from '@/components/tenant/visual-map-editor';

export const metadata: Metadata = { title: 'Chart' };

/**
 * One chart and every place on it.
 *
 * ⚠️ NO PHI. The preview is the same renderer the consultation uses, with
 *   nothing marked on it — a chart is a picture of a body and not of a person.
 */
export default async function VisualMapPage({
  params,
}: {
  params: Promise<{ slug: string; mapId: string }>;
}) {
  const { slug, mapId } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have access to the charts here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const result = await api<VisualMapDetail>(`/api/v1/visual-maps/${mapId}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (result.status === 404) notFound();
  if (!result.ok || result.data === undefined) {
    return (
      <Alert tone="error">
        {result.message ?? 'That chart could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return <VisualMapEditor slug={slug} map={result.data} />;
}
