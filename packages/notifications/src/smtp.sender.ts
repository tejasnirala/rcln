import type { Transporter } from 'nodemailer';

import { renderEmail } from './templates.js';
import {
  maskEmail,
  maskPhone,
  type NotificationLogger,
  type NotificationSender,
  type SenderOptions,
} from './types.js';

/**
 * The SMTP sender — Mailpit in development, a real relay later.
 *
 * WHY THIS EXISTS AT ALL WHEN SES IS STILL PENDING
 *   An invitation token is handed to the sender and to nobody else; the column
 *   holds a digest. With the logging stub the only way to open an invitation
 *   was to read the API container's logs and copy a URL out of a JSON line.
 *   Mailpit already ran in compose and caught nothing, because nothing was ever
 *   sent to it. Now it is, and the link is a click at http://localhost:8025.
 *
 * SMS IS DELIBERATELY NOT HANDLED HERE
 *   It stays on the logging stub until TRAI DLT registration clears — see the
 *   note in `sender.ts`. There is no SMTP path to a handset.
 */

/**
 * Built once, lazily.
 *
 * Lazily because nodemailer is then never loaded in the test suite or in a
 * `console` deployment, and once because a transport holds a pooled connection
 * — constructing one per message opens a TCP connection per message.
 */
let transporter: Promise<Transporter> | null = null;

function getTransporter(options: SenderOptions): Promise<Transporter> {
  transporter ??= import('nodemailer').then((nodemailer) =>
    nodemailer.default.createTransport({
      host: options.smtp.host,
      port: options.smtp.port,
      secure: options.smtp.secure,
      // Mailpit authenticates nobody, so an `auth` block with blank credentials
      // would make it refuse the session. Omit it entirely when unset.
      ...(options.smtp.user
        ? { auth: { user: options.smtp.user, pass: options.smtp.password ?? '' } }
        : {}),
      pool: true,
    })
  );
  return transporter;
}

/**
 * ⚠️ A FACTORY RATHER THAN A CONST, BECAUSE THE WORKER SENDS TOO (PI-24). This
 *   used to live in `apps/api` and read that app's `config` and `logger`
 *   directly, which is exactly why the worker could not send anything and why
 *   `QUEUE.NOTIFICATIONS` had a handler that logged "not implemented yet". The
 *   alternative was a second sender in the worker, and KNOWN_ISSUES KI-6 says in
 *   so many words: do not build a second notification path.
 */
export function createSmtpSender(
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

    async sendEmail(to, template, vars): Promise<void> {
      const { subject, text, html } = renderEmail(template, vars);

      try {
        const mailer = await getTransporter(options);
        const info = await mailer.sendMail({ from: options.from, to, subject, text, html });
        logger.info({ to: maskEmail(to), template, messageId: info.messageId }, 'email sent');
      } catch (error) {
        /**
         * A send failure does not fail the request.
         *
         * The caller already committed — the invitation row exists, the token is
         * spent, the audit entry is written — and there is nothing useful to roll
         * back to. Throwing here turns a delivery problem into a 500 on a request
         * that actually succeeded, and the operator's fix (resend) works either
         * way. So: log loudly, and in development log the variables too, so a
         * developer whose Mailpit is down still gets the link out of the API log.
         */
        logger.error(
          {
            to: maskEmail(to),
            template,
            err: error,
            ...(options.isProduction ? {} : vars),
          },
          'email send failed'
        );
      }
    },
  };
}
