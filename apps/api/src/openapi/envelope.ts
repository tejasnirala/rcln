/**
 * The response envelope, and every way a request can fail.
 *
 * ⚠️ EVERY ENDPOINT ANSWERS IN THE SAME SHAPE, AND A CONSUMER SHOULD LEARN IT
 *   ONCE. `sendSuccess` and `sendError` in `utils/response.ts` are the only two
 *   functions that write a body, so the envelope below is not a convention this
 *   file hopes holds — it is the two shapes those functions can produce. What
 *   varies between endpoints is `data`, which is why `data` is the only part the
 *   per-endpoint registry has to say anything about.
 *
 * ⚠️ THE STATUS CODES ARE DERIVED FROM THE MIDDLEWARE CHAIN, NOT GUESSED. A
 *   route documents 401 because something in its chain authenticates, 403
 *   because it carries an `authorize()` gate, 400 because it validates. A route
 *   that documents a failure it cannot produce teaches the reader to handle a
 *   case that never arrives; one that omits a failure it CAN produce is worse.
 */
import type { JsonSchema } from './schema.js';

export const ENVELOPE_SCHEMAS: Record<string, JsonSchema> = {
  /** What `sendError` puts on the wire, for every failure on every endpoint. */
  ErrorResponse: {
    type: 'object',
    required: ['success', 'message'],
    additionalProperties: false,
    properties: {
      success: {
        type: 'boolean',
        const: false,
        description: 'Always `false` on a failure. The single field worth branching on.',
      },
      message: {
        type: 'string',
        description:
          'A sentence describing the failure. Safe to show a user for 4xx; for 5xx in production it is the fixed string `Internal server error`, because the real message can name internals.',
        examples: ['Access denied'],
      },
      errors: {
        type: 'object',
        description:
          'Field-level detail, present on a 400 validation failure and on a 422 regulatory refusal. Keyed by the dotted path of the offending field; the value is every complaint about that field.',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        examples: [{ 'hours.0.opensAt': ['Expected HH:MM'] }],
      },
    },
  },

  /** The pagination block, present only on endpoints that page. */
  ResponseMeta: {
    type: 'object',
    required: ['page', 'limit', 'total', 'totalPages'],
    additionalProperties: false,
    properties: {
      page: {
        type: 'integer',
        minimum: 1,
        description: 'The page returned, 1-based.',
        examples: [1],
      },
      limit: { type: 'integer', minimum: 1, description: 'Rows per page.', examples: [20] },
      total: {
        type: 'integer',
        minimum: 0,
        description: 'Rows matching the query across every page.',
        examples: [137],
      },
      totalPages: {
        type: 'integer',
        minimum: 0,
        description: '`ceil(total / limit)`.',
        examples: [7],
      },
    },
  },
};

/** Wrap a `data` schema in the success envelope. */
export function successEnvelope(
  data: JsonSchema | null,
  options: { readonly message: string; readonly paginated?: boolean }
): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    success: { type: 'boolean', const: true },
    message: {
      type: 'string',
      description:
        'A short human-readable outcome. Not a machine-readable code; do not branch on it.',
      examples: [options.message],
    },
    data: data ?? { type: 'null', description: 'This endpoint returns no payload.' },
  };
  const required = ['success', 'message', 'data'];

  if (options.paginated === true) {
    properties['meta'] = { $ref: '#/components/schemas/ResponseMeta' };
    required.push('meta');
  }

  return { type: 'object', required, additionalProperties: false, properties };
}

interface ErrorCase {
  readonly description: string;
  readonly example: Record<string, unknown>;
}

/**
 * The failure catalogue, verbatim from `error.middleware.ts`.
 *
 * Each entry says what PRODUCES the status, not merely what the status means —
 * "you are not allowed" and "this clinic does not exist" are both plausible
 * readings of a 404 here, and only one of them is right.
 */
