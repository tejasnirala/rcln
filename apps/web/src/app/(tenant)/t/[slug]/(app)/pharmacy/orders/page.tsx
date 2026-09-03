import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { OnlineOrderListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { OnlineOrderList } from '@/components/tenant/online-order-list';
import { pharmacyAccess } from '../guard';

export const metadata: Metadata = { title: 'Deliveries' };

/** ⚠️ PHI: every row names a patient and the town their medicine is going to. */
export default async function OnlineOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await pharmacyAccess(slug);

  if (!access.canReadOrders) {
    return (
      <Alert tone="error">
        You do not have access to deliveries here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of [
    'branchId',
    'status',
    'channel',
    /*
     * ⚠️ NO `patientId` OR `encounterId` HERE. Nothing on this screen produces
     *   them — its filters are branch, status, channel and tracking reference —
     *   so forwarding them bought nothing and made
     *   `alpha.rcln.com/pharmacy/orders?patientId=<uuid>` a bookmarkable,
     *   Referer-leaking, shoulder-readable URL that identifies one patient.
     *   CLAUDE.md: never a patient identifier in a query param. A screen that
     *   genuinely needs this reaches it through the patient's own record.
     *   (PI-24 review.)
     */
    'trackingReference',
    'from',
    'to',
    'page',
  ]) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, orders] = await Promise.all([
    branchesInScope(slug),
    api<OnlineOrderListResponse>(`/api/v1/online-orders?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!orders.ok) {
    return (
      <Alert tone="error">
        {orders.message ?? 'Deliveries could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <Suspense fallback={null}>
      {/*
      ⚠️ SUSPENSE BECAUSE THE CHILD CALLS `useSearchParams`. Next's docs are
         explicit that a STATIC page reading it without a boundary fails the
         production BUILD. This route is dynamic today — its page reads cookies
         through `getSession` — so nothing breaks, but CLAUDE.md forbids
         `pnpm build` as a verification step, which means that trap would be
         sprung by a deploy rather than by anything we run. The boundary costs
         nothing and removes it. (PI-24 review.)
    */}
      <OnlineOrderList
        orders={orders.data?.orders ?? []}
        meta={orders.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
        branches={branches}
        canTakeOrders={access.canManageOrders}
      />
    </Suspense>
  );
}
