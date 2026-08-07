/**
 * The job titles a clinic hands out.
 *
 * A platform catalogue with per-tenant extension — the same shape as
 * `specialties`. Reading returns the platform rows plus this clinic's own;
 * writing can only ever produce a row carrying this clinic's organization_id,
 * because the RLS policy's WITH CHECK is deliberately not NULL-permissive.
 *
 * WHY A TABLE AND NOT FREE TEXT ON `staff_profiles`
 *   Free text produces "Sr. Consultant", "Senior Consultant" and "Sr Consultant"
 *   as three different things, and makes "how many consultants do we have"
 *   unanswerable. It also makes the invite form a text box, which is where those
 *   three variants come from in the first place.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateDesignationRequest,
  DesignationSummary,
  RolePairings,
  SetRolePairingsRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

export interface DesignationActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * `Senior Consultant` -> `SENIOR_CONSULTANT`.
 *
 * Derived rather than typed, so two administrators adding the same title on the
 * same day collide on the unique index instead of creating a near-duplicate.
 * Runs of non-alphanumerics collapse to one underscore, so "Sr. Consultant"
 * and "Sr Consultant" both land on `SR_CONSULTANT`.
 */
function codeFor(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/** One pairing row as the rules below need to see it. */
interface PairingRow {
  roleId: string;
  organizationId: string | null;
  isExcluded: boolean;
}

/**
 * THE ELIGIBILITY RULE. Everything about role↔title filtering resolves here.
 *
 * Precedence, most specific first:
 *
 *   1. This clinic said something about (role, title) — its answer wins,
 *      whether that is "yes" or "no". There is at most one such row, because
 *      the unique is (organization_id, role_id, designation_id).
 *   2. A platform default pairs them — yes.
 *   3. Otherwise: does this title have a POSITIVE pairing to ANY role? If not
 *      it is unmapped, and unmapped means "fits anywhere". If it does, it is a
 *      managed title and this role is not on its list — no.
 *
 * ⚠️ STEP 3 COUNTS POSITIVE ROWS ONLY, AND THAT IS NOT A DETAIL.
 *   Counting exclusions too breaks it in both directions:
 *
 *     Unticking an unmapped title for one role creates its only row. If that
 *     counted, the title would read as "managed" and disappear from every OTHER
 *     role's menu — one unrelated tick emptying six other lists.
 *
 *     Unticking every platform pairing of a title leaves only exclusions. If
 *     positives had gone to zero the title would read as unmapped, and unmapped
 *     means valid EVERYWHERE — the precise opposite of what was asked for.
 */
function eligibleRoleIds(pairings: PairingRow[], allRoleIds: string[]): string[] {
  const tenant = new Map<string, boolean>();
  const platform = new Set<string>();

  for (const row of pairings) {
    if (row.organizationId !== null) tenant.set(row.roleId, !row.isExcluded);
    else if (!row.isExcluded) platform.add(row.roleId);
  }

  /** Is this title constrained at all? Positive rows only — see the note above. */
  const hasPositive = platform.size > 0 || [...tenant.values()].some(Boolean);

  return allRoleIds.filter((roleId) => {
    /*
     * The clinic's own answer wins FIRST, and this ordering is the whole rule.
     *
     * Checking `hasPositive` before the tenant row — which reads naturally and
     * is what this function did first — means a title whose ONLY row is an
     * exclusion has no positives, falls through to the unmapped branch, and
     * comes back eligible for the very role it was just excluded from.
     */
    const explicit = tenant.get(roleId);
    if (explicit !== undefined) return explicit;

    if (platform.has(roleId)) return true;

    // Nobody constrained this title, so it fits anywhere.
    return !hasPositive;
  });
}

/** True when nobody has constrained this title, so it fits every role. */
function fitsAnyRole(pairings: PairingRow[]): boolean {
  return !pairings.some((row) => !row.isExcluded);
}

const PAIRING_SELECT = { roleId: true, organizationId: true, isExcluded: true } as const;

/**
 * Every designation this clinic may use: the platform catalogue plus its own.
 *
 * The RLS policy already limits the read, so no explicit filter is needed —
 * but `isOwn` is computed here rather than exposing `organizationId`, because
 * the screen only needs to know whether the row is the clinic's to retire.
 */
export async function listDesignations(ctx: TenantContext): Promise<DesignationSummary[]> {
  return withTenant(ctx, async (tx) => {
    const [rows, roles] = await Promise.all([
      tx.designation.findMany({
        where: { isActive: true, deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          organizationId: true,
          // RLS narrows these to platform pairings plus this clinic's own, so a
          // pairing another tenant made is invisible — and a title mapped ONLY
          // by that tenant reads here as unmapped, which correctly means "fits
          // anywhere" rather than leaking that a mapping exists.
          roles: { select: PAIRING_SELECT },
        },
        orderBy: { name: 'asc' },
      }),
      // `roles` is RLS-EXEMPT, so this filter IS the tenant boundary.
      tx.role.findMany({
        where: {
          OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
          scopeLevel: { not: 'PLATFORM' },
        },
        select: { id: true },
      }),
    ]);

    const allRoleIds = roles.map((r) => r.id);

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isOwn: row.organizationId !== null,
      roleIds: eligibleRoleIds(row.roles, allRoleIds),
      fitsAnyRole: fitsAnyRole(row.roles),
    }));
  });
}

