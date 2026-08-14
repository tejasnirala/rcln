/**
 * The general consultation — Scenario 3, as a document.
 *
 * Complaint → what the patient reports → what is already known → what is found →
 * what it means → what is done about it → what is asked for → what the patient
 * is told → when they come back.
 *
 * ⚠️ THIS IS THE STARTING POINT FOR A NEW TEMPLATE, NOT THE PLATFORM'S SEEDED
 *   DEFAULT. The seeded `GENERAL_HUMAN` and `GENERAL_VET` templates live in
 *   `packages/db/prisma/seed/data/consultation-templates.ts` and are deliberately
 *   the same shape — a clinic that clones the general consultation and one that
 *   starts a new template should be looking at the same screen.
 *
 * ⚠️ AND IT IS A PLAIN DOCUMENT, PARSED LIKE ANY OTHER. It is not exempt from
 *   `parseTemplateDefinition`, which is what stops this file drifting out of the
 *   grammar the engine actually enforces — a default that no longer validates
 *   would otherwise fail at the moment a clinic creates its first template.
 *
 * ⚠️ NO SCOPES. A general consultation ranks nothing, because it applies
 *   wherever nothing more specific does. A scope RANKS and never FILTERS (§34),
 *   so an empty list costs nothing but the ordering of a picker.
 */
export const DEFAULT_CONSULTATION_DEFINITION = {
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
             required box is how the two disagree. */
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
       * ⚠️ REQUIRED, AND "no follow-up needed" IS A REAL ANSWER. The
       *   recommendation row records `is_required: false` (CE-1's schema comment
       *   says so) precisely so that a clinic can tell "the doctor decided
       *   against one" from "the doctor forgot" — which is only possible if the
       *   question is always asked.
       */
      required: true,
    },
  ],
} as const;
