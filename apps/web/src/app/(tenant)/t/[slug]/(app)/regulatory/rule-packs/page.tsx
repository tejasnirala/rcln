import type { Metadata } from 'next';
import type { RulePackListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RulePackList } from '@/components/tenant/regulatory-lists';
import { regulatoryAccess } from '../guard';

export const metadata: Metadata = { title: 'Rule packs' };

/** <slug>.rcln.com/regulatory/rule-packs — NO PHI. */
export default async function RulePacksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await regulatoryAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to the rules here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  for (const key of ['page', 'countryCode', 'jurisdictionId', 'maturity']) {
    const value = query[key];
    if (typeof value === 'string') search.set(key, value);
  }

  const result = await api<RulePackListResponse>(
    `/api/v1/regulatory/rule-packs?${search.toString()}`,
    { slug, accessToken }
  );

  if (!result.ok) {
    return (
      <Alert tone="error">
        {result.message ?? 'Rule packs could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <RulePackList
      packs={result.data?.packs ?? []}
      meta={result.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
    />
  );
}
