/**
 * The three guards that stand between `iam.role.manage` and a privilege
 * escalation, shared by the role and member services.
 *
 * None of them is enforced by the database, and two of them CANNOT be — the
 * database has no idea what its caller is allowed to do. This file is the whole
 * defence, so it is deliberately small and heavily commented rather than spread
 * across the two services that use it.
 *
 * WHY EACH ONE EXISTS
 *
 *   1. `assertBranchAssignable` — `membership_roles` and
 *      `membership_permission_overrides` carry a RESTRICTIVE branch_isolation
 *      policy that ANDs with tenant_isolation. Naming a branch outside
 *      `app.branch_scope` is refused by its WITH CHECK, which reaches the caller
 *      as a 500 rather than as an answer. Checking first is what makes it the
 *      404 that reading an out-of-scope branch already gives (measured: with
 *      this guard removed, the case in iam.test.ts answers 500).
 *
 *      The USING half of the same policy is the quieter hazard: a row addressed
 *      by its own id in a branch out of scope is invisible, so an `updateMany` /
 *      `deleteMany` matches nothing and commits. Nothing in this file writes
 *      that way — every mutation reads the row first, which turns invisible into
 *      a clean 404 — and that is a rule to keep rather than a coincidence.
 *
 *   2. Org-wide grants (branch_id NULL) are exempt from that policy by design —
 *      that is what makes "every branch" expressible at all. Nothing in the
 *      database refuses one, so a caller whose own reach stops at two of five
 *      locations can hand somebody all five by omitting the branch: an
 *      escalation dressed up as an omission. Measured the same way — without
 *      this guard the request succeeds, 201, and the assignment is real. Same
 *      guard as `createInvitation`, same reasoning.
 *
 *   3. `assertGrantable` — you cannot grant a permission you do not hold. This
 *      is not theoretical here: ORG_ADMIN is defined in
 *      `packages/permissions/src/roles.ts` as everything EXCEPT
 *      `organization.billing.manage`, `branch.delete` and `patient.delete`.
 *      Without this guard, an org admin creates a custom role carrying all
 *      three, assigns it to a colleague, and the three deliberate exclusions
 *      mean nothing.
 *
 * PLATFORM ADMINS BYPASS ALL THREE. Per ADR-0012 impersonation is full access,
 * audited rather than restricted, and `authorize()` already lets them through.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import type { PermissionCode } from '@rcln/permissions';
import { AuthorizationError, NotFoundError } from '../../utils/errors.js';
import { loadUserAccess, permissionsFor } from '../auth/access.service.js';

/**
 * The bits of `req.auth` the guards need that a `TenantContext` does not carry.
 *
 * `branchId` is the branch the caller is acting in — the same value
 * `authorize()` resolved their permissions against, so this file and the
 * middleware cannot come to different conclusions about the same request.
 */
export interface Caller {
  isPlatformAdmin: boolean;
  branchId: string | null;
}

/**
 * Every permission code this caller may put on a role or into an override.
 *
 * `null` means unrestricted, which is only ever a platform admin. An empty
 * array would mean the opposite, so the two must not be confused.
 */
export async function grantableCodes(
  ctx: TenantContext,
  caller: Caller
): Promise<PermissionCode[] | null> {
  if (caller.isPlatformAdmin) return null;

  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  // They got past `authorize`, so this is a membership revoked in the last
  // moment rather than a caller who never had one.
  if (!access) throw new AuthorizationError('Access denied');

  return permissionsFor(access, ctx.userId, caller.branchId, false) as PermissionCode[];
}

/**
 * Refuse the codes the caller does not hold, naming them.
 *
 * Naming them is safe and is the only actionable answer: the caller can already
 * enumerate their own permissions from `/auth/session`, so this tells them
 * nothing they could not work out, and "access denied" would leave them
 * re-submitting the same form.
 */
export function assertGrantable(grantable: PermissionCode[] | null, codes: string[]): void {
  if (grantable === null) return;

  const held = new Set<string>(grantable);
  const beyond = codes.filter((code) => !held.has(code));
  if (beyond.length === 0) return;

  throw new AuthorizationError(
    `You cannot grant a permission you do not hold yourself: ${beyond.sort().join(', ')}.`
  );
}

/**
 * Whether this caller's own scope covers the whole clinic.
 *
 * Counted rather than compared, because `ctx.branchIds` is derived and cached:
 * an org-wide member's list is every ACTIVE branch as of the last cache fill.
 */
export async function coversEveryBranch(
  tx: TxClient,
  ctx: TenantContext,
  caller: Caller
): Promise<boolean> {
  if (caller.isPlatformAdmin) return true;

  const beyondScope = await tx.branch.count({
    where: { deletedAt: null, id: { notIn: ctx.branchIds } },
  });
  return beyondScope === 0;
}

/**
 * May this caller write a `membership_roles` / `membership_permission_overrides`
 * row for this branch? Throws if not.
 *
 * @param branchId `null` for an org-wide grant — see guard 2 in the header.
 */
export async function assertBranchAssignable(
  tx: TxClient,
  ctx: TenantContext,
  caller: Caller,
  branchId: string | null
): Promise<void> {
  if (caller.isPlatformAdmin) return;

  if (branchId === null) {
    if (await coversEveryBranch(tx, ctx, caller)) return;
    // 403, not 404: nothing is being hidden. The caller knows their own scope,
    // and "name the branches explicitly" is the only useful thing to say.
    throw new AuthorizationError(
      'You can only grant access to the branches you manage. Choose them explicitly.'
    );
  }

  /**
   * An empty scope with a branch named is the silent-write case in its purest
   * form: `branch_id = ANY('{}')` is false for every row, so the insert would
   * commit having done nothing. It should not be reachable — `authorize` needs
   * a membership — but a platform admin session with no branch scope would land
   * here, and this must be a loud error rather than a successful no-op.
   */
  if (ctx.branchIds.length === 0) {
    throw new AuthorizationError('This session has no branch to act in.');
  }

  // Out of scope is reported as not existing, exactly as reading it is.
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  // A branch retired since the access cache was filled is still in branchIds.
  const live = await tx.branch.count({ where: { id: branchId, deletedAt: null } });
  if (live !== 1) throw new NotFoundError('Branch');
}
