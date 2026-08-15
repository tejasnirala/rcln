'use server';

import { revalidatePath } from 'next/cache';
import type {
  ClinicalMasterListResponse,
  EncounterContent,
  EncounterDetail,
  EncounterSaveResponse,
  PreviousVisitResponse,
  ReferralTargetResponse,
  SaveEncounterDraftRequest,
  SetFollowUpRecommendationRequest,
  TaxonomyNodeListResponse,
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

// ---------------------------------------------------------------------------
// The clinical content (CE-4)
// ---------------------------------------------------------------------------

/*
 * ⚠️ THESE DO NOT `revalidatePath` EITHER, AND FOR THE SAME REASON THE AUTOSAVE
 *   DOES NOT. A clinician adds a diagnosis, types a note beside it, then adds a
 *   prescription — all in one sitting with a patient in the chair. Revalidating
 *   on each would re-render the consultation from the server, re-mount every
 *   input and throw the caret out of whichever box is being typed in. So each
 *   returns the whole content and the component swaps its own state for it.
 *
 * ⚠️ AND THE RESPONSE IS THE WHOLE CONTENT RATHER THAN THE ROW THAT CHANGED,
 *   because one of these writes legitimately changes a row in a DIFFERENT list:
 *   removing a diagnosis unlinks every procedure citing it. A per-row response
 *   would leave the screen reconciling eight lists by hand and getting that one
 *   case wrong.
 */

export type ContentResult =
  { ok: true; content: EncounterContent } | { ok: false; message: string };

/** The eight collections, spelled as the API paths spell them. */
export type ContentCollection =
  | 'symptoms'
  | 'diagnoses'
  | 'procedures'
  | 'prescriptions'
  | 'investigations'
  | 'advice'
  | 'referrals'
  | 'attachments';

/**
 * Add a row.
 *
 * ⚠️ ONE ACTION OVER A COLLECTION NAME RATHER THAN EIGHT NEAR-IDENTICAL ONES.
 *   The collection is a closed union the compiler checks, and the body is
 *   whatever that collection's contract accepts — the API validates it, which
 *   is where a request is validated in this codebase. Eight copies of this
 *   function would be eight places to forget the access token.
 */
export async function addContentRow(
  slug: string,
  encounterId: string,
  collection: ContentCollection,
  body: Record<string, unknown>
): Promise<ContentResult> {
  const result = await api<EncounterContent>(`/api/v1/encounters/${encounterId}/${collection}`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body,
  });
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'That could not be added.' };
  }
  return { ok: true, content: result.data };
}

export async function updateContentRow(
  slug: string,
  encounterId: string,
  collection: ContentCollection,
  rowId: string,
  body: Record<string, unknown>
): Promise<ContentResult> {
  const result = await api<EncounterContent>(
    `/api/v1/encounters/${encounterId}/${collection}/${rowId}`,
    { method: 'PATCH', slug, accessToken: await getAccessToken(), body }
  );
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'That could not be saved.' };
  }
  return { ok: true, content: result.data };
}

export async function removeContentRow(
  slug: string,
  encounterId: string,
  collection: ContentCollection,
  rowId: string
): Promise<ContentResult> {
  const result = await api<EncounterContent>(
    `/api/v1/encounters/${encounterId}/${collection}/${rowId}`,
    { method: 'DELETE', slug, accessToken: await getAccessToken() }
  );
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'That could not be removed.' };
  }
  return { ok: true, content: result.data };
}

/**
 * State the follow-up plan (CD-13).
 *
 * ⚠️ A `PUT`, BECAUSE THERE IS ONE PER CONSULTATION. A second statement
 *   replaces the first; the superseded row is kept rather than overwritten,
 *   because "the doctor said 15 days and then changed it to 30" is part of the
 *   record.
 */
export async function setFollowUp(
  slug: string,
  encounterId: string,
  body: SetFollowUpRecommendationRequest
): Promise<ContentResult> {
  const result = await api<EncounterContent>(`/api/v1/encounters/${encounterId}/follow-up`, {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body,
  });
  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'The follow-up could not be recorded.' };
  }
  return { ok: true, content: result.data };
}

