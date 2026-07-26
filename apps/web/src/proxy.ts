import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE, baseCookie } from '@/lib/session-cookie';

/**
 * Tenant resolution from the Host header, and session renewal.
 *
 * In Next.js 16 this file is `proxy.ts`, not `middleware.ts` — Middleware was
 * renamed to Proxy in 16. Behaviour is the same; only the convention changed.
 *
 *   alpha.xyz.com/patients  ->  rewritten to /t/alpha/patients
 *   xyz.com/pricing         ->  untouched (marketing site)
 *   admin.xyz.com/...       ->  rewritten to /platform/... (super-admin console)
 *
 * TENANT RESOLUTION IS RESOLUTION ONLY, NEVER AUTHORISATION. Nothing here
 * decides whether `alpha` exists or whether the caller may see it — the API
 * settles both, and an unknown tenant comes back as 404 so the customer list
 * cannot be enumerated.
 *
 * WHY SESSION RENEWAL LIVES HERE TOO
 *   It is not an authorisation decision — it exchanges a credential the browser
 *   already holds for a fresher one, and the API still decides what that buys.
 *   It is here because this is the only place in the request that can do it:
 *   HTTP cannot add a Set-Cookie header once a render has begun streaming, so
 *   `cookies().set()` throws in a Server Component. Doing it in `getSession`
 *   meant every clinic page 500'd fifteen minutes after sign-in AND left the
 *   spent refresh token in the browser to be replayed into the API's reuse
 *   detection, which revokes the whole session family. See .kb/Architecture/PITFALLS.md.
 *
 *   Next 16 runs Proxy in the Node.js runtime, so the fetch below is ordinary
 *   server-to-server traffic on the internal network.
 */

const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';
const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://api:5000';

/**
 * Subdomains the platform keeps. A tenant claiming `api` or `admin` would break
 * routing for everyone, so registration rejects these too — keep both lists in
 * step with RESERVED_SLUGS in @rcln/contracts.
 */
const RESERVED = new Set([
  'www',
  'admin',
  'api',
  'app',
  'auth',
  'static',
  'cdn',
  'assets',
  'mail',
  'smtp',
  'ftp',
  'blog',
  'status',
  'help',
  'support',
  'docs',
  'dev',
  'staging',
  'test',
  'demo',
  'billing',
  'account',
  'accounts',
  'login',
  'signup',
  'register',
  'dashboard',
  'internal',
  'system',
  'root',
  'superadmin',
  'platform',
]);

function getSubdomain(host: string): string | null {
  const hostname = host.split(':')[0]?.toLowerCase();
  if (!hostname) return null;

  // Vercel preview deployments never carry a tenant subdomain.
  if (hostname.endsWith('.vercel.app')) return null;

  if (hostname === ROOT_DOMAIN) return null;
  if (!hostname.endsWith(`.${ROOT_DOMAIN}`)) return null;

  const label = hostname.slice(0, -(ROOT_DOMAIN.length + 1));
  // Only a single label is a tenant: `alpha` yes, `a.b` no. A wildcard TLS cert
  // covers exactly one level, so deeper names would fail the handshake anyway.
  return label.includes('.') ? null : label;
}

/**
 * The browser's address, as a header to pass on — or nothing if we do not know
 * it. A chain of proxies appends, so the original client is the first entry.
 */
function clientAddress(request: NextRequest): Record<string, string> {
  const chain = request.headers.get('x-forwarded-for');
  const client = chain?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip');
  return client ? { 'x-forwarded-for': client } : {};
}

/** What renewal decided, to be applied to whichever response we build. */
type Renewal =
  | { kind: 'none' }
  | { kind: 'renewed'; accessToken: string; refreshToken: string; maxAge: number }
  | { kind: 'spent' };

/**
 * Swap an expired session for a fresh one, before the render sees it.
 *
 * The trigger is the ACCESS cookie being absent while the refresh cookie is
 * present. That needs no JWT decoding and cannot drift out of step with the
 * token's real lifetime: the access cookie is written with `maxAge` equal to the
 * token's own expiry, so the browser stops sending it at the moment it dies.
 *
 * `request.cookies` is mutated as well as the response, so the render happening
 * in this same pass sees the new token rather than waiting a round trip for it.
 *
 * A failure is not an error to surface. The token is spent, revoked, or was
 * rotated by someone else — that last case being reuse detection, which has
 * already killed every session for this user. All three mean the same thing to
 * the browser: there is nothing to keep.
 */
