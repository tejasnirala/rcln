/**
 * What a clinic asserts a product IS, in one jurisdiction, on a date.
 *
 * ⚠️ AN ASSERTION IS NOT AN AUTHORISATION, AND NOTHING MAY GATE A DISPENSE ON A
 *   ROW IN THIS TABLE. A profile is an INPUT to `evaluate()`: it supplies the
 *   classification a rule matches on, and the rules decide. A jurisdiction with
 *   no `PRESCRIPTION_REQUIRED` rule refuses however confidently the profile
 *   says `PRESCRIPTION_REQUIRED`, because a clinic's opinion about the law is
 *   not the law.
 *
 * ⚠️ AND NO ROW IS NOT A PERMISSION. A product with no profile for the
 *   jurisdiction resolves `UNDETERMINED`, which refuses. Almost every
 *   clinic-created product starts there; the screen explains it rather than
 *   hiding it.
 *
 * Shaped as replace-all, exactly like `replaceTaxClassifications` beside it, and
 * the overlap check is the same check for the same reason — see below.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ProductRegulatoryProfileDetail,
  ReplaceProductRegulatoryProfilesRequest,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import {
  calendarToday,
  isCurrentOn,
  startOfCalendarDay,
  toCalendarDate,
} from '../product/values.js';
import { jurisdictionLabel } from './shared.js';

interface ProfileRow {
  id: string;
  jurisdictionId: string;
  registrationNumber: string | null;
  registrationStatus: string;
  classification: string | null;
  controlledSchedule: string | null;
  prescriptionRequirement: string;
  onlineSalePosition: string;
  dispensingNotes: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  jurisdiction: { countryCode: string; regionCode: string | null; name: string };
}

function toDetail(row: ProfileRow, on: Date): ProductRegulatoryProfileDetail {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    jurisdictionLabel: jurisdictionLabel(row.jurisdiction),
    jurisdictionName: row.jurisdiction.name,
    registrationNumber: row.registrationNumber,
    registrationStatus:
      row.registrationStatus as ProductRegulatoryProfileDetail['registrationStatus'],
    classification: row.classification,
    controlledSchedule: row.controlledSchedule,
    prescriptionRequirement:
      row.prescriptionRequirement as ProductRegulatoryProfileDetail['prescriptionRequirement'],
    onlineSalePosition:
      row.onlineSalePosition as ProductRegulatoryProfileDetail['onlineSalePosition'],
    dispensingNotes: row.dispensingNotes,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
    isLive: row.effectiveFrom.getTime() <= on.getTime() && isCurrentOn(row.effectiveTo, on),
  };
}

/** The read, INSIDE a caller's transaction — see `readPackagings` for why. */
async function readProfiles(
  tx: TxClient,
  productId: string
): Promise<ProductRegulatoryProfileDetail[]> {
  const rows = await tx.productRegulatoryProfile.findMany({
    where: { productId },
    // RLS is the guarantee; the composite FK makes a cross-tenant row
    // unreachable anyway. See `replaceRegulatoryProfiles` for where the explicit
    // organization scope is added as ADR-0005's second layer — it matters most
    // on the DELETE, and least here.
    orderBy: [{ effectiveFrom: 'desc' }],
    include: {
      jurisdiction: { select: { countryCode: true, regionCode: true, name: true } },
    },
  });
  const today = calendarToday();
  return rows.map((row) => toDetail(row, today));
}

export async function listRegulatoryProfiles(
  ctx: TenantContext,
  productId: string
): Promise<ProductRegulatoryProfileDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    return readProfiles(tx, productId);
  });
}

