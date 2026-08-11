/**
 * What tax category a product falls into, per jurisdiction, per date.
 *
 * ⚠️ THIS FILE WRITES NO TAX LOGIC, AND THAT IS THE WHOLE DESIGN (PI-ADR-006).
 *   It resolves a `taxCategory` STRING and stops. That string keys `tax_rules`
 *   by exact match, and `@rcln/tax` — already country-generic, effective-dated,
 *   tested, and holding the CGST/SGST split and the `TaxProviderQuote` seam —
 *   does everything after it.
 *
 *   No rate is computed here. No line is split. No label is formatted. There is
 *   no `if (country === 'IN')` in this domain, and adding one would mean two
 *   answers to what a clinic charges, only one of which the invoice engine
 *   knows about.
 *
 * ── `taxCategory` AND `itemCode` ARE DIFFERENT THINGS ────────────────────────
 * `taxCategory` is the LOOKUP KEY. `itemCode` is the PRINTED code — HSN in
 * India, SAC for services, a commodity code elsewhere. `invoice_items` already
 * carries them as separate columns for exactly this reason, so the brief's
 * requirement that HSN must not be the universal product identifier is satisfied
 * upstream. Do not "simplify" them into one.
 *
 * ── RESOLVING TO NULL IS AN ANSWER ───────────────────────────────────────────
 * A product with no classification for a jurisdiction returns `null`, and the
 * invoice engine's existing refusal to issue an `UNRATED` line surfaces it. That
 * is the honest failure: a guessed tax category is a confident wrong number on a
 * legal document, and it looks completely plausible.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ProductTaxClassificationDetail,
  ReplaceProductTaxClassificationsRequest,
  ResolvedTaxCategoryResponse,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';
import { startOfCalendarDay, toCalendarDate } from './values.js';

function toDetail(row: {
  id: string;
  countryCode: string;
  regionCode: string | null;
  taxCategory: string;
  itemCode: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): ProductTaxClassificationDetail {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    taxCategory: row.taxCategory,
    itemCode: row.itemCode,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
  };
}

/**
 * The read, INSIDE a caller's transaction — see `readPackagings` in
 * `packaging.service.ts` for why the write path must not open a second one.
 */
async function readTaxClassifications(
  tx: TxClient,
  productId: string
): Promise<ProductTaxClassificationDetail[]> {
  const rows = await tx.productTaxClassification.findMany({
    where: { productId },
    orderBy: [{ countryCode: 'asc' }, { effectiveFrom: 'desc' }],
  });
  return rows.map(toDetail);
}

export async function listTaxClassifications(
  ctx: TenantContext,
  productId: string
): Promise<ProductTaxClassificationDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    return readTaxClassifications(tx, productId);
  });
}

export async function replaceTaxClassifications(
  ctx: TenantContext,
  productId: string,
  input: ReplaceProductTaxClassificationsRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductTaxClassificationDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (product.organizationId === null) {
      throw new ValidationError(
        'This product is part of the platform catalogue. Copy it into your own catalogue before classifying it for tax.'
      );
    }

    assertNoOverlap(input.classifications);

    const before = await tx.productTaxClassification.count({ where: { productId } });

    await tx.productTaxClassification.deleteMany({ where: { productId } });
    await tx.productTaxClassification.createMany({
      data: input.classifications.map((c) => ({
        organizationId: product.organizationId,
        productId,
        countryCode: c.countryCode,
        regionCode: c.regionCode ?? null,
        taxCategory: c.taxCategory,
        itemCode: c.itemCode ?? null,
        effectiveFrom: new Date(c.effectiveFrom),
        effectiveTo: c.effectiveTo ? new Date(c.effectiveTo) : null,
      })),
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product_tax_classification',
      entityId: productId,
      before: { classifications: before },
      after: {
        classifications: input.classifications.length,
        // The categories themselves, because "who changed this product from
        // GST_5 to GST_12 and when" is the question an audit of a tax dispute
        // actually asks.
        categories: input.classifications.map((c) => `${c.countryCode}:${c.taxCategory}`),
      },
      ...options,
    });

    return readTaxClassifications(tx, productId);
  });
}

/**
 * Two classifications for the same jurisdiction may not cover the same day.
 *
 * ⚠️ THE UNIQUE INDEX DOES NOT CATCH THIS. It keys on `effective_from`, so two
 *   rows starting on different days and overlapping in the middle are perfectly
 *   legal to Postgres — and then `resolveTaxCategory` has two candidates and
 *   returns whichever sorts first. The result is a product that is taxed at one
 *   rate this week and another next week with nothing in the data saying why.
 */
