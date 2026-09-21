import type { Metadata } from 'next';
import type {
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
 * ⚠️ THE PRODUCT PICKER SEARCHES NOW (PI-23) AND THIS PAGE FETCHES NO CATALOGUE.
 *   It used to send the first hundred stocked products and say so on screen —
 *   an honest cap, but one that still let a buyer conclude the clinic does not
 *   stock something. Nothing is fetched until somebody types.
 */
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

  const [supplier, priceBook, units] = await Promise.all([
    api<SupplierDetail>(`/api/v1/procurement/suppliers/${supplierId}`, { slug, accessToken }),
    api<SupplierProductListResponse>(
      `/api/v1/procurement/supplier-products?supplierId=${supplierId}&limit=100`,
      { slug, accessToken }
    ),
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
      units={units.data?.units ?? []}
      canManage={access.canManageSuppliers}
    />
  );
}
