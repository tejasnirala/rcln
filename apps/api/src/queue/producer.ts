/**
 * The API's one job producer.
 *
 * ⚠️ THE API HAS NEVER ENQUEUED ANYTHING BEFORE THIS, AND THAT IS WHY THE QUEUE
 *   DEFINITIONS HAD TO LEAVE THE WORKER. Until the invoice PDF, the only
 *   producer on any queue was the worker itself — the billing sweep fanning out
 *   to its own processors. `@rcln/queue` is now the shared vocabulary, so the
 *   queue name and the payload shape are written down once for both ends. See
 *   that package's header for what the alternative fails like: a job enqueued
 *   for ever onto a queue nothing listens to, with no error anywhere.
 *
 * ⚠️ MEMOISED, AND ITS CONNECTION IS NOT THE CACHE'S. BullMQ needs
 *   `maxRetriesPerRequest: null` because it blocks on `BRPOPLPUSH`; the
 *   request-path cache in `utils/redis.ts` needs the opposite, because a Redis
 *   that has gone away should fail a lookup fast rather than hang a request
 *   handler holding a database connection.
 */

import { createJobProducer, type JobProducer } from '@rcln/queue';

import { config } from '../config/index.js';

let producer: JobProducer | null = null;

export function getJobProducer(): JobProducer {
  producer ??= createJobProducer(config.redis.url);
  return producer;
}

export async function disconnectJobProducer(): Promise<void> {
  await producer?.close();
  producer = null;
}
