'use server';

import { revalidatePath } from 'next/cache';
import {
  addRecallBatchesRequest,
  cancelRecallRequest,
  closeRecallRequest,
  createRecallRequest,
  executeRecallRequest,
  resolveRecallBatchRequest,
  type RecallDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of recall (PI-10).
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as everywhere else. It selects a Host
 *   header and a `revalidatePath` prefix and nothing else; the API compares the
 *   tenant resolved from that Host against the organization in the bearer token
 *   and returns 404 — never 403 — when they disagree. No action here may branch
 *   on it.
 *
 * ⚠️ NOTHING HERE STATES A QUANTITY. Executing a recall moves whatever is in the
 *   AVAILABLE bucket at the moment the transaction runs, read inside it. A
 *   figure from a screen somebody opened ten minutes ago is a figure about a
 *   different moment, and PI-ADR-004 says the ledger is the only source of
 *   quantity truth.
 *
 * ⚠️ AND NO PHI PASSES THROUGH ANY OF THEM. These actions post ids, lot numbers
 *   and free-text reasons. The affected-party list is a READ, on its own
 *   permission, and no action here touches it.
 */

export type RecallFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful create, so the screen can navigate to what it made. */
  createdId?: string;
};

export const IDLE_RECALL_FORM: RecallFormState = { status: 'idle' };

function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): RecallFormState {
  if (result.ok) return { status: 'saved' };
  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

function revalidate(slug: string, recallId?: string): void {
  revalidatePath(`/t/${slug}/product-recalls`);
  if (recallId !== undefined) revalidatePath(`/t/${slug}/product-recalls/${recallId}`);
  /* Executing moved quantity between buckets at every branch it could reach. */
  revalidatePath(`/t/${slug}/stock`);
  revalidatePath(`/t/${slug}/stock/lots`);
}

export async function createRecallAction(
  slug: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = createRecallRequest.safeParse({
    productId: emptyToNull(form.get('productId')) ?? '',
    title: emptyToNull(form.get('title')) ?? '',
    classification: emptyToNull(form.get('classification')) ?? 'UNCLASSIFIED',
    source: emptyToNull(form.get('source')) ?? 'MANUFACTURER',
    noticeReference: emptyToNull(form.get('noticeReference')),
    noticeOn: emptyToNull(form.get('noticeOn')),
    reason: emptyToNull(form.get('reason')) ?? '',
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the notice below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>('/api/v1/recalls', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * ⚠️ THE LOTS ARRIVE AS REPEATED CHECKBOX KEYS, WHICH IS SAFE HERE AND WOULD NOT
 *   BE ON A LINE EDITOR. A recall scope is a set of ids with nothing parallel to
 *   stay aligned with — no quantity, no unit, no reason per row — so one id
 *   skipped in the middle shifts nothing. The consumption panel serialises JSON
 *   precisely because its rows carry five parallel arrays.
 */
export async function addRecallBatchesAction(
  slug: string,
  recallId: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = addRecallBatchesRequest.safeParse({
    batchIds: form.getAll('batchIds').filter((value): value is string => typeof value === 'string'),
  });
  if (!parsed.success) {
    return { status: 'error', message: 'Choose at least one lot to add to this notice.' };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(`/api/v1/recalls/${recallId}/batches`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}

export async function removeRecallBatchAction(
  slug: string,
  recallId: string,
  recallBatchId: string,
  _previous: RecallFormState,
  _form: FormData
): Promise<RecallFormState> {
  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(`/api/v1/recalls/${recallId}/batches/${recallBatchId}`, {
    method: 'DELETE',
    slug,
    accessToken,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}

/**
 * ⚠️ THE MOST CONSEQUENTIAL ACTION IN THE WORKSPACE. It makes a product
 *   un-dispensable and un-consumable at every branch the caller can see, and
 *   every hold it writes is a ledger row that cannot be edited afterwards. The
 *   button that calls it says what it is about to do and names the count.
 */
export async function executeRecallAction(
  slug: string,
  recallId: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = executeRecallRequest.safeParse({ note: emptyToNull(form.get('note')) });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the note.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(`/api/v1/recalls/${recallId}/execute`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}

export async function resolveRecallBatchAction(
  slug: string,
  recallId: string,
  recallBatchId: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = resolveRecallBatchRequest.safeParse({
    resolution: form.get('resolution') === 'DISPOSE' ? 'DISPOSE' : 'RELEASE',
    note: emptyToNull(form.get('note')) ?? '',
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say what happened to this lot. A lot leaving a recall states why.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(
    `/api/v1/recalls/${recallId}/batches/${recallBatchId}/resolve`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}

export async function closeRecallAction(
  slug: string,
  recallId: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = closeRecallRequest.safeParse({
    outcomeNote: emptyToNull(form.get('outcomeNote')) ?? '',
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message:
        'Say how this ended. "Closed" is not an outcome; what was found and who was contacted is.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(`/api/v1/recalls/${recallId}/close`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}

export async function cancelRecallAction(
  slug: string,
  recallId: string,
  _previous: RecallFormState,
  form: FormData
): Promise<RecallFormState> {
  const parsed = cancelRecallRequest.safeParse({
    outcomeNote: emptyToNull(form.get('outcomeNote')) ?? '',
  });
  if (!parsed.success) {
    return { status: 'error', message: 'Say why this notice is being withdrawn.' };
  }

  const accessToken = await getAccessToken();
  const result = await api<RecallDetail>(`/api/v1/recalls/${recallId}/cancel`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidate(slug, recallId);
  return { status: 'saved' };
}