/**
 * Is this title allowed for this role? The same rule as above, for one pair.
 *
 * Runs on the caller's transaction so it can share the one the invitation is
 * being written in — checking eligibility in a separate transaction from the
 * insert would leave a window where the mapping changes in between.
 */
export async function isDesignationEligible(
  tx: TxClient,
  roleId: string,
  designationId: string
): Promise<boolean> {
  const pairings = await tx.roleDesignation.findMany({
    where: { designationId },
    select: PAIRING_SELECT,
  });

  return eligibleRoleIds(pairings, [roleId]).includes(roleId);
}

/**
 * Add a title this clinic uses and the platform catalogue does not have.
 *
 * Always org-scoped: `organizationId` is set from the context and never from the
 * request, so this cannot produce a platform row. The RLS policy's WITH CHECK
 * enforces the same thing independently.
 */
export async function createDesignation(
  ctx: TenantContext,
  input: CreateDesignationRequest,
  options: DesignationActionOptions = {}
): Promise<DesignationSummary> {
  const code = codeFor(input.name);

  if (code === '') {
    throw new ConflictError('Give the title at least one letter or number.');
  }

  const row = await withTenant(ctx, async (tx) => {
    /*
     * Checked against the whole visible set — platform rows included. A clinic
     * adding its own "Consultant" when the platform already publishes one gets
     * a duplicate in every menu, and the unique index would not catch it
     * because the two rows differ by organization_id.
     */
    const clash = await tx.designation.findFirst({
      where: { code, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.organizationId === null
          ? `“${input.name}” is already available — it is one of the standard titles.`
          : `“${input.name}” is already on your list.`
      );
    }

    const created = await tx.designation.create({
      data: { organizationId: ctx.organizationId, code, name: input.name.trim() },
      select: { id: true, code: true, name: true },
    });

    /*
     * Map it to the role being invited for, if the caller said which.
     *
     * Without this the new title lands unmapped, which under the eligibility
     * rule means "fits every role" — the opposite of what someone adding
     * "Trichology Consultant" while inviting a doctor intends.
     *
     * The role is validated first: `roles` is RLS-EXEMPT, so an unchecked id
     * here would let a clinic pair its title with another clinic's private role.
     * The RESTRICTIVE role_visible policy would refuse it, but as an RLS
     * violation that reaches the caller as a 500.
     */
    const roleIds: string[] = [];
    if (input.roleId !== undefined) {
      const role = await tx.role.findFirst({
        where: {
          id: input.roleId,
          OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
        },
        select: { id: true },
      });
      if (!role) throw new NotFoundError('Role');

      await tx.roleDesignation.create({
        data: {
          organizationId: ctx.organizationId,
          roleId: role.id,
          designationId: created.id,
        },
      });
      roleIds.push(role.id);
    }

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'designation',
      entityId: created.id,
      after: { code: created.code, name: created.name, roleIds },
      ...options,
    });

    // Mapped to a role means it is constrained; unmapped means it fits any.
    return { ...created, roleIds, fitsAnyRole: roleIds.length === 0 };
  });

  return { ...row, isOwn: true };
}

// ---------------------------------------------------------------------------
// Managing the pairings, from the clinic settings screen
// ---------------------------------------------------------------------------

/**
 * Every assignable role with its title list, for the settings grid.
 *
 * PLATFORM-scoped roles are excluded: they cannot be invited into, so pairing
 * them with a job title would be configuring something unreachable.
 */
