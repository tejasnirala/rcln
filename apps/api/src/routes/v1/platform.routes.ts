import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  impersonateRequest,
  registerOrganizationRequest,
  type ImpersonateRequest,
  type PlatformOrganizationListResponse,
  type RegisterOrganizationResponse,
} from '@rcln/contracts';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { PERMISSIONS } from '@rcln/permissions';
import { authenticate, authorize, requirePlatformAdmin } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { registerOrganization } from '../../services/organization/register.service.js';
import { startImpersonation } from '../../services/platform/impersonation.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * The super-admin console, served from admin.<root-domain>.
 *
 * `resolveTenant` skips the admin host, so `req.tenant` is absent here by
 * design — this router is deliberately outside any tenant. Access is the
 * `users.is_platform_admin` flag and nothing else; `requirePlatformAdmin`
 * answers a caller without it with 404, so the console does not confirm it
 * exists to people who cannot use it.
 *
 * `@rcln/db/unsafe` is correct on this router for the same reason it is correct
 * on public.routes.ts: platform-wide reads span every tenant, so there is no
 * single organization to scope them to. Anything that touches ONE tenant's data
 * must still go through `withTenant` with that tenant's id.
 */

const router: IRouter = Router();

router.use(authenticate, requirePlatformAdmin);

/**
 * Provisioning on a clinic's behalf, typically converting a demo request.
 *
 * Same service, same transaction, same invariants as self-serve signup — only
 * the actor differs, and that difference is what lands in audit_logs.
 */
const provisionRequest = registerOrganizationRequest.extend({
  /** When present, the demo request this organization came from. */
  demoRequestId: z.uuid().optional(),
});

router.post(
  '/organizations',
  validate(provisionRequest, 'body'),
  async (req: Request, res: Response) => {
    const input = req.body as z.infer<typeof provisionRequest>;
    const { demoRequestId, ...registration } = input;

    const result = await registerOrganization(registration, {
      actorUserId: req.auth?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (demoRequestId) {
      // Best effort and deliberately after the fact: the organization exists,
      // and failing to tick a CRM row must not undo a clinic's account.
      await unsafeDbClient().demoRequest.updateMany({
        where: { id: demoRequestId },
        data: { status: 'CONVERTED', handledAt: new Date() },
      });
    }

    const body: RegisterOrganizationResponse = {
      organizationId: result.organizationId,
      slug: result.slug,
      loginUrl: result.loginUrl,
    };

    sendSuccess(res, body, 'Clinic provisioned', 201);
  }
);

/**
 * Every clinic on the platform.
 *
 * The one list in the product that crosses the tenant boundary, which is why it
 * lives here and nowhere else. An rcln operator needs to find an account, not to
 * read its staff directory.
 *
 * `organizations` is RLS-exempt, so the unscoped client can read it. Do NOT add
 * a `_count` over `branches` or `memberships` here: those tables are not exempt,
 * this client sets no session variables, and their policies would evaluate
 * against a NULL organization and return 0 for every clinic — silently. See the
 * note on `platformOrganizationSummary`.
 */
const organizationQuery = z.object({
  /** Matches slug, display name or legal name. */
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  '/organizations',
  authorize(PERMISSIONS.PLATFORM_ORG_READ),
  validate(organizationQuery, 'query'),
  async (req: Request, res: Response) => {
    const { search, limit } = req.query as unknown as z.infer<typeof organizationQuery>;

    const organizations = await unsafeDbClient().organization.findMany({
      where: {
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { slug: { contains: search, mode: 'insensitive' as const } },
                { displayName: { contains: search, mode: 'insensitive' as const } },
                { legalName: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        slug: true,
        displayName: true,
        legalName: true,
        status: true,
        orgType: true,
        createdAt: true,
      },
    });

    const body: PlatformOrganizationListResponse = {
      organizations: organizations.map((org) => ({
        id: org.id,
        slug: org.slug,
        displayName: org.displayName,
        legalName: org.legalName,
        status: org.status,
        orgType: org.orgType,
        createdAt: org.createdAt.toISOString(),
      })),
    };

    sendSuccess(res, body, 'Clinics');
  }
);

/**
 * Enter a clinic as rcln staff.
 *
 * ANSWERS A TICKET, NOT A SESSION. Session cookies are host-only, so this host
 * cannot write one for a clinic's subdomain — the browser carries the ticket
 * across and `POST /auth/impersonation/claim` on the clinic's own host redeems
 * it. See the header of impersonation.service.ts.
 *
 * `authorize` here is belt and braces: `requirePlatformAdmin` already ran, and
 * `authorize` bypasses for a platform admin. It is written out anyway so the
 * permission code that governs this appears at the route, where a reader looks
 * for it, rather than only in the seed.
 */
router.post(
  '/organizations/:organizationId/impersonate',
  authorize(PERMISSIONS.PLATFORM_IMPERSONATE),
  validate(z.object({ organizationId: z.uuid() }), 'params'),
  validate(impersonateRequest, 'body'),
  async (req: Request, res: Response) => {
    const auth = req.auth as NonNullable<Request['auth']>;
    const { reason } = req.body as ImpersonateRequest;

    const grant = await startImpersonation({
      organizationId: req.params['organizationId'] as string,
      adminUserId: auth.userId,
      reason,
    });

    sendSuccess(res, grant, 'Ready to enter', 201);
  }
);

const demoRequestQuery = z.object({
  status: z.enum(['NEW', 'CONTACTED', 'CONVERTED', 'SPAM']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The pipeline view. Platform-admin only — this is every lead in the system. */
router.get(
  '/demo-requests',
  validate(demoRequestQuery, 'query'),
  async (req: Request, res: Response) => {
    const { status, limit } = req.query as unknown as z.infer<typeof demoRequestQuery>;

    const requests = await unsafeDbClient().demoRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        clinicName: true,
        contactName: true,
        email: true,
        phone: true,
        city: true,
        branchCount: true,
        specialty: true,
        message: true,
        status: true,
        createdAt: true,
      },
    });

    sendSuccess(res, requests, 'Demo requests');
  }
);

export default router;
