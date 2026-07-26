import { unsafeDbClient } from '@rcln/db/unsafe';
import { withTenant } from '@rcln/db';
import type { AuthSession } from '@rcln/contracts';
import { ALL_PERMISSIONS } from '@rcln/permissions';
import { AuthenticationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  fakeVerify,
  isLockedOut,
  lockoutUntil,
  verifyPassword,
  MAX_FAILED_ATTEMPTS,
} from './password.service.js';
import { accessTokenLifetimeSeconds, signAccessToken } from './token.service.js';
import { createSession, type IssuedSession } from './session.service.js';
import { listMemberships, loadUserAccess, permissionsFor } from './access.service.js';

/**
 * Everything between "correct credentials" and a usable session.
 *
 * `users` and `sessions` are RLS-exempt (see the manifest in enable-rls.sql):
 * login happens before a tenant context exists, because which organizations you
 * belong to is one of the things logging in tells you. Hence the unscoped
 * client. Anything that reads a tenant's own rows still goes through withTenant.
 */

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
  /**
   * Derived from `emailVerifiedAt` / `phoneVerifiedAt`, and flattened to
   * booleans here because that is the whole of what a client may do with them —
   * the shell decides whether to prompt. The timestamps stay on the row for the
   * audit trail. Kept in step with `authSession.user`, which this shape is
   * returned as verbatim by `describeSession`.
   */
  emailVerified: boolean;
  phoneVerified: boolean;
}

/**
 * One message for every failure.
 *
 * "No such user" and "wrong password" must be indistinguishable, in wording and
 * in timing, or the endpoint becomes a way to ask whether a given doctor has an
 * account here. See `fakeVerify` for the timing half.
 */
const INVALID_CREDENTIALS = 'Those credentials are not valid.';

export async function findUserByIdentifier(identifier: string): Promise<{
  id: string;
  passwordHash: string | null;
  status: string;
  failedAttempts: number;
  lockedUntil: Date | null;
} | null> {
  const db = unsafeDbClient();

  // The contract accepts an email or an E.164 phone; both columns are globally
  // unique, so one OR resolves either without knowing which was typed.
  return db.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: identifier }, { phone: identifier }],
    },
    select: {
      id: true,
      passwordHash: true,
      status: true,
      failedAttempts: true,
      lockedUntil: true,
    },
  });
}

/**
 * Verify a password, applying and maintaining the lockout counter.
 *
 * Returns the user id. Throws `AuthenticationError` for every failure mode,
 * always with the same message.
 */
export async function verifyCredentials(identifier: string, password: string): Promise<string> {
  const db = unsafeDbClient();
  const user = await findUserByIdentifier(identifier);

  if (!user || !user.passwordHash) {
    // Burn comparable work so an absent account is not the fast path.
    await fakeVerify(password);
    throw new AuthenticationError(INVALID_CREDENTIALS);
  }

  if (isLockedOut(user.lockedUntil)) {
    // Distinct message: this one is safe, because reaching it already required
    // enough correct-shaped attempts that enumeration is not the concern.
    throw new AuthenticationError(
      'Too many failed attempts. This account is locked for a few minutes.'
    );
  }

  if (user.status === 'SUSPENDED') {
    throw new AuthenticationError('This account has been suspended.');
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const failedAttempts = user.failedAttempts + 1;
    await db.user.update({
      where: { id: user.id },
      data: { failedAttempts, lockedUntil: lockoutUntil(failedAttempts) },
    });

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      logger.warn({ userId: user.id, failedAttempts }, 'account locked after failed attempts');
    }

    throw new AuthenticationError(INVALID_CREDENTIALS);
  }

  // A success clears the counter; otherwise five failures spread over a month
  // would eventually lock out a legitimate user.
  if (user.failedAttempts > 0 || user.lockedUntil) {
    await db.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  return user.id;
}

export async function loadAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
  const db = unsafeDbClient();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      isPlatformAdmin: true,
      mfaEnabled: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
    },
  });

  if (!user) throw new AuthenticationError(INVALID_CREDENTIALS);

  const { emailVerifiedAt, phoneVerifiedAt, ...rest } = user;
  return {
    ...rest,
    emailVerified: emailVerifiedAt !== null,
    phoneVerified: phoneVerifiedAt !== null,
  };
}

/**
 * Which branch a freshly-signed-in user lands on.
 *
 * The primary branch if they can reach it, otherwise the first branch they can.
 * A user with org-wide access to a three-branch hospital has to start somewhere,
 * and "somewhere" should be the main location rather than alphabetical luck.
 */
