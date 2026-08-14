/**
 * The consultation itself — opening one, autosaving it, signing it, correcting
 * it (CE-3).
 *
 * ⚠️ EVERYTHING IN THIS FILE IS PHI, WHICH IS THE OPPOSITE OF `consultation.ts`
 *   NEXT DOOR. A template is configuration and is safe in a log line; a chief
 *   complaint is a clinical statement about a named person. Nothing here goes in
 *   a URL query, a cookie, `localStorage` or an audit payload — the ids do, and
 *   the text does not.
 *
 * ── WHAT THIS CONTRACT DOES NOT DO ───────────────────────────────────────────
 *
 * ⚠️ IT DOES NOT VALIDATE SECTION `data` AGAINST THE TEMPLATE, AND THAT IS
 *   DELIBERATE. Which keys a section may carry, which are required and what a
 *   MEASUREMENT means are stated by the encounter's own frozen
 *   `template_snapshot` and checked by `@rcln/clinical` at finalization. Zod
 *   cannot see that document, and a second grammar here would be a grammar that
 *   drifts — the same reasoning `consultation.ts` gives for `definition` being
 *   `unknown` on the wire.
 *
 *   So the contract checks SHAPE (an object, keyed by section, of JSON values)
 *   and the engine checks MEANING. A draft is allowed to be incomplete; a
 *   finalized consultation is not.
 */
import { z } from 'zod';
import { uuid } from './common.js';
import { consultationSectionConfig, consultationSectionType } from './consultation.js';

export const encounterStatus = z.enum(['DRAFT', 'FINALIZED', 'AMENDED', 'CANCELLED']);
export type EncounterStatusValue = z.infer<typeof encounterStatus>;

/** Mirrors `ClinicalDurationUnit`. Both ends of the range — see the enum. */
export const clinicalDurationUnit = z.enum(['HOURS', 'DAYS', 'WEEKS', 'MONTHS', 'YEARS']);
export type ClinicalDurationUnitValue = z.infer<typeof clinicalDurationUnit>;

export const clinicalOnset = z.enum(['SUDDEN', 'GRADUAL', 'UNKNOWN']);
export type ClinicalOnsetValue = z.infer<typeof clinicalOnset>;

/**
 * One descriptor-driven section's answers.
 *
 * ⚠️ `z.unknown()` PER FIELD RATHER THAN A UNION OF PRIMITIVES. A CHECKBOX_GROUP
 *   answers with an array and a MEASUREMENT with a number-and-unit pair; the
 *   descriptor says which, and the descriptor is not visible from here. Narrowing
 *   it in Zod would refuse a legal answer for a field type added later, at the
 *   API, with a patient in the chair.
 */
export const encounterSectionData = z.record(z.string(), z.unknown());
export type EncounterSectionData = z.infer<typeof encounterSectionData>;

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open the consultation for a visit — or resume the one already open.
 *
 * ⚠️ IDEMPOTENT BY DESIGN, AND THE PARTIAL UNIQUE INDEX IS WHY IT CAN BE. A
 *   second call for the same appointment returns the SAME draft rather than
 *   opening a second record of one visit. Without that, a double-click, two tabs
 *   or a resumed session each produce a record, and which one the prescription
 *   hangs off is a race nobody can see afterwards.
 *
 * ⚠️ `appointmentId` IS OPTIONAL BECAUSE A WALK-IN HAS NO BOOKING (CD-1). Give
 *   the booking, or give the patient and the journey and the place — never
 *   neither, and never a booking alongside a contradicting patient.
 */
export const openEncounterRequest = z
  .object({
    appointmentId: uuid.optional(),
    /** Walk-in only: who is being seen. */
    patientId: uuid.optional(),
    /**
     * Walk-in only: the journey this consultation belongs to.
     *
     * ⚠️ REQUIRED RATHER THAN GUESSED. Attaching a walk-in to the patient's most
     *   recent open episode would be a clinical claim the software has no basis
     *   for — the same call `appointments.clinical_episode_id` makes.
     */
    clinicalEpisodeId: uuid.optional(),
    /** Walk-in only. Required when the caller's scope covers several branches. */
    branchId: uuid.optional(),
    /** Walk-in only. Defaults to the acting user's own doctor profile. */
    doctorProfileId: uuid.optional(),
  })
  .refine((body) => (body.appointmentId === undefined) !== (body.patientId === undefined), {
    message: 'Give either an appointment, or a patient for a walk-in — not both and not neither',
  })
  .refine((body) => body.patientId === undefined || body.clinicalEpisodeId !== undefined, {
    message: 'A walk-in consultation needs the treatment journey it belongs to',
  });
