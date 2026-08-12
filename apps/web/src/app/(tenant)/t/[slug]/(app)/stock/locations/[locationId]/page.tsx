import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationDetail, StorageProfileSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LocationForm } from '@/components/tenant/location-form';

export const metadata: Metadata = {
  title: 'Location',
};

/**
 * <slug>.rcln.com/stock/locations/<id>
 *
 * The edit screen. `branchId` and `code` are shown and disabled rather than
 * omitted — a storekeeper needs to see which branch a location is at, and the
 * contract refuses to change either. See the form's header for why.
 */
export default async function LocationPage({
  params,
}: {
  params: Promise<{ slug: string; locationId: string }>;
}) {
  const { slug, locationId } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.INVENTORY_LOCATION_MANAGE)) {
    return (
      <Alert tone="error">
        You cannot change locations here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [location, branches, storageProfiles] = await Promise.all([
    api<InventoryLocationDetail>(`/api/v1/inventory-locations/${locationId}`, {
      slug,
      accessToken,
    }),
    branchesInScope(slug),
    api<{ profiles: StorageProfileSummary[] }>('/api/v1/storage-profiles', { slug, accessToken }),
  ]);

  if (!location.ok || !location.data) {
    return <Alert tone="error">{location.message ?? 'That location could not be found.'}</Alert>;
  }

  return (
    <LocationForm
      slug={slug}
      branches={branches}
      storageProfiles={storageProfiles.data?.profiles ?? []}
      location={location.data}
    />
  );
}
