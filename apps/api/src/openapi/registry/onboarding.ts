/**
 * Onboarding — the seven questions a new clinic answers once.
 *
 * ⚠️ THE ONE IDEA A READER OF THESE DOCS MUST LEAVE WITH: these endpoints SEED
 *   settings, they do not shadow them. A step writes the clinic's answer and
 *   derives concrete `setting_values` rows from it, once, only where the clinic
 *   has not already set a value at that scope. Afterwards the settings screen is
 *   the authority and re-running a step will not overrule it. That is ADR-0018,
 *   and it is why every step is a PUT.
 *
 * ⚠️ NOTHING ON THIS SURFACE GRANTS ANYBODY ANYTHING. The `modules` a clinic
 *   picks decide which navigation tabs are drawn; every endpoint behind those
 *   tabs still checks its own permission. Ticking Pharmacy does not let anyone
 *   dispense, and unticking it does not stop anyone who could.
 *
 * NO PHI ANYWHERE HERE. A clinic profile names no patient — the closest it comes
 * is deciding what a patient RECORD defaults to — so nothing is read-audited and
 * every id is safe in a URL.
 */
import { onboardingState } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  CARE_CONTEXT_ID,
  CARE_CONTEXT_VET_ID,
  ROLE_RECEPTION_ID,
} from './fixtures.js';

/**
 * The pet clinic, which is the example that makes this whole feature legible:
 * one care context, so the front desk is never asked "person or animal?".
 */
const VET_ONLY_STATE = {
  steps: [
    { step: 'IDENTITY', visited: true, completedAt: '2026-02-02T05:30:00.000Z' },
    { step: 'CARE_CONTEXTS', visited: true, completedAt: '2026-02-02T05:34:00.000Z' },
    { step: 'MODULES', visited: true, completedAt: '2026-02-02T05:38:00.000Z' },
    { step: 'LOCALE_HOURS', visited: true, completedAt: '2026-02-02T05:45:00.000Z' },
    { step: 'TAX_BILLING', visited: true, completedAt: '2026-02-02T05:52:00.000Z' },
    { step: 'STAFF', visited: true, completedAt: '2026-02-02T05:58:00.000Z' },
    { step: 'REVIEW', visited: false, completedAt: null },
  ],
  completedAt: null,
  profile: {
    careContextIds: [CARE_CONTEXT_VET_ID],
    careContextCodes: ['VET'],
    modules: ['APPOINTMENTS', 'CONSULTATIONS', 'BILLING', 'PHARMACY', 'INVENTORY'],
  },
  branchProfiles: [],
  entitledModules: [
    'APPOINTMENTS',
    'CONSULTATIONS',
    'BILLING',
    'PHARMACY',
    'INVENTORY',
    'PROCUREMENT',
    'ONLINE_ORDERS',
  ],
  careContextOptions: [
    {
      id: CARE_CONTEXT_ID,
      code: 'HUMAN',
      name: 'Human',
      description: 'People.',
      isOwn: false,
    },
    {
      id: CARE_CONTEXT_VET_ID,
      code: 'VET',
      name: 'Veterinary',
      description: 'Animals.',
      isOwn: false,
    },
  ],
  identity: {
    legalName: 'Alpha Veterinary Care Private Limited',
    displayName: 'Alpha Pet Clinic',
    orgType: 'CLINIC',
    facilityKind: 'CLINIC',
    countryCode: 'IN',
    regionCode: 'KA',
  },
  branches: [
    {
      id: BRANCH_ID,
      name: 'Whitefield',
      isPrimary: true,
      timezone: 'Asia/Kolkata',
      timeFormat: '12H',
      slotMinutes: 20,
      operatingHours: [
        { dayOfWeek: 1, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 20 },
        { dayOfWeek: 0, opensAt: '09:00', closesAt: '13:00', isClosed: false, slotMinutes: 20 },
      ],
    },
  ],
  billing: {
    invoicePrefix: 'INV',
    defaultTaxPercent: 0,
    financialYearStartMonth: 4,
    cashRoundingMinor: 100,
    hasTaxRegistration: true,
  },
  invitableRoles: [{ id: ROLE_RECEPTION_ID, name: 'Receptionist' }],
  pendingInvitationCount: 2,
};

const SAVED = (message: string): { summary: string; value: unknown } => ({
  summary: message,
  value: { success: true, message, data: VET_ONLY_STATE },
});

