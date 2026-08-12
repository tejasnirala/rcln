import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { StockReservationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import {
  branchesInScope,
  getAccessToken,
  getSession,
  timeFormatOf,
  timezoneOf,
} from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ReservationList } from '@/components/tenant/reservation-list';

export const metadata: Metadata = {
  title: 'Reservations',
};

/**
 * <slug>.rcln.com/stock/reservations
 *
 * ⚠️ `status=ACTIVE` IS THIS SCREEN'S DEFAULT AND NOT THE CONTRACT'S. A released
 *   reservation is history; the useful list is what is being held right now, and
 *   the filter says which one is showing.
 *
 * ⚠️ THE ZONE AND THE CLOCK FORMAT COME FROM THE SESSION, NOT THE BROWSER. Every
 *   `expiresAt` on this screen is an instant stored in UTC, and rendering it
 *   with `toLocaleString()` would give the container's zone on the server and
 *   the laptop's in the browser — two different times for one fact, and a
 *   hydration mismatch besides. Invariant 6.
 *
 * NO PHI. A reservation cites what it is held for, never who for.
 */
export default async function ReservationsPage({
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

  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = new URLSearchParams();
  for (const key of ['branchId', 'productId', 'locationId', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }
  // The screen's default. `status=` in the URL clears it deliberately.
  const status = one('status');
  if (status === undefined) search.set('status', 'ACTIVE');
  else if (status !== '') search.set('status', status);

  const [branches, reservations, timezone, timeFormat] = await Promise.all([
    branchesInScope(slug),
    api<StockReservationListResponse>(`/api/v1/stock/reservations?${search.toString()}`, {
      slug,
      accessToken,
    }),
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  if (!reservations.ok) {
    return (
      <Alert tone="error">
        {reservations.message ?? 'Reservations could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ReservationList
      slug={slug}
      reservations={reservations.data?.reservations ?? []}
      meta={reservations.data?.meta ?? { page: 1, limit: 50, total: 0, totalPages: 1 }}
      branches={branches}
      timezone={timezone}
      timeFormat={timeFormat}
      canReserve={permissions.includes(PERMISSIONS.STOCK_RESERVE)}
    />
  );
}
