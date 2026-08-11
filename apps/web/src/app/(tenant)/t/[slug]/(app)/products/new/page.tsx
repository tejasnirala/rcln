import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type {
  ManufacturerSummary,
  ProductCategory,
  StorageProfileSummary,
  UnitListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductCreateForm } from '@/components/tenant/product-create-form';

export const metadata: Metadata = {
  title: 'Add a product',
};

/**
 * <slug>.rcln.com/products/new
 *
 * The four master lists are fetched in PARALLEL on the server and handed to the
 * form as props. Fetching them from the client on mount would give the user four
 * empty selects and a request waterfall to watch; they are small and the form
 * cannot be used without any of them.
 */
export default async function NewProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have permission to add products here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [units, categories, manufacturers, storageProfiles] = await Promise.all([
    api<UnitListResponse>('/api/v1/units', { slug, accessToken }),
    api<{ categories: ProductCategory[] }>('/api/v1/product-categories', { slug, accessToken }),
    api<{ manufacturers: ManufacturerSummary[] }>('/api/v1/manufacturers', { slug, accessToken }),
    api<{ profiles: StorageProfileSummary[] }>('/api/v1/storage-profiles', { slug, accessToken }),
  ]);

  /*
   * A product cannot exist without a base unit, so an empty unit list is a
   * blocked screen rather than a form with one empty select. It means the seed
   * has not run against this database — worth saying plainly rather than letting
   * someone fill in nine fields and fail on submit.
   */
  if (!units.ok || (units.data?.units.length ?? 0) === 0) {
    return (
      <Alert tone="error">
        No units of measure are available, so a product cannot be created yet. The platform
        catalogue of units has not been loaded for this environment.
      </Alert>
    );
  }

  return (
    <ProductCreateForm
      slug={slug}
      units={units.data?.units ?? []}
      categories={categories.data?.categories ?? []}
      manufacturers={manufacturers.data?.manufacturers ?? []}
      storageProfiles={storageProfiles.data?.profiles ?? []}
    />
  );
}
