import type { Metadata } from 'next';
import type { GoodsReceiptDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { GoodsReceiptPanel } from '@/components/tenant/goods-receipt-panel';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Delivery' };

export default async function GoodsReceiptPage({
  params,
}: {
  params: Promise<{ slug: string; goodsReceiptId: string }>;
}) {
  const { slug, goodsReceiptId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canReceive) {
    return <Alert tone="error">You do not have access to deliveries here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const receipt = await api<GoodsReceiptDetail>(
    `/api/v1/procurement/goods-receipts/${goodsReceiptId}`,
    { slug, accessToken }
  );

  if (!receipt.ok || !receipt.data) {
    return <Alert tone="error">{receipt.message ?? 'That delivery could not be loaded.'}</Alert>;
  }

  return <GoodsReceiptPanel slug={slug} receipt={receipt.data} canManage={access.canReceive} />;
}
