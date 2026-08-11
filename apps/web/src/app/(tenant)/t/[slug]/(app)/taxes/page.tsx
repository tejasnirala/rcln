import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TaxRateCard } from '@/components/tenant/tax-rate-card';
import { loadRateCard, loadRules } from './actions';

export const metadata: Metadata = {
  title: 'Tax',
};

/**
 * <slug>.rcln.com/taxes — what this clinic charges, and under which registration.
 *
 * ⚠️ THE FIRST SCREEN `issuer_tax_registrations` AND `tax_rules` HAVE EVER HAD.
 *   Phase 2 created both tables and the engine has read them since; nothing wrote
 *   to either, so every clinic on the platform has been running entirely on
 *   rcln's published catalogue. That is a defensible default and it is not a
 *   configuration — a clinic below the registration threshold issues invoices with
 *   no tax and no registration, and until now one ABOVE it had no way to say so.
 *
 * ⚠️ AND IT IS NOT PHI. A rate names a category, a rate and a jurisdiction; no
 *   patient and no invoice. Nothing here writes a `data_access_logs` row, and the
 *   WRITES are audited instead — who changed the rate the clinic bills at is the
 *   question an auditor asks.
 */
export default async function TaxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ history?: string }>;
}) {
  const { slug } = await params;
  const { history } = await searchParams;

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.BILLING_TAX_READ)) {
    return (
      <Alert tone="error">
        You do not have access to this clinic&rsquo;s tax settings. Ask an administrator at this
        clinic.
      </Alert>
    );
  }

  /*
   * Lapsed rules are asked for through the URL, not held in component state: it
   * is a second read, and a date range discloses nobody. Same rule as the invoice
   * ledger's filters.
   */
  const showHistory = history === 'true';

  const [card, rules] = await Promise.all([
    loadRateCard(slug),
    // Every rule the clinic wrote, which is a different list from the card: the
    // card is what APPLIES, and this is what the clinic has authored, lapsed rows
    // included when asked for.
    loadRules(slug, showHistory),
  ]);

  if (card === null) {
    return (
      <Alert tone="error">
        The rate card could not be loaded. Refresh the page, and tell an administrator if it keeps
        happening.
      </Alert>
    );
  }

  return (
    <TaxRateCard
      slug={slug}
      card={card}
      rules={rules}
      showHistory={showHistory}
      canManage={permissions.includes(PERMISSIONS.BILLING_TAX_MANAGE)}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
