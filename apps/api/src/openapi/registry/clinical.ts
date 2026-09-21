/**
 * The clinical vocabulary and the treatment journey — two surfaces with two
 * disclosure classes, deliberately in one router and never in one permission.
 *
 * ⚠️ `/clinical-data` IS THE DICTIONARY AND DISCLOSES NOBODY. "Dental caries"
 *   is a word. It is read behind the codes that already let you see a chart and
 *   written behind `clinical.master.manage`.
 *
 * ⚠️ `/clinical-episodes` AND `/follow-up-recommendations` NAME A PATIENT. PHI,
 *   audited, paginated.
 *
 * ⚠️ EPISODES AND RECALLS SIT BEHIND `appointment.*`, NOT A CLINICAL CODE, AND
 *   THAT IS INVARIANT 7 AGAIN. An episode is a booking-time concept — the front
 *   desk picks one while making an appointment — and the recall list is worked
 *   by whoever telephones the patient. The desk holds no clinical code at all,
 *   so gating either behind `clinical.encounter.read` would mean the only people
 *   who could do the job are the people who do not do it. Advising a follow-up
 *   is authorship and lives on the encounter; chasing one is administration.
 */
import {
  clinicalEpisodeDetail,
  clinicalEpisodeListResponse,
  clinicalEpisodeSummary,
  clinicalMasterItem,
  clinicalMasterListResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  APPOINTMENT_ID,
  BRANCH_ID,
  CLINICAL_TERM_ID,
  EPISODE_CODE,
  EPISODE_ID,
  PATIENT,
  PATIENT_ID,
  RECOMMENDATION_ID,
  SPECIALTY_GENERAL_MEDICINE_ID,
} from './fixtures.js';

const MASTER_EXAMPLE = {
  id: CLINICAL_TERM_ID,
  kind: 'DIAGNOSIS',
  code: 'ACUTE_PHARYNGITIS',
  name: 'Acute pharyngitis',
  description: null,
  parentId: null,
  displayOrder: 0,
  isActive: true,
  isOwn: false,
  codings: [
    { system: 'ICD10', code: 'J02.9', display: 'Acute pharyngitis, unspecified', isPrimary: true },
  ],
};

const EPISODE_EXAMPLE = {
  id: EPISODE_ID,
  code: EPISODE_CODE,
  title: 'Recurrent sore throat',
  status: 'OPEN',
  patientId: PATIENT_ID,
  primarySpecialtyId: SPECIALTY_GENERAL_MEDICINE_ID,
  primarySpecialtyName: 'General Medicine',
  openedOn: '2026-03-17',
  closedOn: null,
  appointmentCount: 1,
};

