import { z } from 'zod';
import { email, password, phone, uuid } from './common.js';

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

// -- responses ---------------------------------------------------------------

export const branchSummary = z.object({
  id: uuid,
  name: z.string(),
  code: z.string(),
  city: z.string().nullable(),
  isPrimary: z.boolean(),
});

export const membershipSummary = z.object({
  organizationId: uuid,
  organizationName: z.string(),
  organizationSlug: z.string(),
  roles: z.array(z.string()),
  /** Exactly what the UI branch switcher renders. */
  branches: z.array(branchSummary),
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
  }),
  activeOrganizationId: uuid.nullable(),
  activeBranchId: uuid.nullable(),
  memberships: z.array(membershipSummary),
  /**
   * Resolved for the active branch. Deliberately NOT in the JWT — it goes stale
   * the instant a role changes, and it is far too large for a header.
   */
  permissions: z.array(z.string()),
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
export type AuthSession = z.infer<typeof authSession>;
export type MembershipSummary = z.infer<typeof membershipSummary>;
export type BranchSummary = z.infer<typeof branchSummary>;
