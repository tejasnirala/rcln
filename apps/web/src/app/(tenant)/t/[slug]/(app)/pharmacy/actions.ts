'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelPrescriptionFulfilmentRequest,
  createDispenseRequest,
  createDispenseReturnRequest,
  verifyPrescriptionRequest,
  type DispenseDetail,
  type DispenseLineRequest,
  type DispenseReturnDetail,
  type PharmacyPrescriptionDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of the counter.
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as everywhere else. It selects a Host
 *   header and a `revalidatePath` prefix and nothing else; the API compares the
 *   tenant resolved from that Host against the organization in the bearer token
 *   and returns 404 — never 403 — when they disagree. No action here may branch
 *   on it.
 *
 * ⚠️ NOTHING HERE DECIDES WHETHER A SUPPLY IS LAWFUL. The regulatory engine is
 *   asked on the server, inside the transaction that moves the stock, and a
 *   refusal comes back as a 422 carrying the rule's own sentence. An action that
 *   pre-checked anything would be a second opinion that can drift from the one
 *   that counts.
 *
 * ⚠️ AND NO PHI IS PUT ANYWHERE IT PERSISTS. These actions post ids and
 *   quantities; the patient's name never leaves the rendered page, and nothing
 *   here writes to `localStorage`, a cookie or a URL.
 */

export type PharmacyFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful supply, so the workspace can navigate to what it made. */
  createdId?: string;
  /**
   * What the rules said, when they said something.
   *
   * ⚠️ RENDERED VERBATIM AND NEVER SUMMARISED. `regulatory_rules.statement` is
   *   written for the person standing at the counter and says what to DO about
   *   the refusal; rewording it here would lose that and would drift from what
   *   the Rules screens show for the same rule.
   */
  ruleMessages?: string[];
};

export const IDLE_FORM: PharmacyFormState = { status: 'idle' };

function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): PharmacyFormState {
  if (result.ok) return { status: 'saved' };

  /*
   * A 422 from the regulatory seam arrives with `messages` in the error envelope
   * — the same `Record<string, string[]>` shape field errors use, because that is
   * what the API's error responder puts on the wire. They are not field errors,
   * so they are lifted out here rather than being rendered against an input that
   * has nothing to do with them.
   */
  const ruleMessages = result.fieldErrors?.messages;
  const fieldErrors = result.fieldErrors
    ? Object.fromEntries(
        Object.entries(result.fieldErrors).filter(
          ([key]) => key !== 'messages' && key !== 'ruleCodes' && key !== 'outcome'
        )
      )
    : undefined;

  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    ...(ruleMessages && ruleMessages.length > 0 ? { ruleMessages } : {}),
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export async function verifyPrescriptionAction(
  slug: string,
  encounterId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = verifyPrescriptionRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? undefined,
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<PharmacyPrescriptionDetail>(
    `/api/v1/pharmacy/prescriptions/${encounterId}/verify`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/pharmacy/queue`);
  revalidatePath(`/t/${slug}/pharmacy/prescriptions/${encounterId}`);
  return { status: 'saved' };
}

/**
 * ⚠️ THIS STANDS THE DISPENSARY DOWN. It does not withdraw the prescription —
 *   that is the prescriber's act, in the clinical record, and there is no path to
 *   it from this section.
 */
export async function cancelFulfilmentAction(
  slug: string,
  encounterId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = cancelPrescriptionFulfilmentRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? undefined,
    reason: emptyToNull(form.get('reason')) ?? '',
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say why the dispensary is not supplying this.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<PharmacyPrescriptionDetail>(
    `/api/v1/pharmacy/prescriptions/${encounterId}/cancel`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/pharmacy/queue`);
  revalidatePath(`/t/${slug}/pharmacy/prescriptions/${encounterId}`);
  return { status: 'saved' };
}

// ---------------------------------------------------------------------------
// The supply
// ---------------------------------------------------------------------------

/**
 * One line per medicine the counter is handing over.
 *
 * ⚠️ THE FORM SENDS THE QUANTITY AND THE UNIT THE PERSON TYPED, NEVER A BASE
 *   QUANTITY AND NEVER A SIGN. The server converts through the same `toBaseUnits`
 *   the ledger legs use; a client that converted would put the label and the shelf
 *   out of step at the exact moment somebody reconciles them.
 *
 * ⚠️ ALLOCATIONS ARE OMITTED UNLESS A PHARMACIST CHOSE LOTS. Omitted means "use
 *   the FEFO plan the workspace just showed me", which the server recomputes
 *   inside the posting transaction rather than trusting a plan that may be
 *   minutes old.
 */
function linesFrom(form: FormData): DispenseLineRequest[] {
  const raw = form.get('lines');
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    return JSON.parse(raw) as DispenseLineRequest[];
  } catch {
    return [];
  }
}

export async function dispenseAction(
  slug: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = createDispenseRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')),
    locationId: emptyToNull(form.get('locationId')),
    kind: emptyToNull(form.get('kind')) ?? 'PRESCRIPTION',
    encounterId: emptyToNull(form.get('encounterId')),
    patientId: emptyToNull(form.get('patientId')),
    notes: emptyToNull(form.get('notes')),
    lines: linesFrom(form),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the supply before handing it over.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<DispenseDetail>('/api/v1/pharmacy/dispenses', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/pharmacy/queue`);
  revalidatePath(`/t/${slug}/pharmacy/dispenses`);
  if (parsed.data.encounterId) {
    revalidatePath(`/t/${slug}/pharmacy/prescriptions/${parsed.data.encounterId}`);
  }
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

export async function returnDispenseAction(
  slug: string,
  dispenseId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const rawLines = form.get('lines');
  const parsed = createDispenseReturnRequest.safeParse({
    locationId: emptyToNull(form.get('locationId')),
    reason: emptyToNull(form.get('reason')) ?? '',
    requestRestock: form.get('requestRestock') === 'on',
    lines: typeof rawLines === 'string' && rawLines.length > 0 ? JSON.parse(rawLines) : [],
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check what is coming back and why.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<DispenseReturnDetail>(
    `/api/v1/pharmacy/dispenses/${dispenseId}/return`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/pharmacy/dispenses`);
  revalidatePath(`/t/${slug}/pharmacy/dispenses/${dispenseId}`);
  return { status: 'saved' };
}
