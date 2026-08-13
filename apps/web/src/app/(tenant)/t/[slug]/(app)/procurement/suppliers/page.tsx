import type { Metadata } from 'next';
import type { SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SupplierList } from '@/components/tenant/supplier-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Suppliers' };

/**
 * <slug>.rcln.com/procurement/suppliers
 *
 * ⚠️ THE FILTERS COME FROM THE URL AND DRIVE THE FETCH. Nothing here filters an
 *   in-memory array — the rows are one server-rendered page of a query the API ran in
 *   SQL, exactly as the stock and catalogue screens do.
 *
 * NO PHI.
 */
export default async function SuppliersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canManageSuppliers) {
    return (
      <Alert tone="error">
        You do not have access to suppliers here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['status', 'q', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const suppliers = await api<SupplierListResponse>(
    `/api/v1/procurement/suppliers?${search.toString()}`,
    { slug, accessToken }
  );

  if (!suppliers.ok) {
    return (
      <Alert tone="error">
        {suppliers.message ?? 'Suppliers could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <SupplierList
      suppliers={suppliers.data?.suppliers ?? []}
      meta={suppliers.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      canManage={access.canManageSuppliers}
    />
  );
}
