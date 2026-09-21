/**
 * Patients — the first PHI surface, and the one whose rules the rest inherit.
 *
 * ⚠️ EVERY READ HERE WRITES A `data_access_logs` ROW. Not as a courtesy: who
 *   looked at whose record is the question a clinic has to answer after the
 *   fact, and the trail is the intended cost of the disclosure.
 *
 * ⚠️ `patients` DELIBERATELY CARRIES NO BRANCH ISOLATION POLICY (ADR-0016).
 *   Identity follows the person across a group; ATTENDANCE belongs to the branch,
 *   and that is what `patient_registrations` records. It is why a search can
 *   report a patient it will not fully show, and why the duplicate check spans
 *   branches the caller cannot otherwise see.
 */
import { z } from 'zod';
import {
  doseCalculationResponse,
  patientDetail,
  patientAppointmentsResponse,
  patientDuplicateMatch,
  patientHistoryResponse,
  patientListResponse,
  visitHistoryResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  ANIMAL_GUARDIAN_CONTACT,
  ANIMAL_GUARDIAN_CONTACT_ID,
  ANIMAL_PROFILE,
  APPOINTMENT_AT,
  APPOINTMENT_ID,
  APPOINTMENT_NUMBER,
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  DOCTOR,
  DOCTOR_ID,
  PATIENT,
  PATIENT_ANIMAL,
  PATIENT_ID,
  PATIENT_TWO_ID,
} from './fixtures.js';

const PATIENT_ID_NOTE =
  "The patient's `id` (not their UHID). A patient at another clinic is answered `404`.";

const PATIENT_EXAMPLE = {
  id: PATIENT_ID,
  uhid: 'ALP-000241',
  fullName: 'Ravi Subramanian',
  firstName: 'Ravi',
  lastName: 'Subramanian',
  gender: 'MALE',
  age: 47,
  ageIsApproximate: false,
  dateOfBirth: '1979-02-14',
  approxAgeYears: null,
  bloodGroup: 'O_POSITIVE',
  phone: '+919845067890',
  email: 'ravi.s@example.in',
  abhaNumber: null,
  nationalId: null,
  nationalIdType: null,
  maritalStatus: 'MARRIED',
  status: 'ACTIVE',
  deceasedOn: null,
  mergedIntoId: null,
  mrn: 'IND-1043',
  branchId: BRANCH_ID,
  crossBranch: false,
  subjectType: 'HUMAN',
  registrations: [
    {
      branchId: BRANCH_ID,
      branchName: 'Alpha Clinic — Indiranagar',
      mrn: 'IND-1043',
      registeredOn: '2024-11-03T06:12:00.000Z',
    },
  ],
  addresses: [],
  contacts: [],
  animalProfile: null,
};

/**
 * The same shape, for an animal (PI-11).
 *
 * ⚠️ IT IS THE SAME SHAPE, AND THE REFERENCE HAS TO SHOW THAT RATHER THAN SAY
 *   IT. A consumer reading only the human example would reasonably assume a
 *   separate endpoint exists for animals; ADR-0017 is that there is not one, and
 *   the fastest way to communicate that is two examples of one response.
 */
const ANIMAL_PATIENT_EXAMPLE = {
  ...PATIENT_ANIMAL,
  registrations: [
    {
      branchId: BRANCH_ID,
      branchName: 'Alpha Clinic — Indiranagar',
      mrn: 'IND-1178',
      registeredOn: '2026-02-19T05:40:00.000Z',
    },
  ],
  addresses: [],
  contacts: [ANIMAL_GUARDIAN_CONTACT],
  animalProfile: ANIMAL_PROFILE,
};

/** What `POST /patients/duplicate-check` answers with. Not a contract export. */
const duplicateCheckResponse = z.object({
  matches: z
    .array(patientDuplicateMatch)
    .describe('Empty when nothing plausible was found — the normal case.'),
});

