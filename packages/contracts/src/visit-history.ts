/**
 * The read surfaces over everything CE-1…CE-4 stores (CE-5).
 *
 * ⚠️ EVERY SHAPE IN THIS FILE IS PHI, AND IT IS THE MOST CONCENTRATED PHI IN THE
 *   CONTRACTS. A visit history is one named person's entire clinical past in one
 *   response — every journey, every visit, every diagnosis. Nothing here goes in
 *   a URL query, a cookie, `localStorage` or an audit payload, and every endpoint
 *   that returns one writes a `data_access_logs` row.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `clinical.ts` ───────────────────────────
 *
 * ⚠️ THE DEPENDENCY RUNS ONE WAY AND A CYCLE HERE FAILS AT RUNTIME, NOT AT
 *   LINT. `encounter-content.ts` imports `clinical.ts` (for the follow-up enums),
 *   so `clinical.ts` cannot import `encounterContent` back — the schemas are
 *   built at module evaluation, and whichever side loaded second would read
 *   `undefined` with nothing on screen to explain it. This file sits downstream
 *   of both and imports from each, which is the only arrangement that works.
 *
 * ── TWO DISCLOSURE CLASSES, TWO ENDPOINTS (CD-14) ────────────────────────────
 *
 *   GET /clinical-episodes/:id     appointment.read       WHEN somebody came in
 *   GET /patients/:id/visit-history clinical.encounter.read WHAT was concluded
 *
 * The front desk works the first — booking a follow-up means knowing which
 * journey a visit belongs to. Only somebody who may read the chart gets the
 * second, because a list of diagnoses is a chart however it is paginated.
 */
import { z } from 'zod';
import { uuid } from './common.js';
import { clinicalEpisodeSummary } from './clinical.js';
import { clinicalDurationUnit, encounterContent } from './encounter-content.js';
import { clinicalOnset, encounterStatus } from './encounters.js';

/**
 * One consultation, small enough to list.
 *
 * ⚠️ COUNTS RATHER THAN ROWS FOR EVERYTHING EXCEPT THE DIAGNOSES, and the
 *   asymmetry is deliberate. A timeline entry answers "what was this visit
 *   about", which is the diagnosis and nothing else; the dosage of the third
 *   medicine is a question you open the record to ask. Sending every
 *   prescription line for every visit in a patient's history would make the
 *   response grow without bound and would disclose far more than the screen
 *   renders.
 */
export const encounterVisitSummary = z.object({
  id: uuid,
  status: encounterStatus,
  /** Null until finalization — a draft has burnt no counter. */
  encounterNumber: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().nullable(),
  /** ⚠️ PHI. The patient's own words. */
  chiefComplaint: z.string().nullable(),
  chiefComplaintDurationValue: z.number().int().nullable(),
  chiefComplaintDurationUnit: clinicalDurationUnit.nullable(),
  onset: clinicalOnset.nullable(),
  /**
   * ⚠️ PHI. Display names, primary first, then by display order. A coded
   *   diagnosis contributes its master item's name and a free-text one
   *   contributes the clinician's own words — the screen cannot tell them apart
   *   and does not need to.
   */
  diagnoses: z.array(z.string()),
  prescriptionCount: z.number().int(),
  investigationCount: z.number().int(),
  procedureCount: z.number().int(),
  referralCount: z.number().int(),
  attachmentCount: z.number().int(),
  /** The record this one corrects, and the record that corrected this one. */
  amendsEncounterId: uuid.nullable(),
  amendedAt: z.iso.datetime().nullable(),
  /** What the doctor asked for at the end of it, if anything. */
  followUpDueOn: z.string().nullable(),
  followUpIsRequired: z.boolean().nullable(),
});
export type EncounterVisitSummary = z.infer<typeof encounterVisitSummary>;

/**
 * One visit on the timeline.
 *
 * ⚠️ BOTH HALVES ARE NULLABLE AND AT LEAST ONE IS ALWAYS PRESENT. A booking with
 *   no consultation is a no-show or a visit not yet written up; a consultation
 *   with no booking is a walk-in (CD-1). Folding them into one required shape
 *   would lose whichever fact the row is actually recording — the same reason
 *   `appointments` and `encounters` are two tables.
 */
export const visitHistoryVisit = z.object({
  appointmentId: uuid.nullable(),
  appointmentNumber: z.string().nullable(),
  scheduledStart: z.iso.datetime().nullable(),
  appointmentStatus: z.string().nullable(),
  visitType: z.string().nullable(),
  /** The immediate predecessor booking. Null for the first visit in a journey. */
  parentAppointmentId: uuid.nullable(),
  branchId: uuid,
  /** The branch's zone — the screen never renders a clinical time in its own. */
  timezone: z.string(),
  doctorProfileId: uuid.nullable(),
  doctorName: z.string().nullable(),
  encounter: encounterVisitSummary.nullable(),
});
export type VisitHistoryVisit = z.infer<typeof visitHistoryVisit>;

/** A journey and the visits along it, oldest first within the journey. */
export const visitHistoryEpisode = clinicalEpisodeSummary.extend({
  visits: z.array(visitHistoryVisit),
});
export type VisitHistoryEpisode = z.infer<typeof visitHistoryEpisode>;

