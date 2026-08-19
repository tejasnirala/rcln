import type { Metadata } from 'next';
import type { InventoryLocationListResponse, ProductListResponse } from '@rcln/contracts';
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
  const [branches, country, locations, products] = await Promise.all([
    branchesInScope(slug),
    countryOf(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
    /*
     * ⚠️ CAPPED AT 100, THE PICKER LIMIT THE REST OF THIS PROGRAMME HAS AND THE
     *   ONE PI-23 REPLACES WITH A RESOLVER. Recorded in KNOWN_ISSUES rather than
     *   papered over with a bigger number.
     */
    api<ProductListResponse>('/api/v1/products?limit=100&isStockItem=true', {
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
      products={products.data?.products ?? []}
      defaultCountryCode={country}
    />
  );
}
