import type { Metadata } from 'next';
import Link from 'next/link';
import { getPlatformSession } from '@/lib/session';
import { PlatformLogin } from '@/components/platform/platform-login';
import { PlatformSignOut } from '@/components/platform/platform-sign-out';

export const metadata: Metadata = {
  title: 'Platform',
  // rcln's own back office. Inherited by every page here, so no page has to
  // remember it.
  robots: { index: false, follow: false },
};

/**
 * The super-admin console, served from admin.<root-domain>.
 *
 * DEFERRED FROM SLICE 0 ON PURPOSE
 *   The console was one page with an inline sign-in gate, and a layout for one
 *   page is speculation. It has two pages now — the demo pipeline and the clinic
 *   list — and one of them can put an admin inside somebody's clinic, so the
 *   gate and the chrome belong somewhere neither page can forget them.
 *
 * THE DARK BAR
 *   This header is `ink`, the only dark chrome in the product, and the
 *   impersonation banner inside a clinic is the same surface. That is the one
 *   idea these two screens share: the dark bar is rcln's, and it follows you in.
 *   When you are looking at a clinic's own shell there is a light header above
 *   you; when the bar above you is dark, you are somewhere your account does not
 *   belong. `on-ink` re-points the focus ring so a keyboard user does not lose
 *   it against the dark.
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

  return (
    <div className="min-h-dvh">
      <header className="on-ink bg-ink text-paper">
        <div className="px-gutter mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 py-4">
          <span className="font-display text-lg">rcln</span>
          <span className="bg-signal-bright/15 text-signal-bright rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]">
            platform
          </span>
          <div className="ml-auto flex items-center gap-4">
            <span className="text-paper/80 text-[0.8125rem]">{session.user.fullName}</span>
            <PlatformSignOut />
          </div>
        </div>

        <nav aria-label="Platform console" className="border-paper/15 border-t">
          <ul className="px-gutter mx-auto flex max-w-6xl gap-1 py-1">
            {[
              { href: '/', label: 'Demo requests' },
              { href: '/organizations', label: 'Clinics' },
            ].map((link) => (
              <li key={link.href}>
                {/* py-2 keeps the target above the 24px minimum; an inline link
                    is about 19px from line-height alone (apps/web/AGENTS.md). */}
                <Link
                  href={link.href}
                  className="text-paper/75 hover:text-paper hover:bg-paper/10 inline-block rounded-sm px-3 py-2 text-[0.8125rem] transition-colors"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main id="main" className="px-gutter mx-auto max-w-6xl py-12">
        {children}
      </main>
    </div>
  );
}
