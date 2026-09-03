/**
 * The seven-step onboarding wizard (CO-1, ADR-0018).
 *
 * A clinic registers, gets a subdomain, an owner and one branch — and then
 * lands in a product where every module is visible and nothing is configured.
 * This is what runs next: seven questions, asked once, whose answers become
 * settings the clinic owns.
 *
 * ── THE RULE THE WHOLE FILE OBEYS ────────────────────────────────────────────
 * ⚠️ THE PROFILE SEEDS `setting_values`; IT DOES NOT REPLACE THEM. Each step
 *   writes what the clinic IS to `clinic_profiles`, and SEEDS the settings that
 *   follow — via `seedSettingIfUnset`, which writes only where no explicit value
 *   exists at that scope and NEVER updates. That is what makes re-entering a
 *   step in year two safe, and what keeps the settings screen truthful about
 *   who set what.
 *
 *   The consequence to hold on to: this file must never read a setting in order
 *   to decide what to write. It writes defaults, once, and then gets out of the
 *   way.
 *
 * ── ONE TRANSACTION PER STEP, WITH THREE DELIBERATE EXCEPTIONS ───────────────
 * A step is one logical unit of work: upsert the profile, replace its child
 * rows, seed the settings, mark the step, write the audit row — all in one
 * `withTenant`, because an audit row that can commit independently of the
 * mutation it describes is worse than no audit row.
 *
 * ⚠️ THREE STEPS CALL OUT TO EXISTING SERVICES THAT OPEN THEIR OWN
 *   TRANSACTIONS — `setOperatingHours`, `createClinicTaxRegistration` and
 *   `createInvitation` — AND THAT IS A CHOICE, NOT AN OVERSIGHT. Each of those
 *   already validates, audits and (for invitations) sends email; reimplementing
 *   any of them inline to win a single transaction would be a second way to
 *   write operating hours, which is the failure mode CLAUDE.md names outright.
 *
 *   What it costs: a step can half-commit — hours saved, step not marked. Every
 *   step is an idempotent PUT precisely so that the fix is to press save again,
 *   and re-running writes the same rows. Nothing here is money and nothing here
 *   is clinical.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * ⚠️ NOTHING THIS FILE WRITES GRANTS ANYBODY ANYTHING. Modules decide which nav
 *   tabs are drawn; `authorize()` decides who may do what, and is untouched.
 *   A clinic that ticks Pharmacy has not given its receptionist the right to
 *   dispense.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { hasModule, resolveEntitlements } from '@rcln/billing';
import {
  CLINIC_MODULES,
  ONBOARDING_STEP_ORDER,
  type CareContextStepRequest,
  type ClinicModule,
  type IdentityStepRequest,
  type LocaleStepRequest,
  type ModuleStepRequest,
  type OnboardingState,
  type OnboardingStep,
  type StaffStepRequest,
  type TaxStepRequest,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { seedSettings, type SeedSettingInput } from '../settings/seed.service.js';
import { resolveSettingForBranches } from '../settings/resolver.service.js';
import { setOperatingHours } from '../branch/branch.service.js';
import { createClinicTaxRegistration } from '../tax/clinic-tax.service.js';
import { createInvitation } from '../invitation/invitation.service.js';

/** Request metadata carried onto the audit row. Same shape as every sibling. */
export interface OnboardingActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The `CARE_CONTEXT` codes, mapped to what a patient record defaults to.
 *
 * ⚠️ THE SAME MAP `consultation-config.service.ts` HOLDS, INVERTED, AND THE
 *   DUPLICATION IS DELIBERATE RATHER THAN SHARED. That file asks "this patient
 *   is an ANIMAL, which care context resolves?" at consultation time; this one
 *   asks "the clinic works in VET only, what should a new record default to?"
 *   at setup time. They answer opposite questions and will diverge the moment a
 *   third context exists — a shared table would force one of them to be wrong.
 *
 * A code that is not here contributes no default, which is the honest answer:
 * a clinic working in a context nobody has mapped gets the picker.
 */
const SUBJECT_TYPE_FOR_CARE_CONTEXT: Readonly<Record<string, 'HUMAN' | 'ANIMAL'>> = {
  HUMAN: 'HUMAN',
  VET: 'ANIMAL',
};

