/**
 * The one place the web talks to the API.
 *
 * Server-side only. Not enforced by the `server-only` package — that would be a
 * new dependency for a guard Next already provides: `API_INTERNAL_URL` has no
 * NEXT_PUBLIC_ prefix, so importing this into a Client Component leaves the URL
 * undefined rather than shipping it to the browser. Import it from Server
 * Actions and Server Components only.
 *
 * TWO URLS, AND THEY ARE NOT INTERCHANGEABLE
 *   `API_INTERNAL_URL` is how this container reaches the API container.
 *   `NEXT_PUBLIC_API_URL` is how a *browser* reaches it. The public one points
 *   at localhost, which inside the web container means the web container. Same
 *   string, different machine — it typechecks and fails at runtime.
 *
 *   This module is server-only, so it always uses the internal one.
 *
 * THE TENANT TRAP
 *   `resolveTenant` in apps/api derives the organization from the Host header.
 *   A server-to-server fetch to `http://api:5000` has Host `api:5000`, which
 *   resolves to no tenant — so every tenant-scoped call 404s, and a 404 from an
 *   unknown tenant is indistinguishable from a missing route.
 *
 *   Passing `slug` sets Host to `<slug>.<root-domain>` so the API resolves the
 *   right tenant. Omit it only for genuinely pre-tenant calls (registration,
 *   the demo form), which belong on the apex.
 */

import { headers } from 'next/headers';

const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://api:5000';
const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

/** The API's envelope. Every route answers in this shape. */
export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: Record<string, string[]>;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}

/**
 * The address of the person whose browser started this, for the API's rate
 * limiter.
 *
 * WHY THIS IS NOT OPTIONAL POLISH
 *   Every call in this file is server-to-server, so without it the API sees the
 *   WEB CONTAINER's address on every request from every user of every clinic —
 *   one bucket. `authLimiter` allows 10 requests per 15 minutes, so the whole
 *   platform shared ten logins a quarter of an hour, and the tenth clinic to
 *   sign in was told its password was wrong.
 *
 *   A chain of proxies appends, so the original client is the FIRST entry.
 *   Returns undefined rather than a placeholder when there is nothing to
 *   forward: the API then falls back to the socket address, which is at least
 *   honest about what it knows.
 */
async function clientAddress(): Promise<string | undefined> {
  const incoming = await headers();
  const chain = incoming.get('x-forwarded-for');
  const first = chain?.split(',')[0]?.trim();
  return first ?? incoming.get('x-real-ip') ?? undefined;
}

export interface ApiRequest {
  // PUT is for the endpoints that replace a resource wholesale rather than
  // patching it — branch opening hours are the first, where an omitted day
  // means the branch stops opening that day.
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Tenant to address. Sets the Host header the API resolves the tenant from. */
  slug?: string | undefined;
  /**
   * Exact Host header, for surfaces that are not a tenant — the admin console
   * sends `admin.<root-domain>`, which `resolveTenant` skips by name. Ignored
   * when `slug` is given.
   */
  host?: string | undefined;
  /** Bearer token for authenticated calls. */
  accessToken?: string | undefined;
}

/** The admin console's host. `resolveTenant` matches this exactly and skips it. */
export const ADMIN_HOST = `admin.${ROOT_DOMAIN}`;

/**
 * Never throws for an HTTP status — a 4xx is an answer, not an exception, and
 * every caller here renders it rather than crashing a page. A genuine network
 * failure returns status 0 with a message that names no internal host.
 */
export async function api<T>(path: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
  const { method = 'GET', body, slug, host, accessToken } = request;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  /*
   * `x-forwarded-host`, NOT `host`.
   *
   * `Host` is a forbidden header name in the fetch spec, so undici drops it
   * without an error or a warning. This file used to set it, and every
   * server-side call therefore reached the API as `api:5000` — resolving to no
   * tenant. Login answered by minting a session scoped to no organization, and
   * nothing failed loudly enough to notice. Do not change this back.
   *
   * resolveTenant in apps/api prefers this header; see the trust note there.
   */
  const targetHost = slug ? `${slug}.${ROOT_DOMAIN}` : host;
  if (targetHost) headers['x-forwarded-host'] = targetHost;
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;

  // Who the API should rate-limit. See clientAddress.
  const forwardedFor = await clientAddress();
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Auth and tenancy are per-request state; a cached answer here would be
      // one user's session served to the next.
      cache: 'no-store',
    });

    const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;

    return {
      ok: response.ok && payload.success !== false,
      status: response.status,
      ...(payload.data !== undefined ? { data: payload.data } : {}),
      ...(payload.message !== undefined ? { message: payload.message } : {}),
      ...(payload.errors !== undefined ? { fieldErrors: payload.errors } : {}),
    };
  } catch {
    // The underlying error names internal hostnames and ports. Never surface it.
    return {
      ok: false,
      status: 0,
      message: 'We could not reach the service. Try again in a moment.',
    };
  }
}

/** Flatten Zod issues into the `fieldErrors` shape the forms render. */
export function fieldErrorsFrom(
  issues: { path: PropertyKey[]; message: string }[]
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}
