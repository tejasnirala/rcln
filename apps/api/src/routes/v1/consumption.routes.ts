/**
 * Clinical consumption: the templates, the panel and the record (PI-9).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   reading templates, the panel, the record  ->  `consumption.record.read`
 *   recording what was used                   ->  `consumption.record`
 *   departing from the template's expectation ->  `consumption.override`
 *   writing the templates themselves          ->  `consumption.template.manage`
 *
 * ⚠️ `consumption.override` IS ENFORCED IN THE SERVICE AND NOT BY `authorize`,
 *   AND IT IS THE ONE CODE ON THIS ROUTER THAT COULD NOT BE. Whether a body
 *   contains a variance is not knowable until the expected quantities have been
 *   read and the units converted, which is most of the work of recording one.
 *   The route gates `consumption.record`; `assertMayOverride` gates the narrower
 *   act inside it, which is why `permissionCodes` is resolved here and passed
 *   down. Compare `requirePriceCodeToOverride` on the charging router, which CAN
 *   do it at the route because the field it keys off is a plain flag on the body.
 *
 * ⚠️ NOTHING ON THIS ROUTER CARRIES A `clinical.*` CODE, AND `route-gates.test.ts`
 *   ASSERTS IT. Recording what a procedure consumed writes a stock movement
 *   anchored to a consultation — the relationship `prescription_fulfilments` has
 *   to a prescription — and no clinical content. Invariant 7 holds because the
 *   arrow points one way: this reads the encounter and writes only beside it.
 *
 * ⚠️ AND NOTHING HERE STATES A PRICE (PI-ADR-005). The money side is a
 *   `charge_request` raised inside the recording transaction; there is no route
 *   on this router through which a caller could say what something costs.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ THE RECORD ROUTES ARE DISCLOSURES — a named person, an implant, a serial
 *   number — and every read of them passes the matched route PATTERN, never
 *   `req.originalUrl`, down to `recordDataAccess`. The TEMPLATE routes file no
 *   disclosure row and correctly so: a template is a statement about a
 *   procedure, no patient appears in either request or response, and filing
 *   rows for them would bury the ones that are disclosures.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  amendConsumptionRequest,
  consumptionPlanQuery,
  consumptionQuery,
  consumptionTemplateQuery,
  correctConsumptionRequest,
  createConsumptionTemplateRequest,
  recordConsumptionRequest,
  updateConsumptionTemplateRequest,
  type AmendConsumptionRequest,
  type ConsumptionPlanQuery,
  type ConsumptionQuery,
  type ConsumptionTemplateQuery,
  type CorrectConsumptionRequest,
  type CreateConsumptionTemplateRequest,
  type RecordConsumptionRequest,
  type UpdateConsumptionTemplateRequest,
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
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import {
  createConsumptionTemplate,
  deleteConsumptionTemplate,
  getConsumptionTemplate,
  listConsumptionTemplates,
  updateConsumptionTemplate,
} from '../../services/consumption/template.service.js';
import {
  amendConsumption,
  correctConsumption,
  getConsumption,
  listConsumptions,
  planConsumption,
  recordConsumption,
} from '../../services/consumption/consumption.service.js';
import type { ConsumptionActionOptions } from '../../services/consumption/shared.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const CONSUMPTION_READ = PERMISSIONS.CONSUMPTION_READ;
const CONSUMPTION_RECORD = PERMISSIONS.CONSUMPTION_RECORD;
const TEMPLATE_MANAGE = PERMISSIONS.CONSUMPTION_TEMPLATE_MANAGE;

const router: IRouter = Router();
router.use(requireTenant, authenticate, requireAuth);

const idParams = z.object({ id: z.uuid() });

/**
 * Everything the services need about WHO is asking and from WHERE.
 *
 * ⚠️ `permissionCodes` IS THE CALLER'S EFFECTIVE PERMISSIONS FOR THE BRANCH BEING
 *   ACTED ON, resolved here rather than derived inside a service, because
 *   `TenantContext` deliberately carries no permissions — it is an isolation
 *   boundary, not an authorization one. It is what `assertMayOverride` reads.
 *
 * ⚠️ `route` IS THE MATCHED PATTERN AND NEVER `req.originalUrl`. A URL carries
 *   its query string into `data_access_logs`, which is the one table that never
 *   takes free text.
 */
