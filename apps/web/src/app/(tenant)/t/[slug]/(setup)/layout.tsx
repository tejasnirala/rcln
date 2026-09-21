import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PERMISSIONS as P } from '@rcln/permissions';
import { getSession } from '@/lib/session';
import { PlatformStrip } from '@/components/shell/platform-strip';

export const metadata: Metadata = {
  // A tenant surface must never be indexed — it would publish the customer list.
  robots: { index: false, follow: false },
};

/**
 * The setup shell.
 *
 * ⚠️ ITS OWN ROUTE GROUP, AND `/setup` CANNOT LIVE INSIDE `(app)`. The redirect
 *   that sends an unfinished clinic here belongs in the `(app)` layout — that is
 *   the only place it cannot be missing from a screen — but an App Router layout
 *   cannot read the pathname, so a layout that redirected to `/setup` would
 *   redirect the wizard to itself, forever. The route group is the fix, and it
 *   is the same reasoning `(app)` itself records for existing.
 *
 * ⚠️ AND IT DELIBERATELY RENDERS NO NAVIGATION. A clinic that has not chosen its
 *   modules has no honest nav to draw: half the tabs would be ones it is about
 *   to say it does not use. The header here is the clinic's name and a way out,
 *   and nothing else.
 *
 * ⚠️ THE "WAY OUT" IS ONLY DRAWN ONCE SETUP IS DONE, AND BOTH HALVES OF THAT
 *   MATTER. Before it, there is deliberately nowhere to go — the `(app)` layout
 *   sends this person straight back, so a link would be a loop with a different
 *   shape. After it, the wizard is an ordinary administrative screen reached
 *   from the Clinic menu, and a screen you can enter and not leave is a trap.
 *   Until this existed the shell drew no header at all, which is why the
 *   paragraph above described a way out that was not on the page.
 */
export default async function TenantSetupLayout({
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
   * ⚠️ GATED ON THE PERMISSION, NOT ON A ROLE (ADR-0002). Somebody who cannot
   *   write the wizard has no business on this screen, and sending them to the
   *   app is the honest answer — they get the banner there instead. Naming
   *   ORG_OWNER here would break the clinic that clones a role to delegate setup.
   */
  if (!session.permissions.includes(P.ORG_ONBOARDING_WRITE)) redirect('/');

  /* The same membership the `(app)` layout reads to decide whether to send
     somebody here in the first place. */
  const setupComplete =
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)
      ?.setupComplete === true;

  const impersonation = session.impersonation;

  return (
    <div className="min-h-dvh">
      {impersonation ? (
        <PlatformStrip
          mode="inside"
          slug={slug}
          organizationName={impersonation.organizationName}
          adminName={impersonation.adminName}
          expiresAt={impersonation.expiresAt}
        />
      ) : null}
      {setupComplete ? (
        <div className="border-rule px-gutter mx-auto flex max-w-7xl items-center justify-between border-b py-4">
          <span className="text-muted text-[0.8125rem]">Clinic setup</span>
          {/*
            A plain link, and `/` is correct here rather than a route-tree path:
            `proxy.ts` rewrites by Host, so on a clinic subdomain `/` is this
            clinic's home. The wizard's own completion navigation records the
            same reasoning at greater length.
          */}
          <Link href="/" className="text-drape text-[0.8125rem] underline-offset-4 hover:underline">
            Back to the clinic
          </Link>
        </div>
      ) : null}
      <main id="main" className="px-gutter mx-auto max-w-7xl py-12">
        {children}
      </main>
    </div>
  );
}
