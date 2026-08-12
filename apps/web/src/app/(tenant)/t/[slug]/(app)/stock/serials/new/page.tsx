import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type {
  BatchListResponse,
  InventoryLocationListResponse,
  ProductListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SerialForm } from '@/components/tenant/serial-form';

export const metadata: Metadata = {
  title: 'Record a serial',
};

const PICKER_LIMIT = 100;

/**
 * <slug>.rcln.com/stock/serials/new
 *
 * ⚠️ FOUR PARALLEL READS, NOT A WATERFALL. The product picker, the lot picker
 *   and the location picker have nothing to say to each other, and a form the
 *   user watches assemble itself is worse than one that arrives.
 *
 * The lot list is fetched whole and narrowed in the browser to the chosen
 * product and branch, because both are chosen after the page loads. It is capped
 * like the product picker, and `moreLots` carries that fact into the form —
 * a picker that silently omits the lot somebody is holding is worse than one
 * that says it is showing a page. A searchable picker is PI-23.
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

  const accessToken = await getAccessToken();
  const query = `isStockItem=true&status=ACTIVE&limit=${String(PICKER_LIMIT)}`;

  const [branches, serialTracked, both, batches, locations] = await Promise.all([
    branchesInScope(slug),
    api<ProductListResponse>(`/api/v1/products?${query}&trackingMode=SERIAL`, {
      slug,
      accessToken,
    }),
    api<ProductListResponse>(`/api/v1/products?${query}&trackingMode=LOT_AND_SERIAL`, {
      slug,
      accessToken,
    }),
    api<BatchListResponse>(`/api/v1/batches?status=ACTIVE&limit=${String(PICKER_LIMIT)}`, {
      slug,
      accessToken,
    }),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', { slug, accessToken }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  const products = [...(serialTracked.data?.products ?? []), ...(both.data?.products ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name)
  );

  const lots = batches.data?.batches ?? [];

  return (
    <SerialForm
      slug={slug}
      branches={branches}
      products={products}
      batches={lots}
      locations={locations.data?.locations ?? []}
      moreLots={(batches.data?.meta.total ?? 0) > lots.length}
    />
  );
}
