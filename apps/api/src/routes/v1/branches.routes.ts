import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  branchOperatingHoursRequest,
  createBranchRequest,
  updateBranchRequest,
  type BranchOperatingHoursRequest,
  type CreateBranchRequest,
  type UpdateBranchRequest,
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
  createBranch,
  deleteBranch,
  getBranch,
  listBranches,
  setOperatingHours,
  updateBranch,
} from '../../services/branch/branch.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Branch management, on a clinic's own subdomain.
 *
 * The first router to use the full middleware chain from CONVENTIONS.md:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * The order is the security model, not a style choice. requireTenant first so an
 * unknown host is answered 404 before any credential is examined; authorize
 * after authenticate because it resolves permissions against the caller's active
 * branch; validate last so a malformed body from someone who is not allowed here
 * anyway never reaches Zod.
 *
 * Scoping to the branches this caller may actually touch is the service's job —
 * `branches` has no branch_isolation policy, so RLS narrows to the organization
 * and no further. See the header of branch.service.ts.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const branchParams = z.object({ branchId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.BRANCH_READ),
  async (req: Request, res: Response): Promise<void> => {
    const branches = await listBranches(tenantContextFrom(req));
    sendSuccess(res, { branches });
  }
);

router.get(
  '/:branchId',
  authorize(PERMISSIONS.BRANCH_READ),
  validate(branchParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { branchId } = req.params as z.infer<typeof branchParams>;
    sendSuccess(res, await getBranch(tenantContextFrom(req), branchId));
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.BRANCH_CREATE),
  validate(createBranchRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const branch = await createBranch(
      tenantContextFrom(req),
      req.body as CreateBranchRequest,
      auditMeta(req)
    );
    sendSuccess(res, branch, 'Branch created', 201);
  }
);

router.patch(
  '/:branchId',
  authorize(PERMISSIONS.BRANCH_UPDATE),
  validate(branchParams, 'params'),
  validate(updateBranchRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { branchId } = req.params as z.infer<typeof branchParams>;
    const branch = await updateBranch(
      tenantContextFrom(req),
      branchId,
      req.body as UpdateBranchRequest,
      auditMeta(req)
    );
    sendSuccess(res, branch, 'Branch updated');
  }
);

/**
 * PUT, not PATCH: the whole week is replaced. A day left out is a day the branch
 * no longer opens. See the contract for why this is not a per-day endpoint.
 */
router.put(
  '/:branchId/operating-hours',
  authorize(PERMISSIONS.BRANCH_UPDATE),
  validate(branchParams, 'params'),
  validate(branchOperatingHoursRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { branchId } = req.params as z.infer<typeof branchParams>;
    const { hours } = req.body as BranchOperatingHoursRequest;
    const branch = await setOperatingHours(tenantContextFrom(req), branchId, hours, auditMeta(req));
    sendSuccess(res, branch, 'Operating hours updated');
  }
);

router.delete(
  '/:branchId',
  authorize(PERMISSIONS.BRANCH_DELETE),
  validate(branchParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { branchId } = req.params as z.infer<typeof branchParams>;
    await deleteBranch(tenantContextFrom(req), branchId, auditMeta(req));
    sendSuccess(res, null, 'Branch removed');
  }
);

export default router;
