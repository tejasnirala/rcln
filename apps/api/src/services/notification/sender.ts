import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

/**
 * The outbound-message seam.
 *
 * There is no SMS provider wired yet, and that is not an oversight: TRAI DLT
 * registration (entity, header, and one approval per template) is a 1–2 week
 * external process listed under "Blocked / needs a human" in docs/STATUS.md.
 * Sending an unregistered SMS in India does not fail softly — it is dropped by
 * the carrier.
 *
 * So the OTP logic ships complete and real — auth_tokens row, hashed code,
 * attempt counting, hard expiry, rate limits — and only DELIVERY is stubbed.
 * When DLT clears, add an MSG91 sender that satisfies this interface and change
 * the one line in `sender` below. No call site changes.
 *
 * Email is in the same position for a different reason: SES is still in the
 * sandbox until the sending domain is verified (docs/STATUS.md), so a real send
 * would be accepted and then silently dropped for any address we have not
 * pre-verified. Same treatment — the invitation row, the hashed token and the
 * expiry are real; the message is logged.
 */

export type SmsTemplate = 'LOGIN_OTP';
export type EmailTemplate = 'INVITE' | 'INVITE_REMINDER';

export interface NotificationSender {
  sendSms(to: string, template: SmsTemplate, vars: Record<string, string>): Promise<void>;
  sendEmail(to: string, template: EmailTemplate, vars: Record<string, string>): Promise<void>;
}

/** `+919876543210` -> `+9198****3210`. Enough to debug, not enough to identify. */
function maskPhone(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 5)}****${value.slice(-4)}`;
}

/** `asha@northwind.test` -> `a***@northwind.test`. The domain is the useful half. */
function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return '****';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/**
 * The stand-in until a provider exists.
 *
 * In development it logs the code, because otherwise nobody can test the OTP
 * flow locally. In any other environment it logs that a message WOULD have been
 * sent and nothing more — a production log containing live login codes is a
 * credential store with no access control on it.
 */
export const loggingSender: NotificationSender = {
  sendSms(to, template, vars) {
    if (config.isProduction) {
      logger.warn(
        { to: maskPhone(to), template },
        'SMS not sent — no provider configured (TRAI DLT registration pending)'
      );
    } else {
      logger.info({ to: maskPhone(to), template, ...vars }, 'SMS (dev stub, not delivered)');
    }
    return Promise.resolve();
  },

  sendEmail(to, template, vars) {
    if (config.isProduction) {
      logger.warn(
        { to: maskEmail(to), template },
        'email not sent — no provider configured (SES domain verification pending)'
      );
    } else {
      // The invitation link is in `vars`, and in development that is the only
      // way to test the accept flow. It is a live credential, which is exactly
      // why the production branch above logs neither it nor the address.
      logger.info({ to: maskEmail(to), template, ...vars }, 'email (dev stub, not delivered)');
    }
    return Promise.resolve();
  },
};

/** Swap this for the MSG91 implementation once DLT registration completes. */
export const sender: NotificationSender = loggingSender;
