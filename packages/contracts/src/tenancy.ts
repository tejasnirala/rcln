import { z } from 'zod';
import { availableSlug, currencyCode, email, password, phone, timezone, uuid } from './common.js';

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

/** 0 = Sunday, matching Postgres `extract(dow)` and JS `Date#getDay`. */
export const operatingHour = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/),
  isClosed: z.boolean().default(false),
  slotMinutes: z.number().int().min(5).max(240).default(15),
});

/**
 * The whole week, replaced in one call.
 *
 * Deliberately not a per-day endpoint. Operating hours are read as a set — "are
 * we open on Tuesday" is answered against all seven rows — and a partial update
 * leaves the branch in a state where some days are the new schedule and some
 * are the old one, with nothing recording which is which.
 *
 * A day omitted from the array is deleted, which is how a branch drops to a
 * six-day week. `.max(7)` plus the day uniqueness check in the service keeps
 * the set well-formed.
 */
export const branchOperatingHoursRequest = z.object({
  hours: z.array(operatingHour).max(7),
});

export const branchClosureRequest = z.object({
  /** Date only — a closure is a whole day, in the branch's own timezone. */
  closureDate: z.iso.date(),
  reason: z.string().max(255).optional(),
});

/**
 * Inviting staff. `branchIds` is the whole multi-branch admin story:
 *
 *   []            -> org-wide: one membership_role row with branchId null
 *   [A]           -> branch A only
 *   [A, B]        -> two rows; this is "admin manages A and B"
 *
 * No employment fields here. `staff_profiles` keys on MEMBERSHIP, and the
 * membership does not exist until the invitation is accepted — an employee code
 * captured now would have nowhere to live for however long the invitation sits
 * unanswered. Employment facts are set on the member, after they join.
 */
export const inviteMemberRequest = z.object({
  email,
  phone: phone.optional(),
  roleId: uuid,
  branchIds: z.array(uuid).max(50).default([]),
});

/**
 * Revoking is an action on an invitation, not a payload — the id is in the path.
 * The reason is optional and lands on the audit row, never on an email.
 */
export const revokeInvitationRequest = z.object({
  reason: z.string().max(255).optional(),
});

/**
 * Give a member a role, in one branch or in all of them.
 *
 * The membership is in the path, not here — the same shape as
 * `revokeInvitationRequest`: this is an action on a member, and an id that
 * appears in both places is an id that can disagree with itself.
 *
 *   branchId null -> one membership_roles row with branch_id NULL, which means
 *                    every branch in the organization, including ones opened
 *                    later (ADR-0002). It is a strictly larger grant than
 *                    naming every branch you can currently see, which is why
 *                    the API refuses it from a caller whose own scope is
 *                    narrower than the whole clinic.
 *
 * `validFrom` / `validTo` are how a locum gets access for a fortnight. The
 * resolver treats validTo as exclusive, so an assignment ending at midnight
 * stops working at midnight.
 */
export const assignRoleRequest = z.object({
  roleId: uuid,
  /** null = every branch in the organization */
  branchId: uuid.nullable(),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
});

/**
 * A per-person exception to what their roles say.
 *
 * DENY beats GRANT and both beat a role grant, so this is the sharp instrument:
 * one row here quietly overrules the whole role model for one person. `reason`
 * is optional to Zod and effectively mandatory in practice — it is the only
 * record of why the exception exists, and it lands on the audit row.
 */
export const permissionOverrideRequest = z.object({
  permissionCode: z.string().max(128),
  branchId: uuid.nullable(),
  effect: z.enum(['GRANT', 'DENY']),
  reason: z.string().max(512).optional(),
});

/**
 * A custom role, scoped to this organization.
 *
 * System roles are never edited — a tenant clones one into a role of its own and
 * edits that. There is no clone endpoint: the role list already carries every
 * system role's permission codes, so cloning is the create form arriving
 * prefilled, and a second way to write the same row is worse than none.
 *
 * The database refuses a code that shadows a system one
 * (`reject_shadowed_system_role`), because two roles with the same code make the
 * effective-permission lookup ambiguous.
 */
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

