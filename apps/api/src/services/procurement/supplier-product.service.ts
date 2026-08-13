/**
 * The price book: what one supplier sells one product as, and for how much
 * (PI-4.2).
 *
 * ── THE TRANSLATION LAYER, AND WHY IT IS A TABLE ────────────────────────────
 * A supplier sells `AMOX-500-BOX10x10` in boxes at ₹412; the clinic stocks
 * "Amoxicillin 500 mg capsule" in CAPSULES. Those are the same physical thing in
 * two vocabularies, and the mapping is a fact about the commercial relationship
 * rather than about either side.
 *
 * ⚠️ WITHOUT THIS TABLE EVERY PURCHASE ORDER LINE RE-ENTERS THE CONVERSION BY
 *   HAND, AND EVERY ONE OF THEM IS A CHANCE TO ORDER TEN TIMES TOO MANY. That is
 *   the whole justification, and it is why `quantityPerPack` carries a positivity
 *   CHECK in the database rather than only a Zod refinement: it is the divisor that
 *   turns a pack price into the unit cost that lands on a shelf.
 *
 * ⚠️ `quantity_per_pack` IS IN THE PRODUCT'S BASE UNIT, NOT IN `pack_unit_id`, AND
 *   THAT IS THE COLUMN MOST LIKELY TO BE MISREAD. `packUnitId` is only the WORD —
 *   BOX, CASE, VIAL — so an order prints "5 BOX" rather than "500 capsule". It is a
 *   column rather than a lookup through `product_packagings` because a
 *   distributor's shipping case need not be a level of the clinic's own packaging
 *   ladder at all.
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { unitCostFromPack } from '@rcln/inventory';
import type {
  CreateSupplierProductRequest,
  SupplierProductListResponse,
  SupplierProductQuery,
  SupplierProductSummary,
  UpdateSupplierProductRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import {
  fromDateString,
  toDateString,
  toMinorNumber,
  toQuantityString,
  toRequiredDateString,
} from './shared.js';

const detailInclude = Prisma.validator<Prisma.SupplierProductInclude>()({
  supplier: { select: { code: true, name: true } },
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  packUnit: { select: { symbol: true } },
});

type DetailRow = Prisma.SupplierProductGetPayload<{ include: typeof detailInclude }>;

function toSummary(row: DetailRow): SupplierProductSummary {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierCode: row.supplier.code,
    supplierName: row.supplier.name,
    productId: row.productId,
    productCode: row.product.code,
    productName: row.product.name,
    baseUnitSymbol: row.product.baseUnit.symbol,
    supplierSku: row.supplierSku,
    supplierProductName: row.supplierProductName,
    packUnitId: row.packUnitId,
    packUnitSymbol: row.packUnit.symbol,
    quantityPerPack: toQuantityString(row.quantityPerPack),
    pricePerPackMinor: toMinorNumber(row.pricePerPackMinor),
    currency: row.currency,
    /*
     * ⚠️ DERIVED HERE AND NEVER STORED FROM HERE, AND THE DISTINCTION MATTERS. The
     *   figure a purchase order line records is computed at ORDERING time from the
     *   quantity actually ordered, so a rounding on this screen can never leak into
     *   a cost on a shelf. It is returned because "₹4.12 per capsule" is what a
     *   buyer compares two suppliers on, and making the screen do the division is
     *   how two screens end up rounding differently — the reason
     *   `unitCostFromPack` lives in `@rcln/inventory` where it is unit-tested.
     */
    unitCostBase: unitCostFromPack(
      toMinorNumber(row.pricePerPackMinor),
      toQuantityString(row.quantityPerPack)
    ),
    priceEffectiveFrom: toRequiredDateString(row.priceEffectiveFrom),
    priceEffectiveTo: toDateString(row.priceEffectiveTo),
    leadTimeDays: row.leadTimeDays,
    minimumOrderPacks:
      row.minimumOrderPacks === null ? null : toQuantityString(row.minimumOrderPacks),
    isPreferred: row.isPreferred,
    isActive: row.isActive,
    notes: row.notes,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSupplierProducts(
  ctx: TenantContext,
  query: SupplierProductQuery
): Promise<SupplierProductListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.SupplierProductWhereInput = {
      deletedAt: null,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.supplierId !== undefined ? { supplierId: query.supplierId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { supplierSku: { contains: query.q, mode: 'insensitive' } },
              { supplierProductName: { contains: query.q, mode: 'insensitive' } },
              { product: { name: { contains: query.q, mode: 'insensitive' } } },
              { product: { code: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.supplierProduct.count({ where }),
      tx.supplierProduct.findMany({
        where,
        include: detailInclude,
        /*
         * Preferred first, then by product name. A buyer asking "who sells this"
         * wants the answer the clinic already decided on at the top of the list,
         * and `id` last makes the page boundary stable.
         */
        orderBy: [{ isPreferred: 'desc' }, { product: { name: 'asc' } }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      supplierProducts: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * At most one preferred row per product, cleared in the same transaction.
 *
 * ⚠️ ENFORCED HERE RATHER THAN BY A PARTIAL UNIQUE INDEX, AND THE REASON IS THAT
 *   "PREFERRED" IS ADVICE. A partial index would make the second preferred row a
 *   23505 the buyer cannot read, and — worse — it would refuse the ordinary
 *   mid-switch state where a clinic has decided nothing yet. What must not happen
 *   is TWO, because then "the preferred supplier" resolves to whichever row the
 *   plan returned, which changes as the table grows.
 */
async function clearOtherPreferred(
  tx: TxClient,
  productId: string,
  keepId: string | null
): Promise<void> {
  await tx.supplierProduct.updateMany({
    where: {
      productId,
      isPreferred: true,
      deletedAt: null,
      ...(keepId === null ? {} : { id: { not: keepId } }),
    },
    data: { isPreferred: false },
  });
}

export async function createSupplierProduct(
  ctx: TenantContext,
  supplierId: string,
  input: CreateSupplierProductRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierProductSummary> {
  return withTenant(ctx, async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    if (!supplier || supplier.deletedAt) throw new NotFoundError('Supplier');

    /*
     * ⚠️ A BLACKLISTED SUPPLIER'S PRICE BOOK MAY STILL BE EDITED, DELIBERATELY, AND
     *   ONLY ORDERING IS REFUSED (see `resolveSupplierForDocument`). Blacklisting is
     *   a decision about buying, not about record-keeping, and a clinic settling a
     *   dispute needs the prices to still be there when they un-blacklist them.
     */

    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, name: true, isStockItem: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so there is nothing to buy. A consultation fee is a product to billing and never to a store.`
      );
    }

    /*
     * ⚠️ `units_of_measure` HAS NO `deleted_at` — A UNIT IS RETIRED WITH `is_active`,
     *   because a unit cited by a year of ledger rows can never be removed. Existence
     *   is the check that matters here; an inactive unit on a price book row is the
     *   clinic's own business.
     */
    const packUnit = await tx.unitOfMeasure.findUnique({
      where: { id: input.packUnitId },
      select: { id: true, isActive: true },
    });
    if (!packUnit) throw new NotFoundError('Unit');

    if (input.priceEffectiveTo != null && input.priceEffectiveTo < input.priceEffectiveFrom) {
      throw new ValidationError(
        'This price is recorded as ending before it starts. Check the two dates.'
      );
    }

    const clash = await tx.supplierProduct.findFirst({
      where: { supplierId, productId: input.productId, supplierSku: input.supplierSku },
      select: { id: true, deletedAt: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.deletedAt === null
          ? `${supplier.name} already has ${input.supplierSku} recorded for ${product.name}. Edit that entry to change the price.`
          : `${input.supplierSku} was recorded for ${product.name} and has been removed. Restore it rather than adding a second entry — past order lines still cite it.`
      );
    }

    if (input.isPreferred) await clearOtherPreferred(tx, input.productId, null);

    const created = await tx.supplierProduct.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId,
        productId: input.productId,
        supplierSku: input.supplierSku,
        supplierProductName: input.supplierProductName ?? null,
        packUnitId: input.packUnitId,
        quantityPerPack: input.quantityPerPack,
        pricePerPackMinor: BigInt(input.pricePerPackMinor),
        currency: input.currency,
        priceEffectiveFrom: fromDateString(input.priceEffectiveFrom),
        priceEffectiveTo:
          input.priceEffectiveTo != null ? fromDateString(input.priceEffectiveTo) : null,
        leadTimeDays: input.leadTimeDays ?? null,
        minimumOrderPacks: input.minimumOrderPacks ?? null,
        isPreferred: input.isPreferred,
        notes: input.notes ?? null,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'supplier_product',
      entityId: created.id,
      after: {
        supplierId,
        productId: input.productId,
        supplierSku: input.supplierSku,
        pricePerPackMinor: input.pricePerPackMinor,
        currency: input.currency,
      },
      ...options,
    });

    return toSummary(created);
  });
}

export async function updateSupplierProduct(
  ctx: TenantContext,
  id: string,
  input: UpdateSupplierProductRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierProductSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.supplierProduct.findUnique({
      where: { id },
      include: detailInclude,
    });
    if (!existing || existing.deletedAt) throw new NotFoundError('Supplier product');

    const from = input.priceEffectiveFrom ?? toDateString(existing.priceEffectiveFrom);
    const to =
      input.priceEffectiveTo !== undefined
        ? input.priceEffectiveTo
        : toDateString(existing.priceEffectiveTo);
    if (from != null && to != null && to < from) {
      throw new ValidationError(
        'This price is recorded as ending before it starts. Check the two dates.'
      );
    }

    if (input.packUnitId !== undefined) {
      const packUnit = await tx.unitOfMeasure.findUnique({
        where: { id: input.packUnitId },
        select: { id: true, isActive: true },
      });
      if (!packUnit) throw new NotFoundError('Unit');
    }

    if (input.isPreferred === true) await clearOtherPreferred(tx, existing.productId, id);

    /*
     * ⚠️ CHANGING A PRICE DOES NOT RESTATE ANY ORDER OR ANY BATCH. Every purchase
     *   order line stores the `unit_cost_base` resolved when it was raised, and
     *   `batches.unit_cost_base` stores what the lot actually cost. This row is the
     *   price of the NEXT order and nothing else — which is what
     *   `price_effective_from`/`_to` exist to make readable.
     */
    const updated = await tx.supplierProduct.update({
      where: { id },
      data: {
        ...(input.supplierProductName !== undefined
          ? { supplierProductName: input.supplierProductName }
          : {}),
        ...(input.packUnitId !== undefined ? { packUnitId: input.packUnitId } : {}),
        ...(input.quantityPerPack !== undefined ? { quantityPerPack: input.quantityPerPack } : {}),
        ...(input.pricePerPackMinor !== undefined
          ? { pricePerPackMinor: BigInt(input.pricePerPackMinor) }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.priceEffectiveFrom !== undefined
          ? { priceEffectiveFrom: fromDateString(input.priceEffectiveFrom) }
          : {}),
        ...(input.priceEffectiveTo !== undefined
          ? {
              priceEffectiveTo:
                input.priceEffectiveTo === null ? null : fromDateString(input.priceEffectiveTo),
            }
          : {}),
        ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
        ...(input.minimumOrderPacks !== undefined
          ? { minimumOrderPacks: input.minimumOrderPacks }
          : {}),
        ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'supplier_product',
      entityId: id,
      before: {
        pricePerPackMinor: toMinorNumber(existing.pricePerPackMinor),
        quantityPerPack: toQuantityString(existing.quantityPerPack),
        isActive: existing.isActive,
      },
      after: {
        pricePerPackMinor: toMinorNumber(updated.pricePerPackMinor),
        quantityPerPack: toQuantityString(updated.quantityPerPack),
        isActive: updated.isActive,
      },
      ...options,
    });

    return toSummary(updated);
  });
}

/**
 * Take a row out of the price book.
 *
 * A soft delete, because `purchase_order_lines.supplier_product_id` cites it under
 * `Restrict` — "what was this priced from" has to keep having an answer.
 */
export async function deleteSupplierProduct(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.supplierProduct.findUnique({
      where: { id },
      select: { id: true, supplierSku: true, productId: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) throw new NotFoundError('Supplier product');

    await tx.supplierProduct.update({
      where: { id },
      data: { deletedAt: new Date(), isPreferred: false },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'supplier_product',
      entityId: id,
      before: { supplierSku: existing.supplierSku, productId: existing.productId },
      ...options,
    });
  });
}
