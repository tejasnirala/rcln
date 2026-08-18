/**
 * Recall & traceability (PI-10).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * Two routers, mounted at two paths in `index.ts`. They share one domain and one
 * set of permission codes; splitting the file would be how one of them ends up
 * with a different guard.
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   reading a notice, its scope, either trace  ->  `recall.notice.read`
 *   recording a notice and assembling it       ->  `recall.notice.create`
 *   pulling the stock, releasing, disposing    ->  `recall.notice.execute`
 *   turning the counts into NAMES              ->  `recall.trace.patients`   ⚠
 *
 * ⚠️ THE LAST ONE IS NOT IMPLIED BY THE FIRST THREE, AND THAT SEPARATION IS THE
 *   WHOLE DESIGN OF THIS ROUTER. `GET /v1/traceability/forward` answers "37
 *   supplies, 4 procedures, 29 people" and names nobody; `GET
 *   /v1/traceability/affected` answers "these 29 people, with their phone
 *   numbers". TRACEABILITY.md § "Patient linkage and its limits" says the link
 *   always exists in the data and who may SEE it is an access-control question —
 *   this is where that sentence becomes code. A storekeeper who can read a lot
 *   number is not thereby somebody who may pull a patient list.
 *
 * ⚠️ RESOLVING AND EXECUTING SHARE ONE CODE, DELIBERATELY. Releasing a held lot
 *   puts stock back on sale and disposing of it destroys stock; both are the
 *   same class of decision as pulling it, taken by the same person, and a
 *   separate `recall.notice.resolve` would be a code nobody could explain the
 *   boundary of.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ EXACTLY ONE ROUTE ON THIS ROUTER DISCLOSES ANYTHING. It passes the matched
 *   route PATTERN — never `req.originalUrl`, which carries a query string into
 *   `data_access_logs` — down to `recordDataAccess`, and the service files ONE
 *   row carrying the COUNT. Nothing else here files a disclosure, and correctly
 *   so: a recall notice is a statement about a product.
 *
 * ⚠️ AND NOTHING HERE CARRIES A `clinical.*` CODE (invariant 7). A recall reads
 *   the dispensing and consumption registers and writes only stock movements
 *   beside them; `route-gates.test.ts` asserts it.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  addRecallBatchesRequest,
  affectedPartyQuery,
  backwardTraceQuery,
  cancelRecallRequest,
  closeRecallRequest,
  createRecallRequest,
  executeRecallRequest,
  forwardTraceQuery,
  recallQuery,
  resolveRecallBatchRequest,
  updateRecallRequest,
  type AddRecallBatchesRequest,
  type AffectedPartyQuery,
  type BackwardTraceQuery,
  type CancelRecallRequest,
  type CloseRecallRequest,
  type CreateRecallRequest,
  type ExecuteRecallRequest,
  type ForwardTraceQuery,
  type RecallQuery,
  type ResolveRecallBatchRequest,
  type UpdateRecallRequest,
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
  addRecallBatches,
  cancelRecall,
  closeRecall,
  createRecall,
  executeRecall,
  getRecall,
  listRecallCandidates,
  listRecalls,
  removeRecallBatch,
  resolveRecallBatch,
  updateRecall,
} from '../../services/recall/recall.service.js';
import {
  backwardTrace,
  forwardTrace,
  listAffectedParties,
} from '../../services/recall/trace.service.js';
import type { RecallActionOptions } from '../../services/recall/shared.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const READ = PERMISSIONS.RECALL_READ;
const CREATE = PERMISSIONS.RECALL_CREATE;
const EXECUTE = PERMISSIONS.RECALL_EXECUTE;
const TRACE_PATIENTS = PERMISSIONS.RECALL_TRACE_PATIENTS;

function guarded(): IRouter {
  const router: IRouter = Router();
  router.use(requireTenant, authenticate, requireAuth);
  return router;
}

/**
 * ⚠️ `route` IS THE MATCHED PATTERN AND NEVER `req.originalUrl`, for the reason
 *   `consumption.routes.ts` gives: a URL carries its query string into
 *   `data_access_logs`, which is the one table that never takes free text.
 */
