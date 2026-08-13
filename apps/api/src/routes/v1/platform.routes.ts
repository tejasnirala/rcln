import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  approveRulePackRequest,
  createJurisdictionRequest,
  createRegulatoryAuthorityRequest,
  createRegulatoryRuleRequest,
  createRegulatorySourceRequest,
  createRulePackRequest,
  createTaxRegistrationRequest,
  createTaxRuleDefaultRequest,
  jurisdictionQuery,
  regulatoryAuthorityQuery,
  regulatoryRuleQuery,
  regulatorySourceQuery,
  rulePackQuery,
  updateJurisdictionRequest,
  updateRegulatoryAuthorityRequest,
  updateRegulatoryRuleRequest,
  updateRegulatorySourceRequest,
  updateRulePackRequest,
  impersonateRequest,
  registerOrganizationRequest,
  updateTaxRegistrationRequest,
  updateTaxRuleDefaultRequest,
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
import {
  approveRulePack,
  createAuthority,
  createJurisdiction,
  createRule,
  createRulePack,
  createSource,
  listAuthoritiesForPlatform,
  listJurisdictionsForPlatform,
  listRulePacksForPlatform,
  listRulesForPlatform,
  listSourcesForPlatform,
  updateAuthority,
  updateJurisdiction,
  updateRule,
  updateRulePack,
  updateSource,
} from '../../services/platform/regulatory.service.js';
import {
  createTaxRuleDefault,
  listTaxRuleDefaults,
  retireTaxRuleDefault,
  updateTaxRuleDefault,
} from '../../services/platform/tax-rule-default.service.js';
import { paymentProvider } from '../../services/billing/provider.js';
import { AuthenticationError } from '../../utils/errors.js';
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

// ---------------------------------------------------------------------------
// Default tax rules
// ---------------------------------------------------------------------------

/**
 * The rate cards every clinic inherits until it overrides them.
 *
 * ⚠️ THESE ROUTES CHANGE WHAT EVERY CLINIC IN A COUNTRY CHARGES, WITH NO PUBLISH
 *   STEP. Inheritance is resolved at read time, so a POST here reaches the next
 *   invoice raised anywhere in that jurisdiction by a clinic that has not
 *   overridden the category. That is the point — one row when a rate
 *   notification lands, rather than a migration across every tenant — and it is
 *   why `sourceNote` is required rather than optional.
 *
 * ⚠️ THERE IS NO DELETE, DELIBERATELY. A rate that has stopped applying is
 *   `PATCH /retire` with an end date. An invoice issued last year has to stay
 *   explicable, and the row that priced it is the explanation — removing it does
 *   not un-charge the tax, it only makes the charge unaccountable to whoever
 *   asks years later. Contrast the registrations above, which do have a DELETE:
 *   a registration entered in error asserts a legal fact that was never true,
 *   and leaving it live keeps collecting tax nobody can remit.
 *
 * Same permission as the registrations console. Both answer to whoever is
 * accountable for what rcln asserts about tax.
 */
const taxRuleDefaultParams = z.object({ id: z.uuid() });
const taxRuleDefaultQuery = z.object({
  /** Narrow to one country. The console is per-country; the API need not be. */
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
});
const retireTaxRuleDefaultBody = z.object({
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
});

router.get(
  '/tax-rule-defaults',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(taxRuleDefaultQuery, 'query'),
  async (req: Request, res: Response) => {
    const { countryCode } = req.query as unknown as z.infer<typeof taxRuleDefaultQuery>;
    sendSuccess(res, await listTaxRuleDefaults(countryCode), 'Default tax rules');
  }
);

router.post(
  '/tax-rule-defaults',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(createTaxRuleDefaultRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createTaxRuleDefault(
      req.body as z.infer<typeof createTaxRuleDefaultRequest>
    );
    sendSuccess(res, created, 'Default tax rule added', 201);
  }
);

