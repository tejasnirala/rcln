import { Router, type IRouter, type Request, type Response } from 'express';
import {
  acceptInviteRequest,
  invitationTokenRequest,
  loginRequest,
  otpRequest,
  otpVerifyRequest,
  refreshRequest,
  switchBranchRequest,
  switchOrganizationRequest,
  type AcceptInviteRequest,
  type InvitationTokenRequest,
  type LoginRequest,
  type OtpRequest,
  type OtpVerifyRequest,
  type RefreshRequest,
  type SwitchBranchRequest,
} from '@rcln/contracts';
import { withTenant } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { authenticate, requireAuth, tenantContextFrom } from '../../middleware/auth.middleware.js';
import {
  authLimiter,
  identityLimiter,
  otpLimiter,
} from '../../middleware/rateLimiter.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  buildAuthSession,
  describeSession,
  loadAuthenticatedUser,
  verifyCredentials,
} from '../../services/auth/login.service.js';
import { requestOtp, verifyOtp } from '../../services/auth/otp.service.js';
import {
  acceptInvitation,
  previewInvitation,
} from '../../services/invitation/invitation.service.js';
import {
  findLiveSession,
  revokeSession,
  rotateRefreshToken,
  setActiveScope,
} from '../../services/auth/session.service.js';
import { loadUserAccess } from '../../services/auth/access.service.js';
import { recordAudit } from '../../services/audit/audit.service.js';
import { accessTokenLifetimeSeconds, signAccessToken } from '../../services/auth/token.service.js';
import { AuthenticationError, AuthorizationError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

/**
 * Authentication.
 *
 * TENANT SCOPE
 *   `resolveTenant` has already run app-wide, so `req.tenant` is the
 *   organization named by the Host header — and it is absent on the apex and on
 *   admin.<root>, which is exactly how a platform admin signs in without
 *   belonging to any tenant.
 *
 *   `requireTenant` is deliberately NOT applied to this router. Login has to
 *   work on both surfaces, and the per-route logic below decides which
 *   organization (if any) the session is scoped to.
 *
 * RATE LIMITING
 *   `authLimiter` on everything: these are the endpoints worth brute-forcing.
 *   OTP additionally gets `otpLimiter`, which meters per phone number rather
 *   than per IP so rotating addresses cannot spam one person's handset.
 */

const router: IRouter = Router();

/** The tenant this request is signing in to, or null on the apex/admin host. */
function targetOrganizationId(req: Request): string | null {
  return req.tenant?.organizationId ?? null;
}

router.post(
  '/login',
  authLimiter,
  // Per-account as well as per-address: one office NAT must not be one budget,
  // and one account must not be sprayable from a thousand addresses.
  identityLimiter,
  validate(loginRequest, 'body'),
  async (req: Request, res: Response) => {
    const input = req.body as LoginRequest;

    const userId = await verifyCredentials(input.identifier, input.password);
    const user = await loadAuthenticatedUser(userId);

    const session = await buildAuthSession({
      user,
      organizationId: targetOrganizationId(req),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Id only — never the identifier that was just used to sign in.
    logger.info({ userId, organizationId: session.activeOrganizationId }, 'login succeeded');

    sendSuccess(res, session, 'Signed in');
  }
);

router.post(
  '/otp/request',
  authLimiter,
  otpLimiter,
  validate(otpRequest, 'body'),
  async (req: Request, res: Response) => {
    const { phone } = req.body as OtpRequest;
    await requestOtp(phone);

    // One response whether or not that number has an account. See otp.service.
    sendSuccess(
      res,
      { sent: true as const },
      'If that number has an account, a code is on its way.'
    );
  }
);

router.post(
  '/otp/verify',
  authLimiter,
  validate(otpVerifyRequest, 'body'),
  async (req: Request, res: Response) => {
    const input = req.body as OtpVerifyRequest;

    const userId = await verifyOtp(input.phone, input.code);
    const user = await loadAuthenticatedUser(userId);

    const session = await buildAuthSession({
      user,
      organizationId: targetOrganizationId(req),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Verifying a code proves control of the handset, which is exactly what
    // phone verification means. Record it.
    await unsafeDbClient().user.updateMany({
      where: { id: userId, phoneVerifiedAt: null },
      data: { phoneVerifiedAt: new Date() },
    });

    logger.info({ userId, organizationId: session.activeOrganizationId }, 'otp login succeeded');
    sendSuccess(res, session, 'Signed in');
  }
);

/**
 * Exchange a refresh token for a new pair.
 *
 * Unauthenticated by design — the access token is expected to be expired, which
 * is the whole reason the client is here. The refresh token is the credential.
 */
router.post(
  '/refresh',
  authLimiter,
  validate(refreshRequest, 'body'),
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body as RefreshRequest;

    // Rotates, and revokes the whole family if this token was already used.
    const rotated = await rotateRefreshToken(refreshToken);
    const user = await loadAuthenticatedUser(rotated.userId);

    /**
     * Re-check membership on every refresh.
     *
     * A user removed from an organization mid-session must not be able to keep
     * renewing indefinitely. This is the checkpoint where that takes effect.
     */
    let membershipId: string | null = null;
    if (rotated.activeOrganizationId) {
      const access = await loadUserAccess(user.id, rotated.activeOrganizationId);
      if (!access && !user.isPlatformAdmin) {
        await revokeSession(rotated.id);
        throw new AuthenticationError('Your access to this organization has been removed.');
      }
      membershipId = access?.membershipId ?? null;
    }

    const accessToken = signAccessToken({
      userId: user.id,
      sessionId: rotated.id,
      isPlatformAdmin: user.isPlatformAdmin,
      membershipId,
      organizationId: rotated.activeOrganizationId,
      branchId: rotated.activeBranchId,
      impersonatedByUserId: rotated.impersonatedByUserId,
    });

    const session = await describeSession(
      user.id,
      rotated.activeOrganizationId,
      rotated.activeBranchId,
      { accessToken, refreshToken: rotated.refreshToken }
    );

    sendSuccess(res, session, 'Session refreshed');
  }
);

/**
 * Invitations — the accept side.
 *
 * ON THIS ROUTER, NOT /invitations
 *   The issuing routes sit behind `requireTenant, authenticate, requireAuth,
 *   authorize`. Every one of those would reject the person these two exist for:
 *   they hold no membership in this organization, which is the thing they are
 *   here to obtain, and usually no account at all.
 *
 * THE TENANT STILL MATTERS, AND IT IS THE HOST THAT SUPPLIES IT
 *   `resolveTenant` has already run, so `req.tenant` names the clinic whose
 *   subdomain the invitee opened. That id is handed to the service, whose
 *   transaction adopts it — so RLS on `invitations` narrows the token lookup to
 *   that organization, and clinic A's invitation is invisible at clinic B's
 *   host. No comparison in application code, so none to forget.
 *
 *   The apex has no tenant, so there is nothing to look a token up against: 404,
 *   for the same reason `requireTenant` answers 404 rather than 403.
 *
 * The token is in the BODY on both routes. It is a credential that mints a
 * membership, and a path or query string is written to every access log between
 * the browser and here.
 */
function invitedOrganizationId(req: Request, res: Response): string | null {
  const organizationId = req.tenant?.organizationId;
  if (!organizationId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return null;
  }
  return organizationId;
}

router.post(
  '/invitations/preview',
  authLimiter,
  validate(invitationTokenRequest, 'body'),
  async (req: Request, res: Response) => {
    const organizationId = invitedOrganizationId(req, res);
    if (!organizationId) return;

    const { token } = req.body as InvitationTokenRequest;
    sendSuccess(res, await previewInvitation(organizationId, token), 'Invitation');
  }
);

/**
 * Accept, and land signed in.
 *
 * A session is minted here rather than bouncing to /login, for both paths: the
 * new user has just chosen a password and the existing one has just re-entered
 * theirs, so asking again is a step that proves nothing. The session is scoped
 * to this host and this organization, which is what the membership they just
 * gained is for.
 */
router.post(
  '/invitations/accept',
  authLimiter,
  validate(acceptInviteRequest, 'body'),
  async (req: Request, res: Response) => {
    const organizationId = invitedOrganizationId(req, res);
    if (!organizationId) return;

    const input = req.body as AcceptInviteRequest;

    const accepted = await acceptInvitation(organizationId, input, {
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(req.get('user-agent') !== undefined
        ? { userAgent: req.get('user-agent') as string }
        : {}),
    });

    const user = await loadAuthenticatedUser(accepted.userId);
    const session = await buildAuthSession({
      user,
      organizationId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    logger.info({ organizationId, isNewUser: accepted.isNewUser }, 'invitation accept signed in');
    sendSuccess(res, session, 'Welcome aboard', 201);
  }
);

router.post('/logout', authenticate, requireAuth, async (req: Request, res: Response) => {
  const auth = req.auth;
  if (auth) {
    await revokeSession(auth.sessionId);
    logger.info({ userId: auth.userId }, 'logout');
  }
  sendSuccess(res, { signedOut: true as const }, 'Signed out');
});

/**
 * The current session, with permissions re-resolved.
 *
 * This endpoint exists because the permission list is not in the JWT. After any
 * role change the client refetches here rather than waiting for a new token.
 */
router.get('/session', authenticate, requireAuth, async (req: Request, res: Response) => {
  const auth = req.auth as NonNullable<Request['auth']>;

  const session = await describeSession(auth.userId, auth.organizationId, auth.branchId, {
    // The caller already holds these; echoing the access token keeps the
    // response shape identical to login, and no new refresh token is minted
    // (that only happens on rotation).
    accessToken: (req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
    refreshToken: '',
  });

  sendSuccess(res, session, 'Session');
});

/**
 * Change the active branch.
 *
 * An UPDATE plus a re-issued access token — never a re-login. The refresh token
 * survives, so a tab left open in another branch is not signed out.
 */
router.post(
  '/switch-branch',
  authenticate,
  requireAuth,
  validate(switchBranchRequest, 'body'),
  async (req: Request, res: Response) => {
    const auth = req.auth as NonNullable<Request['auth']>;
    const { branchId } = req.body as SwitchBranchRequest;

    if (!auth.organizationId) {
      throw new AuthorizationError('No active organization');
    }

    /**
     * Validate against the caller's OWN membership_roles, not against the list
     * of branches that exist. `branchScope` is what authenticate resolved for
     * this user; a branch outside it is one they hold no assignment for.
     */
    if (!auth.branchScope.includes(branchId)) {
      // 404, not 403: confirming the branch exists would leak the tenant's
      // structure to someone with no access to it.
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const branch = await withTenant(
      { organizationId: auth.organizationId, branchIds: auth.branchScope, userId: auth.userId },
      async (tx) =>
        tx.branch.findFirst({
          where: { id: branchId, status: 'ACTIVE', deletedAt: null },
          select: { id: true },
        })
    );

    if (!branch) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    await setActiveScope(auth.sessionId, auth.organizationId, branchId);

    const accessToken = signAccessToken({
      userId: auth.userId,
      sessionId: auth.sessionId,
      isPlatformAdmin: auth.isPlatformAdmin,
      membershipId: auth.membershipId,
      organizationId: auth.organizationId,
      branchId,
      impersonatedByUserId: auth.impersonatedByUserId,
    });

    // Auditable: who moved where, and when. Required by CONVENTIONS.md.
    const auditCtx = tenantContextFrom(req);
    await withTenant(auditCtx, (tx) =>
      recordAudit(tx, auditCtx, {
        action: 'SWITCH_BRANCH',
        entityType: 'session',
        entityId: auth.sessionId,
        before: { branchId: auth.branchId },
        after: { branchId },
        branchId,
      })
    );

    const session = await describeSession(auth.userId, auth.organizationId, branchId, {
      accessToken,
      refreshToken: '',
    });

    sendSuccess(res, session, 'Branch switched');
  }
);

/**
 * Change the active organization.
 *
 * For someone who works at more than one clinic. Note the session moves, but
 * the browser must still navigate to that organization's subdomain — a cookie
 * is scoped to one host, and the tenant is resolved from the Host header.
 */
router.post(
  '/switch-organization',
  authenticate,
  requireAuth,
  validate(switchOrganizationRequest, 'body'),
  async (req: Request, res: Response) => {
    const auth = req.auth as NonNullable<Request['auth']>;
    const { organizationId } = req.body as { organizationId: string };

    const access = await loadUserAccess(auth.userId, organizationId);
    if (!access) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const user = await loadAuthenticatedUser(auth.userId);
    const session = await findLiveSession(auth.sessionId);
    if (!session) throw new AuthenticationError('Session expired. Please sign in again.');

    const branchId = access.branchIds[0] ?? null;
    await setActiveScope(auth.sessionId, organizationId, branchId);

    const accessToken = signAccessToken({
      userId: auth.userId,
      sessionId: auth.sessionId,
      isPlatformAdmin: user.isPlatformAdmin,
      membershipId: access.membershipId,
      organizationId,
      branchId,
      impersonatedByUserId: auth.impersonatedByUserId,
    });

    const described = await describeSession(auth.userId, organizationId, branchId, {
      accessToken,
      refreshToken: '',
    });

    sendSuccess(
      res,
      { ...described, expiresIn: accessTokenLifetimeSeconds() },
      'Organization switched'
    );
  }
);

export default router;
