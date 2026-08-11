/**
 * Products: the root of the catalogue.
 *
 * ⚠️ NOTHING HERE HAS A QUANTITY, A LOCATION OR A PRICE. A product is a
 *   definition. Where it is and how much exists is `stock_ledger` (PI-2); what
 *   it costs is per payer, per contract and per date, which belongs to billing.
 *   If a function in this file starts needing a stock level, it is in the wrong
 *   file.
 *
 * ── PLATFORM ROWS ARE CLONED, NEVER EDITED ───────────────────────────────────
 * A clinic that wants "Amoxicillin 500 mg, but with our SKU and our pack size"
 * calls `cloneProduct`, which copies the platform row and its children into the
 * tenant's own. It cannot edit the platform row: the RLS WITH CHECK refuses it
 * outright, and `assertMutable` runs first only so the caller gets a sentence.
 *
 * ⚠️ AND THE CLONE IS NOT A CONVENIENCE — IT IS THE ONLY WAY THE CHILDREN CAN
 *   WORK. `product_packagings`, `product_identifiers`,
 *   `product_tax_classifications` and `medicine_details` reach their parent
 *   through the composite FK `(organization_id, product_id)`. A tenant row must
 *   name its own organization_id, so it can only ever point at a product that
 *   also names it — which means a tenant physically cannot attach a packaging to
 *   a platform product. The database makes the design decision unavoidable
 *   rather than merely documented.
 *
 * ── SEARCH IS SERVER-SIDE, ALWAYS ────────────────────────────────────────────
 * A mature catalogue is tens of thousands of rows. Loading it into the browser
 * to filter there works on the demo tenant and fails at exactly the clinics that
 * needed the feature.
 *
 * NO PHI. A product is not a patient — nothing here writes `data_access_logs`.
 * That changes the moment dispensing links a product to a person (PI-ADR-016).
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateProductRequest,
  EquivalentProductsResponse,
  ProductDetail,
  ProductListQuery,
  ProductListResponse,
  ProductSummary,
  UpdateProductRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { categorySubtreeIds } from './category.service.js';
import { packagingFactorToBase, formatQuantity } from './units.js';
import { decimalToString, isCurrentOn, toCalendarDate } from './values.js';
import type { CatalogueActionOptions } from './unit.service.js';

/*
 * ⚠️ `Prisma.validator`, NOT `as const`.
 *
 * `as const` looks like the way to keep an include object precise enough for
 * Prisma to infer the payload from. It makes every nested array READONLY, and
 * Prisma's `orderBy` takes a mutable array — so a multi-key sort fails to
 * compile with an error about readonly tuples that reads as if the sort itself
 * were wrong. Dropping `as const` instead widens `true` to `boolean` and the
 * inferred payload silently loses every included relation.
 *
 * `Prisma.validator` is the tool for exactly this: exact literal types, mutable
 * arrays, and the object is checked against the real `ProductInclude` at the
 * point of definition rather than at the call site.
 */
const summaryInclude = Prisma.validator<Prisma.ProductInclude>()({
  category: { select: { name: true } },
  manufacturer: { select: { name: true } },
  baseUnit: { select: { code: true, symbol: true } },
});

const detailInclude = Prisma.validator<Prisma.ProductInclude>()({
  ...summaryInclude,
  composition: { select: { name: true } },
  storageProfile: { select: { name: true } },
  packagings: {
    include: { unit: { select: { code: true, symbol: true } } },
    orderBy: { level: 'asc' },
  },
  identifiers: { orderBy: [{ type: 'asc' }, { value: 'asc' }] },
  taxClassifications: { orderBy: { effectiveFrom: 'desc' } },
  medicineDetail: true,
});

type ProductWithSummary = Awaited<ReturnType<typeof findProductOrThrow>>;