/**
 * Find or create the profile row for a scope.
 *
 * ⚠️ `findFirst` THEN `create`, NOT `upsert`. The unique is
 *   `(organization_id, branch_id) NULLS NOT DISTINCT` and Prisma refuses to
 *   build a `where` for a compound unique with a nullable component — the same
 *   constraint `setting_values` imposes, for the same reason. Uniqueness stays
 *   the index's job.
 */
async function profileFor(
  tx: TxClient,
  organizationId: string,
  branchId: string | null
): Promise<{ id: string }> {
  const existing = await tx.clinicProfile.findFirst({
    where: { organizationId, branchId },
    select: { id: true },
  });
  if (existing) return existing;

  return tx.clinicProfile.create({
    data: { organizationId, branchId },
    select: { id: true },
  });
}

/**
 * Record that a step was completed.
 *
 * Absent row = pending, row with a null `completedAt` = opened but not saved,
 * set = done. The wizard's rail draws all three from this one column.
 */
async function markStep(tx: TxClient, ctx: TenantContext, step: OnboardingStep): Promise<void> {
  const existing = await tx.clinicOnboardingStep.findFirst({
    where: { organizationId: ctx.organizationId, step },
    select: { id: true },
  });

  const data = { completedAt: new Date(), completedByUserId: ctx.userId };

  if (existing) {
    await tx.clinicOnboardingStep.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.clinicOnboardingStep.create({
    data: { organizationId: ctx.organizationId, step, ...data },
  });
}

/**
 * A branch id from a request body, checked against what this caller may touch.
 *
 * ⚠️ 404 AND NOT 403 FOR A BRANCH THE CALLER CANNOT SEE — CONVENTIONS.md, and
 *   the same call `createInvitation` makes. A 403 confirms the branch exists,
 *   which is a fact about another tenant's estate.
 *
 * ⚠️ AND IT IS NOT MERELY A PERMISSION CHECK. The branch id becomes a
 *   `scopeId` on a `setting_values` write, and that table is RLS-EXEMPT — an
 *   unchecked id from a body would write another clinic's configuration with
 *   nothing in Postgres to object. This function is what makes the seeding
 *   calls below safe.
 */
function assertBranchInScope(ctx: TenantContext, branchId: string | undefined): string | null {
  if (branchId === undefined) return null;
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
  return branchId;
}

/** The modules this clinic's plan allows, resolved through the billing engine. */
async function entitledModules(tx: TxClient, organizationId: string): Promise<ClinicModule[]> {
  const subscription = await tx.subscription.findFirst({
    where: { organizationId },
    select: {
      plan: { select: { features: true } },
      featureOverrides: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  /*
   * ⚠️ NO SUBSCRIPTION MEANS ONLY THE UNGATED MODULES, NOT ALL OF THEM.
   *   `resolveEntitlements` folds in HARD_DEFAULTS, which deny every paid
   *   feature — a floor that is deliberately mean, because a feature nobody has
   *   priced is a feature nobody agreed to sell. Answering "everything" here
   *   would hand the pharmacy to any clinic whose subscription row is missing.
   */
  const features = subscription
    ? resolveEntitlements(subscription.plan.features, subscription.featureOverrides)
    : resolveEntitlements([]);

  return CLINIC_MODULES.filter(
    (m) => m.featureKey === null || hasModule(features, m.featureKey)
  ).map((m) => m.key);
}

// -- read --------------------------------------------------------------------

/**
 * Everything the wizard needs to draw itself, in one call.
 *
 * One request rather than seven because the rail renders every step's state on
 * the first paint, and a screen that fetched per step would show a rail filling
 * in as the user watched.
 */
export async function getOnboardingState(ctx: TenantContext): Promise<OnboardingState> {
  return withTenant(ctx, async (tx) => {
    const [organization, stepRows, profiles, branchRows, careContexts, roles, invitations] =
      await Promise.all([
        tx.organization.findFirstOrThrow({
          where: { id: ctx.organizationId },
          select: {
            legalName: true,
            displayName: true,
            orgType: true,
            countryCode: true,
            regionCode: true,
          },
        }),
        tx.clinicOnboardingStep.findMany({
          where: { organizationId: ctx.organizationId },
          select: { step: true, completedAt: true },
        }),
        tx.clinicProfile.findMany({
          where: { organizationId: ctx.organizationId },
          select: {
            branchId: true,
            facilityKind: true,
            completedAt: true,
            modules: { select: { module: true } },
            careContexts: { select: { specialtyId: true } },
          },
        }),
        tx.branch.findMany({
          where: { id: { in: ctx.branchIds }, deletedAt: null },
          select: {
            id: true,
            name: true,
            isPrimary: true,
            timezone: true,
            operatingHours: {
              select: {
                dayOfWeek: true,
                opensAt: true,
                closesAt: true,
                isClosed: true,
                slotMinutes: true,
              },
              orderBy: { dayOfWeek: 'asc' },
            },
          },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        }),
        /*
         * ⚠️ PLATFORM ROWS AND THIS CLINIC'S OWN, WHICH IS EXACTLY WHAT THE
         *   `platform_extensible` POLICY ALREADY RETURNS. Only two exist today —
         *   `HUMAN` and `VET`, both platform rows — so this is a two-checkbox
         *   screen. It is written as a query rather than a constant because a
         *   clinic defining its own context is a supported shape, and a
         *   hard-coded pair would silently exclude it.
         */
        tx.specialty.findMany({
          where: { type: 'CARE_CONTEXT', isActive: true, deletedAt: null },
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            organizationId: true,
          },
          orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        }),
        /*
         * ⚠️ SYSTEM ROLES TOO, NOT JUST THIS CLINIC'S OWN. `roles.organization_id`
         *   is NULLABLE — the twelve system roles are platform rows shared by
         *   every tenant, and a clinic that has cloned none of them would
         *   otherwise be offered an empty menu on the step whose entire purpose
         *   is inviting somebody. The `platform_extensible` policy already
         *   returns exactly this set.
         */
        tx.role.findMany({
          where: { OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        tx.invitation.count({
          where: { organizationId: ctx.organizationId, acceptedAt: null, revokedAt: null },
        }),
      ]);

    const orgProfile = profiles.find((p) => p.branchId === null);
    const branchIds = branchRows.map((b) => b.id);

    /*
     * ⚠️ BATCHED ACROSS BRANCHES, LIKE EVERY OTHER READ OF THIS TABLE. The
     *   wizard is not a hot path, but `resolveSettingForBranches` is the only
     *   correct shape for reading a setting for several branches and a bespoke
     *   loop here would be the second one.
     */
    const [formats, slots, billing] = await Promise.all([
      resolveSettingForBranches(tx, 'locale.time_format', {
        organizationId: ctx.organizationId,
        branchIds,
      }),
      resolveSettingForBranches(tx, 'appointment.slot_minutes', {
        organizationId: ctx.organizationId,
        branchIds,
      }),
      tx.settingValue.findMany({
        where: {
          // Both halves of every key pinned — `setting_values` is RLS-EXEMPT.
          scopeType: 'ORGANIZATION',
          scopeId: ctx.organizationId,
          settingKey: {
            in: [
              'billing.invoice_prefix',
              'billing.default_tax_percent',
              'billing.financial_year_start_month',
              'billing.cash_rounding_minor',
            ],
          },
        },
        select: { settingKey: true, value: true },
      }),
    ]);

    const billingValue = new Map(billing.map((row) => [row.settingKey, row.value]));
    const asNumber = (key: string, fallback: number): number => {
      const raw = billingValue.get(key);
      const parsed = typeof raw === 'string' ? Number(raw) : raw;
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
    };

    const hasTaxRegistration =
      (await tx.issuerTaxRegistration.count({
        where: { organizationId: ctx.organizationId, deletedAt: null },
      })) > 0;

    const contextCode = new Map(careContexts.map((c) => [c.id, c.code]));
    const toIds = (rows: { specialtyId: string }[]): string[] => rows.map((r) => r.specialtyId);

    return {
      steps: ONBOARDING_STEP_ORDER.map((step) => {
        const row = stepRows.find((s) => s.step === step);
        return {
          step,
          visited: row !== undefined,
          completedAt: row?.completedAt?.toISOString() ?? null,
        };
      }),
      completedAt: orgProfile?.completedAt?.toISOString() ?? null,
      profile: {
        careContextIds: toIds(orgProfile?.careContexts ?? []),
        careContextCodes: toIds(orgProfile?.careContexts ?? []).flatMap((id) => {
          const code = contextCode.get(id);
          return code ? [code] : [];
        }),
        modules: (orgProfile?.modules ?? []).map((m) => m.module as ClinicModule),
      },
      branchProfiles: profiles
        .filter((p) => p.branchId !== null)
        .map((p) => ({
          branchId: p.branchId as string,
          branchName: branchRows.find((b) => b.id === p.branchId)?.name ?? '',
          careContextIds: toIds(p.careContexts),
          modules: p.modules.map((m) => m.module as ClinicModule),
        })),
      entitledModules: await entitledModules(tx, ctx.organizationId),
      careContextOptions: careContexts.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        description: c.description,
        isOwn: c.organizationId !== null,
      })),
      identity: {
        legalName: organization.legalName,
        displayName: organization.displayName,
        orgType: organization.orgType,
        facilityKind: orgProfile?.facilityKind ?? 'CLINIC',
        countryCode: organization.countryCode,
        regionCode: organization.regionCode,
      },
      branches: branchRows.map((b) => ({
        id: b.id,
        name: b.name,
        isPrimary: b.isPrimary,
        timezone: b.timezone,
        timeFormat: formats.get(b.id) === '24H' ? ('24H' as const) : ('12H' as const),
        slotMinutes: Number(slots.get(b.id) ?? 15) || 15,
        operatingHours: b.operatingHours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          // `@db.Time(0)` comes back as a 1970 Date; the wire carries `HH:MM`.
          opensAt: h.opensAt.toISOString().slice(11, 16),
          closesAt: h.closesAt.toISOString().slice(11, 16),
          isClosed: h.isClosed,
          slotMinutes: h.slotMinutes,
        })),
      })),
      billing: {
        invoicePrefix: String(billingValue.get('billing.invoice_prefix') ?? 'INV'),
        defaultTaxPercent: asNumber('billing.default_tax_percent', 0),
        financialYearStartMonth: asNumber('billing.financial_year_start_month', 4),
        cashRoundingMinor: asNumber('billing.cash_rounding_minor', 1),
        hasTaxRegistration,
      },
      invitableRoles: roles,
      pendingInvitationCount: invitations,
    };
  });
}

