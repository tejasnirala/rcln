/**
 * The shape of the outbound-message seam, split out from `sender.ts` so that a
 * concrete sender can depend on it without importing the module that chooses
 * which sender to use. `sender.ts` re-exports everything here — import from
 * there unless you are writing a sender.
 */

export type SmsTemplate = 'LOGIN_OTP' | 'VERIFY_PHONE';

/**
 * ⚠️ EVERY BODY IS PHI-FREE, AND THE PHARMACY ONES ARE WHY THAT RULE NEEDED
 *   STATING TWICE. `templates.ts` has always said "NO PHI, EVER" — these bodies
 *   go to an external relay and sit in plain text at the far end, in an inbox
 *   the clinic does not control. The delivery notifications added in PI-24 are
 *   the first that concern a PATIENT rather than a colleague, and the
 *   temptation is a friendly "Hello Asha, your metformin has shipped", which
 *   would put a name and a diagnosis-revealing drug on a mail server for ever.
 *
 *   So they carry an order REFERENCE and a status and nothing else: no patient
 *   name, no medicine, no clinic name, no quantity. The recipient signs in to
 *   see what it was. That is the standard secure-notification pattern — say
 *   that something changed, keep the content behind authentication — and it is
 *   the reason these could be built without anyone having to relax a PHI rule.
 */
export type EmailTemplate =
  | 'INVITE'
  | 'INVITE_REMINDER'
  | 'VERIFY_EMAIL'
  | 'ORDER_CONFIRMED'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERY_FAILED'
  | 'STOCK_EXPIRING';

/** What a sender needs to know, passed in rather than imported (see smtp.sender.ts). */
export interface SenderOptions {
  provider: 'smtp' | 'console';
  from: string;
  isProduction: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string | undefined;
    password?: string | undefined;
  };
}

/**
 * The subset of a pino logger these senders use. Declared here so the package
 * depends on no particular logger — the API passes its own, the worker passes
 * its own, and neither has to be the same instance.
 */
export interface NotificationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface NotificationSender {
  sendSms(to: string, template: SmsTemplate, vars: Record<string, string>): Promise<void>;
  sendEmail(to: string, template: EmailTemplate, vars: Record<string, string>): Promise<void>;
}

/** `+919876543210` -> `+9198****3210`. Enough to debug, not enough to identify. */
export function maskPhone(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 5)}****${value.slice(-4)}`;
}

/** `asha@northwind.test` -> `a***@northwind.test`. The domain is the useful half. */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return '****';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}
