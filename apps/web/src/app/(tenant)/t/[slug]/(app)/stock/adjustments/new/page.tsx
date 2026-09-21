import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationListResponse, StockReasonCodeListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { AdjustmentForm } from '@/components/tenant/adjustment-form';

export const metadata: Metadata = {
  title: 'Record an adjustment',
};

/**
 * <slug>.rcln.com/stock/adjustments/new
 *
 * ⚠️ A FORM WITH NO LIST BESIDE IT, AND THAT IS THE STRUCTURE RATHER THAN A GAP.
 *   The list of adjustments IS the movements screen filtered to one type — same
 *   rows, same query — so a second list would be a second door onto one screen,
 *   and two tabs showing overlapping sets of the same rows is how a person loses
 *   track of which one is complete. Recording one is an action, and it lives at
 *   the end of a button on Movements.
 *
 * ⚠️ NEITHER THE PRODUCTS NOR THE LOTS ARE FETCHED HERE ANY MORE (PI-23). Both
 *   pickers ask the server once they have something to ask about. The old page
 *   pulled the first 100 products and the first 200 lots ACROSS EVERY BRANCH, so
 *   a clinic past either figure had stock it could not adjust and nothing on
 *   screen said why.
 *
 * ⚠️ THE REASON CODES ARE FETCHED, NOT HARD-CODED. Thirteen ship with the
 *   platform and a clinic adds its own; a list baked into the form would be a
 *   second vocabulary that drifts from the one the API validates against.
 *
 * NO PHI.
 */
export default async function NewAdjustmentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.STOCK_ADJUST)) {
    return (
      <Alert tone="error">You cannot adjust stock here. Ask an administrator at this clinic.</Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [branches, locations, reasonCodes] = await Promise.all([
    branchesInScope(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', { slug, accessToken }),
    api<StockReasonCodeListResponse>('/api/v1/stock/reason-codes', { slug, accessToken }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return (
    <AdjustmentForm
      slug={slug}
      branches={branches}
      locations={locations.data?.locations ?? []}
      reasonCodes={reasonCodes.data?.reasonCodes ?? []}
    />
  );
}
