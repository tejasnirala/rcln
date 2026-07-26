'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { AuthSession } from '@rcln/contracts';
import { signOut, switchBranch } from '@/app/(tenant)/t/[slug]/actions';
import { cn } from '@/lib/cn';
import { hardNavigate } from '@/lib/hard-navigate';
import { Wordmark } from '@/components/marketing/wordmark';

/**
 * The signed-in shell.
 *
 * The branch switcher is the one control here that carries real weight: which
 * branch you are in decides what you can see and what you can do, so it names
 * the current branch in full rather than hiding it behind an icon, and the
 * switch is a server round trip (a re-issued token), not a client-side filter.
 */
export function TenantHeader({ slug, session }: { slug: string; session: AuthSession }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  const branches = membership?.branches ?? [];
  const active = branches.find((b) => b.id === session.activeBranchId);

  return (
    <header className="border-rule bg-card border-b">
      <div className="px-gutter mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 py-4">
        <span className="text-ink">
          <Wordmark />
        </span>

        <span className="text-muted font-mono text-[0.8125rem]">{slug}</span>

        {branches.length > 0 ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              disabled={pending || branches.length === 1}
              aria-expanded={open}
              aria-haspopup="listbox"
              className={cn(
                'border-rule text-ink hover:border-drape flex items-center gap-2 rounded-md border px-3 py-2 text-[0.875rem] transition-colors',
                branches.length === 1 && 'cursor-default opacity-90'
              )}
            >
              <span className="text-muted text-[0.75rem]">Branch</span>
              <span className="font-medium">{active?.name ?? 'Choose a branch'}</span>
              {branches.length > 1 ? <span aria-hidden="true">▾</span> : null}
            </button>

            {open && branches.length > 1 ? (
              <ul
                role="listbox"
                aria-label="Switch branch"
                className="border-rule bg-card absolute z-10 mt-1 min-w-56 rounded-md border py-1 shadow-lg"
              >
                {branches.map((branch) => {
                  const current = branch.id === session.activeBranchId;
                  return (
                    <li key={branch.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={current}
                        disabled={pending}
                        onClick={() => {
                          setOpen(false);
                          startTransition(async () => {
                            await switchBranch(slug, branch.id);
                            // The action no longer redirects: a router
                            // navigation to `/` resolves against the route tree
                            // and lands on the marketing page, because the
                            // rewrite only applies to real requests. Reloading
                            // also re-reads every server component under the
                            // new branch. See lib/hard-navigate.ts.
                            hardNavigate('/');
                          });
                        }}
                        className={cn(
                          'hover:bg-paper flex w-full flex-col items-start px-3 py-2 text-left text-[0.875rem] transition-colors',
                          current && 'bg-drape-tint/40'
                        )}
                      >
                        <span className="text-ink font-medium">
                          {branch.name}
                          {/* Colour and highlight alone must not carry meaning. */}
                          {current ? <span className="sr-only"> (current branch)</span> : null}
                        </span>
                        <span className="text-muted font-mono text-[0.75rem]">
                          {branch.code}
                          {branch.city ? ` · ${branch.city}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-4">
          <span className="text-muted text-[0.8125rem]">{session.user.fullName}</span>
          {/* Bound server-side, like every other action here, so the browser
              cannot substitute another clinic's slug. The navigation is ours
              rather than the action's: `/login` is this clinic's sign-in page
              only after the proxy rewrite, and the apex serves a clinic finder
              at the same path. */}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                await signOut(slug);
                hardNavigate('/login');
              });
            }}
            className="text-drape hover:text-drape-deep py-1 text-[0.8125rem] underline underline-offset-2 disabled:opacity-60"
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>

      <TenantNav permissions={session.permissions} />
    </header>
  );
}

/**
 * Where you can go from here.
 *
 * Each destination names the permission that makes it usable, and a link the
 * caller cannot use is not rendered — following it would only produce a 403 at
 * the API. This grows as Phase 1 lands; it is not a placeholder.
 *
 * Permissions are resolved fresh per request by the API, never read from the
 * JWT, so this reflects a role change on the next page load.
 */
function TenantNav({ permissions }: { permissions: string[] }) {
  const links = [
    { href: 'branches', label: 'Branches', permission: 'branch.read' },
    { href: 'members', label: 'Staff', permission: 'iam.user.read' },
    { href: 'roles', label: 'Roles', permission: 'iam.role.read' },
    { href: 'invitations', label: 'Invitations', permission: 'iam.user.read' },
  ].filter((link) => permissions.includes(link.permission));

  if (links.length === 0) return null;

  return (
    <nav aria-label="Clinic settings" className="border-rule bg-paper border-t">
      <ul className="px-gutter mx-auto flex max-w-7xl gap-1 py-1">
        {links.map((link) => (
          <li key={link.href}>
            {/* py-2 keeps the target above the 24px minimum; an inline link is
                about 19px from line-height alone (apps/web/AGENTS.md). */}
            <Link
              href={`/${link.href}`}
              className="text-muted hover:text-drape hover:bg-drape-tint/50 inline-block rounded-sm px-3 py-2 text-[0.8125rem] transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
