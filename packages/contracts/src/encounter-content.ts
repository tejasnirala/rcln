/**
 * The clinical content of a consultation (CE-4) — what was concluded,
 * prescribed, ordered, advised and asked for.
 *
 * ⚠️ EVERY FIELD IN THIS FILE IS PHI, and more densely than `encounters.ts` next
 *   door. A chief complaint is what the patient said; a diagnosis, a medicine
 *   and a referral are what the clinic CONCLUDED about a named person. None of
 *   it goes in a URL query, a cookie, `localStorage` or an audit payload — the
 *   ids do, and the content does not.
 *
 * ── WHY THESE ARE ROWS AND NOT SECTION `data` ────────────────────────────────
 *
 * ⚠️ EVERY ONE OF THESE IS A FIRST-CLASS SECTION, WHICH IS A STATEMENT ABOUT ITS
 *   STORAGE AND NOT ABOUT ITS IMPORTANCE. A prescription is dispensed against
 *   (PI-7), a procedure is consumed from stock (PI-9), a diagnosis is reported
 *   on. "What did we prescribe this year" has to be a query — and a `productId`
 *   inside a JSONB document is ADR-0006 exactly, invisible to every constraint,
 *   join and cascade in the database.
 *
 *   So the template decides WHETHER each section appears and over what
 *   vocabulary; it never decides their shape (§11). The shapes are here.
 *
 * ── WHY EACH COLLECTION IS ROW-AT-A-TIME AND NOT A WHOLE-LIST PUT ────────────
 *
 * ⚠️ REPLACING A LIST WOULD REISSUE ITS IDS, AND TWO THINGS DEPEND ON THEM.
 *   `encounter_procedures.diagnosis_id` is a real foreign key into a row in
 *   another list, and an amendment copies these rows and has to keep that link
 *   pointing at the right diagnosis. A `PUT` that deleted and re-inserted would
 *   break the link on every save — silently, because the FK would still be
 *   satisfied by whatever row landed in the same position.
 */
import { z } from 'zod';
import { calendarDate, uuid } from './common.js';
import { decimalString } from './products.js';
/*
 * ⚠️ `followUpIntervalUnit` AND `followUpType` COME FROM `clinical.ts` RATHER
 *   THAN BEING RESTATED HERE. CE-1 shipped the recommendation TABLE and its two
 *   enums with it; the UI that fills it is this phase. A second copy would
 *   export the same name twice from the package index — which is an error the
 *   compiler catches — and, worse, would let the two drift.
 */
import { followUpIntervalUnit, followUpType } from './clinical.js';
/*
 * ⚠️ ONE-WAY, AND `visual-mapping.ts` MAY NEVER IMPORT BACK. It restates
 *   `clinicalSeverity` as `findingSeverity` rather than importing this file for
 *   exactly that reason, and the two are asserted equal by a type-level check
 *   in `services/clinical/sections.ts`.
 */
import { clinicalFinding, findingRegionRef } from './visual-mapping.js';

// ---------------------------------------------------------------------------
// The enums, mirroring the Postgres types
// ---------------------------------------------------------------------------

/**
 * Mirrors `ClinicalDurationUnit`. Both ends of the range — see the enum.
 *
 * ⚠️ IT LIVES HERE RATHER THAN IN `encounters.ts`, WHICH ALSO USES IT, AND THE
 *   REASON IS LOAD ORDER. `encounters.ts` imports `encounterContent` from this
 *   file to put the content on `encounterDetail`; if this file imported back,
 *   whichever module evaluated second would read `undefined` and every request
 *   against the schema would fail at runtime. The dependency runs one way.
 */
export const clinicalDurationUnit = z.enum(['HOURS', 'DAYS', 'WEEKS', 'MONTHS', 'YEARS']);
export type ClinicalDurationUnitValue = z.infer<typeof clinicalDurationUnit>;

export const clinicalSeverity = z.enum(['MILD', 'MODERATE', 'SEVERE']);
export type ClinicalSeverityValue = z.infer<typeof clinicalSeverity>;

