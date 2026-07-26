import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TenantContext } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import type { AuthSession, ImpersonationGrant } from '@rcln/contracts';
import { recordAudit } from '../audit/audit.service.js';
import { organizationBranchIds } from '../auth/access.service.js';
import {
  describeSession,
  loadAuthenticatedUser,
  type ImpersonationDescriptor,
} from '../auth/login.service.js';
import { createSession, revokeSession } from '../auth/session.service.js';
import { signAccessToken } from '../auth/token.service.js';
import { redis } from '../../utils/redis.js';
import { logger } from '../../utils/logger.js';
import { AuthenticationError, NotFoundError } from '../../utils/errors.js';

/**
 * A super admin entering a clinic.
 *
 * WHAT THIS IS ALLOWED TO DO — ADR-0012
 *   Everything. Read, write, delete, exactly as an owner could. There is no
 *   elevation step and no write block, because a support engineer who can look
 *   but not fix has to talk somebody through the fix over the phone, and the
 *   read they took to diagnose it went unrecorded anyway. The control is not the
 *   permission model — `authorize()` bypasses for a platform admin and always
 *   has. The control is that every mutation writes an audit row naming both the
 *   clinic's actor and the real admin behind it, and that entering at all
 *   requires a reason and lands in the clinic's own audit trail.
 *
 * WHY THIS IS TWO STEPS AND NOT ONE
 *   Session cookies are host-only by design (apps/web/src/lib/session.ts) — that
 *   is the isolation boundary that makes a session at alpha.rcln.com useless at
 *   beta.rcln.com. So `admin.<root>` CANNOT write a cookie for a clinic's
 *   subdomain, and there is no version of "mint the session on the admin host"
 *   that ends with the browser holding it.
 *
 *   Something has to cross the host boundary. It is a HANDOFF TICKET: 256 random
 *   bits, held in Redis under its own SHA-256 digest for two minutes, spent
 *   exactly once, and redeemable only at the clinic it names. The browser
 *   carries it in a POST body — never a URL, for the same reason invitation
 *   tokens are not in URLs. The session itself is minted at `claim`, on the
 *   clinic's host, by the request that is about to be given the cookie.
 *
 *   Redis and not `auth_tokens`: a two-minute machine-to-machine ticket is
 *   ephemeral state, not a record. The record is the audit row.
 *
 * WHO THE SESSION ACTS AS
 *   The admin, as themselves. `Session.userId` is the admin and
 *   `Session.impersonatedByUserId` is the admin as well — the second is what
 *   MARKS the session as an impersonation, which is what the banner, the branch
 *   scope in `authenticate`, and `recordAudit` all key on.
 *
 *   Deliberately not "act as the owner". Attributing a write to a real clinic
 *   employee who did not make it puts their name on a change in a system of
 *   record for patient care; the audit row's `impersonated_by_user_id` would
 *   disambiguate it, but only for someone who thought to look.
 *
 * NO REFRESH TOKEN LEAVES THIS FILE
 *   A row in `sessions` needs a `refresh_token_hash`, so one is generated and
 *   immediately discarded. Nothing can rotate this session, `expires_at` is
 *   thirty minutes out, and the access token is signed to match — so the window
 *   closes on its own whether or not anyone remembers to stop.
 */

/** The session's whole life. Long enough to fix something, short enough to end. */
const SESSION_TTL_SECONDS = 30 * 60;

/** The ticket's life. A browser form post, not a coffee break. */
const HANDOFF_TTL_SECONDS = 120;

const handoffKey = (token: string): string =>
  `imp:${createHash('sha256').update(token).digest('hex')}`;

interface HandoffPayload {
  organizationId: string;
  adminUserId: string;
  reason: string;
}

export interface StartImpersonationInput {
  organizationId: string;
  adminUserId: string;
  reason: string;
}

/**
 * Step one, on `admin.<root>`: check the clinic exists and issue the ticket.
 *
 * `unsafeDbClient` is correct here for the same reason it is correct everywhere
 * else on the platform router — this read spans every tenant, so there is no
 * single organization to scope it to. Nothing is written.
 */
