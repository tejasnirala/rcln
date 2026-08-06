import { Router, type IRouter, type Request, type Response } from 'express';
import {
  acceptInviteRequest,
  impersonationClaimRequest,
  invitationTokenRequest,
  loginRequest,
  otpRequest,
  otpVerifyRequest,
  refreshRequest,
  switchBranchRequest,
  switchOrganizationRequest,
  verificationConfirmRequest,
  type AcceptInviteRequest,
  type ImpersonationClaimRequest,
  type InvitationTokenRequest,
  type LoginRequest,
  type OtpRequest,
  type OtpVerifyRequest,
  type RefreshRequest,
  type SwitchBranchRequest,
  type VerificationConfirmRequest,
} from '@rcln/contracts';
import { withTenant } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { authenticate, requireAuth, tenantContextFrom } from '../../middleware/auth.middleware.js';
import {
  authLimiter,
  identityLimiter,
  otpLimiter,
  verificationLimiter,
} from '../../middleware/rateLimiter.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  buildAuthSession,
  defaultBranchId,
  describeSession,
  loadAuthenticatedUser,
  verifyCredentials,
} from '../../services/auth/login.service.js';
import { requestOtp, verifyOtp } from '../../services/auth/otp.service.js';
import {
  confirmVerification,
  requestVerification,
} from '../../services/auth/verification.service.js';
import {
  acceptInvitation,
  previewInvitation,
} from '../../services/invitation/invitation.service.js';
import {
  claimImpersonation,
  describeImpersonation,
  stopImpersonation,
} from '../../services/platform/impersonation.service.js';
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
      { accessToken, refreshToken: rotated.refreshToken },
      /*
       * Reachable, and routinely: an impersonation session renews like any other
       * now, bounded by the ceiling `rotateRefreshToken` applies. This used to be
       * dead code guarding against the banner vanishing on one endpoint — it is
       * the path that keeps the strip on screen through a morning's work.
       *
       * `createdAt`, not `expiresAt`: the deadline shown is the ceiling, and the
       * row's `expires_at` has just slid forward.
       */
      await describeImpersonation(
        rotated.activeOrganizationId,
        rotated.impersonatedByUserId,
        rotated.createdAt
      )
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

/**
 * Verifying your own email address and phone number.
 *
 * NO PERMISSION CODE, AND THAT IS NOT AN OVERSIGHT
 *   Nothing here names an account. The user id comes off the access token, so
 *   these four routes can only ever act on the caller's own row — there is no
 *   input for an escalation guard to check, and inventing a permission would
 *   only create a way for an administrator to lock someone out of confirming
 *   their own address.
 *
 * NOT BEHIND `requireTenant` EITHER
 *   The rest of this router is not, and these belong with it: a platform admin
 *   on admin.<root> has no organization, and they are the one account that
 *   cannot ask a colleague to do it for them.
 *
 * `authLimiter` is deliberately absent. It meters per address, and a clinic
 * arrives through one office NAT; `verificationLimiter` meters the account and
 * the channel, which is the thing actually worth rationing here.
 */
function verifyRoutes(channel: 'email' | 'phone'): void {
  router.post(
    `/verify/${channel}/request`,
    authenticate,
    requireAuth,
    verificationLimiter,
    async (req: Request, res: Response) => {
      const auth = req.auth as NonNullable<Request['auth']>;
      const outcome = await requestVerification(auth.userId, channel);

      sendSuccess(
        res,
        outcome,
        outcome.alreadyVerified
          ? `Your ${channel === 'email' ? 'email address' : 'phone number'} is already verified.`
          : 'Code sent.'
      );
    }
  );

  router.post(
    `/verify/${channel}/confirm`,
    authenticate,
    requireAuth,
    verificationLimiter,
    validate(verificationConfirmRequest, 'body'),
    async (req: Request, res: Response) => {
      const auth = req.auth as NonNullable<Request['auth']>;
      const { code } = req.body as VerificationConfirmRequest;

      const result = await confirmVerification({
        userId: auth.userId,
        channel,
        code,
        // Present only inside a clinic. See the note on ConfirmVerificationInput
        // for why a missing organization is a skipped audit row and not a 403.
        ...(auth.organizationId ? { tenant: tenantContextFrom(req) } : {}),
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(req.get('user-agent') !== undefined
          ? { userAgent: req.get('user-agent') as string }
          : {}),
      });

      logger.info({ userId: auth.userId, channel }, 'contact verified');
      sendSuccess(
        res,
        result,
        result.alreadyVerified
          ? 'That was already verified.'
          : `Your ${channel === 'email' ? 'email address' : 'phone number'} is verified.`
      );
    }
  );
}

verifyRoutes('email');
verifyRoutes('phone');

