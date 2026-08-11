/**
 * Product identifiers, and the resolver that turns a scanned value into a
 * product.
 *
 * ── UNIQUENESS IS QUALIFIED, AND A GLOBAL UNIQUE WOULD BE A BUG ──────────────
 * A GTIN is globally unique in principle and routinely is not in practice:
 * repackagers reuse them, and two countries assign the same national code to
 * different medicines. So the key is (tenant, type, value, country) and NOT
 * (value) — a global unique here would make a legitimate catalogue unimportable
 * while asserting something untrue.
 *
 * ⚠️ WHICH IS WHY `resolveIdentifier` RETURNS EVERY MATCH, NOT THE FIRST.
 *   Answering with one row would dispense whichever the planner happened to
 *   return. That is a patient-safety defect dressed as a convenience, and it
 *   would be invisible in testing because a demo catalogue has no collisions.
 *   The caller disambiguates, or refuses.
 *
 * ── EFFECTIVE DATES, BECAUSE IDENTIFIERS ARE REASSIGNED ──────────────────────
 * A GTIN that moves to a new presentation must still resolve for stock received
 * under it, so an old identifier is expired rather than deleted. The resolver
 * excludes expired rows by default; history keeps them.
 *
 * PI-23 builds the GS1/DataMatrix decode layer ON TOP of this — a scan carrying
 * GTIN + lot + expiry + serial resolves to a product AND a batch AND a serial.
 * This layer answers only the product half, and deliberately does not try to
 * parse anything.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type {
  CreateProductIdentifierRequest,
  ProductIdentifierDetail,
  ResolveIdentifierQuery,
  ResolveIdentifierResponse,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';
import { calendarToday, isCurrentOn, toCalendarDate } from './values.js';

function toDetail(row: {
  id: string;
  type: ProductIdentifierDetail['type'];
  value: string;
  countryCode: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isPrimary: boolean;
}): ProductIdentifierDetail {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    countryCode: row.countryCode,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
    isPrimary: row.isPrimary,
    isCurrent: isCurrentOn(row.effectiveTo),
  };
}

export async function listIdentifiers(
  ctx: TenantContext,
  productId: string
): Promise<ProductIdentifierDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    const rows = await tx.productIdentifier.findMany({
      where: { productId },
      orderBy: [{ type: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return rows.map(toDetail);
  });
}

export async function addIdentifier(
  ctx: TenantContext,
  productId: string,
  input: CreateProductIdentifierRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductIdentifierDetail> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (product.organizationId === null) {
      throw new ValidationError(
        'This product is part of the platform catalogue. Copy it into your own catalogue before adding identifiers.'
      );
    }

    if (input.effectiveTo && input.effectiveFrom && input.effectiveTo < input.effectiveFrom) {
      throw new ValidationError('The end date cannot be before the start date.');
    }

    /*
     * A duplicate within this tenant is refused with a message rather than left
     * to the unique index, whose error names a constraint. Checked across the
     * whole tenant rather than within the product, because the SAME value under
     * the SAME type pointing at TWO of a clinic's own products is precisely the
     * collision that makes a scan ambiguous — and unlike the cross-tenant case,
     * this one the clinic can fix.
     */
    const clash = await tx.productIdentifier.findFirst({
      where: {
        organizationId: ctx.organizationId,
        type: input.type,
        value: input.value,
        countryCode: input.countryCode ?? null,
      },
      select: { id: true, productId: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.productId === productId
          ? 'This product already carries that identifier.'
          : 'Another of your products already carries that identifier. A scan of it would be ambiguous.'
      );
    }

    const created = await tx.productIdentifier.create({
      data: {
        organizationId: product.organizationId,
        productId,
        type: input.type,
        value: input.value,
        countryCode: input.countryCode ?? null,
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: new Date(input.effectiveFrom) }
          : {}),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        isPrimary: input.isPrimary,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'product_identifier',
      entityId: created.id,
      after: { productId, type: input.type, value: input.value, countryCode: input.countryCode },
      ...options,
    });

    return toDetail(created);
  });
}

/**
 * Expire an identifier. NOT a delete, unless it never applied at all.
 *
 * ⚠️ `effective_to` RATHER THAN A ROW REMOVAL, because stock received under this
 *   identifier must keep resolving. Deleting it would orphan the traceability
 *   chain from a GRN back to what was actually scanned at the loading bay.
 */
