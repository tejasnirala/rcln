import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { AuthenticationError } from '../../utils/errors.js';
import { generateRefreshToken, hashRefreshToken } from './token.service.js';

/**
 * Session lifecycle: create, rotate, revoke.
 *
 * `sessions` is deliberately outside RLS (see the exemption manifest in
 * packages/db/prisma/rls/enable-rls.sql): a refresh happens BEFORE a tenant
 * context exists, because the session row is what tells us which tenant the
 * caller is in. Scoping it by organization would be circular in exactly the way
 * `organization_domains` is. `unsafeDbClient()` is therefore correct here rather
 * than a shortcut — every lookup is by the unique hash of a 256-bit secret, so
 * there is nothing to enumerate.
 *
 * REFRESH ROTATION AND REUSE DETECTION
 *   Every refresh issues a new token and moves the old hash to
 *   `previous_token_hash`. A legitimate client only ever holds the newest token.
 *
 *   So if someone presents a token matching `previous_token_hash`, exactly one
 *   of two things happened: an attacker stole a token and is now replaying it
 *   after the real client already rotated, or the real client is replaying after
 *   an attacker rotated. Both mean the token leaked, and we cannot tell which
 *   party is which — so the only safe response is to revoke the entire family
 *   and make both re-authenticate.
 */

const REFRESH_TTL_DAYS = 30;

/**
 * The hard ceiling on an impersonation session, measured from when it started.
 *
 * WHY A SECOND KIND OF EXPIRY EXISTS AT ALL
 *   `expires_at` is a SLIDING window: `rotateRefreshToken` pushes it forward on
 *   every refresh. That is right for an ordinary session — someone using the
 *   product should not be signed out mid-sentence — and it is exactly wrong as
 *   the only bound on a super admin standing inside a clinic, because a tab left
 *   open would renew itself indefinitely.
 *
 *   So an impersonation session has two deadlines. `expires_at` is the idle
 *   timeout: stop working for half an hour and it is over. This is the absolute
 *   one: eight hours after it began it ends, however busy the admin has been.
 *
 *   Derived from `sessions.created_at` rather than stored in its own column,
 *   because it is a constant of the session type and not a property of the row —
 *   a stored copy could disagree with the constant, and only one of the two would
 *   be enforced.
 *
 * A WORKING DAY, DELIBERATELY. Long enough that nobody is interrupted while
 * fixing something; short enough that it cannot become how someone works.
 * ADR-0012 records why this replaced a flat thirty minutes with no renewal.
 */
export const IMPERSONATION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;

/**
 * The idle window for an impersonation session: stop working for this long and it
 * is over, whatever the ceiling says.
 *
 * HERE, not in impersonation.service.ts, because two places need the same number —
 * `createSession` sets it and `rotateRefreshToken` re-applies it. It previously
 * lived only in the service that creates the session, and the refresh path
 * therefore never knew about it: the window was applied once and then replaced by
 * the ordinary thirty-day slide on the first renewal. See `rotateRefreshToken`.
 */
export const IMPERSONATION_IDLE_TTL_SECONDS = 30 * 60;

/** When an impersonation session that started at `startedAt` must end. */
export function impersonationDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + IMPERSONATION_ABSOLUTE_TTL_SECONDS * 1000);
}

export interface SessionRecord {
  id: string;
  userId: string;
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  impersonatedByUserId: string | null;
  /**
   * The idle timeout, and a SLIDING one — `rotateRefreshToken` pushes it forward
   * on every refresh. Thirty days for an ordinary session, thirty minutes for an
   * impersonation.
   *
   * For an impersonation this is NOT the last word: see
   * `IMPERSONATION_ABSOLUTE_TTL_SECONDS`, which bounds it from `createdAt`.
   */
  expiresAt: Date;
  /** When the session began. The anchor for the impersonation ceiling. */
  createdAt: Date;
}

export interface IssuedSession extends SessionRecord {
  /** Plaintext, returned to the caller exactly once. Never stored, never logged. */
  refreshToken: string;
}

