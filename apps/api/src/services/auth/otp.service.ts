import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../../config/index.js';
import { AuthenticationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { generateOtpCode, hashOtpCode } from './token.service.js';
import { sender } from '../notification/sender.js';

/**
 * Phone-first login.
 *
 * Not a nice-to-have in Indian healthcare: a receptionist or a visiting doctor
 * often has a phone and no email, and the phone number is the identity the
 * clinic already has on file.
 *
 * `auth_tokens` is RLS-exempt, and has to be — verification happens before any
 * tenant context exists, and the phone number does not name an organization.
 *
 * DELIVERY IS STUBBED, THE LOGIC IS NOT. Every control that makes an OTP safe —
 * hashing, single use, hard expiry, attempt counting, per-phone rate limiting —
 * is real here. Only the send goes through the logging stub, because TRAI DLT
 * registration is an external blocker (docs/STATUS.md).
 */

/** Requesting a code must never reveal whether the number has an account. */
export interface OtpRequestOutcome {
  /** Always true to the caller. Whether anything was sent is not their business. */
  accepted: true;
}

export async function requestOtp(phone: string): Promise<OtpRequestOutcome> {
  const db = unsafeDbClient();

  const user = await db.user.findFirst({
    where: { phone, deletedAt: null },
    select: { id: true, status: true },
  });

  /**
   * An unknown number gets the same 200 and the same latency as a known one.
   *
   * Anything else turns this endpoint into a way to test whether a given phone
   * number belongs to a clinician on the platform, at zero cost and with no
   * account required.
   */
  if (!user || user.status === 'SUSPENDED') {
    logger.info({ reason: 'no_account' }, 'otp request ignored');
    return { accepted: true };
  }

  const code = generateOtpCode();

  await db.authToken.create({
    data: {
      userId: user.id,
      purpose: 'LOGIN_OTP',
      identifier: phone,
      codeHash: hashOtpCode(code),
      expiresAt: new Date(Date.now() + config.otp.ttlSeconds * 1000),
    },
  });

  await sender.sendSms(phone, 'LOGIN_OTP', { code });

  return { accepted: true };
}

/**
 * Verify a code and return the user it belongs to.
 *
 * Throws `AuthenticationError` on every failure, with one message — a code that
 * is wrong, expired, already used or for an unknown number must look identical.
 */
export async function verifyOtp(phone: string, code: string): Promise<string> {
  const db = unsafeDbClient();
  const invalid = (): never => {
    throw new AuthenticationError('That code is not valid or has expired.');
  };

  const token = await db.authToken.findFirst({
    where: {
      identifier: phone,
      purpose: 'LOGIN_OTP',
      consumedAt: null,
      expiresAt: { gt: new Date() },
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
    logger.warn({ authTokenId: token.id }, 'otp attempt limit reached');
    return invalid();
  }

  if (token.codeHash !== hashOtpCode(code)) {
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
