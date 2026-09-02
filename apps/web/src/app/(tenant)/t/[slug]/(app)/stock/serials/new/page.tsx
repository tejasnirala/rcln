import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SerialForm } from '@/components/tenant/serial-form';

export const metadata: Metadata = {
  title: 'Record a serial',
};

/**
 * <slug>.rcln.com/stock/serials/new
 *
 * ⚠️ TWO READS NOW, NOT FIVE (PI-23). The product picker and the lot picker both
 *   ask the server once they have something to ask about, so neither list is
 *   fetched here any more. The old page pulled the first hundred serial-tracked
 *   products AND the first hundred lots at any branch, and narrowed both in the
 *   browser — which meant the lot somebody was holding was simply missing from a
 *   clinic with more than a hundred open lots.
 *
 * Locations stay pre-loaded: one branch has a handful of them, they change
 * rarely, and the field is optional.
 */
export default async function NewSerialPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.BATCH_MANAGE)) {
    return (
      <Alert tone="error">
        You cannot record serials here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const [branches, locations] = await Promise.all([
    branchesInScope(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', {
      slug,
      accessToken: await getAccessToken(),
    }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return <SerialForm slug={slug} branches={branches} locations={locations.data?.locations ?? []} />;
}
