'use server';

import { revalidatePath } from 'next/cache';
import type {
  ClinicalMasterListResponse,
  EncounterDetail,
  EncounterSaveResponse,
  SaveEncounterDraftRequest,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The consultation, from the browser's side (CE-3).
 *
 * ⚠️ THE AUTOSAVE MUST NOT `revalidatePath`, AND THAT IS THE WHOLE REASON THIS
 *   FILE IS SEPARATE FROM `actions.ts`. Every other write in the appointments
 *   area revalidates, because every other write ends an interaction. An autosave
 *   fires WHILE the doctor is typing: revalidating re-renders the consultation
 *   from the server between keystrokes, which re-mounts the inputs, moves the
 *   caret to the end and drops whatever was typed during the round trip.
 *
 *   So `saveConsultation` returns the saved revision and nothing else, and the
 *   revalidations happen on the transitions that DO end an interaction —
 *   finalize, amend, cancel.
 *
 * ⚠️ AND NOTHING HERE PUTS PHI ANYWHERE PERSISTENT. No draft in `localStorage`,
 *   no encounter text in a cookie, no chief complaint in a URL (CD-8). The
 *   server holds the draft; the browser holds what is on screen.
 *
 * `slug` is bound on the server before these reach the browser, so a client
 * cannot re-point one at another clinic.
 */

export type ConsultationState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
  /** When the last successful save landed, for the "Saved at…" line. */
  savedAt?: string;
};

/**
 * Open the consultation for a visit, or resume the one already open.
 *
 * ⚠️ IDEMPOTENT — a second call returns the same draft. That is what makes it
 *   safe to call from a render, exactly as `POST /appointments/:id/consultation`
 *   already is.
 */
export async function openConsultation(
  slug: string,
  appointmentId: string
): Promise<{ ok: true; encounter: EncounterDetail } | { ok: false; message: string }> {
  const result = await api<EncounterDetail>('/api/v1/encounters', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { appointmentId },
  });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'This consultation could not be opened.' };
  }
  return { ok: true, encounter: result.data };
}

/**
 * The consultation recorded at this visit, for somebody who may read it and not
 * write it.
 *
 * ⚠️ A SEPARATE CALL FROM `openConsultation`, AND NOT AN OPTIMISATION. Opening a
 *   draft is authorship: an administrator arriving to read a booking must not
 *   make "the doctor started a consultation" true by looking at it. This reads,
 *   and answers `null` when nothing has been written up.
 */
export async function loadConsultation(
  slug: string,
  appointmentId: string
): Promise<EncounterDetail | null> {
  const result = await api<EncounterDetail | null>(
    `/api/v1/appointments/${appointmentId}/encounter`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok ? (result.data ?? null) : null;
}

/**
 * The debounced save.
 *
 * ⚠️ RETURNS THE REVISION AND REVALIDATES NOTHING. See the file header — this is
 *   the one write in the app that deliberately leaves the page alone.
 */
export async function saveConsultation(
  slug: string,
  encounterId: string,
  patch: SaveEncounterDraftRequest
): Promise<ConsultationState> {
  const result = await api<EncounterSaveResponse>(`/api/v1/encounters/${encounterId}`, {
    method: 'PATCH',
    slug,
    accessToken: await getAccessToken(),
    body: patch,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      /*
       * The API's sentence, not a generic one. When a save fails because a
       * section key no longer exists, the doctor needs to know which — "could
       * not be saved" sends them to support with nothing to say.
       */
      message: result.message ?? 'This consultation could not be saved.',
    };
  }

  return { status: 'saved', savedAt: result.data.savedAt };
}

/**
 * Sign the record.
 *
 * ⚠️ REVALIDATES, BECAUSE THIS ENDS THE INTERACTION. The page comes back with
 *   the consultation read-only and the day board reflects a visit that is
 *   written up.
 */
export async function finalizeConsultation(
  slug: string,
  appointmentId: string,
  encounterId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await api<EncounterDetail>(`/api/v1/encounters/${encounterId}/finalize`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: {},
  });

  if (!result.ok) {
    return {
      ok: false,
      /* The validation sentence names every missing field at once — pass it
         through verbatim rather than replacing it with "check the form". */
      message: result.message ?? 'This consultation could not be signed.',
    };
  }

  revalidatePath(`/t/${slug}/appointments`);
  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  return { ok: true };
}

/** Correct a signed record by starting a new one that cites it (CD-2). */
export async function amendConsultation(
  slug: string,
  appointmentId: string,
  encounterId: string,
  reason: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await api<EncounterDetail>(`/api/v1/encounters/${encounterId}/amend`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { reason },
  });

  if (!result.ok) {
    return { ok: false, message: result.message ?? 'This amendment could not be started.' };
  }

  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  return { ok: true };
}

/** Abandon a draft. Recorded, never deleted. */
export async function cancelConsultation(
  slug: string,
  appointmentId: string,
  encounterId: string,
  reason: string | undefined
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await api<{ cancelled: boolean }>(`/api/v1/encounters/${encounterId}/cancel`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: reason === undefined ? {} : { reason },
  });

  if (!result.ok) {
    return { ok: false, message: result.message ?? 'This consultation could not be cancelled.' };
  }

  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  return { ok: true };
}

/**
 * The vocabulary behind a `CLINICAL_SELECTOR` field.
 *
 * ⚠️ ALWAYS THE SERVER, NEVER A LOADED MASTER (§39). A clinical vocabulary is
 *   platform-wide and runs to thousands of rows; shipping it to the browser to
 *   filter locally is slow on the first render and wrong on every later one,
 *   because a word the clinic added this morning is not in the copy the tab
 *   loaded at nine.
 *
 * ⚠️ AND THE SCOPE RANKS RATHER THAN FILTERS (§34). `specialtyId` orders the
 *   scoped matches first and returns the rest underneath; a term nobody tagged
 *   is still findable, which is what stops a forgotten tag becoming an invisible
 *   diagnosis.
 */
export async function searchClinicalTerms(
  slug: string,
  kind: string,
  term: string,
  specialtyId: string | undefined
): Promise<{ id: string; name: string }[]> {
  const query = new URLSearchParams({ kind, pageSize: '10' });
  if (term.trim() !== '') query.set('search', term.trim());
  if (specialtyId !== undefined) query.set('specialtyId', specialtyId);

  const result = await api<ClinicalMasterListResponse>(
    `/api/v1/clinical-data?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );

  if (!result.ok || !result.data) return [];
  return result.data.items.map((item) => ({ id: item.id, name: item.name }));
}
