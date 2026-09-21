/**
 * The pieces every consumption service needs, in one place so they cannot
 * drift: branch scoping, the place stock came off, the template in force on a
 * day, and the allocation arithmetic.
 *
 * NO PHI IS LOGGED FROM THIS FILE.
 */
import { type TenantContext, type TxClient } from '@rcln/db';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { resolveBranchId as resolveBranchIdShared } from '../shared/branch.js';

/*
 * ⚠️ THESE FOUR ARE RE-EXPORTED, NOT REDEFINED (PI-11 review). They lived here as
 *   byte-for-byte copies of `pharmacy/shared.ts`'s, including the doc comments —
 *   on the two functions that decide which tenant's branch a write is attributed
 *   to. `services/shared/branch.ts` is now the single source; the import list
 *   below keeps every existing call site in this domain unchanged.
 */
export { assertBranchInScope, auditMeta, q } from '../shared/branch.js';

/**
 * The consumption domain's wording of the shared resolver. The security-relevant
 * body is in `shared/branch.ts`; only the noun in the sentence differs.
 */
export function resolveBranchId(
  ctx: TenantContext,
  named: string | undefined,
  acting: string | null | undefined
): string {
  return resolveBranchIdShared(ctx, named, acting, 'a procedure happens at exactly one of them');
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
