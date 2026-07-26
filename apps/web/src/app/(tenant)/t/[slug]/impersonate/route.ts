import { NextResponse, type NextRequest } from 'next/server';
import type { AuthSession } from '@rcln/contracts';
import { api } from '@/lib/api';
import { ACCESS_COOKIE, REFRESH_COOKIE, baseCookie } from '@/lib/session-cookie';

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
 *   together, which is unambiguous when they are the same object. And an
 *   impersonation session has NO refresh token — so any refresh cookie already
 *   sitting on this host, from an ordinary sign-in weeks ago, has to be deleted.
 *   Left in place, `proxy.ts` would renew it fifteen minutes from now and quietly
 *   swap the impersonation session for that other account's.
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;

  const form = await request.formData().catch(() => null);
  const handoffToken = String(form?.get('handoffToken') ?? '');

  if (!handoffToken) return seeOther('/login');

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
  if (!result.ok || !result.data) return seeOther('/login');

  const session = result.data;
  const response = seeOther('/');

  response.cookies.set(ACCESS_COOKIE, session.accessToken, {
    ...baseCookie,
    // The whole thirty minutes. There is nothing to renew it with, so the cookie
    // and the session end together.
    maxAge: session.expiresIn,
  });
  response.cookies.delete(REFRESH_COOKIE);

  return response;
}
