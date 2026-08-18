/**
 * Platform admin — the super-admin console, on the admin host, outside every
 * tenant.
 *
 * ⚠️ A CALLER WITHOUT THE PLATFORM FLAG IS ANSWERED `404`, NEVER `403`. A `403`
 *   confirms the console exists and is worth attacking; a `404` says nothing.
 *   The same reasoning answers `404` for an unknown tenant everywhere else in
 *   the API.
 *
 * ⚠️ THE LISTS HERE READ ACROSS EVERY TENANT and use the unsafe client, because
 *   there is no single organization to scope them to. The exception is a route
 *   naming ONE organization — that goes through `withTenant`, so the RLS policies
 *   still apply and a typo in a query cannot return somebody else's invoices.
 *
 * ⚠️ NOTHING HERE MUTATES A CLINIC'S OWN DATA. A super admin who needs to change
 *   a plan does it the way the clinic would — through impersonation, which writes
 *   an audit row naming the real administrator and their stated reason (ADR-0012).
 *   A console endpoint that mutated billing directly would be the one billing
 *   change in the system with no attributable actor.
 *
 * ⚠️ AND THE TAX AND REGULATORY ROUTES CHANGE WHAT EVERY CLINIC IS CHARGED, WITH
 *   NO PUBLISH STEP. Read each one's warning before calling it.
 */
import { platformOrganizationListResponse, registerOrganizationResponse } from '@rcln/contracts';
import type { DocRegistry, EndpointDoc } from '../types.js';
import {
  AUTHORITY_ID,
  JURISDICTION_ID,
  ORGANIZATION,
  ORG_ID,
  REGULATORY_SOURCE_ID,
} from './fixtures.js';

const PLATFORM_404 =
  'A caller without the platform-admin flag is answered `404` for every route on this router — never `403`.';

const NO_PUBLISH_STEP = `
⚠️ **This changes what clinics are charged, with no publish step and no draft
state.** The tax engine reads these rows on every invoice, so a write here
reaches the next invoice raised in that jurisdiction. That is deliberate — one
row when a rate notification lands, rather than a migration across every tenant —
and it is why \`effectiveFrom\` is how you schedule a change rather than a
workflow.
`.trim();

/** The regulatory authoring surface: five resources, all the same shape. */
interface LawResource {
  readonly path: string;
  /** Singular, lowercase. */
  readonly noun: string;
  readonly what: string;
  readonly createExample: unknown;
  readonly updateExample: unknown;
}

const LAW: readonly LawResource[] = [
  {
    path: 'jurisdictions',
    noun: 'jurisdiction',
    what: "A country or a region within one. Everything else in the regulatory domain hangs off a jurisdiction, and a clinic falls into one by its branch's country and region codes.",
    createExample: { countryCode: 'IN', regionCode: null, name: 'India' },
    updateExample: { name: 'India (Republic of)' },
  },
  {
    path: 'authorities',
    noun: 'regulator',
    what: 'A body whose rules apply — CDSCO, a state drugs controller. What a refusal names when a clinic asks on whose authority.',
    createExample: {
      code: 'CDSCO',
      name: 'Central Drugs Standard Control Organisation',
      jurisdictionId: JURISDICTION_ID,
    },
    updateExample: { name: 'Central Drugs Standard Control Organisation (CDSCO)' },
  },
  {
    path: 'sources',
    noun: 'legal source',
    what: 'The document rules were drawn from — an act, a schedule, a circular — with a citation a clinic can follow. This is what makes a refusal accountable rather than merely automatic.',
    createExample: {
      code: 'IN-DC-RULES-1945',
      title: 'Drugs and Cosmetics Rules, 1945',
      authorityId: AUTHORITY_ID,
      jurisdictionId: JURISDICTION_ID,
      citationUrl: 'https://cdsco.gov.in/',
      effectiveFrom: '1945-12-21',
    },
    updateExample: { status: 'SUPERSEDED' },
  },
];