async function renewSession(request: NextRequest, apiHost: string): Promise<Renewal> {
  if (request.cookies.has(ACCESS_COOKIE)) return { kind: 'none' };

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return { kind: 'none' };

  try {
    const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // `x-forwarded-host`, NOT `host` — a forbidden header name that fetch
        // drops silently. The whole of lib/api.ts exists for this reason.
        'x-forwarded-host': apiHost,
        // Renewal is metered by `authLimiter` like every other auth route, so
        // it has to be attributed to the browser rather than to this container —
        // otherwise one bucket covers every signed-in user on the platform.
        ...clientAddress(request),
      },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });

    const payload = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { accessToken: string; refreshToken: string; expiresIn: number };
    };

    if (!response.ok || !payload.data?.accessToken) return { kind: 'spent' };

    return {
      kind: 'renewed',
      accessToken: payload.data.accessToken,
      refreshToken: payload.data.refreshToken,
      maxAge: payload.data.expiresIn,
    };
  } catch {
    /*
     * The API is unreachable — a deploy, a restart, a network blip. Deleting the
     * cookies here would sign every user out over a hiccup they did not cause,
     * so the session is left exactly as it was and the render simply finds no
     * usable access token. The next request tries again.
     */
    return { kind: 'none' };
  }
}

/** Apply renewal to the request the render will see, before headers are copied. */
function applyToRequest(request: NextRequest, renewal: Renewal): void {
  if (renewal.kind === 'renewed') {
    request.cookies.set(ACCESS_COOKIE, renewal.accessToken);
    request.cookies.set(REFRESH_COOKIE, renewal.refreshToken);
  } else if (renewal.kind === 'spent') {
    request.cookies.delete(ACCESS_COOKIE);
    request.cookies.delete(REFRESH_COOKIE);
  }
}

/** Apply renewal to the response, which is what reaches the browser. */
function applyToResponse(response: NextResponse, renewal: Renewal): NextResponse {
  if (renewal.kind === 'renewed') {
    response.cookies.set(ACCESS_COOKIE, renewal.accessToken, {
      ...baseCookie,
      maxAge: renewal.maxAge,
    });
    response.cookies.set(REFRESH_COOKIE, renewal.refreshToken, {
      ...baseCookie,
      maxAge: REFRESH_MAX_AGE,
    });
  } else if (renewal.kind === 'spent') {
    response.cookies.delete(ACCESS_COOKIE);
    response.cookies.delete(REFRESH_COOKIE);
  }
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get('host');
  if (!host) return NextResponse.next();

  const subdomain = getSubdomain(host);
  const { pathname, search } = request.nextUrl;

  /*
   * The apex holds no session — cookies are host-only, so signing in at a
   * clinic's subdomain leaves nothing here to renew. Reserved subdomains other
   * than `admin` are not surfaces of this app at all.
   */
  if (!subdomain) return NextResponse.next();
  if (subdomain !== 'admin' && RESERVED.has(subdomain)) return NextResponse.next();

  // The host the API resolves the tenant from, without the dev port — the same
  // string lib/api.ts sends. `admin.<root>` is skipped by name over there.
  const renewal = await renewSession(request, `${subdomain}.${ROOT_DOMAIN}`);
  applyToRequest(request, renewal);

  if (subdomain === 'admin') {
    return applyToResponse(
      NextResponse.rewrite(new URL(`/platform${pathname}${search}`, request.url), {
        request: { headers: new Headers(request.headers) },
      }),
      renewal
    );
  }

  // Pass the slug on as a header as well: server components read it without
  // re-parsing the host, and route handlers get it for free.
  // Copied AFTER applyToRequest, so the copy carries the renewed cookie header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-tenant-slug', subdomain);

  return applyToResponse(
    NextResponse.rewrite(new URL(`/t/${subdomain}${pathname}${search}`, request.url), {
      request: { headers: requestHeaders },
    }),
    renewal
  );
}

export const config = {
  // Skip API routes, Next internals, and anything with a file extension.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
