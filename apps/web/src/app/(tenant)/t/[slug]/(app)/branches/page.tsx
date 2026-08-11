import type { Metadata } from 'next';
import type { BranchListResponse, OrganizationProfile } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { BranchList } from '@/components/tenant/branch-list';

export const metadata: Metadata = {
  title: 'Branches',
};

/**
 * <slug>.rcln.com/branches
 *
 * The auth guard, header and branch switcher come from the `(app)` layout. This
 * page only fetches and hands off.
 *
 * A caller without `branch.read` gets 403 from the API rather than an empty
 * list, so the two are told apart below — an empty state that actually means
 * "you may not see this" is how a permissions bug goes unnoticed.
 */
export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const accessToken = await getAccessToken();

  /*
   * Both in parallel: the organization is needed only to seed a NEW branch's tax
   * jurisdiction, and waterfalling it behind the branch list would add a round
   * trip to a page that renders fine without it.
   */
  const [result, organization] = await Promise.all([
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
    api<OrganizationProfile>('/api/v1/organization', { slug, accessToken }),
  ]);

  if (!result.ok || !result.data) {
    return (
      <Alert tone="error">
        {result.status === 403
          ? 'You do not have access to branch settings. Ask an administrator at this clinic.'
          : (result.message ?? 'Branches could not be loaded.')}
      </Alert>
    );
  }

  /*
   * Whether to offer the history panel at all. Memoised per request, so this is
   * the same session object the layout already resolved (lib/session.ts).
   *
   * Decided here rather than inside the component: a "History" button that answers
   * 403 when pressed is worse than no button, and the API is the authority either
   * way — this only decides what to render.
   */
  const session = await getSession(slug);
  const canReadHistory = session?.permissions.includes(PERMISSIONS.AUDIT_READ) ?? false;

  return (
    <BranchList
      slug={slug}
      branches={result.data.branches}
      /*
       * A caller who may read branches but not the organization still gets the
       * screen; the new-branch form just falls back to India's defaults, and the
       * API applies the clinic's real jurisdiction on save either way.
       */
      organization={{
        countryCode: organization.data?.countryCode ?? 'IN',
        regionCode: organization.data?.regionCode ?? null,
      }}
      canReadHistory={canReadHistory}
    />
  );
}
