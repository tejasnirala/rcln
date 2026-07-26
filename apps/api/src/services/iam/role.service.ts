/**
 * Roles: the named bundles of permissions a clinic hands out.
 *
 * SYSTEM ROLES ARE READ-ONLY, AND THAT IS THE WHOLE EDITING MODEL
 *   The twelve roles in `packages/permissions/src/roles.ts` are seeded once with
 *   `organization_id = NULL` and shared by every tenant on the platform. Editing
 *   one would change what a Doctor is for every clinic in the database, so they
 *   are listed here, assignable, cloneable — and never mutated. A tenant that
 *   wants "Doctor, but without prescription signing" creates an org-scoped role
 *   of its own. There is no clone endpoint: the list already carries every
 *   system role's permission codes, so cloning is the create form arriving
 *   prefilled, and a second write path for the same row would be worse.
 *
 *   `reject_shadowed_system_role` (migration 20260725060000) refuses a tenant
 *   role whose code shadows a system one, because two roles with one code make
 *   the effective-permission lookup ambiguous. It is checked here as well, for a
 *   message that names the clash rather than a bare 409.
 *
 * NONE OF THESE TABLES IS RLS-PROTECTED
 *   `roles`, `permissions` and `role_permissions` are all on the EXEMPT list in
 *   `packages/db/scripts/check-rls.ts`, for a good reason — a system role has no
 *   organization_id to filter on. The consequence is that every read and write
 *   below states its own tenant filter, and a missing one produces no error and
 *   no failing single-tenant test. It hands another clinic's role to this one.
 *
 * WHAT DOES CARRY A POLICY IS `membership_roles`
 *   Which is why `memberCount` below is trustworthy only when the caller can see
 *   every branch — branch_isolation hides assignments in branches outside their
 *   scope. Editing and deleting a role therefore require whole-clinic reach; see
 *   `assertWholeClinic`.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateRoleRequest,
  RoleDetail,
  RoleListResponse,
  UpdateRoleRequest,
} from '@rcln/contracts';
import { AuthorizationError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { invalidateOrganizationAccess } from '../auth/access.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { assertGrantable, coversEveryBranch, grantableCodes, type Caller } from './guards.js';

/** Request metadata carried onto the audit row. Same shape as the branch service. */
export interface RoleActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * A tenant role may never carry a platform permission.
 *
 * `assertGrantable` would refuse one anyway — no member of a clinic holds
 * `platform.*` — but leaving them out of the catalogue means the editor never
 * offers a checkbox that is going to be rejected.
 */
const TENANT_MODULE_FILTER = { module: { not: 'platform' } } as const;

/** What Prisma is asked for, so the list and the write paths cannot drift. */
const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  scopeLevel: true,
  isSystem: true,
  organizationId: true,
  permissions: { select: { permission: { select: { code: true } } } },
} as const;

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  scopeLevel: 'PLATFORM' | 'ORGANIZATION' | 'BRANCH';
  isSystem: boolean;
  organizationId: string | null;
  permissions: { permission: { code: string } }[];
}

/**
 * How many PEOPLE hold a role, which is not how many assignment rows name it.
 *
 * A doctor working at two branches has two `membership_roles` rows for DOCTOR —
 * that is the whole point of the branch column — so `_count: { assignments }`
 * reports "held by 2 people" for one person. Found by curling the demo clinic;
 * it typechecked perfectly and every test still passed, because none of them had
 * a member assigned the same role at two branches.
 *
 * `distinct` over (roleId, membershipId) is what makes the number the one the
 * screen claims it is, and the one `deleteRole` refuses on.
 */
async function holderCounts(tx: TxClient, roleIds: string[]): Promise<Map<string, number>> {
  const rows = await tx.membershipRole.findMany({
    where: { roleId: { in: roleIds } },
    select: { roleId: true, membershipId: true },
    distinct: ['roleId', 'membershipId'],
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
  return counts;
}

function toDetail(row: RoleRow, memberCount: number): RoleDetail {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    // PLATFORM-scoped roles are filtered out of every query below, so the cast
    // narrows a type the queries have already narrowed.
    scopeLevel: row.scopeLevel as 'ORGANIZATION' | 'BRANCH',
    isSystem: row.isSystem,
    permissionCodes: row.permissions.map((p) => p.permission.code).sort(),
    memberCount,
  };
}

/**
 * The audit snapshot: codes and flags, never a member's name.
 *
 * A role change is recorded as what the role now grants. Who holds it is a
 * `membership_roles` fact and is audited there.
 */
function snapshot(row: RoleRow): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    scopeLevel: row.scopeLevel,
    permissionCodes: row.permissions.map((p) => p.permission.code).sort(),
  };
}