const lawResource = (r: LawResource): DocRegistry => {
  const base = `/api/v1/platform/regulatory/${r.path}`;
  const list: EndpointDoc = {
    summary: `List ${r.path}`,
    description: `${r.what}\n\nPlatform data — every clinic in the jurisdiction reads the same rows. ${PLATFORM_404}`,
    paginated: true,
    params: { page: 'Page number, from 1.', pageSize: 'Rows per page.' },
  };
  const create: EndpointDoc = {
    summary: `Create a ${r.noun}`,
    description: `${r.what}\n\n⚠️ **This is platform law, shared by every clinic in the jurisdiction.** No tenant can write it — a database trigger refuses a write from any transaction claiming a tenant — and nothing here is scoped to one clinic.`,
    status: 201,
    errors: [409],
    requestExamples: [{ summary: `A ${r.noun}`, value: r.createExample }],
  };
  const update: EndpointDoc = {
    summary: `Update a ${r.noun}`,
    description: `Correct a ${r.noun}. Rows already cited by rules or evaluations keep their identity — a genuinely different ${r.noun} is a new row, not an edit.`,
    errors: [409],
    params: { id: `The ${r.noun}.` },
    requestExamples: [{ summary: 'A correction', value: r.updateExample }],
  };
  return {
    [`GET ${base}`]: list,
    [`POST ${base}`]: create,
    [`PATCH ${base}/{id}`]: update,
  };
};