export async function startImpersonation(
  input: StartImpersonationInput
): Promise<ImpersonationGrant> {
  const organization = await unsafeDbClient().organization.findFirst({
    where: { id: input.organizationId, deletedAt: null },
    select: { id: true, slug: true, displayName: true },
  });

  // 404 rather than a message about deletion: the platform console is gated on
  // the flag, but an id that resolves is still an id that resolves.
  if (!organization) throw new NotFoundError('Organization not found');

  const handoffToken = randomBytes(32).toString('base64url');
  const payload: HandoffPayload = {
    organizationId: organization.id,
    adminUserId: input.adminUserId,
    reason: input.reason,
  };

  await redis.setex(handoffKey(handoffToken), HANDOFF_TTL_SECONDS, JSON.stringify(payload));

  // The audit row is written when the ticket is REDEEMED, because that is when
  // somebody is actually inside the clinic. This line is the record that it was
  // asked for — an unredeemed ticket leaves no other trace.
  logger.warn(
    { adminUserId: input.adminUserId, organizationId: organization.id, reason: input.reason },
    'impersonation ticket issued'
  );

  return {
    organizationSlug: organization.slug,
    organizationName: organization.displayName,
    handoffToken,
    expiresInSeconds: HANDOFF_TTL_SECONDS,
  };
}

