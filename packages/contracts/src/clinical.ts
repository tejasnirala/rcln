/**
 * The clinical vocabulary, and the treatment journey.
 *
 * ⚠️ TWO DIFFERENT KINDS OF THING LIVE HERE AND ONLY ONE OF THEM IS PHI.
 *   A clinical master item is a DICTIONARY ENTRY — "Dental caries" discloses
 *   nothing about anybody. A clinical episode is a treatment journey belonging
 *   to a named person, and its title is usually a diagnosis by another name.
 *   The first is cacheable and searchable; the second is PHI, is read behind a
 *   `data_access_logs` row, and never appears in a URL or a log line.
 *
 * See .kb/Consultation/ for the programme, and DECISIONS.md CD-5 and CD-13 for
 * why the vocabulary is one table and why an episode is not a chain.
 */
import { z } from 'zod';
import { calendarDate, uuid } from './common.js';

/**
 * What kind of clinical word this is (CD-5).
 *
 * ⚠️ ONE VOCABULARY TABLE WITH A DISCRIMINATOR, NOT SEVEN TABLES. The house
 *   pattern — `products` is one table over twelve `ProductType`s. Seven
 *   near-identical masters would mean seven search endpoints and seven RLS
 *   policies that have to be kept in step with each other.
 */
export const clinicalMasterKind = z.enum([
  'SYMPTOM',
  'DIAGNOSIS',
  'PROCEDURE',
  'INVESTIGATION',
  'ADVICE',
  'HISTORY_ITEM',
  /** Observed AT an anatomical region (CE-6). "Caries" — what you see on tooth
   *  36, as opposed to the DIAGNOSIS, which is what it means. */
  'FINDING_TYPE',
]);
export type ClinicalMasterKindValue = z.infer<typeof clinicalMasterKind>;

export const clinicalEpisodeStatus = z.enum(['OPEN', 'CLOSED']);
export type ClinicalEpisodeStatusValue = z.infer<typeof clinicalEpisodeStatus>;

export const careSubjectType = z.enum(['HUMAN', 'ANIMAL']);
export type CareSubjectTypeValue = z.infer<typeof careSubjectType>;

export const followUpIntervalUnit = z.enum(['DAYS', 'WEEKS', 'MONTHS']);
export type FollowUpIntervalUnitValue = z.infer<typeof followUpIntervalUnit>;

export const followUpType = z.enum([
  'ROUTINE',
  'PROCEDURE_REVIEW',
  'LAB_REVIEW',
  'POST_OPERATIVE',
  'OTHER',
]);
export type FollowUpTypeValue = z.infer<typeof followUpType>;

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Search the clinical vocabulary.
 *
 * ⚠️ SERVER-SIDE, PAGINATED, AND NEVER "GIVE ME EVERY DIAGNOSIS" (§39). A
 *   clinical selector on a busy screen is typed into constantly; shipping the
 *   whole master to the browser is a megabyte per screen and gets worse as the
 *   PLATFORM grows, because the platform catalogue is shared.
 *
 * ⚠️ `specialtyId` RANKS. IT DOES NOT FILTER. §11 and §34 are explicit: a
 *   medicine or a diagnosis relevant to several specialties must not be hidden
 *   from a doctor because nobody tagged it. Scoped matches sort first and
 *   unscoped matches still come back — a hard filter would mean that the day a
 *   clinic adds a diagnosis and forgets to tag it, that diagnosis becomes
 *   invisible with no error and no way to notice.
 */