/*
 * The return type is DELIBERATELY inferred — it is Prisma's payload type for
 * `detailInclude`, and `ProductWithSummary` is derived FROM this signature so
 * adding a field to the include cannot leave `toDetail` describing a shape that
 * no longer arrives. Annotating it by hand freezes exactly what should follow.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function findProductOrThrow(tx: TxClient, id: string) {
  const row = await tx.product.findUnique({ where: { id }, include: detailInclude });
  /*
   * ⚠️ NOT FOUND, NEVER FORBIDDEN, for another tenant's product. RLS has already
   *   filtered it out of the read, so it is genuinely indistinguishable from a
   *   product that does not exist — and a 403 would confirm the id is real to
   *   somebody probing for it.
   */
  if (!row || row.deletedAt) throw new NotFoundError('Product');
  return row;
}

function assertMutable(organizationId: string | null): void {
  if (organizationId === null) {
    throw new ValidationError(
      'This product is part of the platform catalogue and cannot be edited. Copy it into your own catalogue first.'
    );
  }
}

function toSummary(row: {
  id: string;
  organizationId: string | null;
  code: string;
  name: string;
  type: ProductSummary['type'];
  status: ProductSummary['status'];
  brandName: string | null;
  genericName: string | null;
  categoryId: string | null;
  manufacturerId: string | null;
  baseUnitId: string;
  trackingMode: ProductSummary['trackingMode'];
  isExpiryControlled: boolean;
  isStockItem: boolean;
  category: { name: string } | null;
  manufacturer: { name: string } | null;
  baseUnit: { symbol: string };
}): ProductSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    status: row.status,
    brandName: row.brandName,
    genericName: row.genericName,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    manufacturerId: row.manufacturerId,
    manufacturerName: row.manufacturer?.name ?? null,
    baseUnitId: row.baseUnitId,
    baseUnitSymbol: row.baseUnit.symbol,
    trackingMode: row.trackingMode,
    isExpiryControlled: row.isExpiryControlled,
    isStockItem: row.isStockItem,
    isOwn: row.organizationId !== null,
  };
}

