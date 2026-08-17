/**
 * Charging: the charge queue, the policy and the price list (PI-8).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   the queue, its summary, the policy list  ->  `billing.charge_request.read`
 *   deciding one charge                      ->  `billing.charge_request.manage`
 *   editing the standing policy              ->  `billing.charge_policy.manage`
 *   setting a price                          ->  `billing.fee_schedule.manage`
 *
 * ⚠️ THE THREE WRITE CODES ARE THREE DIFFERENT BLAST RADII AND ARE DELIBERATELY
 *   NOT ONE. Deciding one charge affects one patient. Editing the policy decides
 *   every future supply of a product at every branch, silently and with no row
 *   to review. Setting a price decides what every future bill says. A single
 *   `billing.charging.manage` would give the front desk all three the day
 *   somebody grants it to answer an `OPTIONAL` charge.
 *
 * ⚠️ PRICING REUSES `billing.fee_schedule.manage` RATHER THAN INVENTING A CODE.
 *   That code already means "may set what this clinic charges", and already
 *   carries the reasoning about why it is not BRANCH_ADMIN's. A second pricing
 *   permission beside it is how a screen quotes one number and the bill states
 *   another. See the codes file.
 *
 * ⚠️ RAISING THE INVOICE IS NOT ON THIS ROUTER. `POST /v1/invoices/from-charges`
 *   lives with the other invoice routes and is gated by `billing.invoice.create`,
 *   because assembling a document from charges somebody already approved is the
 *   invoice engine's act and confers nothing the generic create does not.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ THE QUEUE IS A DISCLOSURE — it names a patient beside a medicine — and its
 *   read passes the matched route PATTERN, never `req.originalUrl`, down to
 *   `recordDataAccess`. The SUMMARY is the deliberate exception: it returns
 *   counts and one sum, singles out nobody, and renders on every poll.
 *
 * ⚠️ THE POLICY AND PRICE ROUTES LOG NOTHING TO `data_access_logs`, and that is
 *   correct rather than an omission. A charge policy and a price are facts about
 *   a CATALOGUE ROW; no patient appears in either request or response. Filing
 *   disclosure rows for them would bury the rows that are disclosures.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createChargePolicyRuleRequest,
  decideChargeRequest as decideChargeRequestSchema,
  listChargePolicyRulesQuery,
  listChargeRequestsQuery,
  listProductPricesQuery,
  resolveChargePolicyQuery,
  updateChargePolicyRuleRequest,
  upsertProductPriceRequest,
  type CreateChargePolicyRuleRequest,
  type DecideChargeRequest,
  type ListChargePolicyRulesQuery,
  type ListChargeRequestsQuery,
  type ListProductPricesQuery,
  type ResolveChargePolicyQuery,
  type UpdateChargePolicyRuleRequest,
  type UpsertProductPriceRequest,
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
  createChargePolicyRule,
  deleteChargePolicyRule,
  listChargePolicyRules,
  resolveChargePolicyFor,
  updateChargePolicyRule,
  type ChargingActionOptions,
} from '../../services/charging/policy.service.js';
import {
  decideChargeRequest,
  getChargeQueueSummary,
  listChargeRequests,
} from '../../services/charging/charge-request.service.js';
import {
  deleteProductPrice,
  listProductPrices,
  upsertProductPrice,
} from '../../services/charging/price.service.js';
import { sendSuccess } from '../../utils/response.js';

const CHARGE_READ = PERMISSIONS.CHARGE_REQUEST_READ;
const CHARGE_MANAGE = PERMISSIONS.CHARGE_REQUEST_MANAGE;
const POLICY_MANAGE = PERMISSIONS.CHARGE_POLICY_MANAGE;
const PRICE_MANAGE = PERMISSIONS.FEE_SCHEDULE_MANAGE;
const PRICE_READ = PERMISSIONS.FEE_SCHEDULE_READ;

const router: IRouter = Router();
router.use(requireTenant, authenticate, requireAuth);

const idParams = z.object({ id: z.uuid() });
const summaryQuery = z.object({ branchId: z.uuid().optional() });

/**
 * Who is asking and from where.
 *
 * ⚠️ NO `roleCodes` HERE, UNLIKE THE PHARMACY ROUTER. Nothing on this router
 *   consults `@rcln/regulatory` — a charge policy is a commercial decision, not
 *   a legal one — so resolving the caller's effective permissions would be a
 *   cache read nobody uses.
 *
 * ⚠️ `route` IS THE MATCHED PATTERN AND NEVER `req.originalUrl`. A URL carries
 *   its query string into `data_access_logs`, which is the one table that never
 *   takes free text.
 */
