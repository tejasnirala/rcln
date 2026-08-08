/**
 * Invitations: how anyone other than the founder gets into a clinic.
 *
 * TWO HALVES, TWO SECURITY MODELS
 *   Issuing, listing, revoking and resending are ordinary tenant work — behind
 *   `requireTenant`, scoped by `withTenant`, audited like everything else.
 *
 *   Accepting is not. It runs for someone who has, by definition, no membership
 *   in this organization yet and may have no account at all. That is the same
 *   position registration is in, and it gets the same treatment: an
 *   `unsafeDbClient()` transaction that calls `setTenantContext()` mid-flight.
 *   See the header of `acceptInvitation` — it is NOT a general-purpose door, and
 *   `withUserIdentity()` is emphatically not the tool for it (ADR-0011).
 *
 * THE TOKEN IS A CREDENTIAL
 *   256 random bits, handed to the invitee in the clear exactly once and stored
 *   only as a SHA-256 digest in `invitations.token` — the same treatment as
 *   `sessions.refresh_token_hash` and `auth_tokens.code_hash`, for the same
 *   reason: presenting it mints a membership with whatever role it names, so a
 *   dump of the table must not be replayable. Nothing here returns it to anyone
 *   but the sender.
 *
 * SCOPING, AND WHAT RLS WILL NOT DO FOR YOU
 *   `invitations` carries tenant_isolation, so RLS narrows to the organization.
 *   `roles`, `users` and `organizations` are RLS-EXEMPT — every read of them
 *   here filters explicitly, and a mistake there produces no error.
 *
 *   `invitation_branches` is protected by two policies (migration
 *   20260726090000): parent_isolation via the invitation, and a RESTRICTIVE
 *   branch_in_same_org, because its `branch_id` is a plain FK to `branches(id)`
 *   rather than one of the composite ones. Attaching another clinic's branch is
 *   refused by the database — but as a policy violation, which reaches the
 *   caller as a 500. Every branch is checked against `ctx.branchIds` first so it
 *   surfaces as a clean 404 instead.
 */
