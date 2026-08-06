import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  billingOverviewQuery,
  cancelSubscriptionRequest,
  setAutoRenewRequest,
  startCheckoutRequest,
  upgradePreviewRequest,
  type CancelSubscriptionRequest,
  type SetAutoRenewRequest,
  type StartCheckoutRequest,
  type UpgradePreviewRequest,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { BillingError } from '@rcln/billing';
import { PaymentDeclinedError, PaymentUnavailableError } from '@rcln/payments';
import {
  authenticate,
  requireAuth,
  authorize,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { AppError, AuthenticationError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { withTenant } from '@rcln/db';
import * as billing from '../../services/billing/billing.service.js';

/**
 * A clinic's own subscription, on its own subdomain.
 *
 * The standard chain from CONVENTIONS.md, in the standard order:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * TWO PERMISSIONS, NOT ONE
 *   `organization.billing.read` sees what the clinic is on and what it has been
 *   invoiced. `organization.billing.manage` changes it. A practice manager who
 *   needs to download last month's invoice should not thereby be able to
 *   upgrade the plan or cancel the subscription — those are the owner's
 *   decisions, and they cost money.
 *
 * NOTHING HERE ACCEPTS AN AMOUNT
 *   The client names a `plan_prices` row. What it costs, including the
 *   proration, is computed server-side every time — including on apply, which
 *   never trusts the quote it showed. See the header of contracts/billing.ts.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const intentParams = z.object({ intentId: z.uuid() });

/**
 * Who the provider is told is paying, and who the audit row names.
 *
 * Read off the authenticated session, never off the body. `authenticate` has
 * already resolved the user; this reads their contact details once so the
 * provider's customer record carries a real billing contact rather than a
 * placeholder.
 */
async function actorFrom(req: Request): Promise<billing.BillingActor> {
  const ctx = tenantContextFrom(req);

  const user = await withTenant(ctx, (tx) =>
    tx.user.findUnique({
      where: { id: ctx.userId },
      select: { fullName: true, email: true, phone: true },
    })
  );

  if (!user) throw new AuthenticationError('Authentication required');

  return {
    userId: ctx.userId,
    fullName: user.fullName,
    // Cashfree and most acquirers require an email on the customer record. A
    // clinic administrator signed in by phone alone has none, so a routable
    // non-address is used rather than failing the checkout — the receipt goes
    // through our own notifications either way.
    email: user.email ?? `billing+${ctx.organizationId}@rcln.invalid`,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

function slugOf(req: Request): string {
  const slug = req.tenant?.slug;
  // requireTenant guarantees this; the check is here so the type is honest
  // rather than asserted with `!`.
  if (!slug) throw new AppError('Tenant could not be resolved', 404, 'NOT_FOUND');
  return slug;
}

/**
 * Turn a billing or provider failure into an HTTP answer.
 *
 * Three kinds, three answers, because the caller's correct response differs:
 *   BillingError            — a rule was broken. Its own status; usually 409.
 *   PaymentDeclinedError    — the acquirer said no. 402; retrying will not help.
 *   PaymentUnavailableError — we do not know. 503, and the customer should not
 *                             be told the payment failed, because it may not
 *                             have. Never presented as a decline.
 */
function asAppError(error: unknown): AppError {
  if (error instanceof BillingError) {
    return new AppError(error.message, error.statusCode, error.code);
  }
  if (error instanceof PaymentDeclinedError) {
    return new AppError(error.message, 402, 'PAYMENT_DECLINED');
  }
  if (error instanceof PaymentUnavailableError) {
    return new AppError(
      'The payment service did not respond. Nothing has been charged twice — check the billing page in a moment.',
      503,
      'PAYMENT_UNAVAILABLE'
    );
  }
  return error instanceof AppError ? error : new AppError('Billing request failed', 500);
}

/** Every handler goes through this, so the mapping above cannot be forgotten. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      throw asAppError(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The whole billing screen in one call. See getBillingOverview. */
router.get(
  '/',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(billingOverviewQuery, 'query'),
  handle(async (req, res) => {
    const ctx = tenantContextFrom(req);
    const overview = await billing.getOverview(ctx, await countryCodeFor(req));
    sendSuccess(res, overview);
  })
);

/** What the return page polls while it waits for the webhook. */
router.get(
  '/payments/:intentId',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(intentParams, 'params'),
  handle(async (req, res) => {
    const { intentId } = req.params as z.infer<typeof intentParams>;
    sendSuccess(res, await billing.getPaymentStatus(tenantContextFrom(req), intentId));
  })
);

/**
 * Ask the provider directly and apply the answer.
 *
 * POST rather than GET because it can change state — it is the pull half of the
 * webhook's push, and the return page calls it once when the row is still
 * pending rather than on every poll.
 */
router.post(
  '/payments/:intentId/reconcile',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(intentParams, 'params'),
  handle(async (req, res) => {
    const { intentId } = req.params as z.infer<typeof intentParams>;
    sendSuccess(res, await billing.reconcileIntent(tenantContextFrom(req), slugOf(req), intentId));
  })
);

const mandateParams = z.object({ mandateId: z.uuid() });

/** What the return page polls after the customer authorises a mandate. */
router.get(
  '/mandate/:mandateId',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(mandateParams, 'params'),
  handle(async (req, res) => {
    const { mandateId } = req.params as z.infer<typeof mandateParams>;
    sendSuccess(res, await billing.getMandateStatus(tenantContextFrom(req), mandateId));
  })
);

/**
 * Ask the provider whether the mandate was actually authorised, and apply it.
 *
 * ⚠️ NOT AN OPTIMISATION — ON CASHFREE IT IS THE ONLY PATH.
 *   Their Payment Gateway webhook catalogue contains no `SUBSCRIPTION_*` events;
 *   those belong to the Subscriptions product and are configured separately. A
 *   merchant with only PG webhooks set up would otherwise have a mandate stuck
 *   PENDING for ever and automatic renewal permanently unavailable, with nothing
 *   reporting a fault. See `reconcileMandate`.
 */
router.post(
  '/mandate/:mandateId/reconcile',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(mandateParams, 'params'),
  handle(async (req, res) => {
    const { mandateId } = req.params as z.infer<typeof mandateParams>;
    sendSuccess(
      res,
      await billing.reconcileMandate(tenantContextFrom(req), slugOf(req), mandateId)
    );
  })
);

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

router.post(
  '/checkout',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  validate(startCheckoutRequest, 'body'),
  handle(async (req, res) => {
    const { planPriceId } = req.body as StartCheckoutRequest;
    const result = await billing.startCheckout(
      tenantContextFrom(req),
      slugOf(req),
      await actorFrom(req),
      planPriceId
    );
    sendSuccess(res, result, 'Payment started', 201);
  })
);

/**
 * What an upgrade would cost. A POST because it names a resource in the body and
 * is not cacheable — nothing is written.
 */
router.post(
  '/subscription/upgrade/preview',
  authorize(PERMISSIONS.ORG_BILLING_READ),
  validate(upgradePreviewRequest, 'body'),
  handle(async (req, res) => {
    const { planPriceId } = req.body as UpgradePreviewRequest;
    sendSuccess(
      res,
      await billing.previewUpgrade(tenantContextFrom(req), slugOf(req), planPriceId)
    );
  })
);

router.post(
  '/subscription/upgrade',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  validate(upgradePreviewRequest, 'body'),
  handle(async (req, res) => {
    const { planPriceId } = req.body as UpgradePreviewRequest;
    const result = await billing.applyUpgrade(
      tenantContextFrom(req),
      slugOf(req),
      await actorFrom(req),
      planPriceId
    );
    sendSuccess(res, result, result.status === 'SUCCEEDED' ? 'Plan changed' : 'Payment started');
  })
);

router.post(
  '/subscription/cancel',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  validate(cancelSubscriptionRequest, 'body'),
  handle(async (req, res) => {
    const result = await billing.cancel(
      tenantContextFrom(req),
      slugOf(req),
      await actorFrom(req),
      req.body as CancelSubscriptionRequest
    );
    sendSuccess(res, result, 'Subscription will end');
  })
);

router.post(
  '/subscription/resume',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  handle(async (req, res) => {
    const result = await billing.resume(tenantContextFrom(req), slugOf(req), await actorFrom(req));
    sendSuccess(res, result, 'Subscription will continue');
  })
);

router.put(
  '/subscription/auto-renew',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  validate(setAutoRenewRequest, 'body'),
  handle(async (req, res) => {
    const { enabled } = req.body as SetAutoRenewRequest;
    const result = await billing.setAutoRenew(
      tenantContextFrom(req),
      slugOf(req),
      await actorFrom(req),
      enabled
    );
    sendSuccess(res, result, enabled ? 'Automatic renewal on' : 'Automatic renewal off');
  })
);

/** Authorise future debits. A separate act from paying — see startMandateSetup. */
router.post(
  '/mandate',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  handle(async (req, res) => {
    const result = await billing.startMandateSetup(
      tenantContextFrom(req),
      slugOf(req),
      await actorFrom(req)
    );
    sendSuccess(res, result, 'Authorisation started', 201);
  })
);

router.delete(
  '/mandate',
  authorize(PERMISSIONS.ORG_BILLING_MANAGE),
  handle(async (req, res) => {
    await billing.revokeMandate(tenantContextFrom(req), slugOf(req), await actorFrom(req));
    sendSuccess(res, null, 'Automatic payment removed');
  })
);

/**
 * The clinic's country, for a first-time currency default.
 *
 * From the organization row, not from the request. A header-derived country
 * would change what a clinic is quoted depending on where its administrator
 * happened to open the page.
 */
async function countryCodeFor(req: Request): Promise<string | null> {
  const ctx = tenantContextFrom(req);
  const organization = await withTenant(ctx, (tx) =>
    tx.organization.findFirst({
      where: { id: ctx.organizationId },
      select: { countryCode: true },
    })
  );
  return organization?.countryCode ?? null;
}

export default router;
