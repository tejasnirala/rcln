import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  inviteMemberRequest,
  revokeInvitationRequest,
  type InviteMemberRequest,
  type RevokeInvitationRequest,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { inviteLimiter } from '../../middleware/rateLimiter.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from '../../services/invitation/invitation.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Issuing invitations, on a clinic's own subdomain.
 *
 * The same chain as branches.routes.ts, in the same order, for the same reasons:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * plus `inviteLimiter` on the two routes that cause an email to be sent. That
 * sits AFTER authorize deliberately: a caller who may not invite should be
 * refused on the merits rather than spending someone else's budget to find out.
 *
 * ACCEPTING IS NOT HERE. It lives on the auth router, because the person
 * accepting has no membership in this organization and frequently no account at
 * all — every piece of middleware below would reject them. See auth.routes.ts.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const invitationParams = z.object({ invitationId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/**
 * `iam.user.read`, not `iam.user.invite`.
 *
 * Seeing who is on their way in is part of seeing the staff list; it does not
 * imply being able to add to it. The response also carries the assignable roles,
 * which the issue form needs and which are not secret within a tenant.
 */
router.get(
  '/',
  authorize(PERMISSIONS.IAM_USER_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await listInvitations(tenantContextFrom(req)));
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.IAM_USER_INVITE),
  inviteLimiter,
  validate(inviteMemberRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const invitation = await createInvitation(
      tenantContextFrom(req),
      req.body as InviteMemberRequest,
      auditMeta(req)
    );
    sendSuccess(res, invitation, 'Invitation sent', 201);
  }
);

/**
 * POST, not PUT: this is not idempotent. Each call mints a new token and kills
 * the previous one, which is the point — see resendInvitation.
 */
router.post(
  '/:invitationId/resend',
  authorize(PERMISSIONS.IAM_USER_INVITE),
  inviteLimiter,
  validate(invitationParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { invitationId } = req.params as z.infer<typeof invitationParams>;
    const invitation = await resendInvitation(tenantContextFrom(req), invitationId, auditMeta(req));
    sendSuccess(res, invitation, 'Invitation sent again');
  }
);

/**
 * DELETE, with a body.
 *
 * The row survives — `revokedAt` is set, so who was invited and who cancelled it
 * stays answerable. An optional reason rides along to the audit row and is never
 * shown to the invitee.
 */
router.delete(
  '/:invitationId',
  authorize(PERMISSIONS.IAM_USER_INVITE),
  validate(invitationParams, 'params'),
  validate(revokeInvitationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { invitationId } = req.params as z.infer<typeof invitationParams>;
    const { reason } = req.body as RevokeInvitationRequest;
    const invitation = await revokeInvitation(
      tenantContextFrom(req),
      invitationId,
      reason,
      auditMeta(req)
    );
    sendSuccess(res, invitation, 'Invitation revoked');
  }
);

export default router;
