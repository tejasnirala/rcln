import type { Metadata } from 'next';
import type { ProductListResponse, SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RequisitionForm } from '@/components/tenant/requisition-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Ask for stock' };

const PRODUCT_CAP = 100;

export default async function NewRequisitionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await procurementAccess(slug);

  if (!access.canRequisition) {
    return <Alert tone="error">You cannot raise a requisition here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const [branches, products, suppliers] = await Promise.all([
    branchesInScope(slug),
    api<ProductListResponse>(`/api/v1/products?limit=${String(PRODUCT_CAP)}&isStockItem=true`, {
      slug,
      accessToken,
    }),
    /*
     * ⚠️ THE SUPPLIER LIST IS OPTIONAL HERE AND A 403 IS NOT AN ERROR. A storekeeper
     *   holds `procurement.requisition.create` and need not hold
     *   `pharmacy.supplier.manage`, so this legitimately comes back forbidden — and
     *   the field it feeds is a SUGGESTION. Blocking the form on it would stop the
     *   person who is meant to use it from using it.
     */
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
      slug,
      accessToken,
    }),
  ]);

  return (
    <RequisitionForm
      slug={slug}
      branches={branches}
      products={products.data?.products ?? []}
      suppliers={suppliers.data?.suppliers ?? []}
      moreProducts={(products.data?.meta.total ?? 0) > PRODUCT_CAP}
    />
  );
}