export const clinicalMasterQuery = z.object({
  kind: clinicalMasterKind,
  /** Trigram-matched against `lower(name)`. Absent lists by display order. */
  search: z.string().trim().min(1).max(120).optional(),
  /** A taxonomy node. Ranks, never filters — see above. */
  specialtyId: uuid.optional(),
  parentId: uuid.optional(),
  includeInactive: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClinicalMasterQuery = z.infer<typeof clinicalMasterQuery>;

export const clinicalMasterCoding = z.object({
  /** `ICD10`, `SNOMEDCT`, `LOINC`, or a clinic's own label. A string and not an
   *  enum: the accepted list is per-market and grows with every country. */
  system: z.string().trim().min(1).max(32),
  code: z.string().trim().min(1).max(64),
  display: z.string().max(512).nullable(),
  isPrimary: z.boolean(),
});

export const clinicalMasterItem = z.object({
  id: uuid,
  kind: clinicalMasterKind,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: uuid.nullable(),
  displayOrder: z.number().int(),
  isActive: z.boolean(),
  /** False for a platform row. The screen uses it to decide whether Edit is
   *  offered at all — the API refuses either way. */
  isOwn: z.boolean(),
  codings: z.array(clinicalMasterCoding),
});
export type ClinicalMasterItem = z.infer<typeof clinicalMasterItem>;

export const clinicalMasterListResponse = z.object({
  items: z.array(clinicalMasterItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ClinicalMasterListResponse = z.infer<typeof clinicalMasterListResponse>;

/**
 * ⚠️ CODE IS `/^[A-Z0-9_]+$/` AND FLAT, never a path. The taxonomy learned this:
 *   a path-encoded code becomes a lie the moment a node is re-parented, and the
 *   path already has a home in `parentId`.
 */
export const createClinicalMasterRequest = z.object({
  kind: clinicalMasterKind,
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'letters, digits and underscores only'),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  parentId: uuid.optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  codings: z
    .array(
      z.object({
        system: z.string().trim().min(1).max(32),
        code: z.string().trim().min(1).max(64),
        display: z.string().max(512).optional(),
        isPrimary: z.boolean().default(false),
      })
    )
    .max(10)
    .optional(),
  /** Taxonomy nodes this word is relevant to. Ranking only. */
  specialtyIds: z.array(uuid).max(20).optional(),
});
export type CreateClinicalMasterRequest = z.infer<typeof createClinicalMasterRequest>;

export const updateClinicalMasterRequest = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  specialtyIds: z.array(uuid).max(20).optional(),
});
export type UpdateClinicalMasterRequest = z.infer<typeof updateClinicalMasterRequest>;

// ---------------------------------------------------------------------------
// The treatment journey
// ---------------------------------------------------------------------------

/**
 * One continuous treatment journey (CD-13).
 *
 * ⚠️ PHI. `title` and `notes` are clinical statements about a named person, so
 *   this shape is only ever returned from an endpoint that writes a
 *   `data_access_logs` row under `CLINICAL_EPISODE`.
 *
 * ⚠️ A DIFFERENT ANSWER FROM THE APPOINTMENT CHAIN, AND BOTH ARE NEEDED:
 *     appointments.parentAppointmentId   A -> B -> C   the immediate predecessor
 *     clinicalEpisodeId                  A, B, C       the whole journey
 */
export const clinicalEpisodeSummary = z.object({
  id: uuid,
  code: z.string(),
  /** ⚠️ PHI. Usually absent — nobody knows what a journey is about at booking. */
  title: z.string().nullable(),
  status: clinicalEpisodeStatus,
  patientId: uuid,
  primarySpecialtyId: uuid.nullable(),
  primarySpecialtyName: z.string().nullable(),
  /** A calendar date in the branch's zone, `YYYY-MM-DD`. Never an instant. */
  openedOn: z.string(),
  closedOn: z.string().nullable(),
  /** How many bookings hang off it. The timeline's headline number. */
  appointmentCount: z.number().int(),
});
export type ClinicalEpisodeSummary = z.infer<typeof clinicalEpisodeSummary>;

/**
 * The journey with its visits — the timeline (§18, §19).
 *
 * Appointments in scheduled order, each carrying the parent link so the screen
 * can draw the chain WITHIN the journey without a second request.
 */
export const clinicalEpisodeDetail = clinicalEpisodeSummary.extend({
  /** ⚠️ PHI. */
  notes: z.string().nullable(),
  closureReason: z.string().nullable(),
  appointments: z.array(
    z.object({
      id: uuid,
      appointmentNumber: z.string(),
      scheduledStart: z.iso.datetime(),
      status: z.string(),
      visitType: z.string(),
      doctorProfileId: uuid,
      doctorName: z.string(),
      /** The immediate predecessor. Null for the first visit in the journey. */
      parentAppointmentId: uuid.nullable(),
    })
  ),
});
export type ClinicalEpisodeDetail = z.infer<typeof clinicalEpisodeDetail>;

export const clinicalEpisodeQuery = z.object({
  patientId: uuid,
  status: clinicalEpisodeStatus.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClinicalEpisodeQuery = z.infer<typeof clinicalEpisodeQuery>;

export const clinicalEpisodeListResponse = z.object({
  episodes: z.array(clinicalEpisodeSummary),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ClinicalEpisodeListResponse = z.infer<typeof clinicalEpisodeListResponse>;

export const createClinicalEpisodeRequest = z.object({
  patientId: uuid,
  /** Whose timezone decides the calendar day this opened on. */
  branchId: uuid,
  /** ⚠️ PHI. Optional, and usually absent at open time. */
  title: z.string().trim().max(255).optional(),
  primarySpecialtyId: uuid.optional(),
});
export type CreateClinicalEpisodeRequest = z.infer<typeof createClinicalEpisodeRequest>;

/**
 * Retitle, close or reopen.
 *
 * ⚠️ CLOSING IS NOT DELETING, AND REOPENING IS LEGITIMATE. A journey a clinic
 *   thought was finished and that resumes six months later is the same journey;
 *   forcing a new one would split the history exactly where a clinician most
 *   wants it continuous.
 */
export const updateClinicalEpisodeRequest = z
  .object({
    /** ⚠️ PHI. */
    title: z.string().trim().max(255).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    primarySpecialtyId: uuid.nullable().optional(),
    status: clinicalEpisodeStatus.optional(),
    /** ⚠️ PHI. Required when closing; meaningless otherwise. */
    closureReason: z.string().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'OPEN' && v.closureReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['closureReason'],
        message: 'only applies when closing an episode',
      });
    }
  });
export type UpdateClinicalEpisodeRequest = z.infer<typeof updateClinicalEpisodeRequest>;

/**
 * Every journey a patient has been on — the visit history (§18).
 *
 * ⚠️ NEWEST FIRST, and deliberately NOT nested under the current consultation.
 *   Visit history belongs to the PATIENT, not to the encounter that happens to
 *   be reading it: `Patient -> Care Episode -> Appointments -> Consultations`.
 */
export const visitHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});
export type VisitHistoryQuery = z.infer<typeof visitHistoryQuery>;

export { calendarDate };
