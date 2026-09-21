/**
 * The seven-step wizard's own surface (CO-1, ADR-0018).
 *
 * ⚠️ SPLIT FROM `onboarding.ts` DELIBERATELY, AND THE SPLIT IS ABOUT IMPORT
 *   ORDER, NOT ABOUT SIZE. `onboarding.ts` holds the vocabulary and the summary
 *   that rides the SESSION, so `auth.ts` imports it and it may therefore import
 *   nothing but `common.js`. This file needs `tenancy.js`, `tax.js` and
 *   `locale.js`, so it is exported after all three. Nothing here is on the
 *   session, and nothing here may become so without moving first.
 *
 * ── EVERY STEP IS AN IDEMPOTENT PUT ──────────────────────────────────────────
 * ⚠️ PUT AND NOT POST, AND THE VERB IS LOAD-BEARING. Re-entering a step in year
 *   two — the clinic that adds a pharmacy — must be safe to do twice, must not
 *   duplicate its child rows, and must NOT stomp settings the clinic has tuned
 *   since. The service's seeding writes only where no explicit value exists at
 *   that scope; the verb is what tells a reader that is the intent.
 */
import { z } from 'zod';
import { calendarDate, email, phone, timezone, uuid } from './common.js';
import { TIME_FORMATS } from './locale.js';
import { operatingHour } from './tenancy.js';
import { createClinicTaxRegistrationRequest } from './tax.js';
import { clinicModule, clinicProfileSummary, onboardingStepState } from './onboarding.js';

/**
 * The kind of place this is, in the branch's vocabulary.
 *
 * ⚠️ THE SAME FOUR MEMBERS AS `createBranchRequest.branchType`, AND THAT IS THE
 *   POINT: the identity step seeds the primary branch's type from it. It is not
 *   `OrganizationType`, which has CHAIN — a chain is a fact about the group, not
 *   about a site, and the identity step asks about both separately.
 */
export const facilityKind = z.enum(['CLINIC', 'HOSPITAL', 'LAB', 'PHARMACY']);
export type FacilityKind = z.infer<typeof facilityKind>;

// -- step requests -----------------------------------------------------------

/**
 * Step 1 — "Who you are".
 *
 * Pre-filled from what registration already captured, so for most clinics this
 * step is a confirmation rather than a form. It writes `organizations` and the
 * primary branch's type; it seeds no settings.
 */
export const identityStepRequest = z.object({
  legalName: z.string().min(2).max(255),
  displayName: z.string().min(2).max(255),
  orgType: z.enum(['CLINIC', 'HOSPITAL', 'CHAIN', 'LAB']),
  facilityKind,
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'two letters, like IN or IE')
    .transform((value) => value.toUpperCase()),
  /** ISO 3166-2 subdivision without the country prefix — `KA`, never `IN-KA`. */
  regionCode: z
    .string()
    .max(10)
    .regex(/^[A-Za-z0-9-]*$/, 'letters, digits and hyphens only')
    .transform((value) => (value ? value.toUpperCase() : null))
    .optional()
    .nullable(),
});
export type IdentityStepRequest = z.infer<typeof identityStepRequest>;

/**
 * Step 2 — "Who you treat". The step this whole feature exists for.
 *
 * ⚠️ `.min(1)`: A CLINIC THAT TREATS NOBODY IS NOT A STATE THE PRODUCT HAS AN
 *   ANSWER FOR. An empty list would leave `patient.default_subject_type`
 *   unseeded and the picker permanently visible — which is the pre-onboarding
 *   behaviour, reached by saving a step rather than by skipping it, and
 *   therefore indistinguishable from a bug.
 */
export const careContextStepRequest = z.object({
  /**
   * NULL/absent = the organization's answer. Present = this site answers
   * differently, which is the standalone-pharmacy or small-animal satellite
   * case. Validated against the caller's own branches in the service.
   */
  branchId: uuid.optional(),
  careContextIds: z.array(uuid).min(1).max(20),
});
export type CareContextStepRequest = z.infer<typeof careContextStepRequest>;

