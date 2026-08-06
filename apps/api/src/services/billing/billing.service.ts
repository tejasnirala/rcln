/**
 * The API's billing service: thin, on purpose.
 *
 * ALL THE RULES LIVE IN `@rcln/billing`. Proration, dunning, what a plan grants,
 * when a period ends — none of it is here, because the worker needs the same
 * answers and two copies of a billing rule is two opinions about when a clinic
 * gets suspended. This file's whole job is to turn a request into a
 * `BillingRuntime` and hand it over.
 *
 * WHAT IT DOES ADD
 *   - The clinic's own origin, so a customer always returns to their subdomain.
 *   - The billing contact sent to the provider, which is the CALLER — never a
 *     patient, and never read from the request body.
 *   - The audit hook, so a plan change lands on `audit_logs` with the acting
 *     user and their address, alongside the commercial row in
 *     `subscription_changes`.
 */

import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import {
  cancelSubscription as engineCancel,
  getBillingOverview,
  quoteUpgrade,
  resumeSubscription as engineResume,
  setAutoRenew as engineSetAutoRenew,
  applyMandateResult,
  revokeMandate as engineRevokeMandate,
  settleIntent,
  startCheckout as engineStartCheckout,
  startMandateSetup as engineStartMandateSetup,
  startUpgrade as engineStartUpgrade,
  billingCurrencyFor,
  type BillingRuntime,
} from '@rcln/billing';
import { fromMajor } from '@rcln/payments';
import type {
  BillingOverviewResponse,
  CancelSubscriptionRequest,
  CancelSubscriptionResponse,
  CheckoutResponse,
  MandateSetupResponse,
  MandateStatusResponse,
  PaymentStatusResponse,
  ResumeSubscriptionResponse,
  UpgradeQuoteResponse,
} from '@rcln/contracts';
import { config } from '../../config/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { paymentProvider, webhookUrlFor } from './provider.js';

