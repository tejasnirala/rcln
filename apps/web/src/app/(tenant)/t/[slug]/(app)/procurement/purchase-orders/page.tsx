import type { Metadata } from 'next';
import type { PurchaseOrderListResponse, SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseOrderList } from '@/components/tenant/purchase-order-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Purchase orders' };

/**
 * ⚠️ `outstandingOnly` DEFAULTS TO TRUE HERE AND NOT IN THE CONTRACT. The API defaults
 *   it to false, which is right for a general-purpose endpoint; this SCREEN is opened
 *   by somebody asking "what has not arrived", so its default answers that and the
 *   filter says which one is showing. Same split `/stock/transfers` makes.
 */
export default async function PurchaseOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canReadOrders) {
    return (
      <Alert tone="error">
        You do not have access to purchase orders here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['branchId', 'supplierId', 'status', 'q', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }
  search.set('outstandingOnly', one('outstandingOnly') ?? 'true');

  const [branches, orders, suppliers] = await Promise.all([
    branchesInScope(slug),
    api<PurchaseOrderListResponse>(`/api/v1/procurement/purchase-orders?${search.toString()}`, {
      slug,
      accessToken,
    }),
    // Optional: a caller may read orders without holding `supplier.manage`, and the
    // filter it feeds is a convenience.
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
  ]);

  if (!orders.ok) {
    return (
      <Alert tone="error">
        {orders.message ?? 'Purchase orders could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <PurchaseOrderList
      purchaseOrders={orders.data?.purchaseOrders ?? []}
      meta={orders.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      canManage={access.canManageOrders}
    />
  );
}
