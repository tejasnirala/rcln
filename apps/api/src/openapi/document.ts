/**
 * The OpenAPI 3.1 document, assembled from the routers plus the prose registry.
 *
 * The split is the point: everything a machine can know is read off the running
 * routers (`introspect.ts`) and the Zod contracts (`schema.ts`), and everything
 * only a person knows — what an endpoint is FOR, what comes back, what a real
 * call looks like — comes from `registry/`. Nothing appears in both, so nothing
 * can disagree with itself.
 */
import { z, type ZodType } from 'zod';
import { config } from '../config/index.js';
import { introspectRouter, type IntrospectedRoute } from './introspect.js';
import { MOUNTS, TAGS, type Mount } from './mounts.js';
import { SchemaSpace, type JsonSchema } from './schema.js';
import { ENVELOPE_SCHEMAS, errorResponse, successEnvelope } from './envelope.js';
import { DOCS, TAG_DESCRIPTIONS } from './registry/index.js';
import { endpointKey, type EndpointDoc } from './types.js';

const isZodType = (value: unknown): value is ZodType =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === 'function';

/** `/:branchId/operating-hours` -> `/{branchId}/operating-hours`. */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** Join a mount prefix to a router-relative path without doubling the slash. */
function fullPath(prefix: string, path: string): string {
  const joined = `${prefix}${path === '/' ? '' : path}`;
  return joined === '' ? '/' : joined;
}

/** `POST /api/v1/branches` -> `postApiV1Branches`, stable across runs. */
function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/api\/v1/, '')
    .split(/[/{}:_-]+/)
    .filter(Boolean);
  const tail = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return `${method.toLowerCase()}${tail || 'Root'}`;
}

interface Endpoint {
  readonly mount: Mount;
  readonly route: IntrospectedRoute;
  readonly path: string;
  readonly doc: EndpointDoc | undefined;
}

/** Every documented endpoint, in mount order. */
function collectEndpoints(): Endpoint[] {
  const endpoints: Endpoint[] = [];

  for (const mount of MOUNTS) {
    for (const route of introspectRouter(mount.router)) {
      const path = toOpenApiPath(fullPath(mount.prefix, route.path));
      endpoints.push({
        mount,
        route,
        path,
        doc: DOCS[endpointKey(route.method, path)],
      });
    }
  }

  return endpoints;
}

/** Split a `params`/`query` object schema into individual OpenAPI parameters. */
function parametersFrom(
  schema: ZodType,
  location: 'path' | 'query',
  notes: Readonly<Record<string, string>> | undefined
): JsonSchema[] {
  const converted = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as unknown as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };

  const properties = converted.properties ?? {};
  const required = new Set(converted.required ?? []);

  return Object.entries(properties).map(([name, body]) => {
    const { description, ...rest } = body;
    const note = notes?.[name] ?? (typeof description === 'string' ? description : undefined);

    return {
      name,
      in: location,
      // A path parameter is required by definition; a query one says so itself.
      required: location === 'path' ? true : required.has(name),
      ...(note !== undefined ? { description: note } : {}),
      schema: rest,
    };
  });
}

/**
 * The failure statuses an endpoint can actually produce.
 *
 * Derived from its middleware chain rather than stamped on every endpoint
 * identically: a route with no gate cannot answer 403, and saying it can
 * teaches a consumer to handle a case that never arrives.
 */
function errorStatusesFor(endpoint: Endpoint): number[] {
  const { route, doc } = endpoint;
  const statuses = new Set<number>();

  if (route.validated.length > 0) statuses.add(400);
  if (route.gates.includes('authenticate') || route.gates.includes('requireAuth'))
    statuses.add(401);
  if (route.permissions !== null) statuses.add(403);
  if (
    route.gates.includes('requireTenant') ||
    route.gates.includes('requirePlatformAdmin') ||
    endpoint.path.includes('{')
  ) {
    statuses.add(404);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) statuses.add(409);

  for (const status of doc?.errors ?? []) statuses.add(status);

  statuses.add(429);
  statuses.add(500);

  return [...statuses].sort((a, b) => a - b);
}

/**
 * The permission gate and PHI posture, written where a reader will see it.
 *
 * ⚠️ THE GATE IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. A consumer
 *   integrating against this API has to know which permission to grant the
 *   service account they are about to create, and the 403 body deliberately does
 *   not tell them — it names no permission, because naming it maps the model out
 *   for an attacker. This is where they find out instead.
 */
