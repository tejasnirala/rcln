import type { Metadata } from 'next';
import type { DesignationListResponse, MemberListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { MemberList } from '@/components/tenant/member-list';

export const metadata: Metadata = {
  title: 'Staff',
};

/**
 * <slug>.rcln.com/members
 *
 * The auth guard, header and branch switcher come from the `(app)` layout.
 *
 * One request answers the whole screen, including the branches the assign form
 * offers. Those come from here rather than from `/branches` on purpose:
 * `iam.user.read` does not imply `branch.read`, and the list is already narrowed
 * to the caller's own reach — offering a branch they cannot assign into would
 * only produce a 404 on submit.
 */
export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const accessToken = await getAccessToken();

  // Both at once — the designation menu does not depend on the staff list, so
  // awaiting them in sequence would serialise two round trips for no reason.
  const [members, designations] = await Promise.all([
    api<MemberListResponse>('/api/v1/members', { slug, accessToken }),
    api<DesignationListResponse>('/api/v1/designations', { slug, accessToken }),
  ]);

  if (!members.ok || !members.data) {
    return (
      <Alert tone="error">
        {members.status === 403
          ? 'You do not have access to the staff list. Ask an administrator at this clinic.'
          : (members.message ?? 'The staff list could not be loaded.')}
      </Alert>
    );
  }

  // The session is memoised per request, so this is the object the layout already
  // resolved. A "History" button that answers 403 is worse than no button.
  const session = await getSession(slug);
  const canReadHistory = session?.permissions.includes(PERMISSIONS.AUDIT_READ) ?? false;

  return (
    <MemberList
      slug={slug}
      members={members.data.members}
      roles={members.data.roles}
      branches={members.data.branches}
      designations={designations.data?.designations ?? []}
      grantableCodes={members.data.grantableCodes}
      canAssignOrgWide={members.data.canAssignOrgWide}
      canReadHistory={canReadHistory}
    />
  );
}