export const ERROR_CASES: Record<number, ErrorCase> = {
  400: {
    description:
      "The request body, query string or path parameters failed the endpoint's schema. `errors` names every field that failed and why. Also returned when a referenced row does not exist (a foreign key that points at nothing).",
    example: {
      success: false,
      message: 'Validation failed',
      errors: { code: ['String must contain at least 1 character(s)'] },
    },
  },
  401: {
    description:
      'No `Authorization` header, or a token that is expired, malformed, or whose session has been signed out. The session row is the revocation list, so a token can be syntactically valid and still land here. Refresh and retry.',
    example: { success: false, message: 'Session expired. Please sign in again.' },
  },
  403: {
    description:
      'Authenticated, but the caller does not hold the permission this endpoint requires for their active branch. The response deliberately does not name the missing permission — doing so would map the permission model out for an attacker. The code is listed on this endpoint in these docs instead.',
    example: { success: false, message: 'Access denied' },
  },
  404: {
    description:
      'The addressed row does not exist — **or** the `Host` does not resolve to a clinic, **or** a valid token minted for one clinic was replayed against another, **or** a non-platform-admin called an admin-console endpoint. The last three deliberately answer 404 rather than 403: a 403 confirms the tenant exists and lets a caller walk the customer list one subdomain at a time.',
    example: { success: false, message: 'Branch not found' },
  },
  409: {
    description:
      'The write conflicts with a row that already exists, or lost a race against a concurrent write. Retrying an identical request will not help; the caller has to change something. Losing the race for the last strip of stock arrives here rather than as a 500, because it is a normal outcome in a busy pharmacy.',
    example: { success: false, message: 'A record with this value already exists' },
  },
  422: {
    description:
      "The rules of this jurisdiction do not permit what was asked. **Not a 403** — a 403 is a statement about the caller, which they can do nothing about at the counter, whereas this is a statement about the transaction: the same person may lawfully dispense the next prescription in the queue. `message` is the rule's own sentence, written to be read by the person being refused.",
    example: {
      success: false,
      message: 'A Schedule H medicine requires a valid prescription.',
      errors: {
        outcome: ['REFUSED'],
        ruleCodes: ['IN-CDSCO-SCHEDULE-H-RX'],
        messages: ['A Schedule H medicine requires a valid prescription.'],
      },
    },
  },
  402: {
    description:
      'The acquirer declined the payment. **Retrying an identical request will not help** — the customer has to use a different instrument or resolve it with their bank. Deliberately distinct from a `503`, which means we do not know whether the payment succeeded and must never be presented as a decline.',
    example: { success: false, message: 'Your bank declined this payment.' },
  },
  429: {
    description:
      'Rate limited. Applied per client address; the authentication endpoints carry a much tighter budget than the rest of the API.',
    example: { success: false, message: 'Too many requests' },
  },
  500: {
    description:
      'An unhandled failure. The message is the fixed string `Internal server error` in production and the real error text elsewhere. Safe to retry once; if it persists, quote the `X-Request-Id` from the response headers.',
    example: { success: false, message: 'Internal server error' },
  },
  503: {
    description:
      'Either a dependency this instance needs is not answering, or — on a payment route — the provider did not tell us whether the charge succeeded. ⚠️ On a payment, this is NOT a decline and the customer must not be told the payment failed, because it may not have; reconcile with the provider instead. Otherwise it is produced by the readiness probe, which names the failing dependency in `data`. Produced by the readiness probe alone, which names the failing dependency in `data` rather than only reporting that something is wrong. That is a signal to stop routing traffic here, not to restart the process — that is what the liveness probe is for.',
    example: {
      success: false,
      message: 'Service not ready',
      data: {
        status: 'not_ready',
        timestamp: '2026-03-17T04:00:00.000Z',
        database: 'connected',
        redis: 'disconnected',
      },
    },
  },
};

/** The OpenAPI response object for one failure status. */
export function errorResponse(status: number): JsonSchema {
  const entry = ERROR_CASES[status];
  if (!entry) throw new Error(`No documented error case for status ${String(status)}`);

  return {
    description: entry.description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
        example: entry.example,
      },
    },
  };
}