/** Who is doing this, and where they are. Threaded onto the audit row. */
export interface BillingActor {
  userId: string;
  fullName: string;
  email: string;
  phone?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The clinic's own web origin.
 *
 * Built from the slug rather than taken from a header, so a forged
 * `x-forwarded-host` cannot make a customer's return URL point at somewhere
 * else. `ROOT_DOMAIN` and the scheme both come from server configuration.
 */
function tenantUrlFor(slug: string): string {
  const web = new URL(config.webUrl);
  return `${web.protocol}//${slug}.${config.rootDomain}${web.port ? `:${web.port}` : ''}`;
}

export function runtimeFor(slug: string, actor?: BillingActor | undefined): BillingRuntime {
  const provider = paymentProvider();

  return {
    provider,
    tenantUrl: tenantUrlFor(slug),
    webhookUrl: webhookUrlFor(provider.name),
    checkoutPresentation: config.payments.checkoutPresentation,
    audit: actor
      ? async (tx: TxClient, ctx: TenantContext, entry): Promise<void> => {
          await recordAudit(tx, ctx, {
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            ...(entry.before ? { before: entry.before } : {}),
            ...(entry.after ? { after: entry.after } : {}),
            ...(actor.ipAddress !== undefined ? { ipAddress: actor.ipAddress } : {}),
            ...(actor.userAgent !== undefined ? { userAgent: actor.userAgent } : {}),
          });
        }
      : undefined,
  };
}

/** How the engine opens a scoped transaction here: the ordinary `withTenant`. */
const run = <T>(ctx: TenantContext, fn: (tx: TxClient) => Promise<T>): Promise<T> =>
  withTenant(ctx, fn);

/**
 * The billing contact sent to the provider.
 *
 * ⚠️ THE CALLER, NEVER A PATIENT AND NEVER THE REQUEST BODY.
 *   It is whoever is signed in and holds `organization.billing.manage` — a
 *   clinic administrator. Taking a name and email from the body would let a
 *   caller put anything on the provider's customer record, including a string
 *   they copied out of a patient list.
 */
function customerFrom(actor: BillingActor): { name: string; email: string; phone?: string } {
  return {
    name: actor.fullName,
    email: actor.email,
    ...(actor.phone ? { phone: actor.phone } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOverview(
  ctx: TenantContext,
  countryCode: string | null
): Promise<BillingOverviewResponse> {
  const provider = paymentProvider();
  return withTenant(ctx, (tx) => getBillingOverview(tx, ctx, provider, countryCode));
}

/** Which currency this clinic is quoted in, for a screen that only needs that. */
export async function getBillingCurrency(
  ctx: TenantContext,
  countryCode: string | null
): Promise<string> {
  return withTenant(ctx, (tx) => billingCurrencyFor(tx, ctx, countryCode));
}

/**
 * The state of one payment attempt.
 *
 * What the return page polls. It reads OUR row rather than asking the provider
 * on every poll — the webhook is the authority and has almost always landed
 * first. Reconciliation against the provider is `reconcileIntent`, which the
 * page calls once if the row is still pending.
 */
export async function getPaymentStatus(
  ctx: TenantContext,
  intentId: string
): Promise<PaymentStatusResponse> {
  const intent = await withTenant(ctx, (tx) =>
    tx.paymentIntent.findFirst({
      where: { id: intentId, organizationId: ctx.organizationId },
      select: {
        id: true,
        status: true,
        purpose: true,
        amount: true,
        currency: true,
        failureMessage: true,
        invoiceId: true,
      },
    })
  );

  if (!intent) throw new NotFoundError('Payment');

  return {
    intentId: intent.id,
    status: intent.status,
    purpose: intent.purpose,
    // numeric(14,2) -> minor units, through the string form and the currency's
    // own exponent. Never `Number(x) * 100`: that is a float, and it is wrong
    // for every zero- and three-decimal currency besides.
    amountMinor: fromMajor(intent.amount.toString(), intent.currency).amountMinor,
    currency: intent.currency,
    failureMessage: intent.failureMessage,
    invoiceId: intent.invoiceId,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function startCheckout(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor,
  planPriceId: string
): Promise<CheckoutResponse> {
  const result = await engineStartCheckout(
    ctx,
    runtimeFor(slug, actor),
    { planPriceId, customer: customerFrom(actor) },
    run
  );

  return {
    intentId: result.intentId,
    ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
    ...(result.embedded ? { embedded: result.embedded } : {}),
    ...(result.purchase ? { purchase: result.purchase } : {}),
    ...(result.customer ? { customer: result.customer } : {}),
    status: result.status,
    amountMinor: result.amountMinor,
    currency: result.currency,
    ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
  };
}

export async function previewUpgrade(
  ctx: TenantContext,
  slug: string,
  planPriceId: string
): Promise<UpgradeQuoteResponse> {
  const quote = await quoteUpgrade(ctx, runtimeFor(slug), planPriceId, run);

  return {
    fromPlan: quote.fromPlan,
    toPlan: quote.toPlan,
    toPlanPriceId: quote.toPlanPriceId,
    currency: quote.currency,
    fullAmountMinor: quote.fullAmountMinor,
    proration: {
      periodDays: quote.proration.periodDays,
      remainingDays: quote.proration.remainingDays,
      creditMinor: quote.proration.credit.amountMinor,
      chargeMinor: quote.proration.charge.amountMinor,
      amountDueMinor: quote.proration.amountDue.amountMinor,
      isFree: quote.proration.isFree,
    },
    taxLines: quote.tax.lines.map((line) => ({
      name: line.name,
      rateBps: line.rateBps,
      amountMinor: line.amount.amountMinor,
    })),
    taxTotalMinor: quote.tax.total.amountMinor,
    totalDueMinor: quote.proration.amountDue.amountMinor + quote.tax.total.amountMinor,
    taxNote: quote.tax.reason,
    effectiveAt: quote.effectiveAt.toISOString(),
    nextRenewalAt: quote.nextRenewalAt.toISOString(),
  };
}

export async function applyUpgrade(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor,
  planPriceId: string
): Promise<CheckoutResponse> {
  const result = await engineStartUpgrade(
    ctx,
    runtimeFor(slug, actor),
    { planPriceId, customer: customerFrom(actor), actorUserId: actor.userId },
    run
  );

  return {
    intentId: result.intentId,
    ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
    ...(result.embedded ? { embedded: result.embedded } : {}),
    ...(result.purchase ? { purchase: result.purchase } : {}),
    ...(result.customer ? { customer: result.customer } : {}),
    status: result.status,
    amountMinor: result.amountMinor,
    currency: result.currency,
    ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
  };
}

export async function cancel(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor,
  input: CancelSubscriptionRequest
): Promise<CancelSubscriptionResponse> {
  const result = await engineCancel(
    ctx,
    runtimeFor(slug, actor),
    {
      immediate: input.immediate,
      actorUserId: actor.userId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    run
  );

  return { status: result.status, endsAt: result.endsAt.toISOString() };
}

export async function resume(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor
): Promise<ResumeSubscriptionResponse> {
  const result = await engineResume(
    ctx,
    runtimeFor(slug, actor),
    { actorUserId: actor.userId },
    run
  );
  return { nextRenewalAt: result.nextRenewalAt.toISOString() };
}

export async function setAutoRenew(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor,
  enabled: boolean
): Promise<{ autoRenew: boolean }> {
  return engineSetAutoRenew(ctx, runtimeFor(slug, actor), enabled, run);
}

export async function startMandateSetup(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor
): Promise<MandateSetupResponse> {
  const result = await engineStartMandateSetup(
    ctx,
    runtimeFor(slug, actor),
    { customer: customerFrom(actor) },
    run
  );

  return {
    mandateId: result.mandateId,
    ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
  };
}

export async function revokeMandate(
  ctx: TenantContext,
  slug: string,
  actor: BillingActor
): Promise<void> {
  await engineRevokeMandate(ctx, runtimeFor(slug, actor), run);
}

/**
 * The state of the clinic's payment authorisation.
 *
 * Read from our own row. `reconcileMandate` is the pull that goes to the
 * provider; this is what the screen polls afterwards.
 */
export async function getMandateStatus(
  ctx: TenantContext,
  mandateId: string
): Promise<MandateStatusResponse> {
  const mandate = await withTenant(ctx, (tx) =>
    tx.paymentMandate.findFirst({
      where: { id: mandateId, organizationId: ctx.organizationId },
      select: {
        id: true,
        status: true,
        method: true,
        instrumentLabel: true,
        maxAmount: true,
        currency: true,
        activatedAt: true,
      },
    })
  );

  if (!mandate) throw new NotFoundError('Payment authorisation');

  return {
    mandateId: mandate.id,
    status: mandate.status,
    method: mandate.method,
    instrumentLabel: mandate.instrumentLabel,
    maxAmountMinor: fromMajor(mandate.maxAmount.toString(), mandate.currency).amountMinor,
    currency: mandate.currency,
    activatedAt: mandate.activatedAt?.toISOString() ?? null,
  };
}

/**
 * Ask the provider whether the customer actually authorised the mandate.
 *
 * ⚠️ THIS IS NOT AN OPTIMISATION. IT IS THE ONLY PATH ON SOME PROVIDERS.
 *   Mandate activation used to arrive exclusively on a `SUBSCRIPTION_*` webhook.
 *   Cashfree's Payment Gateway webhook catalogue does not contain one — those
 *   events belong to their Subscriptions product and are configured separately,
 *   and a merchant who has only set up PG webhooks would have a mandate that sat
 *   PENDING for ever, with automatic renewal permanently impossible to turn on
 *   and nothing anywhere reporting a fault.
 *
 *   So the customer coming back from the authorisation page is a first-class
 *   trigger, exactly as it is for a charge: we ask the provider directly rather
 *   than believing the redirect. `applyMandateResult` is idempotent, so this
 *   racing a webhook that does arrive is harmless.
 */
export async function reconcileMandate(
  ctx: TenantContext,
  slug: string,
  mandateId: string
): Promise<MandateStatusResponse> {
  const runtime = runtimeFor(slug);

  const mandate = await withTenant(ctx, (tx) =>
    tx.paymentMandate.findFirst({
      where: { id: mandateId, organizationId: ctx.organizationId },
      select: { id: true, status: true, providerMandateId: true },
    })
  );

  if (!mandate) throw new NotFoundError('Payment authorisation');

  // Terminal already, or never reached the provider: nothing to ask about.
  if (mandate.status !== 'PENDING' || !mandate.providerMandateId) {
    return getMandateStatus(ctx, mandateId);
  }

  const result = await runtime.provider.getMandate(mandate.providerMandateId);
  await applyMandateResult(ctx, runtime, mandateId, result, run);

  return getMandateStatus(ctx, mandateId);
}

/**
 * Ask the provider what actually happened, and apply it.
 *
 * WHY THE RETURN PAGE NEEDS THIS AT ALL
 *   The webhook is the authority and usually lands first, but "usually" is not a
 *   guarantee: a provider retrying a delivery it could not make, a redeploy
 *   between the redirect and the POST, a clinic on a network that finishes the
 *   round trip faster than the gateway's queue. Without a pull, the customer
 *   stares at "pending" for something that completed a minute ago.
 *
 *   It is a PULL, not a trust: the answer comes from `getCharge` over an
 *   authenticated API call, never from the query string the browser arrived
 *   with. `settleIntent` is idempotent, so this racing the webhook is fine — one
 *   of them applies it and the other is a no-op.
 */
export async function reconcileIntent(
  ctx: TenantContext,
  slug: string,
  intentId: string
): Promise<PaymentStatusResponse> {
  const runtime = runtimeFor(slug);

  const intent = await withTenant(ctx, (tx) =>
    tx.paymentIntent.findFirst({
      where: { id: intentId, organizationId: ctx.organizationId },
      select: { id: true, status: true, providerChargeId: true },
    })
  );

  if (!intent) throw new NotFoundError('Payment');

  // Terminal already, or never reached the provider: nothing to ask about.
  if (intent.status !== 'PENDING' || !intent.providerChargeId) {
    return getPaymentStatus(ctx, intentId);
  }

  const charge = await runtime.provider.getCharge(intent.providerChargeId);
  await settleIntent(ctx, runtime, intentId, charge, run);

  return getPaymentStatus(ctx, intentId);
}