/**
 * `code` and `scopeLevel` are absent on purpose.
 *
 * The code is what `membership_roles` rows and the permission resolver identify
 * the role by, and the scope level decides whether an assignment may name a
 * branch — changing either would silently reinterpret assignments that already
 * exist. Retire the role and make a new one instead.
 */
export const updateRoleRequest = z.object({
  name: z.string().min(2).max(128).optional(),
  description: z.string().max(512).nullable().optional(),
  /** Replaces the whole set, like operating hours. An omitted code is removed. */
  permissionCodes: z.array(z.string()).min(1).optional(),
});

/**
 * Employment facts, set on the member after they join.
 *
 * `staff_profiles` keys on membership, so none of this could be captured on the
 * invitation — there was no membership to hang it off yet. Every field is
 * nullable: clearing a department is a thing an administrator does, and it has
 * to be distinguishable from not mentioning it.
 */
export const updateMemberRequest = z.object({
  employeeCode: z.string().max(64).nullable().optional(),
  department: z.string().max(128).nullable().optional(),
  designation: z.string().max(128).nullable().optional(),
  joinedOn: z.iso.date().nullable().optional(),
  relievedOn: z.iso.date().nullable().optional(),
});

/** Suspending or restoring someone. The reason is for the audit row only. */
export const memberStatusRequest = z.object({
  reason: z.string().max(255).optional(),
});

/**
 * The clinic's own particulars.
 *
 * `slug` is absent, and this is the reason: the subdomain is the tenant's
 * address. `organization_domains` keys on it, `resolveTenant` caches host ->
 * tenant for 300 seconds, and every session cookie is host-only — so renaming it
 * signs out every member and breaks every link anyone has bookmarked. It is a
 * platform-side operation, not a settings field.
 *
 * `orgType` and `countryCode` are absent for a duller reason: nothing yet reads
 * them, and a field that can be changed but changes nothing is a lie.
 *
 * Every field is optional (a PATCH), and `gstNumber` is additionally nullable —
 * a clinic below the registration threshold clearing a number it entered by
 * mistake has to be distinguishable from not mentioning it.
 */
export const updateOrganizationRequest = z.object({
  legalName: z.string().min(2).max(255).optional(),
  displayName: z.string().min(2).max(255).optional(),
  gstNumber: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, 'invalid GSTIN')
    .nullable()
    .optional(),
  timezone: timezone.optional(),
  currency: currencyCode.optional(),
});

/**
 * One setting, set at the organization scope.
 *
 * `value` is a bare JSON value because the shape it must take is not knowable
 * here — it comes from `setting_definitions.data_type`, a row, not a type. The
 * service checks it against that definition and answers 400 with the type it
 * expected. Zod's job on this route is to establish that a value was sent at
 * all and that it is JSON.
 *
 * Clearing an override is a DELETE, not `{ value: null }`: null is a legitimate
 * JSON value, so it cannot also mean "unset".
 */
export const settingValueRequest = z.object({
  value: z.json(),
});

export const checkSlugQuery = z.object({ slug: availableSlug });

// -- responses ---------------------------------------------------------------

/**
 * What registration hands back.
 *
 * No tokens. The new organization lives on its own subdomain, and a session
 * cookie must be scoped to the exact host that owns it — a cookie set on the
 * apex would be readable by every other tenant. So the browser is sent to
 * `loginUrl` and signs in there, on the host the session will belong to.
 */
export const registerOrganizationResponse = z.object({
  organizationId: uuid,
  slug: z.string(),
  /** Fully-qualified, because the caller is on a different host than the answer. */
  loginUrl: z.url(),
});

/**
 * Deliberately thin. This endpoint is unauthenticated and answers questions
 * about which clinics exist, so it returns a boolean and nothing else — no
 * name, no status, no "taken by whom".
 */
export const slugAvailabilityResponse = z.object({
  slug: z.string(),
  available: z.boolean(),
});

/**
 * A branch as the management screens see it.
 *
 * Richer than `branchSummary` in auth.ts, which is only what the branch
 * switcher renders and is embedded in every session response. Two shapes
 * because they answer different questions, not by accident.
 */
