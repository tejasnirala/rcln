import type { Metadata } from 'next';
import type {
  InventoryLocationListResponse,
  ManufacturerSummary,
  ProductListResponse,
  PurchaseOrderDetail,
  SupplierListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { GoodsReceiptForm } from '@/components/tenant/goods-receipt-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Record a delivery' };

const PRODUCT_CAP = 100;

/**
 * The scanner-heavy screen. Everything it fetches is a picker; the one thing that
 * matters is that the LOT, EXPIRY and SERIAL boxes are typed off the pack rather than
 * looked up, because at this moment the pack is the only authority on them.
 */
export default async function NewGoodsReceiptPage({
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
    return <Alert tone="error">You cannot record deliveries here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const purchaseOrderId = Array.isArray(query['purchaseOrderId'])
    ? query['purchaseOrderId'][0]
    : query['purchaseOrderId'];

  const [branches, suppliers, products, locations, manufacturers, order] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
      slug,
      accessToken,
    }),
    api<ProductListResponse>(`/api/v1/products?limit=${String(PRODUCT_CAP)}&isStockItem=true`, {
      slug,
      accessToken,
    }),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
    api<{ manufacturers: ManufacturerSummary[] }>('/api/v1/manufacturers', {
      slug,
      accessToken,
    }),
    purchaseOrderId === undefined
      ? Promise.resolve(null)
      : api<PurchaseOrderDetail>(`/api/v1/procurement/purchase-orders/${purchaseOrderId}`, {
          slug,
          accessToken,
        }),
  ]);

  return (
    <GoodsReceiptForm
      slug={slug}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      products={products.data?.products ?? []}
      locations={locations.data?.locations ?? []}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      order={order?.data ?? null}
      moreProducts={(products.data?.meta.total ?? 0) > PRODUCT_CAP}
    />
  );
}
