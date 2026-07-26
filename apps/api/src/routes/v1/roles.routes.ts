import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createRoleRequest,
  updateRoleRequest,
  type CreateRoleRequest,
  type UpdateRoleRequest,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  callerFrom,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { createRole, deleteRole, listRoles, updateRole } from '../../services/iam/role.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Custom roles, on a clinic's own subdomain.
 *
 * The same chain as branches.routes.ts, in the same order, for the same reasons:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * `iam.role.read` to look, `iam.role.manage` to write. Reading is separate
 * because assigning a role means knowing what it grants, and `iam.role.read` is
 * in BRANCH_ADMIN's list while `iam.role.manage` deliberately is not.
 *
 * `callerFrom(req)` rides alongside the tenant context on every write. The
 * services need to know what the CALLER may do, not just which tenant they are
 * in — see services/iam/guards.ts.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const roleParams = z.object({ roleId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/**
 * Roles, the permission catalogue and what this caller may grant, in one answer.
 *
 * The catalogue is static and the same for everyone, but it is served from here
 * rather than bundled into the browser: `@rcln/permissions` is a server package,
 * and a copy of it in the client bundle would go stale the first time a code was
 * added.
 */
router.get(
  '/',
  authorize(PERMISSIONS.IAM_ROLE_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await listRoles(tenantContextFrom(req), callerFrom(req)));
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.IAM_ROLE_MANAGE),
  validate(createRoleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const role = await createRole(
      tenantContextFrom(req),
      callerFrom(req),
      req.body as CreateRoleRequest,
      auditMeta(req)
    );
    sendSuccess(res, role, 'Role created', 201);
  }
);

/**
 * PATCH, but `permissionCodes` is replaced wholesale when it is sent — an
 * omitted code is a permission the role stops granting. The contract says so;
 * it is the same shape as a branch's operating hours.
 */
router.patch(
  '/:roleId',
  authorize(PERMISSIONS.IAM_ROLE_MANAGE),
  validate(roleParams, 'params'),
  validate(updateRoleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { roleId } = req.params as z.infer<typeof roleParams>;
    const role = await updateRole(
      tenantContextFrom(req),
      callerFrom(req),
      roleId,
      req.body as UpdateRoleRequest,
      auditMeta(req)
    );
    sendSuccess(res, role, 'Role updated');
  }
);

/**
 * A hard delete, unlike everything else in this codebase — and safe only
 * because the service refuses when anyone still holds the role. `role_id` on
 * `membership_roles` cascades, so deleting a role in use would strip it from
 * every holder without a word.
 */
router.delete(
  '/:roleId',
  authorize(PERMISSIONS.IAM_ROLE_MANAGE),
  validate(roleParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { roleId } = req.params as z.infer<typeof roleParams>;
    await deleteRole(tenantContextFrom(req), callerFrom(req), roleId, auditMeta(req));
    sendSuccess(res, null, 'Role removed');
  }
);

export default router;
