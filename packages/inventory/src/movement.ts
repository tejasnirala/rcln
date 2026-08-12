/**
 * `recordMovement` — THE ONLY THING IN THIS PROGRAMME THAT WRITES `stock_ledger`
 * (PI-ADR-004).
 *
 * Every quantity that ever changes hands goes through this function: goods
 * receipts (PI-4), dispensing (PI-7), clinical consumption (PI-9), transfers
 * (PI-3), the expiry sweep, and the manual adjustments this phase exposes. If a
 * second writer appears, the invariants below stop being invariants — they are
 * enforced by the database as well, precisely because this sentence is the kind
 * that stops being true.
 *
 * ── WHAT THIS FUNCTION GUARANTEES ────────────────────────────────────────────
 *
 *   1. THE CALLER NEVER CHOOSES A SIGN. `movementType` decides it, through
 *      `DIRECTION` below, which mirrors the `stock_ledger_direction` CHECK
 *      one-for-one. A caller that could pass `-5` on a receipt is a caller that
 *      eventually will, and the row it writes is indistinguishable from a
 *      genuine issue in every report.
 *
 *   2. EVERY QUANTITY IS CONVERTED EXACTLY. The user enters boxes or millilitres
 *      and the ledger stores base units. `assertExactConversion` refuses a
 *      conversion that lost a fraction rather than rounding it — a rounded
 *      movement puts the ledger and the shelf permanently out of step by an
 *      amount each individual rounding can justify.
 *
 *   3. A DECREMENT IS CHECKED UNDER A ROW LOCK. The balance rows in play are
 *      taken `FOR UPDATE` inside the committing transaction and re-verified, so
 *      two dispensers racing for the last strip produce one success and one 409
 *      rather than one success and one negative shelf. `stock_balances_non_
 *      negative` is the layer beneath that, for the callers this file cannot see.
 *
 *   4. THE PRODUCT'S TRACKING MODE IS SATISFIED. A `SERIAL` product moving with
 *      no serial is refused here with a sentence and by a CHECK constraint
 *      without one (PI-ADR-014).
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It does not write `stock_balances`. `rcln_app` holds no INSERT, UPDATE or
 * DELETE on that table at all; a trigger maintains it. There is no code path
 * from here to a quantity.
 *
 * It does not create an invoice line. Consumption is not a charge (PI-ADR-005).
 *
 * NO PHI. A movement names ids, quantities and places. The one PHI-adjacent
 * thing in this domain is `serials.assigned_patient_id`, which lives in
 * serial.service.ts and is logged there.
 */
import { type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  RecordMovementRequest,
  RecordMovementResponse,
  StockMovementType,
  StockStatus,
} from '@rcln/contracts';
import { conflict, invalid, missing } from './errors.js';
import {
  assertExactConversion,
  compareQuantities,
  convertPackagingToBase,
  convertToBase,
  type UnitGraph,
} from './units.js';

/**
 * What this engine cannot do for itself, injected by whoever calls it.
 *
 * ⚠️ INJECTED RATHER THAN IMPORTED, BECAUSE BOTH IMPLEMENTATIONS LIVE IN
 *   APPLICATIONS AND THIS IS A PACKAGE. `recordAudit` reaches for the API's
 *   redaction list and its snapshot diffing; `loadUnitGraph` is the API's
 *   tenant-visible read of `units_of_measure`. Pulling either in here would make
 *   the package depend on an app, which is the dependency that does not exist in
 *   this repository and must not start here.
 *
 *   The same shape `@rcln/billing` uses for its `run` parameter, for the same
 *   reason.
 */
export interface MovementDeps {
  /** Writes one `audit_logs` row INSIDE the caller's transaction. */
  recordAudit: (
    tx: TxClient,
    ctx: TenantContext,
    entry: {
      action: 'CREATE';
      entityType: string;
      entityId: string;
      branchId?: string | null | undefined;
      after?: Record<string, unknown> | undefined;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    }
  ) => Promise<void>;
  /** Every unit and conversion this tenant can see, as a graph. */
  loadUnitGraph: (tx: TxClient) => Promise<UnitGraph>;
}

