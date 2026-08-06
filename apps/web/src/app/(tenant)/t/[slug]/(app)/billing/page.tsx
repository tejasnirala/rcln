import type { Metadata } from 'next';
import type { BillingOverviewResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { BillingScreen } from '@/components/tenant/billing-screen';

export const metadata: Metadata = {
  title: 'Billing',
};

/**
 * <slug>.rcln.com/billing
 *
 * One call fetches the whole screen — plan, entitlements, mandate and invoices —
 * because the API assembles it in a single scoped transaction. Four calls would
 * be four chances to interleave with a webhook settling a payment, and a screen
 * that shows an ACTIVE subscription beside an unpaid invoice for the same period.
 *
 * READING AND CHANGING ARE SEPARATE PERMISSIONS. A practice manager who needs
 * last month's invoice should not thereby be able to cancel the subscription, so
 * `canManage` decides which controls render — and the API is the authority
 * either way, answering 403 for anything the caller may not do.
 */
export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await api<BillingOverviewResponse>('/api/v1/billing', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return (
      <Alert tone="error">
        {result.status === 403
          ? 'You do not have access to billing. Ask an administrator at this clinic.'
          : (result.message ?? 'Billing could not be loaded.')}
      </Alert>
    );
  }

  // Memoised per request, so this is the session the layout already resolved.
  const session = await getSession(slug);
  const canManage = session?.permissions.includes(PERMISSIONS.ORG_BILLING_MANAGE) ?? false;

  /*
   * One clock reading, taken here and passed down.
   *
   * The screen is a Client Component that is server-rendered first, so anything
   * derived from `new Date()` inside it is computed twice — once here, once in
   * the browser milliseconds later — and the two renders disagree. Sourcing the
   * instant on the server is what makes the period strip hydrate.
   */
  const renderedAt = new Date().toISOString();

  return (
    <BillingScreen
      slug={slug}
      overview={result.data}
      canManage={canManage}
      renderedAt={renderedAt}
    />
  );
}
