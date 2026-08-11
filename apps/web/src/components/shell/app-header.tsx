import Link from 'next/link';
import { Wordmark } from '@/components/marketing/wordmark';
import { AppNav, type NavLink } from './app-nav';

/**
 * The signed-in shell. One header for the whole application.
 *
 * WHY THIS IS SHARED AND NOT TWO HEADERS
 *   There were two: the clinic's, light, with a branch switcher; and the
 *   console's, dark, with its own nav. Nothing about a super admin's work needs a
 *   different shell — they open the same screens, read the same records and make
 *   the same changes as an owner does (ADR-0012). Two shells only meant two
 *   places to add the next nav entry and two chances to add it to one of them.
 *
 *   What genuinely differs is *context*: a super admin is standing somewhere
 *   their account does not belong. That is the dark strip above this header
 *   (`PlatformStrip`), not a second design.
 *
 * THE SCOPE CHAIN
 *   `scopes` is the chain along the left edge — one segment per level of the
 *   tenancy model, hairline-separated, filled by the caller with a `ScopeLabel`
 *   or a `ScopeSwitcher`. A doctor passes a branch. An owner passes their clinic
 *   and a branch. A super admin passes a switchable clinic and a branch. See
 *   scope-switcher.tsx.
 *
 * A SERVER COMPONENT
 *   Deliberately. The old clinic header was `'use client'` in its entirety
 *   because one dropdown inside it held state, which shipped the wordmark, the
 *   nav and every label to the browser as JavaScript. Only the leaves that need
 *   interactivity are client components now, and they arrive here as children.
 */
export function AppHeader({
  scopes,
  user,
  signOut,
  nav,
}: {
  /** The scope chain. Segments are separated for you; pass them in order. */
  scopes: React.ReactNode[];
  /**
   * Who you are. `href` is your own account, where there is a page for it.
   *
   * `ownProfile` is a second link about YOU rather than about this place, which
   * is why it sits here and not in the nav below. A doctor's own practitioner
   * profile arrives through it: they hold no `doctor.directory.read`, so the
   * Doctors tab is not theirs, and their profile is not a destination the nav
   * should imply is one.
   */
  user: {
    name: string;
    href?: string | undefined;
    ownProfile?: { href: string; label: string } | undefined;
  };
  signOut: React.ReactNode;
  nav: { label: string; links: NavLink[] };
}) {
  const segments = scopes.filter(Boolean);

  return (
    <header className="border-rule bg-card border-b">
      <div className="px-gutter mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 py-4">
        <span className="text-ink">
          <Wordmark />
        </span>

        {segments.length > 0 ? (
          <div className="flex flex-wrap items-center">
            {segments.map((segment, index) => (
              // Indexed by position on purpose: the chain is fixed for a given
              // session, and position is exactly what identifies a segment.
              <div key={index} className="flex items-center">
                {/* The hairline is what makes this read as a chain of nested
                    scopes rather than as a row of unrelated controls. */}
                {index > 0 ? <span aria-hidden="true" className="bg-rule mx-1 h-5 w-px" /> : null}
                {segment}
              </div>
            ))}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-4">
          {/* The person's own account, kept out of the nav below — that row is
              what this place does, this is who you are. */}
          {user.href ? (
            <Link
              href={user.href}
              className="text-muted hover:text-drape py-1 text-[0.8125rem] underline-offset-2 hover:underline"
            >
              {user.name}
            </Link>
          ) : (
            <span className="text-muted text-[0.8125rem]">{user.name}</span>
          )}
          {user.ownProfile ? (
            <Link
              href={user.ownProfile.href}
              className="text-muted hover:text-drape py-1 text-[0.8125rem] underline-offset-2 hover:underline"
            >
              {user.ownProfile.label}
            </Link>
          ) : null}
          {/*
           * Not a nav entry and not a prop: appearance is a property of this
           * browser rather than of this place, so it sits with the other links
           * about you — and unlike them it is guarded by nothing, so there is no
           * caller decision to pass down. The href is relative and correct on
           * both surfaces: the proxy rewrites `admin.<host>/appearance` to
           * `/platform/appearance` and `<clinic>.<host>/appearance` to
           * `/t/<slug>/appearance` (apps/web/AGENTS.md).
           */}
          <Link
            href="/appearance"
            className="text-muted hover:text-drape py-1 text-[0.8125rem] underline-offset-2 hover:underline"
          >
            Appearance
          </Link>
          {signOut}
        </div>
      </div>

      <AppNav label={nav.label} links={nav.links} />
    </header>
  );
}
