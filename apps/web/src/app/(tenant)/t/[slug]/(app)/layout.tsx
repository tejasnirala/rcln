import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PlatformStrip } from '@/components/shell/platform-strip';
import { TenantHeader } from '@/components/tenant/tenant-header';
import { VerifyPrompt } from '@/components/tenant/verify-prompt';

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
      <main id="main" className="px-gutter mx-auto max-w-7xl py-12">
        {children}
      </main>
    </div>
  );
}
