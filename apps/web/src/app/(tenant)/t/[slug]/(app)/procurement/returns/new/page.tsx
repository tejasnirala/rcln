import type { Metadata } from 'next';
import type {
  GoodsReceiptDetail,
  InventoryLocationListResponse,
  ProductListResponse,
  SupplierListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseReturnForm } from '@/components/tenant/purchase-return-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Send stock back' };

const PRODUCT_CAP = 100;

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

  const [branches, suppliers, products, locations, receipt] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
    api<ProductListResponse>(`/api/v1/products?limit=${String(PRODUCT_CAP)}&isStockItem=true`, {
      slug,
      accessToken,
    }),
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

  return (
    <PurchaseReturnForm
      slug={slug}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      products={products.data?.products ?? []}
      locations={locations.data?.locations ?? []}
      receipt={receipt?.data ?? null}
      moreProducts={(products.data?.meta.total ?? 0) > PRODUCT_CAP}
    />
  );
}
