import type { Transporter } from 'nodemailer';

import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

import { renderEmail } from './templates.js';
import { maskEmail, maskPhone, type NotificationSender } from './types.js';

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

function getTransporter(): Promise<Transporter> {
  transporter ??= import('nodemailer').then((nodemailer) =>
    nodemailer.default.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      // Mailpit authenticates nobody, so an `auth` block with blank credentials
      // would make it refuse the session. Omit it entirely when unset.
      ...(config.email.smtp.user
        ? { auth: { user: config.email.smtp.user, pass: config.email.smtp.password ?? '' } }
        : {}),
      pool: true,
    })
  );
  return transporter;
}

export const smtpSender: NotificationSender = {
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

  async sendEmail(to, template, vars) {
    const { subject, text, html } = renderEmail(template, vars);

    try {
      const mailer = await getTransporter();
      const info = await mailer.sendMail({ from: config.email.from, to, subject, text, html });
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
          ...(config.isProduction ? {} : vars),
        },
        'email send failed'
      );
    }
  },
};