export const branchDetail = z.object({
  id: uuid,
  name: z.string(),
  code: z.string(),
  branchType: z.enum(['CLINIC', 'HOSPITAL', 'LAB', 'PHARMACY']),
  status: z.enum(['ACTIVE', 'INACTIVE', 'CLOSED']),
  isPrimary: z.boolean(),
  timezone: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  gstNumber: z.string().nullable(),
  operatingHours: z.array(operatingHour),
});

export const branchListResponse = z.object({
  branches: z.array(branchDetail),
});

/**
 * An invitation as the management screen sees it.
 *
 * `token` is absent, and must stay absent. The column holds a SHA-256 digest and
 * the clear token exists for exactly as long as it takes to hand it to the
 * sender — an administrator listing invitations must not be able to read one
 * back out and sign in as the invitee.
 *
 * `status` is derived rather than stored: the table records `acceptedAt`,
 * `revokedAt` and `expiresAt`, and three timestamps are the wrong thing to make
 * a UI reason about.
 */
export const invitationSummary = z.object({
  id: uuid,
  email: z.string(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']),
  roleId: uuid,
  roleName: z.string(),
  /** Empty means org-wide — every branch, now and in future. */
  branches: z.array(z.object({ id: uuid, name: z.string(), code: z.string() })),
  invitedByName: z.string(),
  expiresAt: z.iso.datetime(),
  /**
   * Whole days remaining, derived by the API against its own clock — the same
   * clock that decided `status`. Sending only `expiresAt` would push the
   * subtraction into a render, where it is a call to `Date.now()` that React
   * rightly refuses: two renders a day apart would disagree, and nothing would
   * make them re-render in between. Zero or less means it lapses today.
   */
  daysLeft: z.number().int(),
  createdAt: z.iso.datetime(),
});

export const invitationListResponse = z.object({
  invitations: z.array(invitationSummary),
  /** The roles this caller may invite into, so the form does not guess. */
  roles: z.array(
    z.object({
      id: uuid,
      code: z.string(),
      name: z.string(),
      scopeLevel: z.enum(['ORGANIZATION', 'BRANCH']),
    })
  ),
});

/**
 * A role as the roles screen sees it.
 *
 * `isSystem` is the whole editing model in one boolean: system roles are shared
 * across every tenant, are listed here so they can be assigned and cloned, and
 * are never mutated. `memberCount` is what makes deleting one a decision rather
 * than a guess — the API refuses to delete a role somebody still holds.
 */
export const roleDetail = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopeLevel: z.enum(['ORGANIZATION', 'BRANCH']),
  isSystem: z.boolean(),
  /** Codes, not ids: the UI groups by module and the id means nothing to it. */
  permissionCodes: z.array(z.string()),
  memberCount: z.number().int(),
});

export const roleListResponse = z.object({
  roles: z.array(roleDetail),
  /**
   * The whole catalogue, so the editor can offer it without a second call and
   * without shipping a copy of `@rcln/permissions` to the browser.
   */
  permissions: z.array(
    z.object({
      code: z.string(),
      module: z.string(),
      action: z.string(),
      description: z.string().nullable(),
    })
  ),
  /**
   * Which of those codes this caller may put on a role.
   *
   * You cannot grant what you do not hold — an ORG_ADMIN is deliberately denied
   * `patient.delete`, and a custom role would otherwise hand it straight back.
   * Sent so the editor can say so up front rather than let the API refuse.
   */
  grantableCodes: z.array(z.string()),
});

