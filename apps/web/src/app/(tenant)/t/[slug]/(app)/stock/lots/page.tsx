import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { BatchListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LotList } from '@/components/tenant/lot-list';

export const metadata: Metadata = {
  title: 'Lots',
};

/**
 * <slug>.rcln.com/stock/lots
 *
 * Paginated in SQL, like every list in this application. `batches` grows by one
 * row per delivery per product per site and is never pruned — a lot has to stay
 * answerable long after its stock is gone, because a recall asks about lots that
 * were fully dispensed years ago.
 */
export default async function LotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.STOCK_READ)) {
    return (
      <Alert tone="error">
        You do not have access to stock here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const search = new URLSearchParams();
  for (const key of ['q', 'status', 'branchId', 'productId', 'page'] as const) {
    const value = query[key];
    // A repeated parameter arrives as an array. Take the first rather than
    // joining, which would send `ACTIVE,EXPIRED` to an enum and 400.
    const single = Array.isArray(value) ? value[0] : value;
    if (single) search.set(key, single);
  }

  const batches = await api<BatchListResponse>(`/api/v1/batches?${search.toString()}`, {
    slug,
    accessToken,
  });

  if (!batches.ok) {
    return (
      <Alert tone="error">
        {batches.message ?? 'Lots could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <LotList
      batches={batches.data?.batches ?? []}
      meta={batches.data?.meta ?? { page: 1, limit: 25, total: 0, totalPages: 1 }}
      canManage={permissions.includes(PERMISSIONS.BATCH_MANAGE)}
    />
  );
}
