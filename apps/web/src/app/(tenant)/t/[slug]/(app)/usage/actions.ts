'use server';

import { revalidatePath } from 'next/cache';
import {
  correctConsumptionRequest,
  createConsumptionTemplateRequest,
  recordConsumptionRequest,
  updateConsumptionTemplateRequest,
  type ConsumptionDetail,
  type ConsumptionTemplateDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of clinical consumption (PI-9).
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as everywhere else. It selects a Host
 *   header and a `revalidatePath` prefix and nothing else; the API compares the
 *   tenant resolved from that Host against the organization in the bearer token
 *   and returns 404 — never 403 — when they disagree. No action here may branch
 *   on it.
 *
 * ⚠️ NOTHING HERE STATES A PRICE, A POLICY OR A VARIANCE FLAG. The charge policy
 *   is resolved on the server inside the transaction that wrote the record, and
 *   whether a line departs from its template is arithmetic the server does over
 *   two numbers it already holds. An action that sent either would be a second
 *   opinion free to drift from the one the record was actually made from — and
 *   in the variance case it would be a control only the honest client applies,
 *   which is the shape of PI-8.11's dispensing CRITICAL.
 *
 * ⚠️ AND NO PHI PERSISTS ANYWHERE. These actions post ids and decimal strings;
 *   the patient's name never leaves the rendered page, and nothing here writes
 *   to `localStorage`, a cookie or a URL.
 */

export type UsageFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful write, so the screen can navigate to what it made. */
  createdId?: string;
};

export const IDLE_USAGE_FORM: UsageFormState = { status: 'idle' };

function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): UsageFormState {
  if (result.ok) return { status: 'saved' };
  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recording what was used
// ---------------------------------------------------------------------------

/**
 * One line as the panel serialises it.
 *
 * ⚠️ THE LINES ARRIVE AS JSON IN A SINGLE FIELD RATHER THAN AS REPEATED FORM
 *   KEYS. A consumption line carries a template pairing, a unit, a quantity, an
 *   optional reason and an optional lot breakdown — five parallel `getAll`
 *   arrays that have to stay index-aligned, and one line skipped in the middle
 *   silently shifts every value after it onto the wrong product. The dispensing
 *   workspace made the same call for the same reason.
 */
interface SerialisedAllocation {
  locationId: string;
  batchId?: string | null;
  serialId?: string | null;
  quantityBase: string;
  overrideReason?: string | null;
}

interface SerialisedLine {
  templateLineId?: string | null;
  productId: string;
  quantity: string;
  unitId: string;
  overrideReason?: string | null;
  /**
   * ⚠️ ABSENT ON A LINE NOBODY CHOSE LOTS FOR, AND THE ABSENCE IS MEANINGFUL —
   *   it is the contract's own "you plan it", and the server runs FEFO inside
   *   the posting transaction. Present only where somebody opened the picker
   *   (PI-9.9), which is what makes recording a specific numbered implant
   *   possible without making every glove a lot decision.
   */
  allocations?: SerialisedAllocation[];
}

function parseLines(form: FormData): SerialisedLine[] {
  const raw = form.get('lines');
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SerialisedLine[]) : [];
  } catch {
    return [];
  }
}

