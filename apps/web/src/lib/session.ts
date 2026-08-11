import { cache } from 'react';
import { cookies } from 'next/headers';
import {
  DEFAULT_TIME_FORMAT,
  type AuthSession,
  type BranchSummary,
  type TimeFormat,
} from '@rcln/contracts';
import { ADMIN_HOST, api } from './api';
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE, baseCookie } from './session-cookie';

/**
 * The session, held in httpOnly cookies.
 *
 * WHY COOKIES AND NOT localStorage
 *   Anything JavaScript can read, an injected script can exfiltrate. These
 *   cookies are httpOnly, so page scripts cannot see them at all — the tokens
 *   exist only between the browser and this server. CLAUDE.md forbids putting
 *   PHI in localStorage; a token that unlocks PHI belongs under the same rule.
 *
 * WHY THE COOKIE IS NOT SET ON THE PARENT DOMAIN
 *   A cookie with `domain=.rcln.com` is sent to EVERY subdomain, so a session
 *   minted at alpha.rcln.com would be handed to beta.rcln.com — one clinic's
 *   credentials delivered to another clinic's host. Omitting `domain` entirely
 *   makes the cookie host-only, which is the isolation .kb/Architecture/architecture.md §3
 *   asks for: "a session at alpha.xyz.com is useless at beta.xyz.com".
 *
 *   This is also why the apex cannot sign anyone in, and why registration ends
 *   in a redirect to the clinic's own subdomain rather than a logged-in state.
 *
 * WHAT IS AND IS NOT STORED
 *   Two tokens and the active branch id. No name, no email, no phone, no
 *   patient anything — the session detail is refetched from GET /auth/session,
 *   which resolves permissions fresh rather than trusting a cookie that has
 *   been sitting in a browser for a fortnight.
 *
 * WHY NOTHING HERE IS WRITTEN DURING A RENDER
 *   `cookies().set()` throws in a Server Component — HTTP cannot add a
 *   Set-Cookie header once the response has begun streaming, so Next refuses it
 *   outright. `getSession` used to renew an expired token and write the result,
 *   which meant every clinic page 500'd fifteen minutes after sign-in, and the
 *   spent refresh token stayed in the browser to be replayed into the API's
 *   reuse detection — revoking the whole session family. See .kb/Architecture/PITFALLS.md.
 *
 *   Renewal therefore happens in `proxy.ts`, which runs before the render and
 *   CAN set cookies. The readers below never write: they either find a usable
 *   access token or return null, and null means "redirect to /login".
 *
 *   The writers — `setSessionCookies`, `clearSessionCookies` — are for Server
 *   Actions and Route Handlers only. Calling either from a page or a layout is
 *   the bug described above.
 */

export async function setSessionCookies(session: AuthSession): Promise<void> {
  const jar = await cookies();

  jar.set(ACCESS_COOKIE, session.accessToken, {
    ...baseCookie,
    maxAge: session.expiresIn,
  });

  /**
   * Only when there is actually one to store.
   *
   * Refresh tokens rotate on /auth/refresh and nowhere else, so the endpoints
   * that re-issue an ACCESS token without rotating — /auth/session,
   * /auth/switch-branch, /auth/switch-organization — answer with an empty
   * string here. Writing that through would overwrite a live refresh token with
   * nothing, and the user would be signed out the moment their access token
   * expired: fifteen minutes after switching branch, for no visible reason.
   */
  if (session.refreshToken) {
    jar.set(REFRESH_COOKIE, session.refreshToken, {
      ...baseCookie,
      maxAge: REFRESH_MAX_AGE,
    });
  }
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

/**
 * The signed-in user for this tenant, or null.
 *
 * READ-ONLY. An expired access token was already renewed by `proxy.ts` before
 * this ran, and the renewed one is on the request this render is serving — so
 * by the time we get here there is either a usable token or no session at all.
 * Retrying the refresh here would be both pointless and illegal; see the header.
 *
 * Returns null rather than throwing so a layout can simply redirect.
 *
 * Memoised per request with React `cache`. The authenticated shell resolves the
 * session in its layout and most pages need it again for their own content;
 * without this that is a second round-trip to /auth/session on every render.
 */
export const getSession = cache(async (slug: string): Promise<AuthSession | null> => {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const result = await api<AuthSession>('/api/v1/auth/session', { slug, accessToken });
  return result.ok && result.data ? result.data : null;
});

/**
 * The branches this session may actually work in, in switcher order.
 *
 * ⚠️ USE THIS, NOT `GET /api/v1/branches`, ANYWHERE A SCREEN NEEDS "which
 *   clinics am I working in". That endpoint is behind `branch.read`, which only
 *   the org-wide roles and BRANCH_ADMIN hold, because it opens the branch
 *   MANAGEMENT screen. A receptionist or a doctor calling it gets a 403 — and
 *   since a failed call degrades to an empty list, the screen silently concludes
 *   the person has no clinic at all. That is precisely how the appointment board
 *   came to tell the front desk, whose main screen it is, "No clinic is in scope
 *   for you yet."
 *
 * Costs nothing: `getSession` is memoised per request and the layout has already
 * resolved it. Discloses nothing either — these are the branches the caller is
 * already scoped to, which is why no permission guards them.
 *
 * Empty genuinely means empty: a member of staff whose roles carry no branch.
 */
export async function branchesInScope(slug: string): Promise<BranchSummary[]> {
  const session = await getSession(slug);
  if (!session) return [];

  return (
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)?.branches ??
    []
  );
}

