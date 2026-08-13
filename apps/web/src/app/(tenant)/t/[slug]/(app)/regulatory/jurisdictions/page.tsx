import type { Metadata } from 'next';
import type { JurisdictionListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { JurisdictionList } from '@/components/tenant/regulatory-lists';
import { regulatoryAccess } from '../guard';

export const metadata: Metadata = { title: 'Places' };

/**
 * <slug>.rcln.com/regulatory/jurisdictions
 *
 * Server-rendered, server-paginated. Nothing here filters an in-memory array.
 * NO PHI.
 */
export default async function JurisdictionsPage({
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
  const page = query['page'];
  if (typeof page === 'string') search.set('page', page);

  const result = await api<JurisdictionListResponse>(
    `/api/v1/regulatory/jurisdictions?${search.toString()}`,
    { slug, accessToken }
  );

  if (!result.ok) {
    return (
      <Alert tone="error">
        {result.message ?? 'Places could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <JurisdictionList
      jurisdictions={result.data?.jurisdictions ?? []}
      meta={result.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
    />
  );
}
