import type { Metadata } from 'next';
import type { SupplierListResponse, SupplierProductListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PriceBookList } from '@/components/tenant/price-book-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Price book' };

export default async function PriceBookPage({
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
    return <Alert tone="error">You do not have access to the price book here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['supplierId', 'productId', 'q', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [priceBook, suppliers] = await Promise.all([
    api<SupplierProductListResponse>(`/api/v1/procurement/supplier-products?${search.toString()}`, {
      slug,
      accessToken,
    }),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
      slug,
      accessToken,
    }),
  ]);

  if (!priceBook.ok) {
    return (
      <Alert tone="error">
        {priceBook.message ?? 'The price book could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <PriceBookList
      supplierProducts={priceBook.data?.supplierProducts ?? []}
      meta={priceBook.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      suppliers={suppliers.data?.suppliers ?? []}
    />
  );
}