/**
 * The clinic's own country, ISO 3166-1 alpha-2.
 *
 * ⚠️ THE ORGANIZATION'S, BECAUSE A BRANCH DOES NOT HAVE ONE. `branches` carries
 *   its own `timezone` — a group can run clinics in two zones — but not a
 *   country code, so every branch is in the organization's country until the
 *   schema says otherwise. That is the right default anyway: the things this
 *   decides (identity documents, postcode format, dialling code, and now the
 *   unit a temperature is written in) follow the jurisdiction the clinic is
 *   registered in.
 *
 * ⚠️ FROM THE SESSION, NOT `GET /organization` — that is behind
 *   `organization.read`, which the front desk does not hold, and these are all
 *   front-desk forms. Defaults to `IN`, which is what every screen already
 *   assumed before this existed.
 */
export async function countryOf(slug: string): Promise<string> {
  const session = await getSession(slug);
  if (!session) return 'IN';

  return (
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)
      ?.countryCode ?? 'IN'
  );
}

/**
 * The zone this clinic reads its clock in — the active branch's, or the first
 * one in scope.
 *
 * ⚠️ FOR SCREENS THAT ARE NOT ABOUT ONE APPOINTMENT. An appointment carries its
 *   OWN branch's `timezone` on the row, and that is the one to format it with:
 *   an org-wide admin scoped to Bengaluru can open a booking made in Dubai, and
 *   the caller's active branch is then the wrong answer. This is for everything
 *   else — a doctor's leave, an audit trail — where the reader's own clinic is
 *   what "when did this happen" means.
 *
 * ⚠️ NEVER THE BROWSER'S OR THE CONTAINER'S ZONE. See `formatClinicTime`.
 *
 * Falls back to `Asia/Kolkata`, which is the schema default on both
 * `organizations.timezone` and `branches.timezone` — a caller with no branch in
 * scope has no clinical times to read anyway.
 */
export async function timezoneOf(slug: string): Promise<string> {
  const session = await getSession(slug);
  if (!session) return 'Asia/Kolkata';

  const branches =
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)?.branches ??
    [];

  const active = branches.find((b) => b.id === session.activeBranchId) ?? branches[0];
  return active?.timezone ?? 'Asia/Kolkata';
}

/**
 * The clock face this clinic reads — `12H` or `24H`.
 *
 * ⚠️ THE COMPANION TO `timezoneOf`, AND SUBJECT TO THE SAME CAVEAT: it answers
 *   for the READER'S active branch, so an appointment carrying its own branch's
 *   `timeFormat` should be rendered with that instead. An org-wide admin scoped
 *   to a 24-hour hospital wing opening a booking made at the 12-hour walk-in
 *   clinic should see the clinic's clock, not their own.
 *
 * ⚠️ DISPLAY ONLY. Every instant is stored in UTC and rendered in the branch's
 *   zone; this decides nothing but the shape. See `formatClinicTime`.
 *
 * Costs nothing — `getSession` is memoised per request and the shell has already
 * resolved it. Falls back to the product default, which is what a caller with no
 * branch in scope would see anyway.
 */
export async function timeFormatOf(slug: string): Promise<TimeFormat> {
  const session = await getSession(slug);
  if (!session) return DEFAULT_TIME_FORMAT;

  const branches =
    session.memberships.find((m) => m.organizationId === session.activeOrganizationId)?.branches ??
    [];

  const active = branches.find((b) => b.id === session.activeBranchId) ?? branches[0];
  return active?.timeFormat ?? DEFAULT_TIME_FORMAT;
}

/**
 * The signed-in platform admin, or null.
 *
 * Same mechanics as `getSession`, including being read-only, and addressed at
 * the admin host rather than a tenant — `resolveTenant` skips `admin.<root>` by
 * name, so these calls carry no organization at all. The cookie is host-only as
 * everywhere else, so an admin session at admin.rcln.com is not a session at any
 * clinic.
 *
 * Returns null for a signed-in user who is NOT a platform admin: being logged in
 * is not the same as being allowed in here, and the console must not render for
 * an ordinary clinic account that wandered over.
 *
 * Memoised per request like `getSession`, for the same reason: the console's
 * layout resolves it to decide whether to render the gate, and every page under
 * it needs the same answer.
 */
export const getPlatformSession = cache(async (): Promise<AuthSession | null> => {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const result = await api<AuthSession>('/api/v1/auth/session', {
    host: ADMIN_HOST,
    accessToken,
  });

  if (!result.ok || !result.data) return null;
  return result.data.user.isPlatformAdmin ? result.data : null;
});
