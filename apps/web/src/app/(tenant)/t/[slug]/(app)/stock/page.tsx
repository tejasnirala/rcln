import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ExpiryReportResponse, StockBalanceListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { StockOverview } from '@/components/tenant/stock-overview';

export const metadata: Metadata = {
  title: 'Stock',
};

/**
 * <slug>.rcln.com/stock
 *
 * ⚠️ BOTH PANELS ARE FETCHED IN PARALLEL, NOT IN SEQUENCE. They are independent
 *   questions and a waterfall here is one the user watches — the expiry report
 *   and the balance page have nothing to say to each other.
 *
 * ⚠️ AND BOTH ARE PAGINATED BY THE API. `stock_balances` has a row per product,
 *   per lot, per shelf, per condition; a clinic with four thousand products has
 *   tens of thousands of them. There is no "load everything" mode on this screen
 *   and there must not be one.
 *
 * NO PHI. Nothing on this page names a patient.
 */
export default async function StockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
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

  const [expiring, balances] = await Promise.all([
    api<ExpiryReportResponse>('/api/v1/stock/expiring?limit=25', { slug, accessToken }),
    api<StockBalanceListResponse>('/api/v1/stock/balances?limit=50', { slug, accessToken }),
  ]);

  if (!expiring.ok || !balances.ok) {
    return (
      <Alert tone="error">
        {expiring.message ??
          balances.message ??
          'Stock could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <StockOverview
      expiring={expiring.data ?? { windowDays: 90, rows: [] }}
      balances={
        balances.data ?? {
          balances: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
        }
      }
    />
  );
}
