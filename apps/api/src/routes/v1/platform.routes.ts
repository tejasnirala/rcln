import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createTaxRegistrationRequest,
  impersonateRequest,
  registerOrganizationRequest,
  updateTaxRegistrationRequest,
  type ImpersonateRequest,
  type PlatformOrganizationListResponse,
  type PlatformSubscriptionView,
  type RegisterOrganizationResponse,
} from '@rcln/contracts';
import { withTenant } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { listInvoices, loadSubscription, toSubscriptionView } from '@rcln/billing';
import { PERMISSIONS } from '@rcln/permissions';
import { authenticate, authorize, requirePlatformAdmin } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { registerOrganization } from '../../services/organization/register.service.js';
import { startImpersonation } from '../../services/platform/impersonation.service.js';
import {
  createTaxRegistration,
  deleteTaxRegistration,
  listTaxRegistrations,
  updateTaxRegistration,
} from '../../services/platform/tax-registration.service.js';
import { paymentProvider } from '../../services/billing/provider.js';
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

/**
 * One clinic's billing, for the support desk.
 *
 * READ-ONLY, AND DELIBERATELY SO. A super admin who needs to change a plan does
 * it the way the clinic would — through impersonation, which writes an audit row
 * naming the real admin and their stated reason (ADR-0012). A console endpoint
 * that mutated billing directly would be the one billing change with no
 * attributable actor.
 *
 * ⚠️ IT READS ANOTHER TENANT'S ROWS, SO IT GOES THROUGH `withTenant`.
 *   `unsafeDbClient()` is right for the platform-wide LISTS above — there is no
 *   single organization to scope them to. This is the opposite case: exactly one
 *   organization, named in the path. Scoping it means the RLS policies still
 *   apply, and a typo in the query cannot return somebody else's invoices.
 *
 * The view carries no more instrument detail than the clinic's own screen: a
 * support desk needs to know whether a clinic is past due, not what card it
 * holds.
 */
router.get(
  '/organizations/:organizationId/subscription',
  authorize(PERMISSIONS.PLATFORM_SUBSCRIPTION_MANAGE),
  validate(z.object({ organizationId: z.uuid() }), 'params'),
  async (req: Request, res: Response) => {
    const organizationId = req.params['organizationId'] as string;
    const auth = req.auth as NonNullable<Request['auth']>;

    // A context for a tenant this user is not a member of. That is exactly what
    // a platform admin is, and the reads below are scoped by it rather than by
    // the caller's own memberships.
    const ctx = { organizationId, branchIds: [], userId: auth.userId };

    const view = await withTenant(ctx, async (tx) => {
      const subscription = await loadSubscription(tx, ctx);
      return {
        organizationId,
        subscription: subscription ? toSubscriptionView(subscription, paymentProvider()) : null,
        invoices: await listInvoices(tx, ctx),
      } satisfies PlatformSubscriptionView;
    });

    sendSuccess(res, view, 'Subscription');
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

// ---------------------------------------------------------------------------
// Tax registrations
// ---------------------------------------------------------------------------

/**
 * Where rcln collects tax.
 *
 * ⚠️ THESE FOUR ROUTES CHANGE WHAT EVERY CLINIC IS CHARGED, WITH NO PUBLISH STEP.
 *   The tax engine reads this table on every invoice. A POST here starts adding
 *   tax to the next checkout in that jurisdiction; a DELETE stops it. There is
 *   no draft state, deliberately — a registration is a real-world fact with a
 *   date, and `effectiveFrom` is how you schedule one rather than a workflow.
 *
 * `authorize(PLATFORM_TAX_MANAGE)` is belt and braces — `requirePlatformAdmin`
 * ran at the top of this router and `authorize` bypasses for a platform admin —
 * but it is written out so the permission governing this appears at the route,
 * where a reader looks for it, rather than only in the seed.
 */
const taxRegistrationParams = z.object({ id: z.uuid() });

router.get(
  '/tax-registrations',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  async (_req: Request, res: Response) => {
    sendSuccess(res, await listTaxRegistrations(), 'Tax registrations');
  }
);

router.post(
  '/tax-registrations',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(createTaxRegistrationRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createTaxRegistration(
      req.body as z.infer<typeof createTaxRegistrationRequest>
    );
    sendSuccess(res, created, 'Tax registration added', 201);
  }
);

router.patch(
  '/tax-registrations/:id',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(taxRegistrationParams, 'params'),
  validate(updateTaxRegistrationRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof taxRegistrationParams>;
    const updated = await updateTaxRegistration(
      id,
      req.body as z.infer<typeof updateTaxRegistrationRequest>
    );
    sendSuccess(res, updated, 'Tax registration updated');
  }
);

router.delete(
  '/tax-registrations/:id',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(taxRegistrationParams, 'params'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof taxRegistrationParams>;
    await deleteTaxRegistration(id);
    sendSuccess(res, null, 'Tax registration removed');
  }
);

export default router;
