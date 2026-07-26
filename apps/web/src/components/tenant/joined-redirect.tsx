'use client';

import { useEffect } from 'react';
import { hardNavigate } from '@/lib/hard-navigate';

/**
 * "You are in" — and then leave.
 *
 * WHY THE NAVIGATION IS NOT IN THE FORM
 *   It used to be, and it never ran. A Server Action's response re-renders the
 *   page's Server Components, and this page re-fetches the invitation preview —
 *   which 404s, because accepting is precisely what consumed the token. The page
 *   swapped to its dead-link branch and `JoinForm` unmounted in the same commit,
 *   taking its pending effect with it. The user was left sitting on /join with a
 *   session they could not see, and had to type the URL themselves.
 *
 *   This component is rendered BY that re-render, so it mounts fresh in the new
 *   tree and its effect is the first thing that runs. Nothing can unmount it
 *   first, because it is what the page became.
 *
 * The link is not decoration. Without JavaScript the effect never runs, and the
 * membership exists either way — a plain `<a>` finishes the job, and being a real
 * document load it goes through proxy.ts exactly as the scripted path does. Same
 * reasoning as ContinueLink in login-form.tsx.
 */
export function JoinedRedirect({ organizationName }: { organizationName: string }) {
  useEffect(() => {
    hardNavigate('/');
  }, []);

  return (
    <>
      <p className="eyebrow">You are in</p>
      <h1 className="font-display mt-2 text-3xl tracking-tight">Welcome to {organizationName}</h1>
      <p role="status" className="text-muted mt-4 text-sm leading-relaxed">
        Taking you to your clinic now.
      </p>
      <p className="mt-6 text-[0.875rem]">
        {/*
         * A plain <a>, deliberately — `<Link>` is what the rule wants and what
         * this must not be. A client navigation to `/` resolves against the
         * route tree and lands on the marketing page; only a document load runs
         * proxy.ts and reaches the clinic. See lib/hard-navigate.ts.
         */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="text-drape hover:text-drape-deep underline underline-offset-2">
          Continue to {organizationName}
        </a>
      </p>
    </>
  );
}
