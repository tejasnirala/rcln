import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LocationList } from '@/components/tenant/location-list';

export const metadata: Metadata = {
  title: 'Locations',
};

/**
 * <slug>.rcln.com/stock/locations
 *
 * Behind `inventory.stock.read`, like every read in this section — every stock
 * screen needs the NAME of a shelf, and gating that behind the permission to
 * CREATE shelves would show a storekeeper a page of uuids.
 *
 * `inventory.location.manage` is what unlocks the editing copy, and it is a
 * different claim: defining that a branch HAS a controlled cabinet is a
 * configuration decision about how the site is laid out, not a daily one.
 */
export default async function LocationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.STOCK_READ)) {
    return (
      <Alert tone="error">
        You do not have access to stock here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const locations = await api<InventoryLocationListResponse>(
    '/api/v1/inventory-locations?includeInactive=true',
    { slug, accessToken }
  );

  if (!locations.ok) {
    return (
      <Alert tone="error">
        {locations.message ?? 'Locations could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <LocationList
      locations={locations.data?.locations ?? []}
      canManage={permissions.includes(PERMISSIONS.INVENTORY_LOCATION_MANAGE)}
    />
  );
}
