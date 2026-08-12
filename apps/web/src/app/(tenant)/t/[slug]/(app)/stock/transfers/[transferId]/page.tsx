import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PERMISSIONS } from '@rcln/permissions';
import type { InventoryLocationListResponse, StockTransferDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import {
  branchesInScope,
  getAccessToken,
  getSession,
  timeFormatOf,
  timezoneOf,
} from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TransferDetail } from '@/components/tenant/transfer-detail';

export const metadata: Metadata = {
  title: 'Transfer',
};

/**
 * <slug>.rcln.com/stock/transfers/<id>
 *
 * ⚠️ WHICH ACTION THIS PERSON GETS IS DECIDED FROM THEIR BRANCH SCOPE, AND THE
 *   API DECIDES IT AGAIN. The sender sends, the receiver signs for it, and the
 *   list of branch ids passed down is what stops a receiving storekeeper being
 *   offered a "Send" button whose movements RLS will not let them write. It is a
 *   convenience, never the control — every one of those endpoints asserts the
 *   branch itself and returns 404 when it is out of scope.
 *
 * ⚠️ 404 ON A TRANSFER BETWEEN TWO BRANCHES THIS PERSON DOES NOT WORK AT, WHICH
 *   IS THE POLICY DOING ITS JOB RATHER THAN AN ERROR. `transfer_branch_isolation`
 *   is `from OR to`, so a third site's document is simply not there.
 *
 * NO PHI.
 */
export default async function TransferPage({
  params,
}: {
  params: Promise<{ slug: string; transferId: string }>;
}) {
  const { slug, transferId } = await params;
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

  const [transfer, locations, branches, timezone, timeFormat] = await Promise.all([
    api<StockTransferDetail>(`/api/v1/stock-transfers/${transferId}`, { slug, accessToken }),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', { slug, accessToken }),
    branchesInScope(slug),
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  if (!transfer.ok || !transfer.data) {
    if (transfer.status === 404) notFound();
    return (
      <Alert tone="error">
        {transfer.message ?? 'This transfer could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <TransferDetail
      slug={slug}
      transfer={transfer.data}
      locations={locations.data?.locations ?? []}
      timezone={timezone}
      timeFormat={timeFormat}
      branchIds={branches.map((b) => b.id)}
      canTransfer={permissions.includes(PERMISSIONS.STOCK_TRANSFER)}
    />
  );
}
