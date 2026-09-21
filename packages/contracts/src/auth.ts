import { z } from 'zod';
import { email, password, phone, uuid } from './common.js';
import { TIME_FORMATS } from './locale.js';
import { clinicModule, clinicProfileSummary } from './onboarding.js';

/**
 * Login is identifier-based: everyone — super admin, doctor, receptionist,
 * pharmacist, patient — authenticates against the same `users` row. Which
 * tenant they land in comes from the request host, and what they may do comes
 * from membership_roles. Neither is part of this payload.
 */
export const loginRequest = z.object({
  identifier: z.union([email, phone]),
  password: z.string().min(1, 'password is required'),
  totpCode: z.string().length(6).optional(),
});

export const otpRequest = z.object({
  phone,
});

export const otpVerifyRequest = z.object({
  phone,
  code: z.string().regex(/^\d{4,8}$/),
});

export const refreshRequest = z.object({
  refreshToken: z.string().min(32),
});

/**
 * Branch switching. Validated against the caller's own membership_roles — a
 * branch they hold no assignment for is rejected, and the switch is audited.
 */
export const switchBranchRequest = z.object({
  branchId: uuid,
});

export const switchOrganizationRequest = z.object({
  organizationId: uuid,
});

export const forgotPasswordRequest = z.object({
  identifier: z.union([email, phone]),
});

export const resetPasswordRequest = z.object({
  token: z.string().min(32),
  newPassword: password,
});

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

/**
 * Reading an invitation without accepting it.
 *
 * The token goes in the BODY, not the path. It is a credential that mints a
 * membership, and a path is written to every access log and proxy trace between
 * the browser and here.
 */
export const invitationTokenRequest = z.object({
  token: z.string().min(32),
});

/**
 * Accepting an invitation. One endpoint, two paths.
 *
 * A person the platform has never seen sets a name and a password here, and the
 * account is created. Someone who already has an account — a locum working at
 * two clinics, the case that made `users.email` globally unique — sends their
 * EXISTING password and no name, and joins with the account they already have.
 *
 * Which path applies is decided by whether the invited email resolves to a user,
 * never by the caller. Letting the request choose would let a stranger holding a
 * forwarded link overwrite the password of an account that has nothing to do
 * with the clinic doing the inviting.
 *
 * WHY THE SECOND PATH IS A PASSWORD AND NOT "BE SIGNED IN"
 *   Session cookies here are host-only, deliberately — a session at
 *   alpha.rcln.com is not a session at beta.rcln.com (lib/session.ts). So an
 *   existing user opening an invitation to a clinic they do not yet belong to
 *   has, by construction, no session on that host and no way to obtain one:
 *   signing in without a membership is refused. The password is the only
 *   credential they can present, and it is the same one login would ask for.
 */
export const acceptInviteRequest = z.object({
  token: z.string().min(32),
  /** New accounts only. Ignored when the address already has a login. */
  fullName: z.string().min(2).max(255).optional(),
  /**
   * Not the `password` schema from common.ts, because this field means two
   * different things. On the existing-account path it is a credential being
   * CHECKED, and rejecting a password set years ago for failing today's
   * complexity rules would lock someone out of an invitation over a field they
   * cannot change from here. On the new-account path the strength rules do
   * apply, and the service re-parses this against `password` once it knows which
   * path it is on — the decision that is the server's to make.
   */
  password: z.string().min(1).max(128),
});

/**
 * Confirming an email address or a phone number.
 *
 * There is no field naming whose account this is. The user id comes off the
 * access token, so verification is self-service by construction rather than by a
 * permission check — which is also why no permission code exists for it.
 *
 * The channel is in the path (`/auth/verify/email/confirm`) rather than the
 * body: it selects the route, not the data, and putting it in the payload would
 * make one handler that has to branch on validated input.
 *
 * Same 4–8 digit shape as `otpVerifyRequest` — one generator, one length
 * setting, one `auth_tokens` table behind all of them.
 */
export const verificationConfirmRequest = z.object({
  code: z.string().regex(/^\d{4,8}$/),
});

/**
 * Entering a clinic as rcln staff.
 *
 * A REASON IS PART OF THE CREDENTIAL, NOT PART OF THE UI
 *   Impersonation is full access — read, write and delete, no elevation step
 *   (ADR-0012). The audit trail is the only control on it, and an audit row that
 *   says "a super admin was in your clinic on Tuesday" without saying why is not
 *   a control. Ten characters is the floor because "test" is not a reason.
 */
export const impersonateRequest = z.object({
  reason: z.string().trim().min(10, 'Say why you are entering this clinic').max(500),
});

/**
 * The answer to `POST /platform/organizations/:id/impersonate`.
 *
 * NOT A SESSION — A ONE-TIME TICKET FOR ONE HOST
 *   Session cookies are host-only by design (apps/web/src/lib/session.ts), so
 *   admin.<root> cannot write a cookie for alpha.<root>. Something has to cross
 *   the host boundary, and it is this: 256 random bits, held in Redis for two
 *   minutes, spent exactly once, and only redeemable at the clinic it names.
 *
 *   `handoffToken` therefore travels in a POST BODY, never in a URL — the same
 *   rule invitation tokens follow, for the same reason.
 */