export const diagnosisRole = z.enum(['PRIMARY', 'SECONDARY', 'DIFFERENTIAL']);
export type DiagnosisRoleValue = z.infer<typeof diagnosisRole>;

export const diagnosisCertainty = z.enum(['CONFIRMED', 'PROVISIONAL', 'SUSPECTED', 'RULED_OUT']);
export type DiagnosisCertaintyValue = z.infer<typeof diagnosisCertainty>;

export const encounterProcedureStatus = z.enum(['PLANNED', 'PERFORMED', 'CANCELLED']);
export type EncounterProcedureStatusValue = z.infer<typeof encounterProcedureStatus>;

export const investigationPriority = z.enum(['ROUTINE', 'URGENT', 'STAT']);
export type InvestigationPriorityValue = z.infer<typeof investigationPriority>;

export const investigationStatus = z.enum(['ORDERED', 'COLLECTED', 'COMPLETED', 'CANCELLED']);
export type InvestigationStatusValue = z.infer<typeof investigationStatus>;

export const referralUrgency = z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']);
export type ReferralUrgencyValue = z.infer<typeof referralUrgency>;

export const medicationRoute = z.enum([
  'ORAL',
  'TOPICAL',
  'INTRAVENOUS',
  'INTRAMUSCULAR',
  'SUBCUTANEOUS',
  'INHALATION',
  'OPHTHALMIC',
  'OTIC',
  'NASAL',
  'RECTAL',
  'VAGINAL',
  'SUBLINGUAL',
  'TRANSDERMAL',
  'OTHER',
]);
export type MedicationRouteValue = z.infer<typeof medicationRoute>;

export const medicationFrequencyUnit = z.enum(['DAY', 'WEEK', 'MONTH']);
export type MedicationFrequencyUnitValue = z.infer<typeof medicationFrequencyUnit>;

export const medicationFoodRelation = z.enum(['BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD', 'ANY']);
export type MedicationFoodRelationValue = z.infer<typeof medicationFoodRelation>;

export const encounterAttachmentKind = z.enum([
  'PHOTO',
  'REPORT',
  'SCAN',
  'CONSENT',
  'LETTER',
  'OTHER',
]);
export type EncounterAttachmentKindValue = z.infer<typeof encounterAttachmentKind>;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * A clinical word, resolved for display.
 *
 * ⚠️ THE NAME IS SENT ALONGSIDE THE ID, and that is not redundancy. The screen
 *   renders a list of what the clinician recorded; without the name it would
 *   have to fetch each word individually, and a chart with fifteen rows would
 *   be fifteen round trips. The ID is what everything downstream reads.
 */
export const clinicalTermRef = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
});
export type ClinicalTermRef = z.infer<typeof clinicalTermRef>;

/**
 * Coded or typed, exactly one — the CHECK constraint, stated on the wire.
 *
 * ⚠️ THE REFINEMENT IS HERE AND NOT ONLY IN POSTGRES so the clinician gets a
 *   sentence rather than a 500. §6 wants a symptom the vocabulary has not
 *   learned yet to be recordable; allowing BOTH would let a typed label
 *   silently contradict the coded word beside it, and then every report
 *   grouping by `itemId` disagrees with the chart.
 */
const codedOrTypedShape = {
  itemId: uuid.optional(),
  customText: z.string().trim().min(1).max(255).optional(),
};

const codedOrTypedRule = (body: {
  itemId?: string | undefined;
  customText?: string | undefined;
}): boolean => (body.itemId === undefined) !== (body.customText === undefined);

const CODED_OR_TYPED_MESSAGE = {
  message: 'Give either a clinical term or your own words — not both and not neither',
};

/**
 * Where a row sits in its list. Optional on create — the service appends.
 *
 * ⚠️ NOT A SORT KEY THE CLIENT INVENTS FROM AN ARRAY INDEX. Reordering is an
 *   explicit act; a client that renumbered everything on every add would write
 *   the whole list back on each keystroke.
 */
const displayOrder = z.number().int().min(0).max(9999).optional();

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

