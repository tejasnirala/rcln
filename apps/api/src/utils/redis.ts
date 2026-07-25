import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Shared Redis connection: tenant cache, permission cache, rate limits, locks.
 *
 * Deliberately NOT used for clinical data. Only ids and permission metadata go
 * in here — keeping PHI out of the cache shrinks the breach surface and the
 * compliance paperwork that comes with it.
 */
export const redis = new Redis(config.redis.url, {
  db: config.redis.cacheDb,
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err: Error) => logger.error({ err }, 'redis error'));
redis.on('connect', () => logger.info('redis connected'));

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
