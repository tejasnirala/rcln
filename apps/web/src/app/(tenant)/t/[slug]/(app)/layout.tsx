import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PERMISSIONS as P } from '@rcln/permissions';
import { getSession } from '@/lib/session';
import { PlatformStrip } from '@/components/shell/platform-strip';
import { TenantHeader } from '@/components/tenant/tenant-header';
import { VerifyPrompt } from '@/components/tenant/verify-prompt';
import { SetupBanner } from '@/components/tenant/onboarding/setup-banner';

export const metadata: Metadata = {
  // A tenant surface must never be indexed — it would publish the customer list.
  // Inherited by every page in this group, so no page has to remember it.
  robots: { index: false, follow: false },
};

/**
 * The authenticated clinic shell.
 *
 * WHY THIS IS A ROUTE GROUP AND NOT `t/[slug]/layout.tsx`
 *   A layout at the segment root wraps `login/` too, and this one redirects to
 *   `/login` when there is no session — so signing out would bounce between the
 *   login page and itself forever. `(app)` opts the authenticated pages into the
 *   shell and leaves the pre-auth ones (login, and the invitation accept page)
 *   outside it, which is exactly what route groups are for.
 *
 * Every screen added from here on — branches, members, roles, settings — is a
 * page inside this group and inherits the guard, the header and the branch
 * switcher without repeating any of it. The impersonation banner mounts here for
 * the same reason: it must not be missing from one screen.
 *
 * `getSession` is memoised per request, so a page calling it again for its own
 * content costs nothing.
 */
export default async function TenantAppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getSession(slug);

  if (!session) redirect('/login');

  /*
   * ⚠️ SETUP IS BLOCKING FOR WHOEVER CAN FINISH IT, AND A BANNER FOR EVERYONE
   *   ELSE (CO-1). A clinic that is already seeing patients must not be locked
   *   out because its owner has not logged in yet — so the wall is only for the
   *   person standing in front of the door with the key.
   *
   * ⚠️ GATED ON THE PERMISSION CODE, NOT ON ORG_OWNER. No role is named anywhere
   *   (ADR-0002), and gating on the code means a clinic that clones a role to
   *   delegate setup gets the redirect too — which is what they asked for by
   *   cloning it.
   *
   * ⚠️ AND `/setup` IS IN A DIFFERENT ROUTE GROUP, WHICH IS WHAT MAKES THIS
   *   TERMINATE. A layout cannot read the pathname, so a `/setup` inside `(app)`
   *   would be redirected to itself forever. See `(setup)/layout.tsx`.
   */
  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  if (
    membership &&
    !membership.setupComplete &&
    session.permissions.includes(P.ORG_ONBOARDING_WRITE)
  ) {
    redirect('/setup');
  }

  const impersonation = session.impersonation;

  return (
    <div className="min-h-dvh">
      {/* The same dark strip the console wears, in its `inside` mode. The bar is
          rcln's and it follows you in. */}
      {impersonation ? (
        <PlatformStrip
          mode="inside"
          slug={slug}
          organizationName={impersonation.organizationName}
          adminName={impersonation.adminName}
          expiresAt={impersonation.expiresAt}
        />
      ) : null}
      <TenantHeader slug={slug} session={session} />
      {/* Renders nothing once both channels are confirmed. It lives here rather
          than on one page so it cannot be missing from a screen — the same
          reason the impersonation banner is above. */}
      <VerifyPrompt session={session} />
      {/* Renders nothing once setup is done, and nothing for the person who can
          finish it — they were redirected to the wizard above. Here rather than
          on a page for the reason the two banners above are. */}
      <SetupBanner session={session} />
      <main id="main" className="px-gutter mx-auto max-w-7xl py-12">
        {children}
      </main>
    </div>
  );
}
