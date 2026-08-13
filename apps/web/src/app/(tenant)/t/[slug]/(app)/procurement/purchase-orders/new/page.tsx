import type { Metadata } from 'next';
import type {
  InventoryLocationListResponse,
  ProductListResponse,
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

const PRODUCT_CAP = 100;

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

  const [branches, suppliers, products, locations, priceBook, requisition] = await Promise.all([
    branchesInScope(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100&status=ACTIVE', {
      slug,
      accessToken,
    }),
    api<ProductListResponse>(`/api/v1/products?limit=${String(PRODUCT_CAP)}&isStockItem=true`, {
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
      products={products.data?.products ?? []}
      locations={locations.data?.locations ?? []}
      priceBook={priceBook.data?.supplierProducts ?? []}
      requisition={requisition?.data ?? null}
      moreProducts={(products.data?.meta.total ?? 0) > PRODUCT_CAP}
    />
  );
}
