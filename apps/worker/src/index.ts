import 'dotenv/config';
import { Worker } from 'bullmq';
import pino from 'pino';
import { createDbClient, disconnectDb } from '@rcln/db';
import { QUEUE, createRedisConnection, type QueueName } from './queues.js';

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

const connection = createRedisConnection(redisUrl);
const workers: Worker[] = [];

/**
 * Processors land here as each phase is built. Registering the queues now means
 * jobs enqueued by the API are durably held rather than dropped — BullMQ keeps
 * them until a processor exists.
 */
const PROCESSORS: Partial<Record<QueueName, (jobName: string, data: unknown) => Promise<void>>> = {
  [QUEUE.NOTIFICATIONS]: async (jobName, data) => {
    logger.info({ jobName, data }, 'notification job received — processor not implemented yet');
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
    { connection, concurrency: 5 }
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

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
