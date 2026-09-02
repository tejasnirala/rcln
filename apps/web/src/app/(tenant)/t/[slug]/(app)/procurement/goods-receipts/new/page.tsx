import type { Metadata } from 'next';
import type {
  InventoryLocationListResponse,
  ManufacturerSummary,
  PurchaseOrderDetail,
  SupplierListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { GoodsReceiptForm } from '@/components/tenant/goods-receipt-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Record a delivery' };

/**
 * The scanner-heavy screen, and since PI-23 it actually has a scanner. The one thing
 * that matters is that the LOT, EXPIRY and SERIAL boxes come off the PACK rather than
 * from a lookup, because at this moment the pack is the only authority on them — the
 * scan field fills them from the DataMatrix for exactly that reason, and reports it
 * when the pack and the lot on file disagree.
 *
 * ⚠️ THE PRODUCT LIST IS NO LONGER FETCHED. It was the first hundred stocked products,
 *   which on a real catalogue is a picker that cannot reach the thing being delivered.
 *   The form searches, and a scan skips the search entirely.
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

  const [branches, suppliers, locations, manufacturers, order] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
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
      locations={locations.data?.locations ?? []}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      order={order?.data ?? null}
    />
  );
}
