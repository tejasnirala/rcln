'use server';

import { revalidatePath } from 'next/cache';
import type { FollowUpRecallResponse, FollowUpRecallStatusValue } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The recall list, from the browser's side (CE-5).
 *
 * ⚠️ THE DESK'S SCREEN, NOT THE DOCTOR'S, AND THE PERMISSIONS SAY SO. Reading
 *   and working this list is `appointment.read` / `appointment.update`, because
 *   somebody rings the patient and books them in — the front desk holds no
 *   clinical code at all. Advising a follow-up is authorship and happens in the
 *   consultation, behind `clinical.encounter.create`. That split is invariant
 *   7's, applied to a chase rather than to a chart.
 *
 * ⚠️ NOTHING HERE PUTS A PATIENT IN A URL. The status and the window are query
 *   parameters because they disclose nobody; the patient filter is not offered
 *   on this screen at all, and the rows carry ids the actions post in a body.
 */

/**
 * Who was told to come back and hasn't.
 *
 * ⚠️ ALWAYS PAGINATED AND ALWAYS WINDOWED. The API refuses an unbounded read and
 *   this is why: a full list of outstanding recommendations is a list of
 *   everybody at the clinic under ongoing treatment, and the response carries
 *   names and telephone numbers because the desk is about to ring them.
 */
export async function loadRecall(
  slug: string,
  status: FollowUpRecallStatusValue,
  page: number,
  withinDays: number
): Promise<FollowUpRecallResponse | null> {
  const query = new URLSearchParams({
    status,
    page: String(page),
    pageSize: '25',
    withinDays: String(withinDays),
  });
  const result = await api<FollowUpRecallResponse>(
    `/api/v1/follow-up-recommendations?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data : null;
}

export type RecallActionState = { status: 'idle' | 'error' | 'done'; message?: string };

/**
 * The patient declined, or the plan changed before they booked.
 *
 * ⚠️ RECORDED RATHER THAN DELETED. "We asked and they said no" is the answer to
 *   a recall chase; a deleted row makes the desk ring them again next month.
 *
 * ⚠️ AND IT REACHES A FINALIZED CONSULTATION'S RECOMMENDATION, deliberately —
 *   one of exactly two writes that do, alongside fulfilment. Declining happens
 *   weeks later, at the desk, and it is a fact about the recommendation's FATE
 *   rather than an edit to the clinical record. Nothing the doctor wrote changes.
 *
 * ⚠️ THIS ONE DOES `revalidatePath`, unlike the consultation writers. It ends an
 *   interaction — the row leaves the list — and there is no caret to protect.
 */
export async function declineRecall(
  slug: string,
  recommendationId: string,
  reason: string | undefined
): Promise<RecallActionState> {
  const result = await api<{ cancelled: boolean }>(
    `/api/v1/follow-up-recommendations/${recommendationId}/cancel`,
    {
      method: 'POST',
      slug,
      accessToken: await getAccessToken(),
      body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
    }
  );

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'That could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/recall`);
  return { status: 'done' };
}
