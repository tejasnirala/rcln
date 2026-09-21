import type { Metadata } from 'next';
import type {
  GoodsReceiptDetail,
  InventoryLocationListResponse,
  SupplierListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseReturnForm } from '@/components/tenant/purchase-return-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Send stock back' };

/* The product list is not fetched: the line picker searches (PI-23). */
export default async function NewReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canReceive) {
    return <Alert tone="error">You cannot send stock back here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const goodsReceiptId = Array.isArray(query['goodsReceiptId'])
    ? query['goodsReceiptId'][0]
    : query['goodsReceiptId'];

  const [branches, suppliers, locations, receipt] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
    goodsReceiptId === undefined
      ? Promise.resolve(null)
      : api<GoodsReceiptDetail>(`/api/v1/procurement/goods-receipts/${goodsReceiptId}`, {
          slug,
          accessToken,
        }),
  ]);

  /* A failed pre-fill is not the same as no pre-fill — see the goods-receipt
   * page for what the silent version cost. (PI-24 review.) */
  if (goodsReceiptId !== undefined && !receipt?.data) {
    return (
      <Alert tone="error">
        That delivery could not be loaded, so this return has not been pre-filled. Open it from the
        delivery itself rather than keying it by hand.
      </Alert>
    );
  }

  return (
    <PurchaseReturnForm
      slug={slug}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      locations={locations.data?.locations ?? []}
      receipt={receipt?.data ?? null}
    />
  );
}