/**
 * Impersonation, the two ends that have to live on a TENANT host.
 *
 * WHY THEY ARE HERE AND NOT ON /platform
 *   `claim` is the request that receives the session cookie, and a session
 *   cookie is host-only by design. It therefore has to be made to the clinic's
 *   own subdomain, where `resolveTenant` has already decided which organization
 *   this is — which is exactly what makes the cross-host check possible. It is
 *   unauthenticated for the same reason `/invitations/accept` is: the credential
 *   IS the ticket, and the caller holds nothing else on this host yet.
 *
 *   `stop` is authenticated by the impersonation session it is ending, which
 *   also only exists here.
 *
 * `authLimiter` on both: an unauthenticated endpoint that mints a session is
 * worth metering, even though the ticket it wants is 256 random bits with a
 * two-minute life.
 */
router.post(
  '/impersonation/claim',
  authLimiter,
  validate(impersonationClaimRequest, 'body'),
  async (req: Request, res: Response) => {
    const organizationId = req.tenant?.organizationId;
    if (!organizationId) {
      // The apex and admin.<root> resolve to no tenant, so there is nothing to
      // redeem a ticket against. 404, like requireTenant.
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const { handoffToken } = req.body as ImpersonationClaimRequest;

    const session = await claimImpersonation({
      organizationId,
      handoffToken,
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(req.get('user-agent') !== undefined
        ? { userAgent: req.get('user-agent') as string }
        : {}),
    });

    sendSuccess(res, session, 'Signed in', 201);
  }
);

router.post(
  '/impersonation/stop',
  authenticate,
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = req.auth as NonNullable<Request['auth']>;

    /*
     * Only an impersonation session can be stopped. An ordinary member calling
     * this has not been given a way to revoke their own session by another name
     * — that is /auth/logout, and conflating the two would put an audit row
     * claiming an impersonation ended on a session that never was one.
     */
    if (!auth.impersonatedByUserId || !auth.organizationId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    await stopImpersonation({
      sessionId: auth.sessionId,
      organizationId: auth.organizationId,
      adminUserId: auth.impersonatedByUserId,
      branchId: auth.branchId,
      branchIds: auth.branchScope,
      ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
      ...(req.get('user-agent') !== undefined
        ? { userAgent: req.get('user-agent') as string }
        : {}),
    });

    sendSuccess(res, { stopped: true as const }, 'Left the clinic');
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

  const session = await describeSession(
    auth.userId,
    auth.organizationId,
    auth.branchId,
    {
      // The caller already holds these; echoing the access token keeps the
      // response shape identical to login, and no new refresh token is minted
      // (that only happens on rotation).
      accessToken: (req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
      refreshToken: '',
    },
    // This is the call the shell makes on every render, so it is what keeps the
    // impersonation banner on screen for the whole visit.
    await describeImpersonation(
      auth.organizationId,
      auth.impersonatedByUserId,
      auth.sessionStartedAt
    )
  );

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
    await withTenant(auditCtx, async (tx) => {
      /*
       * Remember it, so the next sign-in returns them here.
       *
       * In the same transaction as the audit row, and after the scope checks
       * above — a remembered branch is only ever one the caller could reach at
       * the moment they reached it. `membershipId` is null for a platform admin
       * inside a clinic (they hold no membership, which is what makes it
       * impersonation), and there is nothing to remember on: the console
       * remembers the CLINIC for them instead, on `users`.
       */
      if (auth.membershipId) {
        await tx.membership.update({
          where: { id: auth.membershipId },
          data: { lastBranchId: branchId },
        });
      }

      await recordAudit(tx, auditCtx, {
        action: 'SWITCH_BRANCH',
        entityType: 'session',
        entityId: auth.sessionId,
        before: { branchId: auth.branchId },
        after: { branchId },
        branchId,
      });
    });

    const session = await describeSession(
      auth.userId,
      auth.organizationId,
      branchId,
      { accessToken, refreshToken: '' },
      await describeImpersonation(
        auth.organizationId,
        auth.impersonatedByUserId,
        auth.sessionStartedAt
      )
    );

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

    /*
     * The branch they were last in at THIS organization, not `branchIds[0]`.
     *
     * Someone who works at two clinics keeps a separate last branch at each —
     * that is why the preference lives on `memberships` rather than on `users`.
     * Arriving on whichever branch happened to sort first was the old behaviour
     * and it was arbitrary.
     */
    const branchId = await defaultBranchId(
      organizationId,
      auth.userId,
      access.branchIds,
      access.membershipId
    );
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

    const described = await describeSession(
      auth.userId,
      organizationId,
      branchId,
      { accessToken, refreshToken: '' },
      await describeImpersonation(organizationId, auth.impersonatedByUserId, auth.sessionStartedAt)
    );

    sendSuccess(
      res,
      { ...described, expiresIn: accessTokenLifetimeSeconds() },
      'Organization switched'
    );
  }
);

export default router;
