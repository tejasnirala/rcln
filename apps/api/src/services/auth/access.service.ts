import { withTenant, withUserIdentity, type TenantContext } from '@rcln/db';
import {
  effectivePermissions,
  can,
  type AccessContext,
  type PermissionCode,
  type PermissionOverride,
  type RoleAssignment,
} from '@rcln/permissions';
import {
  toTimeFormat,
  type ClinicModule,
  type ClinicProfileSummary,
  type TimeFormat,
} from '@rcln/contracts';
import { resolveSettingForBranches } from '../settings/resolver.service.js';
import {
  EMPTY_CLINIC_PROFILE,
  resolveClinicProfiles,
} from '../organization/clinic-profile.service.js';
import { redis } from '../../utils/redis.js';
import { logger } from '../../utils/logger.js';

/**
 * Turns "who is this user, in this organization" into the two things the rest
 * of the request needs: the branches they may touch, and what they may do.
 *
 * THE BOOTSTRAP PROBLEM
 *   `membership_roles` carries a RESTRICTIVE branch_isolation policy:
 *       branch_id IS NULL OR branch_id = ANY (app_branch_scope())
 *   But app.branch_scope is derived FROM membership_roles. Reading the table
 *   with an empty scope returns only the org-wide (branch_id IS NULL) rows, so
 *   a branch-scoped receptionist would resolve to no branches and no
 *   permissions — a silent, total lockout that typechecks perfectly.
 *
 *   The way out is two reads, not a policy exception:
 *     1. `branches` is org-scoped only — it has no branch_isolation policy — so
 *        an empty scope still lists every branch in the organization.
 *     2. Read membership_roles with the scope set to all of them, filtered to
 *        this user's own membership.
 *   Isolation is not weakened: both reads are inside withTenant and the second
 *   is restricted to one membership id. The user learns nothing about anyone
 *   else, and nothing about any other tenant.
 *
 * CACHING
 *   Redis, 60 seconds, ids and permission codes only. No names, no email, no
 *   phone — CLAUDE.md forbids caching PHI, and a role assignment keyed by user
 *   id is close enough to that line to stay on the safe side of it. The TTL is
 *   short because it is the window in which a revoked role still works.
 */

export interface UserAccess {
  membershipId: string;
  organizationId: string;
  /** Every branch this user may act in. Org-wide assignments expand to all. */
  branchIds: string[];
  roleAssignments: RoleAssignment[];
  overrides: PermissionOverride[];
}

const CACHE_TTL_SECONDS = 60;
const cacheKey = (userId: string, organizationId: string): string =>
  `access:${userId}:${organizationId}`;

/** Dates do not survive JSON, so validity windows are revived on read. */
interface CachedAccess extends Omit<UserAccess, 'roleAssignments'> {
  roleAssignments: (Omit<RoleAssignment, 'validFrom' | 'validTo'> & {
    validFrom: string | null;
    validTo: string | null;
  })[];
}

function revive(cached: CachedAccess): UserAccess {
  return {
    ...cached,
    roleAssignments: cached.roleAssignments.map((a) => ({
      ...a,
      validFrom: a.validFrom ? new Date(a.validFrom) : null,
      validTo: a.validTo ? new Date(a.validTo) : null,
    })),
  };
}

