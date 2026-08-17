import type { Metadata } from 'next';
import type { ProductPriceListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductPriceList } from '@/components/tenant/product-price-list';
import { chargesAccess } from '../guard';

export const metadata: Metadata = { title: 'Prices' };

/** Not PHI: a price is a fact about a catalogue row, so nothing here logs a read. */
export default async function ChargePricesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await chargesAccess(slug);

  if (!access.canReadPrices) {
    return (
      <Alert tone="error">
        You do not have access to prices here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  for (const key of ['branchId', 'productId', 'page']) {
    const value = query[key];
    const one = Array.isArray(value) ? value[0] : value;
    if (one) search.set(key, one);
  }

  const [branches, prices] = await Promise.all([
    branchesInScope(slug),
    api<ProductPriceListResponse>(`/api/v1/charging/prices?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!prices.ok || !prices.data) {
    return (
      <Alert tone="error">
        {prices.message ?? 'Prices could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ProductPriceList
      slug={slug}
      prices={prices.data}
      branches={branches}
      canManage={access.canManagePrices}
    />
  );
}