export interface ClaimImpersonationInput {
  /** From the Host header, via `resolveTenant`. NOT from the request body. */
  organizationId: string;
  handoffToken: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Step two, on the clinic's own host: spend the ticket and mint the session.
 *
 * Every failure is the same `AuthenticationError`. A ticket that has expired, a
 * ticket already spent, and a ticket for a different clinic are indistinguishable
 * from the outside — this endpoint is unauthenticated, so it must not become an
 * oracle for whether an admin is currently working somewhere.
 */
export async function claimImpersonation(input: ClaimImpersonationInput): Promise<AuthSession> {
  const INVALID = 'That link is no longer valid. Start again from the console.';

  /*
   * GETDEL, so redemption is atomic. Two tabs racing the same ticket must not
   * both end up with a session; the loser gets `null` and the message above.
   */
  const raw = await redis.getdel(handoffKey(input.handoffToken));
  if (!raw) throw new AuthenticationError(INVALID);

  const payload = JSON.parse(raw) as HandoffPayload;

  /*
   * THE CROSS-HOST CHECK.
   *
   * The organization id on the left came from the Host header before any
   * credential was read; the one on the right was fixed when the ticket was
   * issued. A ticket for clinic A posted at clinic B's subdomain fails here —
   * and it has already been consumed by the GETDEL above, so replaying it at the
   * right host does not work either.
   */
  if (payload.organizationId !== input.organizationId) {
    logger.warn(
      {
        adminUserId: payload.adminUserId,
        ticketOrganizationId: payload.organizationId,
        hostOrganizationId: input.organizationId,
      },
      'impersonation ticket presented at the wrong tenant'
    );
    throw new AuthenticationError(INVALID);
  }

  const admin = await loadAuthenticatedUser(payload.adminUserId);

  // Re-checked at redemption, not trusted from the ticket. The flag can be
  // withdrawn in the two minutes between issuing and spending, and this is the
  // only moment between then and a live session in a clinic.
  if (!admin.isPlatformAdmin) {
    logger.warn({ userId: admin.id }, 'impersonation ticket redeemed without the platform flag');
    throw new AuthenticationError(INVALID);
  }

  const organization = await unsafeDbClient().organization.findFirst({
    where: { id: input.organizationId, deletedAt: null },
    select: { id: true, displayName: true },
  });
  if (!organization) throw new AuthenticationError(INVALID);

  // Full reach across the clinic, primary branch first — see the note on
  // `organizationBranchIds` for why an empty scope would present as an empty
  // clinic rather than as full access.
  const branchIds = await organizationBranchIds(organization.id, admin.id);
  const activeBranchId = branchIds[0] ?? null;

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  const session = await createSession({
    userId: admin.id,
    activeOrganizationId: organization.id,
    activeBranchId,
    // Both the marker and the record of who. See the header.
    impersonatedByUserId: admin.id,
    expiresAt,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  const accessToken = signAccessToken(
    {
      userId: admin.id,
      sessionId: session.id,
      isPlatformAdmin: true,
      // No membership here, which is the whole point.
      membershipId: null,
      organizationId: organization.id,
      branchId: activeBranchId,
      impersonatedByUserId: admin.id,
    },
    // Signed to the SESSION's life, not the usual fifteen minutes: there is no
    // refresh token, so a shorter token would end the session early.
    SESSION_TTL_SECONDS
  );

  /*
   * The audit row lands in the CLINIC's trail, not the platform's, because the
   * clinic is who needs to be able to see it. `withTenant` also sets
   * `app.impersonator`, so anything else this transaction touched would carry it.
   */
  const ctx: TenantContext = {
    organizationId: organization.id,
    branchIds,
    userId: admin.id,
    impersonatedByUserId: admin.id,
  };

  await withTenant(ctx, (tx) =>
    recordAudit(tx, ctx, {
      action: 'IMPERSONATE',
      entityType: 'session',
      entityId: session.id,
      // A create, so there is no `before` to diff against and the whole snapshot
      // is kept. The reason is the point of the row.
      after: {
        reason: payload.reason,
        organizationId: organization.id,
        expiresAt: expiresAt.toISOString(),
      },
      ...(activeBranchId !== null ? { branchId: activeBranchId } : {}),
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    })
  );

  logger.warn(
    { adminUserId: admin.id, organizationId: organization.id, sessionId: session.id },
    'impersonation session started'
  );

  /*
   * Assembled by `describeSession` like every other session response, so the two
   * cannot drift — including `permissions`, which comes out as the whole
   * catalogue because `effectivePermissions` bypasses for a platform admin the
   * way `can` always has. `memberships` is the admin's OWN, which is what that
   * field means everywhere else and is almost always empty; the shell's branch
   * switcher is therefore absent under impersonation and the banner names the
   * branch instead.
   */
  const described = await describeSession(
    admin.id,
    organization.id,
    activeBranchId,
    {
      accessToken,
      /*
       * Empty, deliberately, and the web BFF is written to skip writing an empty
       * one (lib/session.ts). Nothing can renew this session: thirty minutes in,
       * `findLiveSession` stops returning it and the access token expires in the
       * same breath.
       */
      refreshToken: '',
    },
    { organizationName: organization.displayName, adminName: admin.fullName, expiresAt }
  );

  // `describeSession` reports the CONFIGURED access-token life; this token was
  // signed to the session's instead.
  return { ...described, expiresIn: SESSION_TTL_SECONDS };
}

/**
 * The banner's content, for the endpoints that re-describe an existing session.
 *
 * Returns null for an ordinary session, so a caller can hand it straight to
 * `describeSession` without branching.
 */
export async function describeImpersonation(
  organizationId: string | null,
  impersonatedByUserId: string | null,
  expiresAt: Date
): Promise<ImpersonationDescriptor | null> {
  if (!organizationId || !impersonatedByUserId) return null;

  const db = unsafeDbClient();
  const [organization, admin] = await Promise.all([
    db.organization.findFirst({ where: { id: organizationId }, select: { displayName: true } }),
    db.user.findUnique({ where: { id: impersonatedByUserId }, select: { fullName: true } }),
  ]);

  if (!organization || !admin) return null;

  return { organizationName: organization.displayName, adminName: admin.fullName, expiresAt };
}

/**
 * End it, from inside the clinic.
 *
 * Revoking the session is what actually ends it — the cookie is cleared by the
 * web, but a cookie the browser has thrown away is still a live session to
 * anyone who captured the token. The audit row closes the pair opened by
 * `claimImpersonation`, so the clinic's trail shows both ends of the visit.
 */
export interface StopImpersonationInput {
  sessionId: string;
  organizationId: string;
  adminUserId: string;
  branchId: string | null;
  branchIds: string[];
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export async function stopImpersonation(input: StopImpersonationInput): Promise<void> {
  await revokeSession(input.sessionId);

  const ctx: TenantContext = {
    organizationId: input.organizationId,
    branchIds: input.branchIds,
    userId: input.adminUserId,
    impersonatedByUserId: input.adminUserId,
  };

  await withTenant(ctx, (tx) =>
    recordAudit(tx, ctx, {
      action: 'IMPERSONATE',
      entityType: 'session',
      entityId: input.sessionId,
      // A delete-shaped row: the session that existed no longer does.
      before: { impersonating: true },
      ...(input.branchId !== null ? { branchId: input.branchId } : {}),
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    })
  );

  logger.warn(
    { adminUserId: input.adminUserId, organizationId: input.organizationId },
    'impersonation session ended'
  );
}
