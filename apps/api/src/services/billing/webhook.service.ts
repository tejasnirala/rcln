/**
 * Accepting a payment provider's word for what happened.
 *
 * ⚠️ THIS IS THE MOST ATTACKABLE ENDPOINT IN THE SYSTEM.
 *   It is public, unauthenticated, and its whole purpose is to mark
 *   subscriptions paid. Four things stand between it and a free clinic, and all
 *   four are in this file:
 *
 *     1. THE SIGNATURE. Verified by the provider adapter over the exact bytes
 *        received — which is why the route mounts `express.raw()` and why
 *        nothing here re-serialises the body. A failure is a 401 and no write.
 *        There is no fallback that trusts the payload.
 *
 *     2. THE LEDGER. Every accepted delivery is inserted into
 *        `payment_webhook_events` under a unique `(provider, provider_event_id)`
 *        BEFORE it is acted on. A redelivery collides, is answered 200, and does
 *        nothing. At-least-once is the only guarantee any provider offers.
 *
 *     3. THE REFERENCE. The event names an intent by uuid. That uuid is ours, it
 *        is random, and it was never published — so it is the capability that
 *        lets a verified webhook read the one row it is about. See
 *        `withPaymentReference` in @rcln/db.
 *
 *     4. THE AMOUNT. `settleIntent` refuses a payment smaller than the invoice.
 *        A signature says the message is genuine; it does not say the numbers
 *        are the ones we asked for.
 *
 * IT ALWAYS ANSWERS 200 ONCE THE SIGNATURE PASSES.
 *   An unrecognised event type, an intent that no longer exists, a handler that
 *   threw — all recorded and acknowledged. A 500 makes the provider retry for
 *   hours and then disable the endpoint, taking every event we DO care about
 *   with it. Failures are visible in the ledger, which is where an operator can
 *   see and replay them.
 */

import { withPaymentReference, withTenant, type Prisma, type TenantContext } from '@rcln/db';
import { WebhookVerificationError, type RawWebhook, type WebhookEvent } from '@rcln/payments';
import { applyMandateResult, settleIntent, systemContext } from '@rcln/billing';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { logger } from '../../utils/logger.js';
import { paymentProvider } from './provider.js';
import { runtimeFor } from './billing.service.js';

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate' | 'failed';

/**
 * Verify, record, act — in that order, every time.
 *
 * Throws only `WebhookVerificationError`, which the route answers 401. Every
 * other failure is recorded and reported as `failed`, and the route still
 * answers 200.
 */
