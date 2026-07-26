/**
 * The session cookies, defined once.
 *
 * Two places write them and they must agree exactly: `proxy.ts`, which renews
 * them before a render, and `lib/session.ts`, which writes them from Server
 * Actions. A cookie written with a different `path` or `sameSite` is a DIFFERENT
 * cookie to the browser — you get two, the wrong one is sent, and the symptom is
 * an intermittent sign-out with nothing in any log.
 *
 * Deliberately free of `next/headers`. The proxy runs before the request reaches
 * the app and cannot import it, so anything shared with the proxy lives here
 * rather than in session.ts.
 */

export const ACCESS_COOKIE = 'rcln_at';
export const REFRESH_COOKIE = 'rcln_rt';

/** Refresh tokens live 30 days server-side; the cookie must not outlive that. */
export const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

export const baseCookie = {
  httpOnly: true,
  // Lax, not Strict: Strict would drop the cookie on the cross-host redirect
  // from the apex after signup, and the user would land signed out. Lax still
  // blocks it on cross-site POSTs, which is the CSRF case that matters.
  sameSite: 'lax' as const,
  // Not enforced in development because lvh.me is served over plain http.
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  // NOTE: no `domain`. Host-only is the isolation boundary between one clinic's
  // subdomain and another's. Do not add one. See lib/session.ts.
};
