import type { Metadata } from 'next';
import type { RegulatoryAuthorityListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { AuthorityList } from '@/components/tenant/regulatory-lists';
import { regulatoryAccess } from '../guard';

export const metadata: Metadata = { title: 'Regulators' };

/** <slug>.rcln.com/regulatory/authorities — NO PHI. */
export default async function AuthoritiesPage({
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
  for (const key of ['page', 'jurisdictionId']) {
    const value = query[key];
    if (typeof value === 'string') search.set(key, value);
  }

  const result = await api<RegulatoryAuthorityListResponse>(
    `/api/v1/regulatory/authorities?${search.toString()}`,
    { slug, accessToken }
  );

  if (!result.ok) {
    return (
      <Alert tone="error">
        {result.message ?? 'Regulators could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <AuthorityList
      authorities={result.data?.authorities ?? []}
      meta={result.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
    />
  );
}