function describeOperation(endpoint: Endpoint): string {
  const { route, doc } = endpoint;
  const parts: string[] = [];

  if (doc) parts.push(doc.description);

  if (route.permissions !== null && route.permissions.length > 0) {
    const codes = route.permissions.map((code) => `\`${code}\``).join(', ');
    parts.push(
      `**Permission required:** ${codes} — held for the caller's active branch. A platform admin bypasses the check, and every bypass is logged.`
    );
  } else if (route.gates.includes('requireAuth')) {
    parts.push('**Permission required:** none beyond being signed in to this clinic.');
  } else if (route.gates.includes('requirePlatformAdmin')) {
    parts.push(
      '**Access:** platform administrators only. A caller without the flag is answered `404`, not `403`.'
    );
  } else {
    parts.push('**Access:** unauthenticated. No token required.');
  }

  if (route.gates.includes('requireTenant')) {
    parts.push(
      "**Tenant:** resolved from the `Host` header. Call it on the clinic's own subdomain; an unknown host is answered `404`."
    );
  }

  if (doc?.phi === true) {
    parts.push(
      '**Patient data:** this response discloses PHI. Every successful read writes a `data_access_logs` row naming the caller, the patient and the reason.'
    );
  }

  return parts.join('\n\n');
}

/** Build the whole document. Pure; the caller decides when to cache it. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const endpoints = collectEndpoints();
  const space = new SchemaSpace();

  // Pass 1 — collect every schema the document will reference.
  for (const { route, doc } of endpoints) {
    for (const shape of route.validated) {
      if (shape.source === 'body') space.add(shape.schema, 'input');
    }
    if (doc?.response !== undefined && isZodType(doc.response)) {
      space.add(doc.response, 'output');
    }
  }
  const contractComponents = space.build();

  // Pass 2 — write the operations.
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of endpoints) {
    const { route, doc, mount, path } = endpoint;

    const parameters: JsonSchema[] = [];
    let requestBody: JsonSchema | undefined;

    for (const shape of route.validated) {
      if (shape.source === 'params') {
        parameters.push(...parametersFrom(shape.schema, 'path', doc?.params));
      } else if (shape.source === 'query') {
        parameters.push(...parametersFrom(shape.schema, 'query', doc?.params));
      } else {
        requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: space.refTo(shape.schema, 'input'),
              ...(doc?.requestExamples && doc.requestExamples.length > 0
                ? {
                    examples: Object.fromEntries(
                      doc.requestExamples.map((example, index) => [
                        `example${String(index + 1)}`,
                        {
                          summary: example.summary,
                          ...(example.description !== undefined
                            ? { description: example.description }
                            : {}),
                          value: example.value,
                        },
                      ])
                    ),
                  }
                : {}),
            },
          },
        };
      }
    }

    /*
     * ⚠️ EVERY `{placeholder}` IN THE PATH NEEDS A PARAMETER, WHETHER OR NOT A
     *   ZOD SCHEMA DESCRIBES IT. Most routes validate their params and get a
     *   precise schema for free; a few — the webhook receiver's `{provider}`
     *   among them — read the value straight off `req.params`. OpenAPI requires
     *   the declaration regardless, and a document missing one is rejected
     *   outright rather than merely rendering oddly.
     */
    for (const match of path.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      const name = match[1];
      if (name === undefined) continue;
      if (parameters.some((parameter) => parameter['name'] === name)) continue;
      parameters.push({
        name,
        in: 'path',
        required: true,
        ...(doc?.params?.[name] !== undefined ? { description: doc.params[name] } : {}),
        schema: { type: 'string' },
      });
    }

    /*
     * ⚠️ 200 IS THE DEFAULT FOR EVERY METHOD, INCLUDING POST, AND THAT IS NOT
     *   LAZINESS. Only 72 of the 158 POST routes answer 201 — the rest are
     *   ACTIONS rather than creations: signing in, refreshing, switching branch,
     *   posting a goods receipt, evaluating a regulatory question. Guessing 201
     *   from the verb would be wrong more often than right, and a documented
     *   status a caller branches on is worse than no status at all. An endpoint
     *   that really does create says so with `status: 201` in the registry.
     */
    const successStatus = doc?.status ?? 200;
    const successMessage = doc?.message ?? 'Success';

    const dataSchema: JsonSchema | null =
      doc?.response === undefined
        ? null
        : isZodType(doc.response)
          ? space.refTo(doc.response, 'output')
          : doc.response;

    const responses: Record<string, unknown> = {
      [String(successStatus)]: {
        description: doc?.summary ?? 'Success',
        content: {
          'application/json': {
            schema: successEnvelope(dataSchema, {
              message: successMessage,
              ...(doc?.paginated === true ? { paginated: true } : {}),
            }),
            ...(doc?.responseExamples && doc.responseExamples.length > 0
              ? {
                  examples: Object.fromEntries(
                    doc.responseExamples.map((example, index) => [
                      `example${String(index + 1)}`,
                      {
                        summary: example.summary,
                        ...(example.description !== undefined
                          ? { description: example.description }
                          : {}),
                        value: example.value,
                      },
                    ])
                  ),
                }
              : {}),
          },
        },
      },
    };

    for (const status of errorStatusesFor(endpoint)) {
      responses[String(status)] = errorResponse(status);
    }

    const operation: Record<string, unknown> = {
      tags: [mount.tag],
      summary: doc?.summary ?? `${route.method} ${path}`,
      description: describeOperation(endpoint),
      operationId: operationId(route.method, path),
      responses,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      ...(doc?.deprecated === true ? { deprecated: true } : {}),
      /*
       * An endpoint that never authenticates opts out of the document-level
       * security requirement, so a client does not send a token to `/auth/login`
       * and does not think it needs one for `/health`.
       */
      ...(route.gates.includes('authenticate') || route.gates.includes('requireAuth')
        ? {}
        : { security: [] }),
    };

    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = operation;
  }

  const documented = endpoints.filter((endpoint) => endpoint.doc !== undefined).length;

  return {
    openapi: '3.1.0',
    info: {
      title: 'rcln API',
      version: '0.1.0',
      summary: 'Multi-tenant healthcare management for clinics, hospitals and labs.',
      description: OVERVIEW,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      contact: { name: 'rcln', url: 'https://github.com/tejasnirala/rcln' },
    },
    servers: [
      {
        url: `{scheme}://{clinic}.${config.rootDomain}${config.port === 443 ? '' : `:${String(config.port)}`}`,
        description:
          "A clinic's own subdomain. Which clinic you are addressing is decided by this host and by nothing else.",
        variables: {
          scheme: { enum: ['http', 'https'], default: config.isProduction ? 'https' : 'http' },
          clinic: {
            default: 'alpha',
            description: "The clinic's subdomain label — the `slug` on its organization row.",
          },
        },
      },
    ],
    paths,
    tags: TAGS.map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] !== undefined ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'The access token from `POST /api/v1/auth/login`, sent as `Authorization: Bearer <token>`.\n\nThe token is short-lived and is checked against a session row on every request, so signing out invalidates it immediately rather than at expiry. A token minted for one clinic and replayed against another is answered `404`.',
        },
      },
      schemas: { ...ENVELOPE_SCHEMAS, ...contractComponents },
    },
    'x-rcln-coverage': {
      endpoints: endpoints.length,
      described: documented,
      routers: MOUNTS.length,
    },
  };
}

