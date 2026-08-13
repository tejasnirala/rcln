import type { Metadata } from 'next';
import type { ProductCostAverageListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { CostAverageList } from '@/components/tenant/cost-average-list';
import { procurementAccess } from '../guard';

export const metadata: Metadata = { title: 'Costs' };

/**
 * ⚠️ GATED ON `inventory.stock.read` AND NOT A PURCHASING CODE. What stock is worth is
 *   a stock question, read by people who never raise an order; gating it behind
 *   `purchase_order.read` would mean a storekeeper counting a shelf cannot see what is
 *   on it is worth. Matches the route.
 */
export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canReadStock) {
    return <Alert tone="error">You do not have access to stock costs here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['branchId', 'productId', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, costs] = await Promise.all([
    branchesInScope(slug),
    api<ProductCostAverageListResponse>(`/api/v1/procurement/cost-averages?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!costs.ok) {
    return (
      <Alert tone="error">
        {costs.message ?? 'Costs could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <CostAverageList
      costAverages={costs.data?.costAverages ?? []}
      meta={costs.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
    />
  );
}