import { randomUUID } from 'node:crypto';
import { setTenantContext, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { password } from '@rcln/contracts';
import type {
  InvitationListResponse,
  InvitationPreview,
  InvitationSummary,
  InviteMemberRequest,
} from '@rcln/contracts';
import { config } from '../../config/index.js';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { invalidateUserAccess } from '../auth/access.service.js';
import { verifyCredentials } from '../auth/login.service.js';
import { hashPassword } from '../auth/password.service.js';
import { generateInviteToken, hashInviteToken } from '../auth/token.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { sender } from '../notification/sender.js';
import { isDesignationEligible } from '../iam/designation.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { resolveSettings } from '../settings/resolver.service.js';

/** Request metadata carried onto the audit row. Same shape as the branch service. */
export interface InvitationActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Seven days.
 *
 * Long enough that an invitation sent on a Friday survives the weekend, short
 * enough that a link forwarded into a mailing-list archive is dead before anyone
 * finds it. A constant rather than an env var: nothing about a deployment makes
 * a different answer right, and an environment that quietly disagreed with the
 * copy on the accept page would be worse than no knob at all.
 */
const INVITE_TTL_DAYS = 7;

/** What Prisma is asked for, so list, create and revoke cannot drift apart. */
const INVITATION_SELECT = {
  id: true,
  email: true,
  phone: true,
  roleId: true,
  designationId: true,
  invitedBy: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  role: { select: { name: true } },
  designation: { select: { name: true } },
  inviter: { select: { fullName: true } },
  branches: { select: { branch: { select: { id: true, name: true, code: true } } } },
} as const;

interface InvitationRow {
  id: string;
  email: string;
  phone: string | null;
  roleId: string;
  designationId: string | null;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  role: { name: string };
  designation: { name: string } | null;
  inviter: { fullName: string };
  branches: { branch: { id: string; name: string; code: string } }[];
}

/**
 * Three timestamps, one word.
 *
 * Order matters: an invitation revoked after it expired reads as REVOKED,
 * because somebody made a decision about it and that is the more useful fact.
 */
function statusOf(row: InvitationRow): InvitationSummary['status'] {
  if (row.acceptedAt) return 'ACCEPTED';
  if (row.revokedAt) return 'REVOKED';
  if (row.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

function toSummary(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    status: statusOf(row),
    roleId: row.roleId,
    roleName: row.role.name,
    branches: row.branches.map((b) => b.branch),
    invitedByName: row.inviter.fullName,
    expiresAt: row.expiresAt.toISOString(),
    // Derived here rather than in the browser, against the same clock that
    // decided `status` above — so the word and the countdown cannot disagree.
    daysLeft: Math.ceil((row.expiresAt.getTime() - Date.now()) / 86_400_000),
    createdAt: row.createdAt.toISOString(),
  };
}

/** What goes on the audit row: the grant, never the token. */
function snapshot(row: InvitationRow): Record<string, unknown> {
  return {
    email: row.email,
    roleId: row.roleId,
    branchIds: row.branches.map((b) => b.branch.id).sort(),
    status: statusOf(row),
    expiresAt: row.expiresAt,
  };
}

/** `northwind` plus a token: the link that lands on that clinic's accept page. */
function joinUrl(slug: string, token: string): string {
  const scheme = config.isProduction ? 'https' : 'http';
  const port = config.isProduction ? '' : new URL(config.webUrl).port;
  const suffix = port ? `:${port}` : '';
  return `${scheme}://${slug}.${config.rootDomain}${suffix}/join?token=${token}`;
}

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Issuing side: ordinary tenant work
// ---------------------------------------------------------------------------

export async function listInvitations(ctx: TenantContext): Promise<InvitationListResponse> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.invitation.findMany({
      select: INVITATION_SELECT,
      orderBy: { createdAt: 'desc' },
      // Enough to see what is outstanding and what happened recently, without
      // paginating a screen that holds a dozen rows in a normal clinic.
      take: 100,
    });

    /**
     * `roles` is RLS-exempt, so this filter IS the tenant boundary.
     *
     * A tenant may invite into its own custom roles and into the shared system
     * roles, but never into a PLATFORM-scoped one. SUPER_ADMIN is a system role
     * like any other as far as this table is concerned, and an invitation naming
     * it would hand a clinic administrator the whole platform.
     */
    const roles = await tx.role.findMany({
      where: {
        scopeLevel: { in: ['ORGANIZATION', 'BRANCH'] },
        OR: [{ organizationId: ctx.organizationId }, { organizationId: null, isSystem: true }],
      },
      select: { id: true, code: true, name: true, scopeLevel: true },
      orderBy: [{ isSystem: 'asc' }, { name: 'asc' }],
    });

    return {
      invitations: rows.map(toSummary),
      roles: roles.map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        scopeLevel: role.scopeLevel as 'ORGANIZATION' | 'BRANCH',
      })),
    };
  });
}

