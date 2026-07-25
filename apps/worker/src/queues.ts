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

export interface BillingJob {
  organizationId: string;
  subscriptionId: string;
  action: 'RENEW' | 'DUNNING_RETRY' | 'SUSPEND';
  attempt?: number;
}

export interface InventoryJob {
  organizationId: string;
  branchId: string;
  action: 'EXPIRY_SWEEP' | 'REORDER_CHECK';
}

/** Deterministic ids. `reminder:<appointmentId>:24h` can only ever fire once. */
export const jobId = {
  appointmentReminder: (appointmentId: string, hoursBefore: number): string =>
    `reminder:${appointmentId}:${hoursBefore}h`,
  invoicePdf: (invoiceId: string): string => `invoice-pdf:${invoiceId}`,
  subscriptionRenewal: (subscriptionId: string, periodEnd: string): string =>
    `renew:${subscriptionId}:${periodEnd}`,
  expirySweep: (branchId: string, date: string): string => `expiry:${branchId}:${date}`,
};
