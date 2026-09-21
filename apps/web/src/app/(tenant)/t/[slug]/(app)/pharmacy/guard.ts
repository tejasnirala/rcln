import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do at the counter, resolved once.
 *
 * ⚠️ THE SAME SHAPE `procurementAccess` HAS, AND FOR THE SAME REASON: seven pages
 *   ask the same question and one of them would otherwise ask it differently. The
 *   API refuses regardless — a screen that renders a button somebody may not use
 *   produces a 403, and one that hides a button they may use is a worse map.
 *
 * ⚠️ `canVerify` AND `canDispense` ARE SEPARATE FLAGS EVEN THOUGH `PHARMACIST`
 *   HOLDS BOTH. A clinic that has split the two — a checking pharmacist and a
 *   dispensing technician — is exactly the clinic where a screen that assumed one
 *   implies the other would offer the wrong button to both of them.
 */
export interface PharmacyAccess {
  canRead: boolean;
  canVerify: boolean;
  canDispense: boolean;
  canTakeReturns: boolean;
  /**
   * Online orders (PI-12), and the three flags are three different jobs.
   *
   * ⚠️ THERE IS NO `canPack` HERE, DELIBERATELY. Making the parcel up IS the
   *   supply — it writes the dispense and moves the ledger — so the screen reads
   *   `canDispense` for that button, exactly as the counter does. A fourth flag
   *   would be a second name for one permission, and the two would eventually
   *   disagree on a screen.
   */
  canReadOrders: boolean;
  canManageOrders: boolean;
  canDispatchOrders: boolean;
  /** Whether any of the above is true — i.e. whether the counter is theirs at all. */
  any: boolean;
}

export async function pharmacyAccess(slug: string): Promise<PharmacyAccess> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  const has = (code: string): boolean => permissions.includes(code);

  const access = {
    canRead: has(PERMISSIONS.DISPENSE_READ),
    canVerify: has(PERMISSIONS.DISPENSE_VERIFY),
    canDispense: has(PERMISSIONS.DISPENSE_CREATE),
    canTakeReturns: has(PERMISSIONS.DISPENSE_RETURN),
    canReadOrders: has(PERMISSIONS.ONLINE_ORDER_READ),
    canManageOrders: has(PERMISSIONS.ONLINE_ORDER_MANAGE),
    canDispatchOrders: has(PERMISSIONS.ONLINE_ORDER_DISPATCH),
  };

  return { ...access, any: Object.values(access).some(Boolean) };
}
