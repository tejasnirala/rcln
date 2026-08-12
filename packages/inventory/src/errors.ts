/**
 * The one error this package throws.
 *
 * ⚠️ IT CARRIES A `kind` RATHER THAN AN HTTP STATUS, BECAUSE THIS PACKAGE HAS NO
 *   IDEA IT IS BEHIND HTTP. The API maps the three kinds onto the same 400 / 404
 *   / 409 its own `ValidationError`, `NotFoundError` and `ConflictError` produce
 *   — one branch in `error.middleware.ts` — and the worker lets it bubble to
 *   BullMQ, where a `CONFLICT` on one branch's sweep must not take the rest of
 *   the fan-out down with it.
 *
 * ⚠️ `CONFLICT` IS A NORMAL OUTCOME, NOT A FAULT. Losing the race for the last
 *   strip is what happens in a busy pharmacy: the losing transaction is refused
 *   before it can commit a negative shelf, and the caller re-reads and tells the
 *   user. Treating it as an internal error is how a 500 ends up on a screen that
 *   should have said "somebody else took it".
 */
export type InventoryErrorKind = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT';

export class InventoryError extends Error {
  public readonly kind: InventoryErrorKind;

  constructor(kind: InventoryErrorKind, message: string) {
    super(message);
    this.name = 'InventoryError';
    this.kind = kind;
    // Explicit, so `instanceof` survives the transpiled subclass. The same
    // precaution `apps/api/src/utils/errors.ts` takes for the same reason.
    Object.setPrototypeOf(this, InventoryError.prototype);
  }
}

export const invalid = (message: string): InventoryError =>
  new InventoryError('VALIDATION', message);

export const missing = (resource: string): InventoryError =>
  new InventoryError('NOT_FOUND', `${resource} not found`);

export const conflict = (message: string): InventoryError =>
  new InventoryError('CONFLICT', message);
