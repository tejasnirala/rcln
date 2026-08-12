import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ManufacturerSummary, ProductListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LotForm } from '@/components/tenant/lot-form';

export const metadata: Metadata = {
  title: 'Record a lot',
};

/** How many products the picker offers before it admits it is showing a page. */
const PICKER_LIMIT = 100;

/**
 * <slug>.rcln.com/stock/lots/new
 *
 * ⚠️ THE PRODUCT PICKER IS FILTERED TO BATCH-TRACKED STOCK ITEMS SERVER-SIDE,
 *   through `trackingMode` on the catalogue query. A lot recorded against a
 *   product tracked NONE or SERIAL is one that nothing can ever move; the
 *   service refuses it, and a picker that offers the choice anyway is a form
 *   that fails after it has been filled in.
 *
 * ⚠️ AND IT IS A PAGE, NOT THE CATALOGUE. `PICKER_LIMIT` is a real cap, and the
 *   form says so when it is hit rather than silently truncating. A searchable
 *   picker over tens of thousands of rows is PI-23's work, alongside the barcode
 *   resolver — this is the honest interim, not a pretence.
 *
 * `LOT_AND_SERIAL` is fetched as a second call rather than being folded into
 * one, because the query filter takes a single mode. Two small parallel reads
 * beat inventing a multi-value parameter for one screen.
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

  const accessToken = await getAccessToken();
  const query = `isStockItem=true&status=ACTIVE&limit=${String(PICKER_LIMIT)}`;

  const [branches, batchTracked, both, manufacturers] = await Promise.all([
    branchesInScope(slug),
    api<ProductListResponse>(`/api/v1/products?${query}&trackingMode=LOT_BATCH`, {
      slug,
      accessToken,
    }),
    api<ProductListResponse>(`/api/v1/products?${query}&trackingMode=LOT_AND_SERIAL`, {
      slug,
      accessToken,
    }),
    api<{ manufacturers: ManufacturerSummary[] }>('/api/v1/manufacturers', { slug, accessToken }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  const products = [...(batchTracked.data?.products ?? []), ...(both.data?.products ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name)
  );

  const moreProducts =
    (batchTracked.data?.meta.total ?? 0) + (both.data?.meta.total ?? 0) > products.length;

  return (
    <LotForm
      slug={slug}
      branches={branches}
      products={products}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      moreProducts={moreProducts}
    />
  );
}