// -- steps -------------------------------------------------------------------

/** Step 1 — who you are. Writes `organizations`; seeds no settings. */
export async function saveIdentityStep(
  ctx: TenantContext,
  input: IdentityStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.organization.findFirstOrThrow({
      where: { id: ctx.organizationId },
      select: {
        legalName: true,
        displayName: true,
        orgType: true,
        countryCode: true,
        regionCode: true,
      },
    });

    await tx.organization.update({
      where: { id: ctx.organizationId },
      data: {
        legalName: input.legalName,
        displayName: input.displayName,
        orgType: input.orgType,
        countryCode: input.countryCode,
        regionCode: input.regionCode ?? null,
      },
    });

    const profile = await profileFor(tx, ctx.organizationId, null);
    await tx.clinicProfile.update({
      where: { id: profile.id },
      data: { facilityKind: input.facilityKind },
    });

    /*
     * The primary branch's type follows the facility kind — a solo vet practice
     * whose organization is a CLINIC has a branch that is a CLINIC too. Only the
     * PRIMARY branch: a group's other sites are set up individually, and
     * overwriting them here would retype a pharmacy site as a hospital because
     * somebody re-ran step 1.
     */
    await tx.branch.updateMany({
      where: { organizationId: ctx.organizationId, isPrimary: true, deletedAt: null },
      data: { branchType: input.facilityKind },
    });

    await markStep(tx, ctx, 'IDENTITY');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile',
      entityId: profile.id,
      before: { ...before, step: 'IDENTITY' },
      after: { ...input, step: 'IDENTITY' },
      ...options,
    });
  });
}

