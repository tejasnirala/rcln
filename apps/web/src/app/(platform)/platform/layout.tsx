import type { Metadata } from 'next';
import { getPlatformSession } from '@/lib/session';
import { listPlatformOrganizations } from '@/lib/platform';
import { PlatformLogin } from '@/components/platform/platform-login';
import { ClinicSwitcher } from '@/components/platform/clinic-switcher';
import { AppHeader } from '@/components/shell/app-header';
import { PlatformStrip } from '@/components/shell/platform-strip';
import { SignOutButton } from '@/components/shell/sign-out-button';
import { ScopeLabel } from '@/components/shell/scope-switcher';
import { platformSignOut } from './actions';

export const metadata: Metadata = {
  title: 'Platform',
  // rcln's own back office. Inherited by every page here, so no page has to
  // remember it.
  robots: { index: false, follow: false },
};

/**
 * The super-admin console, served from admin.<root-domain>.
 *
 * THIS IS THE SAME SHELL AS A CLINIC'S
 *   It used to be its own design — a dark header with its own nav — which said
 *   the console was a different kind of place. It is not. A super admin opens the
 *   same screens as an owner and can change the same records (ADR-0012), so a
 *   second shell only meant two places to add the next nav entry and two chances
 *   to add it to one of them. `AppHeader` is now the one header in the
 *   application; this fills it in with the console's scopes and nav.
 *
 *   What a super admin gets that an owner does not is the dark strip above it.
 *   That is the difference, and it is the whole of it: the shell says what you
 *   are looking at, the strip says whose it is.
 *
 * The session is read here rather than in each page. `getPlatformSession` is
 * memoised per request, so a page re-reading it for its own content is free.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await getPlatformSession();

  /*
   * Not a redirect. `/login` on this host would be rewritten to
   * `/platform/login`, which does not exist — and the console is a single
   * surface for a handful of people, so the gate is the page.
   */
  if (!session) {
    return (
      <div className="px-gutter flex min-h-dvh flex-col items-center justify-center py-10">
        <div className="w-full max-w-md">
          <p className="eyebrow">rcln</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Platform console</h1>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            For rcln staff. Clinic accounts sign in at their own address.
          </p>
          <div className="mt-8">
            <PlatformLogin />
          </div>
        </div>
      </div>
    );
  }

  /*
   * The selector's options. Memoised per request, so the clinics page asking for
   * the same list on this render costs nothing (lib/platform.ts).
   *
   * A failure here is not worth breaking the console over — every other screen
   * still works without a clinic selector, and the clinics page says so properly
   * with its own error. The chain simply loses that segment.
   */
  const organizations = (await listPlatformOrganizations()).data?.organizations ?? [];

  return (
    <div className="min-h-dvh">
      <PlatformStrip mode="console" />
      <AppHeader
        /*
         * The chain, one segment longer than an owner's: a super admin picks a
         * clinic where an owner simply has one. `ScopeLabel` holds the position
         * when there is nothing to pick from, so the chain never renders empty.
         */
        scopes={[
          organizations.length > 0 ? (
            <ClinicSwitcher
              key="clinic"
              organizations={organizations}
              lastOrganizationId={session.user.lastPlatformOrganizationId}
            />
          ) : (
            <ScopeLabel key="clinic" label="Scope" name="platform" />
          ),
        ]}
        user={{ name: session.user.fullName }}
        signOut={<SignOutButton action={platformSignOut} redirectTo="/" />}
        nav={{
          label: 'Platform console',
          links: [
            { href: '/', label: 'Demo requests' },
            { href: '/organizations', label: 'Clinics' },
            { href: '/taxes', label: 'Tax' },
          ],
        }}
      />

      <main id="main" className="px-gutter mx-auto max-w-7xl py-12">
        {children}
      </main>
    </div>
  );
}
