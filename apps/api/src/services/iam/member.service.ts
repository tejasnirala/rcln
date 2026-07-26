/**
 * Members: who works at this clinic, and what each of them may do.
 *
 * THE PITFALL THIS FILE IS BUILT AROUND
 *   `membership_roles` and `membership_permission_overrides` carry a RESTRICTIVE
 *   `branch_isolation` policy that ANDs with `tenant_isolation`:
 *
 *       branch_id IS NULL OR branch_id = ANY (app_branch_scope())
 *
 *   Two different failure modes come out of that one policy, and neither one is
 *   an answer a caller should ever see:
 *
 *     WITH CHECK — naming a branch outside the scope is refused at INSERT, and
 *       arrives as a 500. Measured: remove `assertBranchAssignable` from
 *       `assignRole` and the matching case in iam.test.ts turns 404 into 500.
 *     USING — a row addressed by its own id in a branch outside the scope is
 *       simply invisible, so an `updateMany` / `deleteMany` matches nothing and
 *       commits. That one is silent, which is why every mutation below reads the
 *       row first and lets the 404 come from the read.
 *
 *   And the case the database does not cover at all: `branch_id NULL` is org-wide
 *   and exempt by design, so a branch-scoped caller omitting the branch grants
 *   access to every branch there will ever be. Nothing refuses it — measured,
 *   201 and a real assignment — which is why `assertBranchAssignable` is called
 *   for the NULL case too. See `guards.ts`.
 *
 *   The same policy makes reads correct for free: a branch admin listing members
 *   sees their assignments in the branches they manage and the org-wide ones,
 *   and nothing else. That is the intended answer, and it is a policy rather
 *   than a `where` clause, so it cannot be forgotten.
 *
 * CACHE INVALIDATION IS PART OF THE WRITE, NOT A COURTESY
 *   `loadUserAccess` caches a member's roles, overrides and derived branch list
 *   in Redis for 60 seconds. Every function here that changes access calls
 *   `invalidateUserAccess(userId, organizationId)` after COMMIT. Without it the
 *   API keeps honouring a role that was just revoked, and the UI — which reads
 *   the same cache through the session endpoint — keeps showing it. There is no
 *   error and nothing in any log.
 *
 * WHAT NEVER REACHES AN AUDIT ROW
 *   Names and email addresses. A permission change is recorded as membership id,
 *   role code, permission code and branch id. Who those belong to is answerable
 *   from `users`; an audit row is not a place to re-store it.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AssignRoleRequest,
  MemberDetail,
  MemberListResponse,
  PermissionOverrideRequest,
  UpdateMemberRequest,
} from '@rcln/contracts';
import { SYSTEM_ROLES } from '@rcln/permissions';
import { AuthorizationError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { invalidateUserAccess } from '../auth/access.service.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  assertBranchAssignable,
  assertGrantable,
  coversEveryBranch,
  grantableCodes,
  type Caller,
} from './guards.js';
import { visibleRoleWhere } from './role.service.js';

/** Request metadata carried onto the audit row. Same shape as the branch service. */
export interface MemberActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** What Prisma is asked for, so every path returns the same member shape. */
const MEMBER_SELECT = {
  id: true,
  userId: true,
  status: true,
  joinedAt: true,
  user: { select: { fullName: true, email: true, phone: true } },
  roles: {
    select: {
      id: true,
      roleId: true,
      branchId: true,
      validFrom: true,
      validTo: true,
      role: { select: { code: true, name: true } },
      branch: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  overrides: {
    select: {
      id: true,
      branchId: true,
      effect: true,
      reason: true,
      permission: { select: { code: true } },
      branch: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  staffProfile: {
    select: {
      employeeCode: true,
      department: true,
      designation: true,
      joinedOn: true,
      relievedOn: true,
    },
  },
} as const;

interface MemberRow {
  id: string;
  userId: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  joinedAt: Date | null;
  user: { fullName: string; email: string; phone: string | null };
  roles: {
    id: string;
    roleId: string;
    branchId: string | null;
    validFrom: Date | null;
    validTo: Date | null;
    role: { code: string; name: string };
    branch: { name: string } | null;
  }[];
  overrides: {
    id: string;
    branchId: string | null;
    effect: 'GRANT' | 'DENY';
    reason: string | null;
    permission: { code: string };
    branch: { name: string } | null;
  }[];
  staffProfile: {
    employeeCode: string | null;
    department: string | null;
    designation: string | null;
    joinedOn: Date | null;
    relievedOn: Date | null;
  } | null;
}

/** `@db.Date` comes back as a DateTime at UTC midnight; the date part is the value. */
function toDateOnly(value: Date | null): string | null {
  return value ? (value.toISOString().slice(0, 10) as string) : null;
}

function toDetail(row: MemberRow, ctx: TenantContext): MemberDetail {
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    phone: row.user.phone,
    status: row.status,
    joinedAt: row.joinedAt?.toISOString() ?? null,
    roles: row.roles.map((assignment) => ({
      id: assignment.id,
      roleId: assignment.roleId,
      roleCode: assignment.role.code,
      roleName: assignment.role.name,
      branchId: assignment.branchId,
      branchName: assignment.branch?.name ?? null,
      validFrom: assignment.validFrom?.toISOString() ?? null,
      validTo: assignment.validTo?.toISOString() ?? null,
    })),
    overrides: row.overrides.map((override) => ({
      id: override.id,
      permissionCode: override.permission.code,
      branchId: override.branchId,
      branchName: override.branch?.name ?? null,
      effect: override.effect,
      reason: override.reason,
    })),
    employeeCode: row.staffProfile?.employeeCode ?? null,
    department: row.staffProfile?.department ?? null,
    designation: row.staffProfile?.designation ?? null,
    joinedOn: toDateOnly(row.staffProfile?.joinedOn ?? null),
    relievedOn: toDateOnly(row.staffProfile?.relievedOn ?? null),
    isSelf: row.userId === ctx.userId,
  };
}

/**
 * RLS has already narrowed `memberships` to this organization, so a membership
 * belonging to another clinic is not found rather than compared-and-rejected.
 */
async function findMember(
  tx: TxClient,
  membershipId: string,
  { includeRemoved = false } = {}
): Promise<MemberRow> {
  const row = await tx.membership.findFirst({
    where: { id: membershipId, ...(includeRemoved ? {} : { deletedAt: null }) },
    select: MEMBER_SELECT,
  });
  if (!row) throw new NotFoundError('Member');
  return row as MemberRow;
}

/**
 * Nobody edits their own access.
 *
 * Two failure modes, one rule. Upwards: an org admin grants themselves the
 * permissions their role was deliberately denied, and the "you cannot grant what
 * you do not hold" guard is no defence because they would hold it a moment
 * later. Downwards: the only administrator at a clinic revokes their own last
 * role and nobody can undo it, because the person who could is now locked out.
 *
 * 403, not 404. The member obviously exists — it is the caller — so there is
 * nothing to hide, and the message is the useful part.
 */
function assertNotSelf(member: MemberRow, ctx: TenantContext): void {
  if (member.userId !== ctx.userId) return;
  throw new AuthorizationError(
    'You cannot change your own access. Ask another administrator at this clinic.'
  );
}

/**
 * A clinic must keep at least one owner, for the same reason it must keep at
 * least one branch: the state with none is unreachable by any other route and
 * nothing knows how to recover from it.
 *
 * ORG_OWNER assignments are org-wide (`branch_id NULL`), so branch_isolation
 * leaves them visible whatever scope the caller has and this count is complete.
 */
async function assertNotLastOwner(
  tx: TxClient,
  {
    excludeMembershipId,
    excludeAssignmentId,
  }: {
    excludeMembershipId?: string;
    excludeAssignmentId?: string;
  }
): Promise<void> {
  const remaining = await tx.membershipRole.count({
    where: {
      role: { code: SYSTEM_ROLES.ORG_OWNER, isSystem: true },
      membership: { status: 'ACTIVE', deletedAt: null },
      ...(excludeMembershipId !== undefined ? { membershipId: { not: excludeMembershipId } } : {}),
      ...(excludeAssignmentId !== undefined ? { id: { not: excludeAssignmentId } } : {}),
    },
  });

  if (remaining === 0) {
    throw new ConflictError(
      'This clinic would be left without an owner. Give someone else the Organization Owner role first.'
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listMembers(ctx: TenantContext, caller: Caller): Promise<MemberListResponse> {
  const grantable = await grantableCodes(ctx, caller);

  return withTenant(ctx, async (tx) => {
    const rows = await tx.membership.findMany({
      where: { deletedAt: null },
      select: MEMBER_SELECT,
      orderBy: { user: { fullName: 'asc' } },
      // A clinic with more than this many staff needs a search box, not a
      // bigger page. Until then, showing everyone is the honest thing.
      take: 200,
    });

    // Same filter as the roles screen and as invitations: never PLATFORM scope.
    const roles = await tx.role.findMany({
      where: visibleRoleWhere(ctx),
      select: { id: true, code: true, name: true, scopeLevel: true },
      orderBy: [{ isSystem: 'asc' }, { name: 'asc' }],
    });

    // The caller's own reach, no wider — this is what the assign form offers,
    // and offering more would only produce a 404 on submit.
    const branches = await tx.branch.findMany({
      where: { id: { in: ctx.branchIds }, deletedAt: null },
      select: { id: true, name: true, code: true },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });

    const permissions = await tx.permission.findMany({
      where: { module: { not: 'platform' } },
      select: { code: true },
    });

    return {
      members: (rows as MemberRow[]).map((row) => toDetail(row, ctx)),
      roles: roles.map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        scopeLevel: role.scopeLevel as 'ORGANIZATION' | 'BRANCH',
      })),
      branches,
      // null is unrestricted (a platform admin); on the wire that is the whole
      // catalogue, because the UI has no third state to render.
      grantableCodes: grantable ?? permissions.map((p) => p.code),
      canAssignOrgWide: await coversEveryBranch(tx, ctx, caller),
    };
  });
}

export async function getMember(ctx: TenantContext, membershipId: string): Promise<MemberDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findMember(tx, membershipId), ctx));
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

export async function assignRole(
  ctx: TenantContext,
  caller: Caller,
  membershipId: string,
  input: AssignRoleRequest,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  const grantable = await grantableCodes(ctx, caller);

  const updated = await withTenant(ctx, async (tx) => {
    const member = await findMember(tx, membershipId);
    assertNotSelf(member, ctx);

    // `roles` is RLS-exempt, so this filter is the tenant boundary — and it
    // excludes PLATFORM scope, or a clinic admin could hand out SUPER_ADMIN.
    const role = await tx.role.findFirst({
      where: { id: input.roleId, ...visibleRoleWhere(ctx) },
      select: {
        id: true,
        code: true,
        name: true,
        scopeLevel: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    });
    if (!role) throw new NotFoundError('Role');

    /**
     * The guard that makes the one in `createRole` worth having.
     *
     * Without it an ORG_ADMIN — denied `organization.billing.manage`,
     * `branch.delete` and `patient.delete` by definition — simply assigns
     * ORG_OWNER to a colleague and has all three back through them.
     */
    assertGrantable(
      grantable,
      role.permissions.map((p) => p.permission.code)
    );

    if (role.scopeLevel === 'ORGANIZATION' && input.branchId !== null) {
      throw new ConflictError(
        `${role.name} applies to the whole organization. Leave the branch unset.`
      );
    }

    // MUST come before the write. Out of scope, the policy refuses the INSERT
    // and the caller gets a 500; org-wide, it does not refuse it at all.
    await assertBranchAssignable(tx, ctx, caller, input.branchId);

    const duplicate = await tx.membershipRole.findFirst({
      where: { membershipId, roleId: role.id, branchId: input.branchId },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(
        input.branchId === null
          ? `They already hold ${role.name} across the whole clinic.`
          : `They already hold ${role.name} at that branch.`
      );
    }

    const assignment = await tx.membershipRole.create({
      data: {
        membershipId,
        // Denormalised from the membership so RLS can filter without a join and
        // the composite FK to branches holds. Never taken from the request.
        organizationId: ctx.organizationId,
        roleId: role.id,
        branchId: input.branchId,
        ...(input.validFrom !== undefined ? { validFrom: new Date(input.validFrom) } : {}),
        ...(input.validTo !== undefined ? { validTo: new Date(input.validTo) } : {}),
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'membership_role',
      entityId: assignment.id,
      // Codes and ids. Never the member's name — see the file header.
      after: {
        membershipId,
        roleCode: role.code,
        branchId: input.branchId,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
      },
      branchId: input.branchId,
      ...options,
    });

    return { detail: toDetail(await findMember(tx, membershipId), ctx), userId: member.userId };
  });

  await invalidateUserAccess(updated.userId, ctx.organizationId);
  return updated.detail;
}

/**
 * No `Caller` here, and none is needed: the assignment has to be read before it
 * can be deleted, and branch_isolation makes an out-of-scope row unreadable. The
 * guard the write path needs is already doing its job as a policy.
 */
export async function revokeRole(
  ctx: TenantContext,
  membershipId: string,
  assignmentId: string,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  const updated = await withTenant(ctx, async (tx) => {
    const member = await findMember(tx, membershipId);
    assertNotSelf(member, ctx);

    /**
     * An assignment in a branch outside the caller's scope is invisible to this
     * read — branch_isolation, not a `where` clause — so it is a clean 404
     * rather than a delete that reports success having matched nothing.
     */
    const assignment = await tx.membershipRole.findFirst({
      where: { id: assignmentId, membershipId },
      select: {
        id: true,
        branchId: true,
        validFrom: true,
        validTo: true,
        role: { select: { code: true, isSystem: true } },
      },
    });
    if (!assignment) throw new NotFoundError('Role assignment');

    if (assignment.role.isSystem && assignment.role.code === SYSTEM_ROLES.ORG_OWNER) {
      await assertNotLastOwner(tx, { excludeAssignmentId: assignmentId });
    }

    await tx.membershipRole.delete({ where: { id: assignmentId } });

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'membership_role',
      entityId: assignmentId,
      before: {
        membershipId,
        roleCode: assignment.role.code,
        branchId: assignment.branchId,
        validFrom: assignment.validFrom?.toISOString() ?? null,
        validTo: assignment.validTo?.toISOString() ?? null,
      },
      branchId: assignment.branchId,
      ...options,
    });

    return { detail: toDetail(await findMember(tx, membershipId), ctx), userId: member.userId };
  });

  await invalidateUserAccess(updated.userId, ctx.organizationId);
  return updated.detail;
}

// ---------------------------------------------------------------------------
// Per-person overrides
// ---------------------------------------------------------------------------

/**
 * Grant or deny one permission for one person, overruling their roles.
 *
 * Idempotent on (membership, permission, branch): setting an existing override
 * to the other effect flips it rather than failing. The unique index there is
 * `NULLS NOT DISTINCT`, and per .kb/Architecture/PITFALLS.md Prisma cannot `upsert` against
 * a compound unique containing a NULL — so this is findFirst then create or
 * update, the same shape `prisma/seed.ts` uses.
 */
export async function setOverride(
  ctx: TenantContext,
  caller: Caller,
  membershipId: string,
  input: PermissionOverrideRequest,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  const grantable = await grantableCodes(ctx, caller);

  /**
   * Only a GRANT is checked against what the caller holds.
   *
   * A DENY takes something away; nobody escalates by removing a permission, and
   * refusing to let an administrator deny a permission they happen not to hold
   * themselves would block the ordinary "this receptionist must not issue
   * refunds" case.
   */
  if (input.effect === 'GRANT') assertGrantable(grantable, [input.permissionCode]);

  const updated = await withTenant(ctx, async (tx) => {
    const member = await findMember(tx, membershipId);
    assertNotSelf(member, ctx);

    // `permissions` is a static, RLS-exempt catalogue; platform codes are not
    // offered to a tenant at all.
    const permission = await tx.permission.findFirst({
      where: { code: input.permissionCode, module: { not: 'platform' } },
      select: { id: true, code: true },
    });
    if (!permission) throw new NotFoundError('Permission');

    await assertBranchAssignable(tx, ctx, caller, input.branchId);

    const existing = await tx.membershipPermissionOverride.findFirst({
      where: { membershipId, permissionId: permission.id, branchId: input.branchId },
      select: { id: true, effect: true, reason: true },
    });

    const row = existing
      ? await tx.membershipPermissionOverride.update({
          where: { id: existing.id },
          data: {
            effect: input.effect,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          },
          select: { id: true },
        })
      : await tx.membershipPermissionOverride.create({
          data: {
            membershipId,
            organizationId: ctx.organizationId,
            permissionId: permission.id,
            branchId: input.branchId,
            effect: input.effect,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          },
          select: { id: true },
        });

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'membership_permission_override',
      entityId: row.id,
      ...(existing
        ? {
            before: {
              membershipId,
              permissionCode: permission.code,
              branchId: input.branchId,
              effect: existing.effect,
              reason: existing.reason,
            },
          }
        : {}),
      after: {
        membershipId,
        permissionCode: permission.code,
        branchId: input.branchId,
        effect: input.effect,
        reason: input.reason ?? null,
      },
      branchId: input.branchId,
      ...options,
    });

    return { detail: toDetail(await findMember(tx, membershipId), ctx), userId: member.userId };
  });

  await invalidateUserAccess(updated.userId, ctx.organizationId);
  return updated.detail;
}

