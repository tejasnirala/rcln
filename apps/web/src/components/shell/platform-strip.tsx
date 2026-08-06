'use client';

import { useTransition } from 'react';
import { stopImpersonation } from '@/app/(tenant)/t/[slug]/actions';
import { hardNavigate } from '@/lib/hard-navigate';

/**
 * The super admin's extra header, and the only thing on screen saying that the
 * person driving is not from here.
 *
 * WHY THE SHELL BELOW IT IS ORDINARY
 *   A super admin opens the same screens as an owner and can change the same
 *   records (ADR-0012), so giving them a different-looking application would only
 *   have meant maintaining two of everything. The difference is not what the
 *   screens look like — it is *whose* records those are. This strip is that
 *   difference, and it is the whole of it.
 *
 * THE DARK BAR
 *   `ink`, the only dark chrome in the product. A clinic's own shell has a light
 *   header; when the bar above you is dark, you are rcln staff. `on-ink`
 *   re-points `--focus-ring` to `signal-bright` so a keyboard user does not lose
 *   the ring against it.
 *
 * TWO MODES, ONE BAR
 *   On the console you have entered no clinic, so the strip says where you are and
 *   what opening one costs. Inside a clinic it names the clinic, names you, and
 *   carries the way out. Same surface either way: the dark bar is rcln's and it
 *   follows you in.
 *
 * NOT DISMISSIBLE. Dismissing it would leave a super admin writing into a
 * clinic's records with nothing on screen to say so.
 */

const STAFF_CHIP = 'rcln staff';

export function PlatformStrip(
  props:
    | { mode: 'console' }
    | {
        mode: 'inside';
        slug: string;
        organizationName: string;
        adminName: string;
        /** ISO 8601, from the session. Formatted in the reader's own zone. */
        expiresAt: string;
      }
) {
  if (props.mode === 'console') {
    return (
      <Bar>
        <p className="min-w-0">
          You are on the platform console. Choose a clinic to work inside one — you will be asked
          why, and everything you change there is recorded under your name.
        </p>
      </Bar>
    );
  }

  return <InsideClinic {...props} />;
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="on-ink bg-ink text-paper">
      <div className="px-gutter mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-[0.8125rem]">
        <span className="bg-signal-bright/15 text-signal-bright rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]">
          {STAFF_CHIP}
        </span>
        {children}
      </div>
    </div>
  );
}

function InsideClinic({
  slug,
  organizationName,
  adminName,
  expiresAt,
}: {
  slug: string;
  organizationName: string;
  adminName: string;
  expiresAt: string;
}) {
  const [pending, startTransition] = useTransition();

  /*
   * THE END TIME
   *   The CEILING, not the idle timeout. This session renews while it is being
   *   used, so its `expires_at` slides forward and would put a deadline on screen
   *   that quietly moves — worse than showing nothing, because it looks like a
   *   fact. What the API sends is eight hours from when the session started, and
   *   nothing the admin does moves it.
   *
   *   An absolute time and not a countdown: a countdown is motion nobody asked for
   *   (WCAG 2.2.2), it would need an interval and a live region churning every
   *   minute, and reading the clock during a render is a `react-hooks/purity`
   *   error in this codebase for good reason.
   *
   * Pure — no clock is read, only the instant handed down. The server renders this
   * in the container's zone and the browser in the admin's, which is a hydration
   * difference on purpose: the admin's clock is the correct one.
   */
  const endsAt = new Date(expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Bar>
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
             * navigation would resolve `/platform` against the route tree and land
             * on `/platform/platform`. See lib/hard-navigate.ts.
             */
            hardNavigate(`${window.location.protocol}//${adminHost}/`);
          });
        }}
        // py-1 keeps the target above the 24px minimum (apps/web/AGENTS.md).
        className="text-paper hover:text-signal-bright py-1 underline underline-offset-2 disabled:opacity-60"
      >
        {pending ? 'Leaving…' : 'Return to the console'}
      </button>
    </Bar>
  );
}
