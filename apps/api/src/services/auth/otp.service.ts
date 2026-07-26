import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { consumeChallenge, issueChallenge } from './challenge.service.js';
import { sender } from '../notification/sender.js';

/**
 * Phone-first login.
 *
 * Not a nice-to-have in Indian healthcare: a receptionist or a visiting doctor
 * often has a phone and no email, and the phone number is the identity the
 * clinic already has on file.
 *
 * THE CODE MECHANICS ARE NOT HERE. Hashing, expiry, the attempt cap and single
 * use live in challenge.service.ts, which email and phone verification share.
 * What is left in this file is the part that is specific to logging in: the
 * refusal to say whether a number has an account.
 *
 * DELIVERY IS STUBBED, THE LOGIC IS NOT. Only the send goes through the logging
 * stub, because TRAI DLT registration is an external blocker (.kb/STATUS.md).
 */

/** Requesting a code must never reveal whether the number has an account. */
export interface OtpRequestOutcome {
  /** Always true to the caller. Whether anything was sent is not their business. */
  accepted: true;
}

export async function requestOtp(phone: string): Promise<OtpRequestOutcome> {
  const user = await unsafeDbClient().user.findFirst({
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

  const { code } = await issueChallenge({
    userId: user.id,
    purpose: 'LOGIN_OTP',
    identifier: phone,
    ttlSeconds: config.otp.ttlSeconds,
  });

  await sender.sendSms(phone, 'LOGIN_OTP', { code });

  return { accepted: true };
}

/**
 * Verify a code and return the user it belongs to.
 *
 * No `userId` is passed to the challenge: resolving which user this is happens
 * to BE the job here, and the phone column is globally unique, so the identifier
 * already names one account.
 *
 * Throws `AuthenticationError` on every failure, with one message.
 */
export async function verifyOtp(phone: string, code: string): Promise<string> {
  return consumeChallenge({ purpose: 'LOGIN_OTP', identifier: phone, code });
}
