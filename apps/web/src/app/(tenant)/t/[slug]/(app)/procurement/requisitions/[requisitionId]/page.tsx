import type { Metadata } from 'next';
import type { PurchaseRequisitionDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RequisitionPanel } from '@/components/tenant/requisition-panel';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Requisition' };

export default async function RequisitionPage({
  params,
}: {
  params: Promise<{ slug: string; requisitionId: string }>;
}) {
  const { slug, requisitionId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canRequisition) {
    return <Alert tone="error">You do not have access to requisitions here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const requisition = await api<PurchaseRequisitionDetail>(
    `/api/v1/procurement/requisitions/${requisitionId}`,
    { slug, accessToken }
  );

  if (!requisition.ok || !requisition.data) {
    return (
      <Alert tone="error">{requisition.message ?? 'That requisition could not be loaded.'}</Alert>
    );
  }

  return (
    <RequisitionPanel
      slug={slug}
      requisition={requisition.data}
      canCreate={access.canRequisition}
      canApprove={access.canApprove}
      canOrder={access.canManageOrders}
    />
  );
}
