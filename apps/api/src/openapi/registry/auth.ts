/**
 * Authentication — the first surface anybody integrating against rcln meets.
 *
 * ⚠️ NOT BEHIND THE TENANT GUARD, UNLIKE ALMOST EVERYTHING ELSE. These routes
 *   also serve the apex and admin hosts, where a platform administrator has no
 *   clinic at all. The `Host` still decides which clinic a session is issued
 *   FOR — it is simply not required to resolve to one.
 */
import { authSession, invitationPreview } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import { BRANCH_ID, BRANCH_KOCHI_ID, ORG_ID, OTHER_ORG_ID, USER_ID } from './fixtures.js';

const SESSION_EXAMPLE = {
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI3ZjNh…',
  refreshToken: 'v2.local.8Jd1kQ0mV3xY7pR2wL9nT4bC6sA5fH…',
  expiresIn: 900,
  user: {
    id: USER_ID,
    fullName: 'Dr Meera Krishnan',
    email: 'meera@alphaclinic.in',
    phone: '+919845012345',
    isPlatformAdmin: false,
    mfaEnabled: false,
    emailVerified: true,
    phoneVerified: true,
    lastPlatformOrganizationId: null,
  },
  activeOrganizationId: ORG_ID,
  activeBranchId: BRANCH_ID,
  memberships: [
    {
      organizationId: ORG_ID,
      organizationName: 'Alpha Clinic',
      slug: 'alpha',
      branches: [
        {
          id: BRANCH_ID,
          name: 'Alpha Clinic — Indiranagar',
          code: 'BLR-IND',
        },
      ],
    },
  ],
  permissions: [
    'patient.read',
    'patient.create',
    'appointment.read',
    'clinical.encounter.create',
    'clinical.prescription.sign',
  ],
  impersonation: null,
};

/** Every endpoint that mints a session answers with the same object. */
const signedIn = (summary: string, message: string) =>
  ({
    response: authSession,
    message,
    responseExamples: [{ summary, value: { success: true, message, data: SESSION_EXAMPLE } }],
  }) as const;

const TOKEN_LIFECYCLE = `
### What you get back

\`accessToken\` is a short-lived JWT — send it as \`Authorization: Bearer <token>\`.
\`expiresIn\` is its lifetime in **seconds**.

\`refreshToken\` is long-lived and is the credential for
\`POST /api/v1/auth/refresh\`. Store it where an access token would not be safe.

\`permissions\` is resolved **for the active branch** and is deliberately not
inside the JWT: it goes stale the moment a role changes, and it is far too large
for a header. Re-read it after switching branch.
`.trim();

