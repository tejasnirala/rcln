/**
 * The worker's payment provider and per-organization billing runtime.
 *
 * SAME PROVIDER, SAME STORE, DIFFERENT PROCESS
 *   The worker charges mandates that the API set up, so both processes must
 *   agree about what a charge is. The mock provider's state therefore lives in
 *   Redis and not in memory — an in-memory Map would give the API and the worker
 *   different opinions about whether a clinic has paid, and the symptom would be
 *   a renewal that succeeds in development and cannot be reconciled.
 *
 * NO AUDIT HOOK, DELIBERATELY
 *   A renewal has no request and no human behind it. `audit_logs` names an
 *   actor; inventing one for a scheduler would put a fiction in the one table
 *   that exists to be trusted. The commercial record still lands, in
 *   `subscription_changes`, which is honest about having no actor.
 */

import { Redis } from 'ioredis';
import { unsafeDbClient } from '@rcln/db/unsafe';
import type { BillingRuntime } from '@rcln/billing';
import {
  configurePayments,
  getPaymentProvider,
  providerNameFrom,
  type MockStore,
} from '@rcln/payments';

export interface WorkerPaymentsConfig {
  provider: string | undefined;
  redisUrl: string;
  redisCacheDb: number;
  rootDomain: string;
  webUrl: string;
  webhookBaseUrl: string;
  checkoutPresentation: 'redirect' | 'embedded';
  cashfree: {
    appId: string;
    secretKey: string;
    webhookSecret: string | undefined;
    environment: 'sandbox' | 'production';
  };
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    environment: 'sandbox' | 'production';
    mandateMethod: 'upi' | 'emandate' | 'card';
    mandateAuthAmountMinor: number;
  };
  mockWebhookSecret: string;
}

let cache: Redis | null = null;

function store(config: WorkerPaymentsConfig): MockStore {
  cache ??= new Redis(config.redisUrl, { db: config.redisCacheDb, maxRetriesPerRequest: 3 });
  const client = cache;

  return {
    async read(key: string): Promise<string | null> {
      return client.get(key);
    },
    async write(key: string, value: string, ttlSeconds: number): Promise<void> {
      await client.set(key, value, 'EX', ttlSeconds);
    },
  };
}

export function initialisePayments(config: WorkerPaymentsConfig): void {
  configurePayments({
    provider: providerNameFrom(config.provider, 'mock'),
    cashfree: {
      appId: config.cashfree.appId,
      secretKey: config.cashfree.secretKey,
      webhookSecret: config.cashfree.webhookSecret,
      environment: config.cashfree.environment,
    },
    razorpay: {
      keyId: config.razorpay.keyId,
      keySecret: config.razorpay.keySecret,
      webhookSecret: config.razorpay.webhookSecret,
      environment: config.razorpay.environment,
      mandateMethod: config.razorpay.mandateMethod,
      mandateAuthAmountMinor: config.razorpay.mandateAuthAmountMinor,
    },
    mock: {
      store: store(config),
      // The worker never redirects anybody — it only debits mandates — but the
      // mock requires a checkout URL to construct, so it is given the same one
      // the API uses rather than a placeholder that would be wrong if a future
      // job ever did need it.
      checkoutUrl: `${config.webUrl.replace(/\/$/, '')}/billing/sandbox`,
      webhookSecret: config.mockWebhookSecret,
    },
  });
}

export async function disconnectPayments(): Promise<void> {
  await cache?.quit();
  cache = null;
}

/**
 * A runtime for one organization.
 *
 * The slug is read from `organizations`, which is RLS-exempt — it is the table
 * the tenant is resolved FROM, so an unscoped read of one row by primary key is
 * the intended use, exactly as in `resolveTenant`. It is needed because the
 * engine builds return URLs on the clinic's own subdomain.
 */
export function runtimeFactory(
  config: WorkerPaymentsConfig
): (organizationId: string) => Promise<BillingRuntime> {
  return async (organizationId: string): Promise<BillingRuntime> => {
    const organization = await unsafeDbClient().organization.findUnique({
      where: { id: organizationId },
      select: { slug: true },
    });

    const provider = getPaymentProvider();
    const web = new URL(config.webUrl);
    const tenantUrl = organization
      ? `${web.protocol}//${organization.slug}.${config.rootDomain}${web.port ? `:${web.port}` : ''}`
      : config.webUrl;

    return {
      provider,
      tenantUrl,
      webhookUrl: `${config.webhookBaseUrl.replace(/\/$/, '')}/api/v1/webhooks/payments/${provider.name}`,
      /*
       * Present for completeness and inert here. The worker only ever debits
       * mandates off-session, and `presentation` is ignored on that path — there
       * is no customer and no page. Set from the same variable as the API so the
       * two processes cannot describe the deployment differently.
       */
      checkoutPresentation: config.checkoutPresentation,
      // No audit hook. See the header.
    };
  };
}
