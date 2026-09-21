/**
 * The API's notification sender.
 *
 * ⚠️ THE IMPLEMENTATION MOVED TO `@rcln/notifications` IN PI-24, AND THIS FILE
 *   IS NOW ONLY THE WIRING. The worker has to send too — pharmacy events go
 *   through `QUEUE.NOTIFICATIONS`, which had no processor at all — and a sender
 *   that reads this app's `config` and `logger` directly cannot be used from
 *   there. Copying it into the worker was the other option, and KNOWN_ISSUES
 *   KI-6 rules it out by name: **do not build a second notification path.**
 *
 *   Every call site is unchanged: `sender.sendEmail(...)` still means what it
 *   meant, and the integration suites still replace `sendEmail` on this object
 *   to capture an invitation token the database only stores hashed.
 *
 * ⚠️ WHEN SMS DELIVERY LANDS, DELETE THE MASTER VERIFICATION CODE TOO.
 *   `confirmVerification` accepts `config.verification.masterCode` outside
 *   production. Email via Mailpit already removed half its reason to exist —
 *   the emailed code is readable — and a working SMS sender removes the rest.
 *   It is null in production and the API refuses to boot with it set there, but
 *   a backdoor with no remaining justification is just a backdoor.
 */

import { createSender } from '@rcln/notifications';

import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export type { NotificationSender, SmsTemplate, EmailTemplate } from '@rcln/notifications';
export { maskEmail, maskPhone } from '@rcln/notifications';

/** What `@rcln/notifications` needs, read off this app's config once. */
export const senderOptions = {
  provider: config.email.provider === 'smtp' ? ('smtp' as const) : ('console' as const),
  from: config.email.from,
  isProduction: config.isProduction,
  smtp: {
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    user: config.email.smtp.user,
    password: config.email.smtp.password,
  },
};

/**
 * Mutable by construction: the integration suites replace `sendEmail` to
 * capture the invitation token.
 */
export const sender = createSender(senderOptions, logger);
