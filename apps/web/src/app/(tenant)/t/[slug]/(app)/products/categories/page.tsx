import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ProductCategory } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductCategoryList } from '@/components/tenant/product-category-list';

export const metadata: Metadata = { title: 'Categories' };

/**
 * <slug>.rcln.com/products/categories
 *
 * The API returns the tree already flattened and in order, each row carrying its
 * `depth` — so nothing here re-nests it. See the note on the list component.
 *
 * NO PHI.
 */
export default async function CategoriesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const categories = await api<{ categories: ProductCategory[] }>(
    '/api/v1/product-categories?includeInactive=true',
    { slug, accessToken: await getAccessToken() }
  );

  if (!categories.ok) {
    return (
      <Alert tone="error">
        {categories.message ?? 'Categories could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ProductCategoryList
      slug={slug}
      categories={categories.data?.categories ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
