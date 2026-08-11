import { Router, type IRouter, type Request, type Response } from 'express';

import {
  feeQuoteQuery,
  feeScheduleQuery,
  setFeeScheduleRequest,
  type FeeQuoteQuery,
  type FeeScheduleQuery,
  type SetFeeScheduleRequest,
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
  getFeeSchedule,
  listFeeScheduleEntries,
  quoteFee,
  setFeeSchedule,
  type FeeActionOptions,
} from '../../services/fees/fee-schedule.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * What the clinic charges for an appointment — the CLINIC's half of the grid.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ⚠️ A DOCTOR'S OVERRIDES ARE NOT HERE. They are `/v1/doctors/:doctorId/fees`,
 *   on the doctors router, because they hang off a practitioner and the same
 *   404-if-invisible rule has to apply to the doctor id. Both surfaces call the
 *   same two service functions and the same single resolver; there is exactly
 *   one implementation of the precedence rule in the codebase.
 *
 * ⚠️ NOT PHI, WHICH IS WHY NOTHING HERE WRITES `data_access_logs`. A fee names a
 *   branch, a doctor, a kind of visit and a price — no patient, no invoice, no
 *   line description. The WRITES are audited in `audit_logs`, because "who
 *   changed what we charge" is precisely the question an auditor asks.
 *
 * ⚠️ READ IS HELD WIDELY AND MANAGE IS NOT. The front desk is quoted the fee as
 *   it books (§0.2 decision 13) and a doctor may see their own rates, so
 *   receptionists, nurses, doctors and accountants hold `billing.fee_schedule.read`.
 *   `billing.fee_schedule.manage` lands only on the two "everything except"
 *   roles — see the code's own note.
 */
const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const meta = (req: Request): FeeActionOptions => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/**
 * What this visit would cost, before it is booked.
 *
 * ⚠️ MUST STAY ABOVE NOTHING IN PARTICULAR — there is no `/:id` on this router,
 *   deliberately. A fee row's id is an implementation detail of the grid; every
 *   read here is by SCOPE, which is what a human edits and what the resolver
 *   consumes.
 */
router.get(
  '/quote',
  authorize(PERMISSIONS.FEE_SCHEDULE_READ),
  validate(feeQuoteQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as FeeQuoteQuery;
    sendSuccess(res, await quoteFee(tenantContextFrom(req), query));
  }
);

/** Every stored row, clinic defaults and doctor overrides alike. */
router.get(
  '/entries',
  authorize(PERMISSIONS.FEE_SCHEDULE_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { entries: await listFeeScheduleEntries(tenantContextFrom(req)) });
  }
);

/**
 * The clinic's sheet. `?branchId=` reads that branch's, with what it inherits
 * from the org-wide sheet already folded in; absent reads the org-wide one.
 */
router.get(
  '/',
  authorize(PERMISSIONS.FEE_SCHEDULE_READ),
  validate(feeScheduleQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as FeeScheduleQuery;
    sendSuccess(
      res,
      await getFeeSchedule(tenantContextFrom(req), {
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      })
    );
  }
);

/**
 * Save the clinic's prices for one scope.
 *
 * A PUT rather than a POST, and partial rather than wholesale: the body names
 * the fee types it is changing, `null` removes one, and a type left out is left
 * alone. See the contract for why a missing key must not mean a delete.
 */
router.put(
  '/',
  authorize(PERMISSIONS.FEE_SCHEDULE_MANAGE),
  validate(setFeeScheduleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const view = await setFeeSchedule(
      tenantContextFrom(req),
      {},
      req.body as SetFeeScheduleRequest,
      meta(req)
    );
    sendSuccess(res, view, 'Fees saved');
  }
);

export default router;
