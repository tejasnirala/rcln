/**
 * Consultation templates, their versions, and the configuration a consultation
 * screen is resolved to (CE-2).
 *
 * ⚠️ NO PHI IN THIS FILE. A template is configuration — it names no patient and
 *   no clinician, its labels are dictionary entries, and it is safe in a URL and
 *   in a log line. The consultation CONTENT lands in CE-3 and CE-4 and is
 *   nothing like this.
 *
 * ── WHY `definition` IS `z.unknown()` HERE AND VALIDATED ELSEWHERE ───────────
 *
 * ⚠️ THIS IS DELIBERATE AND IT IS NOT A GAP. The definition is a document with a
 *   closed grammar — section types the engine has a component for, field types
 *   the renderer can draw, and the PI-5 rule that a key which says nothing
 *   checkable is an ERROR rather than a permissive default (CD-10). That grammar
 *   lives in `@rcln/clinical`, is unit-tested there, and returns a SENTENCE
 *   naming the section and the key that is wrong.
 *
 *   Expressing it a second time in Zod would mean two grammars that have to be
 *   kept in step with each other, and the day they drift the API accepts a
 *   document the engine then refuses at render time — with a patient in the
 *   chair. So the contract checks that a definition is PRESENT and is an object;
 *   the engine decides whether it means anything, and the route turns its
 *   problem into a 400. Nothing else in the product reads the raw document.
 */
import { z } from 'zod';
import { uuid } from './common.js';

/**
 * ⚠️ A CODE, NOT A PATH — `DENTAL_GENERAL`, never `HUMAN-DEN-GENERAL`. The same
 *   rule the taxonomy and the clinical vocabulary follow: a path-encoded code
 *   becomes a lie the moment the node it names is re-parented.
 */
const templateCode = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'uppercase letters, digits and underscores');

export const consultationTemplateStatus = z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']);
export type ConsultationTemplateStatusValue = z.infer<typeof consultationTemplateStatus>;

/** Mirrors `ConsultationSectionType` in `@rcln/clinical`. A closed set. */
export const consultationSectionType = z.enum([
  'CHIEF_COMPLAINT',
  'SYMPTOMS',
  'HISTORY',
  'EXAMINATION',
  'VISUAL_MAPPING',
  'DIAGNOSIS',
  'PROCEDURE',
  'PRESCRIPTION',
  'INVESTIGATION',
  'ADVICE',
  'REFERRAL',
  'CLINICAL_NOTES',
  'ATTACHMENTS',
  'FOLLOW_UP',
]);
export type ConsultationSectionTypeValue = z.infer<typeof consultationSectionType>;

/** Mirrors `ConsultationFieldType` in `@rcln/clinical`. A closed set. */
export const consultationFieldType = z.enum([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'SELECT',
  'MULTI_SELECT',
  'RADIO_GROUP',
  'CHECKBOX_GROUP',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'MEASUREMENT',
  'SEARCH_SELECT',
  'CLINICAL_SELECTOR',
]);
export type ConsultationFieldTypeValue = z.infer<typeof consultationFieldType>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const consultationTemplateQuery = z.object({
  /** A `CARE_CONTEXT` taxonomy node. Absent lists every context. */
  careContextId: uuid.optional(),
  includeInactive: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ConsultationTemplateQuery = z.infer<typeof consultationTemplateQuery>;

export const createConsultationTemplateRequest = z.object({
  code: templateCode,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  /** The `CARE_CONTEXT` root this template belongs to (CD-3). */
  careContextId: uuid,
  /**
   * The node it is attached to, anywhere beneath that context.
   *
   * ⚠️ ABSENT IS THE CARE-CONTEXT DEFAULT, and it is the most important value
   *   this field takes — it is what a doctor with no classification resolves to.
   */
  specialtyId: uuid.optional(),
});
export type CreateConsultationTemplateRequest = z.infer<typeof createConsultationTemplateRequest>;

export const updateConsultationTemplateRequest = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateConsultationTemplateRequest = z.infer<typeof updateConsultationTemplateRequest>;

export const consultationTemplateVersionSummary = z.object({
  id: uuid,
  version: z.number().int(),
  status: consultationTemplateStatus,
  publishedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  /** How many sections the document declares, of which how many are visible. */
  sectionCount: z.number().int(),
  visibleSectionCount: z.number().int(),
});
export type ConsultationTemplateVersionSummary = z.infer<typeof consultationTemplateVersionSummary>;

export const consultationTemplate = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  careContextId: uuid,
  careContextName: z.string(),
  specialtyId: uuid.nullable(),
  /** Null when the template is the care-context default. */
  specialtyName: z.string().nullable(),
  isActive: z.boolean(),
  /** False for a platform template. The screen uses it to decide whether Edit is
   *  offered at all — the API refuses either way. */
  isOwn: z.boolean(),
  publishedVersion: consultationTemplateVersionSummary.nullable(),
  draftVersion: consultationTemplateVersionSummary.nullable(),
});
export type ConsultationTemplate = z.infer<typeof consultationTemplate>;

