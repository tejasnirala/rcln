import 'dotenv/config';
import { Worker } from 'bullmq';
import pino from 'pino';
import { createDbClient, disconnectDb } from '@rcln/db';
import {
  BILLING_SWEEP_CRON,
  BILLING_SWEEP_JOB,
  QUEUE,
  createQueues,
  createRedisConnection,
  type BillingJob,
  type QueueName,
} from './queues.js';
import {
  disconnectPayments,
  initialisePayments,
  runtimeFactory,
  type WorkerPaymentsConfig,
} from './billing/runtime.js';
import { processBillingJob, sweepDueSubscriptions } from './billing/processor.js';

/** An optional variable, where blank means unset. Mirrors the API's config. */
function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  logger.error('DATABASE_URL is required');
  process.exit(1);
}

createDbClient({ url: databaseUrl, logQueries: false });

/**
 * Payments configuration, read once.
 *
 * Mirrors the API's `config.payments`, and must stay in step with it: the worker
 * debits mandates the API set up, so a provider mismatch between the two is a
 * renewal that cannot find the authorisation it is meant to charge. Both read
 * the same environment variables from the same `.env`.
 */
const paymentsConfig: WorkerPaymentsConfig = {
  provider: process.env['PAYMENT_PROVIDER'],
  redisUrl,
  redisCacheDb: Number(process.env['REDIS_CACHE_DB'] ?? 0),
  rootDomain: process.env['ROOT_DOMAIN'] ?? 'lvh.me',
  webUrl: process.env['WEB_URL'] ?? 'http://lvh.me:3000',
  webhookBaseUrl:
    process.env['PAYMENTS_WEBHOOK_BASE_URL'] ?? process.env['API_URL'] ?? 'http://api:5000',
  cashfree: {
    appId: optional(process.env['CASHFREE_APP_ID']) ?? '',
    secretKey: optional(process.env['CASHFREE_SECRET_KEY']) ?? '',
    // Blank means unset. `CASHFREE_WEBHOOK_SECRET=` is `''`, not undefined, and
    // an empty signing key verifies nothing — see the API's getOptionalEnvVar.
    webhookSecret: optional(process.env['CASHFREE_WEBHOOK_SECRET']),
    environment: process.env['CASHFREE_ENVIRONMENT'] === 'production' ? 'production' : 'sandbox',
  },
  checkoutPresentation:
    process.env['PAYMENTS_CHECKOUT_PRESENTATION'] === 'redirect' ? 'redirect' : 'embedded',
  razorpay: {
    keyId: optional(process.env['RAZORPAY_KEY_ID']) ?? '',
    keySecret: optional(process.env['RAZORPAY_KEY_SECRET']) ?? '',
    // No fallback to the API secret, unlike Cashfree — Razorpay's signing secret
    // is chosen in its dashboard and is unrelated. The adapter refuses to
    // construct without it, which is what stops a silent 401 on every delivery.
    webhookSecret: optional(process.env['RAZORPAY_WEBHOOK_SECRET']) ?? '',
    environment: process.env['RAZORPAY_ENVIRONMENT'] === 'production' ? 'production' : 'sandbox',
    mandateMethod:
      process.env['RAZORPAY_MANDATE_METHOD'] === 'emandate'
        ? 'emandate'
        : process.env['RAZORPAY_MANDATE_METHOD'] === 'card'
          ? 'card'
          : 'upi',
    mandateAuthAmountMinor: Number(process.env['RAZORPAY_MANDATE_AUTH_AMOUNT_MINOR'] ?? 0),
  },
  mockWebhookSecret: process.env['MOCK_PAYMENTS_SECRET'] ?? 'mock-payments-development-secret',
};

initialisePayments(paymentsConfig);

const connection = createRedisConnection(redisUrl);
const queues = createQueues(connection);
const workers: Worker[] = [];

const billingDeps = {
  runtimeFor: runtimeFactory(paymentsConfig),
  queues,
  logger,
};

/**
 * Processors land here as each phase is built. Registering the queues means jobs
 * enqueued by the API are durably held rather than dropped — BullMQ keeps them
 * until a processor exists.
 */
const PROCESSORS: Partial<Record<QueueName, (jobName: string, data: unknown) => Promise<void>>> = {
  [QUEUE.NOTIFICATIONS]: async (jobName, data) => {
    logger.info({ jobName, data }, 'notification job received — processor not implemented yet');
  },

  /**
   * The billing clock.
   *
   * One repeatable sweep and a fan-out of per-subscription jobs. Everything it
   * decides comes from `@rcln/billing`, which the API uses too — see the header
   * of billing/processor.ts.
   */
  [QUEUE.BILLING]: async (jobName, data) => {
    if (jobName === BILLING_SWEEP_JOB) {
      await sweepDueSubscriptions(billingDeps);
      return;
    }
    await processBillingJob(data as BillingJob, billingDeps);
  },
};

for (const name of Object.values(QUEUE)) {
  const handler = PROCESSORS[name];
  if (!handler) continue;

  const worker = new Worker(
    name,
    async (job) => {
      await handler(job.name, job.data);
    },
    {
      connection,
      /*
       * Billing runs one at a time.
       *
       * Every job in it makes a call to a payment gateway, and gateways rate-
       * limit per merchant — running five in parallel turns a busy renewal hour
       * into a burst of 429s, which the adapter correctly classifies as "no
       * verdict" and retries, making the burst worse. Serial is fast enough:
       * the work is one clinic's renewal, not a batch.
       */
      concurrency: name === QUEUE.BILLING ? 1 : 5,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ queue: name, jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
  });
  worker.on('completed', (job) => {
    logger.debug({ queue: name, jobId: job.id }, 'job completed');
  });

  workers.push(worker);
  logger.info({ queue: name }, 'worker started');
}

/**
 * Schedule the billing sweep.
 *
 * Repeatable jobs are keyed by name and pattern, so re-registering on every boot
 * is safe and idempotent — a redeploy does not accumulate duplicate schedules.
 */
async function scheduleRecurring(): Promise<void> {
  const billing = queues[QUEUE.BILLING];
  await billing.add(
    BILLING_SWEEP_JOB,
    {},
    {
      repeat: { pattern: BILLING_SWEEP_CRON },
      // The sweep is cheap and idempotent; a missed hour is picked up by the
      // next one, so there is no value in retrying a failed sweep aggressively.
      attempts: 2,
      removeOnComplete: { count: 24 },
    }
  );
  logger.info({ cron: BILLING_SWEEP_CRON }, 'billing sweep scheduled');
}

void scheduleRecurring().catch((err: unknown) => {
  logger.error({ err }, 'failed to schedule the billing sweep');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
  await disconnectPayments();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
