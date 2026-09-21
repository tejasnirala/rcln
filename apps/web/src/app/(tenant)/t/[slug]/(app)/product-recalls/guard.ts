import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do with a recall, resolved once (PI-10).
 *
 * ⚠️ THE SAME SHAPE `usageAccess`, `chargesAccess` AND `pharmacyAccess` HAVE, and
 *   for the same reason: several screens ask the same question and one of them
 *   would otherwise ask it differently. The API refuses regardless — a screen
 *   that renders a button somebody may not use produces a 403, and one that
 *   hides a button they may use is a worse map.
 *
 * ⚠️ `canSeePatients` IS THE ONE FLAG THAT HIDES CONTENT RATHER THAN A CONTROL,
 *   and it is the only place in this codebase where that is the right call. The
 *   affected-party list is a page of named people with phone numbers; a screen
 *   that rendered the table and let the API 403 it would have already told the
 *   reader how many patients are affected and invited them to try. The COUNT is
 *   on the trace panel, under the read code, which is what tells somebody
 *   without the patient code to ask a colleague.
 */
export interface RecallAccess {
  canRead: boolean;
  canCreate: boolean;
  canExecute: boolean;
  canSeePatients: boolean;
  /** Whether any of the above is true — i.e. whether this section is theirs. */
  any: boolean;
}

export async function recallAccess(slug: string): Promise<RecallAccess> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  const has = (code: string): boolean => permissions.includes(code);

  const access = {
    canRead: has(PERMISSIONS.RECALL_READ),
    canCreate: has(PERMISSIONS.RECALL_CREATE),
    canExecute: has(PERMISSIONS.RECALL_EXECUTE),
    canSeePatients: has(PERMISSIONS.RECALL_TRACE_PATIENTS),
  };

  return { ...access, any: Object.values(access).some(Boolean) };
}
