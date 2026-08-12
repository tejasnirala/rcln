import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { SerialListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SerialList } from '@/components/tenant/serial-list';

export const metadata: Metadata = {
  title: 'Serials',
};

/**
 * <slug>.rcln.com/stock/serials
 *
 * ⚠️ THE ONE PHI SURFACE IN THIS SECTION. The API writes a `data_access_logs`
 *   row for this read whenever the page actually contains an assignment — the
 *   disclosure is the same whether it was asked for narrowly or fell out of a
 *   broad list. The screen renders that a device is assigned and never to whom.
 */
export default async function SerialsPage({
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
    const single = Array.isArray(value) ? value[0] : value;
    if (single) search.set(key, single);
  }

  const serials = await api<SerialListResponse>(`/api/v1/serials?${search.toString()}`, {
    slug,
    accessToken,
  });

  if (!serials.ok) {
    return (
      <Alert tone="error">
        {serials.message ?? 'Serials could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <SerialList
      serials={serials.data?.serials ?? []}
      meta={serials.data?.meta ?? { page: 1, limit: 25, total: 0, totalPages: 1 }}
      canManage={permissions.includes(PERMISSIONS.BATCH_MANAGE)}
    />
  );
}
