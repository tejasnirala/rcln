/**
 * The stand-in when no relay is configured — `EMAIL_PROVIDER=console`, which is
 * what the test suite and a native run without Docker use.
 *
 * In development it logs the code, because otherwise nobody can test the OTP
 * flow locally. In any other environment it logs that a message WOULD have been
 * sent and nothing more — a production log containing live login codes is a
 * credential store with no access control on it.
 */
import {
  maskEmail,
  maskPhone,
  type NotificationLogger,
  type NotificationSender,
  type SenderOptions,
} from './types.js';

export function createLoggingSender(
  options: SenderOptions,
  logger: NotificationLogger
): NotificationSender {
  return {
    sendSms(to, template, vars): Promise<void> {
      if (options.isProduction) {
        logger.warn(
          { to: maskPhone(to), template },
          'SMS not sent — no provider configured (TRAI DLT registration pending)'
        );
      } else {
        logger.info({ to: maskPhone(to), template, ...vars }, 'SMS (dev stub, not delivered)');
      }
      return Promise.resolve();
    },

    sendEmail(to, template, vars): Promise<void> {
      if (options.isProduction) {
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
}
