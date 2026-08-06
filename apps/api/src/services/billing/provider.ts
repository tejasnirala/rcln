/**
 * Building the process's payment provider, once, at boot.
 *
 * WHY THIS IS A FILE AND NOT THREE LINES IN `config`
 *   The mock provider needs somewhere durable to keep the state of a charge in
 *   flight, because the API and the worker are separate processes and an
 *   in-memory Map would give them different opinions about whether a clinic has
 *   paid. That store is Redis here, and the adapter between `ioredis` and the
 *   two-method `MockStore` interface is the only thing in this file that is not
 *   configuration.
 *
 *   `@rcln/payments` reads no environment variables and holds no Redis handle,
 *   deliberately — it stays a pure package that a test can construct with a Map.
 */

import {
  configurePayments,
  getPaymentProvider,
  providerNameFrom,
  type MockStore,
  type PaymentProvider,
} from '@rcln/payments';
import { config } from '../../config/index.js';
import { redis } from '../../utils/redis.js';
import { logger } from '../../utils/logger.js';

/** `ioredis`, narrowed to the two operations the mock provider needs. */
const redisMockStore: MockStore = {
  async read(key) {
    return redis.get(key);
  },
  async write(key, value, ttlSeconds) {
    await redis.set(key, value, 'EX', ttlSeconds);
  },
};

/**
 * The sandbox checkout page.
 *
 * A real screen in `apps/web` on the apex, not a stub the provider fakes: the
 * point of the mock is that the operator has to click Approve or Decline, so the
 * return-versus-webhook race and the abandoned-checkout state are reproducible
 * rather than theoretical.
 */
function sandboxCheckoutUrl(): string {
  return `${config.webUrl.replace(/\/$/, '')}/billing/sandbox`;
}

/** Where a provider POSTs outcomes. One path per provider, so routing is trivial. */
export function webhookUrlFor(provider: string): string {
  return `${config.payments.webhookBaseUrl.replace(/\/$/, '')}/api/v1/webhooks/payments/${provider}`;
}

let configured = false;

/**
 * Called once from the server's startup path.
 *
 * Fails the boot rather than the first checkout: a missing Cashfree secret
 * should stop a deployment, not surface at 09:00 as "payment failed" for the
 * first clinic that tries to subscribe.
 */
export function initialisePayments(): PaymentProvider {
  const name = providerNameFrom(config.payments.provider, 'mock');

  const provider = configurePayments({
    provider: name,
    cashfree: {
      appId: config.payments.cashfree.appId,
      secretKey: config.payments.cashfree.secretKey,
      webhookSecret: config.payments.cashfree.webhookSecret,
      environment: config.payments.cashfree.environment,
    },
    razorpay: {
      keyId: config.payments.razorpay.keyId,
      keySecret: config.payments.razorpay.keySecret,
      webhookSecret: config.payments.razorpay.webhookSecret,
      environment: config.payments.razorpay.environment,
      mandateMethod: config.payments.razorpay.mandateMethod,
      mandateAuthAmountMinor: config.payments.razorpay.mandateAuthAmountMinor,
    },
    mock: {
      store: redisMockStore,
      checkoutUrl: sandboxCheckoutUrl(),
      webhookSecret: config.payments.mock.webhookSecret,
    },
  });

  configured = true;
  logger.info(
    {
      provider: provider.name,
      mandates: provider.capabilities.mandates,
      mandateCurrencies: provider.capabilities.mandateCurrencies,
    },
    'payment provider ready'
  );

  return provider;
}

/**
 * The provider, initialising on first use.
 *
 * The lazy path exists for tests and for the integration suite, which builds the
 * app without going through `index.ts`. In the server it has always already been
 * called, so this is a plain lookup.
 */
export function paymentProvider(): PaymentProvider {
  if (!configured) return initialisePayments();
  return getPaymentProvider();
}
