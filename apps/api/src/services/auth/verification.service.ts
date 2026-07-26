import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { config } from '../../config/index.js';
import { ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit/audit.service.js';
import { sender } from '../notification/sender.js';
import { consumeChallenge, isMasterVerificationCode, issueChallenge } from './challenge.service.js';

/**
 * Proving you control the address and the handset on your own account.
 *
 * SELF-SERVICE, WHICH IS WHY NO PERMISSION CODE GUARDS IT
 *   You verify your own contact details and nobody else's. `userId` is taken
 *   from the access token by the route and never from the body — there is no
 *   input here naming whose account is being changed, so there is nothing for an
 *   escalation guard to check.
 *
 * ⚠️ `users` IS RLS-EXEMPT
 *   It has to be: one login spans every tenant, so the row belongs to no single
 *   organization. Nothing in Postgres narrows these queries — every `where`
 *   below carries `id: userId` explicitly, and that clause is the entire
 *   isolation story. A mistake here does not fail loudly; it writes to somebody
 *   else's account.
 *
 * ⚠️ `phoneVerifiedAt` IS ALSO SET BY OTP LOGIN
 *   Signing in with a code already proves control of the handset, so
 *   auth.routes.ts records it there. Confirming here has to be idempotent with
 *   that: the update is conditional on the column still being NULL, an
 *   already-verified account succeeds rather than erroring, and the timestamp is
 *   never moved forward — the first proof is the one that happened.
 *
 * Delivery is the same logging stub as every other outbound message; in
 * development the code is in the API log. Because that is a poor way to hand the
 * flow to somebody testing in a browser, a MASTER CODE also confirms either
 * channel outside production — see the block in `confirmVerification`, and
 * delete it when a real sender lands.
 */

export type VerificationChannel = 'email' | 'phone';

export interface VerificationRequest {
  sent: boolean;
  alreadyVerified: boolean;
  /** How long the code just sent remains usable. Zero when nothing was sent. */
  expiresInSeconds: number;
}

export interface VerificationResult {
  verified: true;
  /** True when the account was already verified — see the OTP note above. */
  alreadyVerified: boolean;
}

/** Everything that differs between the two channels, in one place. */
const CHANNELS = {
  email: {
    purpose: 'VERIFY_EMAIL',
    field: 'emailVerifiedAt',
    /** The user-facing name of the thing they are being asked to check. */
    noun: 'email address',
  },
  phone: {
    purpose: 'VERIFY_PHONE',
    field: 'phoneVerifiedAt',
    noun: 'phone number',
  },
} as const;

interface ContactState {
  /** The address or number to send to, or null if the account has none. */
  destination: string | null;
  verifiedAt: Date | null;
}

async function contactState(userId: string, channel: VerificationChannel): Promise<ContactState> {
  const user = await unsafeDbClient().user.findFirst({
    // `deletedAt` as well as the id: a soft-deleted account must not be able to
    // re-verify itself back into looking live.
    where: { id: userId, deletedAt: null },
    select: { email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true },
  });

  if (!user) throw new ValidationError('That account no longer exists.');

  return channel === 'email'
    ? { destination: user.email, verifiedAt: user.emailVerifiedAt }
    : { destination: user.phone, verifiedAt: user.phoneVerifiedAt };
}

/**
 * Send a code to the caller's own address or handset.
 *
 * An already-verified channel is answered with `alreadyVerified` and no message,
 * rather than an error: the caller asked for a state that already holds, and
 * sending a code they do not need is the only thing that could go wrong here.
 */
export async function requestVerification(
  userId: string,
  channel: VerificationChannel
): Promise<VerificationRequest> {
  const { purpose, noun } = CHANNELS[channel];
  const { destination, verifiedAt } = await contactState(userId, channel);

  if (!destination) {
    // Not an enumeration concern — this is the caller's own account, and they
    // can see the field is empty. Say what is actually wrong.
    throw new ValidationError(`Add ${noun === 'email address' ? 'an' : 'a'} ${noun} first.`);
  }

  if (verifiedAt) {
    return { sent: false, alreadyVerified: true, expiresInSeconds: 0 };
  }

  const { code } = await issueChallenge({
    userId,
    purpose,
    identifier: destination,
    ttlSeconds: config.verification.ttlSeconds,
  });

  if (channel === 'email') {
    await sender.sendEmail(destination, 'VERIFY_EMAIL', { code });
  } else {
    await sender.sendSms(destination, 'VERIFY_PHONE', { code });
  }

  // Id and channel only. The address is a personal identifier and the code is a
  // live credential; the sender's own stub decides what is safe to log.
  logger.info({ userId, channel }, 'verification code issued');

  return { sent: true, alreadyVerified: false, expiresInSeconds: config.verification.ttlSeconds };
}

export interface ConfirmVerificationInput {
  userId: string;
  channel: VerificationChannel;
  code: string;
  /**
   * The tenant to attribute the audit row to, when there is one.
   *
   * These routes sit behind `authenticate` + `requireAuth` and deliberately NOT
   * behind `requireTenant` — a platform admin verifying from admin.<root> has no
   * organization at all, and refusing them would be refusing self-service to the
   * one account that cannot ask anybody else. So the audit row is written when
   * the caller is inside a clinic (the overwhelmingly common case, and the one
   * a clinic's own audit trail has to answer for) and skipped when they are not.
   */
  tenant?: TenantContext | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export async function confirmVerification(
  input: ConfirmVerificationInput
): Promise<VerificationResult> {
  const { purpose, field } = CHANNELS[input.channel];
  const { destination } = await contactState(input.userId, input.channel);

  if (!destination) {
    // The address the code was issued against is gone, so no code can match it.
    // Same message as a bad code: there is nothing useful to distinguish.
    throw new ValidationError('That code is not valid or has expired.');
  }

  /**
   * ⚠️ THE DEVELOPMENT MASTER CODE, AND THE ONLY PLACE IT APPLIES.
   *
   * Neither channel can deliver a message yet, so outside the API log there is
   * no way to reach a verified account at all. This is the affordance that makes
   * the flow testable until SES and TRAI DLT clear, and it is null in production
   * by construction — see config.verification.masterCode.
   *
   * It skips the token lookup entirely rather than matching against a row, so
   * "Send a code" is not a prerequisite. That also means it bypasses the attempt
   * cap and single use, which is precisely why it may not exist in production.
   *
   * WHAT IT DOES NOT DO
   *   Log anyone in. `verifyOtp` does not consult it, and a test pins that.
   *   Confirming an address you already hold is not proving who you are.
   *
   * REMOVE THIS BLOCK when a real sender lands. It is four lines and one import.
   */
  if (isMasterVerificationCode(input.code)) {
    logger.warn(
      { userId: input.userId, channel: input.channel },
      'contact verified with the development master code'
    );
  } else {
    /**
     * The identifier AND the user.
     *
     * Pinning to `userId` is what stops a code issued to one account being
     * redeemed by another that has since been given the same address —
     * `auth_tokens.identifier` carries no uniqueness constraint of its own.
     */
    await consumeChallenge({
      purpose,
      identifier: destination,
      code: input.code,
      userId: input.userId,
    });
  }

  const now = new Date();

  /**
   * Conditional on the column still being NULL.
   *
   * `updateMany` rather than `update` so that "already verified" is a count of
   * zero rather than an exception, and so the existing timestamp is left where
   * it is — OTP login may already have written it, and the earlier proof is the
   * one that actually happened.
   *
   * The two channels are spelled out rather than indexed by a computed key:
   * Prisma's `where` and `data` types are unions of literal keys, and a computed
   * one widens both to `string` and takes the column names out of the type
   * system — the one thing checking this query at all.
   */
  const markVerified = async (tx: TxClient): Promise<number> => {
    const { count } =
      input.channel === 'email'
        ? await tx.user.updateMany({
            where: { id: input.userId, emailVerifiedAt: null },
            data: { emailVerifiedAt: now },
          })
        : await tx.user.updateMany({
            where: { id: input.userId, phoneVerifiedAt: null },
            data: { phoneVerifiedAt: now },
          });
    return count;
  };

  // No tenant: nowhere to file an audit row, so the write stands alone.
  if (!input.tenant) {
    const count = await markVerified(unsafeDbClient());
    return { verified: true, alreadyVerified: count === 0 };
  }

  const tenant = input.tenant;

  return withTenant(tenant, async (tx) => {
    const count = await markVerified(tx);

    // Nothing moved, so there is nothing to record. An audit row saying a field
    // changed from a value to the same value is noise in the one table that has
    // to stay readable.
    if (count > 0) {
      await recordAudit(tx, tenant, {
        action: 'UPDATE',
        entityType: 'user',
        entityId: input.userId,
        before: { [field]: null },
        after: { [field]: now },
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      });
    }

    return { verified: true as const, alreadyVerified: count === 0 };
  });
}