/** Request provenance, carried into the audit row. */
export interface MovementOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * How a movement type moves quantity.
 *
 * ⚠️ THIS TABLE AND THE `stock_ledger_direction` CHECK CONSTRAINT ARE THE SAME
 *   RULE WRITTEN TWICE, IN TWO LANGUAGES, AND THEY MUST NOT DRIFT. The constraint
 *   is the one that holds; this one exists so the caller gets a sentence instead
 *   of a constraint name, and so the defaults below have somewhere to live.
 *   `apps/api/tests/unit/inventory-movement.test.ts` asserts every member of the
 *   enum appears here,
 *   which is what catches a member added in a later phase and forgotten.
 *
 *   ADD     quantity > 0, `statusTo` only.
 *   REMOVE  quantity < 0, `statusFrom` only.
 *   MOVE    quantity > 0, both, and they must differ. Net zero — the quantity
 *           changes which bucket it sits in, not whether it exists.
 *   EITHER  ADJUSTMENT alone, which is why it is the one type that must carry a
 *           reason code.
 */
type Direction = 'ADD' | 'REMOVE' | 'MOVE' | 'EITHER';

export const DIRECTION: Record<StockMovementType, Direction> = {
  PURCHASE_RECEIPT: 'ADD',
  TRANSFER_IN: 'ADD',
  RETURN: 'ADD',

  DISPENSING: 'REMOVE',
  CLINICAL_CONSUMPTION: 'REMOVE',
  TRANSFER_OUT: 'REMOVE',
  DISPOSAL: 'REMOVE',

  RESERVATION: 'MOVE',
  RELEASE: 'MOVE',
  EXPIRY: 'MOVE',
  RECALL: 'MOVE',
  QUARANTINE: 'MOVE',
  QUARANTINE_RELEASE: 'MOVE',
  DAMAGE: 'MOVE',

  ADJUSTMENT: 'EITHER',
};

/**
 * The buckets each movement uses when the caller does not say.
 *
 * These are conveniences, not rules — the caller may name a different
 * `statusFrom` (quarantining stock that is currently RESERVED is legitimate),
 * and the direction table above plus the CHECK constraint are what actually
 * constrain the result.
 *
 * ⚠️ `DISPOSAL` HAS NO DEFAULT `from`, ON PURPOSE. Disposal is the one movement
 *   that removes stock permanently, and what is being destroyed — expired,
 *   damaged, recalled — is the entire content of the record. Defaulting it to
 *   AVAILABLE would let a mis-click destroy sellable stock and record it as
 *   routine.
 */
const DEFAULT_STATUS: Partial<Record<StockMovementType, { from?: StockStatus; to?: StockStatus }>> =
  {
    PURCHASE_RECEIPT: { to: 'AVAILABLE' },
    TRANSFER_IN: { to: 'AVAILABLE' },
    RETURN: { to: 'AVAILABLE' },

    DISPENSING: { from: 'AVAILABLE' },
    CLINICAL_CONSUMPTION: { from: 'AVAILABLE' },
    TRANSFER_OUT: { from: 'AVAILABLE' },

    RESERVATION: { from: 'AVAILABLE', to: 'RESERVED' },
    RELEASE: { from: 'RESERVED', to: 'AVAILABLE' },
    EXPIRY: { from: 'AVAILABLE', to: 'EXPIRED' },
    RECALL: { from: 'AVAILABLE', to: 'RECALLED' },
    QUARANTINE: { from: 'AVAILABLE', to: 'QUARANTINED' },
    QUARANTINE_RELEASE: { from: 'QUARANTINED', to: 'AVAILABLE' },
    DAMAGE: { from: 'AVAILABLE', to: 'DAMAGED' },
  };

/**
 * What `recordMovement` needs, with the sign, the base quantity and the tracking
 * mode still to be derived.
 *
 * Wider than `RecordMovementRequest` because internal callers move things the
 * HTTP surface does not expose yet — the expiry sweep writes `EXPIRY`, PI-4 will
 * write `PURCHASE_RECEIPT`. They come through this same door.
 */
