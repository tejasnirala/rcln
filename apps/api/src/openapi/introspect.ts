/**
 * What the routers actually are, read off the routers themselves.
 *
 * ⚠️ NOTHING HERE IS A LIST SOMEBODY MAINTAINS, AND THAT IS THE WHOLE POINT.
 *   The alternative to this file is a hand-written OpenAPI document, which is
 *   correct on the day it is written and wrong on the day after — a renamed
 *   field, a permission tightened, a route deleted, and the document still says
 *   what it said. `tests/unit/route-gates.test.ts` makes the same argument about
 *   the permission audit and reads the same stack for it.
 *
 *   The three facts a route carries are legible because the middleware factories
 *   stamp them on: `authorize()` writes `requiredPermissions` (auth.middleware),
 *   `validate()` writes `validatedShapes` (validate.middleware). Everything else
 *   below is derived from the shape Express gives us.
 *
 * ⚠️ EXPRESS 5 DOES NOT KEEP THE MOUNT PATH. A `Layer` compiles its path into a
 *   matcher and discards the string, so the prefix a router is mounted under
 *   cannot be recovered from the stack at all — which is why `mounts.ts` states
 *   the prefixes and this file only ever walks ONE router. The two are checked
 *   against each other by object identity in `mounts.ts`, so a router that gets
 *   mounted without being declared is a failing test rather than a silent hole
 *   in the documentation.
 */
import type { IRouter, RequestHandler } from 'express';
import type { PermissionCode } from '@rcln/permissions';
import { requiredPermissionsOf } from '../middleware/auth.middleware.js';
import { validatedShapesOf, type ValidatedShape } from '../middleware/validate.middleware.js';

/** The middleware this codebase gates on, recognised by function name. */
const GATE_NAMES = new Set([
  'requireTenant',
  'authenticate',
  'requireAuth',
  'requirePlatformAdmin',
]);

export interface IntrospectedRoute {
  /** `GET`, `POST`, … */
  readonly method: string;
  /** The path as registered on its own router — `/:branchId/operating-hours`. */
  readonly path: string;
  /** Codes from `authorize(...)`. `null` means the route carries no gate at all. */
  readonly permissions: readonly PermissionCode[] | null;
  /** Every schema the chain enforces, in the order it enforces them. */
  readonly validated: readonly ValidatedShape[];
  /** Router-level and route-level middleware recognised by name. */
  readonly gates: readonly string[];
}

/** Express does not type its own stack. This is the shape it has in 5.x. */
interface RouteLayer {
  readonly path: string;
  readonly methods: Record<string, boolean>;
  readonly stack: readonly { handle: unknown }[];
}
interface StackLayer {
  readonly name: string;
  readonly handle: unknown;
  readonly route?: RouteLayer;
}

const stackOf = (router: IRouter): readonly StackLayer[] =>
  (router as unknown as { stack: readonly StackLayer[] }).stack;

/**
 * Every route on one router, with its gate, its schemas and its middleware.
 *
 * Router-level `use(...)` middleware is attributed only to the routes
 * registered AFTER it, which is what Express does at runtime. Every route file
 * in this codebase puts its `use(requireTenant, authenticate, requireAuth)` line
 * above its first route, so in practice the whole file inherits it — but reading
 * the order rather than assuming it is what keeps that a fact instead of a
 * convention.
 */
export function introspectRouter(router: IRouter): IntrospectedRoute[] {
  const routes: IntrospectedRoute[] = [];
  const inherited: string[] = [];

  for (const layer of stackOf(router)) {
    if (layer.route === undefined) {
      // A bare `use(...)` layer: middleware for everything registered below it.
      if (typeof layer.handle === 'function' && GATE_NAMES.has(layer.handle.name)) {
        inherited.push(layer.handle.name);
      }
      continue;
    }

    const route = layer.route;

    /*
     * ⚠️ EXACTLY ONE `authorize` PER ROUTE. Two gates would mean the second is
     *   invisible to the document, and two gates disagreeing about who may call
     *   something is not a thing to discover from a bug report. route-gates.test
     *   makes the same check for the clinical routers; this one covers all 32.
     */
    const gates = route.stack
      .map((entry) => requiredPermissionsOf(entry.handle as RequestHandler))
      .filter((codes): codes is readonly PermissionCode[] => codes !== null);
    if (gates.length > 1) {
      throw new Error(
        `${route.path} has ${String(gates.length)} authorize() gates on it; the OpenAPI document can only describe one`
      );
    }

    const validated = route.stack.flatMap((entry) => validatedShapesOf(entry.handle) ?? []);
    const routeGates = route.stack
      .map((entry) => (typeof entry.handle === 'function' ? entry.handle.name : ''))
      .filter((name) => GATE_NAMES.has(name));

    for (const [method, enabled] of Object.entries(route.methods)) {
      if (enabled !== true) continue;
      if (method === '_all') continue;
      routes.push({
        method: method.toUpperCase(),
        path: route.path,
        permissions: gates[0] ?? null,
        validated,
        gates: [...inherited, ...routeGates],
      });
    }
  }

  return routes;
}

/**
 * How many routes the app can actually reach, counted by walking it.
 *
 * The prefixes are unrecoverable (see the header) but the COUNT is not, and it
 * is what `mounts.ts` compares its declared table against.
 */
export function countRoutes(router: IRouter): number {
  let total = 0;

  const walk = (current: IRouter): void => {
    for (const layer of stackOf(current)) {
      if (layer.route !== undefined) {
        total += Object.entries(layer.route.methods).filter(
          ([method, enabled]) => enabled === true && method !== '_all'
        ).length;
        continue;
      }
      const nested = (layer.handle as { stack?: unknown })?.stack;
      if (Array.isArray(nested)) walk(layer.handle as IRouter);
    }
  };

  walk(router);
  return total;
}

/**
 * Every router reachable from `router` that OWNS routes, by identity.
 *
 * ⚠️ LEAVES ONLY, AND THAT IS THE USEFUL SET. `routes/index.ts` and
 *   `routes/v1/index.ts` are pure plumbing — they mount other routers and
 *   register no endpoint of their own — so including them would mean the mount
 *   table had to declare a prefix for something that has nothing to document.
 */
export function reachableRouters(router: IRouter): Set<IRouter> {
  const leaves = new Set<IRouter>();
  const visited = new Set<IRouter>();

  const walk = (current: IRouter): void => {
    if (visited.has(current)) return;
    visited.add(current);

    if (stackOf(current).some((layer) => layer.route !== undefined)) leaves.add(current);

    for (const layer of stackOf(current)) {
      if (layer.route !== undefined) continue;
      const nested = (layer.handle as { stack?: unknown })?.stack;
      if (Array.isArray(nested)) walk(layer.handle as IRouter);
    }
  };

  walk(router);
  return leaves;
}
