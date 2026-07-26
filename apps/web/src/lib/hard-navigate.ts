'use client';

/**
 * Leave the Next router and make the browser fetch the URL itself.
 *
 * WHY THIS EXISTS
 *   `proxy.ts` rewrites by Host: on a clinic subdomain `/` means `/t/<slug>`,
 *   and on the admin host it means `/platform`. Nothing in the client router
 *   knows that — the rewrite is applied to incoming HTTP requests only.
 *
 *   So a `redirect('/')` from a Server Action lands on the wrong page. The
 *   action's POST is itself rewritten (`/login` -> `/t/<slug>/login`), the
 *   action runs, and Next then resolves the redirect target against the route
 *   tree to embed that page's RSC payload in the same response. `/` matches
 *   `(marketing)/page.tsx`, so a user who has just signed in to their clinic is
 *   handed the public landing page — on their own subdomain. Pressing reload
 *   fixes it, because a reload is a real request and the proxy runs.
 *
 *   An absolute URL does not help: Next normalises a same-origin absolute URL
 *   back to a path and resolves it exactly the same way.
 *
 *   `window.location.assign` is not a router navigation at all, so the proxy
 *   always runs. It also drops the client router cache, which matters after
 *   signing in or out: those entries were built under the previous session.
 *
 * WHEN TO USE IT
 *   Any navigation that crosses an authentication boundary or lands on a
 *   proxy-rewritten path — sign in, sign out, switch branch. Ordinary in-app
 *   links are fine as `<Link>`: the proxy does run for the RSC requests those
 *   make.
 */
export function hardNavigate(path: string): void {
  window.location.assign(path);
}