export async function ingestWebhook(raw: RawWebhook): Promise<WebhookOutcome> {
  const provider = paymentProvider();

  // 1. Signature. Throws on failure; nothing below runs.
  const event = provider.parseWebhook(raw);

  // 2. The ledger. `payment_webhook_events` is deliberately outside RLS — the
  //    tenant is not known yet, and deduplication must be global. See the model
  //    comment and the EXEMPT entry in check-rls.ts.
  const db = unsafeDbClient();

  try {
    await db.paymentWebhookEvent.create({
      data: {
        provider: event.provider,
        providerEventId: event.id.slice(0, 255),
        eventType: event.type,
        reference: event.reference?.slice(0, 128) ?? null,
        status: 'RECEIVED',
        payload: toJson(event.raw),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The whole point of the unique index. Seen before, already dealt with.
      logger.info({ provider: event.provider, eventId: event.id }, 'webhook redelivered; ignored');
      return 'duplicate';
    }
    throw error;
  }

  // 3. Act.
  try {
    const outcome = await dispatch(event);
    await db.paymentWebhookEvent.updateMany({
      where: { provider: event.provider, providerEventId: event.id.slice(0, 255) },
      data: {
        status: outcome === 'processed' ? 'PROCESSED' : 'IGNORED',
        processedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return outcome;
  } catch (error) {
    /*
     * Recorded, not rethrown. The route answers 200 and the provider stops
     * retrying; the row sits in FAILED with its payload, which is what an
     * operator replays from. Letting the provider retry a handler that will
     * deterministically throw again is how an endpoint gets disabled.
     */
    logger.error(
      { err: error, provider: event.provider, eventId: event.id, type: event.type },
      'webhook handler failed'
    );

    await db.paymentWebhookEvent.updateMany({
      where: { provider: event.provider, providerEventId: event.id.slice(0, 255) },
      data: {
        status: 'FAILED',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        attempts: { increment: 1 },
      },
    });
    return 'failed';
  }
}

/**
 * Route one event to the domain.
 *
 * Every branch resolves the tenant FIRST, through the narrow reference lookup,
 * and then re-enters `withTenant` to do the work under the ordinary policy. The
 * lookup grants a single SELECT on a single row and nothing more.
 */
async function dispatch(event: WebhookEvent): Promise<'processed' | 'ignored'> {
  if (!event.reference) return 'ignored';

  switch (event.type) {
    case 'charge.succeeded':
    case 'charge.failed': {
      const charge = event.charge;
      if (!charge) return 'ignored';

      const located = await locate('intent', event.reference);
      if (!located) return 'ignored';

      await settleIntent(located.ctx, runtimeFor(located.slug), located.id, charge, (ctx, fn) =>
        withTenant(ctx, fn)
      );

      await stampOrganization(event, located.ctx.organizationId);
      return 'processed';
    }

    case 'mandate.activated':
    case 'mandate.cancelled':
    case 'mandate.failed': {
      const mandate = event.mandate;
      if (!mandate) return 'ignored';

      const located = await locate('mandate', event.reference);
      if (!located) return 'ignored';

      await applyMandateResult(
        located.ctx,
        runtimeFor(located.slug),
        located.id,
        mandate,
        (ctx, fn) => withTenant(ctx, fn)
      );

      await stampOrganization(event, located.ctx.organizationId);
      return 'processed';
    }

    // charge.pending, refunds and anything a provider invents next. Recorded and
    // acknowledged; acting on them is not required for correctness, and a 500
    // here would cost us the events that are.
    default:
      return 'ignored';
  }
}

interface Located {
  id: string;
  ctx: TenantContext;
  slug: string;
}

/**
 * Turn a reference into a tenant, using the one row it names.
 *
 * The uuid shape is checked before the lookup because `app.payment_reference` is
 * cast to `uuid` in the policy, and a non-uuid would raise inside the query
 * rather than simply matching nothing. A provider echoing back a mangled
 * reference should be an ignored event, not a 500.
 */
async function locate(kind: 'intent' | 'mandate', reference: string): Promise<Located | null> {
  if (!UUID.test(reference)) return null;

  const found = await withPaymentReference(reference, async (tx) => {
    if (kind === 'intent') {
      const intent = await tx.paymentIntent.findUnique({
        where: { id: reference },
        select: { id: true, organizationId: true },
      });
      return intent;
    }

    const mandate = await tx.paymentMandate.findUnique({
      where: { id: reference },
      select: { id: true, organizationId: true },
    });
    return mandate;
  });

  if (!found) return null;

  /*
   * The slug, for the return URL the engine builds.
   *
   * `organizations` is RLS-exempt (it is the table the tenant is resolved FROM),
   * so this is a legitimate unscoped read of exactly one row by primary key —
   * the same pattern `resolveTenant` uses. It reads one column.
   */
  const organization = await unsafeDbClient().organization.findUnique({
    where: { id: found.organizationId },
    select: { slug: true },
  });

  if (!organization) return null;

  return {
    id: found.id,
    ctx: systemContext(found.organizationId),
    slug: organization.slug,
  };
}

/** Label the ledger row with the tenant, once we know it. For the console. */
async function stampOrganization(event: WebhookEvent, organizationId: string): Promise<void> {
  await unsafeDbClient().paymentWebhookEvent.updateMany({
    where: { provider: event.provider, providerEventId: event.id.slice(0, 255) },
    data: { organizationId },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The unique index on `(provider, provider_event_id)` doing its job.
 *
 * Shape-checked rather than `instanceof`, matching role.service.ts: the error
 * class is re-exported through the generated client and an `instanceof` against
 * it breaks whenever two copies of the client end up in the graph — which is a
 * silent failure that turns "already seen this webhook" into a 500.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/** The provider's payload, as JSON the column will accept. */
function toJson(raw: unknown): Prisma.InputJsonValue {
  return (raw ?? {}) as Prisma.InputJsonValue;
}

export { WebhookVerificationError };
