/**
 * DATA ONLY — the platform's default consultation templates.
 * `seedConsultationTemplates` writes them.
 *
 * ⚠️ ONE GENERAL TEMPLATE PER CARE CONTEXT, PLUS TWO REFERENCE CONFIGURATIONS.
 *   The general ones are the floor: what a doctor with no classification at all
 *   gets (Scenario 3), and what every specialty inherits until somebody
 *   configures the level they care about. The two below them — Dentistry and
 *   Hair & Scalp — are CE-7's, and they exist to prove one thing: that a
 *   specialty consultation is a DOCUMENT. Neither cost a component, a route, a
 *   column or an `if` anywhere in `apps/web`.
 *
 * ⚠️ AND FOUR IS THE CEILING, NOT A RUNNING START (§41). The seeded data stays
 *   deliberately small. A fifth specialty is a clinic's own template, written
 *   through `/consultation-templates` by somebody who practises it — the
 *   platform shipping a half-researched cardiology default is worse than
 *   shipping none, because a clinic will trust it.
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

// ── Dentistry ────────────────────────────────────────────────────────────────
//
//   ⚠️ EVERYTHING THAT MAKES THIS A DENTAL CONSULTATION IS IN THIS OBJECT. The
//     odontogram is a `mapCode`; the dental history is four descriptors; the
//     ranking of the pickers is one scope code. There is no dental component,
//     no dental route, no dental column and no `if (specialty === 'DEN')`
//     anywhere (§33) — which is the claim CE-7 exists to make good on.

const DENTAL_CONSULTATION = {
  schemaVersion: 1,
  /* Ranks the pickers toward the dental vocabulary. It never filters (§34) — a
     dentist recording "Diabetes mellitus" finds it, one line lower. */
  scopes: ['DEN'],
  sections: [
    {
      type: 'CHIEF_COMPLAINT',
      key: 'chief_complaint',
      label: 'Chief complaint',
      order: 10,
      visible: true,
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
      key: 'dental_history',
      label: 'History',
      order: 30,
      visible: true,
      required: false,
      fields: [
        {
          key: 'dental_history',
          type: 'TEXTAREA',
          label: 'Dental history',
          required: false,
          hint: 'Previous treatment, extractions, appliances.',
          maxLength: 4000,
        },
        {
          key: 'medical_history',
          type: 'TEXTAREA',
          label: 'Relevant medical history',
          /* ⚠️ Not required, and named "relevant": the structured record is
             `patients` and the history master. Asking for it twice is how the
             two come to disagree. */
          required: false,
          maxLength: 4000,
        },
        {
          key: 'habits',
          type: 'CHECKBOX_GROUP',
          label: 'Habits',
          required: false,
          options: [
            { value: 'SMOKING', label: 'Smoking' },
            { value: 'TOBACCO_CHEWING', label: 'Tobacco chewing' },
            { value: 'BETEL_NUT', label: 'Betel nut / areca' },
            { value: 'BRUXISM', label: 'Bruxism' },
          ],
        },
      ],
    },
    {
      type: 'EXAMINATION',
      key: 'oral_examination',
      label: 'Examination',
      order: 40,
      visible: true,
      required: false,
      fields: [
        {
          key: 'oral_hygiene',
          type: 'SELECT',
          label: 'Oral hygiene',
          required: false,
          options: [
            { value: 'GOOD', label: 'Good' },
            { value: 'FAIR', label: 'Fair' },
            { value: 'POOR', label: 'Poor' },
          ],
        },
        {
          key: 'extra_oral',
          type: 'TEXTAREA',
          label: 'Extra-oral',
          required: false,
          maxLength: 2000,
        },
        {
          key: 'intra_oral',
          type: 'TEXTAREA',
          label: 'Intra-oral (soft tissues)',
          required: false,
          maxLength: 4000,
        },
      ],
    },
    {
      /*
       * ⚠️ THE SECTION THIS PHASE IS FOR, AND IT NAMES A CODE (CD-6). The
       *   server turns `HUMAN_DENTAL` into 36 regions with geometry; the
       *   browser is handed a picture and decides nothing.
       *
       * ⚠️ AND IT IS `required: false`, DELIBERATELY. A required chart refuses
       *   finalization when nothing is marked on it — and a mouth with nothing
       *   wrong with it is a real consultation, common at a check-up. A clinic
       *   that wants the chart compulsory sets it on its own template; the
       *   platform will not refuse to sign a healthy patient's record.
       */
      type: 'VISUAL_MAPPING',
      key: 'odontogram',
      label: 'Odontogram',
      order: 50,
      visible: true,
      required: false,
      mapCode: 'HUMAN_DENTAL',
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
      label: 'Treatment',
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
      required: true,
    },
  ],
};

// ── Hair & Scalp ─────────────────────────────────────────────────────────────
//
//   ⚠️ THE SAME DOCUMENT SHAPE, A DIFFERENT PICTURE AND DIFFERENT WORDS. Set
//     this beside the dentistry template: they differ in a `mapCode`, a scope
//     list, some labels and a handful of descriptors. That is the whole of what
//     "supports a new specialty" costs, and it is the measurement CE-7 was
//     asked for.

