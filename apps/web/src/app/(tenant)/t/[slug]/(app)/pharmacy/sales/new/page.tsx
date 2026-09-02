import type { Metadata } from 'next';
import type { InventoryLocationListResponse } from '@rcln/contracts';
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
  /*
   * ⚠️ THE PRODUCT LIST IS GONE (PI-23). It was capped at 100 — the picker limit
   *   the whole programme carried — so a dispensary with a wider catalogue could
   *   not find everything in the dropdown. The line picker searches now.
   */
  const [branches, locations] = await Promise.all([
    branchesInScope(slug),
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
        No branch you work at has a dispensing point set up, so nothing can be sold from a counter.
        Mark a location as a dispensing point under Stock first.
      </Alert>
    );
  }

  return <CounterSaleForm slug={slug} branches={branches} locations={dispensingPoints} />;
}