export interface MovementInput {
  branchId: string;
  productId: string;
  batchId?: string | null | undefined;
  serialId?: string | null | undefined;
  movementType: StockMovementType;
  /** Always positive. The direction comes from `movementType`. */
  quantity: string;
  /** Which way an ADJUSTMENT goes. Ignored for every other type. */
  adjustmentDirection?: 'INCREASE' | 'DECREASE' | null | undefined;
  unitId?: string | null | undefined;
  packagingLevel?: number | null | undefined;
  locationId: string;
  statusFrom?: StockStatus | null | undefined;
  statusTo?: StockStatus | null | undefined;
  reasonCode?: string | null | undefined;
  reasonNote?: string | null | undefined;
  occurredAt?: Date | undefined;
  referenceType?: RecordMovementRequest['referenceType'] | undefined;
  referenceId?: string | null | undefined;
  unitCostBase?: bigint | null | undefined;
  currency?: string | null | undefined;
}

interface BucketKey {
  organizationId: string;
  branchId: string;
  productId: string;
  batchId: string | null;
  serialId: string | null;
  locationId: string;
  status: StockStatus;
}

/**
 * Serialise every writer of a bucket, and read what it holds.
 *
 * ⚠️ AN ADVISORY LOCK, NOT `SELECT ... FOR UPDATE`, AND THE REASON IS THE REVOKE.
 *   `rcln_app` holds no INSERT, UPDATE or DELETE on `stock_balances` — that is
 *   PI-ADR-004 rule 2 made literal, and it is what stops any code path in this
 *   application from stating a quantity directly. But Postgres requires the
 *   UPDATE (or DELETE) privilege to take a row lock, so `FOR UPDATE` on that
 *   table raises 42501 `permission denied` for the very role the whole write
 *   path runs as. The two requirements are in direct conflict and the lock is
 *   the one that has to give way.
 *
 *   `pg_advisory_xact_lock` needs no privilege on anything, releases on COMMIT
 *   or ROLLBACK exactly like a row lock, and serialises precisely the writers
 *   this needs serialised: two movements against the same bucket hash to the
 *   same key and queue behind each other. It was measured — the row-lock version
 *   failed every single movement, not subtly.
 *
 * ⚠️ THE KEYS ARE TAKEN IN SORTED ORDER, AND THAT IS WHAT PREVENTS A DEADLOCK.
 *   A status transition touches TWO buckets. Two concurrent transitions in
 *   opposite directions — one AVAILABLE -> QUARANTINED, one QUARANTINED ->
 *   AVAILABLE — would take the same pair of locks in opposite orders and
 *   deadlock. Sorting the keys makes the acquisition order total for every
 *   caller, which is the standard fix and the only one that does not depend on
 *   remembering to write the calls in the right sequence.
 *
 *   ⚠️ AND IT ONLY HOLDS WITHIN ONE STATEMENT. An advisory *xact* lock is held
 *     until COMMIT, so a caller that records several movements in one
 *     transaction accumulates locks in whatever order it loops — which is why
 *     the expiry sweep opens one transaction PER BUCKET rather than one per
 *     branch. See `expiry.ts`.
 *
 * ⚠️ A HASH COLLISION COSTS CONTENTION AND NOTHING ELSE. Two unrelated buckets
 *   hashing to one key serialise against each other unnecessarily; neither is
 *   corrupted, and `hashtextextended` over a 64-bit space makes it vanishingly
 *   rare. The correctness backstop underneath is `stock_balances_non_negative`.
 */
function bucketKey(key: BucketKey): string {
  return [
    key.organizationId,
    key.branchId,
    key.productId,
    key.batchId ?? '-',
    key.serialId ?? '-',
    key.locationId,
    key.status,
  ].join('|');
}

