import express, { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import { MockProvider, WebhookVerificationError } from '@rcln/payments';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { paymentProvider } from '../../services/billing/provider.js';
import { ingestWebhook } from '../../services/billing/webhook.service.js';

/**
 * Where payment providers tell us what happened.
 *
 * ⚠️ MOUNTED BEFORE `express.json()` IN app.ts, AND THAT IS LOAD-BEARING.
 *   Every provider signs the exact bytes it sent. `express.json()` consumes the
 *   request stream and hands on a parsed object; re-serialising it reorders keys
 *   and changes whitespace, so the HMAC no longer matches and every delivery
 *   fails verification for a reason that looks exactly like a wrong secret.
 *
 *   So this router owns its own body parser — `express.raw()` — and it must stay
 *   ahead of the global one. Moving it below `app.use(express.json())` breaks
 *   payments silently, in production only, and the symptom is "webhooks stopped
 *   working" with no error anywhere.
 *
 * NO TENANT, NO SESSION, NO PERMISSION CHECK — BY CONSTRUCTION
 *   A provider POSTs from its own infrastructure with no host we control and no
 *   credential we issued. The signature IS the authentication, and the
 *   deduplication ledger is what makes a replay harmless. Both are in
 *   webhook.service.ts; read its header before changing anything here.
 *
 * IT IS ALSO OUTSIDE `resolveTenant` AND THE GENERAL RATE LIMITER
 *   Deliberately. `resolveTenant` would 404 a host it has never heard of, and
 *   the shared IP bucket would throttle a provider retrying a burst of events
 *   into oblivion. What protects it is that an unsigned request is rejected
 *   before a single row is read.
 */

const router: IRouter = Router();

// `express.raw()`, not `express.text()` and not `express.json()`.
//
// The type matcher is a wildcard because providers are inconsistent about their
// content type — Cashfree sends `application/json`, others append a charset or
// omit the header entirely, and a parser that only matches one of those hands
// the handler an empty Buffer and no error at all.
const rawBody = express.raw({ type: '*/*', limit: '512kb' });

const providerParams = z.object({ provider: z.string().min(1).max(32) });

/**
 * How long the secret we verify with is — never what it is.
 *
 * Reports whichever secret the CONFIGURED adapter would actually use, which
 * differs per provider: Cashfree falls back to the API secret when no separate
 * signing secret is set, Razorpay has no fallback at all. A length that is one
 * or two longer than the key in the dashboard is a trailing newline or a stray
 * quote in `.env` — the single most common cause of a signature that will never
 * match, and invisible in every other diagnostic.
 *
 * This is the one place outside `@rcln/payments` that branches on a provider
 * name, and it is a log line rather than behaviour. Anything that changes what
 * the system DOES belongs behind the seam in `types.ts`.
 */
function verificationSecretLength(providerName: string): number {
  switch (providerName) {
    case 'cashfree': {
      const { webhookSecret, secretKey } = config.payments.cashfree;
      return (webhookSecret ?? secretKey ?? '').length;
    }
    case 'razorpay':
      return config.payments.razorpay.webhookSecret.length;
    case 'mock':
      return config.payments.mock.webhookSecret.length;
    default:
      return 0;
  }
}

/**
 * Which mode the configured provider believes it is in, for the log only.
 *
 * The most common cause of a 401 that is nobody's bug is sandbox keys pointed at
 * a production dashboard or the reverse, and neither the request nor the
 * signature shows it.
 */
function providerEnvironment(providerName: string): string | null {
  switch (providerName) {
    case 'cashfree':
      return config.payments.cashfree.environment;
    case 'razorpay':
      return config.payments.razorpay.environment;
    default:
      return null;
  }
}

router.post('/payments/:provider', rawBody, async (req: Request, res: Response): Promise<void> => {
  const parsed = providerParams.safeParse(req.params);
  if (!parsed.success) {
    sendError(res, 'Unknown provider', 404);
    return;
  }

  /*
   * The path names a provider; the process has exactly one configured. A
   * mismatch means the deployment's `PAYMENT_PROVIDER` and the URL registered
   * in the provider's dashboard disagree — answered 404 rather than attempting
   * to verify with the wrong secret, which would present as a signature
   * failure and send whoever debugs it looking in the wrong place.
   */
  const provider = paymentProvider();
  if (parsed.data.provider !== provider.name) {
    logger.warn(
      { requested: parsed.data.provider, configured: provider.name },
      'webhook for a provider this process is not configured for'
    );
    sendError(res, 'Unknown provider', 404);
    return;
  }

  try {
    const outcome = await ingestWebhook({
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
      headers: req.headers,
    });

    // 200 for every outcome that got past the signature — including `failed`.
    // See the header of webhook.service.ts: a 500 here makes the provider
    // retry for hours and then disable the endpoint.
    sendSuccess(res, { outcome });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      /*
       * The RESPONSE stays opaque — a verification endpoint that explains why it
       * refused is an oracle. The LOG does not have to be, and it must not be:
       * "signature did not verify" alone cannot distinguish a wrong secret from
       * a body that never arrived, and both present identically. That ambiguity
       * cost a debugging round-trip on the first live delivery.
       *
       * Nothing secret is logged. The secret's LENGTH is, because the most
       * common cause after a plain mismatch is a trailing newline or a quote
       * picked up from `.env` — which shows here as a length one or two longer
       * than the key in the dashboard.
       */
      const received = Buffer.isBuffer(req.body) ? req.body.length : -1;

      logger.warn(
        {
          provider: provider.name,
          err: error.message,
          // -1 means express.raw() did not produce a Buffer, so zero bytes were
          // hashed. That is a mounting problem in app.ts, not a wrong secret.
          bodyBytes: received,
          contentType: req.get('content-type') ?? null,
          /*
           * Every signature header we know about, so the log says "the provider
           * sent nothing" rather than leaving it ambiguous. Cashfree signs
           * `x-webhook-signature` + `x-webhook-timestamp`; Razorpay signs
           * `x-razorpay-signature` alone and identifies the event separately.
           */
          signatureHeaders: [
            'x-webhook-signature',
            'x-webhook-timestamp',
            'x-razorpay-signature',
            'x-razorpay-event-id',
          ].filter((header) => req.get(header) !== undefined),
          configuredSecretLength: verificationSecretLength(provider.name),
          environment: providerEnvironment(provider.name),
        },
        'webhook signature rejected'
      );
      sendError(res, 'Signature verification failed', 401);
      return;
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

const simulateRequest = z.object({
  kind: z.enum(['charge', 'mandate']),
  id: z.uuid(),
  outcome: z.enum(['SUCCEED', 'DECLINE', 'ABANDON', 'STALL']),
  /**
   * Send the same event twice with the same id, on purpose.
   *
   * The deduplication ledger is the only thing standing between a redelivered
   * `charge.succeeded` and a second free month, and the way to know it holds is
   * to make it happen rather than to reason that it would.
   */
  eventId: z.string().max(128).optional(),
});

/**
 * What the mock provider's checkout page posts when the operator clicks.
 *
 * ⚠️ DEVELOPMENT ONLY, AND REFUSED OUTRIGHT OTHERWISE.
 *   It moves a payment to succeeded without any money. Two independent guards:
 *   the provider must be the mock (production cannot boot with it — see
 *   config/index.ts), and this handler 404s whenever it is not. Neither guard
 *   alone would be enough; a 404 rather than a 403 because an endpoint that
 *   admits it exists is an endpoint somebody will keep prodding.
 *
 * IT TAKES NO SHORTCUT. The mock builds a genuinely signed webhook and it goes
 * through `ingestWebhook` — the same signature check, the same ledger, the same
 * handler as a real delivery. That is what makes the mock the tested path rather
 * than a bypass around the tested path.
 */
router.post(
  '/payments/mock/simulate',
  express.json({ limit: '16kb' }),
  async (req: Request, res: Response): Promise<void> => {
    const provider = paymentProvider();
    if (config.isProduction || !(provider instanceof MockProvider)) {
      sendError(res, 'Not found', 404);
      return;
    }

    const parsed = simulateRequest.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'Check the sandbox request', 400);
      return;
    }

    const { kind, id, outcome, eventId } = parsed.data;

    const raw = await provider.simulate(
      kind,
      id,
      outcome,
      eventId !== undefined ? { eventId } : {}
    );

    // STALL emits a `charge.pending` event, which the handler records and
    // ignores — exactly what a real UPI collect request produces while somebody
    // is still looking for their phone.
    const result = await ingestWebhook(raw);

    sendSuccess(res, { outcome: result }, 'Sandbox event delivered');
  }
);

export default router;