export async function expireIdentifier(
  ctx: TenantContext,
  productId: string,
  identifierId: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.productIdentifier.findUnique({ where: { id: identifierId } });
    if (!existing || existing.productId !== productId) throw new NotFoundError('Identifier');

    if (existing.organizationId === null) {
      throw new ValidationError('Platform identifiers cannot be changed.');
    }

    /*
     * ⚠️ `effectiveTo` IS INCLUSIVE, SO EXPIRING IT TODAY LEAVES IT VALID TODAY.
     *   That is the intended behaviour, not an oversight: a code withdrawn part
     *   way through a working day must still scan for the stock already on the
     *   shelf and the labels already printed. It stops being current tomorrow.
     *
     *   `calendarToday()` rather than `new Date()` because the column is
     *   `@db.Date`. Handing it an instant relies on Prisma to truncate, and the
     *   truncated value would be the UTC day — so an expiry recorded at 01:00
     *   in Kolkata would be stamped with YESTERDAY's date and the identifier
     *   would already be expired the moment it was written.
     */
    await tx.productIdentifier.update({
      where: { id: identifierId },
      data: { effectiveTo: calendarToday(), isPrimary: false },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product_identifier',
      entityId: identifierId,
      before: { value: existing.value, effectiveTo: existing.effectiveTo },
      after: { expired: true },
      ...options,
    });
  });
}

/**
 * Resolve a scanned or typed value to the product(s) carrying it.
 *
 * The read PI-23's scanner UX is built on, and the hottest endpoint in the
 * programme once it lands. Index-only on
 * `product_identifiers (organization_id, type, value)`.
 *
 * Expired identifiers are excluded: resolving to a product whose GTIN moved on
 * two years ago is worse than resolving to nothing, because it looks right.
 */
export async function resolveIdentifier(
  ctx: TenantContext,
  query: ResolveIdentifierQuery
): Promise<ResolveIdentifierResponse> {
  return withTenant(ctx, async (tx) => {
    /*
     * A CALENDAR DAY, not an instant. `effective_from`/`effective_to` are
     * `@db.Date`, so comparing them against `new Date()` compares a day against
     * a moment: `effectiveTo: { gte: now }` excluded a row on its own final
     * valid day from midnight onwards. A barcode that stops scanning a day early
     * presents as one unreproducible failure at a counter.
     */
    const today = calendarToday();

    /*
     * ⚠️ TWO `OR` GROUPS, SO THEY GO IN `AND`. THEY CANNOT BOTH BE `OR:` KEYS.
     *   An object literal takes the LAST value for a repeated key, and a spread
     *   counts — `{ ...(cond ? { OR: a } : {}), OR: b }` is just `{ OR: b }`.
     *   Neither TypeScript nor eslint says a word.
     *
     *   Here that meant the country group vanished and this endpoint matched a
     *   barcode against EVERY country's identifiers. National codes legitimately
     *   collide across countries — that is why the column exists — so a scan at
     *   an Indian counter could resolve to the medicine that code belongs to in
     *   the US. Wrong-product-from-a-barcode is the failure this whole endpoint
     *   exists to prevent.
     */
    const rows = await tx.productIdentifier.findMany({
      where: {
        value: query.value,
        ...(query.type !== undefined ? { type: query.type } : {}),
        effectiveFrom: { lte: today },
        product: { deletedAt: null },
        AND: [
          /*
           * A country-qualified search still matches identifiers recorded with
           * NO country — those are valid everywhere, which is what NULL means
           * here. Omitting the NULL branch would drop every platform GTIN, i.e.
           * most of the catalogue, for any caller that passed a country.
           */
          ...(query.countryCode !== undefined
            ? [{ OR: [{ countryCode: query.countryCode }, { countryCode: null }] }]
            : []),
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
        ],
      },
      include: {
        product: {
          include: {
            category: { select: { name: true } },
            manufacturer: { select: { name: true } },
            baseUnit: { select: { symbol: true } },
          },
        },
      },
      // A clinic's own row before a platform row: if both resolve, the one the
      // clinic curated is the one it means.
      orderBy: [{ organizationId: 'desc' }, { isPrimary: 'desc' }],
      take: 25,
    });

    return {
      matches: rows.flatMap((row) => {
        const p = row.product;
        // `product` is optional in the generated types because the composite FK
        // has a nullable component (see products.prisma); it is never actually
        // absent, and flatMap drops the impossible case without a non-null
        // assertion — this repository does not allow `!`.
        if (!p) return [];
        return [
          {
            product: {
              id: p.id,
              code: p.code,
              name: p.name,
              type: p.type,
              status: p.status,
              brandName: p.brandName,
              genericName: p.genericName,
              categoryId: p.categoryId,
              categoryName: p.category?.name ?? null,
              manufacturerId: p.manufacturerId,
              manufacturerName: p.manufacturer?.name ?? null,
              baseUnitId: p.baseUnitId,
              baseUnitSymbol: p.baseUnit.symbol,
              trackingMode: p.trackingMode,
              isExpiryControlled: p.isExpiryControlled,
              isStockItem: p.isStockItem,
              isOwn: p.organizationId !== null,
            },
            identifier: toDetail(row),
          },
        ];
      }),
    };
  });
}
