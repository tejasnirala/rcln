import type { Metadata } from 'next';
import type { InventoryLocationListResponse, ProductListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { CounterSaleForm } from '@/components/tenant/counter-sale-form';
import { pharmacyAccess } from '../../guard';

export const metadata: Metadata = { title: 'Counter sale' };

/**
 * A sale with no prescription behind it.
 *
 * ⚠️ NO PHI ON THE WAY IN. A walk-in is frequently not a patient of this clinic,
 *   and the form invents no record for one.
 */
export default async function CounterSalePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canDispense) {
    return (
      <Alert tone="error">
        You do not have permission to sell from the counter here. Ask an administrator at this
        clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [branches, locations, products] = await Promise.all([
    branchesInScope(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
    /*
     * ⚠️ CAPPED AT 100, WHICH IS THE PICKER LIMIT THE REST OF THIS PROGRAMME HAS
     *   AND THE ONE PI-23 REPLACES WITH A RESOLVER. A dispensary with a wider
     *   catalogue than that cannot find everything in this dropdown today; it is
     *   recorded in KNOWN_ISSUES rather than papered over with a bigger number.
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
        No branch you work at has a dispensing point set up, so nothing can be sold from a counter.
        Mark a location as a dispensing point under Stock first.
      </Alert>
    );
  }

  return (
    <CounterSaleForm
      slug={slug}
      branches={branches}
      locations={dispensingPoints}
      products={products.data?.products ?? []}
    />
  );
}