export const createEncounterSymptomRequest = z
  .object({
    ...codedOrTypedShape,
    /** How long it has been going on. ⚠️ Both or neither — a CHECK says so. */
    durationValue: z.number().int().min(1).max(32767).nullish(),
    durationUnit: clinicalDurationUnit.nullish(),
    severity: clinicalSeverity.nullish(),
    /** "Intermittent", "on waking". Free text: an enum would refuse the answer. */
    frequency: z.string().trim().max(120).nullish(),
    /** ⚠️ Free text until CE-6, where a site becomes a `visual_regions` row. */
    site: z.string().trim().max(120).nullish(),
    notes: z.string().trim().max(4000).nullish(),
    displayOrder,
  })
  .refine(codedOrTypedRule, CODED_OR_TYPED_MESSAGE);
export type CreateEncounterSymptomRequest = z.infer<typeof createEncounterSymptomRequest>;

/**
 * ⚠️ THE UPDATE IS NOT THE CREATE MADE PARTIAL, AND THAT IS DELIBERATE THROUGH
 *   THIS WHOLE FILE. `itemId` and `customText` are not editable: swapping a
 *   coded diagnosis for a typed one on an existing row is a different clinical
 *   statement, and the honest way to make it is to remove the row and add the
 *   one you meant. What the update changes is everything ABOUT that statement.
 */
export const updateEncounterSymptomRequest = z.object({
  durationValue: z.number().int().min(1).max(32767).nullish(),
  durationUnit: clinicalDurationUnit.nullish(),
  severity: clinicalSeverity.nullish(),
  frequency: z.string().trim().max(120).nullish(),
  site: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
});
export type UpdateEncounterSymptomRequest = z.infer<typeof updateEncounterSymptomRequest>;

export const encounterSymptom = z.object({
  id: uuid,
  item: clinicalTermRef.nullable(),
  customText: z.string().nullable(),
  durationValue: z.number().int().nullable(),
  durationUnit: clinicalDurationUnit.nullable(),
  severity: clinicalSeverity.nullable(),
  frequency: z.string().nullable(),
  site: z.string().nullable(),
  notes: z.string().nullable(),
  displayOrder: z.number().int(),
});
export type EncounterSymptom = z.infer<typeof encounterSymptom>;

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

export const createEncounterDiagnosisRequest = z
  .object({
    ...codedOrTypedShape,
    /**
     * ⚠️ AT MOST ONE `PRIMARY` PER CONSULTATION, enforced by a partial unique
     *   index. Two primaries is two answers to "what was this visit about", and a
     *   second one comes back as a 409 rather than a 500.
     */
    role: diagnosisRole.optional(),
    certainty: diagnosisCertainty.optional(),
    notes: z.string().trim().max(4000).nullish(),
    displayOrder,
  })
  .refine(codedOrTypedRule, CODED_OR_TYPED_MESSAGE);
export type CreateEncounterDiagnosisRequest = z.infer<typeof createEncounterDiagnosisRequest>;

