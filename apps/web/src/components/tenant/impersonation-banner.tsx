'use client';

import { useTransition } from 'react';
import { stopImpersonation } from '@/app/(tenant)/t/[slug]/actions';
import { hardNavigate } from '@/lib/hard-navigate';

/**
 * The one thing on screen saying that the person driving is not from here.
 *
 * THE DARK BAR
 *   `ink`, and the only dark surface inside the clinic app. It is the same bar
 *   as the platform console's header, which is the whole idea: the dark chrome
 *   is rcln's and it follows you in. A clinic's own shell has a light header;
 *   when the bar above you is dark, you are somewhere your account does not
 *   belong. `on-ink` re-points `--focus-ring` to `signal-bright` so a keyboard
 *   user does not lose the ring against it.
 *
 * THE END TIME IS THE SIGNATURE
 *   This session cannot be renewed — there is no refresh token, and thirty
 *   minutes after it started the row and the access token expire together. That
 *   is the single fact separating it from an ordinary session, and a banner that
 *   only said "you are impersonating" would hide it. So the bar carries the hour
 *   it closes, the way a branch row carries its whole week.
 *
 *   An absolute time and not a ticking countdown. A countdown is motion nobody
 *   asked for (WCAG 2.2.2), it would need an interval and a live region churning
 *   every minute, and reading the clock during a render is a `react-hooks/purity`
 *   error in this codebase for good reason. "Ends at 16:42" is a fact; it does
 *   not move, and it is the one someone plans around.
 *
 * NOT DISMISSIBLE. Dismissing it would leave a super admin writing into a
 * clinic's records with nothing on screen to say so.
 */
export function ImpersonationBanner({
  slug,
  organizationName,
  adminName,
  expiresAt,
}: {
  slug: string;
  organizationName: string;
  adminName: string;
  /** ISO 8601, from the session. Formatted in the reader's own zone below. */
  expiresAt: string;
}) {
  const [pending, startTransition] = useTransition();

  // Pure — no clock is read, only the instant handed down. The server renders
  // this in the container's zone and the browser in the admin's, which is a
  // hydration difference on purpose: the admin's clock is the correct one.
  const endsAt = new Date(expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="on-ink bg-ink text-paper">
      <div className="px-gutter mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-[0.8125rem]">
        <span className="bg-signal-bright/15 text-signal-bright rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]">
          rcln staff
        </span>

        <p className="min-w-0">
          You are inside <span className="font-medium">{organizationName}</span> as {adminName}.
          Everything you change here is recorded under your name.
        </p>

        <p className="text-signal-bright ml-auto font-medium">
          Ends at{' '}
          <time dateTime={expiresAt} suppressHydrationWarning>
            {endsAt}
          </time>
        </p>

        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const adminHost = window.location.host.replace(/^[^.]+\./, 'admin.');
              await stopImpersonation(slug);
              /*
               * A real navigation, and to another host. The console is `/` on
               * `admin.<root>` only after proxy.ts rewrites it, so a router
               * navigation would resolve `/platform` against the route tree and
               * land on `/platform/platform`. See lib/hard-navigate.ts.
               */
              hardNavigate(`${window.location.protocol}//${adminHost}/`);
            });
          }}
          // py-1 keeps the target above the 24px minimum (apps/web/AGENTS.md).
          className="text-paper hover:text-signal-bright py-1 underline underline-offset-2 disabled:opacity-60"
        >
          {pending ? 'Leaving…' : 'Return to the console'}
        </button>
      </div>
    </div>
  );
}
