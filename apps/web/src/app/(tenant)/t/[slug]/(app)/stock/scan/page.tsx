import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import { branchesInScope, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ScanConsole } from '@/components/tenant/scan-console';

export const metadata: Metadata = {
  title: 'Scan',
};

/**
 * <slug>.rcln.com/stock/scan
 *
 * ⚠️ IT FETCHES NOTHING BUT THE BRANCH LIST, AND THAT IS THE DESIGN. Every other
 *   screen in this section loads rows and shows them; this one loads nothing
 *   until somebody scans, because the whole screen is one field and the answer
 *   to whatever was put in it. A pre-loaded list would be a list nobody read.
 *
 * ⚠️ BOTH READ CODES, BECAUSE THE ENDPOINT NEEDS BOTH. `GET /stock/resolve`
 *   answers a catalogue question and a stock question in one round trip and is
 *   gated on `inventory.stock.read` AND `product.definition.read`. Checking only
 *   one here would render a working screen whose every scan came back 403.
 */
export default async function ScanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (
    !permissions.includes(PERMISSIONS.STOCK_READ) ||
    !permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)
  ) {
    return (
      <Alert tone="error">
        Scanning needs access to both stock and the product catalogue. Ask an administrator at this
        clinic.
      </Alert>
    );
  }

  return <ScanConsole slug={slug} branches={await branchesInScope(slug)} />;
}