export const platformDocs: DocRegistry = {
  'POST /api/v1/platform/organizations': {
    summary: 'Create a clinic',
    description: `
Register a clinic from the console — the same act as public self-registration,
performed by rcln staff for a customer being onboarded.

Same transaction and same result as \`POST /api/v1/public/organizations/register\`:
the organization, its first branch, the owner's user and membership, and a trial
subscription.

Returns a \`loginUrl\` rather than tokens, for the same reason the public route
does — a session cookie must be scoped to the host that owns it.
`.trim(),
    response: registerOrganizationResponse,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Onboard a clinic',
        value: {
          organization: {
            legalName: 'Sunrise Dental LLP',
            displayName: 'Sunrise Dental',
            slug: 'sunrise',
            countryCode: 'IN',
            regionCode: 'MH',
          },
          branch: { name: 'Sunrise Dental — Kothrud', city: 'Pune', pincode: '411038' },
          owner: {
            fullName: 'Dr Anita Desai',
            email: 'anita@sunrisedental.in',
            phone: '+919845099887',
            password: 'correct-horse-battery-staple',
          },
          acceptedTerms: true,
        },
      },
    ],
  },

  'GET /api/v1/platform/organizations': {
    summary: 'List clinics',
    description: `
Every clinic on the platform.

**Reads across every tenant**, which is why it uses the unsafe client — there is
no single organization to scope it to. ${PLATFORM_404}
`.trim(),
    response: platformOrganizationListResponse,
    paginated: true,
    params: {
      search: 'Match on name or slug.',
      status: 'Filter by organization status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One clinic',
        value: {
          success: true,
          message: 'Success',
          data: {
            organizations: [
              {
                id: ORG_ID,
                name: ORGANIZATION.name,
                slug: ORGANIZATION.slug,
                status: 'ACTIVE',
                orgType: 'CLINIC',
                countryCode: 'IN',
                branchCount: 2,
                memberCount: 9,
                createdAt: '2024-10-28T05:30:00.000Z',
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

  'POST /api/v1/platform/organizations/{organizationId}/impersonate': {
    summary: 'Enter a clinic as rcln staff',
    description: `
Begin an impersonation session inside a customer's clinic.

⚠️ **ANSWERS A TICKET, NOT A SESSION.** Session cookies are host-only, so this
host cannot write one for a clinic's subdomain. The browser carries the ticket
across and \`POST /api/v1/auth/impersonation/claim\` on the **clinic's own host**
redeems it.

⚠️ **Every write made while impersonating is attributed twice** — to the
membership acted through, and to the rcln administrator in \`onBehalfOf\`
(ADR-0012). The clinic can tell our writes from their own, by name, which is the
entire point.

\`reason\` is required and lands on the audit trail. This is why there are no
console endpoints that mutate a clinic's data directly: a change made here would
be the one change with no attributable actor.
`.trim(),
    status: 201,
    errors: [409],
    params: { organizationId: `The clinic to enter. ${PLATFORM_404}` },
    requestExamples: [
      {
        summary: 'Investigating a support ticket',
        value: { reason: 'Ticket #4821 — invoice totals disputed by the clinic' },
      },
    ],
    responseExamples: [
      {
        summary: 'A ticket to redeem on the clinic host',
        value: {
          success: true,
          message: 'Success',
          data: {
            ticket: 'imp_9Kd2xQ0mV3xY7pR2wL9nT4bC6sA5fH…',
            expiresIn: 60,
            claimUrl: `https://${ORGANIZATION.slug}.rcln.com/impersonate/claim`,
          },
        },
      },
    ],
  },

  'GET /api/v1/platform/organizations/{organizationId}/subscription': {
    summary: "Get a clinic's subscription",
    description: `
One clinic's billing, for the support desk.

⚠️ **READ-ONLY, AND DELIBERATELY SO.** A super admin who needs to change a plan
does it the way the clinic would — through impersonation, which writes an audit
row naming the real administrator and their stated reason. A console endpoint
that mutated billing directly would be the one billing change with no
attributable actor.

⚠️ **It reads another tenant's rows, so it goes through the tenant-scoped
client.** The platform-wide lists use the unsafe client because there is no single
organization to scope them to; this is the opposite case — exactly one
organization, named in the path — so the RLS policies still apply and a typo in
the query cannot return somebody else's invoices.
`.trim(),
    params: { organizationId: `The clinic. ${PLATFORM_404}` },
    responseExamples: [
      {
        summary: 'An active subscription',
        value: {
          success: true,
          message: 'Success',
          data: {
            organizationId: ORG_ID,
            status: 'ACTIVE',
            planCode: 'GROWTH',
            currency: 'INR',
            amountMinor: 499000,
            currentPeriodEnd: '2026-04-01T00:00:00.000Z',
            autoRenew: true,
          },
        },
      },
    ],
  },

  'GET /api/v1/platform/demo-requests': {
    summary: 'List demo requests',
    description:
      'Submissions from the marketing site — the sales inbox. Honeypot and too-fast submissions were dropped before they reached the table, so what is here is what survived the spam checks. Every submitter was answered identically regardless.',
    paginated: true,
    params: {
      search: 'Match on clinic name, contact or email.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
  },

  'GET /api/v1/platform/tax-registrations': {
    summary: 'List platform tax registrations',
    description: `
The registrations **rcln itself** trades under, per jurisdiction.

⚠️ **This is not \`/api/v1/tax/registrations\`, and the two must never learn
about each other.** That one is a clinic's own GSTIN for billing its patients;
this one is ours, for billing subscriptions.
`.trim(),
    params: { countryCode: 'Narrow to one country.' },
  },

  'POST /api/v1/platform/tax-registrations': {
    summary: 'Create a platform tax registration',
    description: `Record a registration rcln trades under.\n\n${NO_PUBLISH_STEP}\n\nA \`POST\` here starts adding tax to the next checkout in that jurisdiction.`,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'An Indian GSTIN',
        value: {
          countryCode: 'IN',
          regionCode: 'KA',
          scheme: 'GST',
          registrationNumber: '29AAACR5678D1ZQ',
          legalName: 'rcln Technologies Pvt Ltd',
          effectiveFrom: '2024-04-01',
        },
      },
    ],
  },

  'PATCH /api/v1/platform/tax-registrations/{id}': {
    summary: 'Update a platform tax registration',
    description: `Correct a registration or close it off with \`effectiveTo\`.\n\n${NO_PUBLISH_STEP}`,
    errors: [409],
    params: { id: 'The registration.' },
    requestExamples: [{ summary: 'Close it off', value: { effectiveTo: '2026-03-31' } }],
  },

  'DELETE /api/v1/platform/tax-registrations/{id}': {
    summary: 'Delete a platform tax registration',
    description: `
Remove a registration entered in error.

⚠️ **A \`DELETE\` exists here and deliberately does NOT exist on tax rule
defaults**, and the asymmetry is the point. A registration entered in error
asserts a legal fact that was **never true**, and leaving it live keeps
collecting tax nobody can remit. A rate that has merely stopped applying is
retired with an end date, because the invoice it priced has to stay explicable.

A \`DELETE\` stops tax being added in that jurisdiction from the next checkout.
`.trim(),
    errors: [409],
    params: { id: 'The registration.' },
  },

  'GET /api/v1/platform/tax-rule-defaults': {
    summary: 'List default tax rules',
    description:
      'The rates every clinic in a jurisdiction gets unless it overrides the category itself. Inheritance is resolved at read time, so these are live rather than copied into each tenant.',
    paginated: true,
    params: {
      countryCode: 'Narrow to one country.',
      regionCode: 'Narrow to one region.',
      activeOn: 'Only rules in force on this date.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
  },

  'POST /api/v1/platform/tax-rule-defaults': {
    summary: 'Create a default tax rule',
    description: `
Set a rate that every clinic in a jurisdiction inherits.

⚠️ **THIS CHANGES WHAT EVERY CLINIC IN A COUNTRY CHARGES, WITH NO PUBLISH STEP.**
Inheritance is resolved at read time, so a \`POST\` here reaches the next invoice
raised anywhere in that jurisdiction by a clinic that has not overridden the
category. That is the point — one row when a rate notification lands, rather than
a migration across every tenant.

**\`sourceNote\` is required rather than optional** for exactly that reason: a
rate that changed what thousands of clinics charge must say where it came from.

\`rateBps\` is basis points — 12% is \`1200\`.
`.trim(),
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: '12% GST on medicines in India',
        value: {
          countryCode: 'IN',
          scheme: 'GST',
          taxCategory: 'GST_12',
          rateBps: 1200,
          lineName: 'IGST',
          regionalLineName: 'CGST/SGST',
          split: 'INTRA_STATE_HALVES',
          effectiveFrom: '2026-01-01',
          sourceNote: 'CBIC notification 03/2026-Central Tax (Rate), 12 January 2026.',
        },
      },
    ],
  },

  'PATCH /api/v1/platform/tax-rule-defaults/{id}': {
    summary: 'Update a default tax rule',
    description:
      "Correct a default rule's descriptive fields. **Not the path for a rate change** — a new rate is a new rule with its own `effectiveFrom`, and the old one retired, so last year's invoice stays explicable.",
    errors: [409],
    params: { id: 'The default rule.' },
    requestExamples: [
      {
        summary: 'Correct the citation',
        value: { sourceNote: 'CBIC notification 03/2026, corrected 14 January 2026.' },
      },
    ],
  },

  'PATCH /api/v1/platform/tax-rule-defaults/{id}/retire': {
    summary: 'Retire a default tax rule',
    description: `
End a default rate at a date.

⚠️ **THERE IS NO DELETE ON THIS RESOURCE, DELIBERATELY.** An invoice issued last
year has to stay explicable, and the row that priced it is the explanation —
removing it does not un-charge the tax, it only makes the charge unaccountable to
whoever asks years later.

Contrast the registrations above, which **do** have a delete: a registration
entered in error asserts a legal fact that was never true.
`.trim(),
    errors: [409],
    params: { id: 'The default rule.' },
    requestExamples: [{ summary: 'End it at the year end', value: { effectiveTo: '2026-03-31' } }],
  },

  ...LAW.reduce<DocRegistry>((all, r) => ({ ...all, ...lawResource(r) }), {}),

  'GET /api/v1/platform/regulatory/rule-packs': {
    summary: 'List rule packs',
    description:
      'The versioned bundles of rules, with their review maturity. Every clinic in the jurisdiction is evaluated against these.',
    paginated: true,
    params: {
      jurisdictionId: 'Narrow to one jurisdiction.',
      maturity: 'Filter by review maturity.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
  },

  'POST /api/v1/platform/regulatory/rule-packs': {
    summary: 'Create a rule pack',
    description: `
Start a bundle of rules for a jurisdiction.

A pack is created at the lowest maturity and **is not evaluated against until it
is approved**. That is the staging step the tax defaults deliberately lack — law
is bulkier and gets imported, so it gets a review gate.
`.trim(),
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'An Indian schedule pack',
        value: {
          code: 'IN-CDSCO-SCHEDULES',
          version: '2026.1',
          jurisdictionId: JURISDICTION_ID,
          authorityId: AUTHORITY_ID,
          sourceId: REGULATORY_SOURCE_ID,
          effectiveFrom: '2026-01-01',
        },
      },
    ],
  },

  'PATCH /api/v1/platform/regulatory/rule-packs/{id}': {
    summary: 'Update a rule pack',
    description:
      "Correct a pack's metadata. **Maturity is not set here** — raising it is `PATCH /{id}/approve`, behind a different code.",
    errors: [409],
    params: { id: 'The pack.' },
    requestExamples: [
      { summary: 'Correct the effective date', value: { effectiveFrom: '2026-02-01' } },
    ],
  },

  'PATCH /api/v1/platform/regulatory/rule-packs/{id}/approve': {
    summary: 'Approve a rule pack',
    description: `
Declare a pack reviewed, and raise its maturity.

⚠️ **\`regulatory.pack.approve\`, NOT \`regulatory.rule.manage\`, and that is the
whole point of this endpoint existing separately.** Whoever maintains the rules is
not thereby whoever may declare them reviewed. The code is held by counsel, a
retained consultant or a registered pharmacist — **and by nobody by default**.

Maturity is reported back to clinics on every evaluation as
\`lowestPackMaturity\`, so a decision resting on an unreviewed pack is
distinguishable from one resting on a production pack.
`.trim(),
    errors: [403, 409],
    params: { id: 'The pack.' },
    requestExamples: [
      {
        summary: 'Enable it in production',
        value: {
          maturity: 'PRODUCTION_ENABLED',
          note: 'Reviewed against the 2026 schedules by retained counsel, 14 January 2026.',
        },
      },
    ],
  },

  'GET /api/v1/platform/regulatory/rules': {
    summary: 'List rules',
    description:
      'The individual rules across packs — what each checks, what it does when it fires, and the sentence it carries to whoever is refused.',
    paginated: true,
    params: {
      packId: 'Narrow to one pack.',
      ruleType: 'Filter by what the rule governs.',
      transaction: 'Filter to one kind of transaction.',
      status: 'Filter by rule status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
  },

  'POST /api/v1/platform/regulatory/rule-packs/{packId}/rules': {
    summary: 'Add a rule to a pack',
    description: `
Write one rule.

⚠️ **\`message\` is read aloud to the person being refused**, so it is written for
them and not for a developer: "A Schedule H medicine requires a valid
prescription", never "SCHEDULE_H_RX_REQUIRED". A refusal arrives at the counter
as a \`422\` carrying this exact text.

The rule takes effect when its pack is approved and its own \`effectiveFrom\`
arrives.
`.trim(),
    status: 201,
    errors: [409],
    params: { packId: 'The pack to add the rule to.' },
    requestExamples: [
      {
        summary: 'Schedule H needs a prescription',
        value: {
          code: 'IN-CDSCO-SCHEDULE-H-RX',
          ruleType: 'PRESCRIPTION_REQUIRED',
          transaction: 'DISPENSE',
          outcome: 'REFUSED',
          message: 'A Schedule H medicine requires a valid prescription.',
          effectiveFrom: '2026-01-01',
        },
      },
    ],
  },

  'PATCH /api/v1/platform/regulatory/rules/{id}': {
    summary: 'Update a rule',
    description:
      'Correct a rule. Changing what it *decides* on a live, production-enabled pack changes outcomes at counters immediately — a genuinely different rule belongs in a new pack version, which goes through approval.',
    errors: [409],
    params: { id: 'The rule.' },
    requestExamples: [
      {
        summary: 'Improve the wording shown to patients',
        value: { message: 'This medicine can only be supplied against a valid prescription.' },
      },
      { summary: 'Withdraw it', value: { status: 'WITHDRAWN', effectiveTo: '2026-03-31' } },
    ],
  },
};