export const authDocs: DocRegistry = {
  'POST /api/v1/auth/login': {
    summary: 'Sign in with a password',
    description: `
Exchanges an identifier and password for a session.

\`identifier\` is an **email address or a phone number** — the same field takes
either, and which one it is decided by its shape rather than by a flag.

**The \`Host\` decides which clinic the session belongs to.** Signing in on
\`alpha.example.com\` yields a session scoped to Alpha; the same credentials on
\`beta.example.com\` yield a session scoped to Beta, with different permissions.
On the apex host a platform administrator gets a session scoped to no clinic.

${TOKEN_LIFECYCLE}

### Rate limiting

Much tighter than the rest of the API, keyed on the caller's address. Expect
\`429\` well before anything resembling a password-guessing rate.

### What it does not tell you

A wrong password and an unknown account produce the **same** message, on purpose:
distinguishing them turns this endpoint into an account-enumeration oracle.
`.trim(),
    ...signedIn('A doctor signing in at their clinic', 'Signed in'),
    requestExamples: [
      {
        summary: 'By email',
        value: { identifier: 'meera@alphaclinic.in', password: 'correct-horse-battery-staple' },
      },
      {
        summary: 'By phone',
        value: { identifier: '+919845012345', password: 'correct-horse-battery-staple' },
      },
    ],
    errors: [401, 429],
  },

  'POST /api/v1/auth/otp/request': {
    summary: 'Request a one-time code by SMS',
    description: `
Sends a numeric code to the handset if — and only if — that number has an
account.

⚠️ **The response is identical either way.** It always reports success, because
an endpoint that says "no such number" is an endpoint that confirms which phone
numbers belong to patients and staff of a named clinic.
`.trim(),
    message: 'If that number has an account, a code is on its way.',
    response: {
      type: 'object',
      required: ['sent'],
      additionalProperties: false,
      properties: {
        sent: {
          type: 'boolean',
          const: true,
          description: 'Always `true`. Says nothing about whether the number exists.',
        },
      },
    },
    requestExamples: [{ summary: 'An Indian mobile', value: { phone: '+919845012345' } }],
    responseExamples: [
      {
        summary: 'The only response there is',
        value: {
          success: true,
          message: 'If that number has an account, a code is on its way.',
          data: { sent: true },
        },
      },
    ],
    errors: [429],
  },

  'POST /api/v1/auth/otp/verify': {
    summary: 'Sign in with a one-time code',
    description: `
Exchanges the code from \`/otp/request\` for a session. Same session object as
\`/login\`.

Verifying a code proves control of the handset, so this **also marks the phone
number verified** if it was not already — that is what phone verification means,
and asking the user to do it twice would be theatre.

${TOKEN_LIFECYCLE}
`.trim(),
    ...signedIn('Signed in by OTP', 'Signed in'),
    requestExamples: [
      { summary: 'Code from the SMS', value: { phone: '+919845012345', code: '482913' } },
    ],
    errors: [401, 429],
  },

  'POST /api/v1/auth/refresh': {
    summary: 'Exchange a refresh token for a new session',
    description: `
**Unauthenticated by design** — the access token is expected to be expired,
which is the whole reason a client is here. The refresh token is the credential.

The pair is **rotated**: the refresh token you send is consumed and a new one
comes back. Reusing a consumed token fails, which is what makes a stolen refresh
token detectable rather than silently useful forever.

${TOKEN_LIFECYCLE}
`.trim(),
    ...signedIn('A rotated pair', 'Session refreshed'),
    requestExamples: [
      {
        summary: 'The stored refresh token',
        value: { refreshToken: 'v2.local.8Jd1kQ0mV3xY7pR2wL9nT4bC6sA5fH…' },
      },
    ],
    errors: [401, 429],
  },

  'POST /api/v1/auth/invitations/preview': {
    summary: 'Read an invitation before accepting it',
    description: `
What the accept page renders before anybody types anything: which clinic, which
role, which branches, and whether the invitee needs to create an account.

Everything returned is already known to whoever holds the token — it was emailed
to them. \`needsAccount\` is the one derived field, and it decides whether the
page asks for a password or asks them to sign in.

**The token is single-use in effect and time-limited.** The stored value is a
SHA-256 digest, so an administrator listing invitations cannot read a token back
out and sign in as the invitee.
`.trim(),
    message: 'Invitation',
    response: invitationPreview,
    requestExamples: [
      {
        summary: 'The token from the invitation link',
        value: { token: 'inv_9f4c2a7e51b3486d90fa2e7c1d8b5043' },
      },
    ],
    responseExamples: [
      {
        summary: 'A new colleague who has no account yet',
        value: {
          success: true,
          message: 'Invitation',
          data: {
            organizationName: 'Alpha Clinic',
            email: 'arjun@alphaclinic.in',
            roleName: 'Front Desk',
            branchNames: ['Alpha Clinic — Indiranagar'],
            needsAccount: true,
            expiresAt: '2026-08-25T09:00:00.000Z',
          },
        },
      },
    ],
    errors: [404, 429],
  },

  'POST /api/v1/auth/invitations/accept': {
    summary: 'Accept an invitation and sign in',
    description: `
Turns an invitation into a membership and hands back a session, so the invitee
lands signed in rather than at a login form.

Send \`password\` when the preview said \`needsAccount: true\`; omit it when the
person already has an account and is simply joining another clinic.

Answers \`201\`: a membership is created.
`.trim(),
    status: 201,
    ...signedIn('Joined and signed in', 'Welcome aboard'),
    requestExamples: [
      {
        summary: 'A brand-new colleague',
        value: {
          token: 'inv_9f4c2a7e51b3486d90fa2e7c1d8b5043',
          fullName: 'Arjun Rao',
          password: 'correct-horse-battery-staple',
        },
      },
      {
        summary: 'Someone who already has an account',
        value: { token: 'inv_9f4c2a7e51b3486d90fa2e7c1d8b5043' },
      },
    ],
    errors: [404, 409, 429],
  },

  'POST /api/v1/auth/verify/email/request': {
    summary: 'Send an email verification code',
    description:
      "Emails a code to the signed-in user's own address. If it is already verified the call succeeds and reports `alreadyVerified: true` rather than sending a second code.",
    message: 'Code sent.',
    response: {
      type: 'object',
      required: ['alreadyVerified'],
      properties: {
        alreadyVerified: {
          type: 'boolean',
          description: 'True when nothing was sent because the address was already verified.',
        },
      },
    },
    errors: [429],
  },
  'POST /api/v1/auth/verify/email/confirm': {
    summary: 'Confirm an email verification code',
    description:
      "Marks the signed-in user's email address verified. Inside a clinic the change is audited; on the apex host, where there is no clinic to audit against, the audit row is skipped rather than the request refused.",
    message: 'Your email address is verified.',
    response: {
      type: 'object',
      required: ['alreadyVerified'],
      properties: { alreadyVerified: { type: 'boolean' } },
    },
    requestExamples: [{ summary: 'Code from the email', value: { code: '731905' } }],
    errors: [429],
  },
  'POST /api/v1/auth/verify/phone/request': {
    summary: 'Send a phone verification code',
    description:
      'The SMS counterpart of `/verify/email/request`, with the same shape and the same `alreadyVerified` behaviour.',
    message: 'Code sent.',
    response: {
      type: 'object',
      required: ['alreadyVerified'],
      properties: { alreadyVerified: { type: 'boolean' } },
    },
    errors: [429],
  },
  'POST /api/v1/auth/verify/phone/confirm': {
    summary: 'Confirm a phone verification code',
    description: 'The SMS counterpart of `/verify/email/confirm`.',
    message: 'Your phone number is verified.',
    response: {
      type: 'object',
      required: ['alreadyVerified'],
      properties: { alreadyVerified: { type: 'boolean' } },
    },
    requestExamples: [{ summary: 'Code from the SMS', value: { code: '482913' } }],
    errors: [429],
  },

  'POST /api/v1/auth/impersonation/claim': {
    summary: 'Redeem an impersonation grant',
    description: `
Turns a grant issued on the admin console into a session **on the clinic's own
host**. Platform administrators only.

⚠️ **It is redeemed here rather than issued here, and that is the point.** A
session may only be handed to the host that owns it, so the grant is minted on
the admin console and spent on \`<clinic>.<root-domain>\`. The redeemed session
carries no refresh token and hard-expires; \`impersonation\` on the session
object is non-null for its whole life so the interface can say, permanently and
unmissably, whose records are on screen.

Every claim is audited with the reason given when the grant was created.
`.trim(),
    status: 201,
    ...signedIn('An administrator inside a clinic', 'Signed in'),
    responseExamples: [
      {
        summary: 'An administrator inside a clinic',
        value: {
          success: true,
          message: 'Signed in',
          data: {
            ...SESSION_EXAMPLE,
            refreshToken: '',
            user: {
              ...SESSION_EXAMPLE.user,
              fullName: 'Platform Support',
              isPlatformAdmin: true,
              lastPlatformOrganizationId: ORG_ID,
            },
            impersonation: {
              organizationName: 'Alpha Clinic',
              adminName: 'Platform Support',
              expiresAt: '2026-08-18T11:30:00.000Z',
            },
          },
        },
      },
    ],
    errors: [404, 429],
  },
  'POST /api/v1/auth/impersonation/stop': {
    summary: 'Leave an impersonated clinic',
    description:
      'Ends an impersonation session immediately. Idempotent — calling it on an ordinary session succeeds and does nothing.',
    message: 'Left the clinic',
    response: {
      type: 'object',
      required: ['stopped'],
      additionalProperties: false,
      properties: { stopped: { type: 'boolean', const: true } },
    },
  },

  'POST /api/v1/auth/logout': {
    summary: 'Sign out',
    description: `
Revokes the current session row.

That is what makes signing out mean something: the JWT is stateless and stays
syntactically valid until it expires, but every request re-checks the session,
so the token is dead from here on.
`.trim(),
    message: 'Signed out',
    response: {
      type: 'object',
      required: ['signedOut'],
      additionalProperties: false,
      properties: { signedOut: { type: 'boolean', const: true } },
    },
  },

  'GET /api/v1/auth/session': {
    summary: 'Describe the current session',
    description: `
Who is signed in, which clinic and branch is active, which clinics they belong
to, and the permissions resolved **for the active branch**.

Call it on load rather than trusting a cached copy: permissions are resolved per
request, so a role granted or revoked while the tab was open shows up here.

The \`accessToken\` echoed back is the one you sent; \`refreshToken\` is empty,
because a describe call does not mint credentials.
`.trim(),
    ...signedIn('An ordinary session', 'Session'),
  },

  'POST /api/v1/auth/switch-branch': {
    summary: 'Switch the active branch',
    description: `
Moves the session to another branch of the **same** clinic and returns a session
with \`permissions\` re-resolved for it.

This matters more than it looks: permissions are held per branch, so the same
person can be an administrator at one location and a receptionist at another.
Re-read \`permissions\` after every switch rather than carrying the old set over.

Refused for a branch the caller holds no assignment for.
`.trim(),
    ...signedIn('Now at the second branch', 'Branch switched'),
    requestExamples: [{ summary: 'Move to Kochi', value: { branchId: BRANCH_KOCHI_ID } }],
    errors: [404],
  },

  'POST /api/v1/auth/switch-organization': {
    summary: 'Switch the active clinic',
    description: `
For somebody who belongs to more than one clinic — a visiting consultant, a
group's finance lead.

⚠️ **The token that comes back is for a different clinic, so subsequent calls
must go to that clinic's host.** Continuing to call the old subdomain with the
new token is answered \`404\`: a token whose organization does not match the
resolved tenant is rejected, and it answers 404 rather than 403 so that a valid
token cannot be used to probe which subdomains exist.
`.trim(),
    ...signedIn('Now inside the second clinic', 'Organization switched'),
    requestExamples: [
      {
        summary: 'Move to the other clinic',
        value: { organizationId: OTHER_ORG_ID },
      },
    ],
    errors: [404],
  },
};
