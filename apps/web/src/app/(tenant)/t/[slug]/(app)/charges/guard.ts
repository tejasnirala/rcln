import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do with charges, resolved once (PI-8).
 *
 * ⚠️ THE SAME SHAPE `pharmacyAccess` AND `procurementAccess` HAVE, AND FOR THE
 *   SAME REASON: three pages ask the same question and one of them would
 *   otherwise ask it differently. The API refuses regardless — a screen that
 *   renders a button somebody may not use produces a 403, and one that hides a
 *   button they may use is a worse map.
 *
 * ⚠️ FOUR SEPARATE FLAGS FOR WHAT LOOKS LIKE ONE JOB, BECAUSE THE BLAST RADII
 *   DIFFER BY ORDERS OF MAGNITUDE. Reading the queue, answering one charge,
 *   editing the standing policy and setting a price are four decisions with four
 *   different reaches — a pharmacist holds only the first, the front desk holds
 *   the first two, and the last two are the organization's. A screen that
 *   assumed one implies another would offer the wrong control to three of the
 *   four people who open it.
 */
export interface ChargesAccess {
  canRead: boolean;
  canDecide: boolean;
  canManagePolicy: boolean;
  canReadPrices: boolean;
  canManagePrices: boolean;
  /** Whether any of the above is true — i.e. whether this section is theirs. */
  any: boolean;
}

export async function chargesAccess(slug: string): Promise<ChargesAccess> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  const has = (code: string): boolean => permissions.includes(code);

  const access = {
    canRead: has(PERMISSIONS.CHARGE_REQUEST_READ),
    canDecide: has(PERMISSIONS.CHARGE_REQUEST_MANAGE),
    canManagePolicy: has(PERMISSIONS.CHARGE_POLICY_MANAGE),
    canReadPrices: has(PERMISSIONS.FEE_SCHEDULE_READ),
    canManagePrices: has(PERMISSIONS.FEE_SCHEDULE_MANAGE),
  };

  return { ...access, any: Object.values(access).some(Boolean) };
}
