import { ALL_PERMISSIONS, type PermissionCode } from './codes.js';

/**
 * Effective-permission resolution.
 *
 * Order (first match wins):
 *   1. DENY  override        -> denied     (an explicit DENY always beats a grant)
 *   2. GRANT override        -> allowed
 *   3. role grants, where the role assignment applies to this branch
 *   4. otherwise             -> denied
 *
 * "Applies to this branch" means the assignment's branchId is either the branch
 * being acted on, or null — null meaning every branch in the organization. That
 * nullable is what lets one admin cover branches A and B while another covers
 * only A, without a separate table.
 */

export type OverrideEffect = 'GRANT' | 'DENY';

export interface RoleAssignment {
  roleId: string;
  roleCode: string;
  /** null = applies to every branch in the organization */
  branchId: string | null;
  permissions: PermissionCode[];
  validFrom?: Date | null;
  validTo?: Date | null;
}

export interface PermissionOverride {
  permission: PermissionCode;
  /** null = applies to every branch in the organization */
  branchId: string | null;
  effect: OverrideEffect;
}

export interface AccessContext {
  userId: string;
  organizationId: string;
  /** The branch the request is acting on. null for org-wide operations. */
  branchId: string | null;
  isPlatformAdmin: boolean;
  roleAssignments: RoleAssignment[];
  overrides: PermissionOverride[];
}

function scopeApplies(assignmentBranchId: string | null, targetBranchId: string | null): boolean {
  // A null assignment branch is org-wide and therefore covers any target.
  if (assignmentBranchId === null) return true;
  // An org-wide operation cannot be satisfied by a single-branch grant.
  if (targetBranchId === null) return false;
  return assignmentBranchId === targetBranchId;
}

function isActive(a: RoleAssignment, now: Date): boolean {
  if (a.validFrom && a.validFrom > now) return false;
  if (a.validTo && a.validTo <= now) return false;
  return true;
}

export function can(ctx: AccessContext, permission: PermissionCode, now = new Date()): boolean {
  // The seeded super admin bypasses membership entirely. Every action taken
  // under this branch must be written to audit_logs by the caller.
  if (ctx.isPlatformAdmin) return true;

  const relevant = ctx.overrides.filter(
    (o) => o.permission === permission && scopeApplies(o.branchId, ctx.branchId)
  );
  if (relevant.some((o) => o.effect === 'DENY')) return false;
  if (relevant.some((o) => o.effect === 'GRANT')) return true;

  return ctx.roleAssignments.some(
    (a) =>
      isActive(a, now) &&
      scopeApplies(a.branchId, ctx.branchId) &&
      a.permissions.includes(permission)
  );
}

export function canAll(
  ctx: AccessContext,
  permissions: PermissionCode[],
  now = new Date()
): boolean {
  return permissions.every((p) => can(ctx, p, now));
}

export function canAny(
  ctx: AccessContext,
  permissions: PermissionCode[],
  now = new Date()
): boolean {
  return permissions.some((p) => can(ctx, p, now));
}

/**
 * Flatten to the set the UI needs for showing/hiding controls.
 * Never put this in a JWT — it goes stale the moment a role changes, and it is
 * far too large for a header. Serve it from an endpoint, cache it in Redis.
 */
export function effectivePermissions(ctx: AccessContext, now = new Date()): PermissionCode[] {
  /*
   * The same bypass `can` applies, for the same reason — and it has to be here
   * too, or the two disagree.
   *
   * `can` is what the API enforces; this is what the UI renders from. A platform
   * admin inside a clinic (ADR-0012) holds no membership there, so the role loop
   * below finds nothing and returns an empty list — a shell with no navigation,
   * in front of someone every endpoint is about to say yes to. The screen would
   * be hiding controls the API would have allowed, which is the worst of both:
   * no security gained, and a console that looks broken.
   */
  if (ctx.isPlatformAdmin) return [...ALL_PERMISSIONS];

  const granted = new Set<PermissionCode>();

  for (const a of ctx.roleAssignments) {
    if (!isActive(a, now) || !scopeApplies(a.branchId, ctx.branchId)) continue;
    for (const p of a.permissions) granted.add(p);
  }

  for (const o of ctx.overrides) {
    if (!scopeApplies(o.branchId, ctx.branchId)) continue;
    if (o.effect === 'GRANT') granted.add(o.permission);
  }

  // DENY is applied last so it always wins.
  for (const o of ctx.overrides) {
    if (!scopeApplies(o.branchId, ctx.branchId)) continue;
    if (o.effect === 'DENY') granted.delete(o.permission);
  }

  return [...granted].sort();
}

/**
 * The branches this user may act in — i.e. what the UI branch switcher lists.
 * A null branchId on any assignment means "all branches", so the caller
 * substitutes the org's full branch list.
 */
export function accessibleBranchIds(
  ctx: Pick<AccessContext, 'roleAssignments' | 'isPlatformAdmin'>,
  allOrgBranchIds: string[],
  now = new Date()
): string[] {
  if (ctx.isPlatformAdmin) return allOrgBranchIds;

  const active = ctx.roleAssignments.filter((a) => isActive(a, now));
  if (active.some((a) => a.branchId === null)) return allOrgBranchIds;

  return [...new Set(active.map((a) => a.branchId).filter((b): b is string => b !== null))];
}
