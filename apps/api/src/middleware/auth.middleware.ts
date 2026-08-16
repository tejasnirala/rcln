import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { TenantContext } from '@rcln/db';
import type { PermissionCode } from '@rcln/permissions';
import { verifyAccessToken } from '../services/auth/token.service.js';
import { findLiveSession } from '../services/auth/session.service.js';
import {
  hasPermission,
  loadUserAccess,
  organizationBranchIds,
} from '../services/auth/access.service.js';
import { AuthenticationError, AuthorizationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Steps 4 and 5 of the request lifecycle: who is calling, and may they.
 *
 * The order is fixed and is the security model (see the header of app.ts):
 *
 *   resolveTenant  ->  requireTenant  ->  authenticate  ->  authorize  ->  handler
 *
 * `resolveTenant` runs first because which tenant you are talking to is a
 * property of the URL, not of the caller. `authenticate` therefore already
 * knows the tenant, which is what lets it reject a token minted for a different
 * organization before any handler runs.
 */

/** `Authorization: Bearer <token>` -> the token, or null. */
function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}

/**
 * Verify the access token and populate `req.auth`.
 *
 * A missing token is NOT an error here — this runs on routes that are readable
 * both signed in and out. Use `requireAuth` to demand a caller.
 *
 * A token that is present but bad IS an error: silently continuing as anonymous
 * would turn an expired session into a confusing 403 further down instead of
 * the 401 that tells the client to refresh.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const claims = verifyAccessToken(token);

    // The JWT is stateless, so it stays valid until it expires even after a
    // logout. The session row is the revocation list, and checking it is what
    // makes "sign out everywhere" mean anything.
    const session = await findLiveSession(claims.sessionId);
    if (!session || session.userId !== claims.userId) {
      throw new AuthenticationError('Session expired. Please sign in again.');
    }

    /**
     * Cross-tenant guard.
     *
     * A valid token for organization A, replayed against B's subdomain, is the
     * single highest-value attack on a shared-database multi-tenant system.
     *
     * 404, not 403 — the same reasoning as requireTenant. A 403 would confirm
     * that the tenant exists, and the caller already holds a valid token, so
     * they would be able to walk the customer list one subdomain at a time.
     */
    if (
      req.tenant &&
      claims.organizationId &&
      claims.organizationId !== req.tenant.organizationId
    ) {
      logger.warn(
        {
          userId: claims.userId,
          tokenOrganizationId: claims.organizationId,
          hostOrganizationId: req.tenant.organizationId,
        },
        'cross-tenant token rejected'
      );
      _res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    // Branch scope is resolved per request rather than carried in the token, so
    // a role revoked mid-session stops working within the cache TTL instead of
    // at token expiry.
    let branchScope: string[] = [];
    if (claims.organizationId) {
      const access = await loadUserAccess(claims.userId, claims.organizationId);
      if (!access && !claims.isPlatformAdmin) {
        throw new AuthenticationError('Your access to this organization has been removed.');
      }

      /**
       * An impersonating platform admin has no membership here — that is what
       * makes it impersonation — so there is nothing for `loadUserAccess` to
       * derive a branch scope from, and an empty scope is not "unrestricted".
       * `branch_isolation` is RESTRICTIVE: every branch-scoped read would return
       * nothing and every branch-scoped write would silently match nothing, so
       * full access (ADR-0012) would present as an empty clinic.
       *
       * The scope is therefore the organization's own branches, resolved fresh.
       * Note the condition: a platform admin who is NOT impersonating and has no
       * membership keeps the empty scope, because they have not asked to be
       * inside this clinic and nothing has been audited to say they are.
       */
      branchScope = access?.branchIds ?? [];
      if (!access && claims.isPlatformAdmin && claims.impersonatedByUserId) {
        branchScope = await organizationBranchIds(claims.organizationId, claims.userId);
      }
    }

    req.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      isPlatformAdmin: claims.isPlatformAdmin,
      membershipId: claims.membershipId,
      organizationId: claims.organizationId,
      branchId: claims.branchId,
      branchScope,
      impersonatedByUserId: claims.impersonatedByUserId,
      sessionExpiresAt: session.expiresAt,
      sessionStartedAt: session.createdAt,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** 401 unless `authenticate` produced a caller. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(new AuthenticationError('Authentication required'));
    return;
  }
  next();
}

/**
 * Require every one of `permissions` for the caller's active branch.
 *
 * Platform admins bypass, which is the whole point of the flag — and every
 * bypass is logged, because an unaudited god mode is indistinguishable from a
 * compromised account after the fact.
 */