export const patientDocs: DocRegistry = {
  'GET /api/v1/patients': {
    summary: 'Search patients',
    description: `
Free-text search over name, UHID, MRN and phone.

⚠️ **\`scope\` is the disclosure control on this endpoint, and \`ORGANIZATION\` is
not simply "more results".** \`BRANCH\` (the default) returns people who attend
one of the caller's own branches. \`ORGANIZATION\` searches the whole group and
marks anything outside the caller's branches \`crossBranch: true\` — the row is
identifying information about somebody another site treats. Use it when
somebody is standing at the desk saying they were seen at the other location;
do not use it as the default.

**Rows are summaries, not records.** No address, no email, no ABHA number, no
national id — a full identity set on every row would turn one permission into a
bulk export. Fetch the record itself for those.

Pagination lives **inside \`data\`** on this endpoint (\`data.meta\`), not in the
envelope's top-level \`meta\`.
`.trim(),
    response: patientListResponse,
    phi: true,
    params: {
      q: 'Name, UHID, MRN or phone. At least 2 characters.',
      scope:
        "`BRANCH` (default) searches the caller's own branches; `ORGANIZATION` searches the whole group and flags out-of-scope rows with `crossBranch: true`.",
      status: 'Narrow to one lifecycle state. Omit to get `ACTIVE` and `INACTIVE`.',
      page: '1-based.',
      limit: 'Rows per page, up to 50.',
    },
    responseExamples: [
      {
        summary: 'One local match and one at another branch',
        value: {
          success: true,
          message: 'Success',
          data: {
            patients: [
              {
                id: PATIENT_EXAMPLE.id,
                uhid: 'ALP-000241',
                fullName: 'Ravi Subramanian',
                gender: 'MALE',
                age: 47,
                ageIsApproximate: false,
                phone: '+919845067890',
                status: 'ACTIVE',
                mrn: 'IND-1043',
                branchId: BRANCH_ID,
                crossBranch: false,
              },
              {
                id: PATIENT_TWO_ID,
                uhid: 'ALP-000318',
                fullName: 'Ravi Menon',
                gender: 'MALE',
                age: 52,
                ageIsApproximate: false,
                phone: '+919847011223',
                status: 'ACTIVE',
                mrn: null,
                branchId: null,
                crossBranch: true,
              },
            ],
            meta: { page: 1, limit: 20, total: 2, totalPages: 1 },
          },
        },
      },
    ],
  },

  'POST /api/v1/patients/duplicate-check': {
    summary: 'Check for an existing patient before registering one',
    description: `
Call this **before** \`POST /api/v1/patients\` and show the operator what comes
back. A duplicated person is expensive to unpick once two records have separate
clinical histories.

\`matchedOn\` says why each candidate matched — \`PHONE\`, \`NAME_AND_DOB\`, \`ABHA\`
or \`NATIONAL_ID\` — so the desk can judge rather than guess.

⚠️ **Deliberately organization-wide, including branches the caller cannot see.**
That is the point of the endpoint. \`branchNames\` comes back **empty** for a
match at a branch outside the caller's scope, so the desk learns "this person is
already registered somewhere in this group" without learning where.

Advisory: it never blocks a registration.
`.trim(),
    /*
     * Built from the contract rather than hand-written as JSON Schema, so
     * `PatientDuplicateMatch` is REGISTERED as a component. A hand-written
     * `$ref` to it would render as a broken link — the component would never be
     * emitted, because nothing had told the schema space the contract was used.
     */
    response: duplicateCheckResponse,
    requestExamples: [
      {
        summary: 'What the desk has typed so far',
        value: {
          firstName: 'Ravi',
          lastName: 'Subramanian',
          phone: '+919845067890',
          dateOfBirth: '1979-02-14',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Already registered at a branch the caller cannot see',
        value: {
          success: true,
          message: 'Success',
          data: {
            matches: [
              {
                id: PATIENT_EXAMPLE.id,
                uhid: 'ALP-000241',
                fullName: 'Ravi Subramanian',
                age: 47,
                gender: 'MALE',
                phone: '+919845067890',
                matchedOn: ['PHONE', 'NAME_AND_DOB'],
                branchNames: [],
              },
            ],
          },
        },
      },
      {
        summary: 'Nothing found',
        value: { success: true, message: 'Success', data: { matches: [] } },
      },
    ],
  },

  'POST /api/v1/patients': {
    summary: 'Register a patient',
    description: `
Creates the person **and** their first registration at a branch, in one
transaction.

**Age:** send \`dateOfBirth\` when it is known. When it is not — which is common
at a walk-in counter — send \`approxAgeYears\` instead and the record says so
forever after (\`ageIsApproximate: true\`). Inventing a birthday to fill the field
is the thing this pair exists to prevent.

**UHID is issued by us**, per organization, and is the identifier to show a
patient. **MRN is per branch** and is what that site's own paperwork uses. Both
come back on the response; neither is accepted on the request.

**Animals register here too.** Send \`subjectType: "ANIMAL"\` with an optional
\`animalProfile\`. There is no separate endpoint and no parallel model
(ADR-0017) — an animal is a \`patients\` row with an extension row hanging off
it, so it gets a UHID, an MRN, a chart and a prescription exactly as a person
does. The kind is fixed at registration: \`subjectType\` is deliberately absent
from \`PATCH\`, because a chart written under one care-context taxonomy cannot be
read under another.

⚠️ **The owner cannot be linked on this call.** \`animalProfile.guardianContactId\`
names a \`patient_contacts\` row, and at registration the only such rows are the
ones being created by this same request — whose ids you cannot know yet. Send the
owner as \`guardianName\`/\`guardianPhone\`, or register first and then
\`PUT /api/v1/patients/{patientId}/animal-profile\`.

Run \`POST /api/v1/patients/duplicate-check\` first.
`.trim(),
    status: 201,
    message: 'Patient registered',
    response: patientDetail,
    phi: true,
    requestExamples: [
      {
        summary: 'Walk-in with an exact date of birth',
        value: {
          firstName: 'Ravi',
          lastName: 'Subramanian',
          gender: 'MALE',
          dateOfBirth: '1979-02-14',
          phone: '+919845067890',
          branchId: BRANCH_ID,
        },
      },
      {
        summary: 'A dog',
        description:
          'The human fields still mean something: `gender` is the animal’s sex, `dateOfBirth` is when it was born. The owner goes in `contacts` and is linked to the profile afterwards.',
        value: {
          firstName: 'Kaapi',
          lastName: 'Subramanian',
          subjectType: 'ANIMAL',
          gender: 'MALE',
          dateOfBirth: '2023-05-20',
          branchId: BRANCH_ID,
          contacts: [
            {
              relation: 'Owner',
              name: 'Ravi Subramanian',
              phone: '+919845067890',
              isGuardian: true,
            },
          ],
          animalProfile: { species: 'Dog', breed: 'Indie' },
        },
      },
      {
        summary: 'Age not known exactly',
        description:
          'No `dateOfBirth`. The record will report `ageIsApproximate: true` from here on.',
        value: {
          firstName: 'Lakshmi',
          gender: 'FEMALE',
          approxAgeYears: 72,
          phone: '+919845099887',
          branchId: BRANCH_ID,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Registered',
        value: { success: true, message: 'Patient registered', data: PATIENT_EXAMPLE },
      },
    ],
    errors: [409],
  },

  'PUT /api/v1/patients/{patientId}/animal-profile': {
    summary: "Record an animal's species, weight and owner",
    description: `
Species, breed, weight and owner for a patient registered as an animal.

⚠️ **There is no separate model for animals.** An animal is a \`patients\` row
with \`subjectType: "ANIMAL"\`, and this endpoint fills in the extension row that
hangs off it. It is answered \`400\` for a person — a record's kind is fixed at
registration and is not editable, because a chart written under one care-context
taxonomy cannot be read under another.

**This is a \`PUT\`, and it replaces the whole profile.** Send the fields you
want to keep. Omitting the weight *clears* it rather than leaving it alone, and
that is deliberate: a stale weight surviving an edit that meant to remove it is
the exact hazard this profile exists to prevent.

**A weight must come with the day it was taken.** \`weightRecordedOn\` is
required whenever \`weightKg\` is sent, and refused when it is not. A puppy
weighed at eight weeks and dosed at eight months is what
\`POST /api/v1/patients/{patientId}/dose-calculations\` needs to be able to see,
and it cannot see it without a date.

**The owner is recorded one way or the other, never both.** Either
\`guardianContactId\` — a contact already on this animal's record, which is the
better answer — or \`guardianName\` and \`guardianPhone\` as free text for the
walk-in whose owner has not been recorded yet. Sending both is \`400\`.

⚠️ **\`weightKg\` is a decimal STRING, not a number.** \`"18.4"\`, not \`18.4\`
unquoted. The column is \`Decimal(8,3)\` and a JSON number is a double — this is
the value a dose gets multiplied by. It comes back with its significant digits
and **not** padded to the column's scale, which is this platform's convention on
every quantity; the computed dose fields DO pad, because they report at a
declared precision rather than echoing a column.

The whole patient record comes back, exactly as \`GET\` returns it.
`.trim(),
    message: 'Animal details saved',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Weighed today, owner already on the record',
        value: {
          species: 'Dog',
          breed: 'Indie',
          weightKg: '18.4',
          weightRecordedOn: '2026-03-02',
          guardianContactId: ANIMAL_GUARDIAN_CONTACT_ID,
        },
      },
      {
        summary: 'A walk-in nobody knows much about yet',
        description:
          'Every field is optional. An animal brought in ill, whose owner is not a contact row yet, still gets a record.',
        value: { species: 'Cat', guardianName: 'Anitha Rao', guardianPhone: '+919845112233' },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: { success: true, message: 'Animal details saved', data: ANIMAL_PATIENT_EXAMPLE },
      },
    ],
    errors: [409],
  },

  'POST /api/v1/patients/{patientId}/dose-calculations': {
    summary: 'Calculate a weight-based dose',
    description: `
Multiplies the animal's **recorded** weight by a rate you supply, and holds the
answer to whatever ceilings you supply.

⚠️ **The weight is not a parameter, and that is the entire reason this endpoint
exists.** The arithmetic is a multiplication anybody can do at the counter; what
they cannot do at the counter is notice that the weight they are working from was
taken seven months ago. The response carries \`weightRecordedOn\` and
\`weightIsStale\` for exactly that. An animal with no recorded weight is
answered \`400\` rather than from a number you sent.

⚠️ **This platform holds no formulary and recommends nothing.** \`dosePerKg\`,
\`maxSingleDose\` and \`maxDailyDose\` come from a clinician reading a label.
Nothing here originates a mg/kg figure or has an opinion about whether one is
sensible.

⚠️ **It writes no clinical record and authorises nothing.** A dose becomes part of
the chart when a prescription is signed. This is a calculator; it files a
disclosure log and nothing else.

**When a ceiling binds, \`singleDose\` is the capped figure** and \`cappedBy\`
says which one. Rendering the cap as a footnote beside an uncapped number shows a
dose the label prohibits. A daily ceiling reduces the *single* dose rather than
trimming the total, so the two figures always multiply.

**No unit conversion happens.** \`unit\` is echoed back verbatim; mixing mg and
ml across the fields gives an answer in a unit of your own invention.

**Rounding is to three decimal places and always downward**, never half-up —
rounding a dose up past a maximum is an overdose. \`exact: false\` says something
was discarded.

It is a \`POST\` because a \`GET\` would put clinical parameters in the access
log, the referrer header and browser history beside a patient id.
`.trim(),
    response: doseCalculationResponse,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: '15 mg/kg, three times a day',
        value: { dosePerKg: '15', unit: 'mg', dosesPerDay: 3 },
      },
      {
        summary: 'With the label’s daily ceiling',
        description:
          'The daily maximum binds first here, so `singleDose` comes back reduced and `cappedBy` is `DAILY`.',
        value: { dosePerKg: '15', unit: 'mg', dosesPerDay: 3, maxDailyDose: '500' },
      },
    ],
    responseExamples: [
      {
        summary: '18.4 kg at 15 mg/kg',
        value: {
          success: true,
          message: 'Success',
          data: {
            weightKg: ANIMAL_PROFILE.weightKg,
            weightRecordedOn: ANIMAL_PROFILE.weightRecordedOn,
            weightIsStale: false,
            unit: 'mg',
            singleDose: '276.000',
            dailyDose: '828.000',
            cappedBy: null,
            exact: true,
          },
        },
      },
      {
        summary: 'Held to the daily maximum',
        value: {
          success: true,
          message: 'Success',
          data: {
            weightKg: ANIMAL_PROFILE.weightKg,
            weightRecordedOn: ANIMAL_PROFILE.weightRecordedOn,
            weightIsStale: false,
            unit: 'mg',
            singleDose: '166.666',
            dailyDose: '500.000',
            cappedBy: 'DAILY',
            exact: false,
          },
        },
      },
    ],
  },

  'GET /api/v1/patients/{patientId}': {
    summary: 'Get a patient record',
    description:
      'The full identity record: names, contact details, identifiers, and every branch registration, address and emergency contact.\n\n**Not the medical history** — allergies, conditions and medications sit behind a separate permission at `GET /api/v1/patients/{patientId}/history`, because the front desk holds this one and must not hold that one.',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    responseExamples: [
      {
        summary: 'A registered patient',
        value: { success: true, message: 'Success', data: PATIENT_EXAMPLE },
      },
      {
        summary: 'An animal patient',
        description:
          'The same response. `subjectType` is `ANIMAL`, `animalProfile` is populated, and the owner is a contact on the record — there is no separate endpoint and no separate model (ADR-0017).',
        value: { success: true, message: 'Success', data: ANIMAL_PATIENT_EXAMPLE },
      },
    ],
  },

  'PATCH /api/v1/patients/{patientId}': {
    summary: 'Update a patient record',
    description:
      'A partial update of identity and contact fields. Only what you send changes.\n\nUHID, MRN and the registration list are not editable here — the first two are issued, and the third changes through `POST /api/v1/patients/{patientId}/registrations`.',
    message: 'Patient updated',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      { summary: 'Correct a phone number', value: { phone: '+919845000111' } },
      {
        summary: 'Record a death',
        description: 'Sets the record to `DECEASED`; the history stays readable.',
        value: { status: 'DECEASED', deceasedOn: '2026-08-01' },
      },
    ],
    errors: [409],
  },

  'DELETE /api/v1/patients/{patientId}': {
    summary: 'Remove a patient record',
    description:
      'A **soft delete** — `deleted_at` is stamped and the row stays. Nothing hard-deletes a patient: their appointments, invoices, dispensing records and clinical notes all reference them, and a clinic is required to be able to produce that history.',
    message: 'Patient record removed',
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    responseExamples: [
      {
        summary: 'Removed',
        value: { success: true, message: 'Patient record removed', data: null },
      },
    ],
    errors: [409],
  },

  'POST /api/v1/patients/{patientId}/registrations': {
    summary: 'Register an existing patient at another branch',
    description:
      'Attaches an existing person to a second branch and issues them an MRN there.\n\nThis is the right call when the duplicate check found somebody already in the group — it keeps one clinical history instead of starting a second one.',
    status: 201,
    message: 'Registered at clinic',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Also seen at Kochi',
        value: { branchId: BRANCH_KOCHI_ID },
      },
    ],
    errors: [409],
  },

  'POST /api/v1/patients/{patientId}/addresses': {
    summary: 'Add an address',
    description:
      "Appends an address. A patient may have several — home, work, a caregiver's. Returns the whole updated record.",
    status: 201,
    message: 'Address added',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Home address',
        value: {
          addressType: 'HOME',
          line1: '14, 5th Cross',
          line2: 'Malleshwaram',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560003',
          countryCode: 'IN',
        },
      },
    ],
  },
  'DELETE /api/v1/patients/{patientId}/addresses/{addressId}': {
    summary: 'Remove an address',
    description: 'Detaches one address from the patient.',
    message: 'Address removed',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      addressId: "The address `id` from the patient record's `addresses` array.",
    },
  },

  'POST /api/v1/patients/{patientId}/contacts': {
    summary: 'Add an emergency contact',
    description:
      'Appends a contact — next of kin, a guardian, whoever should be called. Returns the whole updated record.',
    status: 201,
    message: 'Contact added',
    response: patientDetail,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Spouse',
        value: {
          fullName: 'Priya Subramanian',
          relationship: 'SPOUSE',
          phone: '+919845077665',
          isPrimary: true,
        },
      },
    ],
  },
  'DELETE /api/v1/patients/{patientId}/contacts/{contactId}': {
    summary: 'Remove an emergency contact',
    description: 'Detaches one contact from the patient.',
    message: 'Contact removed',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      contactId: "The contact `id` from the patient record's `contacts` array.",
    },
  },

  'GET /api/v1/patients/{patientId}/appointments': {
    summary: "List a patient's bookings",
    description: `
Every appointment this patient has, newest first — what the Appointments tab on
the chart renders.

⚠️ **\`appointment.read\`, not \`clinical.encounter.read\`.** This answers *when*
somebody came in, with whom, and whether they turned up. It carries no
diagnosis, no chief complaint and no consultation content, so the front desk —
which books the follow-ups and has to see what came before — may read it. What
was *concluded* at those visits is \`/visit-history\`, behind the clinical
permission.

⚠️ **Not a filter on the day board, and could not be one.** \`GET /api/v1/appointments\`
is anchored on a branch and a date range capped at 45 days; a history is
unbounded in time by definition, so this paginates instead of ranging.

⚠️ **Scoped to the caller's branches as well as their organization.** A patient
treated at two branches has a history spanning both, and a caller confined to
one sees only that one's bookings here.

Rows carry \`cancellationReason\` but never \`reason\` — the same split the day
board draws. \`liveInvoice\` is never populated: whether a visit is billed is the
ledger's question.

Writes a \`data_access_logs\` row. The day board does not; this singles out one
patient's record, which is the line \`data_access_logs\` is drawn on.
`.trim(),
    response: patientAppointmentsResponse,
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      page: '1-based.',
      pageSize: 'Bookings per page, at most 50.',
    },
    responseExamples: [
      {
        summary: 'Two visits, the later one seen',
        value: {
          success: true,
          message: 'Success',
          data: {
            patientId: PATIENT_ID,
            appointments: [
              {
                id: APPOINTMENT_ID,
                appointmentNumber: APPOINTMENT_NUMBER,
                branchId: BRANCH_ID,
                timezone: 'Asia/Kolkata',
                patientId: PATIENT_ID,
                patientName: PATIENT.fullName,
                uhid: PATIENT.uhid,
                doctorProfileId: DOCTOR_ID,
                doctorName: DOCTOR.fullName,
                scheduledStart: APPOINTMENT_AT,
                scheduledEnd: '2026-03-17T04:15:00.000Z',
                visitType: 'NEW',
                source: 'FRONT_DESK',
                status: 'COMPLETED',
                cancellationReason: null,
                checkedInAt: '2026-03-17T03:52:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 10,
          },
        },
      },
    ],
  },

  'GET /api/v1/patients/{patientId}/visit-history': {
    summary: "List a patient's past consultations",
    description: `
The sequence of consultations: when, with whom, what was concluded and what was
prescribed.

⚠️ **This is the most concentrated PHI read on the platform** — one person's
entire clinical past in a single response — and it is gated on
\`clinical.encounter.read\`, **not** on the patient permissions above. A
receptionist who can find a patient and book them an appointment cannot read
this.

Distinct from \`/history\`, which is the standing problem list — what is true of
this person between visits. A doctor holds both; they are not the same
disclosure and not the same permission.
`.trim(),
    response: visitHistoryResponse,
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      from: 'ISO date. Omit for no lower bound.',
      to: 'ISO date. Omit for no upper bound.',
      page: '1-based.',
      limit: 'Consultations per page.',
    },
  },

  'GET /api/v1/patients/{patientId}/history': {
    summary: 'Get the medical history',
    description: `
The three standing lists together: **allergies**, **conditions** and **current
medications**.

Its own endpoint behind its own permission rather than part of the patient
record, and the reason is concrete: folding it into \`GET /patients/{patientId}\`
would mean either the front desk reads the problem list, or nobody does.

This is what is true of the person *between* visits. What happened *at* a visit
is \`/visit-history\`.
`.trim(),
    response: patientHistoryResponse,
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
  },

  'POST /api/v1/patients/{patientId}/allergies': {
    summary: 'Record an allergy',
    description:
      'Adds an allergy to the standing list. Returns no payload — re-read `/history` for the updated set.',
    status: 201,
    message: 'Allergy recorded',
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Drug allergy',
        value: {
          substance: 'Penicillin',
          reaction: 'Urticaria and facial swelling',
          severity: 'SEVERE',
          notedOn: '2025-06-11',
        },
      },
    ],
  },
  'DELETE /api/v1/patients/{patientId}/allergies/{allergyId}': {
    summary: 'Withdraw an allergy',
    description:
      'Withdraws an entry — for a record made in error, or one since disproved. The row is retained; the clinical record is not rewritten.',
    message: 'Allergy withdrawn',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      allergyId: 'The allergy `id` from `GET /api/v1/patients/{patientId}/history`.',
    },
  },

  'POST /api/v1/patients/{patientId}/conditions': {
    summary: 'Record a condition',
    description: 'Adds a condition to the standing problem list.',
    status: 201,
    message: 'Condition recorded',
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'A chronic condition',
        value: {
          name: 'Type 2 diabetes mellitus',
          status: 'ACTIVE',
          onsetOn: '2019-03-01',
          notes: 'Diet-controlled since 2023.',
        },
      },
    ],
  },
  'PUT /api/v1/patients/{patientId}/conditions/{conditionId}': {
    summary: 'Replace a condition',
    description:
      '`PUT`, not `PATCH`: the entry is replaced whole, so anything you omit is cleared. Send the complete condition.',
    message: 'Condition updated',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      conditionId: 'The condition `id` from `GET /api/v1/patients/{patientId}/history`.',
    },
    requestExamples: [
      {
        summary: 'Mark it resolved',
        value: {
          name: 'Type 2 diabetes mellitus',
          status: 'RESOLVED',
          onsetOn: '2019-03-01',
          resolvedOn: '2026-05-20',
        },
      },
    ],
  },
  'DELETE /api/v1/patients/{patientId}/conditions/{conditionId}': {
    summary: 'Withdraw a condition',
    description:
      'For an entry made in error. A condition that has ENDED should be marked `RESOLVED` instead — withdrawing it loses the fact that it was ever true.',
    message: 'Condition withdrawn',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      conditionId: 'The condition `id` from `GET /api/v1/patients/{patientId}/history`.',
    },
  },

  'POST /api/v1/patients/{patientId}/medications': {
    summary: 'Record a current medication',
    description:
      'Adds to the list of what the patient is currently taking — including medicines prescribed elsewhere, which is the main reason this is captured by hand rather than derived from prescriptions.',
    status: 201,
    message: 'Medicine recorded',
    phi: true,
    params: { patientId: PATIENT_ID_NOTE },
    requestExamples: [
      {
        summary: 'Prescribed elsewhere',
        value: {
          name: 'Metformin 500mg',
          dose: '500 mg',
          frequency: 'Twice daily',
          startedOn: '2019-03-05',
          notes: 'Started by external endocrinologist.',
        },
      },
    ],
  },
  'POST /api/v1/patients/{patientId}/medications/{medicationId}/stop': {
    summary: 'Stop a medication',
    description:
      'Marks a medicine as no longer being taken, with the date it stopped. **Prefer this to deleting it** — that the patient was on it, and until when, is clinically relevant long after they stop.',
    message: 'Medicine stopped',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      medicationId: 'The medication `id` from `GET /api/v1/patients/{patientId}/history`.',
    },
    requestExamples: [
      {
        summary: 'Stopped last month',
        value: { stoppedOn: '2026-07-15', reason: 'Switched to insulin.' },
      },
    ],
  },
  'DELETE /api/v1/patients/{patientId}/medications/{medicationId}': {
    summary: 'Remove a medication entry',
    description:
      'For an entry made in error. A medicine the patient genuinely stopped should go through `/stop` instead.',
    message: 'Medicine removed',
    phi: true,
    params: {
      patientId: PATIENT_ID_NOTE,
      medicationId: 'The medication `id` from `GET /api/v1/patients/{patientId}/history`.',
    },
  },
};