async function load(userId: string, organizationId: string): Promise<UserAccess | null> {
  // Step 1: membership + every branch in the org, with an empty branch scope.
  const bootstrapCtx: TenantContext = { organizationId, branchIds: [], userId };

  const bootstrap = await withTenant(bootstrapCtx, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { userId, organizationId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!membership) return null;

    const branches = await tx.branch.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });

    return { membershipId: membership.id, allBranchIds: branches.map((b) => b.id) };
  });

  if (!bootstrap) return null;

  // Step 2: the user's own assignments, now that the scope can see them.
  const scopedCtx: TenantContext = {
    organizationId,
    branchIds: bootstrap.allBranchIds,
    userId,
  };

  const { assignments, overrides } = await withTenant(scopedCtx, async (tx) => {
    const rows = await tx.membershipRole.findMany({
      where: { membershipId: bootstrap.membershipId },
      select: {
        roleId: true,
        branchId: true,
        validFrom: true,
        validTo: true,
        role: {
          select: {
            code: true,
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });

    const overrideRows = await tx.membershipPermissionOverride.findMany({
      where: { membershipId: bootstrap.membershipId },
      // The override stores a permission id; the resolver works in codes.
      select: { branchId: true, effect: true, permission: { select: { code: true } } },
    });

    return { assignments: rows, overrides: overrideRows };
  });

  const roleAssignments: RoleAssignment[] = assignments.map((a) => ({
    roleId: a.roleId,
    roleCode: a.role.code,
    branchId: a.branchId,
    permissions: a.role.permissions.map((p) => p.permission.code as PermissionCode),
    validFrom: a.validFrom,
    validTo: a.validTo,
  }));

  // An org-wide assignment (branchId null) means every branch. Otherwise the
  // user's reach is exactly the branches named on their assignments.
  const hasOrgWide = roleAssignments.some((a) => a.branchId === null);
  const branchIds = hasOrgWide
    ? bootstrap.allBranchIds
    : [
        ...new Set(
          roleAssignments.map((a) => a.branchId).filter((id): id is string => id !== null)
        ),
      ];

  return {
    membershipId: bootstrap.membershipId,
    organizationId,
    branchIds,
    roleAssignments,
    overrides: overrides.map((o) => ({
      permission: o.permission.code as PermissionCode,
      branchId: o.branchId,
      effect: o.effect,
    })),
  };
}

export async function loadUserAccess(
  userId: string,
  organizationId: string
): Promise<UserAccess | null> {
  const key = cacheKey(userId, organizationId);

  const cached = await redis.get(key);
  if (cached) {
    return cached === 'NONE' ? null : revive(JSON.parse(cached) as CachedAccess);
  }

  const access = await load(userId, organizationId);

  // Negative results are cached too: a user probing a tenant they are not a
  // member of must not get a free database query on every attempt.
  await redis.setex(key, CACHE_TTL_SECONDS, access ? JSON.stringify(access) : 'NONE');

  return access;
}

/** Call after any write to membership_roles or membership_permission_overrides. */
export async function invalidateUserAccess(userId: string, organizationId: string): Promise<void> {
  await redis.del(cacheKey(userId, organizationId));
}

/**
 * Drop every cached access record for an organization.
 *
 * Needed because `branchIds` is derived, not stored: an org-wide assignment
 * (branch_id NULL) expands to "every branch in the organization", so adding or
 * retiring a branch silently changes the effective scope of every org-wide
 * member — without touching a single membership_roles row.
 *
 * Without this, creating a branch and then trying to configure it answers 404
 * for up to the 60-second TTL. There is no error and nothing in the logs; the
 * branch simply is not there yet, which reads as data loss rather than caching.
 *
 * SCAN rather than KEYS: KEYS walks the entire keyspace in one blocking call,
 * and this shares a Redis with the rate limiters. Branch changes are rare enough
 * that the extra round-trips do not matter.
 */
export async function invalidateOrganizationAccess(organizationId: string): Promise<void> {
  const pattern = cacheKey('*', organizationId);
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/**
 * Every active branch in an organization, for a caller who has no membership to
 * derive a scope from.
 *
 * ONE CALLER, AND IT IS NOT A SHORTCUT AROUND `loadUserAccess`
 *   A platform admin impersonating a clinic (ADR-0012) holds no membership
 *   there, so `loadUserAccess` returns null and `branchScope` comes out empty.
 *   An empty scope is not "no restriction" — `branch_isolation` is RESTRICTIVE,
 *   so every branch-scoped read returns nothing and every branch-scoped write
 *   silently matches nothing. Full access would present as an empty clinic.
 *
 *   Safe for the same reason step 1 of `load()` is: `branches` carries the
 *   org-scoped policy only, so an empty scope still lists the organization's own
 *   branches and nobody else's. Not cached — impersonation is rare and short,
 *   and a stale branch list here is a stale authorisation scope.
 */
export async function organizationBranchIds(
  organizationId: string,
  userId: string
): Promise<string[]> {
  const branches = await withTenant({ organizationId, branchIds: [], userId }, async (tx) =>
    tx.branch.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: { id: true },
    })
  );

  return branches.map((b) => b.id);
}

export function toAccessContext(
  access: UserAccess,
  userId: string,
  branchId: string | null,
  isPlatformAdmin: boolean
): AccessContext {
  return {
    userId,
    organizationId: access.organizationId,
    branchId,
    isPlatformAdmin,
    roleAssignments: access.roleAssignments,
    overrides: access.overrides,
  };
}

export function permissionsFor(
  access: UserAccess,
  userId: string,
  branchId: string | null,
  isPlatformAdmin: boolean
): string[] {
  return effectivePermissions(toAccessContext(access, userId, branchId, isPlatformAdmin));
}

export function hasPermission(
  access: UserAccess,
  userId: string,
  branchId: string | null,
  isPlatformAdmin: boolean,
  permission: PermissionCode
): boolean {
  return can(toAccessContext(access, userId, branchId, isPlatformAdmin), permission);
}

/**
 * Every organization the user belongs to, for the account switcher and for the
 * `memberships` array of `authSession`.
 *
 * `memberships` is RLS-enforced and org-scoped, so "all orgs for this user" is
 * not a query any single tenant context can answer — and the UNSCOPED client
 * cannot answer it either: with no app.current_org the policy fails closed and
 * returns zero rows, silently. An empty array, no error.
 *
 * `withUserIdentity` is the narrow hole cut for exactly this: it sets only
 * app.current_user, which enables the `own_membership` policy (your own rows,
 * and only while no tenant is claimed). Per-organization detail then goes back
 * through withTenant like everything else.
 */
export interface MembershipSummaryRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  /** The clinic's country. Drives address, ID and phone formats on every form. */
  countryCode: string;
  roles: string[];
  branches: {
    id: string;
    name: string;
    code: string;
    city: string | null;
    isPrimary: boolean;
    /** For the screens that render a clock. See the contract for why it is here. */
    timezone: string;
    /** The clock FACE, `12H` or `24H`. The other half of the same question. */
    timeFormat: TimeFormat;
    /**
     * What this branch said it is, resolved branch-over-organization (CO-1).
     * Here for the reason `timezone` and `timeFormat` are: the patient form and
     * the shell need it, and neither may require a settings permission.
     */
    profile: ClinicProfileSummary;
  }[];
  /** Whether the onboarding wizard has been finished. NOT `registeredAt`. */
  setupComplete: boolean;
  /** The ORGANIZATION-level module answer, for the branch-less screens. */
  modules: ClinicModule[];
}

