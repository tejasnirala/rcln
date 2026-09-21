/**
 * Members & Roles — who works here and what they may do.
 *
 * ⚠️ EVERYTHING ACTS ON A **MEMBERSHIP** ID, NEVER A USER ID. A person may work
 *   at two clinics, and only one of those memberships is any of this tenant's
 *   business. A user id in one of these paths would be a question about a person
 *   rather than about an employee, and it is not a question this API answers.
 *
 * ⚠️ ROLES LIVE ON `membership_roles (membership × role × branch_id NULLABLE)`,
 *   where NULL means every branch in the org (ADR-0002). There is no role column
 *   on `users` and there is no "admin" flag — the same person is genuinely an
 *   administrator at one location and a receptionist at another, and the model
 *   says so rather than approximating it.
 *
 * Four permissions, deliberately separate: seeing the staff list does not imply
 * changing it, and a practice manager who keeps employee codes current has no
 * business assigning roles.
 */
import {
  designationListResponse,
  invitationListResponse,
  invitationSummary,
  memberDetail,
  memberListResponse,
  roleDetail,
  roleListResponse,
  rolePairingListResponse,
  designationSummary,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  DESIGNATION_AYURVEDA_ID,
  DESIGNATION_FRONT_DESK_ID,
  DESIGNATION_PHYSICIAN_ID,
  INVITATION_ID,
  MEMBERSHIP_ID,
  OVERRIDE_ID,
  RECEPTION_ASSIGNMENT_ID,
  RECEPTIONIST,
  RECEPTIONIST_MEMBERSHIP_ID,
  ROLE_ASSIGNMENT_ID,
  ROLE_DOCTOR_ID,
  ROLE_RECEPTION_ID,
  ROLE_SENIOR_RECEPTION_ID,
  USER,
  USER_ID,
} from './fixtures.js';

const MEMBERSHIP_NOTE =
  "The **membership** id, as `GET /api/v1/members` lists it — not the person's user id. A membership at another clinic is answered `404`.";

const MEMBER_EXAMPLE = {
  id: MEMBERSHIP_ID,
  userId: USER_ID,
  fullName: USER.fullName,
  email: USER.email,
  phone: USER.phone,
  status: 'ACTIVE',
  employeeCode: 'ALP-014',
  department: 'General Medicine',
  designationId: DESIGNATION_PHYSICIAN_ID,
  designationName: 'Consultant Physician',
  joinedOn: '2024-10-28',
  relievedOn: null,
  roles: [
    {
      id: ROLE_ASSIGNMENT_ID,
      roleId: ROLE_DOCTOR_ID,
      roleCode: 'DOCTOR',
      roleName: 'Doctor',
      branchId: null,
      branchName: null,
      validFrom: '2024-10-28T00:00:00.000Z',
      validTo: null,
    },
  ],
  overrides: [],
};

