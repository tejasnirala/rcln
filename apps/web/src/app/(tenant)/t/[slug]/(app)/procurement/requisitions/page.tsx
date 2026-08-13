import type { Metadata } from 'next';
import type { PurchaseRequisitionListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RequisitionList } from '@/components/tenant/requisition-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Requisitions' };

/**
 * ⚠️ GATED ON `.create` AND NOT `.approve`, MATCHING THE ROUTE. Both participants in
 *   the flow have to be able to read the list — a storekeeper to see what they asked
 *   for, an approver to see what they are approving — and `.create` is the wider of
 *   the two codes.
 */
export default async function RequisitionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canRequisition) {
    return (
      <Alert tone="error">
        You do not have access to requisitions here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['branchId', 'status', 'awaitingApproval', 'q', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, requisitions] = await Promise.all([
    branchesInScope(slug),
    api<PurchaseRequisitionListResponse>(`/api/v1/procurement/requisitions?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!requisitions.ok) {
    return (
      <Alert tone="error">
        {requisitions.message ?? 'Requisitions could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <RequisitionList
      requisitions={requisitions.data?.requisitions ?? []}
      meta={requisitions.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
      canCreate={access.canRequisition}
    />
  );
}
