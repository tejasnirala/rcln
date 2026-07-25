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

export const acceptInviteRequest = z.object({
  token: z.string().min(32),
  fullName: z.string().min(2).max(255),
  password,
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

export type LoginRequest = z.infer<typeof loginRequest>;
export type OtpRequest = z.infer<typeof otpRequest>;
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequest>;
export type RefreshRequest = z.infer<typeof refreshRequest>;
export type SwitchBranchRequest = z.infer<typeof switchBranchRequest>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequest>;
export type AuthSession = z.infer<typeof authSession>;
export type MembershipSummary = z.infer<typeof membershipSummary>;
export type BranchSummary = z.infer<typeof branchSummary>;