export const impersonationGrant = z.object({
  organizationSlug: z.string(),
  organizationName: z.string(),
  handoffToken: z.string(),
  /** Seconds the ticket stays redeemable. The session it buys lives longer. */
  expiresInSeconds: z.number().int(),
});

/** Redeeming the ticket, at the clinic's own host. */
export const impersonationClaimRequest = z.object({
  handoffToken: z.string().min(32),
});

export const impersonationStopResult = z.object({
  stopped: z.literal(true),
});

// -- responses ---------------------------------------------------------------

export const verificationRequestResult = z.object({
  sent: z.boolean(),
  /**
   * The channel was already verified, so nothing was sent. Not an error: the
   * caller asked for a state that already holds. OTP login sets
   * `phoneVerifiedAt` as a side effect, so this is reachable without anyone ever
   * having used this flow.
   */
  alreadyVerified: z.boolean(),
  /** How long the code just sent stays usable, so the screen can say so. */
  expiresInSeconds: z.number().int(),
});

export const verificationResult = z.object({
  verified: z.literal(true),
  alreadyVerified: z.boolean(),
});

export const branchSummary = z.object({
  id: uuid,
  name: z.string(),
  code: z.string(),
  city: z.string().nullable(),
  isPrimary: z.boolean(),
  /**
   * The branch's IANA zone.
   *
   * ⚠️ NOT FOR THE BRANCH SWITCHER, WHICH NEVER RENDERS IT. It is here because
   *   this list is the ONLY un-gated statement of which branches a caller may
   *   work in, and the day board needs a zone to render a time in. `GET
   *   /branches` is behind `branch.read`, which the front desk and the doctors
   *   deliberately do not hold — that permission opens the branch MANAGEMENT
   *   screen. Without the zone here, every screen that shows a clock would have
   *   to choose between a permission it should not need and the browser's
   *   timezone, and the browser's is wrong for a receptionist working remotely
   *   in a way that looks entirely plausible.
   */
  timezone: z.string(),
  /**
   * The clock face this branch reads — `12H` or `24H`, resolved from
   * `locale.time_format`.
   *
   * ⚠️ IT RIDES ALONGSIDE `timezone` BECAUSE IT ANSWERS THE OTHER HALF OF THE
   *   SAME QUESTION, and it is needed by exactly the same screens for exactly
   *   the same reason: the zone decides WHICH instant to draw, this decides what
   *   the drawing looks like, and neither is a permission a receptionist holds.
   *   Fetching it from `GET /settings` would put the day board behind
   *   `settings.branch.read`.
   *
   * ⚠️ DISPLAY ONLY. Storage is UTC everywhere in rcln — see `TIME_FORMATS` in
   *   `locale.ts`. Nothing parses against this and no arithmetic reads it.
   *
   * Per branch, not per organization, because a group can run a hospital wing on
   * a 24-hour clock and its walk-in clinic on a 12-hour one.
   */
  timeFormat: z.enum(TIME_FORMATS),
  /**
   * What this branch said it is — care contexts and modules, RESOLVED, with the
   * branch's own answer taking precedence over the organization's (CO-1).
   *
   * ⚠️ IT RIDES HERE FOR THE THIRD TIME FOR THE REASON `timezone` AND
   *   `timeFormat` DO, AND THE ARGUMENT IS NOW LOAD-BEARING FOR THE TWO SCREENS
   *   THAT MATTER MOST. The patient registration form needs to know whether to
   *   ask "person or animal?", and the shell needs to know which tabs to draw.
   *   Both are opened by the front desk, who hold neither `settings.branch.read`
   *   nor `organization.read` — fetching this from `GET /settings` would put the
   *   registration form behind a permission a receptionist must not need.
   *
   * ⚠️ AND IT IS NOT AN AUTHORIZATION INPUT. A module absent from this list must
   *   never be why a request is refused; `authorize()` is. This decides what is
   *   DRAWN, and a caller who reaches a hidden route by typing its URL is
   *   stopped by the permission gate exactly as before.
   *
   * ⚠️ NOT CACHED, DELIBERATELY. `loadUserAccess` holds a 60-second Redis cache;
   *   this is resolved beside the branch list instead, in the same uncached
   *   transaction. Folding it into that cache would mean every onboarding write
   *   had to invalidate it, and a clinic that finished setup would watch the old
   *   nav for a minute wondering whether it saved.
   */
  profile: clinicProfileSummary,
});

