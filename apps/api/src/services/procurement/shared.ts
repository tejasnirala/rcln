/**
 * What every procurement service needs and none of them owns.
 *
 * Extracted rather than repeated because each of these is a rule the whole domain
 * has to agree on, and six copies is how one of them ends up subtly different —
 * the same reasoning `guarded()` uses in the route files.
 */
import type { Prisma, TenantContext, TxClient } from '@rcln/db';
import { toBaseUnits } from '@rcln/inventory';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { movementDeps } from '../inventory/movement.service.js';
import { resolveSettings } from '../settings/resolver.service.js';

/*
 * ⚠️ RE-EXPORTED, NOT REDEFINED (PI-11 review). This was a fourth copy of the
 *   same function. `services/shared/branch.ts` is the single source.
 */
export { assertBranchInScope } from '../shared/branch.js';

/**
 * The supplier, as this document will name them.
 *
 * ⚠️ IT RETURNS A SNAPSHOT AND THE CALLER STORES IT. `suppliers` is org-scoped so
 *   a branch CAN read it — this is NOT the PI-3 invisibility problem — but a
 *   purchase order is a document that was sent to somebody, on a day, naming
 *   them. A supplier who re-registers for GST or changes their trading name next
 *   year must not silently rewrite what last year's orders said. Same shape and
 *   the same reasoning as the invoice practitioner snapshot.
 *
 * ⚠️ `BLACKLISTED` IS REFUSED AND `ON_HOLD` IS NOT, WHICH IS THE WHOLE POINT OF
 *   THERE BEING TWO STATUSES. A hold is a payment dispute or a stock-out and the
 *   clinic may well need to finish an order through it; a blacklisting is a
 *   quality or regulatory failure, and the one thing it must never do is quietly
 *   become orderable again.
 */
export async function resolveSupplierForDocument(
  tx: TxClient,
  supplierId: string
): Promise<{
  id: string;
  name: string;
  currency: string | null;
  taxNumber: string | null;
}> {
  const supplier = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: {
      id: true,
      name: true,
      status: true,
      defaultCurrency: true,
      deletedAt: true,
      taxIdentifiers: {
        /*
         * The registration in force TODAY, newest first. A supplier holding a
         * GSTIN per state holds several; the document prints one, and which one is
         * a question about place of supply that this programme does not answer
         * (PI-ADR-006). Newest-effective is the honest default and the buyer can
         * see the rest on the supplier record.
         */
        where: {
          effectiveFrom: { lte: new Date() },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: { registrationNumber: true },
      },
    },
  });
  if (!supplier || supplier.deletedAt) throw new NotFoundError('Supplier');

  if (supplier.status === 'BLACKLISTED') {
    throw new ValidationError(
      `${supplier.name} has been blacklisted, so nothing further can be ordered from or returned to them. Change their status on the supplier record if that is no longer the case.`
    );
  }

  return {
    id: supplier.id,
    name: supplier.name,
    currency: supplier.defaultCurrency,
    taxNumber: supplier.taxIdentifiers[0]?.registrationNumber ?? null,
  };
}

/** A shelf at this branch, active, and readable by this caller. */
export async function resolveLocation(
  tx: TxClient,
  branchId: string,
  locationId: string,
  verb: string
): Promise<{ id: string; name: string }> {
  const location = await tx.inventoryLocation.findUnique({
    where: { id: locationId },
    select: { id: true, branchId: true, isActive: true, deletedAt: true, name: true },
  });
  if (!location || location.deletedAt) throw new NotFoundError('Inventory location');
  if (location.branchId !== branchId) {
    throw new ValidationError(
      `${location.name} is not at the branch this document is being recorded against.`
    );
  }
  if (!location.isActive) {
    throw new ValidationError(`${location.name} is no longer in use, so stock cannot ${verb} it.`);
  }
  return { id: location.id, name: location.name };
}

/** What a document line needs to know about the product it names. */
export interface ProductForLine {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  trackingMode: 'NONE' | 'LOT_BATCH' | 'SERIAL' | 'LOT_AND_SERIAL';
  isExpiryControlled: boolean;
}

/**
 * The product, and the refusal every document in this domain shares.
 *
 * ⚠️ `isStockItem` IS THE CHECK THAT KEEPS BILLING OUT OF INVENTORY. A
 *   consultation fee is a product to billing and never to a store: it has no
 *   quantity, no shelf and nothing to receive. The same sentence
 *   `recordMovementIn` and `resolveLines` both carry, because it is reachable from
 *   every one of them.
 */
export async function resolveProductForLine(
  tx: TxClient,
  productId: string
): Promise<ProductForLine> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      code: true,
      name: true,
      baseUnitId: true,
      trackingMode: true,
      isStockItem: true,
      isExpiryControlled: true,
      deletedAt: true,
      baseUnit: { select: { code: true } },
    },
  });
  if (!product || product.deletedAt) throw new NotFoundError('Product');
  if (!product.isStockItem) {
    throw new ValidationError(
      `${product.name} is not stocked, so it cannot be bought into a store. A consultation fee is a product to billing and never to inventory.`
    );
  }

  return {
    id: product.id,
    code: product.code,
    name: product.name,
    baseUnitId: product.baseUnitId,
    baseUnitCode: product.baseUnit.code,
    trackingMode: product.trackingMode,
    isExpiryControlled: product.isExpiryControlled,
  };
}

/**
 * What the user typed, resolved to base units.
 *
 * ⚠️ THE SAME `toBaseUnits` THE LEDGER USES, IMPORTED RATHER THAN REIMPLEMENTED.
 *   A receipt line that converted "5 boxes" differently from its own
 *   `PURCHASE_RECEIPT` leg would put the delivery note and the shelves out of step
 *   at the exact moment somebody reconciles the two, and by an amount each
 *   individual conversion could justify. PI-3 exported it for transfer lines for
 *   precisely this.
 */
