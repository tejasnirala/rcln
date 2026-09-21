import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TransferForm } from '@/components/tenant/transfer-form';

export const metadata: Metadata = {
  title: 'Move stock',
};

/**
 * <slug>.rcln.com/stock/transfers/new
 *
 * ⚠️ TWO PARALLEL READS NOW, NOT FOUR (PI-23). Products and lots are asked for
 *   per LINE, once that line names a product and the sending branch is known.
 *   The old page fetched the first 100 products and the first 200 lots across
 *   every branch and filtered both in the browser, so a clinic past either
 *   figure had stock it could not transfer and nothing on screen said why.
 *
 * NO PHI.
 */
export default async function NewTransferPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.STOCK_TRANSFER)) {
    return (
      <Alert tone="error">You cannot move stock here. Ask an administrator at this clinic.</Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [branches, locations] = await Promise.all([
    branchesInScope(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', { slug, accessToken }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return (
    <TransferForm slug={slug} branches={branches} locations={locations.data?.locations ?? []} />
  );
}