function toDetail(row: ProductWithSummary): ProductDetail {
  /*
   * Hoisted out of the packaging map below. Every level's factor is computed
   * from the SAME ladder, so rebuilding it inside the map allocated a fresh copy
   * per row for one identical value. n is capped at 11, so this is tidiness
   * rather than a fix — but the shape reads as if each row had its own ladder,
   * which is the misreading that matters.
   */
  const ladder = row.packagings.map((l) => ({
    level: l.level,
    unitId: l.unitId,
    quantityOfChild: l.quantityOfChild.toString(),
  }));

  return {
    ...toSummary(row),
    description: row.description,
    compositionId: row.compositionId,
    compositionName: row.composition?.name ?? null,
    storageProfileId: row.storageProfileId,
    storageProfileName: row.storageProfile?.name ?? null,
    baseUnitCode: row.baseUnit.code,
    defaultShelfLifeDays: row.defaultShelfLifeDays,
    reorderLevelBase: decimalToString(row.reorderLevelBase),
    reorderQuantityBase: decimalToString(row.reorderQuantityBase),
    packagings: row.packagings.map((p) => ({
      id: p.id,
      level: p.level,
      unitId: p.unitId,
      unitCode: p.unit.code,
      unitSymbol: p.unit.symbol,
      quantityOfChild: p.quantityOfChild.toString(),
      /*
       * Computed here, never stored. A `factor_to_base` column would be a second
       * copy of what the levels already say, and it is the copy that goes stale
       * when somebody edits a level in the middle of the chain.
       */
      quantityInBase: formatQuantity(packagingFactorToBase(ladder, p.level)).quantity,
      isDefaultPurchase: p.isDefaultPurchase,
      isDefaultSale: p.isDefaultSale,
      barcode: p.barcode,
    })),
    identifiers: row.identifiers.map((i) => ({
      id: i.id,
      type: i.type,
      value: i.value,
      countryCode: i.countryCode,
      effectiveFrom: toCalendarDate(i.effectiveFrom),
      effectiveTo: i.effectiveTo ? toCalendarDate(i.effectiveTo) : null,
      isPrimary: i.isPrimary,
      isCurrent: isCurrentOn(i.effectiveTo),
    })),
    taxClassifications: row.taxClassifications.map((t) => ({
      id: t.id,
      countryCode: t.countryCode,
      regionCode: t.regionCode,
      taxCategory: t.taxCategory,
      itemCode: t.itemCode,
      effectiveFrom: toCalendarDate(t.effectiveFrom),
      effectiveTo: t.effectiveTo ? toCalendarDate(t.effectiveTo) : null,
    })),
    medicine: row.medicineDetail
      ? {
          id: row.medicineDetail.id,
          productId: row.medicineDetail.productId,
          dosageForm: row.medicineDetail.dosageForm,
          route: row.medicineDetail.route,
          releaseType: row.medicineDetail.releaseType,
          isNarrowTherapeuticIndex: row.medicineDetail.isNarrowTherapeuticIndex,
          prescriptionClassificationHint: row.medicineDetail.prescriptionClassificationHint,
          labelInstructions: row.medicineDetail.labelInstructions,
          defaultCourseDays: row.medicineDetail.defaultCourseDays,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProducts(
  ctx: TenantContext,
  query: ProductListQuery
): Promise<ProductListResponse> {
  return withTenant(ctx, async (tx) => {
    /*
     * A category filter means the category AND everything under it.
     *
     * ⚠️ WITHOUT THIS, CLICKING "Antibiotics" IN A CLINIC THAT FILES PRECISELY
     *   RETURNS NOTHING. Every product sits under a leaf like Penicillins, so
     *   an equality filter on the branch node matches no rows at all — and the
     *   screen looks broken in exactly the clinics whose catalogue is best kept.
     */
    const categoryIds = query.categoryId
      ? await categorySubtreeIds(tx, query.categoryId)
      : undefined;

    const where = {
      deletedAt: null,
      ...(query.type !== undefined ? { type: query.type } : {}),
      /*
       * ⚠️ WITHDRAWN IS HIDDEN BY DEFAULT, BY STATUS — NOT BY `deletedAt`.
       *   `withdrawProduct` used to stamp `deleted_at` as well, which hid the
       *   row here but ALSO made `findProductOrThrow` 404 it, so the product
       *   became unreadable by id and the `WITHDRAWN` filter below could never
       *   return anything. That contradicted the whole point of the status:
       *   "out of every picker while history keeps resolving". It resolved
       *   nothing.
       *
       *   So the status carries it, which is what `ProductStatus` is for. The
       *   default excludes WITHDRAWN; asking for it explicitly still finds it.
       */
      ...(query.status !== undefined
        ? { status: query.status }
        : { status: { not: 'WITHDRAWN' as const } }),
      ...(query.manufacturerId !== undefined ? { manufacturerId: query.manufacturerId } : {}),
      ...(query.compositionId !== undefined ? { compositionId: query.compositionId } : {}),
      ...(query.isStockItem !== undefined ? { isStockItem: query.isStockItem } : {}),
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      /*
       * `source` is expressed as a predicate on organization_id, which RLS has
       * already narrowed to "NULL or mine". So OWN means `not null` and PLATFORM
       * means `null` — neither needs to name the organization, and neither could
       * widen the result if it tried.
       */
      ...(query.source === 'OWN' ? { organizationId: { not: null } } : {}),
      ...(query.source === 'PLATFORM' ? { organizationId: null } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { code: { contains: query.q, mode: 'insensitive' as const } },
              { brandName: { contains: query.q, mode: 'insensitive' as const } },
              { genericName: { contains: query.q, mode: 'insensitive' as const } },
              // By what is in it, and by how it is labelled on the shelf.
              {
                composition: {
                  is: { name: { contains: query.q, mode: 'insensitive' as const } },
                },
              },
              { identifiers: { some: { value: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.product.findMany({
        where,
        include: summaryInclude,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.product.count({ where }),
    ]);

    return {
      products: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getProduct(ctx: TenantContext, productId: string): Promise<ProductDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findProductOrThrow(tx, productId)));
}

/**
 * Everything sharing this product's composition.
 *
 * ⚠️ EQUIVALENCE IS NOT PERMISSION. This answers "what is chemically the same
 *   medicine". Whether one may be dispensed in place of another is regulatory,
 *   depends on the jurisdiction, the prescriber's instruction and the drug's
 *   therapeutic index, and is answered by `evaluate()` in PI-5. A screen
 *   rendering this list must not label it "can be swapped for".
 */
export async function listEquivalentProducts(
  ctx: TenantContext,
  productId: string
): Promise<EquivalentProductsResponse> {
  return withTenant(ctx, async (tx) => {
    const product = await findProductOrThrow(tx, productId);

    // A product with no composition is not a medicine, so nothing is equivalent
    // to it. Returning every other composition-less product — gloves, gauze —
    // would be worse than returning nothing.
    if (product.compositionId === null) {
      return { compositionId: null, products: [] };
    }

    const rows = await tx.product.findMany({
      where: {
        compositionId: product.compositionId,
        id: { not: productId },
        deletedAt: null,
        status: { in: ['ACTIVE', 'DISCONTINUED'] },
      },
      include: summaryInclude,
      orderBy: { name: 'asc' },
      take: 100,
    });

    return { compositionId: product.compositionId, products: rows.map(toSummary) };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Refuse an expiry-controlled product that has nowhere to record an expiry.
 *
 * The database CHECKs this too. Both exist because the CHECK's message names a
 * constraint, and because this is the kind of rule a later import path would
 * otherwise reintroduce.
 */
function assertExpiryTrackable(input: {
  isExpiryControlled?: boolean | undefined;
  trackingMode?: string | undefined;
}): void {
  if (
    input.isExpiryControlled === true &&
    input.trackingMode !== 'LOT_BATCH' &&
    input.trackingMode !== 'LOT_AND_SERIAL'
  ) {
    throw new ValidationError(
      'An expiry date is recorded against a batch, so expiry control needs batch tracking. Set tracking to Lot/batch first.'
    );
  }
}

export async function createProduct(
  ctx: TenantContext,
  input: CreateProductRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductDetail> {
  return withTenant(ctx, async (tx) => {
    assertExpiryTrackable(input);

    const clash = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A product with this code already exists.');

    /*
     * The referenced masters are NOT re-checked for visibility here, and that is
     * deliberate rather than an omission: the RESTRICTIVE `*_visible` policies on
     * `products` do it in the database, for every writer, including ones written
     * after this file. A check here would be a third layer that can drift from
     * the two that matter. What we DO check is existence, so the caller gets a
     * message instead of a foreign-key violation.
     */
    const baseUnit = await tx.unitOfMeasure.findUnique({
      where: { id: input.baseUnitId },
      select: { id: true, isActive: true },
    });
    if (!baseUnit) throw new NotFoundError('Base unit');
    if (!baseUnit.isActive) {
      throw new ValidationError('That base unit is inactive. Pick a unit that is still in use.');
    }

    const created = await tx.product.create({
      data: {
        organizationId: ctx.organizationId,
        type: input.type,
        code: input.code,
        name: input.name,
        brandName: input.brandName ?? null,
        genericName: input.genericName ?? null,
        description: input.description ?? null,
        categoryId: input.categoryId ?? null,
        manufacturerId: input.manufacturerId ?? null,
        compositionId: input.compositionId ?? null,
        storageProfileId: input.storageProfileId ?? null,
        baseUnitId: input.baseUnitId,
        trackingMode: input.trackingMode,
        isExpiryControlled: input.isExpiryControlled,
        defaultShelfLifeDays: input.defaultShelfLifeDays ?? null,
        reorderLevelBase: input.reorderLevelBase ?? null,
        reorderQuantityBase: input.reorderQuantityBase ?? null,
        isStockItem: input.isStockItem,
        /*
         * Level 0 is created with the product, always.
         *
         * ⚠️ A PRODUCT WITHOUT IT HAS NO BASE PACKAGING ROW, so every packaging
         *   calculation starts from a gap and `packagingFactorToBase` refuses.
         *   Creating it here means a product is never in that state, rather than
         *   being repaired by whoever next opens the packaging tab.
         */
        /*
         * ⚠️ NO `organizationId` ON A NESTED CREATE, AND PRISMA IS RIGHT TO
         *   REFUSE IT. `organization_id` is half of the composite relation
         *   `(organization_id, product_id) -> products(organization_id, id)`, so
         *   Prisma owns both columns and copies them from the parent it is
         *   creating. Setting it by hand would let the two disagree, which is the
         *   exact failure the composite FK exists to make impossible.
         */
        packagings: {
          create: { level: 0, unitId: input.baseUnitId, quantityOfChild: '1' },
        },
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'product',
      entityId: created.id,
      after: { code: input.code, name: input.name, type: input.type, status: 'DRAFT' },
      ...options,
    });

    return toDetail(await findProductOrThrow(tx, created.id));
  });
}

export async function updateProduct(
  ctx: TenantContext,
  productId: string,
  input: UpdateProductRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findProductOrThrow(tx, productId);
    assertMutable(existing.organizationId);

    // Validate the state the product will be IN, not only what is being sent —
    // ticking expiry control without touching tracking has to be caught too.
    assertExpiryTrackable({
      isExpiryControlled: input.isExpiryControlled ?? existing.isExpiryControlled,
      trackingMode: input.trackingMode ?? existing.trackingMode,
    });

    await tx.product.update({
      where: { id: productId },
      data: {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brandName !== undefined ? { brandName: input.brandName } : {}),
        ...(input.genericName !== undefined ? { genericName: input.genericName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.manufacturerId !== undefined ? { manufacturerId: input.manufacturerId } : {}),
        ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}),
        ...(input.storageProfileId !== undefined
          ? { storageProfileId: input.storageProfileId }
          : {}),
        ...(input.trackingMode !== undefined ? { trackingMode: input.trackingMode } : {}),
        ...(input.isExpiryControlled !== undefined
          ? { isExpiryControlled: input.isExpiryControlled }
          : {}),
        ...(input.defaultShelfLifeDays !== undefined
          ? { defaultShelfLifeDays: input.defaultShelfLifeDays }
          : {}),
        ...(input.reorderLevelBase !== undefined
          ? { reorderLevelBase: input.reorderLevelBase }
          : {}),
        ...(input.reorderQuantityBase !== undefined
          ? { reorderQuantityBase: input.reorderQuantityBase }
          : {}),
        ...(input.isStockItem !== undefined ? { isStockItem: input.isStockItem } : {}),
      },
      select: { id: true },
    });

    const after = await findProductOrThrow(tx, productId);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product',
      entityId: productId,
      before: {
        name: existing.name,
        status: existing.status,
        trackingMode: existing.trackingMode,
        isExpiryControlled: existing.isExpiryControlled,
      },
      after: {
        name: after.name,
        status: after.status,
        trackingMode: after.trackingMode,
        isExpiryControlled: after.isExpiryControlled,
      },
      ...options,
    });

    return toDetail(after);
  });
}

/**
 * Copy a platform product into this clinic's own catalogue.
 *
 * The only way a clinic customises a platform row — see the file header for why
 * the database makes it the only way.
 *
 * ⚠️ IDENTIFIERS ARE COPIED, TAX CLASSIFICATIONS ARE NOT.
 *   An identifier describes the PRODUCT — a GTIN is the same digits whoever
 *   stocks it — so carrying it over is correct and is what makes the clone
 *   resolve to the same barcode scan.
 *   A tax classification describes what THIS CLINIC charges under its own
 *   registration in its own jurisdiction. Copying one would silently assert a
 *   tax position the clinic has never reviewed, on a document a patient
 *   receives. It starts empty, and the invoice engine's existing refusal to
 *   issue an UNRATED line is what surfaces the gap.
 */
export async function cloneProduct(
  ctx: TenantContext,
  productId: string,
  overrides: { code?: string | undefined },
  options: CatalogueActionOptions = {}
): Promise<ProductDetail> {
  return withTenant(ctx, async (tx) => {
    const source = await findProductOrThrow(tx, productId);

    if (source.organizationId !== null) {
      throw new ValidationError(
        'This product is already in your catalogue. Edit it directly rather than copying it.'
      );
    }

    const code = overrides.code ?? source.code;
    const clash = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, code, deletedAt: null },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        `You already have a product with the code "${code}". Give the copy a different code.`
      );
    }

    const created = await tx.product.create({
      data: {
        organizationId: ctx.organizationId,
        type: source.type,
        // ⚠️ DRAFT, not the source's status. A copy nobody has checked must not
        //   arrive ready to dispense.
        status: 'DRAFT',
        code,
        name: source.name,
        brandName: source.brandName,
        genericName: source.genericName,
        description: source.description,
        categoryId: source.categoryId,
        manufacturerId: source.manufacturerId,
        compositionId: source.compositionId,
        storageProfileId: source.storageProfileId,
        baseUnitId: source.baseUnitId,
        trackingMode: source.trackingMode,
        isExpiryControlled: source.isExpiryControlled,
        defaultShelfLifeDays: source.defaultShelfLifeDays,
        reorderLevelBase: source.reorderLevelBase,
        reorderQuantityBase: source.reorderQuantityBase,
        isStockItem: source.isStockItem,
        packagings: {
          // No organizationId — see the note on createProduct's nested create.
          create: source.packagings.map((p) => ({
            level: p.level,
            unitId: p.unitId,
            quantityOfChild: p.quantityOfChild,
            isDefaultPurchase: p.isDefaultPurchase,
            isDefaultSale: p.isDefaultSale,
            barcode: p.barcode,
          })),
        },
        identifiers: {
          create: source.identifiers.map((i) => ({
            type: i.type,
            value: i.value,
            countryCode: i.countryCode,
            effectiveFrom: i.effectiveFrom,
            effectiveTo: i.effectiveTo,
            isPrimary: i.isPrimary,
          })),
        },
        ...(source.medicineDetail
          ? {
              medicineDetail: {
                create: {
                  dosageForm: source.medicineDetail.dosageForm,
                  route: source.medicineDetail.route,
                  releaseType: source.medicineDetail.releaseType,
                  isNarrowTherapeuticIndex: source.medicineDetail.isNarrowTherapeuticIndex,
                  prescriptionClassificationHint:
                    source.medicineDetail.prescriptionClassificationHint,
                  labelInstructions: source.medicineDetail.labelInstructions,
                  defaultCourseDays: source.medicineDetail.defaultCourseDays,
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'product',
      entityId: created.id,
      after: { code, name: source.name, clonedFromProductId: productId, status: 'DRAFT' },
      ...options,
    });

    return toDetail(await findProductOrThrow(tx, created.id));
  });
}

/**
 * Withdraw a product. NOT a hard delete.
 *
 * ⚠️ SOFT, AND `status` RATHER THAN A BOOLEAN. Batches, ledger rows, invoices
 *   and dispensing records will all reference this product forever; removing the
 *   row would break the record of what was dispensed. `WITHDRAWN` takes it out
 *   of every picker while history keeps resolving — and it is deliberately
 *   different from `DISCONTINUED`, which means "we stopped buying it" and leaves
 *   existing stock dispensable (PI-ADR-013).
 */
export async function withdrawProduct(
  ctx: TenantContext,
  productId: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findProductOrThrow(tx, productId);
    assertMutable(existing.organizationId);

    /*
     * ⚠️ NO `deletedAt`. The status IS the withdrawal — that is what the enum
     *   exists for, and `ProductStatus` was chosen over an `isDeleted` boolean
     *   precisely so a product could be retired without becoming unreadable.
     *   Stamping `deleted_at` here made `findProductOrThrow` 404 the row, so
     *   every batch, ledger line and dispensing record pointing at it lost the
     *   ability to resolve the product it named — the exact outcome the comment
     *   above promises does not happen. It also made the code look free to the
     *   app-level clash check while the DB unique still held it.
     */
    await tx.product.update({
      where: { id: productId },
      data: { status: 'WITHDRAWN' },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'product',
      entityId: productId,
      before: { code: existing.code, name: existing.name, status: existing.status },
      after: { status: 'WITHDRAWN' },
      ...options,
    });
  });
}
