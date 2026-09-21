import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductImport } from '@/components/tenant/product-import';

export const metadata: Metadata = {
  title: 'Import a catalogue',
};

/**
 * <slug>.rcln.com/products/import
 *
 * ⚠️ NO MASTER LISTS FETCHED HERE, UNLIKE `products/new`. The import names units,
 *   categories and manufacturers by CODE and the server resolves them, so there
 *   is nothing for this page to pre-load — and pre-loading them would recreate
 *   the capped-list problem PI-23 spent a phase removing.
 *
 * Gated on the same permission as adding one product: an import is four hundred
 * of the same act, not a different one.
 */
export default async function ImportProductsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getSession(slug);

  if (!(session?.permissions ?? []).includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have permission to add products here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Import a catalogue
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Add many products at once from a spreadsheet. Check the file first — nothing is written
          until it comes back clean.
        </p>
      </header>

      <ProductImport slug={slug} />
    </div>
  );
}
