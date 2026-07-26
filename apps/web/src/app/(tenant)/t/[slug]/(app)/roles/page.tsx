import type { Metadata } from 'next';
import type { RoleListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RoleList } from '@/components/tenant/role-list';

export const metadata: Metadata = {
  title: 'Roles',
};

/**
 * <slug>.rcln.com/roles
 *
 * The auth guard, header and branch switcher come from the `(app)` layout. One
 * request answers the whole screen: the roles, the permission catalogue the
 * editor offers, and which of those codes this caller may actually grant. The
 * catalogue is not bundled into the browser — it lives in `@rcln/permissions`,
 * a server package, and a copy shipped to the client would go stale.
 */
export default async function RolesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const roles = await api<RoleListResponse>('/api/v1/roles', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!roles.ok || !roles.data) {
    return (
      <Alert tone="error">
        {roles.status === 403
          ? 'You do not have access to roles. Ask an administrator at this clinic.'
          : (roles.message ?? 'Roles could not be loaded.')}
      </Alert>
    );
  }

  return (
    <RoleList
      slug={slug}
      roles={roles.data.roles}
      permissions={roles.data.permissions}
      grantableCodes={roles.data.grantableCodes}
    />
  );
}
