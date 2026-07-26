import { Router, type IRouter, type Request, type Response } from 'express';
import {
  checkSlugQuery,
  demoRequestInput,
  registerOrganizationRequest,
  type CheckSlugQuery,
  type DemoRequestInput,
  type RegisterOrganizationRequest,
  type RegisterOrganizationResponse,
  type SlugAvailabilityResponse,
} from '@rcln/contracts';
import { unsafeDbClient } from '@rcln/db/unsafe';
import {
  publicFormLimiter,
  registrationLimiter,
  slugCheckLimiter,
} from '../../middleware/rateLimiter.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  isSlugAvailable,
  registerOrganization,
} from '../../services/organization/register.service.js';
import { sendSuccess } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

/**
 * Public, unauthenticated routes served from the apex domain (rcln.com).
 *
 * Everything here is pre-tenant. `resolveTenant` runs app-wide and deliberately
 * skips the lookup on the root domain, so `req.tenant` is absent by design —
 * do NOT add `requireTenant` to this router, and do not reach for `withTenant`,
 * because there is no tenant to scope to.
 *
 * That makes `@rcln/db/unsafe` correct here rather than a shortcut. It is the
 * sanctioned pre-tenant escape hatch, and `demo_requests` is a table with no
 * `organization_id` at all — see the exemption recorded in
 * packages/db/prisma/rls/enable-rls.sql.
 */

const router: IRouter = Router();

/** Scripts submit the instant the DOM exists; people take longer than this. */
const MIN_FILL_MS = 2_500;

/** One clinic re-submitting inside this window is the same lead, not a new one. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The referring site, host only.
 *
 * Never the full URL: a referrer's path and query can carry anything the other
 * site put there, and this column is not the place to find out.
 */
function refererHost(req: Request): string | undefined {
  const referer = req.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).hostname.slice(0, 255);
  } catch {
    return undefined;
  }
}

router.post(
  '/demo-requests',
  publicFormLimiter,
  validate(demoRequestInput, 'body'),
  async (req: Request, res: Response) => {
    const input = req.body as DemoRequestInput;

    /**
     * One response for every well-formed submission.
     *
     * Discarded as spam, deduplicated, or genuinely stored — the caller cannot
     * tell which. Saying "we already have you" would turn this into a way to
     * ask whether a given clinic is talking to rcln.
     */
    const received = (): void => {
      sendSuccess(res, { received: true as const }, 'Demo booked', 201);
    };

    // Honeypot: the field is hidden from people, so anything in it is a script
    // that filled every input on the page. Accepted, then dropped.
    if (input.website) {
      logger.info({ reason: 'honeypot' }, 'demo request discarded');
      received();
      return;
    }

    if (input.elapsedMs !== undefined && input.elapsedMs < MIN_FILL_MS) {
      logger.info({ reason: 'too_fast', elapsedMs: input.elapsedMs }, 'demo request discarded');
      received();
      return;
    }

    const db = unsafeDbClient();

    const duplicate = await db.demoRequest.findFirst({
      where: {
        email: input.email,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { id: true },
    });

    if (duplicate) {
      logger.info({ demoRequestId: duplicate.id }, 'demo request deduplicated');
      received();
      return;
    }

    // Bind once: under exactOptionalPropertyTypes, calling this inside the
    // conditional spread leaves the type as `string | undefined`, which Prisma's
    // input type rejects.
    const source = refererHost(req);

    const created = await db.demoRequest.create({
      data: {
        clinicName: input.clinicName,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.branchCount !== undefined ? { branchCount: input.branchCount } : {}),
        ...(input.specialty !== undefined ? { specialty: input.specialty } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(source !== undefined ? { source } : {}),
      },
      select: { id: true },
    });

    // Id only. The name, email and phone that just came in stay out of the logs.
    logger.info({ demoRequestId: created.id }, 'demo request stored');
    received();
  }
);

/**
 * Is this subdomain free?
 *
 * Unauthenticated because it has to be — it runs while the account is being
 * typed. Returns a bare boolean and nothing else; see slugCheckLimiter for why
 * the budget matters more than usual here.
 */
router.get(
  '/organizations/check-slug',
  slugCheckLimiter,
  validate(checkSlugQuery, 'query'),
  async (req: Request, res: Response) => {
    const { slug } = req.query as unknown as CheckSlugQuery;
    const available = await isSlugAvailable(slug);

    const body: SlugAvailabilityResponse = { slug, available };
    sendSuccess(res, body, available ? 'Available' : 'Taken');
  }
);

/**
 * Clinic self-registration.
 *
 * Pre-tenant on purpose: this runs on the apex domain, `req.tenant` is absent,
 * and the organization it creates is the tenant. The service explains why that
 * makes `@rcln/db/unsafe` correct here and how the RLS-enforced half of the
 * transaction is handled.
 *
 * No try/catch: Express 5 forwards a rejected promise to the error handler,
 * which already maps a Prisma unique violation (P2002) to 409. A slug or email
 * claimed between the pre-flight check and the COMMIT lands there.
 */
router.post(
  '/organizations/register',
  registrationLimiter,
  validate(registerOrganizationRequest, 'body'),
  async (req: Request, res: Response) => {
    const input = req.body as RegisterOrganizationRequest;

    const result = await registerOrganization(input, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    /**
     * No tokens in this response.
     *
     * The session belongs to the new subdomain, and a cookie must be scoped to
     * the exact host that owns it — one set on the apex would be readable by
     * every other tenant's subdomain. So the browser is sent to `loginUrl` and
     * authenticates there, on the host the session will live on.
     */
    const body: RegisterOrganizationResponse = {
      organizationId: result.organizationId,
      slug: result.slug,
      loginUrl: result.loginUrl,
    };

    sendSuccess(res, body, 'Clinic registered', 201);
  }
);

export default router;
