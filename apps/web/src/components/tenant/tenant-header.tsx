import type { AuthSession } from '@rcln/contracts';
import { signOut } from '@/app/(tenant)/t/[slug]/actions';
import { AppHeader } from '@/components/shell/app-header';
import type { NavLink } from '@/components/shell/app-nav';
import { ScopeLabel } from '@/components/shell/scope-switcher';
import { SignOutButton } from '@/components/shell/sign-out-button';
import { BranchSwitcher } from './branch-switcher';

/**
 * The clinic's shell — `AppHeader` filled in with this clinic's scopes and nav.
 *
 * There is one header in the application now (components/shell/app-header.tsx);
 * this decides what goes in it for someone standing inside a clinic. A super
 * admin who has walked in gets the same thing, with the dark `PlatformStrip`
 * above it.
 *
 * A SERVER COMPONENT. Only the branch switcher and the sign-out button need to be
 * client components, and they are. This whole file used to be `'use client'`
 * because of the one dropdown, which shipped the nav and every label to the
 * browser for no reason.
 */
export function TenantHeader({ slug, session }: { slug: string; session: AuthSession }) {
  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  const branches = membership?.branches ?? [];

  /*
   * THE SCOPE CHAIN
   *   The clinic first, then the branch inside it. The clinic segment is a plain
   *   label here because this session belongs to one clinic — a super admin's
   *   session does not, and their layout passes a switcher in this position
   *   instead. Same chain, one more degree of freedom.
   *
   *   Under impersonation `memberships` is the admin's own and is almost always
   *   empty, so there are no branches to switch between and the strip above names
   *   the clinic. The segment is dropped rather than rendered empty.
   */
  const scopes = [
    <ScopeLabel key="clinic" label="Clinic" name={slug} />,
    ...(branches.length > 0
      ? [
          <BranchSwitcher
            key="branch"
            slug={slug}
            branches={branches}
            activeBranchId={session.activeBranchId}
          />,
        ]
      : []),
  ];

  return (
    <AppHeader
      scopes={scopes}
      user={{ name: session.user.fullName, href: '/verify' }}
      signOut={
        // Bound server-side, like every other action here, so the browser cannot
        // substitute another clinic's slug. The navigation is ours rather than the
        // action's: `/login` is this clinic's sign-in page only after the proxy
        // rewrite, and the apex serves a clinic finder at the same path.
        <SignOutButton action={signOut.bind(null, slug)} redirectTo="/login" />
      }
      nav={{ label: 'Clinic', links: clinicNav(session.permissions) }}
    />
  );
}

/**
 * Where you can go from inside a clinic.
 *
 * Each destination names the permission that makes it usable, and a link the
 * caller cannot use is not rendered — following it would only produce a 403 at the
 * API. This grows as later phases land; it is not a placeholder.
 *
 * Permissions are resolved fresh per request by the API, never read from the JWT,
 * so this reflects a role change on the next page load. A platform admin comes
 * back holding the whole catalogue, which is why they see every entry.
 */
function clinicNav(permissions: string[]): NavLink[] {
  return [
    { href: '/branches', label: 'Branches', permission: ['branch.read'] },
    { href: '/members', label: 'Staff', permission: ['iam.user.read'] },
    { href: '/roles', label: 'Roles', permission: ['iam.role.read'] },
    { href: '/invitations', label: 'Invitations', permission: ['iam.user.read'] },
    // Two codes, either of which makes the screen worth opening: it holds the
    // clinic's particulars and its defaults behind separate permissions, and
    // renders whichever half the API answered.
    {
      href: '/settings',
      label: 'Clinic',
      permission: ['organization.read', 'settings.organization.read'],
    },
    // Reading the plan and the invoices is a different permission from changing
    // them; either one makes the screen worth opening, and the screen itself
    // renders only the controls the caller may use.
    {
      href: '/billing',
      label: 'Billing',
      permission: ['organization.billing.read', 'organization.billing.manage'],
    },
  ]
    .filter((link) => link.permission.some((code) => permissions.includes(code)))
    .map(({ href, label }) => ({ href, label }));
}