export const membershipSummary = z.object({
  organizationId: uuid,
  organizationName: z.string(),
  organizationSlug: z.string(),
  /**
   * ISO 3166-1 alpha-2, the clinic's own country.
   *
   * ⚠️ LOAD-BEARING FOR FORMS, NOT DECORATION — and here for the same reason
   *   `timezone` is on `branchSummary`. It decides the postcode format and its
   *   lookup, which identity documents the front desk is offered, the address
   *   labels ("PIN code" vs "ZIP code"), and the dialling code a phone field
   *   starts on. Every one of those is on the patient registration form, which
   *   the front desk opens and which cannot call `GET /organization` — that is
   *   behind `organization.read`, which they do not hold.
   */
  countryCode: z.string().length(2),
  roles: z.array(z.string()),
  /** Exactly what the UI branch switcher renders. */
  branches: z.array(branchSummary),
  /**
   * Whether this clinic has finished the onboarding wizard (CO-1).
   *
   * ⚠️ NOT `registeredAt`, WHICH IS A DIFFERENT FACT AND USED TO BE CALLED
   *   `onboardedAt`. Registration stamps that one; this is
   *   `clinic_profiles.completed_at`, set by the review step.
   *
   * The shell reads it twice: it redirects a caller who holds
   * `organization.onboarding.write` to the wizard, and it renders a banner for
   * everyone else. It is on the session rather than fetched because a banner
   * that can be missing from one screen is a banner nobody trusts — the same
   * argument `VerifyPrompt` makes by living in the layout.
   */
  setupComplete: z.boolean(),
  /**
   * The ORGANIZATION-level module answer, for the branch-less screens.
   *
   * Every branch carries its own resolved copy on `branchSummary.profile`; this
   * is what the shell falls back to before a branch is chosen.
   */
  modules: z.array(clinicModule),
});

export const authSession = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  user: z.object({
    id: uuid,
    fullName: z.string(),
    email: z.email().nullable(),
    phone: z.string().nullable(),
    isPlatformAdmin: z.boolean(),
    mfaEnabled: z.boolean(),
    /**
     * Booleans, not the timestamps behind them. When someone proved they own
     * their address is an audit question; the shell only needs to know whether
     * to prompt, and a date shipped to the browser is a date somebody renders.
     */
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    /**
     * The clinic this platform admin last asked to enter, so the console can
     * offer it again instead of making them find it.
     *
     * Null for everyone who is not a platform admin, which is almost everyone —
     * and null for an admin who has never entered one. A PREFERENCE, NOT A GRANT:
     * entering still goes through the handoff, which re-checks the flag and wants
     * a reason (ADR-0012). An id only, so it is useless to anyone who cannot
     * already list clinics.
     */
    lastPlatformOrganizationId: uuid.nullable(),
  }),
  activeOrganizationId: uuid.nullable(),
  activeBranchId: uuid.nullable(),
  memberships: z.array(membershipSummary),
  /**
   * Resolved for the active branch. Deliberately NOT in the JWT — it goes stale
   * the instant a role changes, and it is far too large for a header.
   */
  permissions: z.array(z.string()),
  /**
   * Non-null only while a platform admin is inside a clinic.
   *
   * The shell renders a banner from this and cannot be allowed to miss it, so it
   * rides on the session rather than being fetched separately. The organization
   * NAME is here because `memberships` cannot supply it: an impersonating admin
   * holds no membership in the clinic they are standing in — that is what makes
   * it impersonation.
   */
  impersonation: z
    .object({
      organizationName: z.string(),
      /** The real person behind the session. Also its `user`, see ADR-0012. */
      adminName: z.string(),
      /** When the session hard-expires. There is no refresh token to extend it. */
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
});

/**
 * What the accept page renders before anyone types anything.
 *
 * Everything here is already known to whoever holds the token — it was sent to
 * them by email. `needsAccount` is the one derived field: it decides whether the
 * page asks for a password or asks them to sign in, and it is the server's
 * answer rather than the page's guess.
 */
export const invitationPreview = z.object({
  organizationName: z.string(),
  email: z.string(),
  roleName: z.string(),
  branchNames: z.array(z.string()),
  needsAccount: z.boolean(),
  expiresAt: z.iso.datetime(),
});

export type LoginRequest = z.infer<typeof loginRequest>;
export type InvitationTokenRequest = z.infer<typeof invitationTokenRequest>;
export type InvitationPreview = z.infer<typeof invitationPreview>;
export type OtpRequest = z.infer<typeof otpRequest>;
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequest>;
export type RefreshRequest = z.infer<typeof refreshRequest>;
export type SwitchBranchRequest = z.infer<typeof switchBranchRequest>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequest>;
export type VerificationConfirmRequest = z.infer<typeof verificationConfirmRequest>;
export type VerificationRequestResult = z.infer<typeof verificationRequestResult>;
export type VerificationResult = z.infer<typeof verificationResult>;
export type ImpersonateRequest = z.infer<typeof impersonateRequest>;
export type ImpersonationGrant = z.infer<typeof impersonationGrant>;
export type ImpersonationClaimRequest = z.infer<typeof impersonationClaimRequest>;
export type ImpersonationStopResult = z.infer<typeof impersonationStopResult>;
export type AuthSession = z.infer<typeof authSession>;
export type MembershipSummary = z.infer<typeof membershipSummary>;
export type BranchSummary = z.infer<typeof branchSummary>;
