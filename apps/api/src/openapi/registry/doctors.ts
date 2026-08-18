/**
 * Doctors — practitioners, their week, their prices and what the clinic pays them.
 *
 * ⚠️ NOTHING HERE IS PHI. A doctor is staff: this router names no patient and
 *   implies none, which is why it sits behind personnel codes rather than
 *   clinical ones and why none of it is read-audited.
 *
 * ⚠️ SIX PERMISSIONS, AND THE SPLIT IS THE DESIGN. `doctor.read` sees a profile,
 *   `doctor.directory.read` enumerates the roster, `doctor.schedule.read` sees
 *   the configured week, `fee.schedule.manage` sets prices, and
 *   `doctor.compensation.manage` sets pay. What a doctor CHARGES a patient and
 *   what the clinic PAYS them are different facts with different audiences, and
 *   fusing them is the mistake this router is shaped to prevent.
 */
import {
  doctorCompensationDetail,
  doctorDetail,
  doctorListResponse,
  doctorScheduleExceptionDetail,
  feeScheduleView,
  referralTargetResponse,
  specialtyListResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  CONSULTATION_FEE_PAISE,
  DOCTOR,
  DOCTOR_BRANCH_SETTING_ID,
  DOCTOR_EXCEPTION_ID,
  DOCTOR_ID,
  DOCTOR_QUALIFICATION_ROW_ID,
  DOCTOR_SCHEDULE_ID,
  DOCTOR_SPECIALTY_ROW_ID,
  MEMBERSHIP_ID,
  QUALIFICATION_MBBS_ID,
  QUALIFICATION_MD_ID,
  SPECIALTY_CARDIOLOGY_ID,
  SPECIALTY_GENERAL_MEDICINE_ID,
  SPECIALTY_MEDICINE_ID,
  USER_ID,
} from './fixtures.js';

const DOCTOR_NOTE =
  "The doctor's **profile** id, as `GET /api/v1/doctors` lists it — not their user id and not their membership id. A doctor at another clinic is answered `404`.";

const SPECIALTY = {
  id: DOCTOR_SPECIALTY_ROW_ID,
  specialtyId: SPECIALTY_GENERAL_MEDICINE_ID,
  code: 'GENERAL_MEDICINE',
  name: 'General Medicine',
  isPrimary: true,
  type: 'SPECIALTY',
  proficiency: 'EXPERT',
  effectiveFrom: '2024-10-28',
  effectiveTo: null,
  isActive: true,
  ancestors: [
    { id: SPECIALTY_MEDICINE_ID, code: 'MEDICINE', name: 'Medicine', type: 'DEPARTMENT' },
  ],
};

const SCHEDULE = {
  id: DOCTOR_SCHEDULE_ID,
  branchId: BRANCH_ID,
  branchName: 'Alpha Clinic — Indiranagar',
  dayOfWeek: 1,
  startTime: '09:00',
  endTime: '13:00',
  slotMinutes: null,
  effectiveSlotMinutes: 15,
  maxPatients: 24,
  validFrom: '2026-01-01',
  validTo: null,
  isActive: true,
};

const DOCTOR_SUMMARY = {
  id: DOCTOR_ID,
  userId: USER_ID,
  fullName: DOCTOR.fullName,
  status: 'ACTIVE',
  registrationNumber: DOCTOR.registrationNumber,
  experienceYears: DOCTOR.experienceYears,
  primarySpecialty: 'General Medicine',
  specialties: [SPECIALTY],
  branchIds: [BRANCH_ID, BRANCH_KOCHI_ID],
};

const DOCTOR_DETAIL = {
  ...DOCTOR_SUMMARY,
  registrationCouncil: DOCTOR.registrationCouncil,
  registrationValidTill: '2028-03-31',
  bio: 'Internal medicine, with an interest in diabetes and hypertension.',
  qualifications: [
    {
      id: DOCTOR_QUALIFICATION_ROW_ID,
      qualificationId: QUALIFICATION_MD_ID,
      code: 'MD',
      name: 'MD (General Medicine)',
      institute: 'Bangalore Medical College',
      yearOfCompletion: 2014,
    },
  ],
  branchSettings: [
    {
      id: DOCTOR_BRANCH_SETTING_ID,
      branchId: BRANCH_ID,
      branchName: 'Alpha Clinic — Indiranagar',
      followUpFreeDays: 7,
      isActive: true,
    },
  ],
  schedules: [SCHEDULE],
  exceptions: [],
};