export async function listRolePairings(ctx: TenantContext): Promise<RolePairings[]> {
  return withTenant(ctx, async (tx) => {
    const [roles, designations, pairings] = await Promise.all([
      // `roles` is RLS-EXEMPT, so this filter IS the tenant boundary.
      tx.role.findMany({
        where: {
          OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
          scopeLevel: { not: 'PLATFORM' },
        },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      tx.designation.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      tx.roleDesignation.findMany({ select: { designationId: true, ...PAIRING_SELECT } }),
    ]);

    const byDesignation = new Map<string, PairingRow[]>();
    for (const row of pairings) {
      const list = byDesignation.get(row.designationId) ?? [];
      list.push(row);
      byDesignation.set(row.designationId, list);
    }

    const allRoleIds = roles.map((r) => r.id);

    return roles.map((role) => ({
      roleId: role.id,
      roleCode: role.code,
      roleName: role.name,
      titles: designations.map((designation) => {
        const rows = byDesignation.get(designation.id) ?? [];
        return {
          designationId: designation.id,
          name: designation.name,
          enabled: eligibleRoleIds(rows, allRoleIds).includes(role.id),
          isPlatformDefault: rows.some(
            (r) => r.organizationId === null && r.roleId === role.id && !r.isExcluded
          ),
        };
      }),
    }));
  });
}

/**
 * Replace the set of titles that fit one role.
 *
 * Reconciles the requested list against the platform defaults and writes the
 * smallest set of tenant rows that expresses the difference:
 *
 *   wanted, and the platform already pairs them  -> no row (it is the default)
 *   wanted, and the platform does not            -> tenant row, isExcluded false
 *   not wanted, and the platform pairs them      -> tenant row, isExcluded TRUE
 *   not wanted, and the platform does not        -> no row
 *
 * Storing the difference rather than the whole list means a clinic that never
 * touched a role keeps tracking the platform defaults as they change, and a
 * clinic that returns a role to its default state leaves no residue behind.
 */
export async function setRolePairings(
  ctx: TenantContext,
  roleId: string,
  input: SetRolePairingsRequest,
  options: DesignationActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // `roles` is RLS-EXEMPT — without this filter a clinic could configure
    // another clinic's private role. PLATFORM roles are not invitable.
    const role = await tx.role.findFirst({
      where: {
        id: roleId,
        OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
        scopeLevel: { not: 'PLATFORM' },
      },
      select: { id: true, name: true },
    });
    if (!role) throw new NotFoundError('Role');

    // Only titles this clinic can actually see. An id naming another tenant's
    // private title would be refused by the RESTRICTIVE designation_visible
    // policy, but as a 500 rather than a named 404.
    const visible = await tx.designation.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true },
    });
    const visibleIds = new Set(visible.map((d) => d.id));

    const wanted = new Set(input.designationIds);
    for (const id of wanted) {
      if (!visibleIds.has(id)) throw new NotFoundError('Designation');
    }

    /*
     * EVERY visible pairing, not just this role's.
     *
     * The baseline below needs to know whether a title has a positive pairing
     * to ANY role, because a title with none fits every role — so "unticked and
     * not a platform default for this role" is NOT automatically "no row
     * needed". Fetching only this role's rows makes unticking an unmapped title
     * silently do nothing, which is exactly the bug this comment replaced.
     */
    const allPairings = await tx.roleDesignation.findMany({
      select: {
        id: true,
        designationId: true,
        roleId: true,
        organizationId: true,
        isExcluded: true,
      },
    });

    const hasPositiveAnywhere = new Set(
      allPairings.filter((r) => !r.isExcluded).map((r) => r.designationId)
    );

    const forThisRole = allPairings.filter((r) => r.roleId === roleId);
    const platformFor = new Set(
      forThisRole
        .filter((r) => r.organizationId === null && !r.isExcluded)
        .map((r) => r.designationId)
    );
    const tenantFor = new Map(
      forThisRole.filter((r) => r.organizationId !== null).map((r) => [r.designationId, r])
    );

    for (const designationId of visibleIds) {
      const isWanted = wanted.has(designationId);

      /*
       * What would apply to this (role, title) with no tenant row: the platform
       * default, OR "fits anywhere" when nothing positive pairs this title to
       * any role at all.
       */
      const baseline = platformFor.has(designationId) || !hasPositiveAnywhere.has(designationId);

      const tenantRow = tenantFor.get(designationId);
      // A tenant row is needed only where the answer differs from the baseline.
      const needsRow = isWanted !== baseline;

      if (!needsRow) {
        if (tenantRow) await tx.roleDesignation.delete({ where: { id: tenantRow.id } });
        continue;
      }

      if (tenantRow) {
        if (tenantRow.isExcluded === isWanted) {
          await tx.roleDesignation.update({
            where: { id: tenantRow.id },
            data: { isExcluded: !isWanted },
          });
        }
        continue;
      }

      await tx.roleDesignation.create({
        data: {
          organizationId: ctx.organizationId,
          roleId,
          designationId,
          isExcluded: !isWanted,
        },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'role_designations',
      entityId: roleId,
      // Ids and a count. The titles themselves are readable from the catalogue.
      after: { roleId, designationCount: wanted.size },
      ...options,
    });
  });
}