export async function listMemberships(userId: string): Promise<MembershipSummaryRow[]> {
  const rows = await withUserIdentity(userId, async (tx) =>
    tx.membership.findMany({
      where: { userId, status: 'ACTIVE', deletedAt: null },
      select: {
        organization: {
          select: {
            id: true,
            displayName: true,
            slug: true,
            countryCode: true,
            deletedAt: true,
          },
        },
      },
    })
  );

  const summaries: MembershipSummaryRow[] = [];

  for (const row of rows) {
    const org = row.organization;
    if (org.deletedAt) continue;

    const access = await loadUserAccess(userId, org.id);
    if (!access) continue;

    const branches = await withTenant(
      { organizationId: org.id, branchIds: access.branchIds, userId },
      async (tx) => {
        const rows = await tx.branch.findMany({
          where: { id: { in: access.branchIds }, status: 'ACTIVE', deletedAt: null },
          select: {
            id: true,
            name: true,
            code: true,
            city: true,
            isPrimary: true,
            timezone: true,
          },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        });

        /*
         * ⚠️ ONE QUERY FOR EVERY BRANCH, NOT ONE PER BRANCH. This runs on every
         *   render of every page — `getSession` is memoised per request, but a
         *   request is one page — so an N+1 here is an N+1 on the hottest path
         *   in the product. `resolveSettingForBranches` exists for that.
         *
         * ⚠️ THE IDS COME FROM `rows`, WHICH WAS READ UNDER RLS. `setting_values`
         *   is RLS-EXEMPT: it is keyed by (scope_type, scope_id) with no
         *   organization_id, so a branch id from anywhere else would read another
         *   clinic's configuration and nothing in Postgres would object. See the
         *   header of resolver.service.ts.
         */
        const formats = await resolveSettingForBranches(tx, 'locale.time_format', {
          organizationId: org.id,
          branchIds: rows.map((b) => b.id),
        });

        /*
         * ⚠️ IN THE SAME TRANSACTION AND WITH THE SAME BATCHING ARGUMENT as the
         *   formats above, and DELIBERATELY OUTSIDE the 60-second
         *   `loadUserAccess` cache. Caching it would mean every onboarding write
         *   had to invalidate that cache, and a clinic that just finished setup
         *   would watch the old nav for a minute. See the header of
         *   clinic-profile.service.ts.
         */
        const profiles = await resolveClinicProfiles(tx, {
          organizationId: org.id,
          branchIds: rows.map((b) => b.id),
        });

        return {
          branches: rows.map((b) => ({
            ...b,
            timeFormat: toTimeFormat(formats.get(b.id)),
            profile: profiles.byBranch.get(b.id) ?? EMPTY_CLINIC_PROFILE,
          })),
          profiles,
        };
      }
    );

    summaries.push({
      organizationId: org.id,
      organizationName: org.displayName,
      organizationSlug: org.slug,
      countryCode: org.countryCode,
      roles: [...new Set(access.roleAssignments.map((a) => a.roleCode))].sort(),
      branches: branches.branches,
      setupComplete: branches.profiles.completedAt !== null,
      modules: branches.profiles.organization.modules,
    });
  }

  if (summaries.length === 0) {
    logger.debug({ userId }, 'user has no active memberships');
  }

  return summaries;
}