const OVERVIEW = `
A multi-tenant API for running a clinic: appointments, the clinical record,
pharmacy and dispensing, inventory, procurement, invoicing and billing.

## Which clinic you are talking to

Every clinic gets its own subdomain, and **the \`Host\` header is what selects the
tenant** — there is no \`organizationId\` parameter on any endpoint, and there is
no way to address a second clinic from a session belonging to the first. A host
that resolves to no clinic is answered \`404\`.

## Signing in

\`POST /api/v1/auth/login\` on the clinic's own host returns an access token and a
refresh token. Send the access token as \`Authorization: Bearer <token>\`.

The token is stateless but not unrevocable: every request checks it against a
live session row, so signing out takes effect immediately. Permissions are **not**
carried in the token — they are resolved per request against the caller's
membership, so a role granted or revoked now takes effect on the next request
rather than at the next sign-in.

## Permissions

Authorization is a permission code, not a role name. Every endpoint that needs
one names it in its description. A caller holds a code for a branch, so the same
person may be allowed to do something at one location and not at another.

## Every response has the same shape

Success:

\`\`\`json
{ "success": true, "message": "Branch created", "data": { "id": "…" } }
\`\`\`

Failure:

\`\`\`json
{ "success": false, "message": "Access denied" }
\`\`\`

\`data\` is the only part that varies between endpoints; branch on \`success\` and
on the HTTP status, never on \`message\`. List endpoints that page add a \`meta\`
block with \`page\`, \`limit\`, \`total\` and \`totalPages\`.

## Dates, times and money

Timestamps are ISO 8601 in **UTC**, always with a trailing \`Z\`. Render them in
the branch's own timezone — a clinic's day is a local fact, and the browser's
zone is not it. Money is a decimal string, never a float.

## Request tracing

Every response carries \`X-Request-Id\`. Send your own to have it echoed and
correlated in the logs; quote it in any bug report.
`.trim();
