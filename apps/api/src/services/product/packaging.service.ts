/**
 * A product's packaging ladder: `box(10) -> strip(10) -> tablet`.
 *
 * ── WHY THIS IS PER PRODUCT AND `unit_conversions` IS NOT ────────────────────
 * `unit_conversions` says a strip is ten tablets for EVERY product using those
 * units. This says THIS product comes in strips of ten. Both are needed because
 * a supplier ships the same medicine in strips of 10 and of 15, and a single
 * global conversion cannot hold both — so the general statement lives in the
 * unit table and the specific one lives here.
 *
 * ── REPLACED WHOLESALE, NEVER PATCHED ────────────────────────────────────────
 * A ladder is only meaningful complete: level 3 with no level 2 does not
 * describe a box of anything, and multiplying whichever levels happen to exist
 * would answer a plausible number for a product nobody can count. Patching one
 * level at a time lets a caller build exactly that gap one request at a time, so
 * the whole ladder arrives together and `assertValidPackaging` checks it as a
 * unit.
 *
 * The arithmetic is in `units.ts` and is exact — see that file's header for why
 * a `factor: number` is the wrong shape for this problem.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { ProductPackagingDetail, ReplaceProductPackagingRequest } from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  assertValidPackaging,
  convertPackagingToBase,
  formatQuantity,
  packagingFactorToBase,
} from './units.js';
import type { CatalogueActionOptions } from './unit.service.js';

/**
 * The read, INSIDE a caller's transaction.
 *
 * ⚠️ SPLIT OUT SO THE WRITE PATH DOES NOT OPEN A SECOND TRANSACTION. Both
 *   `replacePackagings` and its equivalent in tax-classification used to finish
 *   their own `withTenant`, then call the public list function, which opened
 *   another `BEGIN; set_config; …; COMMIT`. That is a second round trip and a
 *   redundant product lookup for every write — and, worse, a window: the
 *   response could describe a state a concurrent writer had already changed, so
 *   the caller was shown something that was never the result of its own request.
 *
 *   CONVENTIONS says to group related queries into one call. This is that.
 */
async function readPackagings(tx: TxClient, productId: string): Promise<ProductPackagingDetail[]> {
  const rows = await tx.productPackaging.findMany({
    where: { productId },
    include: { unit: { select: { code: true, symbol: true } } },
    orderBy: { level: 'asc' },
  });

  // Hoisted out of the map below: every row needs the SAME ladder to compute its
  // factor, and rebuilding it per row is n² allocations for one answer.
  const levels = rows.map((r) => ({
    level: r.level,
    unitId: r.unitId,
    quantityOfChild: r.quantityOfChild.toString(),
  }));

  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    unitId: r.unitId,
    unitCode: r.unit.code,
    unitSymbol: r.unit.symbol,
    quantityOfChild: r.quantityOfChild.toString(),
    quantityInBase: formatQuantity(packagingFactorToBase(levels, r.level)).quantity,
    isDefaultPurchase: r.isDefaultPurchase,
    isDefaultSale: r.isDefaultSale,
    barcode: r.barcode,
  }));
}

export async function listPackagings(
  ctx: TenantContext,
  productId: string
): Promise<ProductPackagingDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    return readPackagings(tx, productId);
  });
}