/**
 * Step 3 — "What you run".
 *
 * ⚠️ AN UNENTITLED MODULE IS REFUSED WITH 400, AND THE POINT IS THAT IT IS NOT
 *   A 403. "Your plan does not include Pharmacy" and "you may not dispense" are
 *   different sentences said to different people; answering a plan question with
 *   a permission status sends the clinic to their administrator instead of to
 *   billing.
 *
 *   ⚠️ AND IT IS NOT A 422 EITHER, WHICH IS THE STATUS THIS SHAPE OF REFUSAL
 *     FIRST SUGGESTS. In this API 422 is documented narrowly as "the rules of
 *     this JURISDICTION do not permit what was asked" — it carries rule codes and
 *     a regulator's sentence, and the dispensing screens read it that way. A
 *     commercial limit borrowing it would make one status mean both "the law
 *     refuses" and "your plan refuses", and a client cannot tell those apart.
 */
export const moduleStepRequest = z.object({
  branchId: uuid.optional(),
  modules: z.array(clinicModule).max(32),
});
export type ModuleStepRequest = z.infer<typeof moduleStepRequest>;

/**
 * Step 4 — "When you're open".
 *
 * ⚠️ `branchId` IS REQUIRED HERE, UNLIKE STEPS 2 AND 3. A time zone and a set of
 *   opening hours are facts about a PLACE — there is no organization-level
 *   answer to "when do you open" for a group with a site in each of two states.
 *   `branches.timezone` and `branch_operating_hours` are columns and rows on the
 *   branch; only the clock FORMAT and the slot length are settings.
 */
export const localeStepRequest = z.object({
  branchId: uuid,
  timezone,
  timeFormat: z.enum(TIME_FORMATS),
  /** Minutes one appointment blocks out. Seeds `appointment.slot_minutes`. */
  slotMinutes: z.number().int().min(5).max(240),
  operatingHours: z.array(operatingHour).max(7),
});
export type LocaleStepRequest = z.infer<typeof localeStepRequest>;

/**
 * Step 5 — "How you bill".
 *
 * ⚠️ THE REGISTRATION HERE IS THE CLINIC AS AN ISSUER, NOT AS RCLN'S CUSTOMER,
 *   AND CONFLATING THEM IS THE MISTAKE THIS STEP EXISTS TO PREVENT.
 *   `taxRegistration` creates an `issuer_tax_registrations` row — the number the
 *   clinic PRINTS on the invoices it raises against its own patients, which is
 *   effective-dated because one business can hold several.
 *   `organizations.tax_id` is a different fact: the number rcln bills the CLINIC
 *   under, and it is derived from these registrations rather than typed. The
 *   screen must label this one as "the number you print on patient bills", or a
 *   clinic whose two numbers differ will enter one of them in the wrong place
 *   and only find out when a patient's invoice is refused as defective.
 *
 * Every field is optional: a clinic that is not registered for tax yet is a real
 * clinic, and blocking setup on a number they have applied for is how a wizard
 * stops being finishable.
 */
export const taxStepRequest = z.object({
  invoicePrefix: z.string().trim().min(1).max(16).optional(),
  defaultTaxPercent: z.number().min(0).max(100).optional(),
  financialYearStartMonth: z.number().int().min(1).max(12).optional(),
  /** In MINOR units — 100 is "to the rupee". See the setting's own comment. */
  cashRoundingMinor: z.number().int().min(1).max(10000).optional(),
  taxRegistration: createClinicTaxRegistrationRequest.optional(),
});
export type TaxStepRequest = z.infer<typeof taxStepRequest>;

/**
 * Step 6 — "Who works here".
 *
 * Reuses the invitation shape rather than restating it; the service calls the
 * existing invitation path, which does its own auditing and its own emailing.
 * An empty list is valid — a solo practitioner is the common case, and they are
 * already a member.
 */