const HAIR_SCALP_CONSULTATION = {
  schemaVersion: 1,
  /*
   * ⚠️ DERMATOLOGY FIRST, THEN TRICHOLOGY, AND THE ORDER IS LOAD-BEARING. The
   *   pickers take the FIRST scope id, and the seeded hair vocabulary is
   *   scoped to Dermatology — the department the words belong to. Trichology
   *   is named too so a clinic's own trichology terms rank as well.
   */
  scopes: ['DERMATOLOGY', 'TRICHOLOGY'],
  sections: [
    {
      type: 'CHIEF_COMPLAINT',
      key: 'chief_complaint',
      label: 'Chief complaint',
      order: 10,
      visible: true,
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
      key: 'hair_history',
      label: 'History',
      order: 30,
      visible: true,
      required: false,
      fields: [
        {
          key: 'onset_and_course',
          type: 'TEXTAREA',
          label: 'Onset and course',
          required: false,
          hint: 'When it started, and how it has changed since.',
          maxLength: 4000,
        },
        {
          key: 'family_history',
          type: 'BOOLEAN',
          label: 'Family history of hair loss',
          required: false,
        },
        {
          key: 'previous_treatment',
          type: 'TEXTAREA',
          label: 'Previous treatment',
          required: false,
          maxLength: 2000,
        },
        {
          key: 'hair_care',
          type: 'TEXTAREA',
          label: 'Hair care and styling',
          required: false,
          hint: 'Washing, colouring, heat, traction from tight styles.',
          maxLength: 2000,
        },
      ],
    },
    {
      type: 'EXAMINATION',
      key: 'scalp_examination',
      label: 'Examination',
      order: 40,
      visible: true,
      required: false,
      fields: [
        {
          /*
           * ⚠️ PUBLISHED SCALES, NAMED AS SUCH — Norwood for male pattern,
           *   Ludwig for female. Nothing here is invented: the same rule the
           *   vocabulary seed works under, for the same reason. A grade a
           *   clinician does not recognise is one they will record wrongly.
           */
          key: 'pattern_grade',
          type: 'SELECT',
          label: 'Pattern grade',
          required: false,
          options: [
            { value: 'NORWOOD_1', label: 'Norwood I' },
            { value: 'NORWOOD_2', label: 'Norwood II' },
            { value: 'NORWOOD_3', label: 'Norwood III' },
            { value: 'NORWOOD_4', label: 'Norwood IV' },
            { value: 'NORWOOD_5', label: 'Norwood V' },
            { value: 'NORWOOD_6', label: 'Norwood VI' },
            { value: 'NORWOOD_7', label: 'Norwood VII' },
            { value: 'LUDWIG_1', label: 'Ludwig I' },
            { value: 'LUDWIG_2', label: 'Ludwig II' },
            { value: 'LUDWIG_3', label: 'Ludwig III' },
          ],
        },
        {
          key: 'pull_test',
          type: 'SELECT',
          label: 'Pull test',
          required: false,
          options: [
            { value: 'NEGATIVE', label: 'Negative' },
            { value: 'POSITIVE', label: 'Positive' },
          ],
        },
        {
          key: 'hair_density',
          type: 'MEASUREMENT',
          label: 'Density on trichoscopy',
          required: false,
          unit: 'hairs/cm²',
          min: 0,
          max: 400,
          precision: 0,
        },
        {
          key: 'trichoscopy',
          type: 'TEXTAREA',
          label: 'Trichoscopy',
          required: false,
          maxLength: 4000,
        },
      ],
    },
    {
      /* The second chart, and the second seed. See the note on the odontogram
         above for why it is not required. */
      type: 'VISUAL_MAPPING',
      key: 'scalp_chart',
      label: 'Scalp chart',
      order: 50,
      visible: true,
      required: false,
      mapCode: 'HUMAN_SCALP',
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
  /**
   * The taxonomy node this template is attached to, below the care context.
   *
   * ⚠️ ABSENT MEANS "the care-context default", WHICH IS A DIFFERENT TEMPLATE
   *   ENTIRELY — it is the one every unclassified doctor resolves to. A
   *   specialty template that lost its node would become a SECOND default
   *   competing with the general one at depth 0, decided by a code comparison:
   *   `DENTAL_HUMAN` sorts before `GENERAL_HUMAN`, so every human consultation
   *   in the product would silently become a dental one. The seeder treats a
   *   named-but-missing node as fatal for exactly that reason.
   */
  specialtyCode?: string;
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
  {
    code: 'DENTAL_HUMAN',
    name: 'Dental consultation',
    description:
      'A reference configuration for dentistry: the odontogram, a dental history and a treatment list. Attached to the Dental domain, so every dental specialty inherits it until the clinic writes its own.',
    careContextCode: 'HUMAN',
    /* The DOMAIN, not General Dentistry. Attaching it to the leaf would leave
       an orthodontist resolving the general human consultation. */
    specialtyCode: 'DEN',
    definition: DENTAL_CONSULTATION,
  },
  {
    code: 'HAIR_SCALP_HUMAN',
    name: 'Hair & scalp consultation',
    description:
      'A reference configuration for trichology: the scalp chart, pattern grading and a hair history. Attached to Trichology, so a general dermatology consultation is unaffected.',
    careContextCode: 'HUMAN',
    /*
     * ⚠️ TRICHOLOGY AND NOT DERMATOLOGY, WHICH IS THE OPPOSITE CHOICE FROM THE
     *   DENTAL ONE AND IS DELIBERATE. Every dental specialty conducts a
     *   consultation shaped like the one above; most of dermatology does not
     *   grade a Norwood scale. Attaching this at the department would hand a
     *   scalp chart to somebody treating acne — and specificity only ever walks
     *   UP, so they would have no way to decline it short of writing their own
     *   template.
     */
    specialtyCode: 'TRICHOLOGY',
    definition: HAIR_SCALP_CONSULTATION,
  },
];