export async function toBase(
  tx: TxClient,
  product: ProductForLine,
  line: {
    quantity: string;
    unitId?: string | null | undefined;
    packagingLevel?: number | null | undefined;
  }
): Promise<string> {
  return toBaseUnits(
    tx,
    movementDeps,
    { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnitCode },
    line
  );
}

/**
 * Refuse the same product twice on one document.
 *
 * ⚠️ HERE **AND** IN A UNIQUE INDEX, AND THE INDEX ALONE WOULD PRODUCE A 23505
 *   NOBODY CAN READ. Two lines for one product have two plausible readings — the
 *   sum, or a duplicate — and neither should be guessed. The index is
 *   NULLS NOT DISTINCT precisely so it catches the untracked case too; this is
 *   what turns it into a sentence.
 */
export function assertNoDuplicateLines(
  keys: string[],
  message = 'The same product appears on this document twice. Combine them into one line — two lines for one product could mean the total or a duplicate, and neither should be guessed.'
): void {
  if (new Set(keys).size !== keys.length) throw new ValidationError(message);
}

export const OVER_RECEIPT_TOLERANCE_KEY = 'procurement.over_receipt_tolerance_percent';
export const QUALITY_HOLD_KEY = 'procurement.quality_hold_required';

/**
 * The two receiving policies, resolved through the settings ladder (PI-ADR-015).
 *
 * ⚠️ `setting_values` IS RLS-EXEMPT, SO THE EXPLICIT `(scopeType, scopeId)` PAIRS
 *   `resolveSettings` BUILDS ARE THE ONLY TENANT ISOLATION THESE READS HAVE, AND
 *   `db:rls:check` CANNOT NOTICE A MISSING ONE — there is no policy to be missing.
 *   Both ids below come from `TenantContext` and from a branch already proved to be
 *   in scope; neither is ever taken from a request body. A read that pinned only
 *   the KEY would return every clinic's row and run one clinic's receiving policy
 *   on another clinic's deliveries. See the header of resolver.service.ts.
 *
 * ⚠️ AND BOTH ARE READ ON THE CALLER'S TRANSACTION, at the moment of posting, and
 *   then SNAPSHOTTED onto the receipt. A policy changed next month must not
 *   restate what happened this month — the same reason `tracking_mode` is copied
 *   onto every ledger row.
 */
export async function resolveReceivingPolicy(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string
): Promise<{ tolerancePercent: number; qualityHoldRequired: boolean }> {
  const settings = await resolveSettings(tx, [OVER_RECEIPT_TOLERANCE_KEY, QUALITY_HOLD_KEY], {
    organizationId: ctx.organizationId,
    branchId,
  });

  const tolerance = settings.get(OVER_RECEIPT_TOLERANCE_KEY);
  const hold = settings.get(QUALITY_HOLD_KEY);

  return {
    /*
     * ⚠️ A NON-NUMBER FALLS BACK TO ZERO, WHICH IS THE STRICT ANSWER. The column
     *   is JSONB and the definition says INT, so a hand-edited row could hold a
     *   string — and a tolerance that failed open would silently accept a delivery
     *   larger than the order. Refusing over-receipt is always recoverable: the
     *   difference is an adjustment with a reason.
     */
    tolerancePercent: typeof tolerance === 'number' && tolerance >= 0 ? tolerance : 0,
    qualityHoldRequired: hold === true,
  };
}

/**
 * Money as the wire and the database both hold it: an integer number of minor
 * units.
 *
 * ⚠️ `BigInt` IN THE COLUMN AND `number` ON THE WIRE, AND THIS IS THE ONE PLACE
 *   THAT CROSSES BETWEEN THEM. `JSON.stringify` throws outright on a BigInt, so a
 *   response that forgot this conversion fails at serialisation rather than
 *   quietly — which is the good failure. Beyond `Number.MAX_SAFE_INTEGER` a
 *   conversion would lose precision instead, so it is refused: 9.007e15 minor
 *   units is ₹90,071,992,547,409, and a clinic with a purchase order that large
 *   has a different problem.
 */
export function toMinorNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError('This amount is larger than the system can report.');
  }
  return Number(value);
}

/** A `Decimal(18,6)` column as the decimal STRING the wire uses. */
export function toQuantityString(value: Prisma.Decimal): string {
  return value.toString();
}

/** A `date` column as `YYYY-MM-DD`, which is what `effectiveDate` is. */
export function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * The same, for a NOT NULL column.
 *
 * ⚠️ A SECOND FUNCTION RATHER THAN `toDateString(x) ?? ''` OR A `!`. The fallback
 *   form invents a date for a column that cannot be null, and `!` is the thing
 *   `noUncheckedIndexedAccess` exists to stop being silenced. Two signatures, one
 *   implementation, and the compiler knows which columns are which.
 */
export function toRequiredDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` as the `Date` a `@db.Date` column takes.
 *
 * ⚠️ PARSED AS UTC MIDNIGHT, DELIBERATELY, AND `new Date('2026-08-14')` ALREADY
 *   DOES THAT — the explicit suffix is here so nobody "fixes" it into
 *   `new Date(y, m, d)`, which is LOCAL midnight and lands on the previous day in
 *   every timezone west of Greenwich. An expiry date is a day in the
 *   manufacturer's calendar and is resolved into the branch's zone by the sweep,
 *   not here (invariant 6).
 */
export function fromDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
