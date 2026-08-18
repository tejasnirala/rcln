/**
 * Public — the apex marketing site, and the only place a clinic that does not
 * exist yet can talk to us.
 *
 * ⚠️ EVERYTHING HERE IS PRE-TENANT AND UNAUTHENTICATED. `resolveTenant` skips
 *   the lookup on the root domain, so `req.tenant` is absent by design and
 *   `withTenant` has nothing to scope to. That is what makes `@rcln/db/unsafe`
 *   correct in these three handlers rather than a shortcut.
 *
 * ⚠️ AND EVERYTHING HERE IS RATE LIMITED, harder than the rest of the API.
 *   These are the only endpoints reachable without a token, so they are the only
 *   ones a stranger can grind: `check-slug` is an enumeration oracle over every
 *   clinic that has ever signed up, and `register` writes rows.
 */
import { registerOrganizationResponse, slugAvailabilityResponse } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import { ORG_ID, ORGANIZATION } from './fixtures.js';

const DEMO_RECEIPT = {
  type: 'object',
  required: ['received'],
  properties: { received: { type: 'boolean', const: true } },
} as const;

export const publicDocs: DocRegistry = {
  'POST /api/v1/public/demo-requests': {
    summary: 'Request a demo',
    description: `
The "talk to us" form on the marketing site.

⚠️ **It answers \`201\` to everything well-formed, and that is deliberate.**
A submission may be stored, silently discarded as spam, or recognised as a
duplicate of one from the last 24 hours — and the caller cannot tell which.
Reporting "we already have you" would turn this endpoint into a way to ask
whether a named clinic is in conversation with rcln, which is not a question a
stranger gets to ask.

Two spam checks run before anything is written, and neither reports itself:

- \`website\` is a **honeypot**. It is hidden from people, so anything in it is
  a script that filled every field on the page. It is deliberately *not*
  rejected in validation — an error naming the field teaches the next bot to
  skip it.
- \`elapsedMs\` is how long the form was on screen. Under 2.5 seconds is a
  script, not a person.

Nothing identifying is logged. The id goes to the log; the name, email and phone
that just arrived do not.
`.trim(),
    response: DEMO_RECEIPT,
    status: 201,
    message: 'Demo booked',
    errors: [429],
    requestExamples: [
      {
        summary: 'A single-branch clinic',
        value: {
          clinicName: 'Sunrise Dental',
          contactName: 'Dr Anita Desai',
          email: 'anita@sunrisedental.in',
          phone: '+919845099887',
          city: 'Pune',
          branchCount: 1,
          specialty: 'Dentistry',
          message: 'Looking to move off paper records before the new financial year.',
          elapsedMs: 42000,
        },
      },
      {
        summary: 'The minimum',
        description: 'Only the four required fields. Everything else is optional.',
        value: {
          clinicName: 'Sunrise Dental',
          contactName: 'Dr Anita Desai',
          email: 'anita@sunrisedental.in',
          phone: '+919845099887',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Accepted',
        description: 'Identical whether the row was written, deduplicated or dropped.',
        value: { success: true, message: 'Demo booked', data: { received: true } },
      },
    ],
  },

  'GET /api/v1/public/organizations/check-slug': {
    summary: 'Check whether a subdomain is free',
    description: `
Is \`<slug>.rcln.com\` available. Called while the clinic is still typing its
name into the sign-up form.

Returns a bare boolean and nothing else — never the name of whoever holds a
taken slug, and never a suggestion derived from it.

⚠️ **This is an enumeration oracle and is budgeted like one.** Anyone may ask
whether \`apollo\` is taken, and a taken slug means a clinic by roughly that name
banks with us. The rate limit is tighter here than anywhere else in the API for
that reason; it is not protecting the database, which barely notices, it is
protecting the customer list.

\`available: false\` is not a promise the name is claimable later, and
\`available: true\` is not a reservation — the slug is only yours once
\`POST /organizations/register\` commits. A slug taken in between comes back as
\`409\` from that call.
`.trim(),
    response: slugAvailabilityResponse,
    errors: [429],
    params: {
      slug: 'The subdomain the clinic wants. Lowercase letters, digits and hyphens; a reserved word such as `www`, `api` or `admin` is always reported as taken.',
    },
    responseExamples: [
      {
        summary: 'Free',
        value: { success: true, message: 'Available', data: { slug: 'sunrise', available: true } },
      },
      {
        summary: 'Taken',
        description: 'Note the message changes but the shape does not, and no owner is named.',
        value: {
          success: true,
          message: 'Taken',
          data: { slug: ORGANIZATION.slug, available: false },
        },
      },
    ],
  },

  'POST /api/v1/public/organizations/register': {
    summary: 'Register a clinic',
    description: `
Clinic self-registration — the call that creates a tenant. One transaction
produces the organization, its first branch, the owner's user and membership,
the ORG_OWNER role assignment, and a trial subscription on \`planCode\`.

⚠️ **No tokens come back, and that is a security decision rather than an
oversight.** The new session belongs to \`<slug>.rcln.com\`, and a cookie must be
scoped to the exact host that owns it — one set on the apex would be readable by
every other tenant's subdomain. So you get a \`loginUrl\` and the browser
authenticates there, on the host the session will actually live on.

**\`organization.taxId\` creates the clinic's first tax registration**, not just
a column value. Registration is the one moment the number, the country and the
region arrive together, which is exactly what a registration record needs.
Omitting it is the clinic that is not registered for tax — a legitimate answer
that stays legitimate.

Despite the name, \`taxId\` is not necessarily a GSTIN: it holds an Irish VAT
number or a UAE TRN just as readily, and its format is checked against
\`countryCode\`. \`branch.pincode\` is checked the same way — against that
country's postcode format, not India's.

\`acceptedTerms\` must be literally \`true\`. A slug or email claimed between the
pre-flight check and the commit is answered \`409\`.
`.trim(),
    response: registerOrganizationResponse,
    status: 201,
    message: 'Clinic registered',
    errors: [409, 429],
    requestExamples: [
      {
        summary: 'A single-branch clinic in Karnataka',
        description: 'The registration that produced the clinic every other example uses.',
        value: {
          organization: {
            legalName: ORGANIZATION.legalName,
            displayName: ORGANIZATION.name,
            slug: ORGANIZATION.slug,
            orgType: 'CLINIC',
            taxId: '29AAACA1234C1ZP',
            countryCode: 'IN',
            regionCode: 'KA',
            timezone: 'Asia/Kolkata',
            currency: 'INR',
          },
          branch: {
            name: 'Alpha Clinic — Indiranagar',
            code: 'BLR-IND',
            phone: '+919845012345',
            addressLine1: '221, 100 Feet Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560038',
          },
          owner: {
            fullName: 'Dr Meera Krishnan',
            email: 'meera@alphaclinic.in',
            phone: '+919845012345',
            password: 'correct-horse-battery-staple',
          },
          planCode: 'STARTER',
          acceptedTerms: true,
        },
      },
      {
        summary: 'Not registered for tax',
        description:
          '`taxId` omitted, so no `issuer_tax_registrations` row is written. `code`, `orgType`, `timezone` and `planCode` all fall back to their defaults.',
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
    responseExamples: [
      {
        summary: 'Registered',
        description: 'Send the browser to `loginUrl`; there are deliberately no tokens here.',
        value: {
          success: true,
          message: 'Clinic registered',
          data: {
            organizationId: ORG_ID,
            slug: ORGANIZATION.slug,
            loginUrl: `https://${ORGANIZATION.slug}.rcln.com/login`,
          },
        },
      },
    ],
  },
};
