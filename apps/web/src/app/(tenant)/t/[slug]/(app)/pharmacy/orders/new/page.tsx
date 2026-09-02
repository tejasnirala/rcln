import type { Metadata } from 'next';
import type { InventoryLocationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, countryOf, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { OnlineOrderForm } from '@/components/tenant/online-order-form';
import { pharmacyAccess } from '../../guard';

export const metadata: Metadata = { title: 'Take an order' };

/**
 * Taking an order for delivery.
 *
 * ⚠️ IT SAVES A DRAFT AND HOLDS NOTHING. The law is consulted and the stock is
 *   held when somebody ACCEPTS the order, on its own screen — see the header on
 *   `online-order.service.ts` for why those are two acts.
 */
export default async function TakeOnlineOrderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canManageOrders) {
    return (
      <Alert tone="error">
        You do not have permission to take orders here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  /*
   * ⚠️ THE PRODUCT LIST IS GONE (PI-23). It was capped at 100 — the picker limit
   *   the whole programme carried — and the form searches now. So does the patient
   *   field, which was a box asking for a uuid.
   */
  const [branches, country, locations] = await Promise.all([
    branchesInScope(slug),
    countryOf(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
  ]);

  const dispensingPoints = (locations.data?.locations ?? []).filter(
    (location) => location.isDispensingPoint && location.isActive
  );

  if (dispensingPoints.length === 0) {
    return (
      <Alert tone="warning">
        No branch you work at has a dispensing point set up, so nothing can be packed. Mark a
        location as a dispensing point under Stock first.
      </Alert>
    );
  }

  return (
    <OnlineOrderForm
      slug={slug}
      branches={branches}
      locations={dispensingPoints}
      defaultCountryCode={country}
    />
  );
}
