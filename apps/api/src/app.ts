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
import webhookRoutes from './routes/v1/webhooks.routes.js';

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

  /**
   * Trust exactly one hop, in every environment.
   *
   * `req.ip` is what every rate limit keys on, and EVERY request from the web
   * app is server-to-server — so without this the API sees the BFF's address on
   * behalf of every user of every clinic, and the ten-per-fifteen-minutes auth
   * budget becomes ten for the whole platform. That is not theoretical: it was
   * observed as `rl:auth:172.19.0.7` with a count of 14, and it surfaces as
   * "wrong password" and "this invitation expired" for whoever arrives eleventh.
   *
   * Previously `false` outside production, which is why development behaved
   * differently from the thing being developed.
   *
   * `1`, not `true`: trust the single proxy in front of us (the BFF, or the
   * ingress in production) and no further, so `req.ip` is the leftmost address
   * that proxy vouches for. `true` would trust the whole chain and let a client
   * pick its own address by prepending one.
   *
   * SAME TRUST BOUNDARY AS x-forwarded-host, and it is worth stating plainly:
   * anything that can reach this API directly can now choose the address it is
   * rate-limited as. The deployment must keep the API private, behind an ingress
   * that OVERWRITES both headers. See the header of tenant.middleware.ts.
   */
  app.set('trust proxy', 1);
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

  /*
   * ⚠️ WEBHOOKS GO BEFORE THE BODY PARSERS, AND THE ORDER IS LOAD-BEARING.
   *
   * Every payment provider signs the exact bytes it sent. `express.json()`
   * consumes the request stream and hands on a parsed object; re-serialising it
   * reorders keys and changes whitespace, so the HMAC no longer matches — and
   * the failure presents as "wrong secret" rather than as anything to do with
   * this line. The router owns its own `express.raw()`.
   *
   * It is also ahead of `generalLimiter` and `resolveTenant` on purpose: a
   * provider posts from its own infrastructure, on no host we control, and a
   * burst of retries must not be throttled into a disabled endpoint. What
   * protects it is the signature, checked before a single row is read. See the
   * header of webhooks.routes.ts.
   */
  app.use('/api/v1/webhooks', webhookRoutes);

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
