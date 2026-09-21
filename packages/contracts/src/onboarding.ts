/**
 * The clinic profile's PRIMITIVES — the vocabulary, and the shape the session
 * carries (CO-1, ADR-0018).
 *
 * ⚠️ THIS FILE IMPORTS FROM `common.js` AND NOTHING ELSE, AND THAT CONSTRAINT
 *   IS THE ONLY REASON IT IS SEPARATE FROM `onboarding-wizard.ts`.
 *   `auth.ts` imports `clinicProfileSummary` and `clinicModule` from here —
 *   `branchSummary` and `membershipSummary` carry the resolved profile so the
 *   shell can render the right nav and the patient form the right default —
 *   and `auth.ts` is exported second in `index.ts`, immediately after
 *   `common.js`. Anything this file imported would have to come before it, and
 *   a Zod module cycle fails at RUNTIME rather than at lint.
 *
 *   So: the wizard's own request and response shapes, which legitimately need
 *   `tenancy.js`, `tax.js` and `locale.js`, live in `onboarding-wizard.ts` and
 *   are exported after those. Nothing there is on the session.
 */
import { z } from 'zod';
import { uuid } from './common.js';

/**
 * A module of the product, as the clinic thinks of it.
 *
 * ⚠️ THREE DIFFERENT QUESTIONS SHARE THIS VOCABULARY AND MUST NOT SHARE AN
 *   ANSWER. `plan_features` says what the clinic MAY have (we sell it), a
 *   `clinic_profile_modules` row says what they picked from that, and
 *   `membership_roles` says who may touch it. Collapsing any two makes a
 *   billing question answerable by a configuration edit — or worse, makes
 *   "we do not run a pharmacy" mean "you may not dispense".
 */
export const clinicModule = z.enum([
  'APPOINTMENTS',
  'CONSULTATIONS',
  'PHARMACY',
  'INVENTORY',
  'PROCUREMENT',
  'LAB',
  'BILLING',
  'ONLINE_ORDERS',
]);
export type ClinicModule = z.infer<typeof clinicModule>;

/**
 * The module catalogue — the ONE place that says which modules are sold
 * separately and under which entitlement key.
 *
 * ⚠️ IT LIVES IN CONTRACTS BECAUSE BOTH SIDES READ IT AND MUST AGREE. The API
 *   refuses an unentitled module from this table; the wizard renders its
 *   checkboxes from the same rows. A copy in `apps/web` would drift, and the
 *   drift shows up as a checkbox the clinic can tick and the server then
 *   rejects — which is the worst possible place to discover a plan boundary.
 *
 *   The refusal is a 400, deliberately not a 403 and deliberately not a 422 —
 *   see `moduleStepRequest` in `onboarding-wizard.ts` for both halves of that
 *   argument.
 *
 * `featureKey: null` means "always available on every plan". Those are the
 * modules that are not a product line: a clinic that cannot book an appointment
 * is not a clinic.
 *
 * ⚠️ ONLY TWO KEYS APPEAR HERE — `pharmacy_module` AND `lab_module` — BECAUSE
 *   ONLY TWO ARE SOLD. They are the two in `plans.ts` and the two in
 *   `HARD_DEFAULTS`; every other key would resolve to "off" for every clinic on
 *   the platform, because `resolveEntitlements` deliberately denies a feature
 *   nobody has priced. Inventing `inventory_module` here would have made Stock
 *   unreachable for every existing customer, silently, on the day this shipped.
 *
 * ⚠️ ONLINE ORDERS GATES ON `pharmacy_module`, WHICH IS NOT AN OVERSIGHT. PI-12
 *   is the same medicine leaving in a parcel instead of into a hand — it is the
 *   pharmacy product line, not a second one, and it writes no second way to move
 *   stock. If it is ever priced separately, this is the line to change and the
 *   plan seed is the other.
 */