/**
 * Visible to this tenant: its own roles, plus the shared system ones.
 *
 * PLATFORM scope is excluded by name. SUPER_ADMIN is an ordinary row in this
 * table as far as SQL is concerned, and a clinic that could assign it would own
 * the platform. Same filter as `listInvitations`, for the same reason.
 */
export function visibleRoleWhere(ctx: TenantContext): Prisma.RoleWhereInput {
  return {
    scopeLevel: { in: ['ORGANIZATION', 'BRANCH'] },
    OR: [{ organizationId: ctx.organizationId }, { organizationId: null, isSystem: true }],
  };
}

/**
 * Editing or retiring a role reaches members in branches this caller may not be
 * able to see, so it takes whole-clinic reach.
 *
 * Without this, a branch-scoped holder of `iam.role.manage` sees `memberCount:
 * 0` for a role held only in another branch — branch_isolation hid those rows —
 * and deleting it cascades away assignments they were never allowed to know
 * about.
 */
async function assertWholeClinic(tx: TxClient, ctx: TenantContext, caller: Caller): Promise<void> {
  if (await coversEveryBranch(tx, ctx, caller)) return;
  throw new AuthorizationError(
    'Changing a role affects every branch, so it can only be done by someone who manages all of them.'
  );
}

/** Map permission codes to ids, refusing anything not in the catalogue. */
async function resolvePermissionIds(tx: TxClient, codes: string[]): Promise<string[]> {
  const unique = [...new Set(codes)];

  const rows = await tx.permission.findMany({
    where: { code: { in: unique }, ...TENANT_MODULE_FILTER },
    select: { id: true, code: true },
  });

  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.code));
    const unknown = unique.filter((code) => !found.has(code)).sort();
    throw new ConflictError(`No such permission: ${unknown.join(', ')}.`);
  }

  return rows.map((r) => r.id);
}

/**
 * `roles` is RLS-exempt, so this is the tenant boundary for a single role.
 * A system role is returned — it is readable — and refused by the caller.
 */
async function findRole(tx: TxClient, ctx: TenantContext, roleId: string): Promise<RoleRow> {
  const row = await tx.role.findFirst({
    where: { id: roleId, ...visibleRoleWhere(ctx) },
    select: ROLE_SELECT,
  });
  if (!row) throw new NotFoundError('Role');
  return row as RoleRow;
}

export async function listRoles(ctx: TenantContext, caller: Caller): Promise<RoleListResponse> {
  const grantable = await grantableCodes(ctx, caller);

  return withTenant(ctx, async (tx) => {
    const roles = await tx.role.findMany({
      where: visibleRoleWhere(ctx),
      select: ROLE_SELECT,
      // Custom roles first: they are the ones this clinic actually maintains.
      orderBy: [{ isSystem: 'asc' }, { name: 'asc' }],
    });

    const permissions = await tx.permission.findMany({
      where: TENANT_MODULE_FILTER,
      select: { code: true, module: true, action: true, description: true },
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });

    const holders = await holderCounts(
      tx,
      roles.map((role) => role.id)
    );

    return {
      roles: (roles as RoleRow[]).map((role) => toDetail(role, holders.get(role.id) ?? 0)),
      permissions,
      // null means unrestricted (a platform admin), which on the wire is "every
      // code in the catalogue" — the UI has no third state to render.
      grantableCodes: grantable ?? permissions.map((p) => p.code),
    };
  });
}

export async function createRole(
  ctx: TenantContext,
  caller: Caller,
  input: CreateRoleRequest,
  options: RoleActionOptions = {}
): Promise<RoleDetail> {
  /**
   * Resolved before the transaction opens: `loadUserAccess` runs its own
   * `withTenant`, and nesting that inside this one would hold a pooled
   * connection open waiting for a connection.
   */
  const grantable = await grantableCodes(ctx, caller);

  const created = await withTenant(ctx, async (tx) => {
    /**
     * Checked here for the message, enforced by the database regardless.
     *
     * The trigger raises `unique_violation`, which reaches the caller as a bare
     * 409 naming no field. Saying which code is reserved is the difference
     * between an administrator renaming their role and one filing a bug.
     */
    const shadowed = await tx.role.findFirst({
      where: { organizationId: null, isSystem: true, code: input.code },
      select: { name: true },
    });
    if (shadowed) {
      throw new ConflictError(
        `${input.code} is reserved by the built-in ${shadowed.name} role. Choose another code.`
      );
    }

    const clash = await tx.role.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code },
      select: { id: true },
    });
    if (clash) throw new ConflictError(`A role with code ${input.code} already exists.`);

    // Catalogue first, authority second: a typo is a typo, and telling someone
    // they may not grant `patient.teleport` is a worse answer than saying no
    // such permission exists.
    const permissionIds = await resolvePermissionIds(tx, input.permissionCodes);
    assertGrantable(grantable, input.permissionCodes);

    const role = (await tx.role
      .create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          // exactOptionalPropertyTypes: a conditional spread, never `key: undefined`.
          ...(input.description !== undefined ? { description: input.description } : {}),
          scopeLevel: input.scopeLevel,
          // Always false. `isSystem` is not a field a tenant may set — a system
          // role is one this codebase seeds, and nothing else.
          isSystem: false,
          permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
        },
        select: ROLE_SELECT,
      })
      .catch(rethrowRoleConflict)) as RoleRow;

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'role',
      entityId: role.id,
      after: snapshot(role),
      ...options,
    });

    return role;
  });

  // Brand new, so nobody holds it yet.
  return toDetail(created, 0);
}