function expiryDate(): Date {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface CreateSessionInput {
  userId: string;
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  impersonatedByUserId?: string | null;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /**
   * Override the 30-day default. An impersonation session gets thirty MINUTES as
   * its idle window, on top of the absolute ceiling `rotateRefreshToken` applies
   * — see `IMPERSONATION_ABSOLUTE_TTL_SECONDS` and impersonation.service.ts.
   */
  expiresAt?: Date | undefined;
}

export async function createSession(input: CreateSessionInput): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const db = unsafeDbClient();

  const session = await db.session.create({
    data: {
      userId: input.userId,
      activeOrganizationId: input.activeOrganizationId,
      activeBranchId: input.activeBranchId,
      impersonatedByUserId: input.impersonatedByUserId ?? null,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: input.expiresAt ?? expiryDate(),
      // exactOptionalPropertyTypes: an explicit `undefined` is not assignable,
      // so absent values must be omitted from the object entirely.
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent.slice(0, 512) } : {}),
    },
    select: {
      id: true,
      userId: true,
      activeOrganizationId: true,
      activeBranchId: true,
      impersonatedByUserId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return { ...session, refreshToken };
}

/** Load a live session by id. Returns null if revoked, expired or absent. */
export async function findLiveSession(sessionId: string): Promise<SessionRecord | null> {
  const db = unsafeDbClient();

  return db.session.findFirst({
    where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      userId: true,
      activeOrganizationId: true,
      activeBranchId: true,
      impersonatedByUserId: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

/**
 * Exchange a refresh token for a new one.
 *
 * Throws `AuthenticationError` on anything suspicious, having first revoked the
 * family when the token was a rotated one.
 */
export async function rotateRefreshToken(presentedToken: string): Promise<IssuedSession> {
  const db = unsafeDbClient();
  const presentedHash = hashRefreshToken(presentedToken);

  // The theft check comes first and is deliberately a separate query: a token
  // that matches `previous_token_hash` will never match `refresh_token_hash`,
  // so a single lookup would just report "unknown token" and lose the signal.
  const replayed = await db.session.findFirst({
    where: { previousTokenHash: presentedHash, revokedAt: null },
    select: { id: true, userId: true },
  });

  if (replayed) {
    await revokeFamily(replayed.userId);
    logger.warn(
      { userId: replayed.userId, sessionId: replayed.id },
      'refresh token reuse detected — all sessions revoked'
    );
    throw new AuthenticationError('Session expired. Please sign in again.');
  }

  const session = await db.session.findFirst({
    where: { refreshTokenHash: presentedHash, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      userId: true,
      activeOrganizationId: true,
      activeBranchId: true,
      impersonatedByUserId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  if (!session) {
    throw new AuthenticationError('Session expired. Please sign in again.');
  }

  /*
   * BOTH DEADLINES, RE-APPLIED. An impersonation session renews like any other,
   * but its idle window is thirty minutes rather than thirty days, and it can
   * never pass eight hours from when it started.
   *
   * This is the one function that moves expiry forward, so it is the one place
   * either bound can be enforced. That cuts both ways, and the first version of
   * this clamp got it wrong in a way worth recording:
   *
   *   It took `min(ceiling, expiryDate())`. But `expiryDate()` is unconditionally
   *   `now + 30 days`, so for an impersonation session the minimum was ALWAYS the
   *   ceiling — `created_at + 8h` is earlier than `now + 30d` for the session's
   *   whole life. The thirty-minute idle window was applied once, by
   *   `createSession`, and then silently discarded by the first refresh. An
   *   abandoned session held full access to a clinic's records for eight hours
   *   instead of dying half an hour after last use, which is precisely the
   *   exposure the ceiling was added to bound.
   *
   * So the SLIDING term is what varies by session type; the ceiling only trims it.
   * The idle constant lives in this file rather than in impersonation.service.ts
   * because both the create path and this one have to read the same number — them
   * living in different modules is how the two drifted apart.
   *
   * Once `now` passes the ceiling the clamped `expires_at` is already in the past,
   * so the `expiresAt: { gt: new Date() }` filter above stops matching and the
   * session is simply gone — the same answer as any other expired session.
   */
  const impersonating = session.impersonatedByUserId !== null;

  const slidingMs = impersonating
    ? IMPERSONATION_IDLE_TTL_SECONDS * 1000
    : REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

  const ceilingMs = impersonating
    ? impersonationDeadline(session.createdAt).getTime()
    : Number.POSITIVE_INFINITY;

  const nextExpiry = new Date(Math.min(Date.now() + slidingMs, ceilingMs));

  const nextToken = generateRefreshToken();

  await db.session.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hashRefreshToken(nextToken),
      previousTokenHash: presentedHash,
      lastUsedAt: new Date(),
      expiresAt: nextExpiry,
    },
  });

  return { ...session, refreshToken: nextToken };
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = unsafeDbClient();
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Every live session for one user. The response to a suspected token theft. */
export async function revokeFamily(userId: string): Promise<void> {
  const db = unsafeDbClient();
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Point a session at a different branch or organization.
 *
 * Branch switching is an UPDATE here plus a re-issued access token — never a
 * re-login. The `Session` model doc comment in schema.prisma says so, and the
 * refresh token deliberately survives the switch so the user is not logged out
 * of a tab they left open.
 */
export async function setActiveScope(
  sessionId: string,
  organizationId: string | null,
  branchId: string | null
): Promise<void> {
  const db = unsafeDbClient();
  await db.session.update({
    where: { id: sessionId },
    data: {
      activeOrganizationId: organizationId,
      activeBranchId: branchId,
      lastUsedAt: new Date(),
    },
  });
}

/** Cookie/expiry hint for the web BFF. */
export const refreshTokenMaxAgeSeconds = REFRESH_TTL_DAYS * 24 * 60 * 60;

/** Kept for symmetry with config; the TTL is not currently env-tunable. */
export const refreshTokenTtlSetting = config.jwt.refreshTokenExpiresIn;