export const CLINIC_MODULES: readonly {
  key: ClinicModule;
  label: string;
  /** The `plan_features` key that gates it, or null when it is always on. */
  featureKey: string | null;
  /** What the wizard says under the checkbox. The clinic's words, not ours. */
  blurb: string;
}[] = [
  {
    key: 'APPOINTMENTS',
    label: 'Appointments',
    featureKey: null,
    blurb: 'Book visits, run a day board, send reminders.',
  },
  {
    key: 'CONSULTATIONS',
    label: 'Consultations',
    featureKey: null,
    blurb: 'The clinical record — notes, diagnoses, prescriptions.',
  },
  {
    key: 'BILLING',
    label: 'Billing',
    featureKey: null,
    blurb: 'Raise invoices, take payments, print a receipt.',
  },
  {
    key: 'PHARMACY',
    label: 'Pharmacy',
    featureKey: 'pharmacy_module',
    blurb: 'Dispense at a counter, against a prescription or over it.',
  },
  {
    key: 'INVENTORY',
    label: 'Stock',
    featureKey: null,
    blurb: 'Batches, expiry, transfers between sites.',
  },
  {
    key: 'PROCUREMENT',
    label: 'Buying',
    featureKey: null,
    blurb: 'Suppliers, purchase orders, goods received.',
  },
  {
    key: 'LAB',
    label: 'Lab',
    featureKey: 'lab_module',
    blurb: 'Order investigations and record results.',
  },
  {
    key: 'ONLINE_ORDERS',
    label: 'Online orders',
    featureKey: 'pharmacy_module',
    blurb: 'Take medicine orders for delivery rather than at the counter.',
  },
] as const;

/** The wizard's seven steps. */
export const onboardingStep = z.enum([
  'IDENTITY',
  'CARE_CONTEXTS',
  'MODULES',
  'LOCALE_HOURS',
  'TAX_BILLING',
  'STAFF',
  'REVIEW',
]);
export type OnboardingStep = z.infer<typeof onboardingStep>;

/**
 * The order they are asked in.
 *
 * ⚠️ THE ONE EXPRESSION OF THAT ORDER OUTSIDE THE PRISMA ENUM'S DECLARATION.
 *   The rail, the "next incomplete step" calculation and the review screen all
 *   read this. Two lists that can disagree about which step comes third is how
 *   a wizard sends somebody backwards.
 */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  'IDENTITY',
  'CARE_CONTEXTS',
  'MODULES',
  'LOCALE_HOURS',
  'TAX_BILLING',
  'STAFF',
  'REVIEW',
] as const;

/** How the wizard's rail draws one step. */
export const onboardingStepState = z.object({
  step: onboardingStep,
  /**
   * Absent row = pending, row with null = opened but not saved, set = done.
   * Collapsed here to two fields because the rail draws three states and the
   * screen should not have to reason about row existence.
   */
  visited: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
});
export type OnboardingStepState = z.infer<typeof onboardingStepState>;

/**
 * What this clinic said it is, resolved for one scope — BRANCH over
 * ORGANIZATION, exactly as `setting_values` resolves.
 *
 * ⚠️ THIS IS THE SHAPE THAT RIDES THE SESSION, AND IT IS DELIBERATELY THIN.
 *   It answers the only two questions the profile is read live for: which nav
 *   tabs render, and whether the patient form shows a care-context picker.
 *   Everything else the wizard captured became a `setting_values` row that the
 *   clinic owns and the settings screen reports (ADR-0018).
 *
 * ⚠️ AND IT IS NOT AN AUTHORIZATION INPUT. A module missing from this list must
 *   never be the reason a request is refused — `authorize()` is. This only
 *   decides whether a tab is drawn.
 */
export const clinicProfileSummary = z.object({
  /**
   * The `CARE_CONTEXT` specialty ids this clinic works in.
   *
   * ⚠️ ITS LENGTH IS THE WHOLE FEATURE. One means the patient form defaults
   *   `subjectType` and does not render the picker at all — the pet clinic that
   *   is never asked "person or animal?". Two or more means the picker appears.
   *   Empty means onboarding has not reached that step, and the form falls back
   *   to showing the picker, because refusing to ask is only safe once somebody
   *   has answered.
   */
  careContextIds: z.array(uuid),
  /**
   * The same contexts as their taxonomy codes — `HUMAN`, `VET`.
   *
   * ⚠️ RIDES ALONGSIDE THE IDS BECAUSE THE PATIENT FORM NEEDS THE CODE AND
   *   CANNOT LOOK IT UP. Resolving an id to a code means `GET /specialties`,
   *   which is behind a permission the front desk does not hold — the same
   *   argument `branchSummary.timezone` makes about the day board.
   */
  careContextCodes: z.array(z.string()),
  /** What the nav should offer. See the warning above about authorization. */
  modules: z.array(clinicModule),
});
export type ClinicProfileSummary = z.infer<typeof clinicProfileSummary>;