function actionOptions(req: Request, route: string): RecallActionOptions {
  return {
    route,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recalls  ->  /v1/recalls
// ---------------------------------------------------------------------------

export const recallRoutes: IRouter = guarded();

const idParams = z.object({ id: z.uuid() });
const lotParams = z.object({ id: z.uuid(), recallBatchId: z.uuid() });

recallRoutes.get(
  '/',
  authorize(READ),
  validate(recallQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as RecallQuery;
    sendSuccess(res, await listRecalls(tenantContextFrom(req), query));
  }
);

recallRoutes.get(
  '/:id',
  authorize(READ),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    sendSuccess(res, await getRecall(tenantContextFrom(req), id));
  }
);

/**
 * The lots of this product that are not yet in the scope.
 *
 * ⚠️ GATED ON READ RATHER THAN CREATE. It is the picker behind the "add lots"
 *   dialog, and somebody reviewing a recall has every reason to see what was
 *   NOT included — which is one of the questions an audit of a recall asks.
 */
recallRoutes.get(
  '/:id/candidates',
  authorize(READ),
  validate(idParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    sendSuccess(res, await listRecallCandidates(tenantContextFrom(req), id));
  }
);

recallRoutes.post(
  '/',
  authorize(CREATE),
  validate(createRecallRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateRecallRequest;
    sendCreated(
      res,
      await createRecall(tenantContextFrom(req), body, actionOptions(req, 'POST /v1/recalls'))
    );
  }
);

recallRoutes.patch(
  '/:id',
  authorize(CREATE),
  validate(idParams, 'params'),
  validate(updateRecallRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as UpdateRecallRequest;
    sendSuccess(
      res,
      await updateRecall(
        tenantContextFrom(req),
        id,
        body,
        actionOptions(req, 'PATCH /v1/recalls/:id')
      )
    );
  }
);

recallRoutes.post(
  '/:id/batches',
  authorize(CREATE),
  validate(idParams, 'params'),
  validate(addRecallBatchesRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as AddRecallBatchesRequest;
    sendSuccess(
      res,
      await addRecallBatches(
        tenantContextFrom(req),
        id,
        body,
        actionOptions(req, 'POST /v1/recalls/:id/batches')
      )
    );
  }
);

recallRoutes.delete(
  '/:id/batches/:recallBatchId',
  authorize(CREATE),
  validate(lotParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { id, recallBatchId } = req.params as z.infer<typeof lotParams>;
    sendSuccess(
      res,
      await removeRecallBatch(
        tenantContextFrom(req),
        id,
        recallBatchId,
        actionOptions(req, 'DELETE /v1/recalls/:id/batches/:recallBatchId')
      )
    );
  }
);

/**
 * Pull the stock.
 *
 * ⚠️ ONE TRANSACTION, AND IT REACHES EVERY BRANCH THE CALLER CAN SEE. This is
 *   the single most consequential POST in the programme: it makes a product
 *   un-dispensable and un-consumable across the organization, and every hold it
 *   writes is a `stock_ledger` leg that cannot be edited afterwards.
 */
recallRoutes.post(
  '/:id/execute',
  authorize(EXECUTE),
  validate(idParams, 'params'),
  validate(executeRecallRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as ExecuteRecallRequest;
    sendSuccess(
      res,
      await executeRecall(
        tenantContextFrom(req),
        id,
        body,
        actionOptions(req, 'POST /v1/recalls/:id/execute')
      )
    );
  }
);

recallRoutes.post(
  '/:id/batches/:recallBatchId/resolve',
  authorize(EXECUTE),
  validate(lotParams, 'params'),
  validate(resolveRecallBatchRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id, recallBatchId } = req.params as z.infer<typeof lotParams>;
    const body = req.body as ResolveRecallBatchRequest;
    sendSuccess(
      res,
      await resolveRecallBatch(
        tenantContextFrom(req),
        id,
        recallBatchId,
        body,
        actionOptions(req, 'POST /v1/recalls/:id/batches/:recallBatchId/resolve')
      )
    );
  }
);

recallRoutes.post(
  '/:id/close',
  authorize(EXECUTE),
  validate(idParams, 'params'),
  validate(closeRecallRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as CloseRecallRequest;
    sendSuccess(
      res,
      await closeRecall(
        tenantContextFrom(req),
        id,
        body,
        actionOptions(req, 'POST /v1/recalls/:id/close')
      )
    );
  }
);

recallRoutes.post(
  '/:id/cancel',
  authorize(EXECUTE),
  validate(idParams, 'params'),
  validate(cancelRecallRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof idParams>;
    const body = req.body as CancelRecallRequest;
    sendSuccess(
      res,
      await cancelRecall(
        tenantContextFrom(req),
        id,
        body,
        actionOptions(req, 'POST /v1/recalls/:id/cancel')
      )
    );
  }
);

// ---------------------------------------------------------------------------
// Traceability  ->  /v1/traceability
//
// ⚠️ ITS OWN MOUNT RATHER THAN `/v1/recalls/:id/trace`, BECAUSE THE QUESTION IS
//   ASKED WITHOUT A RECALL FAR MORE OFTEN THAN WITH ONE. "Where did this lot
//   come from" is what a storekeeper asks about a suspicious delivery, and "who
//   got this device" is what a surgeon asks after one failed — neither has a
//   notice behind it yet, and both are exactly how a recall STARTS.
// ---------------------------------------------------------------------------

export const traceabilityRoutes: IRouter = guarded();

traceabilityRoutes.get(
  '/forward',
  authorize(READ),
  validate(forwardTraceQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ForwardTraceQuery;
    sendSuccess(res, await forwardTrace(tenantContextFrom(req), query));
  }
);

traceabilityRoutes.get(
  '/backward',
  authorize(READ),
  validate(backwardTraceQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as BackwardTraceQuery;
    sendSuccess(res, await backwardTrace(tenantContextFrom(req), query));
  }
);

/**
 * ⚠️ THE ONE PHI ROUTE IN THIS DOMAIN, AND IT CARRIES BOTH CODES.
 *
 *   `authorize` takes them as a list meaning ALL of them, so somebody who may
 *   read a notice but was not given the patient code gets a 403 here and a full
 *   answer on `/forward`. That is the split working: they still see how many
 *   people are affected, which is what tells them to ask a colleague.
 */
traceabilityRoutes.get(
  '/affected',
  authorize(READ, TRACE_PATIENTS),
  validate(affectedPartyQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AffectedPartyQuery;
    sendSuccess(
      res,
      await listAffectedParties(
        tenantContextFrom(req),
        query,
        actionOptions(req, 'GET /v1/traceability/affected')
      )
    );
  }
);