/** One row of `membership_roles`, named so a person can read it. */
export const memberRoleAssignment = z.object({
  id: uuid,
  roleId: uuid,
  roleCode: z.string(),
  roleName: z.string(),
  /** null = every branch in the organization, now and in future. */
  branchId: uuid.nullable(),
  branchName: z.string().nullable(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
});

export const memberOverride = z.object({
  id: uuid,
  permissionCode: z.string(),
  branchId: uuid.nullable(),
  branchName: z.string().nullable(),
  effect: z.enum(['GRANT', 'DENY']),
  reason: z.string().nullable(),
});

/**
 * A member as the staff screen sees it.
 *
 * Name and email are staff identity, not patient data, and an administrator
 * managing access needs to know who they are acting on. They are still never
 * written to an audit row — those carry ids and permission codes only.
 */
export const memberDetail = z.object({
  /** The MEMBERSHIP id. Everything on this screen acts on the membership. */
  id: uuid,
  userId: uuid,
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']),
  joinedAt: z.iso.datetime().nullable(),
  roles: z.array(memberRoleAssignment),
  overrides: z.array(memberOverride),
  employeeCode: z.string().nullable(),
  department: z.string().nullable(),
  designation: z.string().nullable(),
  joinedOn: z.iso.date().nullable(),
  relievedOn: z.iso.date().nullable(),
  /**
   * True for the caller's own membership.
   *
   * The API refuses to let anyone change their own roles, overrides or status —
   * that is both the self-escalation route and the way an only administrator
   * locks themselves out — and the screen hides those controls rather than
   * offering a button that is going to be refused.
   */
  isSelf: z.boolean(),
});

export const memberListResponse = z.object({
  members: z.array(memberDetail),
  /** Assignable roles, already filtered to non-PLATFORM scope. */
  roles: z.array(
    z.object({
      id: uuid,
      code: z.string(),
      name: z.string(),
      scopeLevel: z.enum(['ORGANIZATION', 'BRANCH']),
    })
  ),
  /**
   * The branches this caller may assign into — their own scope, no wider.
   * Carried here so the screen needs no `branch.read`, which `iam.user.read`
   * does not imply.
   */
  branches: z.array(z.object({ id: uuid, name: z.string(), code: z.string() })),
  /** Same list as on the roles screen, for the override form. */
  grantableCodes: z.array(z.string()),
  /** True when this caller's own scope covers every branch in the clinic. */
  canAssignOrgWide: z.boolean(),
});

/**
 * The clinic as its own settings screen sees it.
 *
 * `slug` and `status` are shown and not editable — where you are and whether the
 * subscription is live are facts about this clinic that its administrator needs
 * to be able to read back, and neither is changed from here.
 */
export const organizationProfile = z.object({
  id: uuid,
  slug: z.string(),
  legalName: z.string(),
  displayName: z.string(),
  orgType: z.enum(['CLINIC', 'HOSPITAL', 'CHAIN', 'LAB']),
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
  gstNumber: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  countryCode: z.string(),
  onboardedAt: z.iso.datetime().nullable(),
});

/**
 * One setting, resolved for this clinic.
 *
 * WHAT THE THREE VALUES MEAN
 *   Resolution is USER -> BRANCH -> ORGANIZATION -> PLATFORM -> the definition's
 *   default, most specific wins. This screen sits at the ORGANIZATION scope, so
 *   it reports two of those and collapses the rest:
 *
 *     value          what applies at this clinic today
 *     inheritedValue what would apply if the clinic override were cleared
 *     isOverridden   whether this clinic has set one at all
 *
 *   `inheritedFrom` names where `inheritedValue` came from, because "the
 *   platform decided this" and "nobody has ever decided this" are different
 *   answers to "why is it 15".
 *
 *   Branch- and user-level values are deliberately NOT folded in. A branch that
 *   sets its own slot length still overrules this row, and pretending otherwise
 *   would make the screen lie to a clinic with three branches.
 *
 * `editable` is `isTenantEditable` AND the definition allowing an ORGANIZATION
 * value at all. Both are properties of the setting, not of the caller — the
 * permission check is separate and happens at the route.
 */
/**
 * One choice on a setting whose values are a closed set.
 *
 * The value keeps its real type — 4, not "4", for the month a financial year
 * starts — because that is what the column stores and what any arithmetic
 * downstream expects. The label is the only thing a human should ever see:
 * nobody picks "4" from a list, they pick April.
 */
export const settingChoice = z.object({
  value: z.json(),
  label: z.string(),
});

export const settingItem = z.object({
  key: z.string(),
  module: z.string(),
  dataType: z.enum(['STRING', 'INT', 'BOOL', 'DECIMAL', 'JSON']),
  /** The short name for the row. */
  description: z.string().nullable(),
  /** What the setting is for, and what changing it does. */
  helpText: z.string().nullable(),
  /**
   * The values this setting will accept, or null for "anything of `dataType`".
   *
   * Comes from `setting_definitions.allowed_values`, so the select the screen
   * renders and the set the API enforces are the same list — a screen offering
   * three options while the API takes any string is how a clinic ends up with
   * a delivery channel nothing can send to.
   */
  choices: z.array(settingChoice).nullable(),
  allowedScopes: z.array(z.string()),
  editable: z.boolean(),
  value: z.json(),
  isOverridden: z.boolean(),
  inheritedValue: z.json(),
  inheritedFrom: z.enum(['PLATFORM', 'DEFAULT']),
  /** When this clinic last set it. Null when it never has. */
  updatedAt: z.iso.datetime().nullable(),
});

export const settingListResponse = z.object({
  settings: z.array(settingItem),
});

/**
 * One clinic as the PLATFORM console sees it — every tenant on the system.
 *
 * Deliberately thin. This is the only list in the product that crosses the
 * tenant boundary, so it carries what an rcln operator needs to find an account
 * and nothing that belongs to the clinic: no owner, no member names, no
 * addresses, and obviously nothing clinical.
 *
 * NO BRANCH OR MEMBER COUNTS, AND THAT IS NOT AN OVERSIGHT
 *   `organizations` is RLS-exempt — it is the table the tenant is resolved FROM
 *   — but `branches` and `memberships` are not, and the unscoped client sets no
 *   session variables, so their policies evaluate against a NULL organization
 *   and match nothing. A `_count` here returns 0 for every clinic, with no error
 *   and nothing in the log. Getting real numbers would mean one `withTenant`
 *   round trip per organization; they are not worth that, and a silent zero is
 *   worse than an absent column.
 */
export const platformOrganizationSummary = z.object({
  id: uuid,
  slug: z.string(),
  displayName: z.string(),
  legalName: z.string(),
  status: z.string(),
  orgType: z.string(),
  createdAt: z.iso.datetime(),
});

export const platformOrganizationListResponse = z.object({
  organizations: z.array(platformOrganizationSummary),
});

export type PlatformOrganizationSummary = z.infer<typeof platformOrganizationSummary>;
export type PlatformOrganizationListResponse = z.infer<typeof platformOrganizationListResponse>;
export type CheckSlugQuery = z.infer<typeof checkSlugQuery>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequest>;
export type OrganizationProfile = z.infer<typeof organizationProfile>;
export type SettingValueRequest = z.infer<typeof settingValueRequest>;
export type SettingChoice = z.infer<typeof settingChoice>;
export type SettingItem = z.infer<typeof settingItem>;
export type SettingListResponse = z.infer<typeof settingListResponse>;
export type RoleDetail = z.infer<typeof roleDetail>;
export type RoleListResponse = z.infer<typeof roleListResponse>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequest>;
export type MemberRoleAssignment = z.infer<typeof memberRoleAssignment>;
export type MemberOverride = z.infer<typeof memberOverride>;
export type MemberDetail = z.infer<typeof memberDetail>;
export type MemberListResponse = z.infer<typeof memberListResponse>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;
export type MemberStatusRequest = z.infer<typeof memberStatusRequest>;
export type InvitationSummary = z.infer<typeof invitationSummary>;
export type InvitationListResponse = z.infer<typeof invitationListResponse>;
export type RevokeInvitationRequest = z.infer<typeof revokeInvitationRequest>;
export type OperatingHour = z.infer<typeof operatingHour>;
export type BranchDetail = z.infer<typeof branchDetail>;
export type BranchListResponse = z.infer<typeof branchListResponse>;
export type BranchOperatingHoursRequest = z.infer<typeof branchOperatingHoursRequest>;
export type BranchClosureRequest = z.infer<typeof branchClosureRequest>;
export type RegisterOrganizationResponse = z.infer<typeof registerOrganizationResponse>;
export type SlugAvailabilityResponse = z.infer<typeof slugAvailabilityResponse>;

export type RegisterOrganizationRequest = z.infer<typeof registerOrganizationRequest>;
export type CreateBranchRequest = z.infer<typeof createBranchRequest>;
export type UpdateBranchRequest = z.infer<typeof updateBranchRequest>;
export type InviteMemberRequest = z.infer<typeof inviteMemberRequest>;
export type AssignRoleRequest = z.infer<typeof assignRoleRequest>;
export type CreateRoleRequest = z.infer<typeof createRoleRequest>;
export type PermissionOverrideRequest = z.infer<typeof permissionOverrideRequest>;
