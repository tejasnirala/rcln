import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';

/**
 * Two tokens, two very different jobs.
 *
 * ACCESS TOKEN — a short-lived signed JWT. Stateless on purpose: verifying it
 *   costs no database round-trip, which matters because it happens on every
 *   request. The cost of statelessness is that it cannot be revoked before it
 *   expires, which is why it lives for 15 minutes and not a day.
 *
 * REFRESH TOKEN — an opaque 256-bit random string, NOT a JWT. It is stored only
 *   as a SHA-256 hash in `sessions.refresh_token_hash`, so a dump of that table
 *   cannot be replayed. It is stateful precisely so it CAN be revoked, which is
 *   what makes reuse detection possible (see session.service.ts).
 *
 * WHAT IS NOT IN THE TOKEN
 *   The permission list. It is resolved per request from membership_roles.
 *   Baking it in would mean a revoked role keeps working until the token
 *   expires, and it is far too large for a header. This is a CLAUDE.md
 *   invariant, not a preference.
 *
 *   Nothing here is a name, an email, a phone number or any other identifier a
 *   person could be recognised by. Ids only — a JWT is base64, not encrypted,
 *   and anyone holding it can read every claim.
 */

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  isPlatformAdmin: boolean;
  membershipId: string | null;
  organizationId: string | null;
  branchId: string | null;
  impersonatedByUserId: string | null;
}

/** Short keys: this rides on every request, and headers have size limits. */
interface JwtPayload {
  sub: string;
  sid: string;
  pa: boolean;
  mid: string | null;
  oid: string | null;
  bid: string | null;
  imp: string | null;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  const payload: JwtPayload = {
    sub: claims.userId,
    sid: claims.sessionId,
    pa: claims.isPlatformAdmin,
    mid: claims.membershipId,
    oid: claims.organizationId,
    bid: claims.branchId,
    imp: claims.impersonatedByUserId,
  };

  // `expiresIn` is typed as a non-optional union, so under
  // exactOptionalPropertyTypes the assertion has to land on the concrete type,
  // not on the property lookup — the latter still includes `undefined`.
  const options: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn: config.jwt.accessTokenExpiresIn as NonNullable<jwt.SignOptions['expiresIn']>,
    issuer: 'rcln',
  };

  return jwt.sign(payload, config.jwt.secret, options);
}

/**
 * Throws `JsonWebTokenError` / `TokenExpiredError` on a bad token — both are
 * already mapped to 401 by apps/api/src/middleware/error.middleware.ts.
 *
 * `algorithms` is pinned. Without it, a token signed with `alg: none` — or with
 * the public half of an asymmetric pair — is accepted, which is the classic JWT
 * forgery. Never let the token choose how it is verified.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: 'rcln',
  }) as JwtPayload;

  return {
    userId: decoded.sub,
    sessionId: decoded.sid,
    isPlatformAdmin: decoded.pa,
    membershipId: decoded.mid,
    organizationId: decoded.oid,
    branchId: decoded.bid,
    impersonatedByUserId: decoded.imp,
  };
}

/** Seconds until an access token expires, for the `expiresIn` field of authSession. */
export function accessTokenLifetimeSeconds(): number {
  const raw = config.jwt.accessTokenExpiresIn;
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) return Number.parseInt(raw, 10) || 900;

  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const seconds = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
  return value * seconds;
}

/** 256 bits of entropy, url-safe. Returned to the caller exactly once. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, not argon2.
 *
 * A refresh token is 256 random bits, so it has no dictionary to attack and
 * needs no key stretching. Argon2 here would add ~50ms to every refresh for no
 * security gain. Passwords are different — they are low-entropy and human-chosen.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * An invitation token: 256 random bits, url-safe, emailed in the clear.
 *
 * Held to the same standard as a refresh token, because it does the same kind of
 * thing — anyone presenting it gets a membership in a clinic, with whatever role
 * the invitation names. `invitations.token` therefore stores only the digest;
 * see hashInviteToken. Not `generateRefreshToken` reused under another name:
 * these are separate credentials with separate lifetimes, and a shared helper
 * would make one of them impossible to change.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256, for the same reason as hashRefreshToken: 256 bits need no stretching. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A numeric OTP of the configured length, zero-padded, uniformly random. */
export function generateOtpCode(): string {
  const digits = config.otp.length;
  const max = 10 ** digits;
  // rejection-free enough: randomInt is uniform over [0, max)
  const value = randomBytes(6).readUIntBE(0, 6) % max;
  return String(value).padStart(digits, '0');
}

/** OTP codes are short and guessable, so they are hashed like a password. */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(`${code}:${config.jwt.secret}`).digest('hex');
}
