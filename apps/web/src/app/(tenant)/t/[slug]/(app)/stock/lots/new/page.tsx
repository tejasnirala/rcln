import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ManufacturerSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LotForm } from '@/components/tenant/lot-form';

export const metadata: Metadata = {
  title: 'Record a lot',
};

/**
 * <slug>.rcln.com/stock/lots/new
 *
 * ⚠️ THE PRODUCT LIST IS NO LONGER FETCHED HERE AT ALL (PI-23). This page used
 *   to make two calls for the first 100 batch-tracked products each and hand the
 *   form a capped list to filter in a `<select>`; a clinic with three thousand
 *   products got a picker that could not reach most of its own catalogue. The
 *   form now searches on demand through `ProductPicker`, which applies the same
 *   `trackingMode` filter server-side — so the filter holds for the whole
 *   catalogue rather than for the slice that happened to load.
 *
 * Manufacturers stay pre-loaded: it is a short, slow-changing list, and the
 * field is an override that is usually left alone.
 */
export default async function NewLotPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.BATCH_MANAGE)) {
    return (
      <Alert tone="error">You cannot record lots here. Ask an administrator at this clinic.</Alert>
    );
  }

  const [branches, manufacturers] = await Promise.all([
    branchesInScope(slug),
    api<{ manufacturers: ManufacturerSummary[] }>('/api/v1/manufacturers', {
      slug,
      accessToken: await getAccessToken(),
    }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return (
    <LotForm
      slug={slug}
      branches={branches}
      manufacturers={manufacturers.data?.manufacturers ?? []}
    />
  );
}