export async function replaceRegulatoryProfiles(
  ctx: TenantContext,
  productId: string,
  input: ReplaceProductRegulatoryProfilesRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductRegulatoryProfileDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (product.organizationId === null) {
      throw new ValidationError(
        'This product is part of the platform catalogue. Copy it into your own catalogue before recording its regulatory position.'
      );
    }

    assertNoOverlap(input.profiles);

    /*
     * ⚠️ THE JURISDICTIONS ARE CHECKED, NOT TRUSTED. `jurisdictions` is platform
     *   data with no policy, so a bad id here would surface as a raw foreign-key
     *   error rather than a sentence — and the caller cannot tell a typo from a
     *   jurisdiction rcln has not created yet, which is exactly the state PI-6
     *   onwards will leave for most countries.
     */
    const jurisdictionIds = [...new Set(input.profiles.map((p) => p.jurisdictionId))];
    const known = await tx.jurisdiction.findMany({
      where: { id: { in: jurisdictionIds } },
      select: { id: true },
    });
    if (known.length !== jurisdictionIds.length) {
      throw new ValidationError(
        'One of those jurisdictions does not exist. Pick one from the list — jurisdictions are maintained by rcln, not per clinic.'
      );
    }

    const before = await tx.productRegulatoryProfile.count({
      where: { productId, organizationId: product.organizationId },
    });

    /*
     * ⚠️ ORGANIZATION-SCOPED EXPLICITLY, NOT ONLY BY RLS (ADR-0005's second
     *   layer). `tenant_isolation` is read-PERMISSIVE on this table — a platform
     *   row is visible to every tenant — so an unscoped `deleteMany` asks to
     *   delete rows this clinic can SEE but does not OWN. The
     *   `platform_rows_immutable` trigger would raise rather than let it
     *   through, and the composite FK means a tenant product can never have
     *   platform profiles in the first place, so this is the third layer on a
     *   door already shut twice. It costs one predicate.
     */
    await tx.productRegulatoryProfile.deleteMany({
      where: { productId, organizationId: product.organizationId },
    });
    await tx.productRegulatoryProfile.createMany({
      data: input.profiles.map((p) => ({
        organizationId: product.organizationId,
        productId,
        jurisdictionId: p.jurisdictionId,
        registrationNumber: p.registrationNumber ?? null,
        registrationStatus: p.registrationStatus,
        classification: p.classification ?? null,
        controlledSchedule: p.controlledSchedule ?? null,
        prescriptionRequirement: p.prescriptionRequirement,
        onlineSalePosition: p.onlineSalePosition,
        dispensingNotes: p.dispensingNotes ?? null,
        effectiveFrom: startOfCalendarDay(new Date(p.effectiveFrom)),
        effectiveTo: p.effectiveTo ? startOfCalendarDay(new Date(p.effectiveTo)) : null,
      })),
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product_regulatory_profile',
      entityId: productId,
      before: { profiles: before },
      after: {
        profiles: input.profiles.length,
        /*
         * The assertions themselves, because "who changed this product from
         * OTC to Schedule H, and when" is the question an inspection asks —
         * and it is asked of the clinic, not of rcln.
         */
        positions: input.profiles.map(
          (p) => `${p.jurisdictionId}:${p.classification ?? '-'}:${p.prescriptionRequirement}`
        ),
      },
      ...options,
    });

    return readProfiles(tx, productId);
  });
}

/**
 * Two profiles for one jurisdiction may not cover the same day.
 *
 * ⚠️ THE UNIQUE INDEX DOES NOT CATCH THIS — it keys on `effective_from`, so two
 *   rows starting on different days and overlapping in the middle are perfectly
 *   legal to Postgres. The resolver would then have two candidates and take
 *   whichever sorted first, so a product would be Schedule H this week and
 *   general sale next week with nothing in the data saying why. Identical
 *   reasoning, and identical shape, to `assertNoOverlap` in
 *   tax-classification.service.ts.
 */
function assertNoOverlap(profiles: ReplaceProductRegulatoryProfilesRequest['profiles']): void {
  const byJurisdiction = new Map<string, { from: string; to: string | null }[]>();

  for (const profile of profiles) {
    if (profile.effectiveTo && profile.effectiveTo < profile.effectiveFrom) {
      throw new ValidationError(
        'A regulatory profile ends before it starts, so it would never apply.'
      );
    }

    const windows = byJurisdiction.get(profile.jurisdictionId) ?? [];
    for (const existing of windows) {
      // Half-open comparison on ISO dates, which sort lexically.
      const overlaps =
        (existing.to === null || profile.effectiveFrom <= existing.to) &&
        (profile.effectiveTo == null || existing.from <= profile.effectiveTo);
      if (overlaps) {
        throw new ValidationError(
          'Two regulatory profiles for the same jurisdiction overlap. End one before the other ' +
            'begins — otherwise which classification applies depends on the order rows come back in.'
        );
      }
    }

    windows.push({ from: profile.effectiveFrom, to: profile.effectiveTo ?? null });
    byJurisdiction.set(profile.jurisdictionId, windows);
  }
}
