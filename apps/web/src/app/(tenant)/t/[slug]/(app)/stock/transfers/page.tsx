import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { StockTransferListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TransferList } from '@/components/tenant/transfer-list';

export const metadata: Metadata = {
  title: 'Transfers',
};

/**
 * <slug>.rcln.com/stock/transfers
 *
 * ⚠️ `outstandingOnly` DEFAULTS TO TRUE HERE AND NOT IN THE CONTRACT. The API
 *   defaults it to false, which is the right default for a general-purpose
 *   endpoint that PI-4 and PI-7 will also call. This SCREEN is opened by a
 *   person asking "where is my delivery", so its default is the answer to that
 *   question, and the filter says which one is showing.
 *
 * ⚠️ AND THE FILTERS COME FROM THE URL AND DRIVE THE FETCH. Nothing here filters
 *   an in-memory array — the rows are one server-rendered page of a query the
 *   API ran in SQL, exactly as the lots and catalogue screens do.
 *
 * NO PHI on this screen.
 */
export default async function TransfersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
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
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['fromBranchId', 'toBranchId', 'status', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }
  // The screen's default, stated rather than inherited. See the header.
  search.set('outstandingOnly', one('outstandingOnly') ?? 'true');

  const [branches, transfers] = await Promise.all([
    branchesInScope(slug),
    api<StockTransferListResponse>(`/api/v1/stock-transfers?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!transfers.ok) {
    return (
      <Alert tone="error">
        {transfers.message ?? 'Transfers could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <TransferList
      transfers={transfers.data?.transfers ?? []}
      meta={transfers.data?.meta ?? { page: 1, limit: 50, total: 0, totalPages: 1 }}
      branches={branches}
      canTransfer={permissions.includes(PERMISSIONS.STOCK_TRANSFER)}
    />
  );
}