export const memberDocs: DocRegistry = {
  /* ─────────────────────────── invitations ─────────────────────────── */

  'GET /api/v1/invitations': {
    summary: 'List invitations',
    description: `
Every invitation this clinic has sent that has not yet been accepted, with who
sent it and when it expires.

⚠️ **The token is never here, and never anywhere else after the send.** The
column holds a digest, not the token — so an invitation cannot be re-read out of
the API by anyone, including the person who sent it. That is why re-sending
mints a *new* token rather than repeating the old one.
`.trim(),
    response: invitationListResponse,
    responseExamples: [
      {
        summary: 'One pending invitation',
        value: {
          success: true,
          message: 'Success',
          data: {
            invitations: [
              {
                id: INVITATION_ID,
                email: 'lakshmi@alphaclinic.in',
                phone: '+919847011223',
                status: 'PENDING',
                roleId: ROLE_RECEPTION_ID,
                roleName: 'Receptionist',
                designationName: 'Front Desk Executive',
                branchIds: [BRANCH_ID],
                invitedByName: USER.fullName,
                invitedAt: '2026-03-12T06:30:00.000Z',
                expiresAt: '2026-03-19T06:30:00.000Z',
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/invitations': {
    summary: 'Invite a member',
    description: `
Send somebody an invitation to work at this clinic, carrying the role they will
hold when they accept.

**\`branchIds\` decides the scope of the role, and an empty list is not the same
as an empty answer.** Left empty, the role is assigned org-wide — \`branch_id\`
NULL, meaning every branch this clinic has now and every branch it opens later.
Naming branches confines it to those. For a solo clinic the two are
indistinguishable; for a group they are very different grants, and this is the
moment the difference is decided.

**The token is handed to the sender and to nobody else.** What is stored is a
digest, so it cannot be recovered from the database or from this API — losing it
means re-sending, which is why that endpoint exists.

An invitation to an email that already has an active membership here is \`409\`.
An invitation to somebody who works at a *different* clinic is fine: memberships
are per organization, and a person may hold several.
`.trim(),
    response: invitationSummary,
    status: 201,
    message: 'Invitation sent',
    errors: [409],
    requestExamples: [
      {
        summary: 'A receptionist at one branch',
        description: 'Scoped to Indiranagar — this person gets nothing at Kochi.',
        value: {
          email: 'lakshmi@alphaclinic.in',
          phone: '+919847011223',
          roleId: ROLE_RECEPTION_ID,
          branchIds: [BRANCH_ID],
        },
      },
      {
        summary: 'A doctor across the whole clinic',
        description:
          '`branchIds` omitted, so the role is held org-wide — including at branches that do not exist yet.',
        value: { email: 'vikram@alphaclinic.in', roleId: ROLE_DOCTOR_ID },
      },
    ],
    responseExamples: [
      {
        summary: 'Sent',
        value: {
          success: true,
          message: 'Invitation sent',
          data: {
            id: INVITATION_ID,
            email: 'lakshmi@alphaclinic.in',
            phone: '+919847011223',
            status: 'PENDING',
            roleId: ROLE_RECEPTION_ID,
            roleName: 'Receptionist',
            designationName: null,
            branchIds: [BRANCH_ID],
            invitedByName: USER.fullName,
            invitedAt: '2026-03-12T06:30:00.000Z',
            expiresAt: '2026-03-19T06:30:00.000Z',
          },
        },
      },
    ],
  },

  'POST /api/v1/invitations/{invitationId}/resend': {
    summary: 'Re-send an invitation',
    description: `
Send the invitation again, with a fresh expiry.

⚠️ **This mints a NEW token and invalidates the old one.** It is not a repeat of
the original email — the stored digest is replaced, so any link already sitting
in somebody's inbox stops working the moment this is called. That is the point:
the old token may be the reason it is being re-sent.

Only a \`PENDING\` invitation can be re-sent. One already accepted or revoked is
\`409\`.
`.trim(),
    response: invitationSummary,
    message: 'Invitation sent again',
    errors: [409],
    params: { invitationId: 'The invitation, as `GET /api/v1/invitations` lists it.' },
    responseExamples: [
      {
        summary: 'Re-sent with a new expiry',
        value: {
          success: true,
          message: 'Invitation sent again',
          data: {
            id: INVITATION_ID,
            email: 'lakshmi@alphaclinic.in',
            phone: '+919847011223',
            status: 'PENDING',
            roleId: ROLE_RECEPTION_ID,
            roleName: 'Receptionist',
            designationName: null,
            branchIds: [BRANCH_ID],
            invitedByName: USER.fullName,
            invitedAt: '2026-03-12T06:30:00.000Z',
            expiresAt: '2026-03-24T09:05:00.000Z',
          },
        },
      },
    ],
  },

  'DELETE /api/v1/invitations/{invitationId}': {
    summary: 'Revoke an invitation',
    description: `
Withdraw an invitation that has not been accepted. The token stops working
immediately.

Answers with the invitation in its revoked state rather than \`204\`, so a list
can be updated from the response without a re-read. \`reason\` is optional and is
kept on the record — it is what the audit trail shows when somebody asks later
why a colleague never got access.

Revoking an invitation that was already accepted is \`409\`: at that point the
thing to remove is a *membership*, not an invitation, and cutting off access is
\`POST /api/v1/members/{membershipId}/suspend\`.
`.trim(),
    response: invitationSummary,
    message: 'Invitation revoked',
    errors: [409],
    params: { invitationId: 'The invitation, as `GET /api/v1/invitations` lists it.' },
    requestExamples: [
      { summary: 'With a reason', value: { reason: 'Offer withdrawn before joining' } },
      { summary: 'Without one', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Revoked',
        value: {
          success: true,
          message: 'Invitation revoked',
          data: {
            id: INVITATION_ID,
            email: 'lakshmi@alphaclinic.in',
            phone: '+919847011223',
            status: 'REVOKED',
            roleId: ROLE_RECEPTION_ID,
            roleName: 'Receptionist',
            designationName: null,
            branchIds: [BRANCH_ID],
            invitedByName: USER.fullName,
            invitedAt: '2026-03-12T06:30:00.000Z',
            expiresAt: '2026-03-19T06:30:00.000Z',
          },
        },
      },
    ],
  },

  /* ─────────────────────────────── roles ─────────────────────────────── */

  'GET /api/v1/roles': {
    summary: 'List roles',
    description: `
Every role available here — the twelve system roles rcln ships, plus any this
clinic has cloned for itself.

A system role is the same in every clinic and cannot be edited; \`isSystem\`
says which is which. A clinic that wants a receptionist who can also record
vitals clones the role and adds the code, rather than editing a role that
thousands of other clinics also rely on.

\`scopeLevel\` says whether the role is meaningful org-wide or only at a branch,
which is what \`POST /members/{id}/roles\` validates \`branchId\` against.
`.trim(),
    response: roleListResponse,
    responseExamples: [
      {
        summary: 'Two system roles and one clone',
        value: {
          success: true,
          message: 'Success',
          data: {
            roles: [
              {
                id: ROLE_DOCTOR_ID,
                code: 'DOCTOR',
                name: 'Doctor',
                description: 'Authors the clinical record.',
                scopeLevel: 'BRANCH',
                isSystem: true,
                memberCount: 3,
                permissionCodes: [
                  'patient.read',
                  'clinical.encounter.create',
                  'clinical.prescription.sign',
                  'clinical.vitals.read',
                ],
              },
              {
                id: ROLE_RECEPTION_ID,
                code: 'RECEPTIONIST',
                name: 'Receptionist',
                description: 'Front desk: registration, booking and vitals.',
                scopeLevel: 'BRANCH',
                isSystem: true,
                memberCount: 4,
                permissionCodes: [
                  'patient.read',
                  'patient.create',
                  'appointment.create',
                  'clinical.vitals.record',
                ],
              },
              {
                id: ROLE_SENIOR_RECEPTION_ID,
                code: 'SENIOR_RECEPTIONIST',
                name: 'Senior Receptionist',
                description: "Reception, plus the ability to move another desk's bookings.",
                scopeLevel: 'BRANCH',
                isSystem: false,
                memberCount: 1,
                permissionCodes: [
                  'patient.read',
                  'patient.create',
                  'appointment.create',
                  'appointment.reschedule',
                  'clinical.vitals.record',
                ],
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/roles': {
    summary: 'Create a role',
    description: `
Define a role of this clinic's own, usually by starting from a system role's
permission list and adding or removing a code.

⚠️ **You cannot grant a permission you do not hold.** The codes in
\`permissionCodes\` are checked against the caller's own set, so this endpoint
cannot be used to escalate — an administrator who lacks
\`clinical.prescription.sign\` cannot mint a role that has it and then assign it
to themselves.

**\`code\` is UPPER_SNAKE_CASE and unique within this clinic**, not globally.
Two clinics may both have a \`SENIOR_NURSE\`, and they are unrelated roles.

\`scopeLevel: 'BRANCH'\` means the role is assignable per branch;
\`'ORGANIZATION'\` means it only makes sense clinic-wide. It is enforced when the
role is assigned, not here.

This is the sanctioned way to widen invariant 7. A clinic that wants its nurses
to record diagnoses clones the role and adds the code — that is the clinic's
decision to make, and it is deliberately an explicit act rather than a default.
`.trim(),
    response: roleDetail,
    status: 201,
    message: 'Role created',
    errors: [409],
    requestExamples: [
      {
        summary: 'A receptionist who can also reschedule',
        value: {
          code: 'SENIOR_RECEPTIONIST',
          name: 'Senior Receptionist',
          description: "Reception, plus the ability to move another desk's bookings.",
          scopeLevel: 'BRANCH',
          permissionCodes: [
            'patient.read',
            'patient.create',
            'appointment.create',
            'appointment.reschedule',
            'clinical.vitals.record',
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Role created',
          data: {
            id: ROLE_SENIOR_RECEPTION_ID,
            code: 'SENIOR_RECEPTIONIST',
            name: 'Senior Receptionist',
            description: "Reception, plus the ability to move another desk's bookings.",
            scopeLevel: 'BRANCH',
            isSystem: false,
            memberCount: 0,
            permissionCodes: [
              'patient.read',
              'patient.create',
              'appointment.create',
              'appointment.reschedule',
              'clinical.vitals.record',
            ],
          },
        },
      },
    ],
  },

  'PATCH /api/v1/roles/{roleId}': {
    summary: 'Update a role',
    description: `
Rename a role, or replace what it may do.

⚠️ **\`permissionCodes\` REPLACES the set, it does not add to it.** Send the
whole list you want the role to end up with; anything omitted is revoked. A
partial list is the way roles quietly lose permissions.

⚠️ **The change takes effect for everybody holding the role, immediately.** This
is not a template that new assignments copy — it is the live definition, so
removing a code here removes it from every member who has this role, mid-shift.

**A system role cannot be edited** and is answered \`403\`. Clone it instead;
the twelve shipped roles are shared by every clinic on the platform.

\`code\` and \`scopeLevel\` are not editable. Both are depended on by existing
assignments, and changing either is a new role rather than an edit to this one.
`.trim(),
    response: roleDetail,
    message: 'Role updated',
    errors: [403, 409],
    params: { roleId: 'The role, as `GET /api/v1/roles` lists it. A system role is `403`.' },
    requestExamples: [
      { summary: 'Rename it', value: { name: 'Lead Receptionist' } },
      {
        summary: 'Replace the permission set',
        description: 'The complete list. `appointment.cancel` is added; nothing else changes.',
        value: {
          permissionCodes: [
            'patient.read',
            'patient.create',
            'appointment.create',
            'appointment.reschedule',
            'appointment.cancel',
            'clinical.vitals.record',
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Role updated',
          data: {
            id: ROLE_SENIOR_RECEPTION_ID,
            code: 'SENIOR_RECEPTIONIST',
            name: 'Lead Receptionist',
            description: "Reception, plus the ability to move another desk's bookings.",
            scopeLevel: 'BRANCH',
            isSystem: false,
            memberCount: 1,
            permissionCodes: [
              'patient.read',
              'patient.create',
              'appointment.create',
              'appointment.reschedule',
              'appointment.cancel',
              'clinical.vitals.record',
            ],
          },
        },
      },
    ],
  },

  'DELETE /api/v1/roles/{roleId}': {
    summary: 'Delete a role',
    description: `
Remove a role this clinic defined.

**A role somebody still holds cannot be deleted** — \`409\`, naming nothing.
Reassign those members first; the alternative is silently stripping people of
access, which is exactly the kind of change that is discovered at the counter
rather than in a review.

A system role is \`403\`. Answers \`null\` data on success.
`.trim(),
    message: 'Role removed',
    errors: [403, 409],
    params: { roleId: 'The role, as `GET /api/v1/roles` lists it. A system role is `403`.' },
    responseExamples: [
      {
        summary: 'Removed',
        value: { success: true, message: 'Role removed', data: null },
      },
    ],
  },

  /* ────────────────────────────── members ────────────────────────────── */

  'GET /api/v1/members': {
    summary: 'List members',
    description: `
Everybody who works at this clinic, with the roles they hold and any per-person
exceptions on top.

Each role assignment carries its own \`branchId\` — \`null\` meaning org-wide —
so this one response answers "who is a doctor at Kochi" without a second call.

The list is scoped to what the caller may see: somebody whose own roles are
confined to one branch sees that branch's staff, not the whole group.
`.trim(),
    response: memberListResponse,
    responseExamples: [
      {
        summary: 'A doctor and a receptionist',
        value: {
          success: true,
          message: 'Success',
          data: {
            members: [
              MEMBER_EXAMPLE,
              {
                id: RECEPTIONIST_MEMBERSHIP_ID,
                userId: RECEPTIONIST.id,
                fullName: RECEPTIONIST.fullName,
                email: RECEPTIONIST.email,
                phone: RECEPTIONIST.phone,
                status: 'ACTIVE',
                employeeCode: 'ALP-031',
                department: 'Front Office',
                designationId: DESIGNATION_FRONT_DESK_ID,
                designationName: 'Front Desk Executive',
                joinedOn: '2026-03-16',
                relievedOn: null,
                roles: [
                  {
                    id: RECEPTION_ASSIGNMENT_ID,
                    roleId: ROLE_RECEPTION_ID,
                    roleCode: 'RECEPTIONIST',
                    roleName: 'Receptionist',
                    branchId: BRANCH_ID,
                    branchName: 'Alpha Clinic — Indiranagar',
                    validFrom: '2026-03-16T00:00:00.000Z',
                    validTo: null,
                  },
                ],
                overrides: [],
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/members/{membershipId}': {
    summary: 'Get a member',
    description:
      "One person's employment record, every role assignment they hold and every permission exception set on them. The same shape as one entry in `GET /api/v1/members`.",
    response: memberDetail,
    params: { membershipId: MEMBERSHIP_NOTE },
    responseExamples: [
      { summary: 'A doctor', value: { success: true, message: 'Success', data: MEMBER_EXAMPLE } },
    ],
  },

  'PATCH /api/v1/members/{membershipId}': {
    summary: 'Update a member',
    description: `
The employment record: employee code, department, job title and the dates they
joined and left.

⚠️ **This grants nothing and revokes nothing.** It sits behind
\`iam.user.update\` precisely so a practice manager can keep employee codes and
departments current without being able to touch access. Changing what somebody
may do is \`POST /members/{id}/roles\`, which is a different permission on
purpose.

\`designationId\` is the job *title* — "Consultant Physician" — and it is not a
role. Titles are cosmetic and appear on documents; roles decide access. A clinic
may pair them so that picking a title suggests a role, which is what
\`/designations/pairings\` configures, but the two are never the same field.

Setting \`relievedOn\` does not cut off access either. That is
\`POST /members/{id}/suspend\`.
`.trim(),
    response: memberDetail,
    message: 'Details updated',
    params: { membershipId: MEMBERSHIP_NOTE },
    requestExamples: [
      {
        summary: 'Assign an employee code',
        value: { employeeCode: 'ALP-014', department: 'General Medicine' },
      },
      {
        summary: 'Record a leaving date',
        description: 'Does **not** suspend them — access continues until it is suspended.',
        value: { relievedOn: '2026-06-30' },
      },
      { summary: 'Clear the department', value: { department: null } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Details updated', data: MEMBER_EXAMPLE },
      },
    ],
  },

  'POST /api/v1/members/{membershipId}/roles': {
    summary: 'Assign a role',
    description: `
Give somebody a role, at one branch or across the whole clinic.

⚠️ **\`branchId: null\` MEANS EVERY BRANCH — now and in future.** It is not "no
branch" and it is not a default to reach for. A doctor assigned org-wide gains
access to a branch the clinic opens next year without anybody revisiting this
decision, which is sometimes exactly right and sometimes a quiet over-grant.
Name the branch unless org-wide is genuinely what is meant.

**You cannot assign a role carrying permissions you do not hold yourself.** The
check is on the role's whole code set, so this is not a route to escalation.

\`validFrom\` and \`validTo\` make the assignment temporary — a locum covering a
fortnight gets a role that expires on its own rather than one somebody has to
remember to remove. Both are UTC instants.

Answers \`201\` with the member's full record, so a screen can re-render from the
response.
`.trim(),
    response: memberDetail,
    status: 201,
    message: 'Role assigned',
    errors: [403, 409],
    params: { membershipId: MEMBERSHIP_NOTE },
    requestExamples: [
      {
        summary: 'Receptionist at one branch',
        value: { roleId: ROLE_RECEPTION_ID, branchId: BRANCH_ID },
      },
      {
        summary: 'Doctor across the whole clinic',
        description: '`branchId: null` — every branch, including ones not opened yet.',
        value: { roleId: ROLE_DOCTOR_ID, branchId: null },
      },
      {
        summary: 'A locum for a fortnight',
        description: 'Expires on its own; nobody has to remember to revoke it.',
        value: {
          roleId: ROLE_DOCTOR_ID,
          branchId: BRANCH_KOCHI_ID,
          validFrom: '2026-04-01T00:00:00.000Z',
          validTo: '2026-04-15T00:00:00.000Z',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Assigned',
        value: { success: true, message: 'Role assigned', data: MEMBER_EXAMPLE },
      },
    ],
  },

  'DELETE /api/v1/members/{membershipId}/roles/{assignmentId}': {
    summary: 'Remove a role',
    description: `
Take one role assignment away.

**Addressed by \`assignmentId\`, not by role id**, because the same role may be
held twice by the same person at different branches — removing "the DOCTOR role"
would be ambiguous, and the ambiguity would resolve differently depending on row
order.

Takes effect immediately, mid-session: permissions are resolved per request and
are deliberately not in the JWT, so there is no token to wait out.

Returns the member's full record with the assignment gone.
`.trim(),
    response: memberDetail,
    message: 'Role removed',
    params: {
      membershipId: MEMBERSHIP_NOTE,
      assignmentId:
        "The **assignment** id from the member's `roles[]`, not the role id — the same role may be held at more than one branch.",
    },
    responseExamples: [
      {
        summary: 'Removed',
        value: {
          success: true,
          message: 'Role removed',
          data: { ...MEMBER_EXAMPLE, roles: [] },
        },
      },
    ],
  },

  'POST /api/v1/members/{membershipId}/overrides': {
    summary: 'Grant or deny one permission',
    description: `
A single-code exception for one person, on top of whatever their roles say.

⚠️ **\`DENY\` BEATS EVERYTHING.** It overrules any role that grants the code,
including an org-wide one, and there is no ordering to reason about. That makes
it the right tool for "this one person must not do this one thing" and the wrong
tool for anything a role could express.

⚠️ **This is the escape hatch, not the mechanism.** Overrides are invisible in
the role list, so a clinic that grants access this way ends up unable to answer
"who can sign prescriptions" by reading its roles. If more than one person needs
the same exception, that is a role.

Same scoping rule as an assignment: \`branchId: null\` is every branch.
\`reason\` is optional, kept on the record, and is the only thing that will
explain this to whoever finds it in a year.

Setting an override for a code that already has one replaces it.
`.trim(),
    response: memberDetail,
    message: 'Exception saved',
    errors: [403],
    params: { membershipId: MEMBERSHIP_NOTE },
    requestExamples: [
      {
        summary: 'Let one receptionist reschedule',
        value: {
          permissionCode: 'appointment.reschedule',
          branchId: BRANCH_ID,
          effect: 'GRANT',
          reason: 'Covers the appointments desk on Saturdays',
        },
      },
      {
        summary: 'Bar one person from a code their role grants',
        description: '`DENY` wins over every role, org-wide.',
        value: {
          permissionCode: 'billing.invoice.void',
          branchId: null,
          effect: 'DENY',
          reason: 'Under review following a reconciliation discrepancy',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Saved',
        value: {
          success: true,
          message: 'Exception saved',
          data: {
            ...MEMBER_EXAMPLE,
            overrides: [
              {
                id: OVERRIDE_ID,
                permissionCode: 'appointment.reschedule',
                branchId: BRANCH_ID,
                branchName: 'Alpha Clinic — Indiranagar',
                effect: 'GRANT',
                reason: 'Covers the appointments desk on Saturdays',
              },
            ],
          },
        },
      },
    ],
  },

  'DELETE /api/v1/members/{membershipId}/overrides/{overrideId}': {
    summary: 'Remove a permission exception',
    description: `
Drop one override and fall back to what this person's roles say.

Removing a \`DENY\` restores whatever the roles grant; removing a \`GRANT\`
takes the code away unless a role also carries it. Either way the effect is
immediate — permissions are resolved per request.

Returns the member's full record with the override gone.
`.trim(),
    response: memberDetail,
    message: 'Exception removed',
    params: {
      membershipId: MEMBERSHIP_NOTE,
      overrideId: "The override's id, from the member's `overrides[]`.",
    },
    responseExamples: [
      {
        summary: 'Removed',
        value: { success: true, message: 'Exception removed', data: MEMBER_EXAMPLE },
      },
    ],
  },

  'POST /api/v1/members/{membershipId}/suspend': {
    summary: 'Suspend a member',
    description: `
Cut off somebody's access without unpicking what they hold.

⚠️ **Their roles and overrides are left exactly as they are.** That is the
distinction from removing assignments: a suspension is reversible in one call
and survives whatever staffing change prompted it, so somebody on leave, under
investigation, or between contracts comes back to the access they had rather
than to a rebuilt approximation of it.

Existing sessions are revoked, so the effect is immediate rather than at the next
sign-in.

\`reason\` is optional and goes on the audit record. Suspending an already
suspended member is \`409\`.
`.trim(),
    response: memberDetail,
    message: 'Access suspended',
    errors: [409],
    params: { membershipId: MEMBERSHIP_NOTE },
    requestExamples: [
      { summary: 'With a reason', value: { reason: 'On extended leave until August' } },
      { summary: 'Without one', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Suspended',
        description: 'Note `roles` is untouched — only `status` moved.',
        value: {
          success: true,
          message: 'Access suspended',
          data: { ...MEMBER_EXAMPLE, status: 'SUSPENDED' },
        },
      },
    ],
  },

  'POST /api/v1/members/{membershipId}/reactivate': {
    summary: 'Reactivate a member',
    description: `
Restore access to somebody who was suspended. They come back to the roles and
overrides they had — nothing was removed, so nothing has to be rebuilt.

They will need to sign in again: suspension revoked their sessions and this does
not mint new ones.

Reactivating a member who is already active is \`409\`.
`.trim(),
    response: memberDetail,
    message: 'Access restored',
    errors: [409],
    params: { membershipId: MEMBERSHIP_NOTE },
    requestExamples: [
      { summary: 'With a reason', value: { reason: 'Returned from leave' } },
      { summary: 'Without one', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Restored',
        value: { success: true, message: 'Access restored', data: MEMBER_EXAMPLE },
      },
    ],
  },

  /* ──────────────────────────── designations ──────────────────────────── */

  'GET /api/v1/designations': {
    summary: 'List job titles',
    description: `
The job titles available here — the ones rcln ships, plus any this clinic added.

⚠️ **A designation is a TITLE, not a role.** "Consultant Physician" is what
appears on a prescription and in the staff directory; it grants nothing at all.
What somebody may do is decided entirely by their roles. The two are separate
fields on a membership and are never merged.

\`isOwn\` distinguishes a clinic's own titles from the shipped ones. \`roleIds\`
is the pairing — the roles this title usually comes with — which is a *hint* for
the invite screen, not an assignment.
`.trim(),
    response: designationListResponse,
    responseExamples: [
      {
        summary: "Shipped titles and one of the clinic's own",
        value: {
          success: true,
          message: 'Success',
          data: {
            designations: [
              {
                id: DESIGNATION_PHYSICIAN_ID,
                code: 'CONSULTANT_PHYSICIAN',
                name: 'Consultant Physician',
                isOwn: false,
                roleIds: [ROLE_DOCTOR_ID],
              },
              {
                id: DESIGNATION_FRONT_DESK_ID,
                code: 'FRONT_DESK_EXECUTIVE',
                name: 'Front Desk Executive',
                isOwn: false,
                roleIds: [ROLE_RECEPTION_ID],
              },
              {
                id: DESIGNATION_AYURVEDA_ID,
                code: 'AYURVEDA_CONSULTANT',
                name: 'Ayurveda Consultant',
                isOwn: true,
                roleIds: [ROLE_DOCTOR_ID],
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/designations/pairings': {
    summary: 'List title pairings',
    description: `
Which job titles each role is normally held with, keyed by role.

This is what makes the invite screen useful: pick "Consultant Physician" and it
suggests the DOCTOR role, rather than presenting every role the clinic has and
hoping. It is **only a suggestion** — the role actually assigned is whatever the
request says, and nothing here is enforced at permission-resolution time.

Behind \`iam.designation.manage\` rather than \`iam.user.read\`, because it is
configuration rather than a fact about the staff.
`.trim(),
    response: rolePairingListResponse,
    responseExamples: [
      {
        summary: 'Two roles with their usual titles',
        value: {
          success: true,
          message: 'Success',
          data: {
            roles: [
              {
                roleId: ROLE_DOCTOR_ID,
                roleName: 'Doctor',
                designations: [
                  {
                    id: DESIGNATION_PHYSICIAN_ID,
                    name: 'Consultant Physician',
                    isPaired: true,
                  },
                  {
                    id: DESIGNATION_AYURVEDA_ID,
                    name: 'Ayurveda Consultant',
                    isPaired: true,
                  },
                  {
                    id: DESIGNATION_FRONT_DESK_ID,
                    name: 'Front Desk Executive',
                    isPaired: false,
                  },
                ],
              },
              {
                roleId: ROLE_RECEPTION_ID,
                roleName: 'Receptionist',
                designations: [
                  {
                    id: DESIGNATION_FRONT_DESK_ID,
                    name: 'Front Desk Executive',
                    isPaired: true,
                  },
                  {
                    id: DESIGNATION_PHYSICIAN_ID,
                    name: 'Consultant Physician',
                    isPaired: false,
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  },

  'PUT /api/v1/designations/pairings/{roleId}': {
    summary: 'Set which titles pair with a role',
    description: `
Replace the set of job titles suggested for one role.

**\`PUT\`, so the list REPLACES** — send every designation id the role should
pair with. An empty array is valid and means the role suggests no title at all.

Purely a UI affordance. It changes nothing about access, nothing about existing
memberships, and nothing about permission resolution — it decides what the invite
screen offers next time somebody opens it.

Answers \`null\` data.
`.trim(),
    message: 'Titles updated',
    params: { roleId: 'The role whose pairings are being replaced.' },
    requestExamples: [
      {
        summary: 'Two titles for the doctor role',
        value: {
          designationIds: [DESIGNATION_PHYSICIAN_ID, DESIGNATION_AYURVEDA_ID],
        },
      },
      { summary: 'Suggest nothing', value: { designationIds: [] } },
    ],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Titles updated', data: null } },
    ],
  },

  'POST /api/v1/designations': {
    summary: 'Add a job title',
    description: `
Create a title of this clinic's own — an "Ayurveda Consultant" that rcln does
not ship.

Grants nothing. It is a label on a membership that appears in the directory and
on documents; access still comes entirely from roles.

\`roleId\` is optional and only sets up the pairing, so the title suggests that
role on the invite screen. \`code\` is derived from the name and is unique within
this clinic — a duplicate name is \`409\`.
`.trim(),
    response: designationSummary,
    status: 201,
    message: 'Title added',
    errors: [409],
    requestExamples: [
      {
        summary: 'A title paired with the doctor role',
        value: { name: 'Ayurveda Consultant', roleId: ROLE_DOCTOR_ID },
      },
      {
        summary: 'A title with no pairing',
        value: { name: 'Practice Manager' },
      },
    ],
    responseExamples: [
      {
        summary: 'Added',
        value: {
          success: true,
          message: 'Title added',
          data: {
            id: DESIGNATION_AYURVEDA_ID,
            code: 'AYURVEDA_CONSULTANT',
            name: 'Ayurveda Consultant',
            isOwn: true,
            roleIds: [ROLE_DOCTOR_ID],
          },
        },
      },
    ],
  },
};