router.patch(
  '/tax-rule-defaults/:id',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(taxRuleDefaultParams, 'params'),
  validate(updateTaxRuleDefaultRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof taxRuleDefaultParams>;
    const updated = await updateTaxRuleDefault(
      id,
      req.body as z.infer<typeof updateTaxRuleDefaultRequest>
    );
    sendSuccess(res, updated, 'Default tax rule updated');
  }
);

router.patch(
  '/tax-rule-defaults/:id/retire',
  authorize(PERMISSIONS.PLATFORM_TAX_MANAGE),
  validate(taxRuleDefaultParams, 'params'),
  validate(retireTaxRuleDefaultBody, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof taxRuleDefaultParams>;
    const { effectiveTo } = req.body as z.infer<typeof retireTaxRuleDefaultBody>;
    sendSuccess(res, await retireTaxRuleDefault(id, effectiveTo), 'Default tax rule retired');
  }
);

// ===========================================================================
// The regulatory console (PI-5)
//
// ⚠️ A WRITE HERE CHANGES WHAT EVERY CLINIC IN A JURISDICTION IS EVALUATED
//   AGAINST, IMMEDIATELY. No publish step, no cache: the engine loads these rows
//   at decision time. Same posture as `/tax-rule-defaults` above, and one degree
//   worse in consequence — a wrong rate is a wrong number on a document, a wrong
//   rule is a medicine handed over that should not have been.
//
// ⚠️ **DO NOT INVENT LEGAL RULES.** `regulatory_rules.source_id` is NOT NULL and
//   a source is the REGULATOR'S OWN PUBLICATION. If one cannot be found, the
//   rule is not written and the matrix cell stays `RESEARCH_REQUIRED`.
//
// ⚠️ `PATCH /rule-packs/:id/approve` IS THE ONLY PATH TO `REGULATORY_REVIEWED`
//   AND `PRODUCTION_ENABLED`, and it is gated on `regulatory.pack.approve` —
//   a code NO system role holds, granted to a named human out of band (OD-5).
//   Every other endpoint here accepts only `codeSettableMaturity`, in which
//   those two states cannot be expressed (PI-ADR-009).
// ===========================================================================

const regulatoryIdParams = z.object({ id: z.uuid() });
const rulePackIdParams = z.object({ packId: z.uuid() });

const REGULATORY_MANAGE = PERMISSIONS.REGULATORY_MANAGE;

router.get(
  '/regulatory/jurisdictions',
  authorize(REGULATORY_MANAGE),
  validate(jurisdictionQuery, 'query'),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listJurisdictionsForPlatform(req.query as unknown as z.infer<typeof jurisdictionQuery>)
    );
  }
);

router.post(
  '/regulatory/jurisdictions',
  authorize(REGULATORY_MANAGE),
  validate(createJurisdictionRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createJurisdiction(req.body as z.infer<typeof createJurisdictionRequest>);
    res.status(201);
    sendSuccess(res, created, 'Jurisdiction created');
  }
);

router.patch(
  '/regulatory/jurisdictions/:id',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryIdParams, 'params'),
  validate(updateJurisdictionRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    sendSuccess(
      res,
      await updateJurisdiction(id, req.body as z.infer<typeof updateJurisdictionRequest>),
      'Jurisdiction updated'
    );
  }
);

router.get(
  '/regulatory/authorities',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryAuthorityQuery, 'query'),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listAuthoritiesForPlatform(
        req.query as unknown as z.infer<typeof regulatoryAuthorityQuery>
      )
    );
  }
);

router.post(
  '/regulatory/authorities',
  authorize(REGULATORY_MANAGE),
  validate(createRegulatoryAuthorityRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createAuthority(
      req.body as z.infer<typeof createRegulatoryAuthorityRequest>
    );
    res.status(201);
    sendSuccess(res, created, 'Regulatory authority created');
  }
);

router.patch(
  '/regulatory/authorities/:id',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryIdParams, 'params'),
  validate(updateRegulatoryAuthorityRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    sendSuccess(
      res,
      await updateAuthority(id, req.body as z.infer<typeof updateRegulatoryAuthorityRequest>),
      'Regulatory authority updated'
    );
  }
);

