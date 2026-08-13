import type { Metadata } from 'next';
import type { RegulatorySourceListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SourceList } from '@/components/tenant/regulatory-lists';
import { regulatoryAccess } from '../guard';

export const metadata: Metadata = { title: 'Sources' };

/** <slug>.rcln.com/regulatory/sources — NO PHI. */
export default async function SourcesPage({
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
  for (const key of ['page', 'jurisdictionId', 'reviewStatus']) {
    const value = query[key];
    if (typeof value === 'string') search.set(key, value);
  }

  const result = await api<RegulatorySourceListResponse>(
    `/api/v1/regulatory/sources?${search.toString()}`,
    { slug, accessToken }
  );

  if (!result.ok) {
    return (
      <Alert tone="error">
        {result.message ?? 'Sources could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <SourceList
      sources={result.data?.sources ?? []}
      meta={result.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      timezone={await timezoneOf(slug)}
    />
  );
}