function chargingOptions(req: Request, route: string): ChargingActionOptions {
  return {
    route,
    actingBranchId: req.auth?.branchId ?? null,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// The charge queue  ->  /v1/charging/requests
// ---------------------------------------------------------------------------

router.get(
  '/requests',
  authorize(CHARGE_READ),
  validate(listChargeRequestsQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListChargeRequestsQuery;
    sendSuccess(
      res,
      await listChargeRequests(
        tenantContextFrom(req),
        query,
        chargingOptions(req, 'GET /v1/charging/requests')
      )
    );
  }
);

/**
 * ⚠️ COUNTS AND ONE SUM. No names in the response, because this renders on every
 *   poll of the review screen — putting a patient in a per-poll response is the
 *   firehose `invoice.service.ts` explains it is avoiding, and it is why this
 *   route files no disclosure row while the list above does.
 */
router.get(
  '/requests/summary',
  authorize(CHARGE_READ),
  validate(summaryQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { branchId } = req.query as unknown as z.infer<typeof summaryQuery>;
    sendSuccess(res, await getChargeQueueSummary(tenantContextFrom(req), branchId));
  }
);

/**
 * A human's answer to a charge the policy would not decide.
 *
 * ⚠️ IT RAISES NO INVOICE. "Bill it" answers the POLICY question and leaves the
 *   charge PENDING for a document somebody assembles and confirms; "suppress it"
 *   is terminal and requires a reason. See `decideChargeRequest`.
 */
router.post(
  '/requests/:id/decide',
  authorize(CHARGE_MANAGE),
  validate(idParams, 'params'),
  validate(decideChargeRequestSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as DecideChargeRequest;
    sendSuccess(
      res,
      await decideChargeRequest(
        tenantContextFrom(req),
        id,
        body,
        chargingOptions(req, 'POST /v1/charging/requests/:id/decide')
      ),
      body.decision === 'SUPPRESS' ? 'Charge suppressed' : 'Charge approved for billing'
    );
  }
);

// ---------------------------------------------------------------------------
// The standing policy  ->  /v1/charging/policies
// ---------------------------------------------------------------------------

/**
 * ⚠️ READ IS `billing.charge_request.read`, NOT THE MANAGE CODE. Whoever works
 *   the queue has to be able to see WHY a charge came out suppressed, and "the
 *   policy says gloves are never billed" is that answer. Hiding the rules behind
 *   the code that edits them makes every suppressed charge unexplainable to the
 *   person looking at it.
 */
router.get(
  '/policies',
  authorize(CHARGE_READ),
  validate(listChargePolicyRulesQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListChargePolicyRulesQuery;
    sendSuccess(res, await listChargePolicyRules(tenantContextFrom(req), query));
  }
);

/**
 * What the chain WOULD answer for one product, resolved by the same function the
 * supply path uses — never a second copy of the precedence rule.
 */
router.get(
  '/policies/resolve',
  authorize(CHARGE_READ),
  validate(resolveChargePolicyQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.query as unknown as ResolveChargePolicyQuery;
    sendSuccess(res, await resolveChargePolicyFor(tenantContextFrom(req), productId));
  }
);

router.post(
  '/policies',
  authorize(POLICY_MANAGE),
  validate(createChargePolicyRuleRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateChargePolicyRuleRequest;
    sendSuccess(
      res,
      await createChargePolicyRule(
        tenantContextFrom(req),
        body,
        chargingOptions(req, 'POST /v1/charging/policies')
      ),
      'Charge policy saved',
      201
    );
  }
);

router.patch(
  '/policies/:id',
  authorize(POLICY_MANAGE),
  validate(idParams, 'params'),
  validate(updateChargePolicyRuleRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as UpdateChargePolicyRuleRequest;
    sendSuccess(
      res,
      await updateChargePolicyRule(
        tenantContextFrom(req),
        id,
        body,
        chargingOptions(req, 'PATCH /v1/charging/policies/:id')
      ),
      'Charge policy updated'
    );
  }
);

router.delete(
  '/policies/:id',
  authorize(POLICY_MANAGE),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    await deleteChargePolicyRule(
      tenantContextFrom(req),
      id,
      chargingOptions(req, 'DELETE /v1/charging/policies/:id')
    );
    sendSuccess(res, null, 'Charge policy removed');
  }
);

// ---------------------------------------------------------------------------
// The price list  ->  /v1/charging/prices
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE READ IS HELD WIDELY, exactly as `billing.fee_schedule.read` is for
 *   consultation fees, and for the same reason: whoever is about to hand
 *   somebody a bill has to be able to say what it will come to. A price nobody
 *   can see until the invoice is a quote the patient was never given.
 */
router.get(
  '/prices',
  authorize(PRICE_READ),
  validate(listProductPricesQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListProductPricesQuery;
    sendSuccess(res, await listProductPrices(tenantContextFrom(req), query));
  }
);

router.put(
  '/prices',
  authorize(PRICE_MANAGE),
  validate(upsertProductPriceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as UpsertProductPriceRequest;
    sendSuccess(
      res,
      await upsertProductPrice(
        tenantContextFrom(req),
        body,
        chargingOptions(req, 'PUT /v1/charging/prices')
      ),
      'Price saved'
    );
  }
);

router.delete(
  '/prices/:id',
  authorize(PRICE_MANAGE),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    await deleteProductPrice(
      tenantContextFrom(req),
      id,
      chargingOptions(req, 'DELETE /v1/charging/prices/:id')
    );
    sendSuccess(res, null, 'Price removed');
  }
);

export default router;
