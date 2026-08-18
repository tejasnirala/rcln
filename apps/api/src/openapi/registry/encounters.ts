/**
 * The consultation — what the doctor recorded, and the nine collections it is
 * made of.
 *
 * ⚠️ INVARIANT 7 LIVES HERE. Reading a patient's record is not writing in it:
 *   `clinical.encounter.read` is held by anyone who consults the chart including
 *   the administrator who never writes in it, while `clinical.encounter.create`,
 *   `.close` and `.amend` belong to DOCTOR alone among the system roles. Those
 *   authoring codes are stripped from ORG_OWNER and ORG_ADMIN **by name** in
 *   `roles.ts`, because those roles are defined as "everything except" and a new
 *   authoring code would otherwise join them silently.
 *
 * ⚠️ PHI ON EVERY RESPONSE. Every read writes a `data_access_logs` row carrying
 *   the matched route PATTERN, never the URL — a URL brings its query string with
 *   it, and `data_access_logs` is read by compliance staff who have no business
 *   reading patient records.
 *
 * ⚠️ A SIGNED CONSULTATION IS NEVER EDITED. There is no endpoint anywhere that
 *   modifies a finalized record; correcting one means amending it, which opens a
 *   NEW draft citing the original.
 */
import { encounterDetail, encounterSaveResponse } from '@rcln/contracts';
import type { DocRegistry, EndpointDoc } from '../types.js';
import {
  AMENDED_ENCOUNTER_ID,
  APPOINTMENT_ID,
  BRANCH_ID,
  CLINICAL_TERM_ID,
  DIAGNOSIS_ROW_ID,
  DOCUMENT_ID,
  DOCTOR_ID,
  ENCOUNTER_ID,
  ENCOUNTER_NUMBER,
  ENCOUNTER_OPENED_AT,
  EPISODE_ID,
  PATIENT_ID,
  PRESCRIPTION_ROW_ID,
  PRESCRIPTION_SIGNED_AT,
  PRODUCT,
  PRODUCT_ID,
  SYMPTOM_ROW_ID,
  TEMPLATE_ID,
  TEMPLATE_VERSION_ID,
  VISUAL_REGION_ID,
} from './fixtures.js';

const ENCOUNTER_NOTE =
  'The consultation, as `POST /api/v1/encounters` or `GET /api/v1/appointments/{appointmentId}/encounter` returns it. One belonging to another clinic is answered `404`.';

const ROW_NOTE =
  "The row's own id, from the encounter's `content`. Not the catalogue id it points at.";

const ENCOUNTER_EXAMPLE = {
  id: ENCOUNTER_ID,
  status: 'DRAFT',
  encounterNumber: null,
  branchId: BRANCH_ID,
  patientId: PATIENT_ID,
  appointmentId: APPOINTMENT_ID,
  clinicalEpisodeId: EPISODE_ID,
  doctorProfileId: DOCTOR_ID,
  templateId: TEMPLATE_ID,
  templateVersionId: TEMPLATE_VERSION_ID,
  chiefComplaint: 'Fever and sore throat',
  chiefComplaintDurationValue: 3,
  chiefComplaintDurationUnit: 'DAY',
  onset: 'GRADUAL',
  clinicalNotes: null,
  startedAt: ENCOUNTER_OPENED_AT,
  finalizedAt: null,
  amendsEncounterId: null,
  amendedAt: null,
  amendmentReason: null,
  cancelledAt: null,
  cancelledReason: null,
  configuration: [],
  answers: [],
  content: {
    symptoms: [],
    diagnoses: [],
    procedures: [],
    prescriptions: [],
    investigations: [],
    advice: [],
    referrals: [],
    attachments: [],
    findings: [],
  },
};

