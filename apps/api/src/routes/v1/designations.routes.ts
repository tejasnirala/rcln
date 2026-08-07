import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createDesignationRequest,
  setRolePairingsRequest,
  type CreateDesignationRequest,
  type SetRolePairingsRequest,
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
  createDesignation,
  listDesignations,
  listRolePairings,
  setRolePairings,
} from '../../services/iam/designation.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * The job titles a clinic hands out.
 *
 * Its own router rather than a path under `/members`, because
 * `/members/designations` would be swallowed by `/members/:membershipId` — the
 * uuid param would match the literal and answer 400 on a malformed id.
 *
 * The standard chain: requireTenant -> authenticate -> requireAuth -> authorize
 * -> validate -> handler.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const pairingParams = z.object({ roleId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/**
 * Behind IAM_USER_READ, not IAM_DESIGNATION_MANAGE.
 *
 * Anyone who can open the Staff screen or the invite form has to be able to
 * render the menu; gating the list behind the permission to EDIT it would show
 * a receptionist a blank dropdown and no explanation.
 */
router.get(
  '/',
  authorize(PERMISSIONS.IAM_USER_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { designations: await listDesignations(tenantContextFrom(req)) });
  }
);

/**
 * The role↔title grid, for the clinic settings screen.
 *
 * Behind IAM_DESIGNATION_MANAGE rather than IAM_USER_READ: this is the
 * configuration surface, not the menu the invite form renders.
 */
router.get(
  '/pairings',
  authorize(PERMISSIONS.IAM_DESIGNATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { roles: await listRolePairings(tenantContextFrom(req)) });
  }
);

/**
 * Replace the titles that fit one role.
 *
 * PUT, not PATCH: the body states the whole list, and the server reconciles it
 * against the platform defaults. Two administrators saving at once therefore
 * converge on a state one of them chose rather than a merge neither did.
 */
router.put(
  '/pairings/:roleId',
  authorize(PERMISSIONS.IAM_DESIGNATION_MANAGE),
  validate(pairingParams, 'params'),
  validate(setRolePairingsRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { roleId } = req.params as z.infer<typeof pairingParams>;
    await setRolePairings(
      tenantContextFrom(req),
      roleId,
      req.body as SetRolePairingsRequest,
      auditMeta(req)
    );
    sendSuccess(res, null, 'Titles updated');
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.IAM_DESIGNATION_MANAGE),
  validate(createDesignationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const designation = await createDesignation(
      tenantContextFrom(req),
      req.body as CreateDesignationRequest,
      auditMeta(req)
    );
    sendSuccess(res, designation, 'Title added', 201);
  }
);

export default router;
