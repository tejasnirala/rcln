import type { Metadata } from 'next';
import type { PurchaseOrderDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseOrderPanel } from '@/components/tenant/purchase-order-panel';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Purchase order' };

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ slug: string; purchaseOrderId: string }>;
}) {
  const { slug, purchaseOrderId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canReadOrders) {
    return <Alert tone="error">You do not have access to purchase orders here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const order = await api<PurchaseOrderDetail>(
    `/api/v1/procurement/purchase-orders/${purchaseOrderId}`,
    { slug, accessToken }
  );

  if (!order.ok || !order.data) {
    return <Alert tone="error">{order.message ?? 'That order could not be loaded.'}</Alert>;
  }

  return (
    <PurchaseOrderPanel
      slug={slug}
      order={order.data}
      canManage={access.canManageOrders}
      canReceive={access.canReceive}
    />
  );
}
