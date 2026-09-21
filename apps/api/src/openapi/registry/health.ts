/**
 * Health — the two endpoints a load balancer calls and a person almost never does.
 *
 * Neither is behind the tenant guard, neither authenticates, and both are
 * excluded from request logging: a readiness probe every two seconds would
 * otherwise be the single loudest thing in the log.
 */
import type { DocRegistry } from '../types.js';

/** Not a contract schema — nothing in `@rcln/contracts` describes a probe. */
const LIVENESS = {
  type: 'object',
  required: ['status', 'timestamp', 'environment'],
  properties: {
    status: { type: 'string', const: 'healthy' },
    timestamp: { type: 'string', format: 'date-time' },
    environment: { type: 'string', example: 'production' },
  },
} as const;

const READINESS = {
  type: 'object',
  required: ['status', 'timestamp', 'database', 'redis'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    timestamp: { type: 'string', format: 'date-time' },
    database: { type: 'string', enum: ['connected', 'disconnected'] },
    redis: { type: 'string', enum: ['connected', 'disconnected'] },
  },
} as const;

export const healthDocs: DocRegistry = {
  'GET /api/v1/health': {
    summary: 'Liveness probe',
    description: `
Is the process up and answering.

⚠️ **Deliberately touches nothing.** No database, no Redis, no tenant lookup —
if this returns \`200\` the only thing it proves is that Node is running and the
event loop is not wedged. That narrowness is the feature: a liveness probe that
checks the database restarts a healthy API every time Postgres hiccups, which
turns a brief database problem into an outage.

Use \`GET /api/v1/health/ready\` to decide whether to send traffic.
`.trim(),
    response: LIVENESS,
    message: 'Service is healthy',
    responseExamples: [
      {
        summary: 'Up',
        value: {
          success: true,
          message: 'Service is healthy',
          data: {
            status: 'healthy',
            timestamp: '2026-03-17T04:00:00.000Z',
            environment: 'production',
          },
        },
      },
    ],
  },

  'GET /api/v1/health/ready': {
    summary: 'Readiness probe',
    description: `
Can this instance actually serve a request — meaning both Postgres and Redis
answer.

Each dependency is probed independently and reported by name, so a \`503\` says
*which* one is down rather than only that something is. The database check is a
bare \`SELECT 1\` over the unsafe client, because a readiness probe has no tenant
and must not need one.

Answers \`503\` with the same body shape the moment either dependency fails,
which is the signal to stop routing traffic here. It is **not** a signal to
restart the process — that is what the liveness probe is for.
`.trim(),
    response: READINESS,
    status: 200,
    message: 'Service is ready',
    errors: [503],
    responseExamples: [
      {
        summary: 'Ready',
        value: {
          success: true,
          message: 'Service is ready',
          data: {
            status: 'ready',
            timestamp: '2026-03-17T04:00:00.000Z',
            database: 'connected',
            redis: 'connected',
          },
        },
      },
      {
        summary: 'Redis down — answered 503',
        description: 'Note `success: false`, and that the failing dependency is named.',
        value: {
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
    ],
  },
};
