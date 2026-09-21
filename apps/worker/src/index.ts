import 'dotenv/config';
import { Worker } from 'bullmq';
import pino from 'pino';
import { createDbClient, disconnectDb } from '@rcln/db';
import {
  BILLING_SWEEP_CRON,
  BILLING_SWEEP_JOB,
  INVENTORY_SWEEP_CRON,
  INVENTORY_SWEEP_JOB,
  NOTIFICATION_JOB,
  QUEUE,
  RESERVATION_SWEEP_CRON,
  RESERVATION_SWEEP_JOB,
  createQueues,
  createRedisConnection,
  type BillingJob,
  type QueueName,
} from '@rcln/queue';
import { configureDocumentStore } from '@rcln/documents/store';
import { createSender } from '@rcln/notifications';
import { DOCUMENT_JOB, type InvoicePdfJob } from '@rcln/queue';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { closeBrowser } from './documents/browser.js';
import { renderInvoicePdf } from './documents/invoice-pdf.job.js';
import {
  disconnectPayments,
  initialisePayments,
  runtimeFactory,
  type WorkerPaymentsConfig,
} from './billing/runtime.js';
import { processBillingJob, sweepDueSubscriptions } from './billing/processor.js';
import { alertOnExpiringStock, sweepExpiredStock } from './inventory/expiry.processor.js';
import { sweepDueReservations } from './inventory/reservation.processor.js';
import {
  processNotificationJob,
  type NotificationDeps,
} from './notifications/notification.processor.js';

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
/**
 * The worker's own binding of the notification sender.
 *
 * ⚠️ IT MIRRORS THE API'S, and must stay in step with it for the same reason
 *   `paymentsConfig` does: both read the same variables from the same `.env`,
 *   and a worker sending from a different address — or through a relay the API
 *   does not know about — is a delivery the clinic cannot account for. The
 *   IMPLEMENTATION is shared (`@rcln/notifications`); only the configuration is
 *   read twice, because a worker cannot import an app's config.
 */
const notificationDeps: NotificationDeps = {
  sender: createSender(
    {
      provider: process.env['EMAIL_PROVIDER'] === 'smtp' ? 'smtp' : 'console',
      from: process.env['EMAIL_FROM'] ?? 'noreply@rcln.local',
      isProduction: process.env['NODE_ENV'] === 'production',
      smtp: {
        host: process.env['SMTP_HOST'] ?? 'mailpit',
        port: Number(process.env['SMTP_PORT'] ?? 1025),
        secure: process.env['SMTP_SECURE'] === 'true',
        user: optional(process.env['SMTP_USER']),
        password: optional(process.env['SMTP_PASSWORD']),
      },
    },
    logger
  ),
  logger,
  webUrl: process.env['WEB_URL'] ?? 'http://lvh.me:3000',
};

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

/*
 * Where documents are written.
 *
 * ⚠️ THE SAME FOLDER AS THE API, AT THE SAME PATH. The worker writes the invoice
 *   PDF and the API serves it, from one host folder bind-mounted identically
 *   into both containers — which is what `STORAGE_LOCAL_PATH` being a single
 *   variable is for. Point the two anywhere different and NOTHING FAILS HERE:
 *   the bytes are written, the `files` row says READY, and the download 404s.
 *
 * ⚠️ AND A RELATIVE PATH IS ANCHORED TO THE REPO ROOT, NEVER `cwd`. This process
 *   runs from `apps/worker` and the API from `apps/api`, so `resolve('./x')`
 *   gives the two different folders. That was a real bug, found by probing the
 *   running container rather than by any test, because every test pointed
 *   storage at a temp directory. Compose requires an absolute path, so this only
 *   bites a native run — but it has to hold there too.
 */
const workerRepoRoot = new URL('../../../', import.meta.url).pathname;
const storageLocalPath = process.env['STORAGE_LOCAL_PATH'] ?? './storage/documents';

