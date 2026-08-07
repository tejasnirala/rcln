import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

import { smtpSender } from './smtp.sender.js';
import { maskEmail, maskPhone, type NotificationSender } from './types.js';

/**
 * The outbound-message seam.
 *
 * There is no SMS provider wired yet, and that is not an oversight: TRAI DLT
 * registration (entity, header, and one approval per template) is a 1–2 week
 * external process listed under "Blocked / needs a human" in .kb/STATUS.md.
 * Sending an unregistered SMS in India does not fail softly — it is dropped by
 * the carrier.
 *
 * So the OTP logic ships complete and real — auth_tokens row, hashed code,
 * attempt counting, hard expiry, rate limits — and only DELIVERY is stubbed.
 * When DLT clears, add an MSG91 sender that satisfies this interface and change
 * the one line in `sender` below. No call site changes.
 *
 * EMAIL IS NO LONGER STUBBED IN DEVELOPMENT.
 *   SES is still in the sandbox until the sending domain is verified
 *   (.kb/STATUS.md), so there is no production sender yet. But `EMAIL_PROVIDER`
 *   now selects between this logging stub and `smtpSender`, and compose points
 *   the latter at Mailpit — every invitation link and verification code lands
 *   in a real inbox at http://localhost:8025 instead of in a log line. Same
 *   code path a real relay will use; only the host changes.
 */

export type { NotificationSender, SmsTemplate, EmailTemplate } from './types.js';
export { maskEmail, maskPhone } from './types.js';

/**
 * The stand-in when no relay is configured — `EMAIL_PROVIDER=console`, which is
 * what the test suite and a native run without Docker use.
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
      // The invitation link is in `vars`, and with no relay configured that is
      // the only way to test the accept flow. It is a live credential, which is
      // exactly why the production branch above logs neither it nor the address.
      logger.info({ to: maskEmail(to), template, ...vars }, 'email (dev stub, not delivered)');
    }
    return Promise.resolve();
  },
};

/**
 * Swap the SMS half for the MSG91 implementation once DLT registration
 * completes.
 *
 * ⚠️ WHEN YOU DO, DELETE THE MASTER VERIFICATION CODE TOO.
 *   `confirmVerification` accepts `config.verification.masterCode` outside
 *   production. Email delivery via Mailpit already removes half its reason to
 *   exist — the emailed code is readable — and a working SMS sender removes the
 *   rest. It is null in production and the API refuses to boot with it set
 *   there, but a backdoor with no remaining justification is just a backdoor.
 *   See services/auth/verification.service.ts and .env.example.
 *
 * Mutable by construction: the integration suites replace `sendEmail` to
 * capture the invitation token, which the database only ever stores hashed.
 */
export const sender: NotificationSender =
  config.email.provider === 'smtp' ? smtpSender : loggingSender;
