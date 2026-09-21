import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do with consumption, resolved once (PI-9).
 *
 * ⚠️ THE SAME SHAPE `chargesAccess` AND `pharmacyAccess` HAVE, AND FOR THE SAME
 *   REASON: four screens ask the same question and one of them would otherwise
 *   ask it differently. The API refuses regardless — a screen that renders a
 *   button somebody may not use produces a 403, and one that hides a button they
 *   may use is a worse map.
 *
 * ⚠️ FOUR FLAGS FOR WHAT LOOKS LIKE ONE JOB, BECAUSE THE ACTS ARE DIFFERENT.
 *   Reading what was used, recording it, departing from what the template
 *   expected, and deciding what a procedure is expected to use are four
 *   decisions with four different reaches — a pharmacist holds only the first, a
 *   nurse holds the first three, and the last belongs to whoever runs the
 *   branch. A screen that assumed one implies another would offer the wrong
 *   control to three of the four people who open it.
 *
 * ⚠️ `canOverride` CHANGES NO CONTROL, ONLY A SENTENCE. The quantity field is
 *   editable either way — obstructing it would invite somebody to key the
 *   expected figure, which puts a number in the ledger nobody used. What the
 *   flag does is warn, before the round trip, that this record will be refused.
 */
export interface UsageAccess {
  canRead: boolean;
  canRecord: boolean;
  canOverride: boolean;
  canManageTemplates: boolean;
  /** Whether any of the above is true — i.e. whether this section is theirs. */
  any: boolean;
}

export async function usageAccess(slug: string): Promise<UsageAccess> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  const has = (code: string): boolean => permissions.includes(code);

  const access = {
    canRead: has(PERMISSIONS.CONSUMPTION_READ),
    canRecord: has(PERMISSIONS.CONSUMPTION_RECORD),
    canOverride: has(PERMISSIONS.CONSUMPTION_OVERRIDE),
    canManageTemplates: has(PERMISSIONS.CONSUMPTION_TEMPLATE_MANAGE),
  };

  return { ...access, any: Object.values(access).some(Boolean) };
}