router.get(
  '/regulatory/sources',
  authorize(REGULATORY_MANAGE),
  validate(regulatorySourceQuery, 'query'),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listSourcesForPlatform(req.query as unknown as z.infer<typeof regulatorySourceQuery>)
    );
  }
);

router.post(
  '/regulatory/sources',
  authorize(REGULATORY_MANAGE),
  validate(createRegulatorySourceRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createSource(req.body as z.infer<typeof createRegulatorySourceRequest>);
    res.status(201);
    sendSuccess(res, created, 'Source recorded');
  }
);

router.patch(
  '/regulatory/sources/:id',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryIdParams, 'params'),
  validate(updateRegulatorySourceRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    sendSuccess(
      res,
      await updateSource(id, req.body as z.infer<typeof updateRegulatorySourceRequest>),
      'Source updated'
    );
  }
);

router.get(
  '/regulatory/rule-packs',
  authorize(REGULATORY_MANAGE),
  validate(rulePackQuery, 'query'),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listRulePacksForPlatform(req.query as unknown as z.infer<typeof rulePackQuery>)
    );
  }
);

router.post(
  '/regulatory/rule-packs',
  authorize(REGULATORY_MANAGE),
  validate(createRulePackRequest, 'body'),
  async (req: Request, res: Response) => {
    const created = await createRulePack(req.body as z.infer<typeof createRulePackRequest>);
    res.status(201);
    sendSuccess(res, created, 'Rule pack created');
  }
);

router.patch(
  '/regulatory/rule-packs/:id',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryIdParams, 'params'),
  validate(updateRulePackRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    sendSuccess(
      res,
      await updateRulePack(id, req.body as z.infer<typeof updateRulePackRequest>),
      'Rule pack updated'
    );
  }
);

/**
 * A named human signing a jurisdiction off (OD-5, PI-ADR-009).
 *
 * ⚠️ `REGULATORY_PACK_APPROVE`, NOT `REGULATORY_MANAGE`, AND THAT IS THE WHOLE
 *   POINT OF THIS ENDPOINT EXISTING SEPARATELY. Whoever maintains the rules is
 *   not thereby whoever may declare them reviewed; the code is held by counsel,
 *   a retained consultant or a registered pharmacist, and by nobody by default.
 */
router.patch(
  '/regulatory/rule-packs/:id/approve',
  authorize(PERMISSIONS.REGULATORY_PACK_APPROVE),
  validate(regulatoryIdParams, 'params'),
  validate(approveRulePackRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    const actorUserId = req.auth?.userId;
    if (!actorUserId) throw new AuthenticationError('Authentication required');

    sendSuccess(
      res,
      await approveRulePack(id, req.body as z.infer<typeof approveRulePackRequest>, actorUserId),
      'Rule pack sign-off recorded'
    );
  }
);

router.get(
  '/regulatory/rules',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryRuleQuery, 'query'),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listRulesForPlatform(req.query as unknown as z.infer<typeof regulatoryRuleQuery>)
    );
  }
);

router.post(
  '/regulatory/rule-packs/:packId/rules',
  authorize(REGULATORY_MANAGE),
  validate(rulePackIdParams, 'params'),
  validate(createRegulatoryRuleRequest, 'body'),
  async (req: Request, res: Response) => {
    const { packId } = req.params as unknown as z.infer<typeof rulePackIdParams>;
    const created = await createRule(
      packId,
      req.body as z.infer<typeof createRegulatoryRuleRequest>
    );
    res.status(201);
    sendSuccess(res, created, 'Rule added');
  }
);

router.patch(
  '/regulatory/rules/:id',
  authorize(REGULATORY_MANAGE),
  validate(regulatoryIdParams, 'params'),
  validate(updateRegulatoryRuleRequest, 'body'),
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as z.infer<typeof regulatoryIdParams>;
    sendSuccess(
      res,
      await updateRule(id, req.body as z.infer<typeof updateRegulatoryRuleRequest>),
      'Rule updated'
    );
  }
);

export default router;