export async function updateRole(
  ctx: TenantContext,
  caller: Caller,
  roleId: string,
  input: UpdateRoleRequest,
  options: RoleActionOptions = {}
): Promise<RoleDetail> {
  // Outside the transaction; see createRole.
  const grantable = await grantableCodes(ctx, caller);

  const updated = await withTenant(ctx, async (tx) => {
    const before = await findRole(tx, ctx, roleId);

    if (before.isSystem) {
      throw new ConflictError(
        `${before.name} is a built-in role and cannot be edited. Duplicate it and edit the copy.`
      );
    }

    await assertWholeClinic(tx, ctx, caller);

    if (input.permissionCodes) {
      const permissionIds = await resolvePermissionIds(tx, input.permissionCodes);
      /**
       * The submitted set is checked in full, not just the additions.
       *
       * Keeping a permission the caller does not hold is still granting it —
       * the request says "this role should carry these codes". An org admin
       * editing a role that carries `patient.delete` has to drop it, which is
       * the right answer: they were never allowed to hand that out.
       */
      assertGrantable(grantable, input.permissionCodes);

      // Replaced as a set, like operating hours: an omitted code is a permission
      // the role no longer grants.
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      });
    }

    const after = (await tx.role.update({
      where: { id: roleId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      select: ROLE_SELECT,
    })) as RoleRow;

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'role',
      entityId: roleId,
      before: snapshot(before),
      after: snapshot(after),
      ...options,
    });

    return { role: after, holders: (await holderCounts(tx, [roleId])).get(roleId) ?? 0 };
  });

  /**
   * Mandatory. `loadUserAccess` caches each member's resolved permission codes
   * for 60 seconds, so without this the people holding this role keep the
   * permissions it used to grant — and the UI, which reads the same cache, keeps
   * showing them. Organization-wide because the blast radius is every holder.
   */
  await invalidateOrganizationAccess(ctx.organizationId);

  return toDetail(updated.role, updated.holders);
}

export async function deleteRole(
  ctx: TenantContext,
  caller: Caller,
  roleId: string,
  options: RoleActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await findRole(tx, ctx, roleId);

    if (before.isSystem) {
      throw new ConflictError(`${before.name} is a built-in role and cannot be removed.`);
    }

    await assertWholeClinic(tx, ctx, caller);

    /**
     * A role in use is not deleted, because the FK cascades.
     *
     * `membership_roles.role_id` is `onDelete: Cascade`, so removing a role
     * silently strips it from everyone holding it — no error, no trace beyond
     * this audit row, and a receptionist who can no longer book appointments.
     * The count is complete because assertWholeClinic just established that this
     * caller can see every branch.
     */
    const holders = (await holderCounts(tx, [roleId])).get(roleId) ?? 0;
    if (holders > 0) {
      throw new ConflictError(
        `${before.name} is held by ${String(holders)} ${
          holders === 1 ? 'person' : 'people'
        }. Move them to another role first.`
      );
    }

    await tx.role.delete({ where: { id: roleId } });

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'role',
      entityId: roleId,
      before: snapshot(before),
      ...options,
    });
  });

  // Nobody held it, so nothing resolved through it — but the role list is part
  // of what the cache feeds, and this is cheap enough not to reason about.
  await invalidateOrganizationAccess(ctx.organizationId);
}

/**
 * Backstop for the two unique constraints on `roles`: `@@unique([organizationId,
 * code])` and the `reject_shadowed_system_role` trigger, which raises with
 * ERRCODE `unique_violation` and therefore arrives as P2002 like any other.
 *
 * Both are pre-checked above for a message that names the clash. This catches
 * the race between the check and the insert, where a bare 500 would be wrong.
 */
function rethrowRoleConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    throw new ConflictError('That role code is already in use.');
  }
  throw error;
}
