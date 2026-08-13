/**
 * Regulatory, from a clinic's side: reading the law, and asking the engine.
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHICH CODE GATES WHAT ───────────────────────────────────────────────────
 *
 *   jurisdictions, authorities, packs, rules, sources  ->  `regulatory.rule.read`
 *   evaluating a transaction                           ->  `regulatory.rule.read`
 *
 * ⚠️ THERE IS NO WRITE ON THIS ROUTER, AND THAT IS THE WHOLE POINT. A clinic
 *   never writes a rule pack: the law of a country is the same for everybody in
 *   it, `regulatory.rule.manage` is excluded from ORG_OWNER by name in roles.ts,
 *   the console lives on the platform host, and the database's
 *   `platform_law_not_tenant_writable` trigger refuses a write from any
 *   transaction that claims a tenant. Four layers, because the thing being
 *   protected is what every other clinic on the platform is evaluated against.
 *
 *   What a clinic DOES write is its products' regulatory profiles, and those
 *   live on `/v1/products/:productId/regulatory-profiles` — beside the tax
 *   classifications they are the sibling of, gated on
 *   `product.regulatory.manage`.
 *
 * ⚠️ `POST /evaluate` IS A QUESTION, NOT AN AUTHORISATION. It answers "what would
 *   the rules say"; it moves no stock, permits nothing, and is deliberately
 *   gated on the READ code. Whoever eventually ACTS on a decision — PI-7's
 *   dispensing — is gated on the code for that act, and calls the same service
 *   rather than trusting a decision the client sends back.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ NOTHING ON THIS SURFACE TOUCHES IT, INCLUDING THE EVALUATION REQUEST. A
 *   rule needs to know whether somebody is sixteen; it never needs to know who
 *   they are. There is no patient id in the contract, so no handler here calls
 *   `recordDataAccess` — none of them discloses anything about a named person.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  evaluateRegulatoryRequest,
  jurisdictionQuery,
  regulatoryAuthorityQuery,
  regulatoryRuleQuery,
  regulatorySourceQuery,
  rulePackQuery,
  type EvaluateRegulatoryRequest,
  type JurisdictionQuery,
  type RegulatoryAuthorityQuery,
  type RegulatoryRuleQuery,
  type RegulatorySourceQuery,
  type RulePackQuery,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  getRulePack,
  listAuthorities,
  listJurisdictions,
  listRulePacks,
  listRules,
  listSources,
} from '../../services/regulatory/catalogue.service.js';
import { evaluateFor } from '../../services/regulatory/evaluation.service.js';
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import { sendSuccess } from '../../utils/response.js';

const READ = PERMISSIONS.REGULATORY_READ;

const router: IRouter = Router();
router.use(requireTenant, authenticate, requireAuth);

router.get(
  '/jurisdictions',
  authorize(READ),
  validate(jurisdictionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as JurisdictionQuery;
    sendSuccess(res, await listJurisdictions(tenantContextFrom(req), query));
  }
);

router.get(
  '/authorities',
  authorize(READ),
  validate(regulatoryAuthorityQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as RegulatoryAuthorityQuery;
    sendSuccess(res, await listAuthorities(tenantContextFrom(req), query));
  }
);

router.get(
  '/sources',
  authorize(READ),
  validate(regulatorySourceQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as RegulatorySourceQuery;
    sendSuccess(res, await listSources(tenantContextFrom(req), query));
  }
);

router.get(
  '/rule-packs',
  authorize(READ),
  validate(rulePackQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as RulePackQuery;
    sendSuccess(res, await listRulePacks(tenantContextFrom(req), query));
  }
);

const packParams = z.object({ packId: z.uuid() });

router.get(
  '/rule-packs/:packId',
  authorize(READ),
  validate(packParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { packId } = req.params as z.infer<typeof packParams>;
    sendSuccess(res, { pack: await getRulePack(tenantContextFrom(req), packId) });
  }
);

router.get(
  '/rules',
  authorize(READ),
  validate(regulatoryRuleQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as RegulatoryRuleQuery;
    sendSuccess(res, await listRules(tenantContextFrom(req), query));
  }
);

/**
 * "What would the rules say about this?"
 *
 * ⚠️ THE ANSWER MAY BE `UNDETERMINED`, AND THAT IS A REFUSAL. It is a 200 with a
 *   decision in it — the question was answered — and any client that renders it
 *   as anything other than "we cannot permit this" has reintroduced the
 *   permissive default the whole domain is shaped against.
 */
router.post(
  '/evaluate',
  authorize(READ),
  validate(evaluateRegulatoryRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    /*
     * The caller's effective codes for the branch this request is acting on.
     * `authorize()` has already warmed that cache on the way in, so this is a
     * cache hit rather than a query — and it keeps "what may this person do"
     * answered by the permission resolver rather than by a second opinion here.
     */
    const access = await loadUserAccess(ctx.userId, ctx.organizationId);
    const roleCodes = access
      ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false)
      : [];

    /*
     * ⚠️ THE BRANCH THE REQUEST IS ACTING ON, WHERE THE BODY DOES NOT NAME ONE.
     *   `authorize()` has already resolved this caller's permissions FOR THIS
     *   BRANCH, so evaluating against a different one would judge somebody by
     *   the rules of a place they are not standing in. The service still checks
     *   the id is inside `ctx.branchIds`.
     */
    const body = req.body as EvaluateRegulatoryRequest;
    const branchId = body.branchId ?? req.auth?.branchId ?? undefined;

    sendSuccess(
      res,
      await evaluateFor(ctx, { ...body, ...(branchId ? { branchId } : {}) }, { roleCodes })
    );
  }
);

export default router;
