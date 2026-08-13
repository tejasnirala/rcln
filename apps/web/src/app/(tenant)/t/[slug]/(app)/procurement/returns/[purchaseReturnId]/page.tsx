import type { Metadata } from 'next';
import type { PurchaseReturnDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseReturnPanel } from '@/components/tenant/purchase-return-panel';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Return' };

export default async function PurchaseReturnPage({
  params,
}: {
  params: Promise<{ slug: string; purchaseReturnId: string }>;
}) {
  const { slug, purchaseReturnId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canReceive) {
    return <Alert tone="error">You do not have access to returns here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const purchaseReturn = await api<PurchaseReturnDetail>(
    `/api/v1/procurement/returns/${purchaseReturnId}`,
    { slug, accessToken }
  );

  if (!purchaseReturn.ok || !purchaseReturn.data) {
    return (
      <Alert tone="error">{purchaseReturn.message ?? 'That return could not be loaded.'}</Alert>
    );
  }

  return (
    <PurchaseReturnPanel
      slug={slug}
      purchaseReturn={purchaseReturn.data}
      canManage={access.canReceive}
    />
  );
}
