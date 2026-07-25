import { createDbClient, assertRlsActive, disconnectDb } from '@rcln/db';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Initialise the shared DB client.
 *
 * Note what is NOT exported here: a raw, unscoped client. Services must go
 * through `withTenant(ctx, …)` so the RLS session variables are set. The
 * no-restricted-imports rule in @rcln/config/eslint-node enforces that.
 */
export async function initDatabase(): Promise<void> {
  createDbClient({
    url: config.databaseUrl,
    maxConnections: config.databasePoolSize,
    logQueries: config.isDevelopment,
  });

  // Fails loudly if DATABASE_URL points at the owner or a superuser, either of
  // which would silently disable every tenant policy.
  await assertRlsActive();
  logger.info('database connected — RLS verified active');
}

export { disconnectDb };
export { withTenant, forTenant, type TenantContext } from '@rcln/db';