/**
 * Step 2 — who you treat. The step this whole feature exists for.
 *
 * Replaces the scope's care contexts wholesale and seeds
 * `patient.default_subject_type` from them when — and only when — there is
 * exactly one. Two contexts means the front desk is asked, so there is no
 * default to seed.
 */
export async function saveCareContextStep(
  ctx: TenantContext,
  input: CareContextStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  const branchId = assertBranchInScope(ctx, input.branchId);

  await withTenant(ctx, async (tx) => {
    /*
     * ⚠️ EVERY ID MUST BE A `CARE_CONTEXT` NODE THIS TENANT CAN SEE. The FK
     *   alone is not enough: it is a PLAIN foreign key into `specialties`, which
     *   is platform-extensible, so it would happily accept a SPECIALTY id or —
     *   were the RESTRICTIVE `specialty_visible` policy ever dropped — another
     *   tenant's private node. Checking the type here is what stops a clinic
     *   declaring itself to work in "Interventional Cardiology" and breaking
     *   every template resolution downstream.
     */
    const found = await tx.specialty.findMany({
      where: { id: { in: input.careContextIds }, type: 'CARE_CONTEXT', deletedAt: null },
      select: { id: true, code: true },
    });
    if (found.length !== input.careContextIds.length) {
      throw new ValidationError('Every care context must be one this clinic can use.');
    }

    const profile = await profileFor(tx, ctx.organizationId, branchId);

    const before = await tx.clinicProfileCareContext.findMany({
      where: { organizationId: ctx.organizationId, profileId: profile.id },
      select: { specialtyId: true },
    });

    await tx.clinicProfileCareContext.deleteMany({
      where: { organizationId: ctx.organizationId, profileId: profile.id },
    });
    await tx.clinicProfileCareContext.createMany({
      data: found.map((c) => ({
        organizationId: ctx.organizationId,
        profileId: profile.id,
        // ⚠️ A COPY OF THE PARENT'S branch_id — the FK cannot enforce it, and
        //   `branch_isolation` names this column. See the model comment.
        branchId,
        specialtyId: c.id,
      })),
    });

    /*
     * ⚠️ SEEDED ONLY WHEN THERE IS EXACTLY ONE CONTEXT, AND THIS IS THE ENTIRE
     *   PET-CLINIC FEATURE. One context means nobody is ever asked, so a default
     *   must exist. Two or more means the picker appears and the default is only
     *   what it starts on — seeding it then would be harmless, but it would also
     *   be a value the clinic never chose appearing in their settings screen
     *   attributed to them.
     */
    const seeded =
      found.length === 1 && found[0] && SUBJECT_TYPE_FOR_CARE_CONTEXT[found[0].code]
        ? await seedSettings(tx, [
            {
              key: 'patient.default_subject_type',
              scopeType: branchId ? 'BRANCH' : 'ORGANIZATION',
              scopeId: branchId ?? ctx.organizationId,
              value: SUBJECT_TYPE_FOR_CARE_CONTEXT[found[0].code] as string,
              userId: ctx.userId,
            } satisfies SeedSettingInput,
          ])
        : {};

    await markStep(tx, ctx, 'CARE_CONTEXTS');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile_care_contexts',
      entityId: profile.id,
      before: { careContextIds: before.map((c) => c.specialtyId) },
      after: { careContextIds: found.map((c) => c.id), seeded },
      ...(branchId ? { branchId } : {}),
      ...options,
    });
  });
}

