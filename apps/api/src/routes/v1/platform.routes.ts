import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import { registerOrganizationRequest, type RegisterOrganizationResponse } from '@rcln/contracts';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { authenticate, requirePlatformAdmin } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { registerOrganization } from '../../services/organization/register.service.js';
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
