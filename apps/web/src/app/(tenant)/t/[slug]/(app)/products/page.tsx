import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ManufacturerSummary, ProductCategory, ProductListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductList } from '@/components/tenant/product-list';

export const metadata: Metadata = {
  title: 'Catalogue',
};

/**
 * <slug>.rcln.com/products
 *
 * ⚠️ THE LIST IS FETCHED AND PAGINATED ON THE SERVER, AND MUST STAY THAT WAY.
 *   A mature catalogue is tens of thousands of rows. Fetching it into the client
 *   to filter there works perfectly on a demo tenant with forty products and
 *   fails at exactly the clinics that needed the feature — which is the worst
 *   possible place for that failure to first appear. Every filter below is a
 *   query parameter the API applies in SQL.
 *
 * ⚠️ FILTERS LIVE IN THE URL HERE, UNLIKE `/patients`. That screen keeps its
 *   search term out of the query string because the term is a person's surname.
 *   A product name is not PHI and nothing on this page names a patient, so the
 *   catalogue gets what a catalogue should have: linkable and refreshable state.
 *
 * The masters (categories, manufacturers) are fetched alongside the first page
 * rather than on demand — they are small, they are needed before the filter bar
 * can render, and three parallel requests here beat a request waterfall the user
 * watches.
 */
export default async function ProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const search = new URLSearchParams();
  for (const key of [
    'q',
    'type',
    'status',
    'categoryId',
    'manufacturerId',
    'source',
    'page',
  ] as const) {
    const value = query[key];
    // A repeated parameter arrives as an array. Take the first rather than
    // joining, which would send `DRAFT,ACTIVE` to an enum and 400.
    const single = Array.isArray(value) ? value[0] : value;
    if (single) search.set(key, single);
  }

  const [products, categories, manufacturers] = await Promise.all([
    api<ProductListResponse>(`/api/v1/products?${search.toString()}`, { slug, accessToken }),
    api<{ categories: ProductCategory[] }>('/api/v1/product-categories', { slug, accessToken }),
    api<{ manufacturers: ManufacturerSummary[] }>('/api/v1/manufacturers', {
      slug,
      accessToken,
    }),
  ]);

  if (!products.ok) {
    return (
      <Alert tone="error">
        {products.message ?? 'The catalogue could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ProductList
      products={products.data?.products ?? []}
      meta={products.data?.meta ?? { page: 1, limit: 25, total: 0, totalPages: 1 }}
      categories={categories.data?.categories ?? []}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
