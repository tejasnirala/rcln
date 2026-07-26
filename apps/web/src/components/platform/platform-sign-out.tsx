'use client';

import { useTransition } from 'react';
import { platformSignOut } from '@/app/(platform)/platform/actions';
import { hardNavigate } from '@/lib/hard-navigate';

/**
 * Sign out of the console.
 *
 * A client component only because the navigation has to be a real one: the
 * action clears the cookies and returns, and `/` on the admin host resolves to
 * the console only once proxy.ts has rewritten it. See lib/hard-navigate.ts.
 */
export function PlatformSignOut() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await platformSignOut();
          hardNavigate('/');
        });
      }}
      className="text-drape hover:text-drape-deep py-1 text-[0.8125rem] underline underline-offset-2 disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
