/**
 * What a human adds on top of what the routers already say.
 *
 * Introspection gets the method, the path, the gate and every request schema for
 * free, and it gets them right forever. What it cannot get is WHY an endpoint
 * exists, what comes back, and what a real call looks like — so that is all this
 * type carries, and nothing else. Anything derivable from the code is
 * deliberately absent here so it cannot be stated twice and drift.
 */
import type { ZodType } from 'zod';
import type { JsonSchema } from './schema.js';

export interface EndpointExample {
  /** Short label — `Solo clinic`, `Second branch in another state`. */
  readonly summary: string;
  readonly description?: string;
  readonly value: unknown;
}

export interface EndpointDoc {
  /** One line, imperative, shown in the endpoint list. `Create a branch`. */
  readonly summary: string;
  /**
   * The prose a consumer reads before calling it: what it does, what it does
   * not do, and anything surprising. Markdown.
   */
  readonly description: string;
  /** The `data` payload on success — a contract schema, or a literal JSON Schema. */
  readonly response?: ZodType | JsonSchema;
  /** Success status, when it is not 200. */
  readonly status?: number;
  /** The `message` field on success, so the example is the real thing. */
  readonly message?: string;
  /** Set when the endpoint answers with a `meta` pagination block. */
  readonly paginated?: boolean;
  /** Failure statuses this endpoint can produce beyond the ones derived from its chain. */
  readonly errors?: readonly number[];
  /** Worked request bodies. The first is what a client pre-fills. */
  readonly requestExamples?: readonly EndpointExample[];
  /** Worked responses, enveloped exactly as they arrive. */
  readonly responseExamples?: readonly EndpointExample[];
  /** Notes on individual path/query parameters, keyed by parameter name. */
  readonly params?: Readonly<Record<string, string>>;
  /** Set when calling this discloses patient data and writes a `data_access_logs` row. */
  readonly phi?: boolean;
  readonly deprecated?: boolean;
}

/** `GET /api/v1/branches/:branchId` -> the prose for it. */
export type DocRegistry = Readonly<Record<string, EndpointDoc>>;

/** Key an endpoint the way the registry does. */
export const endpointKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path}`;
