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

export interface SessionRecord {
  id: string;
  userId: string;
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  impersonatedByUserId: string | null;
  /**
   * The hard stop. Thirty days for an ordinary session; thirty MINUTES for an
   * impersonation, which is the only thing bounding it — there is no refresh
   * token to rotate and therefore nothing to revoke on rotation.
   */
  expiresAt: Date;
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
   * Override the 30-day default. An impersonation session gets ~30 MINUTES and
   * is never rotated, so this column is its only hard stop — see
   * impersonation.service.ts.
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
    },
  });

  if (!session) {
    throw new AuthenticationError('Session expired. Please sign in again.');
  }

  const nextToken = generateRefreshToken();

  await db.session.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hashRefreshToken(nextToken),
      previousTokenHash: presentedHash,
      lastUsedAt: new Date(),
      expiresAt: expiryDate(),
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