export async function createInvitation(
  ctx: TenantContext,
  input: InviteMemberRequest,
  options: InvitationActionOptions = {}
): Promise<InvitationSummary> {
  /**
   * Every branch named must be one this caller already holds.
   *
   * Checked before the transaction opens, not left to the database. The
   * RESTRICTIVE policy on invitation_branches would refuse the write anyway, but
   * as a policy error — and the answer for a branch the caller cannot see must
   * be 404, exactly as it is for reading one (CONVENTIONS.md).
   */
  for (const branchId of input.branchIds) {
    if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
  }

  const now = new Date();
  const token = generateInviteToken();

  const issued = await withTenant(ctx, async (tx) => {
    const role = await tx.role.findFirst({
      // Explicit, because `roles` is RLS-exempt. See listInvitations.
      where: {
        id: input.roleId,
        scopeLevel: { in: ['ORGANIZATION', 'BRANCH'] },
        OR: [{ organizationId: ctx.organizationId }, { organizationId: null, isSystem: true }],
      },
      select: { id: true, name: true, scopeLevel: true },
    });
    // A role belonging to another clinic, or a platform role, is reported as not
    // existing — 403 would confirm which of the two it was.
    if (!role) throw new NotFoundError('Role');

    if (role.scopeLevel === 'ORGANIZATION' && input.branchIds.length > 0) {
      throw new ConflictError(
        `${role.name} applies to the whole organization. Leave the branch list empty.`
      );
    }

    /**
     * An empty branch list grants access to every branch there will ever be
     * (ADR-0002: membership_roles.branch_id NULL means org-wide). Someone whose
     * own access stops at two of five locations must not be able to issue that —
     * it is a privilege escalation dressed up as an omission.
     *
     * 403 rather than 404: nothing is being hidden. The caller already knows
     * their own scope, and "name the branches explicitly" is the only actionable
     * answer available.
     */
    if (input.branchIds.length === 0) {
      const beyondScope = await tx.branch.count({
        where: { deletedAt: null, id: { notIn: ctx.branchIds } },
      });
      if (beyondScope > 0) {
        throw new AuthorizationError(
          'You can only invite people to the branches you manage. Choose them explicitly.'
        );
      }
    }

    // A retired branch lingers in ctx.branchIds until the access cache expires.
    const live = await tx.branch.count({
      where: { id: { in: input.branchIds }, deletedAt: null },
    });
    if (live !== input.branchIds.length) throw new NotFoundError('Branch');

    /*
     * The RESTRICTIVE `designation_visible` policy would refuse an out-of-tenant
     * id anyway, but as a row-level security violation with no field attached —
     * which reaches the caller as a 500. Reading it first turns that into a
     * named 404. RLS has already narrowed this to platform rows plus our own.
     */
    if (input.designationId !== undefined) {
      const designation = await tx.designation.findFirst({
        where: { id: input.designationId, isActive: true, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!designation) throw new NotFoundError('Designation');

      /*
       * A Receptionist is not a Radiologist.
       *
       * Enforced HERE and not only in the menu: the invite form filters the
       * select by the chosen role, but a filtered dropdown is a convenience,
       * not a control — the same request posted directly would sail through.
       *
       * An unmapped title is eligible for everything; see isDesignationEligible.
       */
      if (!(await isDesignationEligible(tx, role.id, designation.id))) {
        throw new ValidationError(
          `“${designation.name}” is not a title for the ${role.name} role.`,
          { designationId: [`Not available for ${role.name}.`] }
        );
      }
    }

    // `users` is RLS-exempt: this reads across every tenant on purpose, because
    // the question is whether this person already has a login anywhere.
    const existingUser = await tx.user.findFirst({
      where: { email: input.email, deletedAt: null },
      select: { id: true },
    });

    if (existingUser) {
      const membership = await tx.membership.findFirst({
        // RLS scopes this to the organization, so no organizationId filter is
        // needed — but deletedAt is, or a removed member could never be re-added.
        where: { userId: existingUser.id, deletedAt: null },
        select: { id: true, status: true },
      });
      if (membership && membership.status !== 'INVITED') {
        throw new ConflictError('That person is already a member of this clinic.');
      }
    }

    const outstanding = await tx.invitation.findFirst({
      where: { email: input.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (outstanding) {
      throw new ConflictError(
        'An invitation is already outstanding for that address. Resend or revoke it first.'
      );
    }

    const created = await tx.invitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: input.email,
        // exactOptionalPropertyTypes: a conditional spread, never `key: undefined`.
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        roleId: role.id,
        ...(input.designationId !== undefined ? { designationId: input.designationId } : {}),
        token: hashInviteToken(token),
        invitedBy: ctx.userId,
        expiresAt: expiryFrom(now),
        ...(input.branchIds.length > 0
          ? { branches: { create: input.branchIds.map((branchId) => ({ branchId })) } }
          : {}),
      },
      select: INVITATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'invitation',
      entityId: created.id,
      after: snapshot(created),
      ...(input.branchIds.length === 1 ? { branchId: input.branchIds[0] } : {}),
      ...options,
    });

    // RLS-exempt, and read inside the transaction only because the send below
    // needs the subdomain to build a link that lands on the right host.
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { slug: true },
    });

    return { summary: toSummary(created), slug: organization.slug };
  });

  // After COMMIT. An invitation email for a row that rolled back is a link that
  // 404s, and there is no way to un-send it.
  await sender.sendEmail(input.email, 'INVITE', {
    link: joinUrl(issued.slug, token),
    expiresInDays: String(INVITE_TTL_DAYS),
  });

  logger.info(
    { organizationId: ctx.organizationId, invitationId: issued.summary.id, roleId: input.roleId },
    'invitation issued'
  );

  return issued.summary;
}

