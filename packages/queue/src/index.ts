/**
 * Queue definitions — the vocabulary the API and the worker share.
 *
 * ⚠️ THIS WAS `apps/worker/src/queues.ts` AND HAD TO LEAVE THE APP, BECAUSE A
 *   QUEUE HAS TWO ENDS. Until the invoice PDF there was only ever one producer
 *   and it was the worker itself — the billing sweep enqueues its own fan-out —
 *   so the definitions could live beside the consumer. The moment the API became
 *   a producer, an app-private module would have forced the queue name, the job
 *   name and the payload shape to be written down twice, in two processes, with
 *   nothing but a code review between them and a job that is enqueued for ever
 *   and consumed by nobody.
 *
 *   That failure is silent in the worst way: `queue.add()` succeeds, the API
 *   returns 201, and the document simply never appears. There is no error
 *   anywhere — the job sits in a queue whose name nothing listens to.
 *
 * ⚠️ THE PAYLOAD TYPES ARE A WIRE FORMAT, NOT AN INTERNAL SHAPE. A job enqueued
 *   by the API of one version is consumed by a worker of another, across a
 *   rolling deploy: the two processes are never restarted at the same instant.
 *   So a field may be ADDED (optional, with the consumer tolerating its absence)
 *   and may not be renamed, retyped or removed without a release in which both
 *   shapes are accepted. Everything here is JSON — no Date, no BigInt, no
 *   Decimal, no Money.
 *
 * ⚠️ AND NO PHI, EVER. A job payload is JSON sitting in Redis, which is
 *   configured `noeviction` and persists to disk, and it is echoed into the log
 *   line of every failure. Ids only — the consumer reads the row it names, under
 *   RLS, exactly as the API would have. A patient name here would be a patient
 *   name in a Redis key dump and in the dead-letter queue for seven days.
 */

import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

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

/**
 * The job names on `QUEUE.DOCUMENTS`.
 *
 * A name per document kind rather than a `documentType` field on one payload,
 * because the payloads genuinely differ — an invoice cites an invoice, a lab
 * report will cite an order — and because BullMQ shows the job name in every
 * log line and dashboard, where `INVOICE_PDF` reads better than `render`.
 */
export const DOCUMENT_JOB = {
  INVOICE_PDF: 'INVOICE_PDF',
} as const;

export type DocumentJobName = (typeof DOCUMENT_JOB)[keyof typeof DOCUMENT_JOB];

/**
 * Render the PDF of an invoice that has already been issued.
 *
 * ⚠️ THE INVOICE IS ALREADY A DOCUMENT BY THE TIME THIS IS ENQUEUED, AND THAT IS
 *   WHY THE JOB CAN FAIL WITHOUT ANYTHING BEING WRONG. Finalisation took the
 *   number, froze the totals and committed; the PDF is a rendering of a decision
 *   already made, not part of making it. A render that fails five times leaves an
 *   ISSUED invoice a clinic can still show on screen, re-print and be paid
 *   against — it does not leave a half-issued one.
 */
