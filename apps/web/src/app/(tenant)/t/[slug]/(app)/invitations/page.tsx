import type { Metadata } from 'next';
import type { BranchListResponse, InvitationListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { InvitationList } from '@/components/tenant/invitation-list';

export const metadata: Metadata = {
  title: 'Invitations',
};

/**
 * <slug>.rcln.com/invitations
 *
 * The auth guard, header and branch switcher come from the `(app)` layout. This
 * page only fetches and hands off — including the countdown each row shows,
 * which the API derives (see `daysLeft` on the contract).
 */
export default async function InvitationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const accessToken = await getAccessToken();

  /*
   * Both at once. The two calls are independent, so awaiting them in sequence
   * would serialise two round trips for no reason — the waterfall
   * vercel-react-best-practices warns about.
   */
  const [invitations, branches] = await Promise.all([
    api<InvitationListResponse>('/api/v1/invitations', { slug, accessToken }),
    api<BranchListResponse>('/api/v1/branches', { slug, accessToken }),
  ]);

  if (!invitations.ok || !invitations.data) {
    return (
      <Alert tone="error">
        {invitations.status === 403
          ? 'You do not have access to staff invitations. Ask an administrator at this clinic.'
          : (invitations.message ?? 'Invitations could not be loaded.')}
      </Alert>
    );
  }

  return (
    <InvitationList
      slug={slug}
      roles={invitations.data.roles}
      /*
       * `iam.user.read` does not imply `branch.read`, so this can legitimately
       * come back 403 for someone who may still invite. An empty list means the
       * form offers an org-wide invitation only, which is the correct fallback
       * rather than an error.
       */
      branches={(branches.data?.branches ?? []).map((branch) => ({
        id: branch.id,
        name: branch.name,
        code: branch.code,
      }))}
      invitations={invitations.data.invitations}
    />
  );
}
