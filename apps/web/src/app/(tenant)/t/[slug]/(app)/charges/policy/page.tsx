import type { Metadata } from 'next';
import type { ChargePolicyRuleListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ChargePolicyList } from '@/components/tenant/charge-policy-list';
import { chargesAccess } from '../guard';

export const metadata: Metadata = { title: 'Charge policy' };

/**
 * ⚠️ READ IS GATED ON `canRead`, NOT ON `canManagePolicy`. Whoever works the
 *   charge queue has to be able to see WHY something came out suppressed, and
 *   "the policy says dressings are never billed" is that answer. Hiding the rules
 *   behind the code that edits them makes every suppressed charge unexplainable
 *   to the person looking at it.
 */
export default async function ChargePolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await chargesAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to charges here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  /* Every tier renders as its own section, so the list is fetched whole. */
  search.set('limit', '100');
  const page = query.page;
  const onePage = Array.isArray(page) ? page[0] : page;
  if (onePage) search.set('page', onePage);

  const rules = await api<ChargePolicyRuleListResponse>(
    `/api/v1/charging/policies?${search.toString()}`,
    { slug, accessToken }
  );

  if (!rules.ok || !rules.data) {
    return (
      <Alert tone="error">
        {rules.message ?? 'The charge policy could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return <ChargePolicyList slug={slug} rules={rules.data} canManage={access.canManagePolicy} />;
}