export async function clearOverride(
  ctx: TenantContext,
  membershipId: string,
  overrideId: string,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  const updated = await withTenant(ctx, async (tx) => {
    const member = await findMember(tx, membershipId);
    assertNotSelf(member, ctx);

    // Invisible outside the caller's branch scope, so out of scope is a 404.
    const override = await tx.membershipPermissionOverride.findFirst({
      where: { id: overrideId, membershipId },
      select: {
        id: true,
        branchId: true,
        effect: true,
        reason: true,
        permission: { select: { code: true } },
      },
    });
    if (!override) throw new NotFoundError('Override');

    await tx.membershipPermissionOverride.delete({ where: { id: overrideId } });

    await recordAudit(tx, ctx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'membership_permission_override',
      entityId: overrideId,
      before: {
        membershipId,
        permissionCode: override.permission.code,
        branchId: override.branchId,
        effect: override.effect,
        reason: override.reason,
      },
      branchId: override.branchId,
      ...options,
    });

    return { detail: toDetail(await findMember(tx, membershipId), ctx), userId: member.userId };
  });

  await invalidateUserAccess(updated.userId, ctx.organizationId);
  return updated.detail;
}

// ---------------------------------------------------------------------------
// Employment record and status
// ---------------------------------------------------------------------------

/**
 * The employment fields, which could not be captured on the invitation.
 *
 * `staff_profiles` keys on membership and the membership does not exist until
 * the invitation is accepted (see the note on `inviteMemberRequest`), so this is
 * where an employee code finally lands. It grants nothing — no cache to
 * invalidate, and `iam.user.update` rather than `iam.permission.assign`.
 *
 * The table has no organization_id; it is isolated by an EXISTS against its
 * membership (migration 20260726090000). Addressing a row by its own id would
 * be refused by that policy as a silent zero-row write, so the membership is
 * always the way in.
 */