async function defaultBranchId(
  organizationId: string,
  userId: string,
  branchIds: string[]
): Promise<string | null> {
  if (branchIds.length === 0) return null;

  const branch = await withTenant({ organizationId, branchIds, userId }, async (tx) =>
    tx.branch.findFirst({
      where: { id: { in: branchIds }, status: 'ACTIVE', deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: { id: true },
    })
  );

  return branch?.id ?? null;
}

export interface BuildSessionInput {
  user: AuthenticatedUser;
  /** The tenant being signed in to. Null for a platform admin on the apex. */
  organizationId: string | null;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Mint a session and assemble the `authSession` response.
 *
 * `permissions` is resolved here and deliberately NOT put in the token — it
 * goes stale the moment a role changes and is far too large for a header. The
 * client refetches it from GET /auth/session after any change.
 */
export async function buildAuthSession(input: BuildSessionInput): Promise<AuthSession> {
  const { user, organizationId } = input;

  let membershipId: string | null = null;
  let branchIds: string[] = [];
  let permissions: string[] = [];
  let activeBranchId: string | null = null;

  if (organizationId) {
    const access = await loadUserAccess(user.id, organizationId);

    if (!access) {
      /**
       * Correct credentials, but no membership in THIS tenant.
       *
       * Same message as a wrong password, on purpose: a distinct one would let
       * anyone with any valid account test which clinics a colleague works at,
       * one subdomain at a time.
       */
      if (!user.isPlatformAdmin) {
        throw new AuthenticationError(INVALID_CREDENTIALS);
      }
    } else {
      membershipId = access.membershipId;
      branchIds = access.branchIds;
      activeBranchId = await defaultBranchId(organizationId, user.id, branchIds);
      permissions = permissionsFor(access, user.id, activeBranchId, user.isPlatformAdmin);
    }
  }

  const session: IssuedSession = await createSession({
    userId: user.id,
    activeOrganizationId: organizationId,
    activeBranchId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  const accessToken = signAccessToken({
    userId: user.id,
    sessionId: session.id,
    isPlatformAdmin: user.isPlatformAdmin,
    membershipId,
    organizationId,
    branchId: activeBranchId,
    impersonatedByUserId: null,
  });

  const memberships = await listMemberships(user.id);

  await unsafeDbClient().user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    accessToken,
    refreshToken: session.refreshToken,
    expiresIn: accessTokenLifetimeSeconds(),
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      isPlatformAdmin: user.isPlatformAdmin,
      mfaEnabled: user.mfaEnabled,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
    },
    activeOrganizationId: organizationId,
    activeBranchId,
    memberships,
    permissions,
    // Ordinary sign-in is never impersonation: this path always mints a session
    // for the person who presented the credential. See impersonation.service.ts,
    // which is the only thing that sets it.
    impersonation: null,
  };
}

/**
 * The banner's content while a platform admin is inside a clinic.
 *
 * Resolved by the impersonation service — `describeSession` only carries it
 * through, because the organization name is not something a session response
 * otherwise knows: an impersonating admin holds no membership in the clinic they
 * are standing in, so `memberships` cannot supply it.
 */
export interface ImpersonationDescriptor {
  organizationName: string;
  adminName: string;
  expiresAt: Date;
}

/**
 * Re-assemble the session response for an already-authenticated caller, without
 * minting new tokens. Backs GET /auth/session and the switch endpoints.
 */
export async function describeSession(
  userId: string,
  organizationId: string | null,
  branchId: string | null,
  tokens: { accessToken: string; refreshToken: string },
  impersonation: ImpersonationDescriptor | null = null
): Promise<AuthSession> {
  const user = await loadAuthenticatedUser(userId);

  let permissions: string[] = [];
  if (organizationId) {
    const access = await loadUserAccess(userId, organizationId);
    if (access) {
      permissions = permissionsFor(access, userId, branchId, user.isPlatformAdmin);
    } else if (user.isPlatformAdmin) {
      /*
       * No membership, and none expected — this is an impersonating admin
       * (ADR-0012). `permissionsFor` needs a `UserAccess` to build a context
       * from and there is none, so the bypass is applied directly. The list is
       * the whole catalogue either way: `can` returns true for a platform admin
       * before it looks at anything else, so reporting less would only make the
       * shell hide controls the API is about to allow.
       */
      permissions = [...ALL_PERMISSIONS];
    }
  }

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: accessTokenLifetimeSeconds(),
    user,
    activeOrganizationId: organizationId,
    activeBranchId: branchId,
    memberships: await listMemberships(userId),
    permissions,
    impersonation: impersonation
      ? { ...impersonation, expiresAt: impersonation.expiresAt.toISOString() }
      : null,
  };
}