/**
 * The nine collections, documented from a table rather than as twenty-seven
 * near-identical blocks — the same argument `encounters.routes.ts` makes for
 * generating the handlers that way. What genuinely differs per collection is
 * stated per collection; what is true of all nine is stated once, here.
 *
 * ⚠️ EVERY ONE OF THESE IS `clinical.encounter.create`, INCLUDING `findings`.
 *   Drawing on a body chart is writing up the consultation; the code that says
 *   what the chart IS is `clinical.visual_map.manage`, which a DOCTOR holds
 *   neither nor needs.
 */
interface Collection {
  readonly path: string;
  /** Singular, lowercase — "diagnosis", "prescription". */
  readonly noun: string;
  /** What this collection is, in a sentence or two. Markdown. */
  readonly what: string;
  /** What the update deliberately cannot change, and why. */
  readonly immutable?: string;
  readonly createExample: unknown;
  readonly updateExample: unknown;
  readonly errors?: readonly number[];
}

const CODED_OR_TYPED = `
**Either a coded term or your own words — never both and never neither.** Send
\`itemId\` to cite the vocabulary, or \`customText\` to type it. A clinic whose
vocabulary does not have the term must still be able to record it, and a
consultation that quietly dropped an uncoded observation would be worse than one
that carries free text.
`.trim();

