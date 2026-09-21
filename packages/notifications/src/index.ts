/**
 * The outbound-message seam, shared by the API and the worker.
 *
 * ⚠️ IT IS A PACKAGE BECAUSE THE WORKER SENDS TOO, AND UNTIL PI-24 IT COULD NOT.
 *   All of this lived in `apps/api/src/services/notification`, reading that
 *   app's `config` and `logger` directly — so `QUEUE.NOTIFICATIONS` existed, had
 *   a worker handler that logged "processor not implemented yet", and every
 *   pharmacy event went nowhere. The alternative was a second sender in the
 *   worker, which KNOWN_ISSUES KI-6 forbids by name: **do not build a second
 *   notification path.**
 *
 * ⚠️ NO PHI IN ANY BODY. See `templates.ts` and the note on `EmailTemplate` —
 *   these go to an external relay and are stored in plain text at the far end.
 *   The delivery emails carry a reference and a status; the content is behind
 *   the sign-in.
 *
 * SMS IS STILL A LOGGING STUB, and that is an external blocker rather than a
 * gap in the code: TRAI DLT registration (entity, header, one approval per
 * template) is a 1–2 week process, and an unregistered SMS in India is dropped
 * by the carrier rather than failing loudly. When it clears, add a sender that
 * satisfies `NotificationSender` and change the one line in `createSender`.
 */

export * from './types.js';
export { renderEmail, type RenderedEmail } from './templates.js';
export { createSmtpSender } from './smtp.sender.js';
export { createLoggingSender } from './logging.sender.js';

import { createLoggingSender } from './logging.sender.js';
import { createSmtpSender } from './smtp.sender.js';
import type { NotificationLogger, NotificationSender, SenderOptions } from './types.js';

/** The sender this deployment should use. */
export function createSender(
  options: SenderOptions,
  logger: NotificationLogger
): NotificationSender {
  return options.provider === 'smtp'
    ? createSmtpSender(options, logger)
    : createLoggingSender(options, logger);
}