/**
 * The medicines behind the prescription selector.
 *
 * ⚠️ THE PRODUCT CATALOGUE, NOT `clinical_master_items` (§11). A medicine is a
 *   stocked, batched, taxed thing (PI-ADR-001), not a clinical word — which is
 *   why the PRESCRIPTION section's registry entry has `vocabulary: null`, and
 *   why this is a different endpoint from `searchClinicalTerms` above.
 *
 * ⚠️ AND IT SEARCHES THE SERVER, NEVER A LOADED CATALOGUE (§39). The same
 *   argument as the clinical selector, more forcefully: a formulary runs to
 *   tens of thousands of rows.
 */
export async function searchPrescribableProducts(
  slug: string,
  term: string
): Promise<{ id: string; name: string; code: string }[]> {
  const query = new URLSearchParams({ pageSize: '10' });
  if (term.trim() !== '') query.set('search', term.trim());

  const result = await api<{ items: { id: string; name: string; code: string }[] }>(
    `/api/v1/products?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  if (!result.ok || !result.data) return [];
  return result.data.items.map((item) => ({ id: item.id, name: item.name, code: item.code }));
}

// ---------------------------------------------------------------------------
// The read surfaces (CE-5)
// ---------------------------------------------------------------------------

/**
 * What happened last time (§37).
 *
 * ⚠️ THE RESPONSE SAYS HOW IT WAS FOUND AND THE PANEL MUST NOT FLATTEN THAT.
 *   `PARENT_APPOINTMENT` is a fact the database enforces; `MOST_RECENT` is a
 *   convenience. See `PreviousVisitSummary` — the three get three sentences.
 *
 * ⚠️ IT WRITES A `data_access_logs` ROW. Another consultation's clinical content
 *   is read here, and reading it is a disclosure even from the doctor's own
 *   screen.
 */
export async function loadPreviousVisit(
  slug: string,
  appointmentId: string
): Promise<PreviousVisitResponse['previous']> {
  const result = await api<PreviousVisitResponse>(
    `/api/v1/appointments/${appointmentId}/previous-visit`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data.previous : null;
}

/**
 * The specialties behind a referral's destination picker (§37).
 *
 * ⚠️ THE TAXONOMY, NOT `clinical_master_items`. "Refer to a cardiologist" names
 *   a CLASSIFICATION — the same tree a doctor's own specialties hang off — and
 *   `encounter_referrals.specialty_id` points at it. A second vocabulary of
 *   specialty-shaped words would be a second answer to what a specialty is.
 */
export async function searchReferralSpecialties(
  slug: string,
  term: string
): Promise<{ id: string; name: string }[]> {
  if (term.trim().length < 2) return [];
  /* ⚠️ THE PARAMETER IS `q`, WHICH IS WHAT `taxonomySearchQuery` DECLARES. A
     `search=` here validates as "q is required" and answers 400. */
  const query = new URLSearchParams({ q: term.trim(), limit: '10' });
  const result = await api<TaxonomyNodeListResponse>(
    `/api/v1/clinical-taxonomy/search?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  if (!result.ok || !result.data) return [];
  return result.data.nodes.map((node) => ({ id: node.id, name: node.name }));
}

/**
 * The colleagues behind a referral's in-house destination (§37).
 *
 * ⚠️ NOT THE DOCTOR ROSTER, AND THE ENDPOINT IS DIFFERENT FOR AN ACCESS REASON
 *   RATHER THAN A SHAPE ONE. A DOCTOR does not hold `doctor.directory.read` —
 *   the roster is a personnel list and `roles.ts` says so — so `GET /doctors`
 *   403s for the very person writing the referral. `GET /doctors/referral-targets`
 *   sits behind `clinical.encounter.create`, requires a search term, and answers
 *   a name and a specialty and nothing else. See the route.
 */
export async function searchReferralDoctors(
  slug: string,
  term: string
): Promise<{ id: string; name: string }[]> {
  if (term.trim().length < 2) return [];
  const query = new URLSearchParams({ search: term.trim(), pageSize: '10' });
  const result = await api<ReferralTargetResponse>(
    `/api/v1/doctors/referral-targets?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  if (!result.ok || !result.data) return [];
  return result.data.targets.map((target) => ({
    id: target.doctorProfileId,
    /* The specialty disambiguates two colleagues of one name, which is exactly
       what a picker of people needs and a picker of words does not. */
    name: target.specialtyName === null ? target.name : `${target.name} — ${target.specialtyName}`,
  }));
}
