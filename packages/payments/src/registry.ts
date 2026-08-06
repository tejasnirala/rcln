/**
 * Choosing a provider.
 *
 * THE WHOLE POINT, IN ONE FILE
 *   Adding an acquirer is: a file under `providers/`, one entry in `BUILDERS`,
 *   one branch of the config type. Nothing else in this repository names a
 *   provider — not the schema, not a route, not a screen. If a future change
 *   ever needs a `if (provider === 'cashfree')` outside `providers/`, the seam
 *   in `types.ts` is wrong and should be widened instead.
 *
 *   The one exception is `providers/mock.ts`, whose `simulate()` has no analogue
 *   on a real acquirer. The sandbox route narrows to `MockProvider` explicitly
 *   and refuses to run in production — see the header there.
 *
 * ONE INSTANCE PER PROCESS
 *   `getPaymentProvider()` memoises, because a provider holds credentials and a
 *   connection pool and there is no reason to build one per request. `configure`
 *   is called once at boot; calling it again replaces the instance, which is for
 *   tests and nothing else.
 */

import { PaymentConfigurationError } from './errors.js';
import { CashfreeProvider, type CashfreeConfig } from './providers/cashfree.js';
import { MockProvider, type MockConfig } from './providers/mock.js';
import { RazorpayProvider, type RazorpayConfig } from './providers/razorpay.js';
import { isProviderName, type PaymentProvider, type ProviderName, PROVIDERS } from './types.js';

export interface PaymentsConfig {
  provider: ProviderName;
  cashfree?: CashfreeConfig | undefined;
  razorpay?: RazorpayConfig | undefined;
  mock?: MockConfig | undefined;
}

const BUILDERS: Record<ProviderName, (config: PaymentsConfig) => PaymentProvider> = {
  cashfree: (config) => {
    if (!config.cashfree) {
      throw new PaymentConfigurationError('PAYMENT_PROVIDER=cashfree but no Cashfree config given');
    }
    return new CashfreeProvider(config.cashfree);
  },
  razorpay: (config) => {
    if (!config.razorpay) {
      throw new PaymentConfigurationError('PAYMENT_PROVIDER=razorpay but no Razorpay config given');
    }
    return new RazorpayProvider(config.razorpay);
  },
  mock: (config) => {
    if (!config.mock) {
      throw new PaymentConfigurationError('PAYMENT_PROVIDER=mock but no mock config given');
    }
    return new MockProvider(config.mock);
  },
};

/** Build without memoising. For tests, and for anything holding two at once. */
export function createPaymentProvider(config: PaymentsConfig): PaymentProvider {
  const build = BUILDERS[config.provider];
  if (!build) {
    throw new PaymentConfigurationError(
      `unknown payment provider "${config.provider}" — expected one of ${PROVIDERS.join(', ')}`
    );
  }
  return build(config);
}

let instance: PaymentProvider | null = null;

/** Called once at boot, from the app's config module. */
export function configurePayments(config: PaymentsConfig): PaymentProvider {
  instance = createPaymentProvider(config);
  return instance;
}

/**
 * The process's provider.
 *
 * Throws rather than lazily constructing from the environment: this package
 * reads no environment variables at all, so that every app states its own
 * configuration in its own config module where the validation already lives.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!instance) {
    throw new PaymentConfigurationError(
      'configurePayments() has not been called — the process has no payment provider'
    );
  }
  return instance;
}

/** Parse an environment string into a provider name, with a stated default. */
export function providerNameFrom(value: string | undefined, fallback: ProviderName): ProviderName {
  if (!value) return fallback;
  if (!isProviderName(value)) {
    throw new PaymentConfigurationError(
      `PAYMENT_PROVIDER="${value}" is not one of ${PROVIDERS.join(', ')}`
    );
  }
  return value;
}