export const updateEncounterDiagnosisRequest = z.object({
  role: diagnosisRole.optional(),
  certainty: diagnosisCertainty.optional(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
});
export type UpdateEncounterDiagnosisRequest = z.infer<typeof updateEncounterDiagnosisRequest>;

export const encounterDiagnosis = z.object({
  id: uuid,
  item: clinicalTermRef.nullable(),
  customText: z.string().nullable(),
  role: diagnosisRole,
  certainty: diagnosisCertainty,
  notes: z.string().nullable(),
  displayOrder: z.number().int(),
});
export type EncounterDiagnosis = z.infer<typeof encounterDiagnosis>;

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/**
 * ⚠️ `itemId` IS REQUIRED HERE, UNLIKE ON A SYMPTOM OR A DIAGNOSIS. A procedure
 *   is billed, consumed from stock (PI-9) and reported on; a free-text one is a
 *   line nothing downstream can price or count. The clinic adds the word to its
 *   own vocabulary first, which is one click and is where it belongs.
 */
export const createEncounterProcedureRequest = z.object({
  itemId: uuid,
  /** What it treats. Optional — not every procedure answers a diagnosis. */
  diagnosisId: uuid.nullish(),
  /** Where on the chart it was done (CE-6). Most procedures are nowhere. */
  visualRegionId: uuid.nullish(),
  /** ⚠️ A DATE, not an instant: "when was this done" is a calendar question. */
  performedOn: calendarDate.nullish(),
  status: encounterProcedureStatus.optional(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
});
export type CreateEncounterProcedureRequest = z.infer<typeof createEncounterProcedureRequest>;

export const updateEncounterProcedureRequest = z.object({
  diagnosisId: uuid.nullish(),
  visualRegionId: uuid.nullish(),
  performedOn: calendarDate.nullish(),
  status: encounterProcedureStatus.optional(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
});
export type UpdateEncounterProcedureRequest = z.infer<typeof updateEncounterProcedureRequest>;

export const encounterProcedure = z.object({
  id: uuid,
  item: clinicalTermRef.nullable(),
  diagnosisId: uuid.nullable(),
  /**
   * WHERE it was done — the tooth, the quadrant, the scalp zone (CE-6).
   *
   * ⚠️ THE REGION AND NOT JUST ITS ID, because the procedure list renders "Root
   *   canal — 36" and a second lookup per row to turn an id into a tooth number
   *   is a query the chart already answered.
   */
  region: findingRegionRef.nullable(),
  performedOn: calendarDate.nullable(),
  status: encounterProcedureStatus,
  notes: z.string().nullable(),
  displayOrder: z.number().int(),
});
export type EncounterProcedure = z.infer<typeof encounterProcedure>;

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

/**
 * ⚠️ EVERY DOSING FIELD IS ITS OWN FIELD AND NOT A SENTENCE. "1 tablet twice
 *   daily after food for 5 days" typed as free text cannot be checked, cannot
 *   be dispensed against and cannot be totalled — and a pharmacist reading it
 *   is parsing English at the counter. `instructions` is for what the fields
 *   genuinely cannot say.
 *
 * ⚠️ AND EVERY PAIR TRAVELS TOGETHER, by CHECK constraint. "Twice per" nothing
 *   and "for 5" nothing are both prescriptions nobody can fill.
 */
const prescriptionFields = {
  /** A snapshot of what was written — a catalogue strength can be corrected. */
  strength: z.string().trim().max(64).nullish(),
  /** ⚠️ A string, not a number: half a tablet is `"0.5"` and must stay exact. */
  dose: decimalString.nullish(),
  doseUnit: z.string().trim().max(32).nullish(),
  route: medicationRoute.nullish(),
  frequency: z.number().int().min(1).max(99).nullish(),
  frequencyUnit: medicationFrequencyUnit.nullish(),
  durationValue: z.number().int().min(1).max(32767).nullish(),
  durationUnit: clinicalDurationUnit.nullish(),
  foodRelation: medicationFoodRelation.nullish(),
  timing: z.string().trim().max(120).nullish(),
  quantity: decimalString.nullish(),
  startDate: calendarDate.nullish(),
  endDate: calendarDate.nullish(),
  /** ⚠️ "As needed" — NOT the same as a NULL frequency. See the model. */
  isPrn: z.boolean().optional(),
  instructions: z.string().trim().max(4000).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
};

export const createEncounterPrescriptionRequest = z.object({
  productId: uuid,
  ...prescriptionFields,
});
export type CreateEncounterPrescriptionRequest = z.infer<typeof createEncounterPrescriptionRequest>;

/** ⚠️ `productId` IS NOT EDITABLE. A different medicine is a different line. */
export const updateEncounterPrescriptionRequest = z.object(prescriptionFields);
export type UpdateEncounterPrescriptionRequest = z.infer<typeof updateEncounterPrescriptionRequest>;

/** The medicine, resolved for display. Same argument as `clinicalTermRef`. */
export const prescribedProductRef = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
});
export type PrescribedProductRef = z.infer<typeof prescribedProductRef>;

export const encounterPrescription = z.object({
  id: uuid,
  product: prescribedProductRef.nullable(),
  strength: z.string().nullable(),
  dose: decimalString.nullable(),
  doseUnit: z.string().nullable(),
  route: medicationRoute.nullable(),
  frequency: z.number().int().nullable(),
  frequencyUnit: medicationFrequencyUnit.nullable(),
  durationValue: z.number().int().nullable(),
  durationUnit: clinicalDurationUnit.nullable(),
  foodRelation: medicationFoodRelation.nullable(),
  timing: z.string().nullable(),
  quantity: decimalString.nullable(),
  startDate: calendarDate.nullable(),
  endDate: calendarDate.nullable(),
  isPrn: z.boolean(),
  instructions: z.string().nullable(),
  notes: z.string().nullable(),
  displayOrder: z.number().int(),
});
export type EncounterPrescription = z.infer<typeof encounterPrescription>;

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

/**
 * ⚠️ NOT A LAB ORDER, BECAUSE THE LAB MODULE DOES NOT EXIST. This is the
 *   consultation's statement that something was asked for. `status` is what the
 *   clinic can observe from this side; when the lab ships it reports into this
 *   column rather than replacing it.
 */
export const createEncounterInvestigationRequest = z.object({
  itemId: uuid,
  reason: z.string().trim().max(4000).nullish(),
  priority: investigationPriority.optional(),
  instructions: z.string().trim().max(4000).nullish(),
  status: investigationStatus.optional(),
  displayOrder,
});
export type CreateEncounterInvestigationRequest = z.infer<
  typeof createEncounterInvestigationRequest
>;

export const updateEncounterInvestigationRequest = z.object({
  reason: z.string().trim().max(4000).nullish(),
  priority: investigationPriority.optional(),
  instructions: z.string().trim().max(4000).nullish(),
  status: investigationStatus.optional(),
  displayOrder,
});
export type UpdateEncounterInvestigationRequest = z.infer<
  typeof updateEncounterInvestigationRequest
>;

export const encounterInvestigation = z.object({
  id: uuid,
  item: clinicalTermRef.nullable(),
  reason: z.string().nullable(),
  priority: investigationPriority,
  instructions: z.string().nullable(),
  status: investigationStatus,
  displayOrder: z.number().int(),
});
export type EncounterInvestigation = z.infer<typeof encounterInvestigation>;

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

/**
 * ⚠️ `isEdited` IS SET BY THE SERVICE AND NOT BY THE CALLER, so it is absent
 *   here. It means "the clinician changed the library text before giving it",
 *   which is a fact the server can see — the row carries `customText` alongside
 *   the item it started from — and a client-supplied flag would be an assertion
 *   nothing checks.
 */
export const createEncounterAdviceRequest = z
  .object({ ...codedOrTypedShape, displayOrder })
  .refine(codedOrTypedRule, CODED_OR_TYPED_MESSAGE);
export type CreateEncounterAdviceRequest = z.infer<typeof createEncounterAdviceRequest>;

/**
 * Tailoring a piece of library advice.
 *
 * ⚠️ THIS IS THE ONE UPDATE IN THE FILE THAT TOUCHES THE TEXT, and it is why
 *   `isEdited` exists. "Brushing technique" becoming "brushing technique, and
 *   stop using the hard brush" is the ordinary case, and a clinic that could
 *   not see which of its standard advice reaches patients unchanged has a
 *   library nobody maintains.
 */
export const updateEncounterAdviceRequest = z.object({
  customText: z.string().trim().min(1).max(4000).optional(),
  displayOrder,
});
export type UpdateEncounterAdviceRequest = z.infer<typeof updateEncounterAdviceRequest>;

export const encounterAdvice = z.object({
  id: uuid,
  item: clinicalTermRef.nullable(),
  customText: z.string().nullable(),
  isEdited: z.boolean(),
  displayOrder: z.number().int(),
});
export type EncounterAdvice = z.infer<typeof encounterAdvice>;

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const referralDestination = {
  /** "See a cardiologist." A taxonomy node, which may be a platform row. */
  specialtyId: uuid.nullish(),
  /** A named colleague inside this organization. */
  doctorProfileId: uuid.nullish(),
  /** Somebody outside it, by name. */
  externalName: z.string().trim().max(255).nullish(),
  reason: z.string().trim().max(4000).nullish(),
  urgency: referralUrgency.optional(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
};

/**
 * ⚠️ AT LEAST ONE DESTINATION, AND A CHECK CONSTRAINT SAYS SO TOO. A referral
 *   naming none of the three is a referral to nobody — and it renders on the
 *   chart as an instruction the patient cannot act on.
 */
export const createEncounterReferralRequest = z
  .object(referralDestination)
  .refine(
    (body) => body.specialtyId != null || body.doctorProfileId != null || body.externalName != null,
    { message: 'Say who the patient is being referred to' }
  );
export type CreateEncounterReferralRequest = z.infer<typeof createEncounterReferralRequest>;

export const updateEncounterReferralRequest = z.object({
  reason: z.string().trim().max(4000).nullish(),
  urgency: referralUrgency.optional(),
  notes: z.string().trim().max(4000).nullish(),
  displayOrder,
});
export type UpdateEncounterReferralRequest = z.infer<typeof updateEncounterReferralRequest>;

export const encounterReferral = z.object({
  id: uuid,
  specialtyId: uuid.nullable(),
  specialtyName: z.string().nullable(),
  doctorProfileId: uuid.nullable(),
  doctorName: z.string().nullable(),
  externalName: z.string().nullable(),
  reason: z.string().nullable(),
  urgency: referralUrgency,
  notes: z.string().nullable(),
  displayOrder: z.number().int(),
});
export type EncounterReferral = z.infer<typeof encounterReferral>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Attach a file that has already been uploaded.
 *
 * ⚠️ THE BYTES DO NOT COME THROUGH THIS ENDPOINT, AND THAT SPLIT IS §27's. The
 *   upload goes to the documents surface, which owns storage providers,
 *   checksums and the `files` row; this says that an existing stored file
 *   belongs to this consultation and what it is clinically. A `storageKey` in
 *   this contract would put the storage layer inside the chart.
 */
export const createEncounterAttachmentRequest = z.object({
  storedFileId: uuid,
  kind: encounterAttachmentKind.optional(),
  /** ⚠️ PHI. "Pre-operative, upper left quadrant." */
  caption: z.string().trim().max(500).nullish(),
  displayOrder,
});
export type CreateEncounterAttachmentRequest = z.infer<typeof createEncounterAttachmentRequest>;

export const updateEncounterAttachmentRequest = z.object({
  kind: encounterAttachmentKind.optional(),
  caption: z.string().trim().max(500).nullish(),
  displayOrder,
});
export type UpdateEncounterAttachmentRequest = z.infer<typeof updateEncounterAttachmentRequest>;

export const encounterAttachment = z.object({
  id: uuid,
  storedFileId: uuid,
  kind: encounterAttachmentKind,
  caption: z.string().nullable(),
  /** From the `files` row, so the list renders without a second call. */
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  displayOrder: z.number().int(),
});
export type EncounterAttachment = z.infer<typeof encounterAttachment>;

// ---------------------------------------------------------------------------
// The follow-up recommendation (CD-13)
// ---------------------------------------------------------------------------

/**
 * "Come back after 15 days" — which is not a booking.
 *
 * ⚠️ ONE PER CONSULTATION, SO THIS IS A `PUT` AND NOT A `POST`. A doctor states
 *   a follow-up plan once; a second statement replaces the first rather than
 *   adding to it, and a screen that could produce two would leave the recall
 *   list with no way to say which one the clinic meant.
 *
 * ⚠️ `isRequired: false` IS A REAL ANSWER AND CARRIES NO INTERVAL. "No follow-up
 *   needed" is a clinical decision worth recording — a screen that only ever
 *   wrote a row when a follow-up WAS needed could not tell "the doctor decided
 *   against one" from "the doctor forgot".
 *
 * ⚠️ EXACTLY ONE OF THE INTERVAL PAIR OR `recommendedDate`, and a CHECK
 *   constraint says so as well. "In 15 days" and "on 4 September" are both
 *   legitimate; storing both invites them to disagree about which one the
 *   recall list believes.
 */
export const setFollowUpRecommendationRequest = z
  .object({
    isRequired: z.boolean(),
    intervalValue: z.number().int().min(1).max(365).nullish(),
    intervalUnit: followUpIntervalUnit.nullish(),
    /** ⚠️ A DATE, not an instant. Compared with `startOfCalendarDay`. */
    recommendedDate: calendarDate.nullish(),
    followUpType: followUpType.optional(),
    reason: z.string().trim().max(4000).nullish(),
    notes: z.string().trim().max(4000).nullish(),
  })
  .refine(
    (body) => {
      const hasInterval = body.intervalValue != null && body.intervalUnit != null;
      const hasDate = body.recommendedDate != null;
      /* Not required: no timing at all, which is the whole point of the flag. */
      if (!body.isRequired) return !hasInterval && !hasDate;
      return hasInterval !== hasDate;
    },
    {
      message:
        'Say either an interval or a date — not both. "No follow-up needed" carries neither.',
    }
  )
  .refine((body) => (body.intervalValue == null) === (body.intervalUnit == null), {
    message: 'An interval needs both a number and a unit',
  });
export type SetFollowUpRecommendationRequest = z.infer<typeof setFollowUpRecommendationRequest>;

/**
 * The doctor's plan, and what became of it.
 *
 * ⚠️ `fulfilledByAppointmentId` NULL IS THE INTERESTING STATE — it is the whole
 *   recall list. And fulfilment is optional in BOTH directions: a patient may
 *   book a follow-up nobody recommended, and a recommendation may never be
 *   fulfilled. Neither is an error.
 */
export const followUpRecommendation = z.object({
  id: uuid,
  encounterId: uuid,
  appointmentId: uuid,
  patientId: uuid,
  isRequired: z.boolean(),
  intervalValue: z.number().int().nullable(),
  intervalUnit: followUpIntervalUnit.nullable(),
  recommendedDate: calendarDate.nullable(),
  /**
   * When it actually falls due, computed from whichever half was given.
   *
   * ⚠️ COMPUTED BY THE SERVER AND NEVER STORED. Storing it would be a fourth
   *   copy of the same fact, drifting the moment either input is corrected —
   *   and the recall list is the only thing that reads it.
   */
  dueOn: calendarDate.nullable(),
  followUpType,
  reason: z.string().nullable(),
  notes: z.string().nullable(),
  fulfilledByAppointmentId: uuid.nullable(),
  fulfilledAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledReason: z.string().nullable(),
});
export type FollowUpRecommendation = z.infer<typeof followUpRecommendation>;

/** The patient declined, or the plan changed before they booked. */
export const cancelFollowUpRecommendationRequest = z.object({
  reason: z.string().trim().max(2000).optional(),
});
export type CancelFollowUpRecommendationRequest = z.infer<
  typeof cancelFollowUpRecommendationRequest
>;

/**
 * The recall list: who was told to come back and hasn't.
 *
 * ⚠️ ALWAYS PAGINATED AND ALWAYS FILTERED. An unbounded list of recommendations
 *   is a list of everybody in the clinic under ongoing treatment, which is a
 *   disclosure nobody has a reason to request in one call — the same rule
 *   `clinical-episodes` follows.
 */
/**
 * Which window of the recall list.
 *
 * `DUE` is outstanding and at or past its date; `UPCOMING` is outstanding and
 * still in the future; `OVERDUE` is `DUE` more than a week ago.
 *
 * ⚠️ THE WINDOW IS THE CLINIC'S CALENDAR DAY, NOT AN INSTANT. A recall due
 *   "today" is due all day in the branch's timezone.
 *
 * ⚠️ NAMED RATHER THAN INLINE BECAUSE THE SCREEN SWITCHES ON IT (CE-5). A second
 *   copy of these five strings on the web side is a list that drifts the day a
 *   sixth window is added, and the drift shows up as a tab that returns nothing.
 */
export const followUpRecallStatus = z.enum([
  'DUE',
  'UPCOMING',
  'OVERDUE',
  'FULFILLED',
  'CANCELLED',
]);
export type FollowUpRecallStatusValue = z.infer<typeof followUpRecallStatus>;

export const followUpRecommendationQuery = z.object({
  status: followUpRecallStatus.default('DUE'),
  patientId: uuid.optional(),
  branchId: uuid.optional(),
  /** How far ahead `UPCOMING` looks. Days. */
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type FollowUpRecommendationQuery = z.infer<typeof followUpRecommendationQuery>;

/**
 * One row of the recall list.
 *
 * ⚠️ IT CARRIES THE PATIENT'S NAME, WHICH THE RECOMMENDATION ITSELF DOES NOT.
 *   The desk is about to telephone somebody; a list of uuids is a list nobody
 *   can act on. That is exactly why the endpoint writes a `data_access_logs`
 *   row under `PATIENT_LIST` — reading it IS a disclosure.
 */
export const followUpRecallEntry = followUpRecommendation.extend({
  patientName: z.string(),
  patientPhone: z.string().nullable(),
  branchId: uuid,
  /** The visit the advice was given at, for the "book a follow-up" link. */
  sourceAppointmentId: uuid,
  /**
   * Who saw them, from the recommending appointment (CE-5).
   *
   * ⚠️ FOR THE DIARY THE BOOKING FORM SHOWS, NOT FOR WHAT IT SENDS. The API
   *   reads the doctor off the parent booking and refuses to be told one from
   *   the wire; the desk still has to be shown SOMEBODY'S free slots, and a
   *   follow-up is normally with whoever saw them. Sending the id here saves the
   *   recall screen a lookup per row.
   *
   * ⚠️ AND A CLINICIAN'S NAME IS NOT PHI. It rides on a response that is full of
   *   it, which is why this note exists: the patient name beside it is the
   *   disclosure, and this is staff.
   */
  doctorProfileId: uuid,
  doctorName: z.string(),
});
export type FollowUpRecallEntry = z.infer<typeof followUpRecallEntry>;

export const followUpRecallResponse = z.object({
  items: z.array(followUpRecallEntry),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type FollowUpRecallResponse = z.infer<typeof followUpRecallResponse>;

// ---------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------

/**
 * The clinical content of one consultation.
 *
 * ⚠️ RETURNED WHOLE ON EVERY CONTENT WRITE, and that is a deliberate trade. A
 *   response carrying only the row that changed would leave the browser
 *   reconciling nine lists by hand, and one of the writes — removing a
 *   diagnosis a procedure cites — legitimately changes a row in a DIFFERENT
 *   list. Sending the lot means the screen never has to know which.
 *
 *   It is not sent on the ENCOUNTER autosave, which stays as small as it was
 *   (see `encounterSaveResponse`): that one fires per keystroke.
 */
export const encounterContent = z.object({
  symptoms: z.array(encounterSymptom),
  diagnoses: z.array(encounterDiagnosis),
  procedures: z.array(encounterProcedure),
  prescriptions: z.array(encounterPrescription),
  investigations: z.array(encounterInvestigation),
  advice: z.array(encounterAdvice),
  referrals: z.array(encounterReferral),
  attachments: z.array(encounterAttachment),
  /**
   * What was found on a chart (CE-6). ⚠️ PHI.
   *
   * ⚠️ ONE FLAT LIST ACROSS EVERY VISUAL_MAPPING SECTION, NOT A LIST PER MAP.
   *   The section type is repeatable — a left ear and a right ear are two
   *   sections of one template — so each finding carries its own `sectionKey`
   *   and the screen filters. A nested shape would make the wire format depend
   *   on the template, which is the one thing a contract may not do.
   */
  findings: z.array(clinicalFinding),
  /** At most one. `null` means the doctor has not said either way yet. */
  followUp: followUpRecommendation.nullable(),
});
export type EncounterContent = z.infer<typeof encounterContent>;