async function consumptionOptions(req: Request, route: string): Promise<ConsumptionActionOptions> {
  const ctx = tenantContextFrom(req);
  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  const permissionCodes = access
    ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false)
    : [];

  return {
    route,
    permissionCodes,
    actingBranchId: req.auth?.branchId ?? null,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

/** The read routes need no permission resolution — nothing on them overrides. */
function readOptions(req: Request, route: string): ConsumptionActionOptions {
  return {
    route,
    actingBranchId: req.auth?.branchId ?? null,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Templates  ->  /v1/consumption/templates
// ---------------------------------------------------------------------------

router.get(
  '/templates',
  authorize(CONSUMPTION_READ),
  validate(consumptionTemplateQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ConsumptionTemplateQuery;
    sendSuccess(res, await listConsumptionTemplates(tenantContextFrom(req), query));
  }
);

router.get(
  '/templates/:id',
  authorize(CONSUMPTION_READ),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    sendSuccess(res, await getConsumptionTemplate(tenantContextFrom(req), id));
  }
);

router.post(
  '/templates',
  authorize(TEMPLATE_MANAGE),
  validate(createConsumptionTemplateRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateConsumptionTemplateRequest;
    sendCreated(
      res,
      await createConsumptionTemplate(
        tenantContextFrom(req),
        body,
        readOptions(req, 'POST /v1/consumption/templates')
      )
    );
  }
);

router.patch(
  '/templates/:id',
  authorize(TEMPLATE_MANAGE),
  validate(idParams, 'params'),
  validate(updateConsumptionTemplateRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as UpdateConsumptionTemplateRequest;
    sendCreated(
      res,
      await updateConsumptionTemplate(
        tenantContextFrom(req),
        id,
        body,
        readOptions(req, 'PATCH /v1/consumption/templates/:id')
      )
    );
  }
);

/**
 * ⚠️ SOFT, ALWAYS. A recorded procedure cites the template version it was
 *   pre-filled from and `clinical_consumptions.template_id` is `Restrict`; the
 *   service retires the row rather than removing it.
 */
router.delete(
  '/templates/:id',
  authorize(TEMPLATE_MANAGE),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    await deleteConsumptionTemplate(
      tenantContextFrom(req),
      id,
      readOptions(req, 'DELETE /v1/consumption/templates/:id')
    );
    res.status(204).send();
  }
);

// ---------------------------------------------------------------------------
// The panel  ->  /v1/consumption/plan
// ---------------------------------------------------------------------------

/**
 * What this procedure normally uses, and what is on the shelf.
 *
 * ⚠️ IT WRITES NOTHING, INCLUDING NO RESERVATION — see the service. And it is a
 *   GET that FILES A DISCLOSURE ROW, because it names a patient's procedure and
 *   the products about to be used on them.
 */
router.get(
  '/plan',
  authorize(CONSUMPTION_READ),
  validate(consumptionPlanQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ConsumptionPlanQuery;
    sendSuccess(
      res,
      await planConsumption(
        tenantContextFrom(req),
        query,
        readOptions(req, 'GET /v1/consumption/plan')
      )
    );
  }
);

// ---------------------------------------------------------------------------
// The record  ->  /v1/consumption/records
// ---------------------------------------------------------------------------

router.get(
  '/records',
  authorize(CONSUMPTION_READ),
  validate(consumptionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ConsumptionQuery;
    sendSuccess(
      res,
      await listConsumptions(
        tenantContextFrom(req),
        query,
        readOptions(req, 'GET /v1/consumption/records')
      )
    );
  }
);

router.get(
  '/records/:id',
  authorize(CONSUMPTION_READ),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    sendSuccess(
      res,
      await getConsumption(
        tenantContextFrom(req),
        id,
        readOptions(req, 'GET /v1/consumption/records/:id')
      )
    );
  }
);

/**
 * Record what was used.
 *
 * ⚠️ ONE TRANSACTION, AND NO DRAFT. The material left the trolley once — the
 *   panel plans, a human confirms, and one transaction writes the record, the
 *   ledger legs, the serial assignments, the charge requests and the audit row.
 */
router.post(
  '/records',
  authorize(CONSUMPTION_RECORD),
  validate(recordConsumptionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as RecordConsumptionRequest;
    sendSuccess(
      res,
      await recordConsumption(
        tenantContextFrom(req),
        body,
        await consumptionOptions(req, 'POST /v1/consumption/records')
      )
    );
  }
);

/**
 * Restate it, while the consultation is still open.
 *
 * ⚠️ PATCH RATHER THAN PUT, EVEN THOUGH THE LINE SET IS REPLACED WHOLESALE. The
 *   notes are patched and the lines are not addressable individually — a PUT
 *   would promise that the body is the complete resource, which it is not: the
 *   allocations, the expectations and the ledger legs are all derived.
 */
router.patch(
  '/records/:id',
  authorize(CONSUMPTION_RECORD),
  validate(idParams, 'params'),
  validate(amendConsumptionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as AmendConsumptionRequest;
    sendCreated(
      res,
      await amendConsumption(
        tenantContextFrom(req),
        id,
        body,
        await consumptionOptions(req, 'PATCH /v1/consumption/records/:id')
      )
    );
  }
);

/**
 * Correct it, once the consultation has closed.
 *
 * ⚠️ A SECOND RECORD, NEVER AN EDIT — which is why this is a POST that creates,
 *   and why it returns the CORRECTION rather than the original.
 */
router.post(
  '/records/:id/corrections',
  authorize(CONSUMPTION_RECORD),
  validate(idParams, 'params'),
  validate(correctConsumptionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as CorrectConsumptionRequest;
    sendSuccess(
      res,
      await correctConsumption(
        tenantContextFrom(req),
        id,
        body,
        await consumptionOptions(req, 'POST /v1/consumption/records/:id/corrections')
      )
    );
  }
);

export default router;
