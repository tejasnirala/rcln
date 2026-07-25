import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initDatabase, disconnectDb } from './db/prisma.js';
import { disconnectRedis } from './utils/redis.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

const startServer = async (): Promise<void> => {
  try {
    // Verifies the connection is a non-owner role with RLS in effect. If it is
    // not, this throws and the process never serves a request — which is the
    // point: silently-disabled tenant isolation is worse than being down.
    await initDatabase();

    const app = createApp();
    const server = app.listen(config.port, config.host, () => {
      logger.info(
        { port: config.port, env: config.env, rootDomain: config.rootDomain },
        'api listening'
      );
    });

    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'shutting down');

      const force: NodeJS.Timeout = setTimeout((): void => {
        logger.error('forced shutdown after timeout');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      force.unref();

      server.close((): void => {
        void (async (): Promise<void> => {
          try {
            await disconnectDb();
            await disconnectRedis();
            logger.info('shutdown complete');
            process.exit(0);
          } catch (error) {
            logger.error({ error }, 'error during shutdown');
            process.exit(1);
          }
        })();
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error }, 'failed to start server');
    process.exit(1);
  }
};

void startServer();
