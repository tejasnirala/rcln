import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { StorageProfileSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { StorageProfileList } from '@/components/tenant/storage-profile-list';

export const metadata: Metadata = { title: 'Storage' };

/**
 * <slug>.rcln.com/products/storage
 *
 * ⚠️ ADD AND LIST ONLY. `/v1/storage-profiles` has no PATCH route, so no edit is
 *   offered — see the note on `StorageProfileList`.
 *
 * NO PHI.
 */
export default async function StoragePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const profiles = await api<{ profiles: StorageProfileSummary[] }>(
    '/api/v1/storage-profiles?includeInactive=true',
    { slug, accessToken: await getAccessToken() }
  );

  if (!profiles.ok) {
    return (
      <Alert tone="error">
        {profiles.message ?? 'Storage requirements could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <StorageProfileList
      slug={slug}
      profiles={profiles.data?.profiles ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
