/**
 * The section registry: what each section type IS, and therefore what a template
 * is allowed to say about it.
 *
 * ⚠️ THIS TABLE IS CODE AND THE TEMPLATE IS DATA, AND THAT LINE IS THE ENGINE.
 *   A template may not declare that Prescription is descriptor-driven, that
 *   Diagnosis draws on the symptom master, or that Chief Complaint appears
 *   twice. Those are properties of the COMPONENT, which is written, reviewed and
 *   tested here — the definition selects and parameterises components, and every
 *   claim it makes is checked against this table before anything renders.
 *
 * ── THE TWO KINDS OF SECTION ─────────────────────────────────────────────────
 *
 *   descriptorDriven  HISTORY and EXAMINATION. `FieldRenderer` builds them from
 *                     the template's own descriptors, and the answers land in
 *                     `encounter_sections.data`. A template MUST supply fields;
 *                     one with none renders an empty box a clinician cannot use.
 *
 *   first-class       Everything else. A purpose-built component over its own
 *                     table (CE-4). Configuration decides WHETHER it appears and
 *                     over WHAT vocabulary — never its shape. §11: a
 *                     prescription is not a generic dynamic form, and a template
 *                     that tried to give it fields would be describing a
 *                     component that does not read them.
 *
 * ⚠️ `defaultOrder` IS THE SCENARIO-3 CONSULTATION, IN THE ORDER A CLINICIAN
 *   WORKS. It is what an unordered section falls back to, and what the seeded
 *   GENERAL template ships as — complaint, then what the patient reports, then
 *   what is already known, then what is found, then what it means, then what is
 *   done about it, then what is asked for, then what the patient is told.
 */
import type { ClinicalVocabularyKind, ConsultationSectionType, TemplateSection } from './types.js';
import { CONSULTATION_SECTION_TYPES } from './types.js';

export interface SectionCapability {
  /** Built by `FieldRenderer` from template descriptors, not by a fixed component. */
  readonly descriptorDriven: boolean;
  /** May a template carry more than one section of this type? */
  readonly repeatable: boolean;
  /** The master a selector in this section searches. `null` = no vocabulary. */
  readonly vocabulary: ClinicalVocabularyKind | null;
  /** VISUAL_MAPPING alone: the section is meaningless without a map to draw. */
  readonly requiresMap: boolean;
  /** Where it sits when a template does not say. */
  readonly defaultOrder: number;
  /** The label a template gets if it does not supply one. */
  readonly defaultLabel: string;
}

