/**
 * Appointments — the day board, the availability engine, and the observations
 * taken before the doctor is reached.
 *
 * ⚠️ PHI, AND NOT OBVIOUSLY SO. A patient, a doctor and a reason disclose far
 *   more together than any one of them alone: "Ravi Subramanian, oncology,
 *   Tuesday" is a diagnosis. The reads that name a patient write a
 *   `data_access_logs` row; the availability endpoints, which name nobody, do
 *   not.
 *
 * ⚠️ THREE PERMISSIONS SHAPE ONE SCREEN. `appointment.read` opens the day board,
 *   `doctor.directory.read` decides WHOSE bookings are on it, and
 *   `billing.invoice.read` decides whether it carries a billing column. None of
 *   them is a role check — a doctor gets their own diary and the front desk gets
 *   the branch's, from one rule expressed once.
 */
import {
  appointmentDetail,
  appointmentListResponse,
  availabilityResponse,
  vitalsListResponse,
  vitalsReading,
  vitalsRevisionsResponse,
  workingDaysResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  APPOINTMENT_AT,
  APPOINTMENT_ID,
  APPOINTMENT_NUMBER,
  BRANCH_ID,
  CONSULTATION_FEE_PAISE,
  DOCTOR,
  DOCTOR_ID,
  EPISODE_CODE,
  EPISODE_ID,
  FOLLOW_UP_APPOINTMENT_ID,
  FOLLOW_UP_NUMBER,
  INVOICE_ID,
  PATIENT,
  PATIENT_ID,
  RECOMMENDATION_ID,
  RECEPTIONIST,
  STATUS_EVENT_ID,
  TODAY,
  VITALS_ID,
  VITALS_REVISION_ID,
} from './fixtures.js';

const APPOINTMENT_NOTE =
  'The appointment, as `GET /api/v1/appointments` lists it. One belonging to another clinic is answered `404`.';

const SUMMARY = {
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
  status: 'BOOKED',
  checkedInAt: null,
};

const DETAIL = {
  ...SUMMARY,
  status: 'CHECKED_IN',
  checkedInAt: '2026-03-17T03:52:00.000Z',
  reason: 'Fever and sore throat for three days',
  cancellationReason: null,
  startedAt: null,
  completedAt: null,
  mrn: PATIENT.mrn,
  parentAppointmentId: null,
  parentAppointmentNumber: null,
  clinicalEpisodeId: EPISODE_ID,
  clinicalEpisodeCode: EPISODE_CODE,
  followUps: [],
  statusHistory: [
    {
      id: STATUS_EVENT_ID,
      fromStatus: 'BOOKED',
      toStatus: 'CHECKED_IN',
      changedBy: RECEPTIONIST.membershipId,
      changedByName: RECEPTIONIST.fullName,
      note: null,
      changedAt: '2026-03-17T03:52:00.000Z',
    },
  ],
};

const READING = {
  id: VITALS_ID,
  appointmentId: APPOINTMENT_ID,
  patientId: PATIENT_ID,
  heightCm: 172,
  weightKg: 78.5,
  bmi: 26.5,
  temperatureC: 38.4,
  pulseBpm: 96,
  respiratoryRateBpm: 18,
  systolicMmHg: 132,
  diastolicMmHg: 84,
  spo2Percent: 97,
  bloodGlucoseMgDl: null,
  notes: null,
  recordedAt: '2026-03-17T03:55:00.000Z',
  recordedBy: RECEPTIONIST.membershipId,
  recordedByName: RECEPTIONIST.fullName,
};