/**
 * Step 3 — what you run.
 *
 * ⚠️ AN UNENTITLED MODULE IS REFUSED, AND THE STATUS MATTERS. `ValidationError`
 *   (400) — never a 403, because "your plan does not include Pharmacy" and "you
 *   may not dispense" are different sentences said to different people, and
 *   answering the first with a permission status sends the clinic to their
 *   administrator instead of to billing.
 *
 *   ⚠️ AND NEVER A 422, WHICH IS WHAT THIS SHAPE OF REFUSAL FIRST SUGGESTS. In
 *     this API 422 means "the rules of this JURISDICTION refuse it" and carries
 *     rule codes and a regulator's own sentence — `RegulatoryRefusalError`, read
 *     that way by every dispensing screen. A commercial limit borrowing it would
 *     make one status mean both "the law refuses" and "your plan refuses", which
 *     no client can disambiguate. If a plan refusal ever needs its own status,
 *     it needs its own entry in `ERROR_CASES` first.
 */
export async function saveModuleStep(
  ctx: TenantContext,
  input: ModuleStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  const branchId = assertBranchInScope(ctx, input.branchId);

  await withTenant(ctx, async (tx) => {
    const allowed = new Set(await entitledModules(tx, ctx.organizationId));
    const refused = input.modules.filter((m) => !allowed.has(m));
    if (refused.length > 0) {
      const labels = refused.map((m) => CLINIC_MODULES.find((c) => c.key === m)?.label ?? m);
      throw new ValidationError(
        `Your plan does not include ${labels.join(', ')}. Change your plan to switch it on.`
      );
    }

    const profile = await profileFor(tx, ctx.organizationId, branchId);

    const before = await tx.clinicProfileModule.findMany({
      where: { organizationId: ctx.organizationId, profileId: profile.id },
      select: { module: true },
    });

    await tx.clinicProfileModule.deleteMany({
      where: { organizationId: ctx.organizationId, profileId: profile.id },
    });
    await tx.clinicProfileModule.createMany({
      data: input.modules.map((module) => ({
        organizationId: ctx.organizationId,
        profileId: profile.id,
        branchId,
        module,
      })),
    });

    /*
     * Pharmacy brings two thresholds that a clinic running a counter needs
     * answers to on day one, and that a clinic without one should never be asked
     * about. Seeded at the ORGANIZATION scope even for a branch override: an
     * expiry alert window is how the group practises, and the branch step is
     * about WHICH SITES run a pharmacy, not about giving each one its own
     * dispensing policy.
     */
    const seeded = input.modules.includes('PHARMACY')
      ? await seedSettings(tx, [
          {
            key: 'inventory.expiry_alert_days',
            scopeType: 'ORGANIZATION',
            scopeId: ctx.organizationId,
            value: 90,
            userId: ctx.userId,
          },
          {
            key: 'inventory.batch_selection_strategy',
            scopeType: 'ORGANIZATION',
            scopeId: ctx.organizationId,
            value: 'FEFO',
            userId: ctx.userId,
          },
        ])
      : {};

    await markStep(tx, ctx, 'MODULES');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile_modules',
      entityId: profile.id,
      before: { modules: before.map((m) => m.module) },
      after: { modules: input.modules, seeded },
      ...(branchId ? { branchId } : {}),
      ...options,
    });
  });
}