export function authorize(...permissions: PermissionCode[]): RequestHandler {
  const handler: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const auth = req.auth;
      if (!auth) {
        next(new AuthenticationError('Authentication required'));
        return;
      }

      if (auth.isPlatformAdmin) {
        logger.info(
          { userId: auth.userId, permissions, organizationId: auth.organizationId },
          'platform admin bypassed permission check'
        );
        next();
        return;
      }

      if (!auth.organizationId) {
        next(new AuthorizationError('No active organization'));
        return;
      }

      try {
        const access = await loadUserAccess(auth.userId, auth.organizationId);
        if (!access) {
          next(new AuthorizationError('Access denied'));
          return;
        }

        const granted = permissions.every((permission) =>
          hasPermission(access, auth.userId, auth.branchId, auth.isPlatformAdmin, permission)
        );

        if (!granted) {
          // Log which permission was missing; the caller is told only "denied",
          // because naming it maps out the permission model for an attacker.
          logger.info(
            { userId: auth.userId, required: permissions, branchId: auth.branchId },
            'permission denied'
          );
          next(new AuthorizationError('Access denied'));
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };

  /*
   * ⚠️ THE GATE, LEGIBLE FROM OUTSIDE THE CLOSURE (CE-8). An Express router
   *   stack is a list of anonymous functions, so "is this route gated, and by
   *   what" is a question nothing could ask — and an ungated route looks exactly
   *   like a gated one in a diff, in a review and at runtime until somebody
   *   walks through the hole. Stamping the codes onto the handler is what lets
   *   `tests/unit/route-gates.test.ts` audit every clinical route at once.
   *
   *   Non-enumerable so it stays out of logs and out of anything that
   *   serialises a middleware stack.
   */
  Object.defineProperty(handler, 'requiredPermissions', {
    value: Object.freeze([...permissions]),
    enumerable: false,
  });

  return handler;
}

/** The permission codes an `authorize(...)` handler was built with, if it is one. */
export function requiredPermissionsOf(handler: unknown): readonly PermissionCode[] | null {
  if (typeof handler !== 'function') return null;
  const codes = (handler as { requiredPermissions?: unknown }).requiredPermissions;
  return Array.isArray(codes) ? (codes as PermissionCode[]) : null;
}

/** The `/platform` console. Membership is irrelevant; the flag is everything. */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(new AuthenticationError('Authentication required'));
    return;
  }

  if (!req.auth.isPlatformAdmin) {
    // 404, not 403: the admin console should not confirm it exists to a caller
    // who is not allowed into it.
    _res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }

  next();
}

/**
 * The bridge from an authenticated request into `withTenant`.
 *
 * Throws rather than returning null: a handler that reaches for a tenant
 * context without one is a routing mistake, and it must fail loudly here rather
 * than run an unscoped query.
 */
/**
 * The two facts about a caller that a `TenantContext` deliberately does not
 * carry, for the services that have to reason about the caller's own authority
 * rather than the tenant's.
 *
 * `branchId` is the branch `authorize()` resolved this request's permissions
 * against, so a service asking "may they grant this?" and the middleware asking
 * "may they be here?" cannot answer from different scopes.
 *
 * IAM only. Nothing else should need it: the tenant context is the boundary for
 * ordinary work, and widening it would invite callers to reason about the
 * platform-admin flag where RLS should be doing the reasoning.
 */
export interface CallerIdentity {
  isPlatformAdmin: boolean;
  branchId: string | null;
}

export function callerFrom(req: Request): CallerIdentity {
  const auth = req.auth;
  if (!auth) throw new AuthenticationError('Authentication required');

  return { isPlatformAdmin: auth.isPlatformAdmin, branchId: auth.branchId };
}

/**
 * Does the caller hold `permission`, as a question rather than as a gate?
 *
 * `authorize()` answers the same question by ending the request. Some endpoints
 * need the answer to NARROW what they return instead of refusing it: the day
 * board is readable by a doctor and by the front desk, and the difference
 * between them is whose bookings come back, not whether any do. Returning 403 to
 * the doctor would be wrong, and returning the whole branch's diary would be a
 * disclosure.
 *
 * ⚠️ NEVER THE ONLY CHECK ON A ROUTE. This is a second, refining question asked
 *   after `authorize()` has already established the caller may be here at all.
 *   A handler whose sole protection is an `if` around this helper is one early
 *   `return` away from being unprotected, which is the whole reason permission
 *   gates are middleware.
 *
 * Platform admins answer true, consistent with `authorize()` — with no log line,
 * because this runs on ordinary reads and would drown the bypass records that
 * matter.
 */
export async function callerHasPermission(
  req: Request,
  permission: PermissionCode
): Promise<boolean> {
  const auth = req.auth;
  if (!auth) throw new AuthenticationError('Authentication required');
  if (auth.isPlatformAdmin) return true;
  if (!auth.organizationId) return false;

  // Redis-cached with a short TTL, and `authorize()` has already warmed it for
  // this user and org on the way in, so this is a cache hit rather than a query.
  const access = await loadUserAccess(auth.userId, auth.organizationId);
  if (!access) return false;

  return hasPermission(access, auth.userId, auth.branchId, auth.isPlatformAdmin, permission);
}

export function tenantContextFrom(req: Request): TenantContext {
  const auth = req.auth;
  if (!auth?.organizationId) {
    throw new AuthenticationError('Authentication required');
  }

  return {
    organizationId: auth.organizationId,
    branchIds: auth.branchScope,
    userId: auth.userId,
    impersonatedByUserId: auth.impersonatedByUserId ?? undefined,
  };
}
