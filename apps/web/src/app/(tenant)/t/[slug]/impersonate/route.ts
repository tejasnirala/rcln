import { NextResponse, type NextRequest } from 'next/server';
import type { AuthSession } from '@rcln/contracts';
import { api } from '@/lib/api';
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE, baseCookie } from '@/lib/session-cookie';

/**
 * Where a super admin lands on their way into a clinic.
 *
 * WHY THIS IS A ROUTE HANDLER AND NOT A SERVER ACTION
 *   The console lives on `admin.<root>` and this lives on `<slug>.<root>`, so
 *   the request that arrives here is cross-origin. Next blocks cross-origin
 *   Server Action POSTs — correctly, that is the CSRF defence — and a Route
 *   Handler is the supported way to accept one.
 *
 *   It has to be a request to THIS host at all because session cookies are
 *   host-only by design (lib/session.ts). `admin.<root>` cannot write a cookie
 *   for a clinic's subdomain; only a response served from the subdomain can. So
 *   the ticket crosses in a POST body and the session is minted here.
 *
 * WHY THE COOKIES ARE SET ON THE RESPONSE AND NOT THROUGH `setSessionCookies`
 *   Two reasons, and both matter. The redirect and the Set-Cookie have to travel
 *   together, which is unambiguous when they are the same object. And the refresh
 *   cookie must be REPLACED rather than left alone, for a reason worth spelling
 *   out because it used to be a deletion:
 *
 *   An ordinary sign-in on this host, weeks ago, may have left a refresh cookie
 *   here. If it survives this response, `proxy.ts` finds it fifteen minutes from
 *   now — access cookie expired, refresh cookie present — renews it, and quietly
 *   swaps the impersonation session for THAT OTHER ACCOUNT'S. A super admin would
 *   be silently signed in as a clinic employee, with no strip on screen and audit
 *   rows attributed to the wrong person.
 *
 *   This used to be prevented by deleting the cookie, which was correct while an
 *   impersonation session had no refresh token of its own. It has one now, so the
 *   success path overwrites instead: writing this session's refresh token to the
 *   same cookie evicts the stale one just as deleting it did. What must never
 *   happen is leaving the old value in place — if this session ever stops issuing a
 *   refresh token, this MUST go back to a delete.
 *
 *   EVERY FAILURE EXIT DELETES BOTH. That is not symmetry for its own sake: by the
 *   time this handler runs, `proxy.ts` has already renewed any stale refresh cookie
 *   into a live pair for that other account, and a bare redirect would ship those
 *   headers to the browser untouched. See `abandon`.
 *
 * A GET here is a 405, deliberately. This endpoint spends a credential; a URL
 * that does that is one prefetch or one shared link away from spending it by
 * accident.
 *
 * WHY THE REDIRECTS ARE RELATIVE
 *   `NextResponse.redirect` needs an absolute URL, and the obvious source is
 *   `new URL('/', request.url)` — but `request.url` is built from the connection,
 *   not from the Host header. Behind anything that terminates the connection
 *   elsewhere, that sends the browser to an internal hostname, and this is the
 *   one response in the product that MUST land on the clinic's own origin: a
 *   redirect off-host would strip the session cookie travelling with it. A
 *   relative `Location` is resolved by the browser against the address it
 *   actually asked for, which is the only host that can be right.
 */

/** 303, so the browser follows with GET rather than re-POSTing the ticket. */
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

/**
 * Every failure exit, and it must clear both cookies.
 *
 * NOT MERELY TIDINESS. `proxy.ts` already ran on this POST — `/impersonate` is on
 * its matcher and this is a tenant subdomain — so if the access cookie had lapsed
 * and a stale refresh cookie was sitting on this host from an ordinary sign-in, it
 * has ALREADY been rotated into a live access+refresh pair for that account, and
 * those `Set-Cookie` headers are on the response being built here.
 *
 * Returning without touching them hands the browser a working session as that
 * employee: the admin lands on this clinic's `/login` already signed in as
 * somebody else, with no platform strip on screen, and any write they make is
 * audited under that person's name. Deleting here is what stops it — the success
 * path overwrites both cookies instead, which achieves the same eviction.
 */
function abandon(): NextResponse {
  const response = seeOther('/login');
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;

  const form = await request.formData().catch(() => null);
  const handoffToken = String(form?.get('handoffToken') ?? '');

  if (!handoffToken) return abandon();

  const result = await api<AuthSession>('/api/v1/auth/impersonation/claim', {
    method: 'POST',
    slug,
    body: { handoffToken },
  });

  /*
   * A spent, expired or wrong-clinic ticket lands on this clinic's sign-in page.
   * Nothing is said about which of the three it was — this endpoint is
   * unauthenticated, and a distinguishable answer would tell anyone who found a
   * ticket whether it was ever real.
   */
  if (!result.ok || !result.data) return abandon();

  const session = result.data;
  const response = seeOther('/');

  response.cookies.set(ACCESS_COOKIE, session.accessToken, {
    ...baseCookie,
    maxAge: session.expiresIn,
  });

  /*
   * Overwriting, not deleting — see the header. An impersonation session issues a
   * real refresh token now, and this is what lets `proxy.ts` renew THIS session
   * rather than resurrecting whatever was here before.
   *
   * `REFRESH_MAX_AGE` is the cookie's life, not the session's. The session is
   * bounded server-side twice over — a thirty-minute idle window and an eight-hour
   * ceiling from `created_at` — and neither is something a cookie can enforce. A
   * cookie outliving its session is harmless: the token inside it stops rotating.
   */
  if (session.refreshToken) {
    response.cookies.set(REFRESH_COOKIE, session.refreshToken, {
      ...baseCookie,
      maxAge: REFRESH_MAX_AGE,
    });
  } else {
    // Defensive, and the reason the header says what it says: with no refresh
    // token of our own, a stale one left here would be renewed into someone
    // else's session.
    response.cookies.delete(REFRESH_COOKIE);
  }

  return response;
}