const COLLECTIONS: readonly Collection[] = [
  {
    path: 'symptoms',
    noun: 'symptom',
    what: `What the patient reported, with how long it has been going on and how bad it is.\n\n${CODED_OR_TYPED}\n\n\`durationValue\` and \`durationUnit\` are set together or not at all — a database CHECK says so. \`frequency\` and \`site\` are free text deliberately: an enum would refuse the answer a patient actually gave.`,
    immutable:
      '`itemId` and `customText`. Swapping a coded symptom for a typed one is a different clinical statement; remove the row and add the one you meant.',
    createExample: {
      itemId: CLINICAL_TERM_ID,
      durationValue: 3,
      durationUnit: 'DAY',
      severity: 'MODERATE',
      frequency: 'Constant',
    },
    updateExample: { severity: 'SEVERE', notes: 'Worse overnight' },
  },
  {
    path: 'diagnoses',
    noun: 'diagnosis',
    what: `What the doctor concluded.\n\n${CODED_OR_TYPED}\n\n⚠️ **At most one \`PRIMARY\` per consultation**, enforced by a partial unique index. Two primaries is two answers to "what was this visit about", so a second one is a \`409\` rather than a \`500\`.\n\n\`certainty\` records how firm the conclusion is — a provisional diagnosis is not a hedge, it is a clinically meaningful state.`,
    immutable:
      '`itemId` and `customText`. A different diagnosis is a different row, not an edit of this one.',
    createExample: {
      itemId: CLINICAL_TERM_ID,
      role: 'PRIMARY',
      certainty: 'PROVISIONAL',
      notes: 'Likely viral; review if not settling in 48 hours',
    },
    updateExample: { certainty: 'CONFIRMED' },
    errors: [409],
  },
  {
    path: 'procedures',
    noun: 'procedure',
    what: `What was done at this visit.\n\n${CODED_OR_TYPED}\n\n**Recording a procedure here is a clinical statement, not a charge.** What the patient is billed for is decided on the invoice, and what the procedure consumed from the shelf is recorded through Charging & consumption. The three are deliberately not derived from one another.`,
    immutable: '`itemId` and `customText`.',
    createExample: { customText: 'Throat swab taken', notes: 'Sent for culture' },
    updateExample: { notes: 'Culture negative' },
  },
  {
    path: 'prescriptions',
    noun: 'prescription',
    what: `A medicine, as written.\n\n⚠️ **\`dose\` and \`quantity\` are STRINGS, not numbers.** Half a tablet is \`"0.5"\` and has to stay exactly that — a float would round it, and a rounded dose is a dosing error.\n\n\`strength\` is a **snapshot of what was written**, not a live reference to the catalogue, because a catalogue strength can be corrected afterwards and the prescription must still say what the prescriber said.\n\n⚠️ **\`isRepeatable\` has THREE states and \`null\` is not \`false\`.** \`null\` — the default — is "the prescriber did not address repeats", which the dispensing engine reads as no endorsement. \`false\` is a positive instruction that this may **not** be repeated. Collapsing them would make every prescription ever written carry an endorsement nobody gave.\n\n\`isPrn\` ("as needed") is not the same as a null frequency.`,
    immutable: '`productId`. A different medicine is a different line.',
    createExample: {
      productId: PRODUCT_ID,
      strength: '500mg',
      dose: '1',
      doseUnit: 'capsule',
      route: 'ORAL',
      frequency: 3,
      frequencyUnit: 'PER_DAY',
      durationValue: 5,
      durationUnit: 'DAY',
      foodRelation: 'AFTER_FOOD',
      quantity: '15',
      isPrn: false,
    },
    updateExample: { durationValue: 7, quantity: '21' },
  },
  {
    path: 'investigations',
    noun: 'investigation',
    what: `What was ordered — bloods, imaging, a swab.\n\n${CODED_OR_TYPED}\n\nOrdering an investigation records the request. It does not book it, bill it, or carry a result.`,
    immutable: '`itemId` and `customText`.',
    createExample: { customText: 'Full blood count', notes: 'Fasting not required' },
    updateExample: { notes: 'Urgent — same day' },
  },
  {
    path: 'advice',
    noun: 'advice note',
    what: 'What the patient was told to do — rest, fluids, when to come back, what to watch for. Free text, because advice is prose and an enum of it would be a worse record than no record.',
    createExample: {
      text: 'Rest, plenty of fluids. Return if the fever persists beyond 48 hours.',
    },
    updateExample: { text: 'Rest and fluids. Return sooner if breathing becomes difficult.' },
  },
  {
    path: 'referrals',
    noun: 'referral',
    what: `Where the patient was sent next — a colleague at this clinic, or somewhere outside it.\n\nAn internal referral names a \`doctorProfileId\`, which the prescriber finds through \`GET /api/v1/doctors/referral-targets\` — a lookup, not the roster, because a DOCTOR deliberately does not hold the directory permission.\n\nAn external referral is free text, since the destination is not in this system.`,
    createExample: {
      doctorProfileId: DOCTOR_ID,
      reason: 'Persistent murmur — cardiology opinion',
      urgency: 'ROUTINE',
    },
    updateExample: { urgency: 'URGENT' },
  },
  {
    path: 'attachments',
    noun: 'attachment',
    what: 'A document or image filed against this consultation — a scanned report, a photograph. The bytes are uploaded separately through Documents; this records the reference and what it is.',
    createExample: { documentId: DOCUMENT_ID, label: 'Chest X-ray' },
    updateExample: { label: 'Chest X-ray (PA view)' },
  },
  {
    path: 'findings',
    noun: 'finding',
    what: `A mark on a body chart — where on the diagram something was observed.\n\n⚠️ **Behind \`clinical.encounter.create\`, NOT \`clinical.visual_map.manage\`.** Drawing on a chart is writing up the consultation; the manage code says what the chart IS, and a DOCTOR holds neither it nor a need for it.`,
    createExample: {
      regionId: VISUAL_REGION_ID,
      note: 'Tenderness on palpation',
    },
    updateExample: { note: 'Tenderness resolved on review' },
  },
];