function assertNoOverlap(
  classifications: ReplaceProductTaxClassificationsRequest['classifications']
): void {
  const byJurisdiction = new Map<string, { from: string; to: string | null }[]>();

  for (const c of classifications) {
    if (c.effectiveTo && c.effectiveTo < c.effectiveFrom) {
      throw new ValidationError(
        `The ${c.countryCode} classification ends before it starts, so it would never apply.`
      );
    }

    const key = `${c.countryCode}:${c.regionCode ?? ''}`;
    const windows = byJurisdiction.get(key) ?? [];

    for (const existing of windows) {
      // Half-open comparison on ISO dates, which sort lexically.
      const overlaps =
        (existing.to === null || c.effectiveFrom <= existing.to) &&
        (c.effectiveTo === null || c.effectiveTo === undefined || existing.from <= c.effectiveTo);
      if (overlaps) {
        throw new ValidationError(
          `Two ${c.countryCode} tax classifications overlap. End one before the other begins — ` +
            `otherwise which one applies depends on the order rows come back in.`
        );
      }
    }

    windows.push({ from: c.effectiveFrom, to: c.effectiveTo ?? null });
    byJurisdiction.set(key, windows);
  }
}

/**
 * The one function the invoice engine will call.
 *
 * ⚠️ REGION BEATS COUNTRY, AND THAT ORDER IS THE POINT. A state-level rule is
 *   the more specific statement, so it wins for the same date. Sorting the other
 *   way makes every state override silently inert — the country row is always
 *   present, so it always matches first, and the override looks configured.
 *
 * `on` is a calendar date, not an instant: which tax applies is decided by the
 * DAY of supply in the branch's own zone, not by a UTC timestamp.
 */
export async function resolveTaxCategory(
  tx: TxClient,
  productId: string,
  jurisdiction: { countryCode: string; regionCode?: string | null },
  on: Date
): Promise<ResolvedTaxCategoryResponse> {
  /*
   * ⚠️ TWO `OR` GROUPS, SO THEY GO IN `AND`. THEY CANNOT BOTH BE `OR:` KEYS.
   *   An object literal takes the LAST value for a repeated key, and a spread
   *   counts — `{ ...(cond ? { OR: a } : {}), OR: b }` is just `{ OR: b }`. It
   *   is not a type error and it is not a lint error; the region group simply
   *   disappears.
   *
   *   That is not a subtle degradation. Without the region group the query
   *   returns classifications for EVERY region in the country, and the
   *   `regionCode: 'desc'` ordering below then deliberately prefers a non-NULL
   *   region — so a Karnataka branch resolving a product that also carries a
   *   Tamil Nadu row gets the TAMIL NADU tax category, and prints it on a
   *   Karnataka invoice. The bug makes the ordering rule work against us.
   */
  /*
   * `on` arrives as whatever the caller had — often an instant. Both columns are
   * `@db.Date`, so it is flattened to a calendar day before comparison. Without
   * this, `effectiveTo: { gte: on }` drops a classification on its own last
   * valid day, and the query silently falls through to the previous rate.
   */
  const day = startOfCalendarDay(on);

  const rows = await tx.productTaxClassification.findMany({
    where: {
      productId,
      countryCode: jurisdiction.countryCode,
      effectiveFrom: { lte: day },
      AND: [
        jurisdiction.regionCode
          ? { OR: [{ regionCode: jurisdiction.regionCode }, { regionCode: null }] }
          : { regionCode: null },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }] },
      ],
    },
    orderBy: [
      /*
       * Region rows first — and `nulls: 'last'` is REQUIRED to get that.
       *
       * ⚠️ POSTGRES SORTS NULLS **FIRST** ON `DESC`, NOT LAST. The default is
       *   "nulls sort as though larger than any non-null value", which means
       *   NULLS LAST for ASC and NULLS FIRST for DESC. This orderBy previously
       *   carried a comment asserting the opposite and relied on it.
       *
       *   With `take: 1`, that inverted every override on this path: the
       *   country-wide row (region_code NULL) sorted first and always won, so a
       *   state-level tax category could be configured, could be visible in the
       *   UI, and could never be returned. Which is precisely the failure this
       *   file's own header warns about — "the country row is always present, so
       *   it always matches first, and the override looks configured".
       */
      { regionCode: { sort: 'desc', nulls: 'last' } },
      // Then the most recently effective, so a rate change supersedes cleanly.
      { effectiveFrom: 'desc' },
    ],
    take: 1,
  });

  const match = rows[0];
  if (!match) return { taxCategory: null, itemCode: null };

  return { taxCategory: match.taxCategory, itemCode: match.itemCode };
}

/** The HTTP-facing wrapper. Opens its own transaction. */
export async function resolveTaxCategoryForTenant(
  ctx: TenantContext,
  productId: string,
  jurisdiction: { countryCode: string; regionCode?: string | null },
  on: Date
): Promise<ResolvedTaxCategoryResponse> {
  return withTenant(ctx, (tx) => resolveTaxCategory(tx, productId, jurisdiction, on));
}