async function lockBuckets(tx: TxClient, keys: BucketKey[]): Promise<void> {
  if (keys.length === 0) return;

  /*
   * ⚠️ SORTED AND DEDUPLICATED HERE, IN TYPESCRIPT, AND `unnest` PRESERVES THE
   *   ARRAY ORDER. Any total order works — the point is only that every caller
   *   uses the SAME one — and sorting the key strings gives one without asking
   *   the planner for anything.
   *
   *   The first version sorted inside a sub-SELECT and relied on the outer
   *   target list evaluating in the subquery's output order. That happens to
   *   hold today and is planner behaviour rather than a guarantee, and the
   *   obvious fix — `ORDER BY 1` on the outer select — does not even parse:
   *   `pg_advisory_xact_lock` returns `void`, and `could not identify an
   *   ordering operator for type void` is what you get. Measured.
   */
  const raw = [...new Set(keys.map(bucketKey))].sort();

  /*
   * ⚠️ `$executeRaw`, NOT `$queryRaw`. `pg_advisory_xact_lock` returns `void`,
   *   and Prisma's query path tries to deserialize every column it gets back —
   *   it has no mapping for `void` and raises "Failed to deserialize column of
   *   type 'void'". `$executeRaw` does not read the rows, which is exactly what
   *   is wanted from a statement taken for its side effect.
   */
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(v, 0))
      FROM unnest(${raw}::text[]) AS v
  `;
}

/**
 * What the cache says this bucket holds. `'0'` when there is no row.
 *
 * ⚠️ `IS NOT DISTINCT FROM` ON THE TWO NULLABLE COLUMNS. `batch_id = NULL` is
 *   NULL rather than true, so a plain `=` never matches an untracked product's
 *   bucket — the read returns nothing, the sufficiency check compares against
 *   zero, and every movement of every untracked product is refused.
 *
 * Fully parameterised. RLS still applies, so a bucket that comes back is by
 * construction one the caller may touch.
 */
async function bucketQuantity(tx: TxClient, key: BucketKey): Promise<string> {
  const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>`
    SELECT "quantity"
      FROM "stock_balances"
     WHERE "organization_id" = ${key.organizationId}::uuid
       AND "branch_id"       = ${key.branchId}::uuid
       AND "product_id"      = ${key.productId}::uuid
       AND "batch_id"  IS NOT DISTINCT FROM ${key.batchId}::uuid
       AND "serial_id" IS NOT DISTINCT FROM ${key.serialId}::uuid
       AND "location_id"     = ${key.locationId}::uuid
       AND "status"          = ${key.status}::"StockStatus"
  `;

  return rows[0]?.quantity.toString() ?? '0';
}

/**
 * Turn what the user typed into base units, exactly.
 *
 * Three ways in, one way out:
 *   · a PACKAGING LEVEL — "2 boxes" — resolved through the product's own ladder;
 *   · a UNIT — "500 mL" — resolved through the tenant's conversion graph;
 *   · neither, meaning the quantity is already in the product's base unit.
 *
 * ⚠️ AN INEXACT RESULT IS REFUSED, NOT ROUNDED. This is the call site
 *   `assertExactConversion` was written for, and it is the only one that matters:
 *   rounding a display estimate is fine, rounding a MOVEMENT means the ledger and
 *   the shelf disagree by design.
 *
 * ⚠️ EXPORTED SINCE PI-3, FOR TRANSFER LINES, AND THAT IS THE ONLY REASON. A
 *   transfer line records what the sender typed and what it came to in base
 *   units, and it MUST resolve those two the same way the ledger leg it will
 *   later write does — a line that converted differently from its own movement
 *   would put the document and the shelves out of step at the moment somebody
 *   reconciles them. It converts; it does not move anything. Anything that moves
 *   quantity still goes through `recordMovementIn` (PI-ADR-004).
 */
export async function toBaseUnits(
  tx: TxClient,
  deps: MovementDeps,
  product: { id: string; baseUnitId: string; baseUnitCode: string },
  input: Pick<MovementInput, 'quantity' | 'unitId' | 'packagingLevel'>
): Promise<string> {
  if (input.packagingLevel != null) {
    const rows = await tx.productPackaging.findMany({
      where: { productId: product.id },
      select: { level: true, unitId: true, quantityOfChild: true },
      orderBy: { level: 'asc' },
    });
    if (rows.length === 0) {
      throw invalid(
        'This product has no packaging recorded, so a quantity cannot be entered as a pack. Enter it in the base unit instead.'
      );
    }

    const levels = rows.map((r) => ({
      level: r.level,
      unitId: r.unitId,
      quantityOfChild: r.quantityOfChild.toString(),
    }));

    return assertExactConversion(
      convertPackagingToBase(levels, input.quantity, input.packagingLevel),
      { from: `packaging level ${String(input.packagingLevel)}`, to: product.baseUnitCode }
    );
  }

  if (input.unitId != null && input.unitId !== product.baseUnitId) {
    const graph = await deps.loadUnitGraph(tx);
    const unit = graph.units.get(input.unitId);
    if (!unit) throw missing('Unit');

    return assertExactConversion(
      convertToBase(graph, input.quantity, input.unitId, product.baseUnitId),
      { from: unit.code, to: product.baseUnitCode }
    );
  }

  // Already in base units. Still normalised to the ledger's scale so the stored
  // value and the compared value are the same string.
  return assertExactConversion(
    { quantity: input.quantity, exact: true },
    { from: product.baseUnitCode, to: product.baseUnitCode }
  );
}

/** Negate a decimal string without going through a float. */
function negate(quantity: string): string {
  return quantity.startsWith('-') ? quantity.slice(1) : `-${quantity}`;
}

/**
 * Record one movement. The single entry point into `stock_ledger`.
 *
 * Runs inside `tx` when one is supplied, so a caller that is already committing
 * something else — a goods receipt, a dispense, the expiry sweep's batch of
 * lots — writes the movement in the SAME transaction as the thing that caused
 * it. A movement that can commit independently of its cause is a movement that
 * will, on the day the cause rolls back.
 */
export async function recordMovementIn(
  tx: TxClient,
  ctx: TenantContext,
  deps: MovementDeps,
  input: MovementInput,
  options: MovementOptions = {}
): Promise<RecordMovementResponse> {
  if (!ctx.branchIds.includes(input.branchId)) {
    /*
     * ⚠️ NOT FOUND, NOT FORBIDDEN. A branch outside the caller's scope is
     *   invisible to RLS anyway, so it is indistinguishable from one that does
     *   not exist — and a 403 would confirm to somebody probing that the id is
     *   real. Same rule as every other resource in this codebase.
     */
    throw missing('Branch');
  }

  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      code: true,
      name: true,
      baseUnitId: true,
      trackingMode: true,
      isStockItem: true,
      deletedAt: true,
      baseUnit: { select: { code: true, symbol: true } },
    },
  });
  if (!product || product.deletedAt) throw missing('Product');

  if (!product.isStockItem) {
    throw invalid(
      `${product.name} is not stocked, so it has no quantity to move. A consultation fee is a product to billing and never to inventory.`
    );
  }

  // ---- the place ----------------------------------------------------------
  const location = await tx.inventoryLocation.findUnique({
    where: { id: input.locationId },
    select: { id: true, branchId: true, isActive: true, deletedAt: true, name: true },
  });
  if (!location || location.deletedAt) throw missing('Inventory location');
  if (location.branchId !== input.branchId) {
    throw invalid(`${location.name} is not at the branch this movement is being recorded against.`);
  }
  if (!location.isActive) {
    throw invalid(
      `${location.name} is no longer in use, so stock cannot be moved into or out of it.`
    );
  }

  // ---- tracking mode (PI-ADR-014) -----------------------------------------
  const batchId = input.batchId ?? null;
  const serialId = input.serialId ?? null;
  const mode = product.trackingMode;

  if ((mode === 'LOT_BATCH' || mode === 'LOT_AND_SERIAL') && batchId === null) {
    throw invalid(`${product.name} is batch-tracked, so every movement of it must name a lot.`);
  }
  if ((mode === 'SERIAL' || mode === 'LOT_AND_SERIAL') && serialId === null) {
    throw invalid(
      `${product.name} is serial-tracked, so every movement of it must name a serial number.`
    );
  }

  /*
   * The batch and serial are re-read rather than trusted, because the composite
   * FK proves they belong to this TENANT and says nothing about whether they
   * belong to this PRODUCT or this BRANCH. A movement of batch X against product
   * Y is a valid insert that quietly makes the lot's remaining quantity wrong.
   */
  if (batchId !== null) {
    const batch = await tx.batch.findUnique({
      where: { id: batchId },
      select: { id: true, productId: true, branchId: true, lotNumber: true },
    });
    if (!batch) throw missing('Batch');
    if (batch.productId !== product.id) {
      throw invalid(`Lot ${batch.lotNumber} is not a lot of ${product.name}.`);
    }
    if (batch.branchId !== input.branchId) {
      throw invalid(`Lot ${batch.lotNumber} is held at a different branch.`);
    }
  }

  if (serialId !== null) {
    const serial = await tx.serial.findUnique({
      where: { id: serialId },
      select: { id: true, productId: true, branchId: true, batchId: true, serialNumber: true },
    });
    if (!serial) throw missing('Serial');
    if (serial.productId !== product.id) {
      throw invalid(`Serial ${serial.serialNumber} is not a ${product.name}.`);
    }
    if (serial.branchId !== input.branchId) {
      throw invalid(`Serial ${serial.serialNumber} is held at a different branch.`);
    }
    if (batchId !== null && serial.batchId !== batchId) {
      throw invalid(
        `Serial ${serial.serialNumber} does not belong to the lot this movement names.`
      );
    }
  }

  // ---- direction and buckets ----------------------------------------------
  const direction = DIRECTION[input.movementType];
  const defaults = DEFAULT_STATUS[input.movementType] ?? {};

  let statusFrom: StockStatus | null = null;
  let statusTo: StockStatus | null = null;

  if (direction === 'ADD') {
    statusTo = input.statusTo ?? defaults.to ?? 'AVAILABLE';
  } else if (direction === 'REMOVE') {
    statusFrom = input.statusFrom ?? defaults.from ?? null;
    if (statusFrom === null) {
      throw invalid(
        'Say which stock this is being taken from — available, expired, damaged or recalled. Disposal has no default, because what is being destroyed is the whole content of the record.'
      );
    }
  } else if (direction === 'MOVE') {
    statusFrom = input.statusFrom ?? defaults.from ?? 'AVAILABLE';
    statusTo = input.statusTo ?? defaults.to ?? null;
    if (statusTo === null) {
      throw invalid('Say which state this stock is moving into.');
    }
    if (statusFrom === statusTo) {
      throw invalid(
        `This movement would take stock from ${statusFrom.toLowerCase()} and put it back, which changes nothing.`
      );
    }
  } else {
    // ADJUSTMENT: the direction is stated outright rather than ridden in on a
    // sign. See the contract's `adjustmentDirection`.
    if (input.adjustmentDirection === 'INCREASE') {
      statusTo = input.statusTo ?? 'AVAILABLE';
    } else if (input.adjustmentDirection === 'DECREASE') {
      statusFrom = input.statusFrom ?? 'AVAILABLE';
    } else {
      throw invalid('Say whether this adjustment adds stock or removes it.');
    }
    if (input.reasonCode == null) {
      throw invalid(
        'An adjustment must carry a reason code. It is the only movement whose meaning is not already stated by its name.'
      );
    }
  }

  // ---- the quantity -------------------------------------------------------
  const magnitude = await toBaseUnits(
    tx,
    deps,
    { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
    input
  );

  if (compareQuantities(magnitude, '0') <= 0) {
    throw invalid('A movement of zero records nothing. Enter a quantity above zero.');
  }

  /*
   * The signed value the ledger stores. `REMOVE` is the only shape that is
   * negative — a MOVE is net zero across the two buckets and is written
   * positive, which is what the direction CHECK insists on.
   */
  const quantityBase = statusTo === null ? negate(magnitude) : magnitude;

  // ---- the sufficiency check, under a lock --------------------------------
  const keyBase = {
    organizationId: ctx.organizationId,
    branchId: input.branchId,
    productId: product.id,
    batchId,
    serialId,
    locationId: location.id,
  };

  /*
   * ⚠️ BOTH BUCKETS ARE LOCKED BEFORE EITHER IS READ, IN ONE STATEMENT. Locking
   *   the source, checking it, then locking the destination would leave a window
   *   in which a concurrent transition took the destination lock and then waited
   *   for the source — the deadlock the sorted acquisition exists to prevent.
   */
  await lockBuckets(tx, [
    ...(statusFrom === null ? [] : [{ ...keyBase, status: statusFrom }]),
    ...(statusTo === null ? [] : [{ ...keyBase, status: statusTo }]),
  ]);

  if (statusFrom !== null) {
    const held = await bucketQuantity(tx, { ...keyBase, status: statusFrom });
    if (compareQuantities(held, magnitude) < 0) {
      /*
       * A NORMAL 409, not an error. Losing the race for the last strip is an
       * ordinary outcome in a busy pharmacy and the caller's job is to re-read
       * and tell the user, not to retry blindly.
       */
      throw conflict(
        `${location.name} holds ${held} ${product.baseUnit.symbol} of ${product.name} as ${statusFrom.toLowerCase()}, which is less than the ${magnitude} being taken.`
      );
    }
  }

  // ---- the row ------------------------------------------------------------
  const movement = await tx.stockLedgerEntry.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: input.branchId,
      productId: product.id,
      batchId,
      serialId,
      // A SNAPSHOT of what the product required today. See the model comment:
      // a product that becomes serialised next year did not require a serial
      // for a movement made now.
      trackingMode: mode,
      movementType: input.movementType,
      quantityBase,
      quantityEntered: statusTo === null ? negate(input.quantity) : input.quantity,
      unitId: input.unitId ?? product.baseUnitId,
      fromLocationId: statusFrom === null ? null : location.id,
      toLocationId: statusTo === null ? null : location.id,
      statusFrom,
      statusTo,
      reasonCode: input.reasonCode ?? null,
      reasonNote: input.reasonNote ?? null,
      referenceType: input.referenceType ?? 'MANUAL',
      referenceId: input.referenceId ?? null,
      unitCostBase: input.unitCostBase ?? null,
      currency: input.currency ?? null,
      actorUserId: ctx.userId,
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    },
    select: { id: true, quantityBase: true },
  });

  await deps.recordAudit(tx, ctx, {
    action: 'CREATE',
    entityType: 'stock_ledger',
    entityId: movement.id,
    branchId: input.branchId,
    after: {
      productId: product.id,
      batchId,
      serialId,
      movementType: input.movementType,
      quantityBase: movement.quantityBase.toString(),
      locationId: location.id,
      statusFrom,
      statusTo,
      reasonCode: input.reasonCode ?? null,
    },
    ...options,
  });

  /*
   * Read the buckets back rather than computing what they should now be. The
   * trigger is the authority on what happened, and a service that predicted the
   * answer would agree with the trigger right up until the day one of them
   * changed.
   */
  const statuses = [statusFrom, statusTo].filter((s): s is StockStatus => s !== null);
  const balances = await tx.stockBalance.findMany({
    where: {
      branchId: input.branchId,
      productId: product.id,
      batchId,
      serialId,
      locationId: location.id,
      status: { in: statuses },
    },
    select: { locationId: true, status: true, quantity: true },
  });

  return {
    movementId: movement.id,
    quantityBase: movement.quantityBase.toString(),
    balances: balances.map((b) => ({
      locationId: b.locationId,
      status: b.status,
      quantity: b.quantity.toString(),
    })),
  };
}

/**
 * The `withTenant` wrapper lives in `apps/api/src/services/inventory/
 * movement.service.ts`, not here.
 *
 * ⚠️ ON PURPOSE. Opening a transaction is a decision about the unit of work, and
 *   the two callers make it differently: an HTTP request wraps one movement,
 *   while the expiry sweep writes many inside a transaction it already holds. A
 *   convenience wrapper in this file would be the one the sweep reached for, and
 *   a movement that can commit independently of the thing that caused it is a
 *   movement that will, on the day the cause rolls back.
 */
