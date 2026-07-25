import { z } from 'zod';
import { availableSlug, email, password, phone, uuid } from './common.js';

/**
 * Clinic self-registration. Creates, in one transaction:
 *   organization + organization_domain + first branch + owner user +
 *   membership + membership_role(ORG_OWNER, branchId: null) + trial subscription
 *
 * The branch is created here because an organization with no location cannot
 * take a booking — there is no meaningful "org exists but has no branch" state.
 */
export const registerOrganizationRequest = z.object({
  organization: z.object({
    legalName: z.string().min(2).max(255),
    displayName: z.string().min(2).max(255),
    slug: availableSlug,
    orgType: z.enum(['CLINIC', 'HOSPITAL', 'CHAIN', 'LAB']).default('CLINIC'),
    gstNumber: z
      .string()
      .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, 'invalid GSTIN')
      .optional(),
    timezone: z.string().default('Asia/Kolkata'),
    currency: z.string().length(3).default('INR'),
  }),
  branch: z.object({
    name: z.string().min(2).max(255),
    code: z.string().min(1).max(32).default('MAIN'),
    phone: phone.optional(),
    addressLine1: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    pincode: z
      .string()
      .regex(/^\d{6}$/, 'must be 6 digits')
      .optional(),
  }),
  owner: z.object({
    fullName: z.string().min(2).max(255),
    email,
    phone,
    password,
  }),
  planCode: z.string().default('STARTER'),
  acceptedTerms: z.literal(true, { message: 'terms must be accepted' }),
});

export const createBranchRequest = z.object({
  name: z.string().min(2).max(255),
  code: z.string().min(1).max(32),
  branchType: z.enum(['CLINIC', 'HOSPITAL', 'LAB', 'PHARMACY']).default('CLINIC'),
  phone: phone.optional(),
  email: email.optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  gstNumber: z.string().max(20).optional(),
  timezone: z.string().default('Asia/Kolkata'),
});

export const updateBranchRequest = createBranchRequest.partial().extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'CLOSED']).optional(),
});

export const branchOperatingHoursRequest = z.object({
  hours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        opensAt: z.string().regex(/^\d{2}:\d{2}$/),
        closesAt: z.string().regex(/^\d{2}:\d{2}$/),
        isClosed: z.boolean().default(false),
        slotMinutes: z.number().int().min(5).max(240).default(15),
      })
    )
    .max(7),
});

/**
 * Inviting staff. `branchIds` is the whole multi-branch admin story:
 *
 *   []            -> org-wide: one membership_role row with branchId null
 *   [A]           -> branch A only
 *   [A, B]        -> two rows; this is "admin manages A and B"
 */
export const inviteMemberRequest = z.object({
  email,
  phone: phone.optional(),
  roleId: uuid,
  branchIds: z.array(uuid).default([]),
  employeeCode: z.string().max(64).optional(),
  department: z.string().max(128).optional(),
});

export const assignRoleRequest = z.object({
  membershipId: uuid,
  roleId: uuid,
  /** null = every branch in the organization */
  branchId: uuid.nullable(),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
});

export const permissionOverrideRequest = z.object({
  membershipId: uuid,
  permissionCode: z.string().max(128),
  branchId: uuid.nullable(),
  effect: z.enum(['GRANT', 'DENY']),
  reason: z.string().max(512).optional(),
});

export const createRoleRequest = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE'),
  name: z.string().min(2).max(128),
  description: z.string().max(512).optional(),
  scopeLevel: z.enum(['ORGANIZATION', 'BRANCH']),
  permissionCodes: z.array(z.string()).min(1),
});

export const checkSlugQuery = z.object({ slug: availableSlug });

export type RegisterOrganizationRequest = z.infer<typeof registerOrganizationRequest>;
export type CreateBranchRequest = z.infer<typeof createBranchRequest>;
export type UpdateBranchRequest = z.infer<typeof updateBranchRequest>;
export type InviteMemberRequest = z.infer<typeof inviteMemberRequest>;
export type AssignRoleRequest = z.infer<typeof assignRoleRequest>;
export type CreateRoleRequest = z.infer<typeof createRoleRequest>;
export type PermissionOverrideRequest = z.infer<typeof permissionOverrideRequest>;