export type OpenEncounterRequest = z.infer<typeof openEncounterRequest>;

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/**
 * A debounced partial save of a DRAFT (CD-8).
 *
 * ⚠️ EVERY FIELD IS OPTIONAL AND `null` MEANS "CLEAR IT". A doctor who deletes
 *   the chief complaint they typed must be able to; `undefined` (absent) is
 *   "leave it alone" and is what a section-only save sends. Conflating the two
 *   would mean a save could never remove anything.
 *
 * ⚠️ IT RETURNS THE SAVED REVISION AND NOTHING ELSE, and the Server Action that
 *   calls it MUST NOT `revalidatePath` — revalidating per keystroke re-renders
 *   the consultation from the server and fights the cursor (ARCHITECTURE.md).
 */
export const saveEncounterDraftRequest = z
  .object({
    chiefComplaint: z.string().trim().max(2000).nullable().optional(),
    chiefComplaintDurationValue: z.number().int().min(1).max(32767).nullable().optional(),
    chiefComplaintDurationUnit: clinicalDurationUnit.nullable().optional(),
    onset: clinicalOnset.nullable().optional(),
    clinicalNotes: z.string().trim().max(20000).nullable().optional(),
    /**
     * The descriptor-driven sections that changed. Upserted by `key`; a section
     * absent from the list is left exactly as it was.
     */
    sections: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(64),
          data: encounterSectionData,
        })
      )
      .max(50)
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to save' });
export type SaveEncounterDraftRequest = z.infer<typeof saveEncounterDraftRequest>;

// ---------------------------------------------------------------------------
// Finalizing, amending, cancelling
// ---------------------------------------------------------------------------

/**
 * Sign the record.
 *
 * ⚠️ NO BODY, AND NOTHING TO OVERRIDE. Finalization validates every section
 *   against the encounter's own snapshot descriptors and refuses if a required
 *   answer is missing; a `force` flag would make that check advisory, which is
 *   the same as not having it.
 */
export const finalizeEncounterRequest = z.object({});
export type FinalizeEncounterRequest = z.infer<typeof finalizeEncounterRequest>;

/**
 * Correct a finalized record by starting a new one that cites it (CD-2).
 *
 * ⚠️ THE REASON IS REQUIRED. "The record changed and nobody said why" is exactly
 *   the failure an amendment trail exists to prevent.
 */
export const amendEncounterRequest = z.object({
  reason: z.string().trim().min(3).max(2000),
});
export type AmendEncounterRequest = z.infer<typeof amendEncounterRequest>;

export const cancelEncounterRequest = z.object({
  reason: z.string().trim().max(2000).optional(),
});
export type CancelEncounterRequest = z.infer<typeof cancelEncounterRequest>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const encounterSection = z.object({
  sectionType: consultationSectionType,
  key: z.string(),
  data: encounterSectionData,
  displayOrder: z.number().int(),
});
export type EncounterSection = z.infer<typeof encounterSection>;

/**
 * A whole consultation, and the form it was conducted on.
 *
 * ⚠️ `sections` IS THE FROZEN SNAPSHOT'S, NOT THE LIVE TEMPLATE'S (§29). A
 *   consultation finalized in 2026 renders through the 2026 configuration for
 *   ever, whatever the clinic did to its template since. The two lists pair up:
 *   `configuration` says what the form was, `answers` says what was written in
 *   it, and a key in one and not the other is a template that was edited under a
 *   record — which is precisely what the snapshot prevents.
 */
export const encounterDetail = z.object({
  id: uuid,
  status: encounterStatus,
  /** Null until finalization — the counter is not burnt by an abandoned draft. */
  encounterNumber: z.string().nullable(),
  branchId: uuid,
  patientId: uuid,
  appointmentId: uuid.nullable(),
  clinicalEpisodeId: uuid,
  doctorProfileId: uuid,
  templateId: uuid,
  templateVersionId: uuid,

  chiefComplaint: z.string().nullable(),
  chiefComplaintDurationValue: z.number().int().nullable(),
  chiefComplaintDurationUnit: clinicalDurationUnit.nullable(),
  onset: clinicalOnset.nullable(),
  clinicalNotes: z.string().nullable(),

  startedAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().nullable(),
  /** The record this one corrects, and the record that corrected this one. */
  amendsEncounterId: uuid.nullable(),
  amendedAt: z.iso.datetime().nullable(),
  amendmentReason: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledReason: z.string().nullable(),

  /** The form, from the snapshot. Same shape the resolver returns at CE-2. */
  configuration: z.array(consultationSectionConfig),
  answers: z.array(encounterSection),
});
export type EncounterDetail = z.infer<typeof encounterDetail>;

/**
 * What an autosave answers with.
 *
 * ⚠️ THE SAVED REVISION AND NOTHING ELSE. Returning the whole encounter would
 *   invite the browser to re-render from it on every keystroke, which is the
 *   cursor bug the Server Action is written to avoid.
 */
export const encounterSaveResponse = z.object({
  id: uuid,
  status: encounterStatus,
  savedAt: z.iso.datetime(),
});
export type EncounterSaveResponse = z.infer<typeof encounterSaveResponse>;
