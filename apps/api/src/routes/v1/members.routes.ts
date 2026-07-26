import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  assignRoleRequest,
  memberStatusRequest,
  permissionOverrideRequest,
  updateMemberRequest,
  type AssignRoleRequest,
  type MemberStatusRequest,
  type PermissionOverrideRequest,
  type UpdateMemberRequest,
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
import {
  assignRole,
  clearOverride,
  getMember,
  listMembers,
  revokeRole,
  setMemberStatus,
  setOverride,
  updateMember,
} from '../../services/iam/member.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Staff and their access, on a clinic's own subdomain.
 *
 * The same chain as branches.routes.ts, in the same order, for the same reasons.
 * Three permissions, deliberately separate:
 *
 *   iam.user.read       see who works here and what they hold
 *   iam.permission.assign  change what they may do
 *   iam.user.update     employment record only — grants nothing
 *   iam.user.suspend    cut off access without unpicking the roles
 *
 * Seeing the staff list does not imply changing it, and a practice manager who
 * keeps employee codes up to date has no business assigning roles. Splitting
 * them costs one line each here and is the difference between a role model and
 * a single "admin" flag.
 *
 * Everything acts on a MEMBERSHIP id, never a user id: a person may work at two
 * clinics, and only one of those memberships is any of this tenant's business.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const memberParams = z.object({ membershipId: z.uuid() });
const assignmentParams = memberParams.extend({ assignmentId: z.uuid() });
const overrideParams = memberParams.extend({ overrideId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.IAM_USER_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await listMembers(tenantContextFrom(req), callerFrom(req)));
  }
);

router.get(
  '/:membershipId',
  authorize(PERMISSIONS.IAM_USER_READ),
  validate(memberParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    sendSuccess(res, await getMember(tenantContextFrom(req), membershipId));
  }
);

/** The employment record. Grants nothing, so it is not `iam.permission.assign`. */
router.patch(
  '/:membershipId',
  authorize(PERMISSIONS.IAM_USER_UPDATE),
  validate(memberParams, 'params'),
  validate(updateMemberRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    const member = await updateMember(
      tenantContextFrom(req),
      membershipId,
      req.body as UpdateMemberRequest,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Details updated');
  }
);

router.post(
  '/:membershipId/roles',
  authorize(PERMISSIONS.IAM_PERMISSION_ASSIGN),
  validate(memberParams, 'params'),
  validate(assignRoleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    const member = await assignRole(
      tenantContextFrom(req),
      callerFrom(req),
      membershipId,
      req.body as AssignRoleRequest,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Role assigned', 201);
  }
);

router.delete(
  '/:membershipId/roles/:assignmentId',
  authorize(PERMISSIONS.IAM_PERMISSION_ASSIGN),
  validate(assignmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId, assignmentId } = req.params as z.infer<typeof assignmentParams>;
    const member = await revokeRole(
      tenantContextFrom(req),
      membershipId,
      assignmentId,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Role removed');
  }
);

/**
 * POST, not PUT, and it is idempotent on (member, permission, branch): sending
 * the other effect flips the existing override rather than failing. There is at
 * most one row per triple — the unique index says so.
 */
router.post(
  '/:membershipId/overrides',
  authorize(PERMISSIONS.IAM_PERMISSION_ASSIGN),
  validate(memberParams, 'params'),
  validate(permissionOverrideRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    const member = await setOverride(
      tenantContextFrom(req),
      callerFrom(req),
      membershipId,
      req.body as PermissionOverrideRequest,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Exception saved');
  }
);

router.delete(
  '/:membershipId/overrides/:overrideId',
  authorize(PERMISSIONS.IAM_PERMISSION_ASSIGN),
  validate(overrideParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId, overrideId } = req.params as z.infer<typeof overrideParams>;
    const member = await clearOverride(
      tenantContextFrom(req),
      membershipId,
      overrideId,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Exception removed');
  }
);

/**
 * Suspension keeps the membership and everything on it. It is reversible, which
 * is what makes it the right answer to "revoke their access now" — nobody has to
 * reconstruct a role set afterwards.
 */
router.post(
  '/:membershipId/suspend',
  authorize(PERMISSIONS.IAM_USER_SUSPEND),
  validate(memberParams, 'params'),
  validate(memberStatusRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    const { reason } = req.body as MemberStatusRequest;
    const member = await setMemberStatus(
      tenantContextFrom(req),
      membershipId,
      'SUSPENDED',
      reason,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Access suspended');
  }
);

router.post(
  '/:membershipId/reactivate',
  authorize(PERMISSIONS.IAM_USER_SUSPEND),
  validate(memberParams, 'params'),
  validate(memberStatusRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { membershipId } = req.params as z.infer<typeof memberParams>;
    const { reason } = req.body as MemberStatusRequest;
    const member = await setMemberStatus(
      tenantContextFrom(req),
      membershipId,
      'ACTIVE',
      reason,
      auditMeta(req)
    );
    sendSuccess(res, member, 'Access restored');
  }
);

export default router;