export const staffStepRequest = z.object({
  invitations: z
    .array(
      z.object({
        email,
        phone: phone.optional(),
        roleId: uuid,
        designationId: uuid.optional(),
        branchIds: z.array(uuid).max(50).default([]),
      })
    )
    .max(50),
});
export type StaffStepRequest = z.infer<typeof staffStepRequest>;

// -- responses ---------------------------------------------------------------

/** One care context the clinic may pick — a platform row, or its own. */
export const careContextOption = z.object({
  id: uuid,
  /** `HUMAN`, `VET`. The taxonomy code, not a label. */
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** False for a platform row, true for one this clinic defined. */
  isOwn: z.boolean(),
});
export type CareContextOption = z.infer<typeof careContextOption>;

/** A branch that answers differently from its organization. */
export const branchProfileState = z.object({
  branchId: uuid,
  branchName: z.string(),
  careContextIds: z.array(uuid),
  modules: z.array(clinicModule),
});
export type BranchProfileState = z.infer<typeof branchProfileState>;

/**
 * Everything the wizard needs to draw itself, in one GET.
 *
 * One request rather than seven because the rail renders every step's state on
 * the first paint, and a screen that fetches per step shows a rail that fills in
 * as you watch.
 */
export const onboardingState = z.object({
  steps: z.array(onboardingStepState),
  /** Set once the review step is submitted. The authority on "setup is done". */
  completedAt: z.iso.datetime().nullable(),
  /** The organization-level answer. Branch overrides are below. */
  profile: clinicProfileSummary,
  branchProfiles: z.array(branchProfileState),
  /**
   * The modules this clinic's PLAN allows, resolved through the billing
   * entitlement engine.
   *
   * ⚠️ IT IS RETURNED HERE AND IT IS NOT ON THE SESSION, WHICH IS NOT AN
   *   OVERSIGHT. Resolving it reads the subscription, which is behind
   *   `organization.billing.read` — a permission the owner holds and the front
   *   desk does not. Putting it on the session would 403 the receptionist's
   *   first page load. The session carries only what the clinic PICKED.
   */
  entitledModules: z.array(clinicModule),
  careContextOptions: z.array(careContextOption),
  /** Pre-fill for step 1, from what registration already knows. */
  identity: identityStepRequest,
  /** The branches step 4 must be answered for, in the order the rail lists them. */
  branches: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      isPrimary: z.boolean(),
      timezone: z.string(),
      timeFormat: z.enum(TIME_FORMATS),
      slotMinutes: z.number().int(),
      operatingHours: z.array(operatingHour),
    })
  ),
  /** Pre-fill for step 5. `taxRegistration` is null until one is recorded. */
  billing: z.object({
    invoicePrefix: z.string(),
    defaultTaxPercent: z.number(),
    financialYearStartMonth: z.number().int(),
    cashRoundingMinor: z.number().int(),
    hasTaxRegistration: z.boolean(),
  }),
  /** For step 6's role menu, so the form does not have to fetch it separately. */
  invitableRoles: z.array(z.object({ id: uuid, name: z.string() })),
  /** How many invitations are already outstanding, so step 6 can say so. */
  pendingInvitationCount: z.number().int(),
});
export type OnboardingState = z.infer<typeof onboardingState>;

/**
 * The effective-date a seeded tax registration takes when the clinic does not
 * say — today, in the clinic's own terms.
 *
 * ⚠️ EXPORTED SO THE SCREEN CAN PRE-FILL THE SAME VALUE THE SERVICE WOULD
 *   DEFAULT TO. A registration whose `effectiveFrom` the form left blank and the
 *   server filled in is a registration the clinic did not read — and
 *   `effectiveFrom` decides whether the first invoices after setup are taxable.
 */
export const taxRegistrationEffectiveFrom = calendarDate;
