/**
 * The four helpers every branch-scoped service needs, in ONE place.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THERE WERE TWO COPIES OF IT (PI-11 review).
 *   `pharmacy/shared.ts` and `consumption/shared.ts` carried `assertBranchInScope`,
 *   `resolveBranchId`, `auditMeta` and `q` byte-for-byte identical apart from one
 *   noun in one error message — and `auditMeta`'s own comment said "for the reason
 *   `pharmacy/shared.ts` gives", so the duplication was known when it was written.
 *
 *   That is the failure `pnpm kb:find` exists to prevent, and it had landed on the
 *   two functions that decide WHICH TENANT'S BRANCH A WRITE IS ATTRIBUTED TO —
 *   the pair you least want drifting. A fix applied to one copy and not the other
 *   is a security fix that only half shipped.
 *
 * NO PHI IS LOGGED FROM THIS FILE.
 */
import { Prisma, type TenantContext } from '@rcln/db';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a branch outside the caller's scope. RLS has
 *   already made the row invisible, and a 403 would confirm to somebody probing
 *   that the id is real. Every branch-scoped service in this codebase does this.
 */
export function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

/**
 * Which place is this request about?
 *
 * ⚠️ THE BRANCH THE REQUEST NAMES, OR THE ONE IT IS ACTING ON — NEVER THE FIRST
 *   ONE IN SCOPE. Somebody covering two sites must not have the record filed
 *   against whichever branch id happened to sort first: for a supply the
 *   jurisdiction is where the counter is, for a procedure the stock came off one
 *   trolley, and picking arbitrarily is wrong silently and about half the time.
 *   Both call sites learned this independently, which is part of why they are now
 *   one function.
 *
 * `subject` is the only thing that ever differed between the two copies — the
 * noun in the sentence a person reads. It is a parameter rather than a second
 * function, because everything above this line is the part that must not drift.
 */
export function resolveBranchId(
  ctx: TenantContext,
  named: string | undefined,
  acting: string | null | undefined,
  subject = 'a record happens at exactly one of them'
): string {
  const branchId = named ?? acting ?? (ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined);
  if (!branchId) {
    throw new ValidationError(
      `Say which branch this is for. You work at more than one and ${subject}.`
    );
  }
  assertBranchInScope(ctx, branchId);
  return branchId;
}

/**
 * The two fields `recordAudit` takes, pulled out of the wider options object.
 *
 * ⚠️ EXPLICIT RATHER THAN `...options`, BECAUSE THE CALLERS' OPTIONS CARRY MORE
 *   THAN AUDIT WANTS — a route pattern, the acting branch, the caller's
 *   permission codes. Spreading them would put the caller's effective permissions
 *   into an audit row's shape and nobody would notice for a while.
 */
export function auditMeta(options: {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): { ipAddress?: string; userAgent?: string } {
  return {
    ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
}

/** A decimal as the wire wants it: a string, never a float. */
export function q(value: Prisma.Decimal | number | string): string {
  return new Prisma.Decimal(value).toString();
}
