import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Queue definitions.
 *
 * The worker runs as its own container. A Playwright PDF render or a WhatsApp
 * provider timeout must never occupy an API request thread.
 *
 * Every job carries a deterministic jobId so a retry cannot double-send. BullMQ
 * de-duplicates on jobId while the job is in the queue or recently completed —
 * that is what stops a patient getting the same reminder twice.
 */

export const QUEUE = {
  NOTIFICATIONS: 'notifications',
  DOCUMENTS: 'documents',
  REPORTS: 'reports',
  BILLING: 'billing',
  INVENTORY: 'inventory',
  INTEGRATIONS: 'integrations',
  OUTBOX: 'outbox',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  // Keep a window of history for debugging without unbounded growth.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    // BullMQ requires this: it blocks on BRPOPLPUSH and must not give up.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export function createQueues(connection: Redis): Record<QueueName, Queue> {
  const queues = {} as Record<QueueName, Queue>;
  for (const name of Object.values(QUEUE)) {
    queues[name] = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  }
  return queues;
}

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

export interface NotificationJob {
  organizationId: string;
  branchId: string | null;
  eventCode: string;
  recipientType: 'USER' | 'PATIENT';
  recipientId: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH' | 'IN_APP';
  payload: Record<string, unknown>;
}

export interface DocumentJob {
  organizationId: string;
  branchId: string;
  documentType: 'PRESCRIPTION' | 'INVOICE' | 'LAB_REPORT';
  entityId: string;
}

/**
 * One clinic's billing, one job.
 *
 * The fan-out from the hourly sweep. One job per subscription rather than one
 * job per batch, so a single clinic's gateway failure retries on its own
 * backoff and lands in the dead-letter naming exactly who needs a human — rather
 * than taking the rest of the batch down with it.
 */
export interface BillingJob {
  organizationId: string;
  subscriptionId: string;
  action: 'RENEW' | 'DUNNING_RETRY' | 'SUSPEND' | 'EXPIRE_TRIAL' | 'FINALISE_CANCELLATION';
  attempt?: number;
}

/**
 * The name of the repeatable job that asks which subscriptions are due.
 *
 * A name rather than a payload: it carries no organization, because it is the
 * one piece of billing that deliberately spans every tenant. See the header of
 * apps/worker/src/billing/processor.ts.
 */
export const BILLING_SWEEP_JOB = 'SWEEP';

/**
 * How often the billing clock ticks.
 *
 * Hourly, not nightly. A renewal that fails at 02:00 should get its first retry
 * the same morning rather than a day later, and a clinic that pays an overdue
 * invoice should stop being past due within the hour rather than overnight. The
 * sweep is one indexed query when there is nothing to do, so the cost of the
 * extra frequency is negligible.
 */
export const BILLING_SWEEP_CRON = '0 * * * *';

export interface InventoryJob {
  organizationId: string;
  branchId: string;
  action: 'EXPIRY_SWEEP' | 'REORDER_CHECK';
}

/**
 * Deterministic ids. `reminder-<appointmentId>-24h` can only ever fire once.
 *
 * ⚠️ NO COLONS. BullMQ rejects a custom job id containing `:` — it namespaces
 *   its own Redis keys with them — and it does so by throwing at `queue.add()`,
 *   i.e. at runtime, in the producer. These separators were colons; every one of
 *   them would have failed the first time it was used, and the first one to be
 *   used (the billing sweep) did exactly that.
 */
export const jobId = {
  appointmentReminder: (appointmentId: string, hoursBefore: number): string =>
    `reminder-${appointmentId}-${String(hoursBefore)}h`,
  invoicePdf: (invoiceId: string): string => `invoice-pdf-${invoiceId}`,
  subscriptionRenewal: (subscriptionId: string, periodEnd: string): string =>
    `renew-${subscriptionId}-${periodEnd}`,
  expirySweep: (branchId: string, date: string): string => `expiry-${branchId}-${date}`,
  /** One billing action per subscription per day. See the sweep's fan-out. */
  billingAction: (action: string, subscriptionId: string, day: string): string =>
    `billing-${action}-${subscriptionId}-${day}`,
};
