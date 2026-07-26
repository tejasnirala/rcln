import type { Request, Response, NextFunction } from 'express';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { redis } from '../utils/redis.js';

/**
 * Step 3 of the request lifecycle: resolve the tenant from the Host header.
 *
 * Runs BEFORE authentication, because which tenant you are talking to is a
 * property of the URL, not of the caller. Uses the unscoped client on purpose:
 * `organizations` and `organization_domains` cannot be tenant-scoped, since
 * resolving them is what establishes the tenant in the first place.
 *
 * Cached in Redis because this is on the path of literally every request.
 */

export interface ResolvedTenant {
  organizationId: string;
  slug: string;
  status: string;
  currency: string;
  timezone: string;
}

const CACHE_TTL_SECONDS = 300;
const cacheKey = (host: string): string => `tenant:host:${host}`;

/** Strip the port and lowercase. `Alpha.LVH.me:3000` -> `alpha.lvh.me`. */
function normaliseHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0]?.toLowerCase().trim();
  return host && host.length > 0 ? host : null;
}

/**
 * Which host this request is *for*, which is not always the host it arrived on.
 *
 * WHY THIS IS NOT JUST `req.headers.host`
 *   Every browser request reaches the API through the Next BFF, and that hop is
 *   a server-side `fetch`. `Host` is a forbidden header name in the fetch spec,
 *   so undici silently drops any attempt to set it — the request arrives as
 *   `api:5000` and resolves to no tenant at all.
 *
 *   That failed silently for the whole of Phase 1: no route was behind
 *   requireTenant, and the one place it mattered — login — reads
 *   `req.tenant?.organizationId ?? null` and simply issued a session scoped to
 *   no organization. supertest sets `Host` normally, so the integration suite
 *   never saw it either.
 *
 * THE TRUST BOUNDARY
 *   `x-forwarded-host` is the standard way a proxy says "the client asked for
 *   this host", and it is what Express's own `req.hostname` prefers when
 *   `trust proxy` is on. Honouring it means the API must not be reachable
 *   except through the BFF or an ingress that OVERWRITES this header — an
 *   attacker who can reach the API directly could otherwise address any tenant.
 *
 *   What that would and would not get them: `authenticate` answers 404 when a
 *   token's organization does not match the resolved tenant, so a spoofed host
 *   grants nothing without credentials that are already valid for that clinic.
 *   It is still a tenancy control, and the deployment must keep the API private.
 */
function requestedHost(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-host'];
  // A chain of proxies appends; the original client host is the first entry.
  const claimed = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return normaliseHost(claimed) ?? normaliseHost(req.headers.host);
}

async function lookupTenant(host: string): Promise<ResolvedTenant | null> {
  const cached = await redis.get(cacheKey(host));
  if (cached) {
    return cached === 'MISS' ? null : (JSON.parse(cached) as ResolvedTenant);
  }

  const prisma = unsafeDbClient();
  const domain = await prisma.organizationDomain.findUnique({
    where: { domain: host },
    select: {
      organization: {
        select: {
          id: true,
          slug: true,
          status: true,
          currency: true,
          timezone: true,
          deletedAt: true,
        },
      },
    },
  });

  const org = domain?.organization;
  const resolved: ResolvedTenant | null =
    org && !org.deletedAt
      ? {
          organizationId: org.id,
          slug: org.slug,
          status: org.status,
          currency: org.currency,
          timezone: org.timezone,
        }
      : null;

  // Negative results are cached too, so an unknown host cannot be used to
  // hammer the database.
  await redis.setex(
    cacheKey(host),
    CACHE_TTL_SECONDS,
    resolved ? JSON.stringify(resolved) : 'MISS'
  );

  return resolved;
}

export async function resolveTenant(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const host = requestedHost(req);

  // The bare platform domain and the admin console have no tenant. Requests
  // there are handled by the platform routes, which require is_platform_admin.
  if (!host || host === config.rootDomain || host === `admin.${config.rootDomain}`) {
    return next();
  }

  try {
    const tenant = await lookupTenant(host);
    if (tenant) {
      req.tenant = tenant;
      logger.debug({ host, organizationId: tenant.organizationId }, 'tenant resolved');
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Guard for tenant-scoped routes.
 *
 * An unknown host returns 404, never 403. A 403 would confirm the subdomain
 * exists, which leaks the customer list to anyone who can guess names.
 */
export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenant) {
    res.status(404).json({ error: { code: 'TENANT_NOT_FOUND', message: 'Not found' } });
    return;
  }

  if (req.tenant.status === 'SUSPENDED') {
    res.status(402).json({
      error: {
        code: 'SUBSCRIPTION_SUSPENDED',
        message: 'This account is suspended. Contact your administrator to restore access.',
      },
    });
    return;
  }

  next();
}

/** Called after any change to organizations/organization_domains. */
export async function invalidateTenantCache(host: string): Promise<void> {
  await redis.del(cacheKey(host));
}