export interface InvoicePdfJob {
  organizationId: string;
  branchId: string;
  invoiceId: string;
  /**
   * Who issued the invoice.
   *
   * Lands in `invoice_documents.generated_by`, and is also the `userId` of the
   * tenant context the consumer opens — `withTenant` requires one, because
   * `app.current_user` is what the audit triggers read.
   *
   * ⚠️ REQUIRED, AND A NON-HUMAN PRODUCER WILL HAVE TO DECIDE SOMETHING HERE.
   *   Every render today is raised by the cashier who pressed Issue. A sweep
   *   that re-rendered failed documents would have no actor, and inventing one
   *   would put a fiction in a column an auditor reads — the same problem the
   *   billing runtime solved by having no audit hook at all. It is required
   *   rather than nullable so that decision has to be taken deliberately instead
   *   of being defaulted away by whoever writes the sweep.
   */
  requestedBy: string;
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
 * The name of the repeatable job that asks what has expired.
 *
 * A name and no payload, for the same reason `BILLING_SWEEP_JOB` is one: it
 * carries no organization, because it is the one piece of inventory that
 * deliberately spans every tenant. The per-branch work is discovered inside the
 * processor through a SECURITY DEFINER function rather than fanned out onto
 * `InventoryJob`s — a fan-out would put a branch id in a Redis payload for every
 * clinic on the platform, and buy nothing: the sweep is a handful of indexed
 * statements per branch, not a gateway call.
 */
export const INVENTORY_SWEEP_JOB = 'EXPIRY_SWEEP';

/**
 * How often the expiry clock ticks.
 *
 * ⚠️ HOURLY, NOT NIGHTLY, AND THE REASON IS TIMEZONES. "Midnight" is a different
 *   instant in every clinic this platform serves, and a single nightly run would
 *   be up to a day late for most of them — an Auckland clinic sweeping on UTC
 *   midnight has already been open for thirteen hours. Each tick asks every
 *   branch whether the date has rolled over IN ITS OWN ZONE, so every clinic is
 *   swept within an hour of its own midnight whatever the container's clock says.
 *
 *   The cost of the extra frequency is one indexed query when there is nothing
 *   to do, which is twenty-three hours out of twenty-four.
 */
export const INVENTORY_SWEEP_CRON = '10 * * * *';

/**
 * The reservation clock (PI-3.4). A second repeatable job on the same queue.
 *
 * ⚠️ A SEPARATE JOB AND NOT A SECOND STEP INSIDE THE EXPIRY SWEEP, THOUGH THEY
 *   RUN ON THE SAME QUEUE AND LOOK ALIKE. The two answer different questions of
 *   different tables — one asks which lots have passed a calendar day in the
 *   branch's zone, the other which reservations have passed an instant — and
 *   folding them together would mean one failing takes the other's work with it.
 *   They are also legitimately tunable apart: a clinic wanting reservations
 *   released promptly is not thereby asking for expiry to run more often.
 */
export const RESERVATION_SWEEP_JOB = 'RESERVATION_SWEEP';

/**
 * ⚠️ OFFSET FROM THE EXPIRY SWEEP ON PURPOSE. Both sweeps take advisory bucket
 *   locks, and at :10 on the hour they would contend for the same buckets at
 *   every clinic simultaneously — neither would be wrong, and both would be
 *   slower for no reason. Twenty minutes apart costs nothing: an expired
 *   reservation is released within the hour either way.
 *
 *   Hourly rather than by-the-minute because `expires_at` is chosen in hours or
 *   days by a person holding stock for somebody, never in minutes. A hold that
 *   needed minute precision would be a dispense.
 */
export const RESERVATION_SWEEP_CRON = '30 * * * *';

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

  /**
   * One render per invoice — and a way to ask for another.
   *
   * ⚠️ THE `attempt` ARGUMENT IS NOT DECORATION, AND OMITTING IT ON A RETRY IS A
   *   REGENERATION THAT SILENTLY NEVER RUNS. BullMQ de-duplicates on job id
   *   while a job is queued, active or recently completed, which is exactly what
   *   should happen when a double-clicked Issue button enqueues twice. It is
   *   also what happens to the retry after a FAILED render, where it is the
   *   wrong answer: `queue.add()` resolves, reports the id of the OLD completed
   *   job, and nothing renders. A deliberate regeneration therefore counts.
   */
  invoicePdf: (invoiceId: string, attempt = 1): string =>
    attempt <= 1 ? `invoice-pdf-${invoiceId}` : `invoice-pdf-${invoiceId}-r${String(attempt)}`,

  subscriptionRenewal: (subscriptionId: string, periodEnd: string): string =>
    `renew-${subscriptionId}-${periodEnd}`,
  expirySweep: (branchId: string, date: string): string => `expiry-${branchId}-${date}`,
  /** One billing action per subscription per day. See the sweep's fan-out. */
  billingAction: (action: string, subscriptionId: string, day: string): string =>
    `billing-${action}-${subscriptionId}-${day}`,
};

export { createJobProducer, type EnqueueOptions, type JobProducer } from './producer.js';