export async function revokeInvitation(
  ctx: TenantContext,
  invitationId: string,
  reason: string | undefined,
  options: InvitationActionOptions = {}
): Promise<InvitationSummary> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.invitation.findFirst({
      where: { id: invitationId },
      select: INVITATION_SELECT,
    });
    // RLS already narrowed to this organization, so "not found" covers another
    // clinic's invitation as well as a bad id.
    if (!before) throw new NotFoundError('Invitation');

    if (before.acceptedAt) {
      throw new ConflictError(
        'That invitation has already been accepted. Remove the member instead.'
      );
    }
    if (before.revokedAt) throw new ConflictError('That invitation was already revoked.');

    const after = await tx.invitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
      select: INVITATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'invitation',
      entityId: invitationId,
      before: snapshot(before),
      after: { ...snapshot(after), ...(reason !== undefined ? { reason } : {}) },
      ...options,
    });

    return toSummary(after);
  });
}

/**
 * Send it again, with a new token.
 *
 * Deliberately not "re-send the same link": the stored digest is overwritten, so
 * the previous token stops working the moment this succeeds. A link that has
 * been sitting in a mailbox for a week — possibly a forwarded one — should not
 * still be live after an administrator decided to reissue it.
 */
export async function resendInvitation(
  ctx: TenantContext,
  invitationId: string,
  options: InvitationActionOptions = {}
): Promise<InvitationSummary> {
  const now = new Date();
  const token = generateInviteToken();

  const reissued = await withTenant(ctx, async (tx) => {
    const before = await tx.invitation.findFirst({
      where: { id: invitationId },
      select: INVITATION_SELECT,
    });
    if (!before) throw new NotFoundError('Invitation');

    if (before.acceptedAt) throw new ConflictError('That invitation has already been accepted.');
    if (before.revokedAt) {
      throw new ConflictError('That invitation was revoked. Issue a new one instead.');
    }

    const after = await tx.invitation.update({
      where: { id: invitationId },
      data: { token: hashInviteToken(token), expiresAt: expiryFrom(now) },
      select: INVITATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'invitation',
      entityId: invitationId,
      // `token` is in the audit helper's REDACTED_KEYS, so the row records that
      // the credential was replaced without recording either value.
      before: { ...snapshot(before), token: 'previous' },
      after: { ...snapshot(after), token: 'reissued' },
      ...options,
    });

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { slug: true },
    });

    return { summary: toSummary(after), slug: organization.slug, email: before.email };
  });

  await sender.sendEmail(reissued.email, 'INVITE_REMINDER', {
    link: joinUrl(reissued.slug, token),
    expiresInDays: String(INVITE_TTL_DAYS),
  });

  return reissued.summary;
}

// ---------------------------------------------------------------------------
// Accepting side: pre-membership, and therefore pre-`withTenant`
// ---------------------------------------------------------------------------

