import type { AuthTokenPurpose } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../../config/index.js';
import { AuthenticationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { generateOtpCode, hashOtpCode } from './token.service.js';

/**
 * One short code, issued and redeemed exactly once.
 *
 * `auth_tokens` backs several unrelated flows — phone login, email verification,
 * phone verification — and every one of them needs the same four controls:
 * the code is stored hashed, it expires, it can be tried a bounded number of
 * times, and redeeming it consumes it. This module is those controls, extracted
 * from otp.service.ts when verification became the second caller. A second copy
 * would be a second place to get the attempt cap subtly wrong, and the failure
 * mode of getting it wrong is silent.
 *
 * WHAT DOES **NOT** LIVE HERE
 *   Policy. Who is allowed to ask for a code, whether an unknown identifier is
 *   answered with a lie, which template is sent, what happens after a successful
 *   redemption — all of that belongs to the caller, because it differs. This
 *   module knows only that a code was issued against `(purpose, identifier)`
 *   and whether the one presented matches.
 *
 * `auth_tokens` is RLS-exempt, and has to be: every flow using it runs before a
 * tenant context exists, or on a `users` row that belongs to no single tenant.
 * The scoping is therefore the `where` clause below and nothing else — read it
 * as security-critical code, because there is no policy behind it.
 */

/**
 * Does this code confirm anything it is presented against, regardless of what
 * was issued?
 *
 * ⚠️ Only ONE caller may consult this: `confirmVerification`. It lives here
 * rather than in that service so the whole notion of a code that bypasses the
 * table is visible in the module that owns codes — one grep for
 * `isMasterVerificationCode` finds every place it can possibly apply.
 *
 * `config.verification.masterCode` is null in production and cannot be turned on
 * by an environment variable there; the boot assertion in config/index.ts aborts
 * a process that tries. So this returns false in production for every input.
 *
 * Deliberately NOT constant-time. Timing tells an attacker whether their guess
 * matched a value that, where it exists at all, is documented in .env.example
 * and printed on the screen.
 */
export function isMasterVerificationCode(code: string): boolean {
  const master = config.verification.masterCode;
  return master !== null && code === master;
}

export interface IssuedChallenge {
  /** The plaintext code. Returned exactly once; only its digest is stored. */
  code: string;
  expiresAt: Date;
}

/**
 * Mint a code.
 *
 * `ttlSeconds` is required rather than defaulted. A login OTP travels to a
 * handset already in the user's hand and lives five minutes; an emailed
 * verification code has to survive a mail queue and a coffee break. A default
 * here would quietly apply one flow's lifetime to the other.
 */
export async function issueChallenge(input: {
  userId: string;
  purpose: AuthTokenPurpose;
  /** The email address or phone number the code is being sent to. */
  identifier: string;
  ttlSeconds: number;
}): Promise<IssuedChallenge> {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  await unsafeDbClient().authToken.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      identifier: input.identifier,
      codeHash: hashOtpCode(code),
      expiresAt,
    },
  });

  return { code, expiresAt };
}

/**
 * Redeem a code, and return the user it was issued to.
 *
 * Throws `AuthenticationError` on every failure with ONE message — a code that
 * is wrong, expired, already used, or issued to somebody else must look
 * identical, or the endpoint answers questions it was never asked.
 */
export async function consumeChallenge(input: {
  purpose: AuthTokenPurpose;
  identifier: string;
  code: string;
  /**
   * Pin the row to a user as well as to the identifier.
   *
   * Verification passes this; phone login cannot, because resolving the user is
   * what it is here to do. Without it, an identifier is only as unique as the
   * column it came from — and `auth_tokens.identifier` carries no constraint at
   * all.
   */
  userId?: string | undefined;
}): Promise<string> {
  const db = unsafeDbClient();
  const invalid = (): never => {
    throw new AuthenticationError('That code is not valid or has expired.');
  };

  const token = await db.authToken.findFirst({
    where: {
      identifier: input.identifier,
      purpose: input.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
    },
    // Newest first: requesting a second code should invalidate reliance on the
    // first, and this is what makes the most recent one the live one.
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true, codeHash: true, attempts: true },
  });

  if (!token?.userId) return invalid();

  if (token.attempts >= config.otp.maxAttempts) {
    // Burn it rather than leaving an exhausted row to be retried forever.
    await db.authToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    logger.warn({ authTokenId: token.id, purpose: input.purpose }, 'code attempt limit reached');
    return invalid();
  }

  if (token.codeHash !== hashOtpCode(input.code)) {
    await db.authToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
    });
    return invalid();
  }

  // Single use. Marking it consumed is what stops a code shoulder-surfed from a
  // notification being replayed a second time.
  await db.authToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });

  return token.userId;
}