export const appointmentDocs: DocRegistry = {
  'GET /api/v1/appointments/availability': {
    summary: 'Get free slots for a day',
    description: `
Every slot in one doctor's day at one branch, each marked free or taken, and
taken *why*.

⚠️ **A \`GET\`, unlike the patient search — deliberately.** A branch, a doctor
and a date are nobody's surname, so none of them is a disclosure in a proxy log
or a browser history. The search that takes a patient name is a \`POST\` for
exactly that reason.

The response carries the **branch's** timezone, and \`startsAt\`/\`endsAt\` are
UTC instants. Render them in \`timezone\`, never the browser's — that is
invariant 6, and a slot picker that gets it wrong books people at the wrong hour.

\`notWorking: true\` means the doctor has no block that day at all, which is
different from a day whose slots are all \`BOOKED\`. \`reason\` distinguishes
\`BOOKED\`, \`PAST\`, \`ON_LEAVE\`, \`BRANCH_CLOSED\` and \`BLOCK_FULL\` — the
last being a block that has hit its \`maxPatients\` cap while slots technically
remain.
`.trim(),
    response: availabilityResponse,
    params: {
      branchId: 'Which branch to look at.',
      doctorProfileId: "The doctor's profile id.",
      date: "The day, as `YYYY-MM-DD` in the **branch's** timezone — not UTC, and not the browser's.",
    },
    responseExamples: [
      {
        summary: 'A morning with one slot gone',
        value: {
          success: true,
          message: 'Success',
          data: {
            branchId: BRANCH_ID,
            doctorProfileId: DOCTOR_ID,
            date: TODAY,
            timezone: 'Asia/Kolkata',
            slotMinutes: 15,
            notWorking: false,
            slots: [
              {
                startsAt: '2026-03-17T03:30:00.000Z',
                endsAt: APPOINTMENT_AT,
                available: true,
                reason: null,
              },
              {
                startsAt: APPOINTMENT_AT,
                endsAt: '2026-03-17T04:15:00.000Z',
                available: false,
                reason: 'BOOKED',
              },
              {
                startsAt: '2026-03-17T04:15:00.000Z',
                endsAt: '2026-03-17T04:30:00.000Z',
                available: true,
                reason: null,
              },
            ],
          },
        },
      },
      {
        summary: 'The doctor does not work that day',
        description:
          'Not the same as a full day — there is no block at all, so there are no slots.',
        value: {
          success: true,
          message: 'Success',
          data: {
            branchId: BRANCH_ID,
            doctorProfileId: DOCTOR_ID,
            date: '2026-03-22',
            timezone: 'Asia/Kolkata',
            slotMinutes: 15,
            notWorking: true,
            slots: [],
          },
        },
      },
    ],
  },

  'GET /api/v1/appointments/availability/days': {
    summary: 'Get bookable days',
    description: `
Which days in a range this doctor can be booked on at all — what a date picker
greys out before anybody chooses a day.

Answers one row per date with \`bookable\` and, when false, the reason:
\`PAST\`, \`NOT_SCHEDULED\`, \`ON_LEAVE\` or \`BRANCH_CLOSED\`. Distinguishing
them is what lets the picker say "on leave" rather than silently disabling a
date.

**\`bookable: true\` does not promise a free slot** — only that the doctor works
and the branch is open. Whether anything is actually free is
\`GET /appointments/availability\` for that day.

The range is capped at 62 days.
`.trim(),
    response: workingDaysResponse,
    params: {
      branchId: 'Which branch to look at.',
      doctorProfileId: "The doctor's profile id.",
      from: "First day of the range, `YYYY-MM-DD` in the branch's timezone.",
      to: 'Last day of the range, inclusive. At most 62 days from `from`.',
    },
    responseExamples: [
      {
        summary: 'A week, with the weekend and one leave day closed',
        value: {
          success: true,
          message: 'Success',
          data: {
            branchId: BRANCH_ID,
            doctorProfileId: DOCTOR_ID,
            timezone: 'Asia/Kolkata',
            days: [
              { date: '2026-03-16', bookable: true, reason: null },
              { date: TODAY, bookable: true, reason: null },
              { date: '2026-03-18', bookable: false, reason: 'ON_LEAVE' },
              { date: '2026-03-19', bookable: true, reason: null },
              { date: '2026-03-20', bookable: true, reason: null },
              { date: '2026-03-21', bookable: false, reason: 'NOT_SCHEDULED' },
              { date: '2026-03-22', bookable: false, reason: 'BRANCH_CLOSED' },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/appointments': {
    summary: 'List the day board',
    description: `
The bookings at one branch on one day, or across a range of up to 45 days.

⚠️ **\`appointment.read\` OPENS THIS; \`doctor.directory.read\` DECIDES WHOSE
BOOKINGS ARE ON IT.** A caller who may not enumerate the clinic's practitioners
may not read across them either — so a doctor gets their own diary and the front
desk gets the branch's. A \`403\` would be the wrong answer for the doctor (the
screen is theirs, the scope is narrower) and returning the whole branch's day
would disclose every colleague's list, so the permission **narrows the query
instead of ending the request**.

That narrowing is an override, not a default: \`?doctorProfileId=<a colleague>\`
cannot widen it back out.

⚠️ **A THIRD PERMISSION ADDS A COLUMN RATHER THAN ROWS.** Whether a visit is
already billed is billing information, so \`liveInvoice\` appears only for a
caller holding \`billing.invoice.read\` — and is **omitted entirely** otherwise,
because a doctor shown \`null\` on every row would read the board as "nothing has
been billed today".

Every read here writes a \`data_access_logs\` row.
`.trim(),
    response: appointmentListResponse,
    phi: true,
    params: {
      branchId: "Which branch's board to read.",
      date: "The day, `YYYY-MM-DD` in the branch's timezone. With `to`, the first day of a range.",
      to: 'Last day of a range, inclusive. At most 45 days from `date`.',
      doctorProfileId:
        'Narrow to one doctor. Cannot widen a caller who is already confined to their own diary.',
      status: 'Filter by booking status.',
    },
    responseExamples: [
      {
        summary: 'The front desk view, with billing',
        description: 'Caller holds `doctor.directory.read` and `billing.invoice.read`.',
        value: {
          success: true,
          message: 'Success',
          data: {
            appointments: [
              {
                ...SUMMARY,
                status: 'CHECKED_IN',
                checkedInAt: '2026-03-17T03:52:00.000Z',
                liveInvoice: { id: INVOICE_ID, status: 'DRAFT' },
              },
            ],
          },
        },
      },
      {
        summary: "A doctor's own diary",
        description:
          'No `doctor.directory.read` and no `billing.invoice.read`: their bookings only, and **no** `liveInvoice` key at all.',
        value: {
          success: true,
          message: 'Success',
          data: {
            appointments: [
              { ...SUMMARY, status: 'CHECKED_IN', checkedInAt: '2026-03-17T03:52:00.000Z' },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/appointments': {
    summary: 'Book an appointment',
    description: `
Take a booking.

\`startsAt\` is a **UTC instant**, not a wall time — send \`2026-03-17T04:00:00Z\`
for 09:30 at a clinic in Asia/Kolkata. The slot must be one the availability
engine offers; booking over a taken slot, a closed branch or a doctor's leave is
\`409\`.

\`durationMinutes\` omitted takes the doctor's slot length for that block, which
is itself inherited from the branch unless the block overrides it.

\`clinicalEpisodeId\` attaches this visit to an existing episode — a course of
treatment already under way. Omitted, a new episode is opened, so every visit
belongs to exactly one.

\`visitType\` defaults to \`NEW\`; \`source\` records where the booking came from
and defaults to \`FRONT_DESK\`.
`.trim(),
    response: appointmentDetail,
    status: 201,
    message: 'Appointment booked',
    phi: true,
    errors: [409, 422],
    requestExamples: [
      {
        summary: 'A new patient at 09:30 clinic time',
        description: '04:00Z is 09:30 in Asia/Kolkata. The wire is always UTC.',
        value: {
          branchId: BRANCH_ID,
          patientId: PATIENT_ID,
          doctorProfileId: DOCTOR_ID,
          startsAt: APPOINTMENT_AT,
          visitType: 'NEW',
          reason: 'Fever and sore throat for three days',
        },
      },
      {
        summary: 'A longer slot, booked by phone',
        value: {
          branchId: BRANCH_ID,
          patientId: PATIENT_ID,
          doctorProfileId: DOCTOR_ID,
          startsAt: APPOINTMENT_AT,
          durationMinutes: 30,
          visitType: 'FOLLOW_UP',
          source: 'PHONE',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Booked',
        value: {
          success: true,
          message: 'Appointment booked',
          data: {
            ...DETAIL,
            status: 'BOOKED',
            checkedInAt: null,
            statusHistory: [],
          },
        },
      },
    ],
  },

  'GET /api/v1/appointments/{appointmentId}': {
    summary: 'Get an appointment',
    description:
      'One booking in full: the patient, the doctor, the reason, every status change with who made it, the episode it belongs to and any follow-ups booked out of it. **Mutates nothing** — this is the path an administrator uses to read a visit, as distinct from `POST /{appointmentId}/consultation`, which starts one.',
    response: appointmentDetail,
    phi: true,
    params: { appointmentId: APPOINTMENT_NOTE },
    responseExamples: [
      { summary: 'A checked-in visit', value: { success: true, message: 'Success', data: DETAIL } },
    ],
  },

  'GET /api/v1/appointments/{appointmentId}/billing': {
    summary: 'Preview what this visit would be billed',
    description: `
The fee this visit attracts off the doctor's rate card, and which invoice it is
already on.

⚠️ **Behind \`billing.invoice.read\`, NOT \`appointment.read\`, and it is
mounted here only because the path reads better.** Everything it answers is
billing — a doctor who may open the chart does not thereby learn what the clinic
charged for it.

⚠️ **No \`data_access_logs\` row.** It carries ids, a fee and an invoice state —
no name, no line description, nothing clinical. The bill itself is
\`GET /api/v1/invoices/{invoiceId}\`, which does log.

\`followUpFree\` reflects the doctor's per-branch free-follow-up window: inside
it a return visit prices at zero, and the preview says so before anybody raises
the bill.
`.trim(),
    params: { appointmentId: APPOINTMENT_NOTE },
    responseExamples: [
      {
        summary: 'Not yet invoiced',
        value: {
          success: true,
          message: 'Success',
          data: {
            appointmentId: APPOINTMENT_ID,
            currency: 'INR',
            feeType: 'CONSULTATION',
            amountMinor: CONSULTATION_FEE_PAISE,
            followUpFree: false,
            invoice: null,
          },
        },
      },
      {
        summary: 'Already on a draft invoice',
        value: {
          success: true,
          message: 'Success',
          data: {
            appointmentId: APPOINTMENT_ID,
            currency: 'INR',
            feeType: 'CONSULTATION',
            amountMinor: CONSULTATION_FEE_PAISE,
            followUpFree: false,
            invoice: { id: INVOICE_ID, status: 'DRAFT' },
          },
        },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/invoice': {
    summary: 'Raise the bill for this visit',
    description: `
Create the invoice for one visit, with the consultation fee already on it.

⚠️ **\`billing.invoice.create\` — the same code as \`POST /api/v1/invoices\`,
and there is deliberately no \`appointment.invoice.create\`.** This is a shortcut
through that endpoint: same table, same lifecycle, same number series. A second
code would record a distinction the permission matrix carries and nobody uses.

Answers with the **priced draft** rather than an echo of the request — the whole
point is the engine's numbers, and echoing back what the cashier typed would show
them their own figures and hide the tax.

A visit that already has a live invoice is \`409\`.
`.trim(),
    status: 201,
    phi: true,
    errors: [409, 422],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      { summary: 'Just the consultation', value: {} },
      {
        summary: 'With an extra line',
        value: {
          lines: [{ description: 'Dressing', quantity: 1, unitPriceMinor: 15000 }],
        },
      },
    ],
  },

  'PATCH /api/v1/appointments/{appointmentId}': {
    summary: 'Update an appointment',
    description:
      'Correct the visit type or the reason for attending. **Not how a booking is moved** — that is `POST /{appointmentId}/reschedule`, which checks the new slot is actually free — and not how it is cancelled.',
    response: appointmentDetail,
    message: 'Appointment updated',
    phi: true,
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      { summary: 'Correct the reason', value: { reason: 'Fever, sore throat and body ache' } },
      { summary: 'It was a follow-up after all', value: { visitType: 'FOLLOW_UP' } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Appointment updated', data: DETAIL },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/reschedule': {
    summary: 'Move an appointment',
    description: `
Move a booking to a different slot, keeping the same appointment record and
number.

The new slot is checked against availability exactly as a fresh booking is —
moving onto a taken slot, a closed branch or a doctor's leave is \`409\`. The
doctor may change; the patient may not.

\`initiatedBy\` records whether the **patient** or the **clinic** asked for the
move. It is not bookkeeping: a clinic that reschedules people repeatedly and one
whose patients do are different problems, and the reports can only tell them
apart if this is set honestly.

The status history keeps the move, so the original time is not lost.
`.trim(),
    response: appointmentDetail,
    message: 'Appointment moved',
    phi: true,
    errors: [409, 422],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      {
        summary: 'The patient asked to move',
        value: {
          startsAt: '2026-03-19T05:00:00.000Z',
          initiatedBy: 'PATIENT',
          reason: 'Travelling that morning',
        },
      },
      {
        summary: 'The clinic moved it to another doctor',
        value: {
          startsAt: '2026-03-17T06:00:00.000Z',
          doctorProfileId: DOCTOR_ID,
          initiatedBy: 'CLINIC',
          reason: 'Dr Krishnan called away',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Moved',
        value: {
          success: true,
          message: 'Appointment moved',
          data: {
            ...DETAIL,
            scheduledStart: '2026-03-19T05:00:00.000Z',
            scheduledEnd: '2026-03-19T05:15:00.000Z',
          },
        },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/status': {
    summary: 'Move a booking through its statuses',
    description: `
Advance a booking: \`CONFIRMED\`, \`CHECKED_IN\`, \`IN_PROGRESS\`,
\`COMPLETED\`.

⚠️ **\`appointment.checkin\` — which is NOT \`appointment.cancel\`.** Moving a
booking forward is an administrative act; recording that somebody did not turn
up is a statement about the patient that follows them into the no-show reports.
A receptionist holds the first without the second.

Transitions are validated: a booking cannot go from \`BOOKED\` straight to
\`COMPLETED\`, and a cancelled one cannot be moved at all.

Recording vitals may check a patient in as a side effect, so this is not the only
route to \`CHECKED_IN\`. Starting the consultation moves it to \`IN_PROGRESS\`
the same way.
`.trim(),
    response: appointmentDetail,
    message: 'Appointment updated',
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      { summary: 'Check the patient in', value: { status: 'CHECKED_IN' } },
      {
        summary: 'Close the visit',
        value: { status: 'COMPLETED', note: 'Left with a prescription' },
      },
    ],
    responseExamples: [
      {
        summary: 'Checked in',
        value: { success: true, message: 'Appointment updated', data: DETAIL },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/cancel': {
    summary: 'Cancel an appointment',
    description: `
Record that a booking will not happen.

⚠️ **A cancellation is a FACT, kept forever.** The row stays, the slot is
released, and the reason is recorded — this is not how a mis-click is undone.
That is \`DELETE\`, behind a different permission, precisely so the utilisation
and no-show reports can tell the two apart.

\`reason\` is required and is shown to whoever asks why the slot came free.

A visit already completed or cancelled is \`409\`.
`.trim(),
    response: appointmentDetail,
    message: 'Appointment cancelled',
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      { summary: 'The patient called off', value: { reason: 'Patient unwell, will rebook' } },
    ],
    responseExamples: [
      {
        summary: 'Cancelled',
        value: {
          success: true,
          message: 'Appointment cancelled',
          data: {
            ...DETAIL,
            status: 'CANCELLED',
            cancellationReason: 'Patient unwell, will rebook',
          },
        },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/no-show': {
    summary: 'Mark a patient as not attended',
    description: `
Record that the patient did not turn up.

⚠️ **Behind \`appointment.cancel\`, not \`appointment.checkin\`, and that split
is the point.** This is a statement *about the patient* that follows them into
the no-show reports and may affect whether they can book online. A receptionist
who may move bookings forward should not be able to make it without being given
that permission deliberately.

Only a booking whose time has passed can be marked this way.
`.trim(),
    response: appointmentDetail,
    message: 'Marked as not attended',
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      { summary: 'With a note', value: { note: 'Telephone unreachable' } },
      { summary: 'Without one', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Marked',
        value: {
          success: true,
          message: 'Marked as not attended',
          data: { ...DETAIL, status: 'NO_SHOW' },
        },
      },
    ],
  },

  'DELETE /api/v1/appointments/{appointmentId}': {
    summary: 'Withdraw a booking made in error',
    description: `
Erase a mis-click before it pollutes the reports.

⚠️ **\`appointment.delete\`, WHICH IS NOT \`appointment.cancel\`.** A
cancellation is a fact about a patient who called off; this is the undo for a
booking that should never have existed. Whoever may do the second should not
automatically be able to do the first, or the utilisation and no-show reports
stop distinguishing them.

The service narrows it much further than the permission can: **future only,
\`BOOKED\` only, and nothing hanging off it** — a booking with follow-ups is
refused. It is a soft delete when it does go through.

⚠️ **\`204\`, with no body.** There is nothing meaningful to return, and echoing
the deleted booking back would be handing out PHI on the way out of the door.
`.trim(),
    status: 204,
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
  },

  'POST /api/v1/appointments/{appointmentId}/follow-up': {
    summary: 'Book the next visit',
    description: `
Book a continuation of this visit.

**The patient and the branch come off the parent, not the body**, so this cannot
be used to book for somebody else while looking like a continuation. The new
booking joins the parent's clinical episode.

⚠️ **\`fulfilsRecommendationId\` ticks off a recall the doctor asked for — and
this is still \`appointment.create\`, not a clinical code.** Recording that a
booking satisfies a recommendation is a fact about a BOOKING, made by whoever
takes it: the front desk, on the telephone, weeks after the visit. The desk holds
no clinical code at all, and requiring one here would mean the recall list could
only be worked by clinicians.
`.trim(),
    response: appointmentDetail,
    status: 201,
    message: 'Follow-up booked',
    phi: true,
    errors: [409, 422],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      {
        summary: 'A review in a fortnight',
        value: { startsAt: '2026-03-31T04:00:00.000Z', reason: 'Review after antibiotics' },
      },
      {
        summary: 'Fulfilling the recall the doctor asked for',
        value: {
          startsAt: '2026-03-31T04:00:00.000Z',
          fulfilsRecommendationId: RECOMMENDATION_ID,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Booked',
        value: {
          success: true,
          message: 'Follow-up booked',
          data: {
            ...DETAIL,
            id: FOLLOW_UP_APPOINTMENT_ID,
            appointmentNumber: FOLLOW_UP_NUMBER,
            status: 'BOOKED',
            checkedInAt: null,
            visitType: 'FOLLOW_UP',
            scheduledStart: '2026-03-31T04:00:00.000Z',
            scheduledEnd: '2026-03-31T04:15:00.000Z',
            parentAppointmentId: APPOINTMENT_ID,
            parentAppointmentNumber: APPOINTMENT_NUMBER,
            statusHistory: [],
          },
        },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/consultation': {
    summary: 'Start the consultation',
    description: `
Take the patient in: moves a \`CHECKED_IN\` booking to \`IN_PROGRESS\` so the day
board reflects a doctor who has started, without anybody pressing a button.

⚠️ **A \`POST\` BECAUSE IT MUTATES.** A \`GET\` that silently transitions state
is a trap for every cache and prefetch between here and the browser.

⚠️ **Behind \`clinical.encounter.create\`, not \`.read\` — it used to be the read
code and that was wrong.** With the read code, an administrator opening a booking
to look at it would MOVE THE PATIENT TO "with the doctor" on the day board, from
a page they only came to read. Starting a visit is the first act of authoring the
consultation, so it asks for the authoring code — which among the system roles is
DOCTOR alone.

Everyone else reads the same visit through \`GET /api/v1/appointments/{appointmentId}\`,
which mutates nothing.
`.trim(),
    response: appointmentDetail,
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
    responseExamples: [
      {
        summary: 'Started',
        value: {
          success: true,
          message: 'Success',
          data: { ...DETAIL, status: 'IN_PROGRESS', startedAt: '2026-03-17T04:04:00.000Z' },
        },
      },
    ],
  },

  'GET /api/v1/appointments/{appointmentId}/consultation-config': {
    summary: 'Get the consultation form configuration',
    description: `
What this consultation is made of: the resolved section layout, the field
descriptors, and which vocabularies to rank.

⚠️ **A \`GET\`, and it mutates nothing** — that is the entire difference between
it and \`POST /{appointmentId}/consultation\`. The screen reads its configuration
before the doctor has decided to start, so it must be safe for every cache and
prefetch in between.

⚠️ **Behind \`clinical.encounter.read\`, not \`clinical.template.manage\`.** The
doctor about to consult holds the first and not the second — configuring a
consultation is not conducting one. An administrator reading a consultation for
oversight resolves the same configuration, which is what makes the record render
for them at all.

⚠️ **No \`data_access_logs\` row, and that is a decision.** This discloses
section labels and field descriptors — no clinical content whatever about the
person in the chair. Burying the reads that *do* disclose a patient under a row
per screen-open is the same mistake as auditing the day board.
`.trim(),
    phi: false,
    params: { appointmentId: APPOINTMENT_NOTE },
  },

  'GET /api/v1/appointments/{appointmentId}/encounter': {
    summary: 'Get the consultation recorded at this visit',
    description: `
The written-up consultation, or \`null\` when there is not one yet.

⚠️ **A \`GET\` THAT CREATES NOTHING, and that is why it exists beside
\`POST /api/v1/encounters\`.** Opening a draft is an act of authorship: an
administrator arriving to read a booking must not thereby make "the doctor
started a consultation" true. So the reader's path is this route, behind
\`clinical.encounter.read\`, and it answers \`null\` rather than opening
anything.

Discloses the clinical record of one named patient, so it is audited.
`.trim(),
    phi: true,
    params: { appointmentId: APPOINTMENT_NOTE },
  },

  'GET /api/v1/appointments/{appointmentId}/previous-visit': {
    summary: 'Get the previous visit in this episode',
    description:
      "What was recorded last time, so the doctor can see the course of treatment without leaving the consultation screen. Answers `null` when this is the first visit of the episode. Discloses one named patient's clinical record, so it is audited.",
    phi: true,
    params: { appointmentId: APPOINTMENT_NOTE },
  },

  'GET /api/v1/appointments/{appointmentId}/vitals': {
    summary: 'Read the observations taken at this visit',
    description: `
Every set of observations recorded at this visit, in the order taken.

⚠️ **\`clinical.vitals.read\`, which is NOT \`clinical.encounter.read\`.** Using
the encounter code here would hand the front desk the doctor's conclusions along
with the blood pressure. The nurse and the desk hold this one; so does the
doctor.

**Readings accumulate rather than replace.** A repeat blood pressure twenty
minutes later is a second entry in this list, not an amendment of the first.

\`bmi\` is derived from height and weight when both are present, and is never
sent by a client.

Writes a \`data_access_logs\` row — this is clinical content about one named
patient, which is the line the day board sits on the other side of.
`.trim(),
    response: vitalsListResponse,
    phi: true,
    params: { appointmentId: APPOINTMENT_NOTE },
    responseExamples: [
      {
        summary: 'One set of observations',
        value: { success: true, message: 'Success', data: { vitals: [READING] } },
      },
    ],
  },

  'POST /api/v1/appointments/{appointmentId}/vitals': {
    summary: 'Record observations',
    description: `
Take a set of observations.

⚠️ **\`clinical.vitals.record\` — and a DOCTOR deliberately does not hold it.**
The front desk and the nurse do: they are the ones standing there with the cuff,
and whoever typed a number needs to see it back to check it. A consultation must
not be able to quietly amend an observation somebody else is accountable for.

⚠️ **\`POST\` and never \`PUT\`: readings accumulate.** A repeat blood pressure
twenty minutes later is a second observation, not a correction of the first.
Correcting a mistyped one is \`PUT /{appointmentId}/vitals/{vitalsId}\`, which
keeps both values.

At least one observation is required. A blood pressure needs **both** numbers,
and systolic must exceed diastolic — which catches the two being swapped. Every
value is range-checked against what is physiologically plausible.

**Side effect: this may check the patient in.** \`bmi\` is derived, never sent.
`.trim(),
    response: vitalsReading,
    status: 201,
    message: 'Vitals recorded',
    phi: true,
    errors: [409],
    params: { appointmentId: APPOINTMENT_NOTE },
    requestExamples: [
      {
        summary: 'A full set at the desk',
        value: {
          heightCm: 172,
          weightKg: 78.5,
          temperatureC: 38.4,
          pulseBpm: 96,
          respiratoryRateBpm: 18,
          systolicMmHg: 132,
          diastolicMmHg: 84,
          spo2Percent: 97,
        },
      },
      {
        summary: 'A repeat blood pressure',
        description: 'A second reading, not a correction of the first.',
        value: { systolicMmHg: 128, diastolicMmHg: 82, notes: 'Repeat after 20 minutes rest' },
      },
    ],
    responseExamples: [
      { summary: 'Recorded', value: { success: true, message: 'Vitals recorded', data: READING } },
    ],
  },

  'GET /api/v1/appointments/{appointmentId}/vitals/{vitalsId}/revisions': {
    summary: 'Read the correction history of one reading',
    description: `
Every correction ever made to one set of observations, with **both** values.

⚠️ **This is the CLINICAL trail, not the compliance one, which is why it is here
rather than under \`/audit\`.** \`GET /api/v1/audit\` answers "who touched this
record" for every entity type and is deliberately free of measurements. This one
carries the numbers, because "the temperature was corrected from 38.4 to 37.4"
is a clinical fact that matters to whoever reads the chart.

Behind \`clinical.vitals.read\`, so a doctor can see the corrections to the
observations their consultation rests on — they hold the read code and
deliberately not the write one.
`.trim(),
    response: vitalsRevisionsResponse,
    phi: true,
    params: {
      appointmentId: APPOINTMENT_NOTE,
      vitalsId: 'The reading, as `GET /api/v1/appointments/{appointmentId}/vitals` lists it.',
    },
    responseExamples: [
      {
        summary: 'One correction',
        value: {
          success: true,
          message: 'Success',
          data: {
            revisions: [
              {
                id: VITALS_REVISION_ID,
                revisedAt: '2026-03-17T04:02:00.000Z',
                revisedBy: RECEPTIONIST.membershipId,
                revisedByName: RECEPTIONIST.fullName,
                reason: 'Thermometer misread',
                changes: [{ field: 'temperatureC', before: 38.4, after: 37.4 }],
              },
            ],
          },
        },
      },
    ],
  },

  'PUT /api/v1/appointments/{appointmentId}/vitals/{vitalsId}': {
    summary: 'Correct a reading',
    description: `
Amend a set of observations that was typed wrong.

⚠️ **The previous values are kept, not overwritten.** Every correction lands in
the revision history with both the old and the new number, readable through
\`/revisions\`. A chart that silently changed underneath a clinician is not a
chart anybody can rely on.

This is for a **mistyped** reading. A genuinely new measurement is a fresh
\`POST\`, not a correction — the distinction is what keeps a trend line honest.

Same validation as recording: at least one observation, both blood pressure
numbers together, systolic above diastolic, every value range-checked.
`.trim(),
    response: vitalsReading,
    message: 'Reading corrected',
    phi: true,
    errors: [409],
    params: {
      appointmentId: APPOINTMENT_NOTE,
      vitalsId: 'The reading, as `GET /api/v1/appointments/{appointmentId}/vitals` lists it.',
    },
    requestExamples: [
      {
        summary: 'The thermometer was misread',
        value: {
          heightCm: 172,
          weightKg: 78.5,
          temperatureC: 37.4,
          pulseBpm: 96,
          respiratoryRateBpm: 18,
          systolicMmHg: 132,
          diastolicMmHg: 84,
          spo2Percent: 97,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Corrected',
        value: {
          success: true,
          message: 'Reading corrected',
          data: { ...READING, temperatureC: 37.4 },
        },
      },
    ],
  },

  'DELETE /api/v1/appointments/{appointmentId}/vitals/{vitalsId}': {
    summary: 'Withdraw a reading',
    description: `
Withdraw a set of observations recorded against the wrong patient or the wrong
visit.

⚠️ **A withdrawal, not an erasure.** The row is retracted rather than deleted —
it stops counting towards the chart and stays visible in the revision history,
because a measurement that was acted on cannot be made never to have existed.

Behind \`clinical.vitals.record\`: whoever may take a reading may withdraw one,
and a doctor may do neither.
`.trim(),
    phi: true,
    errors: [409],
    params: {
      appointmentId: APPOINTMENT_NOTE,
      vitalsId: 'The reading, as `GET /api/v1/appointments/{appointmentId}/vitals` lists it.',
    },
  },
};
