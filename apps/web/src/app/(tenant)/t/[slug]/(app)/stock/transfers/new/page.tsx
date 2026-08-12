import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type {
  BatchListResponse,
  InventoryLocationListResponse,
  ProductListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TransferForm } from '@/components/tenant/transfer-form';

export const metadata: Metadata = {
  title: 'Move stock',
};

/** How many products the picker offers before it admits it is showing a page. */
const PICKER_LIMIT = 100;

/**
 * <slug>.rcln.com/stock/transfers/new
 *
 * ⚠️ FOUR PARALLEL READS, NOT A WATERFALL. The branches, shelves, products and
 *   lots are four independent questions, and chaining them is a delay the user
 *   watches for no reason. Same shape as the overview.
 *
 * ⚠️ THE LOT LIST IS CAPPED AND FILTERED TO STOCK ON HAND. A transfer of a lot
 *   with nothing left is a movement the ledger refuses under its bucket lock,
 *   with a 409 that reads correctly and arrives after the form was filled in.
 *   `onlyWithStock` is the honest picker.
 *
 * NO PHI.
 */
export default async function NewTransferPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.STOCK_TRANSFER)) {
    return (
      <Alert tone="error">You cannot move stock here. Ask an administrator at this clinic.</Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [branches, locations, products, batches] = await Promise.all([
    branchesInScope(slug),
    api<InventoryLocationListResponse>('/api/v1/inventory-locations', { slug, accessToken }),
    api<ProductListResponse>(
      `/api/v1/products?isStockItem=true&status=ACTIVE&limit=${String(PICKER_LIMIT)}`,
      { slug, accessToken }
    ),
    api<BatchListResponse>('/api/v1/batches?onlyWithStock=true&status=ACTIVE&limit=200', {
      slug,
      accessToken,
    }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return (
    <TransferForm
      slug={slug}
      branches={branches}
      locations={locations.data?.locations ?? []}
      products={products.data?.products ?? []}
      batches={batches.data?.batches ?? []}
      moreProducts={(products.data?.meta.total ?? 0) > (products.data?.products.length ?? 0)}
    />
  );
}
