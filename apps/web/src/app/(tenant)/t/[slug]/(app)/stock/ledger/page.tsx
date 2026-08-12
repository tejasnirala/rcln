import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { StockLedgerListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timeFormatOf, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { StockLedgerView } from '@/components/tenant/stock-ledger-view';

export const metadata: Metadata = {
  title: 'Movements',
};

/**
 * <slug>.rcln.com/stock/ledger
 *
 * ⚠️ THE ZONE AND THE FORMAT ARE RESOLVED HERE AND PASSED DOWN, NEVER READ FROM
 *   THE BROWSER (invariant 6). A movement timestamped 23:40 in Kolkata is 18:10
 *   the previous day in UTC, and a ledger that renders the container's or the
 *   laptop's zone puts movements on the wrong day for anyone reconciling a
 *   shift. `timezoneOf` and `timeFormatOf` are the same pair every other
 *   clinical screen uses.
 *
 * NO PHI. A movement names ids, quantities and places.
 */
export default async function StockLedgerPage({
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
  for (const key of [
    'branchId',
    'productId',
    'batchId',
    'locationId',
    'movementType',
    'from',
    'to',
    'page',
  ] as const) {
    const value = query[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) search.set(key, single);
  }

  // Three independent reads, so they go together rather than in a waterfall the
  // user watches.
  const [movements, timezone, timeFormat] = await Promise.all([
    api<StockLedgerListResponse>(`/api/v1/stock/ledger?${search.toString()}`, {
      slug,
      accessToken,
    }),
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  if (!movements.ok) {
    return (
      <Alert tone="error">
        {movements.message ?? 'Movements could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <StockLedgerView
      movements={movements.data?.movements ?? []}
      meta={movements.data?.meta ?? { page: 1, limit: 50, total: 0, totalPages: 1 }}
      timezone={timezone}
      timeFormat={timeFormat}
    />
  );
}