export async function updateMember(
  ctx: TenantContext,
  membershipId: string,
  input: UpdateMemberRequest,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  return withTenant(ctx, async (tx) => {
    const before = await findMember(tx, membershipId);

    const data = {
      ...(input.employeeCode !== undefined ? { employeeCode: input.employeeCode } : {}),
      ...(input.department !== undefined ? { department: input.department } : {}),
      ...(input.designation !== undefined ? { designation: input.designation } : {}),
      ...(input.joinedOn !== undefined
        ? { joinedOn: input.joinedOn === null ? null : new Date(input.joinedOn) }
        : {}),
      ...(input.relievedOn !== undefined
        ? { relievedOn: input.relievedOn === null ? null : new Date(input.relievedOn) }
        : {}),
    };

    // membershipId is a real unique with no NULL in it, so upsert is safe here —
    // unlike the override above.
    await tx.staffProfile.upsert({
      where: { membershipId },
      create: { membershipId, ...data },
      update: data,
    });

    const after = await findMember(tx, membershipId);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'staff_profile',
      entityId: membershipId,
      before: {
        employeeCode: before.staffProfile?.employeeCode ?? null,
        department: before.staffProfile?.department ?? null,
        designation: before.staffProfile?.designation ?? null,
        joinedOn: toDateOnly(before.staffProfile?.joinedOn ?? null),
        relievedOn: toDateOnly(before.staffProfile?.relievedOn ?? null),
      },
      after: {
        employeeCode: after.staffProfile?.employeeCode ?? null,
        department: after.staffProfile?.department ?? null,
        designation: after.staffProfile?.designation ?? null,
        joinedOn: toDateOnly(after.staffProfile?.joinedOn ?? null),
        relievedOn: toDateOnly(after.staffProfile?.relievedOn ?? null),
      },
      ...options,
    });

    return toDetail(after, ctx);
  });
}