export async function replacePackagings(
  ctx: TenantContext,
  productId: string,
  input: ReplaceProductPackagingRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductPackagingDetail[]> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, organizationId: true, baseUnitId: true, deletedAt: true, code: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');

    if (product.organizationId === null) {
      throw new ValidationError(
        'This product is part of the platform catalogue. Copy it into your own catalogue before changing its packaging.'
      );
    }

    assertValidPackaging(input.levels);

    /*
     * ⚠️ LEVEL 0 MUST BE THE PRODUCT'S OWN BASE UNIT, and this is the check that
     *   protects the ledger. Every stored quantity is denominated in
     *   `products.base_unit_id`; if level 0 named a different unit, every
     *   packaging conversion would resolve into that unit instead and the
     *   numbers written to `stock_ledger` would silently mean something else.
     *   Nothing else in the system would notice — the arithmetic is internally
     *   consistent, it is simply about the wrong unit.
     */
    /*
     * ⚠️ UNCONDITIONAL — `if (base && …)` WAS THE BUG. Written that way, a
     *   ladder with no level 0 at all skipped the check entirely rather than
     *   failing it, which is the opposite of what a guard is for. The contract
     *   now refuses an empty array, so this is the second layer; between them a
     *   product cannot end up without a base packaging row.
     */
    const base = input.levels.find((l) => l.level === 0);
    if (!base) {
      throw new ValidationError(
        "The ladder must start at level 0, in the product's own base unit."
      );
    }
    if (base.unitId !== product.baseUnitId) {
      throw new ValidationError(
        "Level 0 must be the product's own base unit, because that is what every stored quantity is counted in."
      );
    }

    const unitIds = [...new Set(input.levels.map((l) => l.unitId))];
    const units = await tx.unitOfMeasure.findMany({
      where: { id: { in: unitIds } },
      select: { id: true, code: true, unitClass: true },
    });
    if (units.length !== unitIds.length) {
      // RLS filtered at least one out: it belongs to another tenant, or does not
      // exist. Indistinguishable from here, and correctly so.
      throw new NotFoundError('Packaging unit');
    }

    /*
     * All levels of one ladder measure the same KIND of thing. A box of tablets
     * counted in millilitres is not a packaging error, it is a category error,
     * and the resulting factor would be arithmetically fine and physically
     * meaningless.
     */
    const classes = new Set(units.map((u) => u.unitClass));
    if (classes.size > 1) {
      throw new ValidationError(
        `This packaging mixes ${[...classes].join(' and ').toLowerCase()} units. Every level of one ladder must measure the same thing.`
      );
    }

    const existing = await tx.productPackaging.findMany({
      where: { productId },
      select: { level: true },
    });

    /*
     * Delete-then-create inside one transaction, so no reader ever sees a
     * product with half a ladder. The unique index on (organization_id,
     * product_id, level) makes an in-place upsert order-dependent — moving
     * level 2 to level 1 collides with the level 1 that has not been moved yet.
     */
    await tx.productPackaging.deleteMany({ where: { productId } });
    await tx.productPackaging.createMany({
      data: input.levels.map((l) => ({
        organizationId: product.organizationId,
        productId,
        level: l.level,
        unitId: l.unitId,
        quantityOfChild: l.quantityOfChild,
        isDefaultPurchase: l.isDefaultPurchase,
        isDefaultSale: l.isDefaultSale,
        barcode: l.barcode ?? null,
      })),
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product_packaging',
      entityId: productId,
      before: { levels: existing.length },
      after: { levels: input.levels.length },
      ...options,
    });

    // Inside the same transaction — see `readPackagings`. The product was
    // already loaded and validated above, so no second lookup either.
    return readPackagings(tx, productId);
  });
}

/**
 * Convert a quantity entered at a packaging level into base units.
 *
 * Exported for PI-2: every receipt, dispense and adjustment enters a quantity in
 * whatever the user is holding — a box, a strip — and the ledger stores base
 * units. This is the one function that makes that crossing.
 *
 * ⚠️ REFUSES AN INEXACT RESULT rather than rounding. A ladder that does not
 *   divide evenly means the entry cannot be represented at the ledger's
 *   precision, and a rounded movement puts the ledger and the shelf permanently
 *   out of step by an amount each individual rounding can justify.
 */
export async function quantityInBaseUnits(
  ctx: TenantContext,
  productId: string,
  quantity: string,
  level: number
): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.productPackaging.findMany({
      where: { productId },
      select: { level: true, unitId: true, quantityOfChild: true },
      orderBy: { level: 'asc' },
    });
    if (rows.length === 0) throw new NotFoundError('Product packaging');

    const levels = rows.map((r) => ({
      level: r.level,
      unitId: r.unitId,
      quantityOfChild: r.quantityOfChild.toString(),
    }));

    const result = convertPackagingToBase(levels, quantity, level);

    if (!result.exact) {
      throw new ConflictError(
        `${quantity} at that packaging level does not come to a whole number of base units. Enter the quantity in base units instead.`
      );
    }

    return result.quantity;
  });
}
