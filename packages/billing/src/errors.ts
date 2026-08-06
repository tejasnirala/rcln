/**
 * Billing failures the API turns into HTTP answers.
 *
 * Each carries a stable `code` so the web layer can react to the kind rather
 * than to the wording, and a message written for a clinic administrator rather
 * than for a log. Nothing here mentions a provider by name — the customer did
 * not choose the acquirer and cannot act on its identity.
 */

export type BillingErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'PRICE_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'NOT_AN_UPGRADE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_STATE'
  | 'MANDATE_UNAVAILABLE'
  | 'MANDATE_REQUIRED'
  | 'INTENT_NOT_FOUND'
  | 'PAYMENT_FAILED'
  | 'ALREADY_CANCELLED'
  | 'NOTHING_TO_RESUME';

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  /** HTTP status the API should answer with. 409 for a state conflict. */
  readonly statusCode: number;

  constructor(code: BillingErrorCode, message: string, statusCode = 409) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

export const billingError = {
  planNotFound: (): BillingError =>
    new BillingError('PLAN_NOT_FOUND', 'That plan is not available.', 404),

  priceNotFound: (currency: string): BillingError =>
    new BillingError(
      'PRICE_NOT_FOUND',
      `That plan is not priced in ${currency}. Contact us and we will publish a price for your region.`,
      404
    ),

  currencyMismatch: (subscription: string, requested: string): BillingError =>
    new BillingError(
      'CURRENCY_MISMATCH',
      `This subscription is billed in ${subscription} and cannot switch to ${requested}. Contact us to change your billing currency.`
    ),

  notAnUpgrade: (): BillingError =>
    new BillingError(
      'NOT_AN_UPGRADE',
      'You can only move to a plan that includes everything your current one does. To move to a smaller plan, contact us.'
    ),

  subscriptionNotFound: (): BillingError =>
    new BillingError('SUBSCRIPTION_NOT_FOUND', 'This clinic has no subscription.', 404),

  subscriptionState: (message: string): BillingError =>
    new BillingError('SUBSCRIPTION_STATE', message),

  mandateUnavailable: (currency: string): BillingError =>
    new BillingError(
      'MANDATE_UNAVAILABLE',
      `Automatic renewal is not available for payments in ${currency} yet. You can pay each invoice when it is issued.`
    ),

  mandateRequired: (): BillingError =>
    new BillingError(
      'MANDATE_REQUIRED',
      'Set up automatic payment before turning on automatic renewal.'
    ),

  intentNotFound: (): BillingError =>
    new BillingError('INTENT_NOT_FOUND', 'That payment could not be found.', 404),

  paymentFailed: (message: string): BillingError =>
    new BillingError('PAYMENT_FAILED', message, 402),

  alreadyCancelled: (): BillingError =>
    new BillingError('ALREADY_CANCELLED', 'This subscription is already set to end.'),

  nothingToResume: (): BillingError =>
    new BillingError('NOTHING_TO_RESUME', 'This subscription is not scheduled to end.'),
};