const REGISTRY: Readonly<Record<ConsultationSectionType, SectionCapability>> = {
  CHIEF_COMPLAINT: {
    descriptorDriven: false,
    /*
     * ⚠️ NOT REPEATABLE, AND IT IS THE ONE COLUMN ON `encounters` ITSELF (CE-3).
     *   "What brought you in" has exactly one answer per visit; two would leave
     *   the record with no way to say which one the consultation was about.
     */
    repeatable: false,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 10,
    defaultLabel: 'Chief complaint',
  },
  SYMPTOMS: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: 'SYMPTOM',
    requiresMap: false,
    defaultOrder: 20,
    defaultLabel: 'Symptoms',
  },
  HISTORY: {
    descriptorDriven: true,
    /*
     * ⚠️ REPEATABLE, AND THAT IS WHY `key` EXISTS. Medical history, dental
     *   history, family history and drug history are four different sections of
     *   the same TYPE with four different sets of fields — which is precisely
     *   the per-specialty variation invariant 5 sends through templates.
     */
    repeatable: true,
    vocabulary: 'HISTORY_ITEM',
    requiresMap: false,
    defaultOrder: 30,
    defaultLabel: 'History',
  },
  EXAMINATION: {
    descriptorDriven: true,
    repeatable: true,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 40,
    defaultLabel: 'Examination',
  },
  VISUAL_MAPPING: {
    descriptorDriven: false,
    /*
     * ⚠️ REPEATABLE: an ENT consultation charts a left ear and a right ear, a
     *   dermatology one charts front and back. Each is its own map, and each
     *   needs its own key for the findings to hang off (CE-6).
     */
    repeatable: true,
    vocabulary: 'FINDING_TYPE',
    requiresMap: true,
    defaultOrder: 50,
    defaultLabel: 'Chart',
  },
  DIAGNOSIS: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: 'DIAGNOSIS',
    requiresMap: false,
    defaultOrder: 60,
    defaultLabel: 'Diagnosis',
  },
  PROCEDURE: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: 'PROCEDURE',
    requiresMap: false,
    defaultOrder: 70,
    defaultLabel: 'Procedures',
  },
  PRESCRIPTION: {
    descriptorDriven: false,
    repeatable: false,
    /*
     * ⚠️ `null`, AND NOT BECAUSE A PRESCRIPTION HAS NO VOCABULARY. It draws on
     *   the PRODUCT catalogue, not on `clinical_master_items` — a medicine is a
     *   stocked, batched, taxed thing (PI-ADR-001), not a clinical word. Its
     *   relevance ranking is `product_clinical_scopes`, which the resolver
     *   supplies from the same scope codes.
     */
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 80,
    defaultLabel: 'Prescription',
  },
  INVESTIGATION: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: 'INVESTIGATION',
    requiresMap: false,
    defaultOrder: 90,
    defaultLabel: 'Investigations',
  },
  ADVICE: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: 'ADVICE',
    requiresMap: false,
    defaultOrder: 100,
    defaultLabel: 'Advice',
  },
  REFERRAL: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 110,
    defaultLabel: 'Referral',
  },
  CLINICAL_NOTES: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 120,
    defaultLabel: 'Notes',
  },
  ATTACHMENTS: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 130,
    defaultLabel: 'Attachments',
  },
  FOLLOW_UP: {
    descriptorDriven: false,
    repeatable: false,
    vocabulary: null,
    requiresMap: false,
    defaultOrder: 140,
    defaultLabel: 'Follow-up',
  },
};

/** Is this string a section type the engine has a component for? */
export function isSectionType(value: unknown): value is ConsultationSectionType {
  return typeof value === 'string' && value in REGISTRY;
}

/**
 * What the engine can do with this section type.
 *
 * ⚠️ TOTAL OVER THE UNION, SO ADDING A MEMBER TO `ConsultationSectionType`
 *   WITHOUT ADDING ITS CAPABILITIES IS A TYPE ERROR RATHER THAN A BLANK SCREEN.
 *   That is the whole reason the table is a `Record` over the union and not a
 *   `Partial` with a lookup that falls back.
 */
export function capabilityOf(type: ConsultationSectionType): SectionCapability {
  return REGISTRY[type];
}

/** Every section type, in the order the default consultation renders them. */
export function sectionTypesInDefaultOrder(): readonly ConsultationSectionType[] {
  return [...CONSULTATION_SECTION_TYPES].sort(
    (a, b) => REGISTRY[a].defaultOrder - REGISTRY[b].defaultOrder
  );
}

/**
 * The sections that actually render, in the order they render in.
 *
 * ⚠️ INVISIBLE SECTIONS ARE DROPPED HERE AND NOWHERE ELSE. `visible: false` is
 *   how a clinic switches a section off without deleting it and losing its
 *   labels and descriptors — so the parser keeps it, and every consumer goes
 *   through this function rather than reading `definition.sections` directly.
 *
 * ⚠️ THE ORDER IS TOTAL: `order`, then `key`. Two sections sharing an order
 *   would otherwise render in whatever order the JSON parser happened to
 *   produce, which is stable until somebody edits an unrelated section.
 */
export function visibleSections(sections: readonly TemplateSection[]): readonly TemplateSection[] {
  return sections
    .filter((section) => section.visible)
    .slice()
    .sort((a, b) => (a.order === b.order ? a.key.localeCompare(b.key) : a.order - b.order));
}