/**
 * Step 4 — when you're open.
 *
 * ⚠️ TWO TRANSACTIONS, DELIBERATELY. `setOperatingHours` is the existing,
 *   audited, validated way to write a branch's week — it refuses a duplicate
 *   day and a zero-length shift — and calling it is better than a second
 *   implementation inside one transaction. If the seeding below then fails, the
 *   hours are saved and the step is not marked; pressing save again is correct
 *   and writes the same rows.
 */
export async function saveLocaleStep(
  ctx: TenantContext,
  input: LocaleStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  const branchId = assertBranchInScope(ctx, input.branchId);
  if (branchId === null) throw new NotFoundError('Branch');

  await setOperatingHours(ctx, branchId, input.operatingHours, options);

  await withTenant(ctx, async (tx) => {
    const before = await tx.branch.findFirstOrThrow({
      where: { id: branchId },
      select: { timezone: true },
    });

    // A zone is a COLUMN on the branch, not a setting — every stored instant is
    // UTC and this is what renders it. See CLAUDE.md invariant 6.
    await tx.branch.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
      data: { timezone: input.timezone },
    });

    const seeded = await seedSettings(tx, [
      {
        key: 'locale.time_format',
        scopeType: 'BRANCH',
        scopeId: branchId,
        value: input.timeFormat,
        userId: ctx.userId,
      },
      {
        key: 'appointment.slot_minutes',
        scopeType: 'BRANCH',
        scopeId: branchId,
        value: input.slotMinutes,
        userId: ctx.userId,
      },
    ]);

    await markStep(tx, ctx, 'LOCALE_HOURS');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'branch',
      entityId: branchId,
      before: { timezone: before.timezone },
      after: { timezone: input.timezone, seeded },
      branchId,
      ...options,
    });
  });
}

