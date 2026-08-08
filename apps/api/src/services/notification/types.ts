/**
 * The shape of the outbound-message seam, split out from `sender.ts` so that a
 * concrete sender can depend on it without importing the module that chooses
 * which sender to use. `sender.ts` re-exports everything here — import from
 * there unless you are writing a sender.
 */

export type SmsTemplate = 'LOGIN_OTP' | 'VERIFY_PHONE';
export type EmailTemplate = 'INVITE' | 'INVITE_REMINDER' | 'VERIFY_EMAIL';

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