/**
 * Find a live invitation by its token, inside a transaction that has claimed
 * `organizationId` as its tenant.
 *
 * THE HOST IS THE TENANT CHECK, AND IT COSTS NOTHING
 *   `organizationId` comes from the Host header the invitee's browser used. The
 *   transaction adopts it, so tenant_isolation on `invitations` narrows the
 *   lookup to that organization — and an invitation issued by clinic A simply
 *   does not exist at clinic B's subdomain. No comparison in application code
 *   can be forgotten, because there is no comparison in application code.
 *
 *   `userId` is empty because nobody is acting yet: `app_current_user()` coerces
 *   '' to NULL, and no policy on this path reads it. The branch scope is empty
 *   for the same reason — nothing branch-scoped is touched until the caller
 *   re-adopts the context with the invitation's own branches.
 */
async function findLiveInvitation(
  tx: TxClient,
  organizationId: string,
  token: string
): Promise<InvitationRow | null> {
  await setTenantContext(tx, { organizationId, branchIds: [], userId: '' });

  return tx.invitation.findFirst({
    where: {
      token: hashInviteToken(token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: INVITATION_SELECT,
  });
}

/** One answer for every dead token — expired, revoked, replayed or forged. */
function invalidToken(): never {
  throw new NotFoundError('Invitation');
}

/** Fallback when no `staff.employee_code_prefix` is set. Matches the seed. */
const EMPLOYEE_PREFIX_KEY = 'staff.employee_code_prefix';
const DEFAULT_EMPLOYEE_PREFIX = 'EMP';

/**
 * The employment record, filled in the moment someone accepts.
 *
 * Three things land without anybody typing them:
 *
 *   employeeCode  issued from the org-wide EMPLOYEE sequence, prefixed from the
 *                 clinic's own setting. Concurrency-safe and gapless, because
 *                 two people accepting at the same instant is exactly the case
 *                 `issueNumber` exists for.
 *   designationId copied from the invitation — the person who sent it is the
 *                 one who knows the job title, so it is chosen there rather
 *                 than guessed from the role here.
 *   joinedOn      today, IN THE CLINIC'S OWN TIMEZONE.
 *
 * ⚠️ WHY `joinedOn` IS COMPUTED IN POSTGRES AND NOT WITH `new Date()`
 *   The column is a bare `date`, the API container runs UTC, and clinics do
 *   not. Someone accepting at 01:00 IST would be recorded as having joined
 *   YESTERDAY, because 01:00 IST is 19:30 UTC the previous day. That is a
 *   one-day error nobody notices until payroll disagrees with the joining date
 *   on a contract. `(now() AT TIME ZONE o.timezone)::date` asks Postgres what
 *   day it is where the clinic is, which is the only correct question.
 *
 * ⚠️ RE-JOINING KEEPS THE ORIGINAL EMPLOYEE CODE.
 *   The code is how the clinic refers to a person — on a badge, in a rota, in
 *   whatever spreadsheet predates this system. Reissuing it on a second stint
 *   would silently break every one of those references. `joinedOn` DOES move to
 *   the new stint and `relievedOn` is cleared, because that is what re-joining
 *   means.
 */
async function createEmploymentRecord(
  tx: TxClient,
  input: { organizationId: string; membershipId: string; designationId: string | null }
): Promise<{ employeeCode: string | null; joinedOn: string | null }> {
  const existing = await tx.staffProfile.findUnique({
    where: { membershipId: input.membershipId },
    select: { id: true, employeeCode: true, designationId: true },
  });

  /*
   * `organizations` is RLS-EXEMPT, so the explicit `id` is the only isolation
   * on this read. The timezone decides what "today" means, so reading another
   * clinic's row would date this person's employment by the wrong calendar.
   */
  const dateRows = await tx.$queryRaw<{ joined_on: string }[]>`
    SELECT to_char((now() AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS joined_on
    FROM organizations o
    WHERE o.id = ${input.organizationId}::uuid
  `;
  const joinedOn = dateRows[0]?.joined_on;
  // The organization was read moments ago to resolve this invitation, so a
  // missing row here means it was deleted mid-acceptance. Refusing is right:
  // the alternative is dating the record from the server's own calendar.
  if (joinedOn === undefined) invalidToken();

  const ctx: TenantContext = {
    organizationId: input.organizationId,
    branchIds: [],
    userId: '',
  };

  let employeeCode = existing?.employeeCode ?? null;

  if (employeeCode === null) {
    const settings = await resolveSettings(tx, [EMPLOYEE_PREFIX_KEY], {
      organizationId: input.organizationId,
    });
    const resolved = settings.get(EMPLOYEE_PREFIX_KEY);
    const prefix =
      typeof resolved === 'string' && resolved !== '' ? resolved : DEFAULT_EMPLOYEE_PREFIX;

    /*
     * Org-wide (no branchId): a staff profile keys on membership, which is
     * organization-level, so one person has one code across every branch they
     * work at. Issued last, so the row lock it takes is held for one statement
     * rather than the width of the whole acceptance.
     */
    const issued = await issueNumber(tx, ctx, {
      type: 'EMPLOYEE',
      prefix,
      padding: 4,
    });
    employeeCode = issued.formatted;
  }

  const data = {
    employeeCode,
    joinedOn: new Date(`${joinedOn}T00:00:00.000Z`),
    relievedOn: null,
    // Never clobber a designation an admin has already refined by hand; the
    // invitation only fills a blank.
    ...(existing?.designationId == null && input.designationId !== null
      ? { designationId: input.designationId }
      : {}),
  };

  if (existing) {
    await tx.staffProfile.update({ where: { id: existing.id }, data });
  } else {
    await tx.staffProfile.create({ data: { membershipId: input.membershipId, ...data } });
  }

  return { employeeCode, joinedOn };
}

export async function previewInvitation(
  organizationId: string,
  token: string
): Promise<InvitationPreview> {
  const db = unsafeDbClient();

  return db.$transaction(async (tx) => {
    const invitation = await findLiveInvitation(tx, organizationId, token);
    if (!invitation) invalidToken();

    // Both RLS-exempt, both filtered explicitly.
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { displayName: true },
    });
    const user = await tx.user.findFirst({
      where: { email: invitation.email, deletedAt: null },
      select: { id: true },
    });

    return {
      organizationName: organization.displayName,
      email: invitation.email,
      roleName: invitation.role.name,
      branchNames: invitation.branches.map((b) => b.branch.name),
      // Decides whether the page asks for a name and a NEW password or for the
      // EXISTING one. Both paths ask for a password; only one creates an account.
      needsAccount: user === null,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  });
}

export interface AcceptInvitationInput {
  token: string;
  fullName?: string | undefined;
  password: string;
}

export interface AcceptInvitationResult {
  userId: string;
  organizationId: string;
  membershipId: string;
  /** True when this call created the account, which is what mints a session. */
  isNewUser: boolean;
}

/**
 * Accept an invitation.
 *
 * WHY THIS USES @rcln/db/unsafe
 *   The same reason register.service.ts does. There is no membership yet — that
 *   is what this function creates — so there is no `ctx.branchIds` to scope by
 *   and no membership for a policy to check against. `withTenant()` needs a
 *   context that only exists once the work below has run.
 *
 *   `unsafeDbClient()` is NOT privileged. It is the same rcln_app connection
 *   with NOBYPASSRLS; it merely skips setting the session variables. So the rows
 *   split across that line exactly as they do at registration:
 *     RLS-exempt   users
 *     RLS-enforced invitations, memberships, membership_roles, audit_logs
 *   and an unscoped insert of the second group fails closed.
 *
 * THE RESOLUTION
 *   `setTenantContext()` twice, both transaction-local. First with the
 *   organization from the Host header and no branch scope, which is enough to
 *   read the invitation and is what enforces "clinic A's invitation is not
 *   acceptable at clinic B". Then again once the invitation is known, with its
 *   branches in scope — membership_roles carries the RESTRICTIVE
 *   branch_isolation policy, and without the scope the insert affects zero rows
 *   rather than raising.
 *
 *   Do NOT reach for `withUserIdentity()` here. It reads your own `memberships`
 *   rows and nothing else, and ADR-0011 names misuse of it as the failure mode.
 *
 * REPLAY
 *   Consumption is a compare-and-set: the UPDATE requires `accepted_at IS NULL`
 *   and its row count is checked. Two clicks on the same link land one
 *   membership.
 *
 * WHY IT IS TWO TRANSACTIONS AND NOT ONE
 *   Deciding which path applies needs a database read; both paths then need
 *   argon2, which is deliberately slow and must not run with a pooled connection
 *   held open (register.service.ts hashes outside its transaction for the same
 *   reason). So: read, then hash or verify, then write. Nothing rides on the two
 *   halves being atomic, because the compare-and-set above is what actually
 *   decides whether this acceptance is the one that counts.
 */
export async function acceptInvitation(
  organizationId: string,
  input: AcceptInvitationInput,
  options: InvitationActionOptions = {}
): Promise<AcceptInvitationResult> {
  const db = unsafeDbClient();

  // -- Phase 1: which path is this? Read-only. -------------------------------
  const found = await db.$transaction(async (tx) => {
    const invitation = await findLiveInvitation(tx, organizationId, input.token);
    if (!invitation) invalidToken();

    // `users` is RLS-exempt; this filter is the boundary.
    const existing = await tx.user.findFirst({
      where: { email: invitation.email, deletedAt: null },
      select: { id: true, status: true },
    });

    return { email: invitation.email, existing };
  });

  // -- Phase 2: establish who is accepting, outside any transaction. ---------
  let userId: string;
  let passwordHash: string | null = null;

  if (found.existing) {
    if (found.existing.status === 'SUSPENDED') {
      throw new AuthorizationError('That account is suspended.');
    }

    /**
     * The invited address already has a login, so the password is CHECKED, never
     * set. Honouring a new one would turn a forwarded invitation link into a
     * password reset for an account that has nothing to do with this clinic.
     *
     * `verifyCredentials` rather than a bare hash comparison: it carries the
     * failed-attempt counter, the lockout window and the constant-time behaviour
     * that make the login endpoint safe, and this endpoint accepts exactly the
     * same credential. A second, weaker copy of that logic is how one of them
     * ends up wrong.
     */
    userId = await verifyCredentials(found.email, input.password);
  } else {
    if (!input.fullName) {
      throw new ConflictError('Choose a name to finish setting up your account.');
    }

    /**
     * The strength rules apply here and only here — this password is being
     * chosen. The contract deliberately does not enforce them, because the same
     * field carries an existing password on the other path; see acceptInviteRequest.
     */
    const strong = password.safeParse(input.password);
    if (!strong.success) {
      throw new ValidationError('Choose a stronger password.', {
        password: strong.error.issues.map((issue) => issue.message),
      });
    }

    userId = randomUUID();
    passwordHash = await hashPassword(input.password);
  }

  const isNewUser = found.existing === null;

  // -- Phase 3: create the account if needed, and the membership. ------------
  const result = await db.$transaction(async (tx) => {
    const invitation = await findLiveInvitation(tx, organizationId, input.token);
    // Revoked or accepted between the two reads. Rare, and the same answer.
    if (!invitation) invalidToken();

    const now = new Date();
    const branchIds = invitation.branches.map((b) => b.branch.id);

    if (isNewUser) {
      /**
       * `users.phone` is globally unique, and the invitation's phone is whatever
       * an administrator typed. Claiming a number another account already holds
       * would abort the transaction on a constraint violation, which the invitee
       * would see as a 500 for a field they never entered. Leave it unset
       * instead; phone verification is where a number gets claimed properly.
       */
      const phoneTaken = invitation.phone
        ? await tx.user.count({ where: { phone: invitation.phone } })
        : 1;

      await tx.user.create({
        data: {
          id: userId,
          email: invitation.email,
          fullName: input.fullName as string,
          passwordHash,
          status: 'ACTIVE',
          // Holding the token proves control of the mailbox it was sent to,
          // which is exactly what email verification asserts.
          emailVerifiedAt: now,
          ...(invitation.phone !== null && phoneTaken === 0 ? { phone: invitation.phone } : {}),
        },
      });
    }

    // -- Adopt the tenant WITH the branch scope for the writes below. --------
    await setTenantContext(tx, { organizationId, branchIds, userId });

    /**
     * Consume the invitation first and let the compare-and-set decide.
     *
     * `updateMany` rather than `update`: it returns a count instead of throwing,
     * so a token accepted a millisecond ago by a concurrent request is a clean
     * zero rather than a race that produces two memberships.
     */
    const consumed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (consumed.count !== 1) invalidToken();

    /**
     * A membership may already exist in INVITED state, or as a soft-deleted one
     * from a previous stint — `@@unique([userId, organizationId])` means there is
     * at most one ever, so re-joining has to land on that row rather than insert.
     */
    const prior = await tx.membership.findFirst({
      where: { userId },
      select: { id: true, status: true, deletedAt: true },
    });

    if (prior && prior.status === 'ACTIVE' && prior.deletedAt === null) {
      throw new ConflictError('You are already a member of this clinic.');
    }

    const membership = prior
      ? await tx.membership.update({
          where: { id: prior.id },
          data: {
            status: 'ACTIVE',
            joinedAt: now,
            deletedAt: null,
            invitedBy: invitation.invitedBy,
          },
          select: { id: true },
        })
      : await tx.membership.create({
          data: {
            userId,
            organizationId,
            status: 'ACTIVE',
            invitedBy: invitation.invitedBy,
            joinedAt: now,
          },
          select: { id: true },
        });

    /**
     * One row per branch, or a single row with branchId null for an org-wide
     * grant. This is the whole of the `branchIds` contract, and the NULL case is
     * permitted by branch_isolation whatever is in scope (ADR-0002).
     */
    await tx.membershipRole.createMany({
      data:
        branchIds.length > 0
          ? branchIds.map((branchId) => ({
              membershipId: membership.id,
              organizationId,
              roleId: invitation.roleId,
              branchId,
            }))
          : [
              {
                membershipId: membership.id,
                organizationId,
                roleId: invitation.roleId,
                branchId: null,
              },
            ],
      // A re-joined membership may already carry the role from before; the
      // unique is (membershipId, roleId, branchId).
      skipDuplicates: true,
    });

    const employmentRecord = await createEmploymentRecord(tx, {
      organizationId,
      membershipId: membership.id,
      designationId: invitation.designationId,
    });

    await recordAudit(
      tx,
      { organizationId, branchIds, userId },
      {
        action: 'CREATE',
        entityType: 'membership',
        entityId: membership.id,
        // Ids and flags. The invitee's name and email are already in `users`;
        // an audit row is not a place to re-store them.
        after: {
          invitationId: invitation.id,
          roleId: invitation.roleId,
          branchIds: [...branchIds].sort(),
          isNewUser,
          // Ids and a code, never the person's name or title text.
          employeeCode: employmentRecord.employeeCode,
          designationId: invitation.designationId,
          joinedOn: employmentRecord.joinedOn,
        },
        ...(branchIds.length === 1 ? { branchId: branchIds[0] } : {}),
        ...options,
      }
    );

    return { userId, organizationId, membershipId: membership.id, isNewUser };
  });

  /**
   * Mandatory, and after COMMIT.
   *
   * `loadUserAccess` caches the membership, roles and derived branchIds in Redis
   * for 60 seconds — including the negative answer from before this membership
   * existed. Without this the new member signs in and is told their credentials
   * are not valid, for up to a minute, with nothing in any log to explain it.
   */
  await invalidateUserAccess(result.userId, organizationId);

  logger.info(
    { organizationId, membershipId: result.membershipId, isNewUser: result.isNewUser },
    'invitation accepted'
  );

  return result;
}