/**
 * Suspend or restore a member.
 *
 * Suspension is not a soft delete: the membership, its roles and its history all
 * survive, and restoring gives everything back. It is the answer to "they are on
 * leave" and to "revoke their access now, we will work out the rest later".
 *
 * No session is revoked here, and none needs to be. `loadUserAccess` only ever
 * returns an ACTIVE membership, so once the cache is dropped below, the very
 * next request from that person is refused by `authenticate` — their live access
 * token stops working without waiting for it to expire.
 */
export async function setMemberStatus(
  ctx: TenantContext,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  reason: string | undefined,
  options: MemberActionOptions = {}
): Promise<MemberDetail> {
  const updated = await withTenant(ctx, async (tx) => {
    const before = await findMember(tx, membershipId);
    assertNotSelf(before, ctx);

    if (before.status === status) {
      throw new ConflictError(
        status === 'SUSPENDED' ? 'They are already suspended.' : 'They are already active.'
      );
    }

    /**
     * An INVITED membership has not been accepted yet; there is nothing to
     * suspend, and revoking the invitation is the action that means something.
     */
    if (before.status === 'INVITED') {
      throw new ConflictError(
        'They have not accepted their invitation yet. Cancel the invitation instead.'
      );
    }

    if (status === 'SUSPENDED') {
      await assertNotLastOwner(tx, { excludeMembershipId: membershipId });
    }

    await tx.membership.update({ where: { id: membershipId }, data: { status } });
    const after = await findMember(tx, membershipId);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'membership',
      entityId: membershipId,
      before: { status: before.status },
      after: { status, ...(reason !== undefined ? { reason } : {}) },
      ...options,
    });

    return { detail: toDetail(after, ctx), userId: before.userId };
  });

  // Mandatory, and after COMMIT — this is what makes a suspension take effect
  // now rather than within the 60-second cache TTL.
  await invalidateUserAccess(updated.userId, ctx.organizationId);
  return updated.detail;
}
