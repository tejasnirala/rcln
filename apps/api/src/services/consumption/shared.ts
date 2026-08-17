/**
 * The pieces every consumption service needs, in one place so they cannot
 * drift: branch scoping, the place stock came off, the template in force on a
 * day, and the allocation arithmetic.
 *
 * NO PHI IS LOGGED FROM THIS FILE.
 */
import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a branch outside the caller's scope. RLS has
 *   already made the row invisible and a 403 would confirm to somebody probing
 *   that the id is real. Every branch-scoped service in this codebase does this.
 */
export function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

/**
 * Which place is this request about?
 *
 * ⚠️ THE BRANCH THE REQUEST NAMES, OR THE ONE IT IS ACTING ON — NEVER THE FIRST
 *   ONE IN SCOPE. A clinician covering two sites must not have a procedure filed
 *   against whichever branch id happened to sort first: the stock came off one
 *   trolley, and picking arbitrarily is wrong silently and about half the time.
 *   `pharmacy/shared.ts` learned this the same way.
 */
export function resolveBranchId(
  ctx: TenantContext,
  named: string | undefined,
  acting: string | null | undefined
): string {
  const branchId = named ?? acting ?? (ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined);
  if (!branchId) {
    throw new ValidationError(
      'Say which branch this is for. You work at more than one and a procedure happens at exactly one of them.'
    );
  }
  assertBranchInScope(ctx, branchId);
  return branchId;
}

export interface ConsumptionLocation {
  id: string;
  name: string;
}

/**
 * The trolley, cabinet or treatment room the material came off.
 *
 * ⚠️ `is_dispensing_point` IS DELIBERATELY NOT CHECKED, WHICH IS THE ONE PLACE
 *   THIS DIVERGES FROM `resolveDispensingLocation`. A procedure room's trolley is
 *   not a counter, and requiring the flag here would force every clinic to
 *   mislabel its treatment rooms as dispensing points in order to record a swab
 *   — which would then let a pharmacist dispense a controlled drug out of a
 *   dental surgery, because that flag is what `resolveDispensingLocation` uses
 *   to stop exactly that. Two questions, two checks.
 *
 * What IS checked is the same as everywhere: the location exists at this branch,
 * it is not soft-deleted, and it is still in use.
 */
export async function resolveConsumptionLocation(
  tx: TxClient,
  branchId: string,
  locationId: string
): Promise<ConsumptionLocation> {
  const location = await tx.inventoryLocation.findFirst({
    where: { id: locationId, branchId, deletedAt: null },
    select: { id: true, name: true, isActive: true },
  });
  if (!location) throw new NotFoundError('Location');
  if (!location.isActive) {
    throw new ValidationError(`${location.name} is no longer in use, so nothing can come off it.`);
  }
  return { id: location.id, name: location.name };
}

/**
 * The two fields `recordAudit` takes, pulled out of the wider options object.
 *
 * ⚠️ EXPLICIT RATHER THAN `...options`, for the reason `pharmacy/shared.ts` gives:
 *   the wider options carry a route pattern, an acting branch and the caller's
 *   permission codes, and spreading them would put a caller's effective
 *   permissions into an audit row's shape.
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

/** What every consumption route hands its service. */
export interface ConsumptionActionOptions {
  route?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  actingBranchId?: string | null | undefined;
  /**
   * The caller's effective permission codes. ⚠️ Read to decide whether a
   * variance may be recorded — see `assertMayOverride`. The route resolves them;
   * the service never re-derives them from the token.
   */
  permissionCodes?: readonly string[] | undefined;
}

/**
 * Departing from the template needs its own code.
 *
 * ⚠️ CHECKED IN THE SERVICE RATHER THAN AT THE ROUTE, AND THAT IS THE ONLY PLACE
 *   IT CAN BE. The route cannot know whether a body contains a variance until
 *   the expected quantities have been read and the units converted — which is
 *   most of the work of recording one. `requirePermission` on the route gates
 *   `consumption.record`; this gates the narrower act inside it.
 *
 * ⚠️ AND IT REFUSES THE REQUEST RATHER THAN SILENTLY RECORDING THE EXPECTED
 *   FIGURE. Clamping to the template would put a number in the ledger that
 *   nobody used, which is the one outcome CLINICAL_CONSUMPTION.md rules out: the
 *   inventory must match reality even when the reality is inconvenient. Somebody
 *   who may not override asks somebody who may.
 */
export function assertMayOverride(
  options: ConsumptionActionOptions,
  productName: string,
  expected: string,
  actual: string
): void {
  if (options.permissionCodes?.includes('consumption.override')) return;
  throw new ValidationError(
    `${productName}: the template expected ${expected} and this records ${actual}. ` +
      'Recording a different quantity from the one expected needs the override permission — ' +
      'ask somebody who holds it rather than keying the expected figure, which would put a ' +
      'number in the ledger nobody used.'
  );
}
