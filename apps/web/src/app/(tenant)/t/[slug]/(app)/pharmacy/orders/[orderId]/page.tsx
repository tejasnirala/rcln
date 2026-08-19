import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { OnlineOrderDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timezoneOfBranch, timeFormatOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { OnlineOrderDetailScreen } from '@/components/tenant/online-order-detail';
import { pharmacyAccess } from '../../guard';

export const metadata: Metadata = { title: 'Delivery' };

/**
 * One order.
 *
 * ⚠️ PHI, AND THE DENSEST ON THIS SURFACE: a name, a telephone number, a home
 *   address and a medicine on one page. Opening it writes a `data_access_logs`
 *   row under `ONLINE_ORDER`.
 *
 * ⚠️ THE ZONE IS THE FULFILLING BRANCH'S, NOT THE CLINIC DEFAULT. A group whose
 *   satellite is in another zone would otherwise show "handed to the courier" an
 *   hour out at the site that did it (invariant 6).
 */
export default async function OnlineOrderPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canReadOrders) {
    return (
      <Alert tone="error">
        You do not have access to deliveries here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  /*
   * ⚠️ `timeFormatOf` DOES NOT DEPEND ON THE ORDER, SO IT DOES NOT WAIT BEHIND IT
   *   (PI-12 review). Only `timezoneOfBranch` needs `branchId`, which is a
   *   genuine dependency. The order fetch DOES wait on `pharmacyAccess` above,
   *   and that one is deliberate: it is a permission gate in front of a PHI
   *   read, not a waterfall.
   */
  const [accessToken, timeFormat] = await Promise.all([getAccessToken(), timeFormatOf(slug)]);
  const order = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}`, {
    slug,
    accessToken,
  });

  if (!order.ok || !order.data) {
    if (order.status === 404) notFound();
    return (
      <Alert tone="error">
        {order.message ?? 'That order could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  const timezone = await timezoneOfBranch(slug, order.data.branchId);

  return (
    <OnlineOrderDetailScreen
      slug={slug}
      order={order.data}
      timezone={timezone}
      timeFormat={timeFormat}
      canManage={access.canManageOrders}
      canDispense={access.canDispense}
      canDispatch={access.canDispatchOrders}
    />
  );
}