export const consultationTemplateListResponse = z.object({
  templates: z.array(consultationTemplate),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ConsultationTemplateListResponse = z.infer<typeof consultationTemplateListResponse>;

export const consultationTemplateDetail = consultationTemplate.extend({
  versions: z.array(consultationTemplateVersionSummary),
  /**
   * The document of the version named in the request, parsed. `unknown` for the
   * same reason `definition` is on the way in — the shape is `@rcln/clinical`'s
   * to state, and it has already stated it by the time this is built.
   */
  definition: z.unknown().nullable(),
});
export type ConsultationTemplateDetail = z.infer<typeof consultationTemplateDetail>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * ⚠️ `definition` IS REQUIRED AND MUST BE AN OBJECT — an absent one and an empty
 *   one are both refused, here and again in `@rcln/clinical`. Covering only the
 *   absent case is exactly the gap that let PI-5 ship a permissive typo.
 */
export const saveTemplateVersionRequest = z.object({
  definition: z.looseObject({}),
});
export type SaveTemplateVersionRequest = z.infer<typeof saveTemplateVersionRequest>;

// ---------------------------------------------------------------------------
// The resolved configuration — what a consultation screen is built from
// ---------------------------------------------------------------------------

export const consultationFieldConfig = z.object({
  key: z.string(),
  type: consultationFieldType,
  label: z.string(),
  required: z.boolean(),
  hint: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  unit: z.string().optional(),
  precision: z.number().int().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().optional(),
  masterKind: z.string().optional(),
  source: z.string().optional(),
});
export type ConsultationFieldConfig = z.infer<typeof consultationFieldConfig>;

export const consultationSectionConfig = z.object({
  type: consultationSectionType,
  key: z.string(),
  label: z.string(),
  order: z.number().int(),
  required: z.boolean(),
  /** Descriptor-driven sections only — HISTORY and EXAMINATION. */
  fields: z.array(consultationFieldConfig).optional(),
  /**
   * The taxonomy nodes this section's vocabulary is RANKED by, already resolved
   * from the definition's codes.
   *
   * ⚠️ RANKS, NEVER FILTERS (§11, §34). A term nobody tagged still appears in
   *   every selector; it just sorts lower. The screen must not present this as a
   *   restriction, because a clinician who reads it as one tags defensively and
   *   makes the vocabulary worse.
   */
  scopeIds: z.array(uuid),
  /** VISUAL_MAPPING only. The map is drawn in CE-6; this is its code. */
  mapCode: z.string().optional(),
});
export type ConsultationSectionConfig = z.infer<typeof consultationSectionConfig>;

/**
 * Everything a consultation screen needs, resolved on the server.
 *
 * ⚠️ THE BROWSER DECIDES NOTHING (§33). There is no specialty in `apps/web` and
 *   no `if` on one: this response says which sections exist, in what order,
 *   labelled how and over which vocabulary, and the engine renders exactly that.
 *   The day a component starts branching on a specialty, adding the next
 *   specialty costs a screen — which is the outcome this programme exists to
 *   avoid.
 */
export const consultationConfigResponse = z.object({
  appointmentId: uuid,
  patientId: uuid,
  clinicalEpisodeId: uuid,
  doctorProfileId: uuid,
  /** The `CARE_CONTEXT` root the consultation resolved within. */
  careContext: z.object({ id: uuid, code: z.string(), name: z.string() }),
  template: z.object({
    id: uuid,
    code: z.string(),
    name: z.string(),
    versionId: uuid,
    version: z.number().int(),
    /**
     * Which node the template was attached to, and how far down the path it
     * sits — 0 being the care-context default.
     *
     * ⚠️ RETURNED SO A CLINIC CAN SEE THE LEVEL IT CONFIGURED. "Using the
     *   general consultation" on a dentist's screen is how somebody notices that
     *   the dentistry template was never published.
     */
    matchedSpecialtyId: uuid.nullable(),
    matchedDepth: z.number().int(),
  }),
  sections: z.array(consultationSectionConfig),
});
export type ConsultationConfigResponse = z.infer<typeof consultationConfigResponse>;