export const onboardingDocs: DocRegistry = {
  'GET /api/v1/onboarding': {
    summary: 'Get the setup wizard',
    description: `
Everything the setup wizard needs to draw itself: which of the seven steps are
done, what the clinic has answered so far, and the choices each step may offer.

**One call rather than seven, deliberately.** The wizard's rail shows every
step's state on the first paint; fetching per step would render a rail that
fills in while the user watches.

\`entitledModules\` is what this clinic's **plan** allows, resolved through the
billing engine. It is returned here and is deliberately *not* on the session:
resolving it reads the subscription, and the front desk holds no billing
permission. The session carries only what the clinic **picked**.
`.trim(),
    response: onboardingState,
    responseExamples: [
      {
        summary: 'A pet clinic, one step from finished',
        value: { success: true, message: 'Success', data: VET_ONLY_STATE },
      },
    ],
  },

  'PUT /api/v1/onboarding/steps/identity': {
    summary: 'Step 1 — who you are',
    description: `
The clinic's legal and trading names, what kind of place it is, and where it
sits. Pre-filled from what registration already captured, so for most clinics
this step is a confirmation rather than a form.

\`facilityKind\` also sets the **primary** branch's type — a solo practice whose
organization is a \`CLINIC\` has a branch that is one too. Other branches are set
up individually and are not touched, so re-running this step cannot retype a
pharmacy site as a hospital.

Seeds no settings.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'A single-site veterinary clinic',
        value: {
          legalName: 'Alpha Veterinary Care Private Limited',
          displayName: 'Alpha Pet Clinic',
          orgType: 'CLINIC',
          facilityKind: 'CLINIC',
          countryCode: 'IN',
          regionCode: 'KA',
        },
      },
    ],
    responseExamples: [SAVED('Saved')],
  },

  'PUT /api/v1/onboarding/steps/care-contexts': {
    summary: 'Step 2 — who you treat',
    description: `
Which care contexts this clinic works in — \`HUMAN\`, \`VET\`, or both. The ids
come from \`careContextOptions\` on \`GET /api/v1/onboarding\`; they are
\`CARE_CONTEXT\` nodes at the root of the specialty taxonomy, not a separate
vocabulary.

**The number of contexts is what this step actually decides.** Name exactly one
and \`patient.default_subject_type\` is seeded from it, and the patient
registration form stops asking "person or animal?" — a pet clinic never sees the
question. Name two and the picker appears, defaulted to the first.

Because it is exactly one setting seeded from one answer, a clinic that later
changes its mind in **Settings** is not overruled: re-running this step writes
nothing over an explicit value.

Send \`branchId\` to answer for one site rather than for the organization — the
small-animal satellite of a human practice. Omit it for the organization's own
answer, which every branch inherits unless it overrides it.

Refused with **400** if any id is not a care context this clinic can use.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'A pet clinic — animals only, so the picker disappears',
        value: { careContextIds: [CARE_CONTEXT_VET_ID] },
      },
      {
        summary: 'A mixed practice — the picker stays, defaulted to people',
        value: { careContextIds: [CARE_CONTEXT_ID, CARE_CONTEXT_VET_ID] },
      },
      {
        summary: 'One site answers differently from its group',
        value: { branchId: BRANCH_KOCHI_ID, careContextIds: [CARE_CONTEXT_VET_ID] },
      },
    ],
    responseExamples: [SAVED('Saved')],
    errors: [400, 404],
  },

  'PUT /api/v1/onboarding/steps/modules': {
    summary: 'Step 3 — what you run',
    description: `
Which parts of the product this clinic actually uses. It decides which
navigation tabs are drawn and nothing else.

**This is not a permission and not an entitlement.** Three separate questions
share this vocabulary: \`plan_features\` says what the clinic *may* have, this
step says what they *picked* from that, and \`membership_roles\` says *who* may
touch it. Every endpoint behind a hidden tab still checks its own permission, so
a caller who types the URL is refused exactly as before.

Picking a module the plan does not include is refused with **400** and a message
naming it — deliberately not a 403, which would send the clinic to their
administrator instead of to billing, and deliberately not a 422, which on this
API means a *jurisdiction* refused something.

Choosing Pharmacy seeds \`inventory.expiry_alert_days\` and
\`inventory.batch_selection_strategy\`, which a clinic running a counter needs
answers to on day one and a clinic without one should never be asked about.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'A clinic that dispenses but does not run a lab',
        value: {
          modules: ['APPOINTMENTS', 'CONSULTATIONS', 'BILLING', 'PHARMACY', 'INVENTORY'],
        },
      },
      {
        summary: 'A satellite that is only a pharmacy counter',
        value: { branchId: BRANCH_KOCHI_ID, modules: ['PHARMACY', 'INVENTORY', 'BILLING'] },
      },
    ],
    responseExamples: [SAVED('Saved')],
    errors: [400, 404],
  },

  'PUT /api/v1/onboarding/steps/locale': {
    summary: "Step 4 — when you're open",
    description: `
One branch's time zone, clock format, appointment length and opening week.

**\`branchId\` is required here, unlike steps 2 and 3.** A time zone and a set of
opening hours are facts about a *place*; there is no organization-level answer
for a group with a site in each of two states.

\`timezone\` is a column on the branch, not a setting — every instant rcln stores
is UTC and this is what renders it. \`timeFormat\` and \`slotMinutes\` are
settings, seeded at the branch scope.

The week is replaced whole: a day absent from \`operatingHours\` is removed,
which is how a branch drops to a six-day week. Times are \`HH:MM\` in the
branch's own zone.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'Six days, longer slots for a veterinary consult',
        value: {
          branchId: BRANCH_ID,
          timezone: 'Asia/Kolkata',
          timeFormat: '12H',
          slotMinutes: 20,
          operatingHours: [
            {
              dayOfWeek: 1,
              opensAt: '09:00',
              closesAt: '19:00',
              isClosed: false,
              slotMinutes: 20,
            },
            {
              dayOfWeek: 0,
              opensAt: '09:00',
              closesAt: '13:00',
              isClosed: false,
              slotMinutes: 20,
            },
          ],
        },
      },
    ],
    responseExamples: [SAVED('Saved')],
    errors: [404, 409],
  },

  'PUT /api/v1/onboarding/steps/tax': {
    summary: 'Step 5 — how you bill',
    description: `
The invoice prefix, the fallback tax rate, the financial year and cash rounding —
plus, optionally, the clinic's own tax registration.

⚠️ **\`taxRegistration\` is the clinic as an ISSUER, not as rcln's customer, and
these are two different numbers in the general case.** It creates an
\`issuer_tax_registrations\` row: the GSTIN printed on the invoices this clinic
raises against *its own patients*, effective-dated because one business can hold
several. The number rcln bills the *clinic* under is
\`organizations.taxId\`, which is derived from these registrations rather than
typed, and this endpoint never writes it. A screen that does not label the
difference will collect one number twice and be wrong once.

\`cashRoundingMinor\` is in **minor units** — \`100\` rounds to the whole rupee,
\`1\` rounds nothing.

Every field is optional. A clinic that has applied for registration and not
received it is a real clinic, and setup must stay finishable.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'Registered, rounding to the rupee at the counter',
        value: {
          invoicePrefix: 'APC',
          defaultTaxPercent: 0,
          financialYearStartMonth: 4,
          cashRoundingMinor: 100,
          taxRegistration: {
            countryCode: 'IN',
            regionCode: 'KA',
            scheme: 'GST',
            registrationNumber: '29AABCA1234M1Z7',
            legalName: 'Alpha Veterinary Care Private Limited',
            effectiveFrom: '2026-01-01',
          },
        },
      },
      {
        summary: 'Not registered for tax yet',
        value: { invoicePrefix: 'APC', financialYearStartMonth: 4 },
      },
    ],
    responseExamples: [SAVED('Saved')],
    errors: [400, 409],
  },

  'PUT /api/v1/onboarding/steps/staff': {
    summary: 'Step 6 — who works here',
    description: `
Invitations for the rest of the team. Each one goes through the ordinary
invitation path, which sends the email and writes its own audit row.

⚠️ **Not idempotent in the way the other steps are.** A duplicate setting write
is a no-op; a duplicate invitation is an email a real person receives. Send only
the invitations that have not been sent yet — \`pendingInvitationCount\` on the
wizard state says how many are already outstanding.

An empty list is valid. A solo practitioner is the common case, and they are
already a member.
`.trim(),
    response: onboardingState,
    requestExamples: [
      {
        summary: 'One receptionist, for the main site',
        value: {
          invitations: [
            {
              email: 'front.desk@alphapet.example',
              roleId: ROLE_RECEPTION_ID,
              branchIds: [BRANCH_ID],
            },
          ],
        },
      },
      { summary: 'A solo practice with nobody to invite', value: { invitations: [] } },
    ],
    responseExamples: [SAVED('Invitations sent')],
    errors: [400, 404, 409],
  },

  'POST /api/v1/onboarding/complete': {
    summary: 'Finish setup',
    description: `
Marks setup complete. From the next page load the wizard stops intercepting the
owner and the "setup incomplete" banner stops rendering for everyone else.

**It does not require every other step to be complete, and that is deliberate.**
A clinic with no tax registration and nobody to invite has genuinely finished;
refusing to let them out until they invent an answer is how a setup flow becomes
something people work around. The review screen shows what is unanswered and
lets them finish anyway.

A \`POST\` rather than a \`PUT\` because it is an event, not a value — it is the
only call on this surface that changes what the shell does next.
`.trim(),
    response: onboardingState,
    responseExamples: [
      {
        summary: 'Setup finished',
        value: {
          success: true,
          message: 'Setup complete',
          data: {
            ...VET_ONLY_STATE,
            completedAt: '2026-02-02T06:04:00.000Z',
            steps: VET_ONLY_STATE.steps.map((s) =>
              s.step === 'REVIEW'
                ? { step: 'REVIEW', visited: true, completedAt: '2026-02-02T06:04:00.000Z' }
                : s
            ),
          },
        },
      },
    ],
  },
};
