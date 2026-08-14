/**
 * DATA ONLY — the platform's default consultation templates.
 * `seedConsultationTemplates` writes them.
 *
 * ⚠️ ONE TEMPLATE PER CARE CONTEXT, AND NOT ONE PER SPECIALTY. This is the
 *   floor: what a doctor with no classification at all gets (Scenario 3), and
 *   what every specialty inherits until somebody configures the level they care
 *   about. The dentistry and hair-and-scalp templates that prove the engine is
 *   generic are CE-7's, and they are a clinic's configuration rather than the
 *   platform's — §41 is explicit that the seeded data stays deliberately small.
 *
 * ⚠️ AND THE VETERINARY ONE IS THE SAME DOCUMENT, DELIBERATELY. §42.7 forbids
 *   building veterinary functionality now; §4 asks only that the architecture
 *   stop assuming humans. A care context with no template at all would mean an
 *   animal patient resolves to nothing and a consultation cannot be opened —
 *   which is a broken product rather than an unbuilt feature.
 *
 * ⚠️ NO SCOPES ON EITHER. A general consultation ranks nothing, because it
 *   applies wherever nothing more specific does. A scope RANKS and never FILTERS
 *   (§34), so an empty list costs a picker's ordering and nothing else.
 *
 * ⚠️ AND NOTHING HERE IS AN ID (CD-6, ADR-0006). A definition names sections,
 *   labels, descriptors and CODES. `careContextCode` below is resolved to a row
 *   by the seeder — it is not part of the document.
 */

/** The general consultation, as a `schemaVersion: 1` document. */
const GENERAL_CONSULTATION = {
  schemaVersion: 1,
  scopes: [],
  sections: [
    {
      type: 'CHIEF_COMPLAINT',
      key: 'chief_complaint',
      label: 'Chief complaint',
      order: 10,
      visible: true,
      /* The one section a consultation cannot be finalized without: a record of
         what the visit was about. */
      required: true,
    },
    {
      type: 'SYMPTOMS',
      key: 'symptoms',
      label: 'Symptoms',
      order: 20,
      visible: true,
      required: false,
    },
    {
      type: 'HISTORY',
      key: 'history',
      label: 'History',
      order: 30,
      visible: true,
      required: false,
      fields: [
        {
          key: 'presenting_history',
          type: 'TEXTAREA',
          label: 'History of presenting complaint',
          required: false,
          maxLength: 4000,
        },
        {
          key: 'past_medical_history',
          type: 'TEXTAREA',
          label: 'Past medical history',
          required: false,
          maxLength: 4000,
        },
        {
          key: 'drug_history',
          type: 'TEXTAREA',
          label: 'Current medication',
          required: false,
          maxLength: 2000,
        },
        {
          key: 'allergies',
          type: 'TEXTAREA',
          label: 'Allergies',
          /* ⚠️ Stated explicitly, and false: the structured allergy record is
             `patients`, not a consultation field. Duplicating it here as a
             required box is how the two come to disagree. */
          required: false,
          hint: 'Recorded on the patient record; note anything new here.',
          maxLength: 1000,
        },
      ],
    },
    {
      type: 'EXAMINATION',
      key: 'examination',
      label: 'Examination',
      order: 40,
      visible: true,
      required: false,
      fields: [
        {
          key: 'general_examination',
          type: 'TEXTAREA',
          label: 'General examination',
          required: false,
          maxLength: 4000,
        },
        {
          key: 'systemic_examination',
          type: 'TEXTAREA',
          label: 'Systemic examination',
          required: false,
          maxLength: 4000,
        },
      ],
    },
    {
      type: 'DIAGNOSIS',
      key: 'diagnosis',
      label: 'Diagnosis',
      order: 60,
      visible: true,
      required: false,
    },
    {
      type: 'PROCEDURE',
      key: 'procedures',
      label: 'Procedures',
      order: 70,
      visible: true,
      required: false,
    },
    {
      type: 'PRESCRIPTION',
      key: 'prescription',
      label: 'Prescription',
      order: 80,
      visible: true,
      required: false,
    },
    {
      type: 'INVESTIGATION',
      key: 'investigations',
      label: 'Investigations',
      order: 90,
      visible: true,
      required: false,
    },
    {
      type: 'ADVICE',
      key: 'advice',
      label: 'Advice',
      order: 100,
      visible: true,
      required: false,
    },
    {
      type: 'CLINICAL_NOTES',
      key: 'notes',
      label: 'Notes',
      order: 120,
      visible: true,
      required: false,
    },
    {
      type: 'FOLLOW_UP',
      key: 'follow_up',
      label: 'Follow-up',
      order: 140,
      visible: true,
      /*
       * ⚠️ REQUIRED, AND "no follow-up needed" IS A REAL ANSWER.
       *   `encounter_follow_up_recommendations.is_required` exists so a clinic
       *   can tell "the doctor decided against one" from "the doctor forgot" —
       *   which is only possible if the question is always asked.
       */
      required: true,
    },
  ],
};

export interface ConsultationTemplateSeed {
  code: string;
  name: string;
  description: string;
  /** A `CARE_CONTEXT` node code from `data/specialties.ts`. Resolved by the seeder. */
  careContextCode: string;
  definition: unknown;
}

export const CONSULTATION_TEMPLATES: ConsultationTemplateSeed[] = [
  {
    code: 'GENERAL_HUMAN',
    name: 'General consultation',
    description:
      'The default consultation for human care. Applies wherever no more specific template is published.',
    careContextCode: 'HUMAN',
    definition: GENERAL_CONSULTATION,
  },
  {
    code: 'GENERAL_VET',
    name: 'General veterinary consultation',
    description:
      'The default consultation for veterinary care. Deliberately the same shape as the human one — no veterinary configuration has been researched (§42.7).',
    careContextCode: 'VET',
    definition: GENERAL_CONSULTATION,
  },
];