/**
 * Every journey a patient has been on, newest first (§18).
 *
 * ⚠️ PAGINATED OVER THE EPISODES AND NOT OVER THE VISITS. A journey is the unit
 *   a clinician reads; splitting one across two pages would show half a course
 *   of treatment and call it a page. Episodes are few and visits within one are
 *   fewer, so the page bound is where it can be honoured.
 */
export const visitHistoryResponse = z.object({
  patientId: uuid,
  episodes: z.array(visitHistoryEpisode),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type VisitHistoryResponse = z.infer<typeof visitHistoryResponse>;

// ---------------------------------------------------------------------------
// The previous visit (§37)
// ---------------------------------------------------------------------------

/**
 * How the previous visit was found.
 *
 * ⚠️ IT TRAVELS ON THE RESPONSE BECAUSE THE THREE ARE NOT EQUALLY TRUE. "The
 *   visit this one was booked off" is a fact the database enforces; "the last
 *   consultation in the same journey" is a strong inference; "the last
 *   consultation anywhere" is a convenience. A screen that presented all three
 *   with the same words would tell a doctor that an unrelated visit from March
 *   is what this follow-up follows, which is a clinical claim the software has
 *   no basis for — the same trap `resolveEpisodeForBooking` refuses.
 */
export const previousVisitSource = z.enum(['PARENT_APPOINTMENT', 'SAME_EPISODE', 'MOST_RECENT']);
export type PreviousVisitSourceValue = z.infer<typeof previousVisitSource>;

/**
 * What the doctor sees when they open a follow-up (FOLLOW_UP_ARCHITECTURE §4).
 *
 * ⚠️ READ-ONLY, AND ENFORCED BY THE STORAGE MODEL RATHER THAN BY THE UI. There
 *   is no endpoint anywhere that writes a finalized consultation (CD-2), so a
 *   screen rendering this cannot make it editable by forgetting a `disabled`.
 *
 * ⚠️ THE WHOLE CONTENT, NOT A SUMMARY, AND THIS IS THE ONE PLACE THAT IS RIGHT.
 *   The panel exists so a doctor can see the dose they prescribed last time
 *   without leaving the consultation they are writing — counts would send them
 *   to another screen, which is the interruption the panel is for avoiding. It
 *   is ONE visit, so the payload is bounded.
 */
export const previousVisit = z.object({
  source: previousVisitSource,
  appointmentId: uuid.nullable(),
  appointmentNumber: z.string().nullable(),
  scheduledStart: z.iso.datetime().nullable(),
  branchId: uuid,
  timezone: z.string(),
  doctorProfileId: uuid,
  doctorName: z.string(),
  clinicalEpisodeId: uuid,
  episodeCode: z.string(),
  /** ⚠️ PHI. Usually absent. */
  episodeTitle: z.string().nullable(),
  encounter: encounterVisitSummary,
  /** ⚠️ PHI, in full. */
  clinicalNotes: z.string().nullable(),
  content: encounterContent,
});
export type PreviousVisit = z.infer<typeof previousVisit>;

/**
 * ⚠️ AN OBJECT WITH A NULLABLE FIELD RATHER THAN A NULLABLE BODY. A bare `null`
 *   response and a 204 are both indistinguishable from a failed parse on the
 *   web side; a key that is present and empty says "there was no previous
 *   visit", which is a different fact from "the call did not work".
 */
export const previousVisitResponse = z.object({
  previous: previousVisit.nullable(),
});
export type PreviousVisitResponse = z.infer<typeof previousVisitResponse>;

// ---------------------------------------------------------------------------
// Referral destinations (§37)
// ---------------------------------------------------------------------------

/**
 * A colleague this patient can be sent to.
 *
 * ⚠️ NAME AND SPECIALTY, AND DELIBERATELY NOTHING ELSE. This is not the doctor
 *   roster: no schedule, no contact details, no registration number, no fees,
 *   no employment status. A DOCTOR does not hold `doctor.directory.read` and
 *   that omission is a real access decision (see `roles.ts`) — what this shape
 *   discloses is what is needed to attach the right id to a referral, and the
 *   endpoint behind it refuses to enumerate.
 */
export const referralTarget = z.object({
  doctorProfileId: uuid,
  name: z.string(),
  /** The primary classification, for telling two colleagues of one name apart. */
  specialtyName: z.string().nullable(),
});
export type ReferralTarget = z.infer<typeof referralTarget>;

/**
 * ⚠️ `search` IS REQUIRED AND HAS A MINIMUM. There is no "list every doctor"
 *   form of this endpoint, which is the whole reason it can sit behind a
 *   clinical code rather than the directory one: a lookup answers "which of the
 *   colleagues I already know is this one", and an enumeration hands over a
 *   personnel list.
 */
export const referralTargetQuery = z.object({
  search: z.string().trim().min(2).max(120),
  pageSize: z.coerce.number().int().min(1).max(25).default(10),
});
export type ReferralTargetQuery = z.infer<typeof referralTargetQuery>;

export const referralTargetResponse = z.object({
  targets: z.array(referralTarget),
});
export type ReferralTargetResponse = z.infer<typeof referralTargetResponse>;