const EXCEPTION = {
  id: DOCTOR_EXCEPTION_ID,
  branchId: BRANCH_ID,
  branchName: 'Alpha Clinic — Indiranagar',
  exceptionType: 'LEAVE',
  startsAt: '2026-04-06T00:00:00.000Z',
  endsAt: '2026-04-10T23:59:00.000Z',
  reason: 'Annual leave',
  status: 'REQUESTED',
  requestedBy: MEMBERSHIP_ID,
  decidedBy: null,
  decidedAt: null,
};

export const doctorDocs: DocRegistry = {
  'GET /api/v1/doctors/masters': {
    summary: 'List specialties and qualifications',
    description: `
The two catalogues a doctor's profile points at: the specialty tree and the
qualification list.

Behind \`doctor.read\` rather than the code that EDITS the catalogue, and
deliberately so — every screen that shows a doctor has to render their specialty
name, and gating that behind the permission to edit the tree would show a
receptionist a blank where the specialty should be.

\`isOwn\` separates the entries rcln ships from the ones this clinic added.
`.trim(),
    response: specialtyListResponse,
    responseExamples: [
      {
        summary: 'The shipped catalogue plus one local addition',
        value: {
          success: true,
          message: 'Success',
          data: {
            specialties: [
              {
                id: SPECIALTY_MEDICINE_ID,
                code: 'MEDICINE',
                name: 'Medicine',
                parentId: null,
                isOwn: false,
                type: 'DEPARTMENT',
                description: 'Non-surgical adult care.',
                displayOrder: 1,
              },
              {
                id: SPECIALTY_GENERAL_MEDICINE_ID,
                code: 'GENERAL_MEDICINE',
                name: 'General Medicine',
                parentId: SPECIALTY_MEDICINE_ID,
                isOwn: false,
                type: 'SPECIALTY',
                description: null,
                displayOrder: 1,
              },
              {
                id: SPECIALTY_CARDIOLOGY_ID,
                code: 'CARDIOLOGY',
                name: 'Cardiology',
                parentId: SPECIALTY_MEDICINE_ID,
                isOwn: false,
                type: 'SPECIALTY',
                description: null,
                displayOrder: 2,
              },
            ],
            qualifications: [
              { id: QUALIFICATION_MBBS_ID, code: 'MBBS', name: 'MBBS', isOwn: false },
              {
                id: QUALIFICATION_MD_ID,
                code: 'MD',
                name: 'MD (General Medicine)',
                isOwn: false,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/doctors': {
    summary: 'List doctors',
    description: `
The clinic's roster, filterable by specialty and status.

⚠️ **\`schedules\` rides on \`doctor.schedule.read\`, not on reaching this
route.** The roster carries each doctor's working hours so a booking screen does
not have to fetch them one at a time — but caps, validity windows and inherited
slot lengths are configuration. A caller without that code gets **no
\`schedules\` key at all**, rather than an empty array, because an empty array
would assert the doctor works nowhere.

\`includeDescendants\` (default \`true\`) makes \`specialtyId\` match down the
tree: filtering by *Medicine* returns the general physicians and the
cardiologists, not only whoever is filed at the department node itself.

This is the enumeration endpoint, and it is behind \`doctor.directory.read\` —
which a DOCTOR deliberately does not hold. A practitioner who needs to name a
colleague for a referral uses \`GET /api/v1/doctors/referral-targets\` instead.
`.trim(),
    response: doctorListResponse,
    params: {
      specialtyId:
        'Filter to one specialty. Matches descendants too unless `includeDescendants=false`.',
      includeDescendants:
        'Whether `specialtyId` also matches specialties beneath it in the tree. Defaults to `true`.',
      status: 'Filter by `ACTIVE`, `INACTIVE` or `ARCHIVED`. Omitted, all are returned.',
    },
    responseExamples: [
      {
        summary: 'With the week (caller holds `doctor.schedule.read`)',
        value: {
          success: true,
          message: 'Success',
          data: { doctors: [{ ...DOCTOR_SUMMARY, schedules: [SCHEDULE] }] },
        },
      },
      {
        summary: 'Without it',
        description:
          'Note there is no `schedules` key — not an empty one. The caller cannot see the configured week.',
        value: { success: true, message: 'Success', data: { doctors: [DOCTOR_SUMMARY] } },
      },
    ],
  },

  'GET /api/v1/doctors/referral-targets': {
    summary: 'Find a colleague to refer to',
    description: `
Colleagues this patient could be referred to, by name.

⚠️ **Behind \`clinical.encounter.create\`, not \`doctor.directory.read\`, and
that is the entire reason this route exists separately from \`GET /doctors\`.**
A DOCTOR deliberately does not hold the directory code — the roster is a
personnel list. But a referral has to name a destination, so the person writing
the consultation must be able to reach one, and **only** the person writing one
can.

⚠️ **It is a LOOKUP, NOT AN ENUMERATION**, which is what stops it re-opening the
door the directory code closes. \`search\` is required with a two-character
minimum, so there is no form of this call that answers "who works here". The
payload is a name and a specialty — no schedule, no contact details, no
registration number, no fees, no employment status.

Not read-audited, deliberately: neither half of this exchange names or implies a
patient. The referral it results in **is** audited, on the encounter, where the
patient is.
`.trim(),
    response: referralTargetResponse,
    params: {
      search: 'Required, minimum two characters. There is no way to call this without one.',
    },
    responseExamples: [
      {
        summary: 'Searching for "kri"',
        value: {
          success: true,
          message: 'Success',
          data: {
            targets: [
              {
                id: DOCTOR_ID,
                fullName: DOCTOR.fullName,
                primarySpecialty: 'General Medicine',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/doctors/me': {
    summary: 'Get my own doctor profile',
    description: `
The signed-in practitioner's own profile, without needing to know their profile
id or to hold the directory permission.

Answers \`404\` when the caller is not a doctor — a receptionist has no doctor
profile, and that is not an error condition worth distinguishing from a missing
row.

Declared above \`/{doctorId}\` on purpose: Express matches in declaration order,
and underneath it \`me\` would be parsed as a doctor id and fail uuid validation.
`.trim(),
    response: doctorDetail,
    responseExamples: [
      { summary: 'My profile', value: { success: true, message: 'Success', data: DOCTOR_DETAIL } },
    ],
  },

  'GET /api/v1/doctors/{doctorId}': {
    summary: 'Get a doctor',
    description:
      'One practitioner in full: registration, specialties, degrees, per-branch settings, the configured week, and any leave or extra shifts on it. Contains no pay and no fees — those are separate endpoints behind separate permissions.',
    response: doctorDetail,
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      {
        summary: 'A consultant physician',
        value: { success: true, message: 'Success', data: DOCTOR_DETAIL },
      },
    ],
  },

  'POST /api/v1/doctors': {
    summary: 'Add a doctor',
    description: `
Create a practitioner profile, optionally with their degrees, week, prices and
pay in the same call.

⚠️ **EVERY NESTED SECTION IS AUTHORIZED SEPARATELY, and this is the only place in
the API where that happens.** \`doctor.create\` buys the profile and nothing
else. \`qualifications\` additionally needs \`doctor.update\`, \`schedules\`
needs \`doctor.schedule.manage\`, \`fees\` needs \`fee.schedule.manage\`, and
\`compensation\` needs \`doctor.compensation.manage\`. Accepting them all on
\`doctor.create\` alone would hand whoever may add a colleague a second,
ungated route to setting that colleague's salary.

⚠️ **A section you may not set is a \`403\` that NAMES it, not a silent drop.**
Quietly ignoring a salary means an administrator types a figure, sees "Doctor
added", and believes it was recorded. Refusing says which part was refused so
the form can stop offering it.

The doctor must already be a member of this clinic — this creates the
practitioner profile on an existing membership, it does not invite anybody. Use
\`POST /api/v1/invitations\` first.
`.trim(),
    response: doctorDetail,
    status: 201,
    message: 'Doctor added',
    errors: [403, 409],
    requestExamples: [
      {
        summary: 'Profile only',
        description: 'Needs `doctor.create` and nothing more.',
        value: {
          membershipId: MEMBERSHIP_ID,
          registrationNumber: 'KMC-58214',
          registrationCouncil: 'Karnataka Medical Council',
          experienceYears: 14,
          specialties: [{ specialtyId: SPECIALTY_GENERAL_MEDICINE_ID, isPrimary: true }],
        },
      },
      {
        summary: 'Everything at once',
        description:
          'Needs all five codes. Missing any one of them is a `403` naming the section that was refused.',
        value: {
          membershipId: MEMBERSHIP_ID,
          registrationNumber: 'KMC-58214',
          registrationCouncil: 'Karnataka Medical Council',
          experienceYears: 14,
          specialties: [{ specialtyId: SPECIALTY_GENERAL_MEDICINE_ID, isPrimary: true }],
          qualifications: [
            {
              qualificationId: QUALIFICATION_MD_ID,
              institute: 'Bangalore Medical College',
              yearOfCompletion: 2014,
            },
          ],
          schedules: [
            {
              branchId: BRANCH_ID,
              dayOfWeek: 1,
              startTime: '09:00',
              endTime: '13:00',
              maxPatients: 24,
              validFrom: '2026-01-01',
            },
          ],
          fees: [{ feeType: 'CONSULTATION', amountMinor: CONSULTATION_FEE_PAISE }],
          compensation: { amountMinor: 25000000, interval: 'MONTHLY' },
        },
      },
    ],
    responseExamples: [
      { summary: 'Added', value: { success: true, message: 'Doctor added', data: DOCTOR_DETAIL } },
    ],
  },

  'PATCH /api/v1/doctors/{doctorId}': {
    summary: 'Update a doctor',
    description: `
A partial update of the profile: registration details, bio, experience,
specialties and status.

⚠️ **A doctor editing their OWN profile is scoping, not a permission.** There is
no \`doctor.self.update\` code, because the permission resolver grants a code
across a *branch* scope and cannot express "this one row". The service compares
the profile's \`userId\` against the caller's instead.

Does not touch fees, pay, the week or degrees — each has its own endpoint and its
own code. Archiving is \`DELETE\`, not \`status: 'ARCHIVED'\` here.
`.trim(),
    response: doctorDetail,
    message: 'Doctor updated',
    errors: [403, 409],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'Update the bio',
        value: { bio: 'Internal medicine, with an interest in diabetes.' },
      },
      {
        summary: 'Add a second specialty',
        description: 'Exactly one entry may be `isPrimary`.',
        value: {
          specialties: [
            { specialtyId: SPECIALTY_GENERAL_MEDICINE_ID, isPrimary: true },
            { specialtyId: SPECIALTY_CARDIOLOGY_ID, isPrimary: false },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Doctor updated', data: DOCTOR_DETAIL },
      },
    ],
  },

  'DELETE /api/v1/doctors/{doctorId}': {
    summary: 'Retire a doctor',
    description: `
Take a practitioner off the roster.

⚠️ **A soft archive, never a delete.** The profile is referenced by every
encounter they authored, every prescription they signed and every appointment
they saw — and those are the clinical record, which does not lose its author
because somebody left. The row moves to \`ARCHIVED\`, disappears from booking and
stays attached to everything it is attached to.

Future appointments are not cancelled by this. Reassign or cancel them first;
retiring a doctor with a booked clinic still ahead of them is \`409\`.

Answers \`null\` data.
`.trim(),
    message: 'Doctor retired',
    errors: [409],
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      { summary: 'Retired', value: { success: true, message: 'Doctor retired', data: null } },
    ],
  },

  'POST /api/v1/doctors/{doctorId}/qualifications': {
    summary: 'Add a qualification',
    description:
      "Record a degree against a practitioner, pointing at an entry in the qualification catalogue rather than typing free text — which is what makes 'MD' the same thing on every profile that has it. `institute` and `yearOfCompletion` are the per-person facts. Answers `null` data.",
    status: 201,
    message: 'Qualification added',
    errors: [409],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'An MD',
        value: {
          qualificationId: QUALIFICATION_MD_ID,
          institute: 'Bangalore Medical College',
          yearOfCompletion: 2014,
        },
      },
    ],
    responseExamples: [
      { summary: 'Added', value: { success: true, message: 'Qualification added', data: null } },
    ],
  },

  'PATCH /api/v1/doctors/{doctorId}/qualifications/{rowId}': {
    summary: 'Update a qualification',
    description:
      'Correct a recorded degree — usually the institute or the year. Send `null` to clear either. Answers `null` data.',
    message: 'Qualification updated',
    params: {
      doctorId: DOCTOR_NOTE,
      rowId:
        "The **row** id from the doctor's `qualifications[]` — not the catalogue's qualification id.",
    },
    requestExamples: [
      { summary: 'Correct the year', value: { yearOfCompletion: 2015 } },
      { summary: 'Clear the institute', value: { institute: null } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Qualification updated', data: null },
      },
    ],
  },

  'DELETE /api/v1/doctors/{doctorId}/qualifications/{rowId}': {
    summary: 'Remove a qualification',
    description:
      'Detach a degree from a practitioner. Removes the join row only — the catalogue entry is shared and stays. Answers `null` data.',
    message: 'Qualification removed',
    params: {
      doctorId: DOCTOR_NOTE,
      rowId:
        "The **row** id from the doctor's `qualifications[]` — not the catalogue's qualification id.",
    },
    responseExamples: [
      {
        summary: 'Removed',
        value: { success: true, message: 'Qualification removed', data: null },
      },
    ],
  },

  'PUT /api/v1/doctors/{doctorId}/branch-settings': {
    summary: 'Set per-branch settings',
    description: `
What is true about this doctor **at one branch**: whether they practise there at
all, and how long a follow-up stays free.

\`followUpFreeDays\` is what the fee engine consults when a patient returns —
inside the window the consultation is not charged again. It is per doctor per
branch because it is a commercial decision, and a group may make it differently
in different cities.

\`PUT\`, so the settings for the named branch are replaced wholesale. Other
branches are untouched. Answers \`null\` data.
`.trim(),
    message: 'Branch settings saved',
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'A week of free follow-up',
        value: { branchId: BRANCH_ID, followUpFreeDays: 7, isActive: true },
      },
      {
        summary: 'No longer practising at this branch',
        value: { branchId: BRANCH_KOCHI_ID, isActive: false },
      },
    ],
    responseExamples: [
      { summary: 'Saved', value: { success: true, message: 'Branch settings saved', data: null } },
    ],
  },

  'GET /api/v1/doctors/{doctorId}/compensation': {
    summary: 'Get what the clinic pays a doctor',
    description: `
The practitioner's own pay — an amount and an interval.

⚠️ **THE FIGURE IS REDACTED UNLESS THE CALLER HOLDS
\`doctor.compensation.read\`.** The route itself is behind \`doctor.read\`, so a
caller who may see the profile reaches this and gets the shape with
\`amountMinor: null\` rather than a \`403\`. That is deliberate: a \`403\` on a
panel that is part of a profile screen tells the reader a salary exists and what
it is worth digging for, whereas a null is simply a field they cannot see.

⚠️ **This is what the clinic PAYS, never what the patient is CHARGED.** Fees are
\`GET /doctors/{doctorId}/fees\` behind an entirely different code. The two are
kept apart on purpose and are never derived from one another.

\`amountMinor\` is in minor units — \`25000000\` is ₹250,000.00.
`.trim(),
    response: doctorCompensationDetail,
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      {
        summary: 'Caller holds `doctor.compensation.read`',
        value: {
          success: true,
          message: 'Success',
          data: {
            doctorProfileId: DOCTOR_ID,
            currency: 'INR',
            amountMinor: 25000000,
            interval: 'MONTHLY',
            updatedAt: '2026-01-04T05:30:00.000Z',
          },
        },
      },
      {
        summary: 'Caller does not — redacted, not refused',
        description: 'Same shape, `amountMinor` and `interval` null. Deliberately not a `403`.',
        value: {
          success: true,
          message: 'Success',
          data: {
            doctorProfileId: DOCTOR_ID,
            currency: 'INR',
            amountMinor: null,
            interval: null,
            updatedAt: null,
          },
        },
      },
    ],
  },

  'PUT /api/v1/doctors/{doctorId}/compensation': {
    summary: 'Set what the clinic pays a doctor',
    description: `
Record or clear a practitioner's pay.

⚠️ **\`amountMinor\` and \`interval\` are set together or cleared together.**
One without the other is a validation error, because an amount with no interval
is not a salary — it is a number nobody can act on.

Send both as \`null\` to clear the arrangement entirely.

Behind \`doctor.compensation.manage\`, which is deliberately not held by whoever
sets prices. \`amountMinor\` is in minor units.
`.trim(),
    response: doctorCompensationDetail,
    message: 'Compensation saved',
    errors: [403],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      { summary: '₹250,000 a month', value: { amountMinor: 25000000, interval: 'MONTHLY' } },
      { summary: 'Per session', value: { amountMinor: 500000, interval: 'PER_SESSION' } },
      {
        summary: 'Clear it',
        description: 'Both null. One null and one set is a `400`.',
        value: { amountMinor: null, interval: null },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: {
          success: true,
          message: 'Compensation saved',
          data: {
            doctorProfileId: DOCTOR_ID,
            currency: 'INR',
            amountMinor: 25000000,
            interval: 'MONTHLY',
            updatedAt: '2026-03-17T04:00:00.000Z',
          },
        },
      },
    ],
  },

  'GET /api/v1/doctors/{doctorId}/fees': {
    summary: "Get a doctor's fees",
    description: `
What this practitioner's consultations cost, and where each price came from.

Prices resolve down a scope chain — a clinic-wide default, overridden per branch,
overridden per doctor — and the response says which level each amount was
actually taken from. That is what lets a pricing screen show "₹600, inherited
from the branch" rather than an amount with no provenance.

⚠️ **What the patient is CHARGED, never what the doctor is PAID.** Pay is
\`GET /doctors/{doctorId}/compensation\`, behind a different code.

Amounts are in minor units.
`.trim(),
    response: feeScheduleView,
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      {
        summary: 'A doctor-level consultation price',
        value: {
          success: true,
          message: 'Success',
          data: {
            scopeLevel: 'DOCTOR',
            branchId: BRANCH_ID,
            doctorProfileId: DOCTOR_ID,
            currency: 'INR',
            rows: [
              {
                feeType: 'CONSULTATION',
                amountMinor: CONSULTATION_FEE_PAISE,
                inheritedFrom: 'DOCTOR',
                isOverridden: true,
              },
              {
                feeType: 'FOLLOW_UP',
                amountMinor: 0,
                inheritedFrom: 'BRANCH',
                isOverridden: false,
              },
            ],
          },
        },
      },
    ],
  },

  'PUT /api/v1/doctors/{doctorId}/fees': {
    summary: "Set a doctor's fees",
    description: `
Override prices for this practitioner specifically.

**\`PUT\`, so the doctor-level set is REPLACED.** A fee type you omit stops being
overridden here and falls back to the branch or clinic price — it does not keep
its previous doctor-level amount. That is how an override is removed: leave it
out.

Amounts are in minor units, and \`0\` is a real price meaning free — distinct
from omitting the row, which means "inherit".

Returns the resolved view, so the caller sees what each fee type ended up at and
which level it came from.
`.trim(),
    response: feeScheduleView,
    message: 'Fees saved',
    errors: [403],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'Charge ₹600, follow-ups free',
        value: {
          amounts: [
            { feeType: 'CONSULTATION', amountMinor: CONSULTATION_FEE_PAISE },
            { feeType: 'FOLLOW_UP', amountMinor: 0 },
          ],
        },
      },
      {
        summary: 'Drop every override',
        description: 'An empty list. Every fee type falls back to the branch or clinic price.',
        value: { amounts: [] },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: {
          success: true,
          message: 'Fees saved',
          data: {
            scopeLevel: 'DOCTOR',
            branchId: BRANCH_ID,
            doctorProfileId: DOCTOR_ID,
            currency: 'INR',
            rows: [
              {
                feeType: 'CONSULTATION',
                amountMinor: CONSULTATION_FEE_PAISE,
                inheritedFrom: 'DOCTOR',
                isOverridden: true,
              },
              { feeType: 'FOLLOW_UP', amountMinor: 0, inheritedFrom: 'DOCTOR', isOverridden: true },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/doctors/{doctorId}/schedules': {
    summary: "Get a doctor's working hours",
    description: `
The configured week: which branch, which day, which hours, and how long a slot
is.

\`slotMinutes\` is what this block *states*; \`effectiveSlotMinutes\` is what
actually applies once the branch default is taken into account. A block that
states nothing inherits, and the response gives both so a screen can show the
inheritance rather than hiding it.

\`validFrom\`/\`validTo\` are what make a rota changeable without rewriting
history — a Tuesday clinic that ends in June is a block with a \`validTo\`, not a
deletion.

Behind \`doctor.schedule.read\`, which is separate from booking: the patient
portal reads free slots without ever seeing this configuration.
`.trim(),
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      {
        summary: 'Monday mornings at Indiranagar',
        value: { success: true, message: 'Success', data: { schedules: [SCHEDULE] } },
      },
    ],
  },

  'POST /api/v1/doctors/{doctorId}/schedules': {
    summary: 'Add working hours',
    description: `
Add one block of recurring availability — one day of the week, at one branch,
between two clock times.

**\`startTime\` and \`endTime\` are clinic-local wall times, not instants**, and
\`endTime\` must be after \`startTime\`: an overnight clinic is two blocks, not
one that wraps past midnight.

\`dayOfWeek\` is 0 = Sunday through 6 = Saturday. \`slotMinutes\` omitted
inherits the branch's. \`maxPatients\` caps the block regardless of how many
slots fit in it.

Answers \`null\` data.
`.trim(),
    status: 201,
    message: 'Working hours added',
    errors: [409],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'Monday mornings',
        value: {
          branchId: BRANCH_ID,
          dayOfWeek: 1,
          startTime: '09:00',
          endTime: '13:00',
          maxPatients: 24,
          validFrom: '2026-01-01',
        },
      },
      {
        summary: 'A Tuesday clinic that ends in June',
        description: 'Bounded by `validTo` rather than deleted later.',
        value: {
          branchId: BRANCH_KOCHI_ID,
          dayOfWeek: 2,
          startTime: '14:00',
          endTime: '18:00',
          slotMinutes: 20,
          validFrom: '2026-01-01',
          validTo: '2026-06-30',
        },
      },
    ],
    responseExamples: [
      { summary: 'Added', value: { success: true, message: 'Working hours added', data: null } },
    ],
  },

  'DELETE /api/v1/doctors/{doctorId}/schedules/{scheduleId}': {
    summary: 'Remove working hours',
    description: `
Delete one block from the rota.

⚠️ **Prefer a \`validTo\` for a block that simply ended.** Deleting removes the
block from history as well as from the future, which makes "why was this patient
booked at 3pm on a Tuesday" unanswerable. Deletion is for a block entered in
error.

Appointments already booked into the block are not cancelled. Answers \`null\`
data.
`.trim(),
    message: 'Working hours removed',
    params: {
      doctorId: DOCTOR_NOTE,
      scheduleId: 'The block, as `GET /api/v1/doctors/{doctorId}/schedules` lists it.',
    },
    responseExamples: [
      {
        summary: 'Removed',
        value: { success: true, message: 'Working hours removed', data: null },
      },
    ],
  },

  'GET /api/v1/doctors/{doctorId}/exceptions': {
    summary: 'List leave and extra shifts',
    description:
      'Everything that departs from the configured week — leave, ad-hoc blocks and extra shifts — with the status of each request. A `branchId` of `null` means the exception applies everywhere the doctor practises, which is what leave usually is.',
    params: { doctorId: DOCTOR_NOTE },
    responseExamples: [
      {
        summary: 'A pending leave request',
        value: { success: true, message: 'Success', data: { exceptions: [EXCEPTION] } },
      },
    ],
  },

  'POST /api/v1/doctors/{doctorId}/exceptions': {
    summary: 'Request leave or an extra shift',
    description: `
Ask for a departure from the configured week.

⚠️ **Requesting and approving are different permissions**
(\`doctor.schedule.request\` and \`doctor.schedule.approve\`), which is what
stops a practitioner approving their own leave. The row lands as \`REQUESTED\`
and changes nothing about availability until it is decided.

\`LEAVE\` and \`BLOCK\` remove availability; \`EXTRA_SHIFT\` adds it.
\`branchId\` omitted means everywhere.

\`startsAt\`/\`endsAt\` are UTC instants, and \`endsAt\` must be after
\`startsAt\`.
`.trim(),
    response: doctorScheduleExceptionDetail,
    status: 201,
    message: 'Request submitted',
    errors: [409],
    params: { doctorId: DOCTOR_NOTE },
    requestExamples: [
      {
        summary: 'A week of leave',
        value: {
          exceptionType: 'LEAVE',
          startsAt: '2026-04-06T00:00:00.000Z',
          endsAt: '2026-04-10T23:59:00.000Z',
          reason: 'Annual leave',
        },
      },
      {
        summary: 'An extra Saturday clinic',
        value: {
          branchId: BRANCH_ID,
          exceptionType: 'EXTRA_SHIFT',
          startsAt: '2026-03-21T03:30:00.000Z',
          endsAt: '2026-03-21T08:30:00.000Z',
          reason: 'Catching up on the backlog',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Submitted',
        value: { success: true, message: 'Request submitted', data: EXCEPTION },
      },
    ],
  },

  'POST /api/v1/doctors/{doctorId}/exceptions/{exceptionId}/decision': {
    summary: 'Approve or reject a request',
    description: `
Decide a pending leave or extra-shift request.

⚠️ **Availability moves only now, not when the request was made.** Approving
leave takes the doctor out of the booking engine for that window; rejecting it
leaves the week exactly as configured.

⚠️ **Approving leave does NOT cancel appointments already booked into it.** They
are surfaced for the desk to move, deliberately — silently cancelling a
patient's appointment because a rota changed is not a decision this API makes on
a clinic's behalf.

Behind \`doctor.schedule.approve\`, which the requester does not hold. Deciding
a request that is already decided is \`409\`.
`.trim(),
    response: doctorScheduleExceptionDetail,
    message: 'Decision recorded',
    errors: [409],
    params: {
      doctorId: DOCTOR_NOTE,
      exceptionId: 'The request, as `GET /api/v1/doctors/{doctorId}/exceptions` lists it.',
    },
    requestExamples: [
      { summary: 'Approve', value: { decision: 'APPROVED' } },
      {
        summary: 'Reject, with a reason',
        value: { decision: 'REJECTED', reason: 'Clashes with the vaccination camp' },
      },
    ],
    responseExamples: [
      {
        summary: 'Approved',
        value: {
          success: true,
          message: 'Decision recorded',
          data: {
            ...EXCEPTION,
            status: 'APPROVED',
            decidedBy: MEMBERSHIP_ID,
            decidedAt: '2026-03-17T04:00:00.000Z',
          },
        },
      },
    ],
  },
};
