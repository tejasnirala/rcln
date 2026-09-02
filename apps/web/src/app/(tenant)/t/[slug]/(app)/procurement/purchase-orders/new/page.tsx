import type { Metadata } from 'next';
import type {
  InventoryLocationListResponse,
  PurchaseRequisitionDetail,
  SupplierListResponse,
  SupplierProductListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PurchaseOrderForm } from '@/components/tenant/purchase-order-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Raise an order' };

/*
 * ⚠️ THE PRODUCT LIST IS NOT FETCHED (PI-23). It was the first hundred stocked
 *   products; a buyer at a clinic with a real catalogue could not reach most of
 *   what they order. The line picker searches instead.
 */
export default async function NewPurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await procurementAccess(slug);

  if (!access.canManageOrders) {
    return <Alert tone="error">You cannot raise purchase orders here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const requisitionId = Array.isArray(query['requisitionId'])
    ? query['requisitionId'][0]
    : query['requisitionId'];

  const [branches, suppliers, locations, priceBook, requisition] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
      slug,
      accessToken,
    }),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations?limit=100', {
      slug,
      accessToken,
    }),
    api<SupplierProductListResponse>('/api/v1/procurement/supplier-products?limit=100', {
      slug,
      accessToken,
    }),
    requisitionId === undefined
      ? Promise.resolve(null)
      : api<PurchaseRequisitionDetail>(`/api/v1/procurement/requisitions/${requisitionId}`, {
          slug,
          accessToken,
        }),
  ]);

  return (
    <PurchaseOrderForm
      slug={slug}
      branches={branches}
      suppliers={suppliers.data?.suppliers ?? []}
      locations={locations.data?.locations ?? []}
      priceBook={priceBook.data?.supplierProducts ?? []}
      requisition={requisition?.data ?? null}
    />
  );
}