/** The three endpoints one collection contributes. */
const section = (c: Collection): DocRegistry => {
  const base = `/api/v1/encounters/{encounterId}/${c.path}`;
  const closed = `Refused on a finalized consultation — a signed record is never edited. Correct it by amending, which opens a new draft citing the original.`;

  const create: EndpointDoc = {
    summary: `Add a ${c.noun}`,
    description: `${c.what}\n\n${closed}`.trim(),
    status: 201,
    phi: true,
    errors: [409, ...(c.errors ?? [])],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [{ summary: `A ${c.noun}`, value: c.createExample }],
  };

  const update: EndpointDoc = {
    summary: `Update a ${c.noun}`,
    description: `
Change what was recorded about this ${c.noun}.

⚠️ **The update is not the create made partial, and that is deliberate through
every one of these collections.**${c.immutable ? ` Not editable here: ${c.immutable}` : ''} What the
update changes is everything *about* the statement, never which statement it is.

${closed}
`.trim(),
    phi: true,
    errors: [409, ...(c.errors ?? [])],
    params: { encounterId: ENCOUNTER_NOTE, rowId: ROW_NOTE },
    requestExamples: [{ summary: 'A correction', value: c.updateExample }],
  };

  const remove: EndpointDoc = {
    summary: `Remove a ${c.noun}`,
    description: `Take this ${c.noun} off the consultation. Only possible while the record is a draft — ${closed.charAt(0).toLowerCase()}${closed.slice(1)}`,
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE, rowId: ROW_NOTE },
  };

  return {
    [`POST ${base}`]: create,
    [`PATCH ${base}/{rowId}`]: update,
    [`DELETE ${base}/{rowId}`]: remove,
  };
};

