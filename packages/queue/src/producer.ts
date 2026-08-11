/**
 * The producer half of the queue — what a request handler uses.
 *
 * ⚠️ IT DELIBERATELY LEAKS NEITHER `Queue` NOR `Redis`. A signature returning
 *   BullMQ's own types would make `bullmq` and `ioredis` phantom dependencies of
 *   every app that enqueues anything: resolvable today because pnpm hoists
 *   nothing consistently, and a module-not-found on the day the versions
 *   diverge. The API asks for a job to be run; it has no business holding a
 *   connection object it never configured.
 *
 * ⚠️ ONE CONNECTION PER PROCESS, AND IT IS NOT THE ONE THE CACHE USES. BullMQ
 *   needs `maxRetriesPerRequest: null` because it blocks on `BRPOPLPUSH` — a
 *   setting that would be wrong for the request-path cache, where a Redis that
 *   has gone away should fail fast rather than hang a request handler.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { createRedisConnection, DEFAULT_JOB_OPTIONS, QUEUE, type QueueName } from './index.js';

export interface EnqueueOptions {
  /**
   * A deterministic id, so a retried request cannot double-run the job.
   *
   * ⚠️ See `jobId.invoicePdf` for the trap: BullMQ de-duplicates on this while
   *   the job is queued, active OR recently completed, which is right for a
   *   double-clicked button and wrong for a deliberate regeneration.
   */
  jobId?: string | undefined;
}

export interface JobProducer {
  add: (
    queue: QueueName,
    jobName: string,
    data: unknown,
    options?: EnqueueOptions
  ) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A producer over its own connection.
 *
 * Queues are constructed on first use rather than all seven up front — a process
 * that only ever enqueues documents should not hold seven Redis-backed objects
 * for the six it will never touch.
 */
export function createJobProducer(redisUrl: string): JobProducer {
  let connection: Redis | null = null;
  const queues = new Map<QueueName, Queue>();

  const queueFor = (name: QueueName): Queue => {
    connection ??= createRedisConnection(redisUrl);
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async add(queue, jobName, data, options = {}): Promise<void> {
      await queueFor(queue).add(jobName, data, {
        ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      });
    },

    async close(): Promise<void> {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
      await connection?.quit();
      connection = null;
    },
  };
}

/** Re-exported so a caller needs one import rather than two. */
export { QUEUE };