export const clinicalDocs: DocRegistry = {
  'GET /api/v1/clinical-data': {
    summary: 'Search the clinical vocabulary',
    description: `
The dictionary a consultation picks its terms from — symptoms, diagnoses,
procedures, investigations, one \`kind\` at a time.

⚠️ **Read behind \`appointment.read\`, not the code that EDITS it.** Every screen
that renders a diagnosis needs its NAME. Gating the dictionary behind the manage
code means a receptionist sees uuids where the words should be, and a doctor
cannot pick a symptom without also being allowed to invent one.

**No patient is named or implied**, so this is not audited and not PHI.

\`codings\` carries the external code systems a term maps to — ICD-10 and
friends — with at most one \`isPrimary\`. \`isOwn\` separates the terms rcln
ships from those this clinic added.

### Scope: ranked by default, filtered on request

\`specialtyIds\` names one or more taxonomy nodes — a care context, a domain, a
specialty. By default it **ranks**: matching terms sort first and everything else
follows, so a term nobody remembered to tag is still findable. That is
deliberate; a hard filter would make an untagged diagnosis invisible with no
error and nothing to notice.

\`onlyScoped=true\` makes it a filter, which is what a browsable picker wants —
a dentist opening the symptom list should see the dental ones, not the whole of
medicine. **A caller that narrows is responsible for offering the way back out.**
\`apps/web\` re-runs the search unscoped when nothing in scope matched and tells
the clinician it has done so.

⚠️ **A node means its whole branch, in both directions.** \`DEN\` matches a term
tagged \`DEN\`, one tagged \`ENDODONTICS\` beneath it, and one tagged \`HUMAN\`
above it — so a clinic tags once at the level it means, and a general term stays
visible inside a narrowed list.
`.trim(),
    response: clinicalMasterListResponse,
    paginated: true,
    params: {
      kind: 'Which dictionary — `SYMPTOM`, `DIAGNOSIS`, `PROCEDURE`, `INVESTIGATION`. Required.',
      search: 'Free-text match on name and code.',
      specialtyIds:
        'Taxonomy nodes, comma-separated. Ranks matching terms first; a node covers its whole branch.',
      onlyScoped:
        'Return only terms in scope. Defaults to `false` — see the note above before turning it on.',
      parentId: 'Narrow to children of one term.',
      includeInactive: 'Include retired terms. Defaults to `false`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page, up to 100. Defaults to 25.',
    },
    responseExamples: [
      {
        summary: 'Searching diagnoses for "pharyn"',
        value: {
          success: true,
          message: 'Success',
          data: { items: [MASTER_EXAMPLE], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'POST /api/v1/clinical-data': {
    summary: 'Add a term to the vocabulary',
    description: `
Add a clinical term of this clinic's own.

Behind \`clinical.master.manage\` — an existing code that until this surface
gated nothing. Inventing \`vocabulary.*\` codes would have meant a second answer
to "who curates the clinical masters" and a role matrix that has to be kept in
step with itself.

\`code\` is upper-case letters, digits and underscores, unique within this clinic
for that \`kind\`. \`codings\` maps the term onto external systems so the record
is exportable; at most one may be \`isPrimary\`.

\`specialtyIds\` decides which specialties offer this term in their pickers.
Omitted, it is offered everywhere.
`.trim(),
    response: clinicalMasterItem,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A diagnosis with an ICD-10 mapping',
        value: {
          kind: 'DIAGNOSIS',
          code: 'ACUTE_PHARYNGITIS',
          name: 'Acute pharyngitis',
          codings: [{ system: 'ICD10', code: 'J02.9', isPrimary: true }],
          specialtyIds: [SPECIALTY_GENERAL_MEDICINE_ID],
        },
      },
      {
        summary: 'A local symptom with no external code',
        value: { kind: 'SYMPTOM', code: 'POST_NASAL_DRIP', name: 'Post-nasal drip' },
      },
    ],
    responseExamples: [
      {
        summary: 'Added',
        value: { success: true, message: 'Success', data: { ...MASTER_EXAMPLE, isOwn: true } },
      },
    ],
  },

  'PATCH /api/v1/clinical-data/{itemId}': {
    summary: 'Update a vocabulary term',
    description: `
Rename a term, re-describe it, reorder it, or change which specialties offer it.

**\`kind\`, \`code\` and \`codings\` are not editable.** A term that means
something different is a different term — consultations already cite this one,
and changing what it means underneath them would silently rewrite records that
have been signed.

A term rcln ships cannot be edited. \`specialtyIds\` replaces the set.
`.trim(),
    response: clinicalMasterItem,
    errors: [403, 409],
    params: { itemId: 'The term, as `GET /api/v1/clinical-data` lists it.' },
    requestExamples: [
      { summary: 'Rename', value: { name: 'Acute pharyngitis (sore throat)' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Success',
          data: { ...MASTER_EXAMPLE, name: 'Acute pharyngitis (sore throat)', isOwn: true },
        },
      },
    ],
  },

  'DELETE /api/v1/clinical-data/{itemId}': {
    summary: 'Deactivate a vocabulary term',
    description: `
Retire a term this clinic added.

⚠️ **A deactivation, not a delete.** Signed consultations cite this term, and a
diagnosis that vanished would take their meaning with it. The term stops being
offered in pickers and stays attached to every record that already uses it.

A term rcln ships cannot be retired by a clinic.
`.trim(),
    errors: [403, 409],
    params: { itemId: 'The term, as `GET /api/v1/clinical-data` lists it.' },
    responseExamples: [
      {
        summary: 'Deactivated',
        value: { success: true, message: 'Success', data: { deactivated: true } },
      },
    ],
  },

  'GET /api/v1/clinical-episodes': {
    summary: 'List treatment episodes',
    description: `
A patient's courses of treatment — the thread that ties several visits into one
story.

⚠️ **PHI: this names a patient and writes a \`data_access_logs\` row** under
\`CLINICAL_EPISODE\`. Behind \`appointment.read\`, because picking an episode is
something the front desk does while booking.

Always filtered to one patient and always paginated. \`appointmentCount\` is what
lets a booking screen show "3rd visit of this episode" without a second call.
`.trim(),
    response: clinicalEpisodeListResponse,
    phi: true,
    paginated: true,
    params: {
      patientId: 'Whose episodes to list. Required.',
      status: 'Filter to `OPEN` or `CLOSED`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'One open episode',
        value: {
          success: true,
          message: 'Success',
          data: { episodes: [EPISODE_EXAMPLE], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'POST /api/v1/clinical-episodes': {
    summary: 'Open a treatment episode',
    description: `
Start a new course of treatment for a patient.

Behind \`appointment.create\`: opening an episode is what the front desk does
when a patient arrives about something new, and the desk holds no clinical code.

\`title\` is optional and is the human label — "Recurrent sore throat" — that
makes a list of episodes readable. \`primarySpecialtyId\` files the episode under
a specialty.

Most episodes are opened implicitly by booking an appointment without one; this
endpoint exists for the cases where the episode is decided first.
`.trim(),
    response: clinicalEpisodeDetail,
    status: 201,
    phi: true,
    errors: [409],
    requestExamples: [
      {
        summary: 'A named episode',
        value: {
          patientId: PATIENT_ID,
          title: 'Recurrent sore throat',
          primarySpecialtyId: SPECIALTY_GENERAL_MEDICINE_ID,
        },
      },
      { summary: 'Unnamed', value: { patientId: PATIENT_ID } },
    ],
    responseExamples: [
      { summary: 'Opened', value: { success: true, message: 'Success', data: EPISODE_EXAMPLE } },
    ],
  },

  'GET /api/v1/clinical-episodes/{episodeId}': {
    summary: 'Get a treatment episode',
    description:
      'One course of treatment with the visits that belong to it. **PHI** — names a patient and writes a `data_access_logs` row.',
    response: clinicalEpisodeSummary,
    phi: true,
    params: { episodeId: 'The episode, as `GET /api/v1/clinical-episodes` lists it.' },
    responseExamples: [
      {
        summary: 'An open episode',
        value: { success: true, message: 'Success', data: EPISODE_EXAMPLE },
      },
    ],
  },

  'PATCH /api/v1/clinical-episodes/{episodeId}': {
    summary: 'Update or close an episode',
    description: `
Rename an episode, refile it under a different specialty, or close it.

**Closing sets \`closedOn\` and stops the episode being offered when booking.**
It does not touch the visits already in it, and a closed episode can be reopened
by setting \`status\` back to \`OPEN\` — a course of treatment that resumes is
the same course of treatment.

Behind \`appointment.update\`.
`.trim(),
    phi: true,
    errors: [409],
    params: { episodeId: 'The episode, as `GET /api/v1/clinical-episodes` lists it.' },
    requestExamples: [
      { summary: 'Close it', value: { status: 'CLOSED' } },
      { summary: 'Rename it', value: { title: 'Recurrent tonsillitis' } },
    ],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Success', data: { updated: true } } },
    ],
  },

  'GET /api/v1/follow-up-recommendations': {
    summary: 'List the recall list',
    description: `
Who was told to come back and has not.

⚠️ **Behind \`appointment.read\`, not a clinical code, and that split is exactly
invariant 7's.** This list is worked by the front desk: somebody rings the
patient and books them in. The desk holds no clinical code at all, so gating the
recall list behind \`clinical.encounter.read\` would mean the only people who can
work it are the people who do not do that job. The recommendation **itself** is
written from the consultation, behind \`clinical.encounter.create\` — advising a
follow-up is authorship, chasing one is administration.

⚠️ **It carries the patient's NAME and PHONE, which the recommendation itself
does not.** The desk is about to telephone somebody, and a list of uuids is a
list nobody can act on. That is precisely why reading it writes a
\`data_access_logs\` row under \`PATIENT_LIST\` — a list of who is under ongoing
treatment for what **is** the disclosure.

**Always paginated and always filtered to a window; there is deliberately no
"give me everything" form.** \`status\` defaults to \`DUE\`; \`withinDays\`
decides how far ahead \`UPCOMING\` looks.
`.trim(),
    phi: true,
    paginated: true,
    params: {
      status:
        'Which slice of the list — `DUE`, `UPCOMING`, `FULFILLED`, `CANCELLED`. Defaults to `DUE`.',
      patientId: 'Narrow to one patient.',
      branchId: 'Narrow to one branch.',
      withinDays: 'How far ahead `UPCOMING` reaches, in days. Defaults to 30, capped at 365.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'Two weeks of recalls now due',
        value: {
          success: true,
          message: 'Success',
          data: {
            recommendations: [
              {
                id: RECOMMENDATION_ID,
                patientId: PATIENT_ID,
                patientName: PATIENT.fullName,
                patientPhone: PATIENT.phone,
                branchId: BRANCH_ID,
                sourceAppointmentId: APPOINTMENT_ID,
                intervalValue: 2,
                intervalUnit: 'WEEKS',
                dueOn: '2026-03-31',
                reason: 'Review after antibiotics',
                status: 'DUE',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'POST /api/v1/follow-up-recommendations/{recommendationId}/cancel': {
    summary: 'Cancel a recall',
    description: `
Take somebody off the recall list — they have been reached and declined, or the
recall is no longer clinically relevant.

Behind \`appointment.update\`, for the reason the list itself is: this is the
desk closing off a task, not a clinician revising advice. **The recommendation
recorded on the consultation is not altered** — what the doctor advised stays
what the doctor advised; only the chase is called off.

A recall fulfilled by an actual booking closes itself, through
\`fulfilsRecommendationId\` on \`POST /api/v1/appointments/{appointmentId}/follow-up\`.
This endpoint is for the ones that will never be booked.
`.trim(),
    phi: true,
    errors: [409],
    params: {
      recommendationId: 'The recall, as `GET /api/v1/follow-up-recommendations` lists it.',
    },
    requestExamples: [
      { summary: 'Patient declined', value: { reason: 'Patient declined — symptoms resolved' } },
      { summary: 'Without a reason', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Cancelled',
        value: { success: true, message: 'Success', data: { cancelled: true } },
      },
    ],
  },
};
