import type { Metadata } from 'next';
import type { GoodsReceiptListResponse, SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { GoodsReceiptList } from '@/components/tenant/goods-receipt-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Deliveries' };

export default async function GoodsReceiptsPage({
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
        You do not have access to deliveries here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of [
    'branchId',
    'supplierId',
    'purchaseOrderId',
    'status',
    'awaitingQuality',
    'q',
    'page',
  ]) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, receipts, suppliers] = await Promise.all([
    branchesInScope(slug),
    api<GoodsReceiptListResponse>(`/api/v1/procurement/goods-receipts?${search.toString()}`, {
      slug,
      accessToken,
    }),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
  ]);

  if (!receipts.ok) {
    return (
      <Alert tone="error">
        {receipts.message ?? 'Deliveries could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <GoodsReceiptList
      goodsReceipts={receipts.data?.goodsReceipts ?? []}
      meta={receipts.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      canManage={access.canReceive}
    />
  );
}