export const encounterDocs: DocRegistry = {
  'POST /api/v1/encounters': {
    summary: 'Open a consultation',
    description: `
Start writing up a visit — from an appointment, or as a walk-in.

**Send \`appointmentId\` or \`patientId\`, never both and never neither.** From
an appointment, everything else comes off the booking. For a walk-in you supply
the patient and, importantly, the episode.

⚠️ **\`clinicalEpisodeId\` is REQUIRED for a walk-in rather than guessed.**
Attaching one to the patient's most recent open episode would be a clinical claim
the software has no basis for — whether this visit continues that course of
treatment is a judgement, and the software does not get to make it.

⚠️ **This is an act of AUTHORSHIP, behind \`clinical.encounter.create\`.** An
administrator arriving to read a booking must not thereby make "the doctor
started a consultation" true, which is why the reader's path is
\`GET /api/v1/appointments/{appointmentId}/encounter\` and it answers \`null\`
rather than opening anything.

The consultation is created against a **frozen snapshot** of the form template,
so the record renders forever as it was conducted even after the template moves
on. \`encounterNumber\` is \`null\` until finalization — the counter is not burnt
by an abandoned draft.
`.trim(),
    response: encounterDetail,
    status: 201,
    message: 'Success',
    phi: true,
    errors: [409],
    requestExamples: [
      {
        summary: 'From an appointment',
        description: 'The patient, branch, doctor and episode all come off the booking.',
        value: { appointmentId: APPOINTMENT_ID },
      },
      {
        summary: 'A walk-in',
        description: '`clinicalEpisodeId` is required here — it is never inferred.',
        value: {
          patientId: PATIENT_ID,
          clinicalEpisodeId: EPISODE_ID,
          branchId: BRANCH_ID,
          doctorProfileId: DOCTOR_ID,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'A new draft',
        value: { success: true, message: 'Success', data: ENCOUNTER_EXAMPLE },
      },
    ],
  },

  'GET /api/v1/encounters/{encounterId}': {
    summary: 'Get a consultation',
    description: `
One consultation, whole — the presenting complaint, every collection, and the
form configuration it was conducted on.

**Rendered through its own frozen snapshot**, so a record written last year still
displays as it was written even though the template has changed since.

Behind \`clinical.encounter.read\`, which is deliberately wider than the
authoring codes: an administrator reviewing care holds it, and holds none of the
codes that would let them alter what they are reading.
`.trim(),
    response: encounterDetail,
    phi: true,
    params: { encounterId: ENCOUNTER_NOTE },
    responseExamples: [
      {
        summary: 'A signed consultation',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENCOUNTER_EXAMPLE,
            status: 'FINALIZED',
            encounterNumber: ENCOUNTER_NUMBER,
            finalizedAt: PRESCRIPTION_SIGNED_AT,
            clinicalNotes: 'Pharyngitis, likely viral. Advised rest and fluids.',
            content: {
              ...ENCOUNTER_EXAMPLE.content,
              symptoms: [
                {
                  id: SYMPTOM_ROW_ID,
                  term: { id: CLINICAL_TERM_ID, code: 'R50.9', name: 'Fever' },
                  customText: null,
                  durationValue: 3,
                  durationUnit: 'DAY',
                  severity: 'MODERATE',
                  frequency: 'Constant',
                  site: null,
                  notes: null,
                  displayOrder: 0,
                },
              ],
              diagnoses: [
                {
                  id: DIAGNOSIS_ROW_ID,
                  term: { id: CLINICAL_TERM_ID, code: 'J02.9', name: 'Acute pharyngitis' },
                  customText: null,
                  role: 'PRIMARY',
                  certainty: 'PROVISIONAL',
                  notes: null,
                  displayOrder: 0,
                },
              ],
              prescriptions: [
                {
                  id: PRESCRIPTION_ROW_ID,
                  product: { id: PRODUCT_ID, code: PRODUCT.code, name: PRODUCT.name },
                  strength: '500mg',
                  dose: '1',
                  doseUnit: 'capsule',
                  route: 'ORAL',
                  frequency: 3,
                  frequencyUnit: 'PER_DAY',
                  durationValue: 5,
                  durationUnit: 'DAY',
                  foodRelation: 'AFTER_FOOD',
                  timing: null,
                  quantity: '15',
                  startDate: '2026-03-17',
                  endDate: '2026-03-22',
                  isPrn: false,
                  isRepeatable: null,
                  displayOrder: 0,
                },
              ],
            },
          },
        },
      },
    ],
  },

  'PATCH /api/v1/encounters/{encounterId}': {
    summary: 'Save the draft',
    description: `
The debounced autosave behind the consultation screen.

⚠️ **Returns the saved revision and nothing else** — an id, a status and a
timestamp. A Server Action calling this must **not** \`revalidatePath\`:
revalidating per keystroke re-renders the consultation from the server and fights
the cursor.

\`sections\` upserts the descriptor-driven answers **by \`key\`**. A section
absent from the list is left exactly as it was, so a partial save is safe and the
client need only send what changed.

⚠️ **Not read-audited, deliberately.** A write is not a disclosure, and the
doctor writing the record was already logged reading it. One \`data_access_logs\`
row per keystroke would make the read trail unusable for the question it exists
to answer.

\`clinical.encounter.create\` — the autosave *is* writing up.
`.trim(),
    response: encounterSaveResponse,
    phi: false,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      {
        summary: 'The presenting complaint',
        value: {
          chiefComplaint: 'Fever and sore throat',
          chiefComplaintDurationValue: 3,
          chiefComplaintDurationUnit: 'DAY',
          onset: 'GRADUAL',
        },
      },
      {
        summary: 'One template section',
        description: 'Upserted by `key`. Sections not listed are untouched.',
        value: {
          sections: [
            { key: 'examination', data: { throat: 'Injected, no exudate', chest: 'Clear' } },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: ENCOUNTER_ID,
            status: 'DRAFT',
            savedAt: '2026-03-17T04:18:00.000Z',
          },
        },
      },
    ],
  },

  'POST /api/v1/encounters/{encounterId}/finalize': {
    summary: 'Sign the consultation',
    description: `
Sign the record. It stops being a draft, is issued its \`encounterNumber\`, and
becomes immutable.

⚠️ **From here there is no edit, anywhere in the API.** Correcting a signed
consultation means amending it, which opens a *new* draft citing this one.

⚠️ **A missing required answer is a \`400\` with a sentence, not a silent save.**
Every descriptor-driven section is checked against this encounter's own frozen
snapshot, and **all the problems come back at once** — a doctor sent back three
times for three fields learns to distrust the button.

Behind \`clinical.encounter.close\`, which is separate from \`.create\`: writing
up and signing off are different acts, and a clinic may put them in different
hands.
`.trim(),
    response: encounterDetail,
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    responseExamples: [
      {
        summary: 'Signed',
        description: 'Note `encounterNumber` is issued only now, not when the draft was opened.',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENCOUNTER_EXAMPLE,
            status: 'FINALIZED',
            encounterNumber: ENCOUNTER_NUMBER,
            finalizedAt: PRESCRIPTION_SIGNED_AT,
          },
        },
      },
    ],
  },

  'POST /api/v1/encounters/{encounterId}/amend': {
    summary: 'Amend a signed consultation',
    description: `
Correct a signed record by starting a new one that cites it.

⚠️ **\`201\`, and the response is the NEW DRAFT — not the old record.** Nothing
about the original changes except its status. That is the entire difference
between an amendment and an edit, and it is why there is no endpoint anywhere
that edits a finalized consultation.

The new draft opens pre-filled with the original's content, so the doctor
corrects rather than retypes. \`reason\` is required, at least three characters,
and is carried on the amendment permanently — "why does this record have two
versions" must be answerable from the record itself.

Behind \`clinical.encounter.amend\`, its own code: restating a signed record is
a heavier act than writing a fresh one.
`.trim(),
    response: encounterDetail,
    status: 201,
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      {
        summary: 'Correct the diagnosis',
        value: { reason: 'Culture returned positive for Group A strep; diagnosis restated.' },
      },
    ],
    responseExamples: [
      {
        summary: 'A new draft citing the original',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENCOUNTER_EXAMPLE,
            id: AMENDED_ENCOUNTER_ID,
            status: 'DRAFT',
            amendsEncounterId: ENCOUNTER_ID,
            amendmentReason: 'Culture returned positive for Group A strep; diagnosis restated.',
          },
        },
      },
    ],
  },

  'POST /api/v1/encounters/{encounterId}/cancel': {
    summary: 'Cancel a draft consultation',
    description: `
Abandon a draft that should not have been opened — the wrong patient, or a visit
that did not happen.

**Only a draft.** A signed consultation is never cancelled; it is amended.

The draft is retained in a cancelled state rather than deleted, and its
\`encounterNumber\` was never issued, so nothing in the numbering sequence is
burnt by it.
`.trim(),
    response: encounterDetail,
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      { summary: 'Opened on the wrong patient', value: { reason: 'Opened on the wrong patient' } },
      { summary: 'Without a reason', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Cancelled',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...ENCOUNTER_EXAMPLE,
            status: 'CANCELLED',
            cancelledAt: '2026-03-17T04:20:00.000Z',
            cancelledReason: 'Opened on the wrong patient',
          },
        },
      },
    ],
  },

  ...COLLECTIONS.reduce<DocRegistry>((all, c) => ({ ...all, ...section(c) }), {}),

  'PUT /api/v1/encounters/{encounterId}/follow-up': {
    summary: 'Set the follow-up recommendation',
    description: `
What the doctor wants to happen next — "review in two weeks".

⚠️ **A RECOMMENDATION, NOT A BOOKING.** It creates no appointment and holds no
slot. Somebody at the front desk turns it into one later through
\`POST /api/v1/appointments/{appointmentId}/follow-up\`, ticking
\`fulfilsRecommendationId\` to close the loop. Keeping the two apart is what lets
a clinic work a recall list at all: the clinical intent and the commercial act of
booking are recorded by different people, days or weeks apart.

**\`PUT\`, so there is at most one per consultation** — the doctor's instruction,
replaced if restated, rather than a growing list of half-decisions.

Send \`null\` to clear it.
`.trim(),
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      {
        summary: 'Review in two weeks',
        value: { intervalValue: 2, intervalUnit: 'WEEK', reason: 'Review after antibiotics' },
      },
      { summary: 'Clear it', value: { recommendation: null } },
    ],
  },
};
