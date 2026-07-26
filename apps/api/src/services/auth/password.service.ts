import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing and the login-attempt lockout.
 *
 * Parameters are argon2id at the OWASP baseline, and they are deliberately the
 * SAME literals as packages/db/prisma/seed.ts. The seed creates the super admin;
 * if the two drift, that account stops being verifiable here — argon2 encodes
 * its parameters in the hash string, so verification still works, but new hashes
 * would be weaker or slower than the ones the seed writes. Change both together.
 */
const ARGON2 = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Lock the account after this many consecutive failures. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long a lockout lasts. Long enough to kill online guessing, short enough
 *  that a real user who fat-fingered their password is not calling support. */
export const LOCKOUT_MINUTES = 15;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must
 * fail the login, not 500 the endpoint.
 */
export async function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/**
 * A hash to compare against when the user does not exist.
 *
 * Login must take the same time whether the identifier is unknown or the
 * password is wrong. Without this, an attacker times the response and learns
 * which emails and phone numbers have accounts — a user-enumeration oracle that
 * costs nothing to close. Generated once at module load, from a random string
 * that is never a real password.
 */
let dummyHashPromise: Promise<string> | null = null;

export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`no-such-user:${Math.random()}:${Date.now()}`);
  return dummyHashPromise;
}

/**
 * Burn the same work as a real verification, for a user that does not exist.
 * The result is discarded; only the elapsed time matters.
 */
export async function fakeVerify(plain: string): Promise<void> {
  await verifyPassword(plain, await dummyHash());
}

export function isLockedOut(lockedUntil: Date | null): boolean {
  return lockedUntil !== null && lockedUntil > new Date();
}

/**
 * The next value for `users.locked_until` after a failed attempt, given the
 * failure count that includes this one. Null means "not locked yet".
 */
export function lockoutUntil(failedAttempts: number): Date | null {
  if (failedAttempts < MAX_FAILED_ATTEMPTS) return null;
  return new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
}
