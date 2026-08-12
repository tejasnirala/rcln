/**
 * The API's binding of the ledger writer.
 *
 * The engine itself is `@rcln/inventory` — it moved out of `apps/api` in PI-2
 * because the expiry sweep is a WORKER processor, and PI-ADR-004's "nothing
 * outside `recordMovement()` inserts into `stock_ledger`" only stays true if
 * both applications can reach the same function. See that package's header.
 *
 * What is left here is the two things the package deliberately does not do:
 *
 *   1. INJECT THE DEPENDENCIES it cannot import. `recordAudit` reaches for this
 *      app's redaction list and snapshot diffing; `loadUnitGraph` is this app's
 *      tenant-visible read of `units_of_measure`. A package that imported either
 *      would depend on an application.
 *
 *   2. OPEN THE TRANSACTION, for the HTTP path only. The sweep writes many
 *      movements inside a transaction it already holds, so the wrapper is a
 *      caller's decision rather than the engine's — a movement that can commit
 *      independently of the thing that caused it is a movement that will, on the
 *      day the cause rolls back.
 *
 * ⚠️ DO NOT ADD A SECOND WRITE PATH HERE. If a later phase needs a movement
 *   shaped differently, it belongs in the engine, behind a movement type and a
 *   CHECK constraint, not in a service that inserts its own row.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type { RecordMovementRequest, RecordMovementResponse } from '@rcln/contracts';
import {
  recordMovementIn as recordMovementInEngine,
  type MovementDeps,
  type MovementInput,
  type MovementOptions,
} from '@rcln/inventory';
import { recordAudit } from '../audit/audit.service.js';
import { loadUnitGraph } from '../product/unit.service.js';
import { assertReasonCode } from './reason-code.service.js';

/**
 * One object, built once, shared by every call.
 *
 * `recordAudit`'s signature is wider than the engine asks for — the engine only
 * ever writes a CREATE with an `after` snapshot — so the narrowing is safe and
 * is what keeps the package's `MovementDeps` from having to describe the whole
 * audit vocabulary.
 */
export const movementDeps: MovementDeps = {
  recordAudit: (tx, ctx, entry) => recordAudit(tx, ctx, entry),
  loadUnitGraph,
};

/** Record a movement inside a transaction the caller already holds. */
export async function recordMovementIn(
  tx: Parameters<typeof recordMovementInEngine>[0],
  ctx: TenantContext,
  input: MovementInput,
  options: MovementOptions = {}
): Promise<RecordMovementResponse> {
  return recordMovementInEngine(tx, ctx, movementDeps, input, options);
}

/**
 * The HTTP entry point: opens its own transaction.
 *
 * ⚠️ THE REASON-CODE CHECK LIVES HERE AND NOT IN THE ENGINE, AND THAT IS THE
 *   SAME BOUNDARY `MovementDeps` DRAWS. The engine enforces that an ADJUSTMENT
 *   CARRIES a reason code — that is a property of the movement, checked in the
 *   package and again by the `stock_ledger_direction` CHECK. Whether the code is
 *   one this CLINIC uses is a question about a tenant master, which the package
 *   cannot read and the worker has no need of: the expiry sweep writes `EXPIRY`,
 *   whose meaning is its name.
 *
 *   So the vocabulary is enforced on the surface a human types into, on the same
 *   transaction as the movement it validates. A later phase that writes
 *   adjustments from somewhere else — an import, a stock take — must call
 *   `assertReasonCode` too, and this comment is where that is written down.
 */
export async function recordMovement(
  ctx: TenantContext,
  input: RecordMovementRequest,
  options: MovementOptions = {}
): Promise<RecordMovementResponse> {
  // `occurredAt` arrives as an ISO string and is pulled out rather than spread
  // over: the wire type is `string` and `MovementInput` takes a `Date`, so a
  // plain spread would typecheck against neither.
  const { occurredAt, ...rest } = input;

  return withTenant(ctx, async (tx) => {
    if (input.reasonCode != null) {
      /*
       * ⚠️ THE DIRECTION IS ONLY CHECKED FOR AN ADJUSTMENT, ON PURPOSE. An
       *   adjustment is the one movement whose direction is stated outright and
       *   is therefore the one where "this reason explains stock going the other
       *   way" is a question with an answer. `QUARANTINE` moves quantity between
       *   buckets and is neither an increase nor a decrease in what the branch
       *   holds; forcing it through one of the two would make every code a
       *   clinic wrote for it wrong half the time. Existence, activity and the
       *   note requirement are checked for all of them.
       */
      await assertReasonCode(
        tx,
        input.reasonCode,
        input.adjustmentDirection ?? null,
        input.reasonNote
      );
    }

    return recordMovementIn(
      tx,
      ctx,
      { ...rest, ...(occurredAt !== undefined ? { occurredAt: new Date(occurredAt) } : {}) },
      options
    );
  });
}

export { DIRECTION, type MovementInput } from '@rcln/inventory';
