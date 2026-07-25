import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { generalLimiter } from './middleware/rateLimiter.middleware.js';
import { resolveTenant } from './middleware/tenant.middleware.js';
import routes from './routes/index.js';

/**
 * Middleware order is the security model. Do not reorder casually:
 *
 *   1. helmet / cors      reject before doing any work
 *   2. body parsing
 *   3. request id + logging
 *   4. rate limiting      cheap rejection before touching the database
 *   5. resolveTenant      host -> organization (Redis-cached)
 *   6. routes             authenticate -> authorize -> withTenant -> handler
 *   7. 404, then errors
 */
export const createApp = (): Express => {
  const app = express();

  // Behind an ALB/Cloudflare, req.ip must come from X-Forwarded-For or every
  // rate limit keys on the proxy's address and applies to all users at once.
  app.set('trust proxy', config.isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // CSP off in dev so Swagger UI loads; helmet's default applies in prod.
      ...(config.isProduction ? {} : { contentSecurityPolicy: false as const }),
      crossOriginResourcePolicy: { policy: 'same-site' as const },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    })
  );

  app.use(
    cors({
      /**
       * Tenants live on wildcard subdomains, so a static list cannot work. Any
       * subdomain of ROOT_DOMAIN is allowed here; the tenant's actual existence
       * is settled by resolveTenant, and a custom domain must additionally be
       * verified in organization_domains.
       */
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // curl, server-to-server
        if (config.cors.origins.includes(origin)) return callback(null, true);

        try {
          const { hostname } = new URL(origin);
          if (hostname === config.rootDomain || hostname.endsWith(`.${config.rootDomain}`)) {
            return callback(null, true);
          }
        } catch {
          /* malformed Origin falls through to the rejection below */
        }

        logger.warn({ origin }, 'CORS origin rejected');
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(compression());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' ? existing : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Health checks would otherwise dominate the logs.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') ?? false,
      },
    })
  );

  app.use(generalLimiter);
  app.use(resolveTenant);

  app.use('/api', routes);

  app.get('/', (req: Request, res: Response) => {
    res.json({
      name: 'rcln API',
      version: '0.1.0',
      tenant: req.tenant?.slug ?? null,
    });
  });

  app.use(notFoundHandler);
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    errorHandler(err, req, res, next);
  });

  return app;
};