configureDocumentStore({
  provider: process.env['STORAGE_PROVIDER'] === 's3' ? 's3' : 'local',
  local: {
    rootDir: isAbsolute(storageLocalPath)
      ? storageLocalPath
      : resolvePath(workerRepoRoot, storageLocalPath),
  },
  s3: {
    bucket: optional(process.env['S3_BUCKET']) ?? '',
    region: optional(process.env['S3_REGION']) ?? '',
    keyPrefix: optional(process.env['S3_KEY_PREFIX']),
  },
  logger,
});

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
  /**
   * Rendering.
   *
   * ⚠️ THIS IS THE ONLY QUEUE THAT LAUNCHES A BROWSER, WHICH IS WHY IT IS THE
   *   ONLY ONE THAT MATTERS FOR THE CONTAINER'S MEMORY LIMIT. See the worker's
   *   `mem_limit` in docker-compose and the header of `documents/browser.ts`.
   */
  [QUEUE.DOCUMENTS]: async (jobName, data) => {
    if (jobName === DOCUMENT_JOB.INVOICE_PDF) {
      await renderInvoicePdf(data as InvoicePdfJob, logger);
      return;
    }
    logger.warn({ jobName }, 'unknown document job — no processor for it');
  },

  /**
   * Telling somebody that something happened.
   *
   * ⚠️ THIS HANDLER USED TO LOG "processor not implemented yet", WHICH IS WHY
   *   AN ACCEPTED ORDER TOLD THE PATIENT NOTHING (KNOWN_ISSUES #26, KI-6). The
   *   sender lives in `@rcln/notifications` rather than in the API precisely so
   *   this file can use the same one — see that package's header.
   */
  [QUEUE.NOTIFICATIONS]: async (jobName, data) => {
    await processNotificationJob(jobName, data, notificationDeps);
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

  /**
   * The expiry clock.
   *
   * ⚠️ THE FIRST PROCESSOR IN THIS WORKER THAT CHANGES CLINICAL STATE. Documents
   *   render a PDF of a decision already made and billing charges a card; this
   *   one moves stock out of the dispensable pool, which is the difference
   *   between a pharmacist being offered an expired vial and not.
   *
   * Hourly rather than nightly, because "midnight" is a different instant in
   * every clinic — see INVENTORY_SWEEP_CRON.
   */
  [QUEUE.INVENTORY]: async (jobName) => {
    if (jobName === INVENTORY_SWEEP_JOB) {
      await sweepExpiredStock(logger);
      /*
       * ⚠️ AFTER THE SWEEP, ON THE SAME TICK, AND IT ONLY ENQUEUES. The sweep
       *   moves stock that has already expired; this tells each branch what is
       *   about to, which is the only moment anybody can still act. Running it
       *   second means a lot that expired overnight has already left the
       *   dispensable pool and is not counted twice. The job id caps it at one
       *   mail per branch per day — see `alertOnExpiringStock`.
       */
      await alertOnExpiringStock(logger, async (job, id) => {
        await queues[QUEUE.NOTIFICATIONS].add(NOTIFICATION_JOB.STOCK_EXPIRING, job, { jobId: id });
      });
      return;
    }
    /*
     * The reservation clock (PI-3.4), on the same queue and running the
     * opposite direction: expiry moves stock OUT of the dispensable pool, this
     * moves it back IN. Two jobs rather than two steps of one, so a failure in
     * either does not take the other's work with it — see RESERVATION_SWEEP_JOB.
     */
    if (jobName === RESERVATION_SWEEP_JOB) {
      await sweepDueReservations(logger);
      return;
    }
    logger.warn({ jobName }, 'unknown inventory job — no processor for it');
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
      /*
       * Documents run one at a time for a different reason than billing does.
       * Billing is serial because gateways rate-limit per merchant; rendering is
       * serial because each job holds a Chromium renderer process, and five of
       * those in a container sized for one is the OOM this whole placement
       * decision was made to avoid.
       */
      concurrency: name === QUEUE.BILLING || name === QUEUE.DOCUMENTS ? 1 : 5,
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

  const inventory = queues[QUEUE.INVENTORY];
  await inventory.add(
    INVENTORY_SWEEP_JOB,
    {},
    {
      repeat: { pattern: INVENTORY_SWEEP_CRON },
      // Idempotent and cheap: a missed hour is picked up by the next one, and
      // re-running finds only what is still sitting in the AVAILABLE bucket. So
      // there is no value in retrying a failed sweep aggressively — and the
      // processor already catches per branch, so a failure here means the
      // discovery query itself failed.
      attempts: 2,
      removeOnComplete: { count: 24 },
    }
  );
  logger.info({ cron: INVENTORY_SWEEP_CRON }, 'expiry sweep scheduled');

  await inventory.add(
    RESERVATION_SWEEP_JOB,
    {},
    {
      // Offset from the expiry sweep so the two do not contend for the same
      // advisory bucket locks at every clinic on the hour. Idempotent and cheap
      // for the same reasons, so the same shallow retry.
      repeat: { pattern: RESERVATION_SWEEP_CRON },
      attempts: 2,
      removeOnComplete: { count: 24 },
    }
  );
  logger.info({ cron: RESERVATION_SWEEP_CRON }, 'reservation sweep scheduled');
}

void scheduleRecurring().catch((err: unknown) => {
  logger.error({ err }, 'failed to schedule the recurring sweeps');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  // Before the process exits, or Chromium is orphaned and keeps its memory.
  await closeBrowser();
  await connection.quit();
  await disconnectPayments();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
