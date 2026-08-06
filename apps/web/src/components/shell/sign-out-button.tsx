'use client';

import { useTransition } from 'react';
import { hardNavigate } from '@/lib/hard-navigate';

/**
 * Sign out, from either surface.
 *
 * The two surfaces differ only in which action revokes the session and where the
 * browser lands afterwards, so both are props rather than two components. `action`
 * is a bound Server Action — the clinic's is bound to its slug on the server, so
 * the browser cannot substitute another clinic's.
 *
 * A client component purely because the navigation must be a real request:
 * `/login` is this clinic's sign-in page only after `proxy.ts` rewrites it, and
 * the router knows nothing about that rewrite. See lib/hard-navigate.ts.
 */
export function SignOutButton({
  action,
  redirectTo,
}: {
  action: () => Promise<void>;
  /** Where to land once the session is gone. A path, resolved by the browser. */
  redirectTo: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await action();
          hardNavigate(redirectTo);
        });
      }}
      // py-1 keeps the target above the 24px minimum (apps/web/AGENTS.md).
      className="text-drape hover:text-drape-deep py-1 text-[0.8125rem] underline underline-offset-2 disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