/**
 * Step 5 — how you bill.
 *
 * ⚠️ THE REGISTRATION IS THE CLINIC AS AN ISSUER, NOT AS RCLN'S CUSTOMER.
 *   `createClinicTaxRegistration` writes `issuer_tax_registrations` — the number
 *   printed on the invoices this clinic raises against its own patients.
 *   `organizations.tax_id` is the other fact, and it is DERIVED from these rows
 *   by `syncOrganizationTaxIdentity` rather than typed. This step must never
 *   write it directly, or a clinic ends up billing under a number its own
 *   settings screen disagrees with.
 */
export async function saveTaxStep(
  ctx: TenantContext,
  input: TaxStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  // Its own transaction, and its own audit row. See the file header.
  if (input.taxRegistration) {
    await createClinicTaxRegistration(ctx, input.taxRegistration, options);
  }

  await withTenant(ctx, async (tx) => {
    const toSeed: SeedSettingInput[] = [];
    const at = (key: string, value: string | number | undefined): void => {
      if (value === undefined) return;
      toSeed.push({
        key,
        scopeType: 'ORGANIZATION',
        scopeId: ctx.organizationId,
        value,
        userId: ctx.userId,
      });
    };

    at('billing.invoice_prefix', input.invoicePrefix);
    at('billing.default_tax_percent', input.defaultTaxPercent);
    at('billing.financial_year_start_month', input.financialYearStartMonth);
    at('billing.cash_rounding_minor', input.cashRoundingMinor);

    const seeded = await seedSettings(tx, toSeed);

    await markStep(tx, ctx, 'TAX_BILLING');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile',
      entityId: ctx.organizationId,
      after: { step: 'TAX_BILLING', seeded, taxRegistrationAdded: Boolean(input.taxRegistration) },
      ...options,
    });
  });
}

/**
 * Step 6 — who works here.
 *
 * ⚠️ EACH INVITATION IS ITS OWN TRANSACTION, INSIDE `createInvitation`, WHICH
 *   ALSO SENDS THE EMAIL AND WRITES ITS OWN AUDIT ROW. That means a partial
 *   failure leaves some invitations sent and some not — and re-running the step
 *   would send the sent ones twice, which is why the screen submits the list it
 *   has not yet sent rather than the whole table. An invitation is not
 *   idempotent in the way a setting is: a duplicate is an email a real person
 *   receives.
 */
export async function saveStaffStep(
  ctx: TenantContext,
  input: StaffStepRequest,
  options: OnboardingActionOptions = {}
): Promise<void> {
  for (const invitation of input.invitations) {
    await createInvitation(ctx, invitation, options);
  }

  await withTenant(ctx, async (tx) => {
    await markStep(tx, ctx, 'STAFF');
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile',
      entityId: ctx.organizationId,
      after: { step: 'STAFF', invitationsSent: input.invitations.length },
      ...options,
    });
  });
}

/**
 * The review step — the one authority on "setup is done".
 *
 * ⚠️ IT DOES NOT REQUIRE EVERY OTHER STEP TO BE COMPLETE, AND THAT IS
 *   DELIBERATE. A clinic with no tax registration and no staff to invite has
 *   genuinely finished; refusing to let them out of the wizard until they
 *   invent an answer is how a setup flow becomes something people work around.
 *   The review screen shows what is unanswered and lets them finish anyway.
 */
export async function completeOnboarding(
  ctx: TenantContext,
  options: OnboardingActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const profile = await profileFor(tx, ctx.organizationId, null);

    await tx.clinicProfile.update({
      where: { id: profile.id },
      data: { completedAt: new Date(), completedByUserId: ctx.userId },
    });

    await markStep(tx, ctx, 'REVIEW');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinic_profile',
      entityId: profile.id,
      after: { setupComplete: true },
      ...options,
    });
  });
}
