/**
 * Failures a provider can produce, in three kinds — because the caller's correct
 * response to each is different and it must not have to read a message to work
 * out which.
 */

/** Base. Never thrown directly. */
export class PaymentProviderError extends Error {
  readonly provider: string;
  /** The provider's own code, where it gave one. For the support desk. */
  readonly providerCode: string | undefined;

  constructor(message: string, provider: string, providerCode?: string) {
    super(message);
    this.name = 'PaymentProviderError';
    this.provider = provider;
    this.providerCode = providerCode;
    Object.setPrototypeOf(this, PaymentProviderError.prototype);
  }
}

/**
 * The provider refused, and it will refuse the same request again.
 *
 * A declined card, an amount over the mandate ceiling, a currency the merchant
 * account is not enabled for. Retrying is pointless; the caller must surface it
 * or move to dunning.
 */
export class PaymentDeclinedError extends PaymentProviderError {
  constructor(message: string, provider: string, providerCode?: string) {
    super(message, provider, providerCode);
    this.name = 'PaymentDeclinedError';
    Object.setPrototypeOf(this, PaymentDeclinedError.prototype);
  }
}

/**
 * The request never got a verdict — a timeout, a 5xx, a socket closed.
 *
 * ⚠️ THE MONEY MAY HAVE MOVED. This is not "it failed"; it is "we do not know".
 *   The only safe response is to retry with the SAME reference, so the provider
 *   deduplicates against the order it may already have created, and then to
 *   reconcile with `getCharge` before recording anything. Treating this as a
 *   decline is how a customer is charged twice.
 */
export class PaymentUnavailableError extends PaymentProviderError {
  constructor(message: string, provider: string, providerCode?: string) {
    super(message, provider, providerCode);
    this.name = 'PaymentUnavailableError';
    Object.setPrototypeOf(this, PaymentUnavailableError.prototype);
  }
}

/**
 * A webhook whose signature did not verify, or whose shape could not be read.
 *
 * The route answers 401 and writes nothing. It must never fall back to trusting
 * the body: an unauthenticated webhook endpoint that acts on its payload is a
 * free "mark my subscription paid" button.
 */
export class WebhookVerificationError extends PaymentProviderError {
  constructor(message: string, provider: string) {
    super(message, provider);
    this.name = 'WebhookVerificationError';
    Object.setPrototypeOf(this, WebhookVerificationError.prototype);
  }
}

/** Configuration is missing or nonsensical. Thrown at construction, not at use. */
export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
    Object.setPrototypeOf(this, PaymentConfigurationError.prototype);
  }
}
