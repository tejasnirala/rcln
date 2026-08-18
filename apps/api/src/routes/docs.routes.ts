/**
 * The interactive API reference, at `/docs`.
 *
 * ⚠️ MOUNTED ON THE APP RATHER THAN UNDER `/api`, AND AHEAD OF `resolveTenant`.
 *   The reference is not a tenant resource — it describes the API rather than
 *   any clinic's data — and putting it behind the tenant guard would answer 404
 *   on the apex host, which is the host somebody evaluating the product is most
 *   likely to be on. It reads no database.
 *
 * ⚠️ OFF IN PRODUCTION UNLESS `DOCS_ENABLED=true`. See `config.docsEnabled`. The
 *   gate answers 404 rather than 403 for the reason the tenant guard does: a 403
 *   confirms the thing exists.
 *
 * ⚠️ THE RENDERER IS SERVED FROM HERE, NOT FROM A CDN, AND THAT IS NOT
 *   PREFERENCE. Scalar's own integration points its `<script>` at
 *   `cdn.jsdelivr.net`, which fails in exactly the two situations this product
 *   is deployed into: an air-gapped hospital network, and any environment where
 *   helmet's production CSP is in force — `script-src 'self'` blocks the CDN and
 *   the page renders blank with an error only the browser console shows. The
 *   package ships a prebuilt browser bundle; it is served from `/docs/assets`
 *   and the `cdn` option is pointed at it.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import helmet from 'helmet';
import { apiReference } from '@scalar/express-api-reference';

import { config } from '../config/index.js';
import { buildOpenApiDocument } from '../openapi/document.js';

const router: IRouter = Router();

let cached: Record<string, unknown> | null = null;

/**
 * The OpenAPI document, built on first use and kept.
 *
 * Built lazily rather than at boot so a deployment that never serves the
 * reference never pays for it — assembling it walks every router and converts
 * every contract.
 */
export function openApiDocument(): Record<string, unknown> {
  cached ??= buildOpenApiDocument();
  return cached;
}

/** Where the prebuilt Scalar browser bundle lives inside node_modules. */
const scalarAssetsDir = (): string => {
  const require = createRequire(import.meta.url);
  // Resolves to `<pkg>/dist/index.js`; the browser build sits beside it.
  return join(dirname(require.resolve('@scalar/api-reference')), 'browser');
};

router.use((req: Request, res: Response, next: NextFunction): void => {
  if (!config.docsEnabled) {
    // `originalUrl`, not `path`: the latter is relative to this router and would
    // report `/openapi.json` for a request to `/docs/openapi.json`.
    res.status(404).json({
      success: false,
      message: `Route ${req.method} ${req.originalUrl} not found`,
    });
    return;
  }
  next();
});

/*
 * ⚠️ A CSP FOR THIS ROUTE ONLY, AND DELIBERATELY LOOSER THAN THE APP'S.
 *   The reference is a single-page application: it evaluates its own bundle and
 *   carries an inline configuration block, neither of which helmet's default
 *   policy permits. Relaxing the policy app-wide to accommodate one page would
 *   be the wrong trade by a wide margin, so the exception is scoped here — to a
 *   route that renders no tenant data, reads no database, and is off in
 *   production unless somebody turned it on.
 *
 *   Everything still comes from `'self'`: the bundle below, and the document.
 *   `unsafe-inline` covers the configuration block and the renderer's styles;
 *   `connect-src 'self'` is what lets the try-it-out button reach this API and
 *   nothing else.
 */
router.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
  })
);

/** The renderer itself. Immutable, content-addressed filenames — cache hard. */
router.use(
  '/assets',
  express.static(scalarAssetsDir(), {
    immutable: true,
    maxAge: '1y',
    index: false,
    fallthrough: false,
  })
);

/**
 * The machine-readable document.
 *
 * Its own route because a consumer wants it: import it into Postman, Bruno or
 * Insomnia, or generate a typed client from it. The reference below reads it
 * from the same URL.
 */
router.get('/openapi.json', (_req: Request, res: Response): void => {
  res
    .type('application/json')
    .set('Cache-Control', 'no-store')
    .send(JSON.stringify(openApiDocument(), null, 2));
});

router.use(
  '/',
  apiReference({
    url: '/docs/openapi.json',
    cdn: '/docs/assets/standalone.js',
    pageTitle: 'rcln API reference',
    theme: 'purple',
    /*
     * The `Host` header selects the clinic, so the address the reference is
     * being read at is already the right server for a live call — try-it-out
     * from `alpha.lvh.me:5000/docs` reaches `alpha`. Nothing to configure, which
     * is the whole reason the reference is served by the API itself rather than
     * from a static site.
     */
    hideClientButton: false,
  })
);

export default router;
