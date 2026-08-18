/**
 * Branches — the places a clinic operates from.
 *
 * The smallest complete surface in the API and the one to read first: it shows
 * the middleware chain, the envelope, the tenant rule and the permission model
 * in six endpoints, and every other tenant-scoped router is shaped like it.
 */
import { branchDetail, branchListResponse } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';

/** One fully-populated branch, used as the response example throughout. */
const MAIN_BRANCH = {
  id: '8f1b0c4e-2d3a-4b5c-9e7f-1a2b3c4d5e6f',
  name: 'Alpha Clinic — Indiranagar',
  code: 'BLR-IND',
  branchType: 'CLINIC',
  status: 'ACTIVE',
  isPrimary: true,
  timezone: 'Asia/Kolkata',
  phone: '+919845012345',
  email: 'indiranagar@alphaclinic.in',
  addressLine1: '221, 100 Feet Road',
  addressLine2: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  countryCode: 'IN',
  regionCode: 'KA',
  operatingHours: [
    { dayOfWeek: 1, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
    { dayOfWeek: 2, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
    { dayOfWeek: 3, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
    { dayOfWeek: 4, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
    { dayOfWeek: 5, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
    { dayOfWeek: 6, opensAt: '09:00', closesAt: '14:00', isClosed: false, slotMinutes: 20 },
    { dayOfWeek: 0, opensAt: '00:00', closesAt: '00:00', isClosed: true, slotMinutes: 15 },
  ],
} as const;

const BRANCH_ID_NOTE =
  "The branch's `id`, as returned by `GET /api/v1/branches`. A branch belonging to another clinic is answered `404`, never `403`.";

export const branchDocs: DocRegistry = {
  'GET /api/v1/branches': {
    summary: 'List branches',
    description: `
Every branch the **caller** may act on, each with its full week of operating
hours.

⚠️ **This is not necessarily every branch the clinic has.** Roles are held per
branch: somebody with an organization-wide assignment sees all of them, and a
branch administrator sees only theirs. The filtering is deliberate and there is
no parameter to defeat it.

Not paginated — a clinic has branches in the single or low double digits, and
the screens that call this need the whole set to render a switcher.
`.trim(),
    response: branchListResponse,
    responseExamples: [
      {
        summary: 'A two-branch group',
        value: {
          success: true,
          message: 'Success',
          data: {
            branches: [
              MAIN_BRANCH,
              {
                ...MAIN_BRANCH,
                id: '3c9d5a71-8e42-4f16-b0d3-7a5e9c1f2b84',
                name: 'Alpha Clinic — Kochi',
                code: 'KOC-MG',
                isPrimary: false,
                phone: '+919847098765',
                email: 'kochi@alphaclinic.in',
                addressLine1: 'MG Road',
                addressLine2: null,
                city: 'Kochi',
                state: 'Kerala',
                pincode: '682035',
                regionCode: 'KL',
              },
            ],
          },
        },
      },
      {
        summary: 'A solo clinic',
        description: 'One organization, one branch. The same shape as the group above.',
        value: { success: true, message: 'Success', data: { branches: [MAIN_BRANCH] } },
      },
    ],
  },

  'GET /api/v1/branches/{branchId}': {
    summary: 'Get a branch',
    description:
      'One branch and its operating hours. Answers `404` both for a branch that does not exist and for one belonging to another clinic — the two are indistinguishable to a caller on purpose.',
    response: branchDetail,
    params: { branchId: BRANCH_ID_NOTE },
    responseExamples: [
      {
        summary: 'The primary branch',
        value: { success: true, message: 'Success', data: MAIN_BRANCH },
      },
    ],
  },

  'POST /api/v1/branches': {
    summary: 'Create a branch',
    description: `
Opens a new location for this clinic.

**\`code\` is yours and must be unique within the clinic**, not globally — two
different clinics may both have a \`MAIN\`. It is what appears on documents and
in exports, so pick something durable.

**\`countryCode\` and \`regionCode\` are the branch's tax jurisdiction, not its
postal address**, even though they usually agree. They decide which of the
clinic's tax registrations an invoice raised here is issued under, and they are
the place of supply for the rate. Both default from the *organization* when
omitted — which is what lets a group open its second branch in another state by
sending \`regionCode\` alone.

\`timezone\` defaults to the organization's. It is the zone every time at this
branch is rendered in; the browser's zone is never used.

Operating hours are **not** set here — the branch is created without them and
they are replaced as a set through \`PUT /api/v1/branches/{branchId}/operating-hours\`.
`.trim(),
    status: 201,
    message: 'Branch created',
    response: branchDetail,
    requestExamples: [
      {
        summary: 'Minimum — a second branch in the same state',
        description:
          'Everything not sent is inherited from the organization: country, region and timezone.',
        value: { name: 'Alpha Clinic — Koramangala', code: 'BLR-KOR' },
      },
      {
        summary: 'A branch in a different state',
        description:
          '`regionCode` is what makes this branch bill under the Kerala registration rather than the Karnataka one. Sending the address alone would not.',
        value: {
          name: 'Alpha Clinic — Kochi',
          code: 'KOC-MG',
          branchType: 'CLINIC',
          phone: '+919847098765',
          email: 'kochi@alphaclinic.in',
          addressLine1: 'MG Road',
          city: 'Kochi',
          state: 'Kerala',
          pincode: '682035',
          countryCode: 'IN',
          regionCode: 'KL',
          timezone: 'Asia/Kolkata',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Branch created',
          data: {
            ...MAIN_BRANCH,
            id: '5e2f8a90-1c47-4d3b-8f6a-9b0c1d2e3f45',
            name: 'Alpha Clinic — Koramangala',
            code: 'BLR-KOR',
            isPrimary: false,
            operatingHours: [],
          },
        },
      },
    ],
    errors: [409],
  },

  'PATCH /api/v1/branches/{branchId}': {
    summary: 'Update a branch',
    description: `
A partial update: only the fields you send are changed.

**A postcode is validated against the country the branch will END UP with**, not
the one it has now, so changing \`countryCode\` and \`pincode\` together works.
Sending a \`regionCode\` for a country that does not register tax by subdivision
is refused rather than ignored, because a region that matches no registration
would silently produce untaxed invoices.

Operating hours are not editable here.
`.trim(),
    message: 'Branch updated',
    response: branchDetail,
    params: { branchId: BRANCH_ID_NOTE },
    requestExamples: [
      { summary: 'Change the phone number', value: { phone: '+919845099999' } },
      {
        summary: 'Close a location',
        description:
          'The row is kept — its appointments, invoices and stock history still reference it.',
        value: { status: 'CLOSED' },
      },
    ],
    errors: [409],
  },

  'PUT /api/v1/branches/{branchId}/operating-hours': {
    summary: 'Replace the week of operating hours',
    description: `
**\`PUT\`, not \`PATCH\`: the whole week is replaced.** A day left out of the array
is a day the branch no longer opens.

That is deliberate rather than convenient. Hours are read as a set — "are we
open on Tuesday" is answered against all seven rows — and a per-day update would
leave a branch where some days are the new schedule and some are the old one,
with nothing recording which is which.

- \`dayOfWeek\` is \`0\`–\`6\` with **\`0\` = Sunday**.
- \`opensAt\`/\`closesAt\` are \`HH:MM\` in the **branch's own timezone**, not UTC.
- \`slotMinutes\` is the appointment grid for that day; the availability engine
  reads it, so \`20\` on a Saturday produces 20-minute slots on Saturdays only.
- \`isClosed: true\` records a day the branch is shut while keeping the row.
`.trim(),
    message: 'Operating hours updated',
    response: branchDetail,
    params: { branchId: BRANCH_ID_NOTE },
    requestExamples: [
      {
        summary: 'Six-day week, half-day Saturday, closed Sunday',
        value: { hours: MAIN_BRANCH.operatingHours },
      },
      {
        summary: 'Weekdays only',
        description:
          'Saturday and Sunday are absent from the array, so those rows are deleted and the branch drops to a five-day week.',
        value: {
          hours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
            dayOfWeek,
            opensAt: '09:00',
            closesAt: '18:00',
            slotMinutes: 15,
          })),
        },
      },
    ],
  },

  'DELETE /api/v1/branches/{branchId}': {
    summary: 'Remove a branch',
    description: `
A **soft delete**: \`deleted_at\` is stamped and the row stays. Nothing in this
system hard-deletes a branch, because its appointments, invoices, stock ledger
and audit trail all reference it and a clinic's history has to remain readable.

Refused while the branch is the clinic's only one, or its primary.
`.trim(),
    message: 'Branch removed',
    params: { branchId: BRANCH_ID_NOTE },
    responseExamples: [
      { summary: 'Removed', value: { success: true, message: 'Branch removed', data: null } },
    ],
    errors: [409],
  },
};
