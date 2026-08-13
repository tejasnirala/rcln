import type { Metadata } from 'next';
import type {
  ProductListResponse,
  SupplierDetail,
  SupplierProductListResponse,
  UnitListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SupplierPanel } from '@/components/tenant/supplier-panel';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Supplier' };

/**
 * ⚠️ THE PRODUCT PICKER IS CAPPED AT 100 AND THE SCREEN SAYS SO. Same cap the stock
 *   forms carry, and the same reason: searching the whole catalogue from a form comes
 *   with the barcode resolver in PI-23. A silent cap would let a buyer conclude the
 *   clinic does not stock something.
 */
const PRODUCT_CAP = 100;

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ slug: string; supplierId: string }>;
}) {
  const { slug, supplierId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canManageSuppliers) {
    return <Alert tone="error">You do not have access to suppliers here.</Alert>;
  }

  const accessToken = await getAccessToken();

  const [supplier, priceBook, products, units] = await Promise.all([
    api<SupplierDetail>(`/api/v1/procurement/suppliers/${supplierId}`, { slug, accessToken }),
    api<SupplierProductListResponse>(
      `/api/v1/procurement/supplier-products?supplierId=${supplierId}&limit=100`,
      { slug, accessToken }
    ),
    api<ProductListResponse>(`/api/v1/products?limit=${String(PRODUCT_CAP)}&isStockItem=true`, {
      slug,
      accessToken,
    }),
    api<UnitListResponse>('/api/v1/units?limit=100', { slug, accessToken }),
  ]);

  if (!supplier.ok || !supplier.data) {
    return <Alert tone="error">{supplier.message ?? 'That supplier could not be loaded.'}</Alert>;
  }

  return (
    <SupplierPanel
      slug={slug}
      supplier={supplier.data}
      priceBook={priceBook.data?.supplierProducts ?? []}
      products={products.data?.products ?? []}
      units={units.data?.units ?? []}
      canManage={access.canManageSuppliers}
      moreProducts={(products.data?.meta.total ?? 0) > PRODUCT_CAP}
    />
  );
}
