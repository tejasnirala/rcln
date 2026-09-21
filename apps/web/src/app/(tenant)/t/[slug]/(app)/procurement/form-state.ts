/**
 * The idle form state for this route's actions.
 *
 * ⚠️ NOT IN `actions.ts`, AND IT CANNOT BE. A `'use server'` module may export
 *   ONLY async functions — every other export is a value the runtime would have
 *   to send across the server/client boundary, and Next refuses the whole module
 *   rather than one export: "A 'use server' file can only export async
 *   functions, found object". The page then fails at MODULE EVALUATION, so the
 *   route does not render at all.
 *
 * ⚠️ AND THE FAILURE IS INVISIBLE UNTIL SOMEBODY OPENS THE ROUTE. It is not a
 *   type error and not a lint error; `tsc` and `eslint` both pass. Seven route
 *   groups shipped with this because every one of them sits behind a module the
 *   clinic had not switched on, so no page had ever been evaluated.
 *
 * `lib/invoice-filters.ts` records the same rule and is the precedent for this
 * file existing.
 */
import type { ProcurementFormState } from './actions';

export const IDLE_FORM: ProcurementFormState = { status: 'idle' };
