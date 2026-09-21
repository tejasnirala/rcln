import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ManufacturerSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ManufacturerList } from '@/components/tenant/manufacturer-list';

export const metadata: Metadata = { title: 'Manufacturers' };

/**
 * <slug>.rcln.com/products/manufacturers
 *
 * ⚠️ `includeInactive=true`, UNLIKE EVERY PICKER THAT READS THIS ENDPOINT. A
 *   picker offers what may be chosen; this screen is where retiring happens, and
 *   a list that hid what it had just retired would look like it had deleted it.
 *
 * NO PHI.
 */
export default async function ManufacturersPage({ params }: { params: Promise<{ slug: string }> }) {
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

  const manufacturers = await api<{ manufacturers: ManufacturerSummary[] }>(
    '/api/v1/manufacturers?includeInactive=true',
    { slug, accessToken: await getAccessToken() }
  );

  if (!manufacturers.ok) {
    return (
      <Alert tone="error">
        {manufacturers.message ?? 'Manufacturers could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ManufacturerList
      slug={slug}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
