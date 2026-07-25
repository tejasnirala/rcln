import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Tenant resolution from the Host header.
 *
 * In Next.js 16 this file is `proxy.ts`, not `middleware.ts` — Middleware was
 * renamed to Proxy in 16. Behaviour is the same; only the convention changed.
 *
 *   alpha.xyz.com/patients  ->  rewritten to /t/alpha/patients
 *   xyz.com/pricing         ->  untouched (marketing site)
 *   admin.xyz.com/...       ->  rewritten to /platform/... (super-admin console)
 *
 * This does resolution only, never authorisation. The proxy runs at the edge
 * with no database access, so it cannot know whether `alpha` exists or whether
 * the caller may see it — the API settles both, and an unknown tenant comes
 * back as 404 so the customer list cannot be enumerated.
 */

const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

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

export function proxy(request: NextRequest): NextResponse {
  const host = request.headers.get('host');
  if (!host) return NextResponse.next();

  const subdomain = getSubdomain(host);
  const { pathname, search } = request.nextUrl;

  if (!subdomain) {
    return NextResponse.next();
  }

  if (subdomain === 'admin') {
    return NextResponse.rewrite(new URL(`/platform${pathname}${search}`, request.url));
  }

  if (RESERVED.has(subdomain)) {
    return NextResponse.next();
  }

  // Pass the slug on as a header as well: server components read it without
  // re-parsing the host, and route handlers get it for free.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-tenant-slug', subdomain);

  return NextResponse.rewrite(new URL(`/t/${subdomain}${pathname}${search}`, request.url), {
    request: { headers: requestHeaders },
  });
}

export const config = {
  // Skip API routes, Next internals, and anything with a file extension.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
