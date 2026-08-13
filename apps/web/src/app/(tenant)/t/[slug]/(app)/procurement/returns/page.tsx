import type { Metadata } from 'next';
import type { PurchaseReturnListResponse, SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseReturnList } from '@/components/tenant/purchase-return-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Returns' };

export default async function ReturnsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canReceive) {
    return (
      <Alert tone="error">
        You do not have access to returns here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['branchId', 'supplierId', 'status', 'q', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, returns, suppliers] = await Promise.all([
    branchesInScope(slug),
    api<PurchaseReturnListResponse>(`/api/v1/procurement/returns?${search.toString()}`, {
      slug,
      accessToken,
    }),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
  ]);

  if (!returns.ok) {
    return (
      <Alert tone="error">
        {returns.message ?? 'Returns could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <PurchaseReturnList
      purchaseReturns={returns.data?.purchaseReturns ?? []}
      meta={returns.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      canManage={access.canReceive}
    />
  );
}