export async function recordConsumptionAction(
  slug: string,
  _previous: UsageFormState,
  form: FormData
): Promise<UsageFormState> {
  const procedureId = emptyToNull(form.get('encounterProcedureId'));
  const lines = parseLines(form);

  if (lines.length === 0) {
    return {
      status: 'error',
      message: 'Nothing is on this list. Set a quantity against at least one item.',
    };
  }

  const parsed = recordConsumptionRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? undefined,
    anchorKind: procedureId === null ? 'ENCOUNTER' : 'ENCOUNTER_PROCEDURE',
    encounterId: emptyToNull(form.get('encounterId')) ?? '',
    encounterProcedureId: procedureId,
    locationId: emptyToNull(form.get('locationId')) ?? '',
    notes: emptyToNull(form.get('notes')),
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the quantities below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ConsumptionDetail>('/api/v1/consumption/records', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/usage`);
  revalidatePath(`/t/${slug}/consultations/${parsed.data.encounterId}`);
  /* The charge queue gained rows in the same transaction. */
  revalidatePath(`/t/${slug}/charges`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * Correct a record whose consultation has closed.
 *
 * ⚠️ TWO DIRECTIONS, ONE FORM, AND THE QUANTITIES ARE POSITIVE IN BOTH. "More
 *   was used" and "less was used" are the same shape of statement about
 *   different directions, and the sign lives in `kind` for the reason
 *   `stock_ledger` keeps it out of the quantity.
 */
export async function correctConsumptionAction(
  slug: string,
  consumptionId: string,
  _previous: UsageFormState,
  form: FormData
): Promise<UsageFormState> {
  const lines = parseLines(form);
  if (lines.length === 0) {
    return { status: 'error', message: 'Say what should change, and by how much.' };
  }

  const parsed = correctConsumptionRequest.safeParse({
    kind:
      form.get('kind') === 'CONSUMPTION_REVERSAL'
        ? 'CONSUMPTION_REVERSAL'
        : 'ADDITIONAL_CONSUMPTION',
    reason: emptyToNull(form.get('reason')) ?? '',
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say why this is being corrected, and check the quantities.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ConsumptionDetail>(
    `/api/v1/consumption/records/${consumptionId}/corrections`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/usage`);
  revalidatePath(`/t/${slug}/charges`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface SerialisedTemplateLine {
  productId: string;
  quantity: string;
  unitId: string;
  isOptional: boolean;
  displayOrder: number;
  note?: string | null;
}

function parseTemplateLines(form: FormData): SerialisedTemplateLine[] {
  const raw = form.get('lines');
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as SerialisedTemplateLine[]).map((line, index) => ({
      ...line,
      /* The order on screen IS the order stored. Nobody types a sort key. */
      displayOrder: index,
    }));
  } catch {
    return [];
  }
}

export async function createConsumptionTemplateAction(
  slug: string,
  _previous: UsageFormState,
  form: FormData
): Promise<UsageFormState> {
  const parsed = createConsumptionTemplateRequest.safeParse({
    itemId: emptyToNull(form.get('itemId')) ?? '',
    name: emptyToNull(form.get('name')) ?? '',
    effectiveFrom: emptyToNull(form.get('effectiveFrom')) ?? undefined,
    effectiveTo: emptyToNull(form.get('effectiveTo')),
    status: form.get('status') === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
    notes: emptyToNull(form.get('notes')),
    lines: parseTemplateLines(form),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ConsumptionTemplateDetail>('/api/v1/consumption/templates', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/usage/templates`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * ⚠️ `lines` IS OMITTED WHEN THE FORM DOES NOT CARRY IT, AND SENT — POSSIBLY
 *   EMPTY — WHEN IT DOES. "Leave the lines alone" and "the template now lists
 *   nothing" are different intentions and the contract keeps them apart; a
 *   `?? []` here would empty a template every time somebody renamed one.
 */
export async function updateConsumptionTemplateAction(
  slug: string,
  templateId: string,
  _previous: UsageFormState,
  form: FormData
): Promise<UsageFormState> {
  const hasLines = typeof form.get('lines') === 'string';

  const parsed = updateConsumptionTemplateRequest.safeParse({
    ...(form.get('name') !== null ? { name: emptyToNull(form.get('name')) ?? '' } : {}),
    ...(form.get('status') !== null ? { status: String(form.get('status')) } : {}),
    ...(form.get('effectiveFrom') !== null
      ? { effectiveFrom: emptyToNull(form.get('effectiveFrom')) ?? undefined }
      : {}),
    ...(form.get('effectiveTo') !== null
      ? { effectiveTo: emptyToNull(form.get('effectiveTo')) }
      : {}),
    ...(form.get('notes') !== null ? { notes: emptyToNull(form.get('notes')) } : {}),
    ...(hasLines ? { lines: parseTemplateLines(form) } : {}),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ConsumptionTemplateDetail>(
    `/api/v1/consumption/templates/${templateId}`,
    { method: 'PATCH', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/usage/templates`);
  revalidatePath(`/t/${slug}/usage/templates/${templateId}`);
  return { status: 'saved' };
}

/**
 * Retire a template.
 *
 * ⚠️ "RETIRE", NOT "DELETE", ON THE BUTTON AND IN THE SERVICE. A recorded
 *   procedure cites the version it was pre-filled from and the row is never
 *   removed; a button saying Delete would promise something the database
 *   refuses.
 */
export async function retireConsumptionTemplateAction(
  slug: string,
  templateId: string
): Promise<UsageFormState> {
  const accessToken = await getAccessToken();
  const result = await api<void>(`/api/v1/consumption/templates/${templateId}`, {
    method: 'DELETE',
    slug,
    accessToken,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/usage/templates`);
  return { status: 'saved' };
}
