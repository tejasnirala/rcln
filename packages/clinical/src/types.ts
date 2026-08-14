/**
 * The vocabulary of the consultation engine's CONFIGURATION.
 *
 * ⚠️ EVERY TYPE IN THIS FILE IS A CLOSED SET, AND THAT IS THE WHOLE ARCHITECTURE
 *   (CD-6, ARCHITECTURE.md). Configuration decides whether a section appears,
 *   where, labelled how, over which vocabulary. It cannot invent a section the
 *   engine has no component for, and it cannot invent a field type the renderer
 *   cannot render. A template naming `ULTRASOUND_LOOP` is a REJECTED document,
 *   not a blank space on a clinician's screen.
 *
 *   This is deliberately not "JSON controls the frontend". The section type is
 *   an enum with exactly one hard-coded component per member; the definition
 *   selects and parameterises those components and does nothing else.
 *
 * ⚠️ AND NOTHING IN A DEFINITION IS A FOREIGN KEY (CD-6, ADR-0006). Sections
 *   name vocabulary SCOPES and visual maps by CODE — `DENTISTRY`,
 *   `HUMAN_DENTAL` — never by id. An id inside a JSONB document is invisible to
 *   every constraint, join and cascade in the database, and a template exported
 *   from one clinic and imported into another would carry ids that belong to
 *   somebody else.
 */

/**
 * The sections a consultation can be made of.
 *
 * Two kinds, and the difference decides what a template may say about one:
 *
 *   FIRST-CLASS      Diagnosis, Prescription, Investigation, Procedure,
 *                    Referral, Follow-up, Symptoms, Attachments. Purpose-built
 *                    components over their own tables. Configuration decides
 *                    WHETHER and OVER WHAT VOCABULARY, never their shape — §11
 *                    is explicit that a prescription is not a generic form.
 *
 *   DESCRIPTOR-DRIVEN History and Examination. Rendered by `FieldRenderer` from
 *                    the template's own descriptors into `encounter_sections`.
 */
export type ConsultationSectionType =
  | 'CHIEF_COMPLAINT'
  | 'SYMPTOMS'
  | 'HISTORY'
  | 'EXAMINATION'
  | 'VISUAL_MAPPING'
  | 'DIAGNOSIS'
  | 'PROCEDURE'
  | 'PRESCRIPTION'
  | 'INVESTIGATION'
  | 'ADVICE'
  | 'REFERRAL'
  | 'CLINICAL_NOTES'
  | 'ATTACHMENTS'
  | 'FOLLOW_UP';

export const CONSULTATION_SECTION_TYPES: readonly ConsultationSectionType[] = [
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
];

/** The clinical vocabulary a section draws on. Mirrors `ClinicalMasterKind`. */
export type ClinicalVocabularyKind =
  | 'SYMPTOM'
  | 'DIAGNOSIS'
  | 'PROCEDURE'
  | 'INVESTIGATION'
  | 'ADVICE'
  | 'HISTORY_ITEM'
  | 'FINDING_TYPE';

/**
 * What `FieldRenderer` can render, and therefore what a descriptor may claim to
 * be. A field type the renderer has no component for is a rejected descriptor.
 */
export type ConsultationFieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'RADIO_GROUP'
  | 'CHECKBOX_GROUP'
  | 'BOOLEAN'
  | 'DATE'
  | 'DATETIME'
  | 'MEASUREMENT'
  | 'SEARCH_SELECT'
  | 'CLINICAL_SELECTOR';

export const CONSULTATION_FIELD_TYPES: readonly ConsultationFieldType[] = [
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
];

/** One choice in a SELECT, MULTI_SELECT, RADIO_GROUP or CHECKBOX_GROUP. */
export interface FieldOption {
  /** Stored in `encounter_sections.data`. Stable; renaming one rewrites history. */
  readonly value: string;
  /** Shown to the clinician. */
  readonly label: string;
}

/**
 * A single field on a descriptor-driven section, after parsing.
 *
 * ⚠️ `required` IS NOT OPTIONAL HERE AND IS NOT OPTIONAL IN THE DOCUMENT. See
 *   `descriptors.ts` — this is the PI-5 lesson, and it is the reason this
 *   package exists at all.
 */
export interface FieldDescriptor {
  readonly key: string;
  readonly type: ConsultationFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly hint?: string;
  readonly placeholder?: string;
  /** SELECT · MULTI_SELECT · RADIO_GROUP · CHECKBOX_GROUP. Never empty. */
  readonly options?: readonly FieldOption[];
  /** MEASUREMENT. "mm", "kg", "mmHg" — a label, never a conversion factor. */
  readonly unit?: string;
  /** MEASUREMENT · NUMBER. Decimal places the input accepts. */
  readonly precision?: number;
  /** NUMBER · MEASUREMENT. Advisory bounds; the engine validates against them. */
  readonly min?: number;
  readonly max?: number;
  /** TEXT · TEXTAREA. */
  readonly maxLength?: number;
  /** CLINICAL_SELECTOR. Which master the selector searches. */
  readonly masterKind?: ClinicalVocabularyKind;
  /** SEARCH_SELECT. What the selector searches — a server surface, by name. */
  readonly source?: string;
}

/** A section of a resolved template, after parsing. */
export interface TemplateSection {
  readonly type: ConsultationSectionType;
  /**
   * Unique within the template, and the key `encounter_sections.section_key`
   * carries. ⚠️ Stable: renaming one orphans every answer already recorded
   * under the old key, in every finalized consultation.
   */
  readonly key: string;
  readonly label: string;
  readonly order: number;
  readonly visible: boolean;
  readonly required: boolean;
  /** Descriptor-driven sections only. Never empty when present. */
  readonly fields?: readonly FieldDescriptor[];
  /** Taxonomy node CODES that rank this section's vocabulary. Never ids. */
  readonly scopes?: readonly string[];
  /** VISUAL_MAPPING only. A `visual_maps.code` — resolved to a row in CE-6. */
  readonly mapCode?: string;
}

/**
 * A parsed `consultation_template_versions.definition`.
 *
 * `schemaVersion` is the DOCUMENT's shape, which is not the row's `version`
 * column: a clinic publishes v7 of its dentistry template, and every one of the
 * seven is a `schemaVersion: 1` document. Conflating them means the day the
 * document shape changes, every historical version reads as the new shape.
 */
export interface TemplateDefinition {
  readonly schemaVersion: 1;
  /**
   * Default vocabulary scopes for every section that does not name its own.
   * May be empty — a template that scopes nothing still works, because a scope
   * RANKS and never FILTERS (§34).
   */
  readonly scopes: readonly string[];
  /** In `order`, ascending, with ties broken by key. Never empty. */
  readonly sections: readonly TemplateSection[];
}

/**
 * A read that either produced a value or a sentence saying why it did not.
 *
 * ⚠️ THE SAME SHAPE AS `@rcln/regulatory`'s `Parsed`, ON PURPOSE. A malformed
 *   document returns a problem the caller must handle; there is no path here
 *   that returns a plausible default and lets a broken configuration reach a
 *   clinician.
 */
export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };
