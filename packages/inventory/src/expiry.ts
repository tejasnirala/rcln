/**
 * The expiry sweep: moving what has expired at one branch into the `EXPIRED`
 * bucket.
 *
 * ⚠️ IT LIVES IN THIS PACKAGE BECAUSE THE WORKER RUNS IT. The API exposes an
 *   operator-triggered version of the same thing, injected with the same audit
 *   hook, so a nightly sweep and a manual one are literally the same code.
 *
 * ── INVARIANT 6, AND THIS IS WHERE IT ACTUALLY BITES ────────────────────────
 * ⚠️ "TODAY" IS THE BRANCH'S TODAY, NOT UTC'S AND NOT THE CONTAINER'S. A lot
 *   expiring on the 31st is good until the end of the 31st AT THE CLINIC. The
 *   API and the worker both run in UTC containers, so a sweep comparing
 *   `expires_on < CURRENT_DATE` would expire an Auckland clinic's stock thirteen
 *   hours early and a Los Angeles clinic's eight hours late — silently, and only
 *   for part of each day, which is the hardest kind of defect to be told about.
 *
 *   So the day is resolved IN SQL as `(now() AT TIME ZONE b.timezone)::date`,
 *   exactly as `availability.service.ts` already does for appointment slots. A
 *   `Date` composed in JavaScript would carry the container's zone into the
 *   comparison at whichever step nobody looked at.
 *
 * ── ONE TRANSACTION PER BUCKET, NOT ONE PER BRANCH ──────────────────────────
 * ⚠️ THIS IS A CORRECTION FROM THE PI-2 SECURITY REVIEW, AND IT IS ABOUT
 *   DEADLOCK. `recordMovementIn` takes an advisory lock per bucket, and an
 *   advisory *xact* lock is held until COMMIT. A sweep that moved every expired
 *   bucket inside ONE transaction therefore accumulated locks across iterations
 *   in `expires_on` order — an order sorted by date and not by lock key. Sorting
 *   inside a single statement, which is what makes an ordinary two-bucket
 *   movement deadlock-free, buys nothing across a loop.
 *
 *   A sweep holding bucket A and wanting B, against a concurrent status
 *   transition holding B and wanting A, deadlocks. Postgres aborts one, and if
 *   it aborts the sweep the ENTIRE branch rolls back — so that branch's stock
 *   stays dispensable past its expiry until some later tick happens to win.
 *
 *   So the loop is driven by the CALLER, one transaction per bucket, and each
 *   iteration is then exactly the same shape as any other single movement:
 *   two keys, sorted, in one statement. It also stops a branch with thousands of
 *   expired buckets holding one long transaction against the hottest table in
 *   the programme.
 *
 *   ⚠️ PARTIAL COMPLETION IS SAFE, WHICH IS WHY THIS IS AFFORDABLE. The sweep is
 *     idempotent by construction — it only ever moves what is CURRENTLY in the
 *     `AVAILABLE` bucket of an expired lot — so a run that stops halfway leaves
 *     the finished half done and the rest for the next tick. That was already
 *     true; splitting the transaction is what makes it useful.
 *
 * ⚠️ EVERY MOVE GOES THROUGH `recordMovementIn`. There is no status change
 *   without a ledger row (PI-ADR-004), and the sweep is not privileged — it is
 *   simply automatic.
 *
 * ⚠️ THE ACTOR IS A REAL USER, PASSED IN. `stock_ledger.actor_user_id` is NOT
 *   NULL on purpose: a movement nobody can be asked about is a movement that
 *   ends an audit. The worker supplies the organization's owner rather than
 *   inventing a system id — the same decision `InvoicePdfJob.requestedBy`
 *   forced, for the same reason.
 *
 * NO PHI.
 */
import { type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import { recordMovementIn, type MovementDeps } from './movement.js';

export interface SweepResult {
  branchId: string;
  /** The branch's own calendar day the sweep ran for. */
  asOf: string;
  batchesExpired: number;
  movementsWritten: number;
  /**
   * Buckets that could not be moved. Non-zero means a later tick has work left
   * — the sweep reports rather than pretending it finished.
   */
  bucketsFailed: number;
}

/** One (product, lot, serial, shelf) holding of expired stock. */
export interface ExpiredBucket {
  batchId: string;
  productId: string;
  /**
   * ⚠️ SELECTED, AND THE ORIGINAL VERSION DID NOT SELECT IT. Without it a
   *   `SERIAL` or `LOT_AND_SERIAL` product's expired stock was passed to
   *   `recordMovementIn` with no serial, which refuses it by name — so ONE
   *   expired serialised device made the whole branch's sweep throw, and nothing
   *   at that branch ever expired again. Silent, because the processor catches
   *   per branch and logs. Found by the PI-2 security review.
   */
  serialId: string | null;
  locationId: string;
  quantity: string;
  /** The branch's own calendar day, resolved beside `branches.timezone`. */
  asOf: string;
}

interface DueRow {
  batch_id: string;
  product_id: string;
  serial_id: string | null;
  location_id: string;
  quantity: Prisma.Decimal;
  as_of: string;
}

/**
 * What has expired at one branch, as of the branch's own today.
 *
 * A read, and deliberately separate from the write: the caller opens one
 * transaction per bucket, and holding this query's transaction open across all
 * of them is the thing being avoided. Re-reading is cheap and the answer only
 * ever shrinks — anything moved between this read and its own write simply is
 * not in the AVAILABLE bucket any more, and the movement is refused with a 409
 * the caller counts rather than a lost update.
 */
export async function findExpiredBuckets(tx: TxClient, branchId: string): Promise<ExpiredBucket[]> {
  const due = await tx.$queryRaw<DueRow[]>`
    SELECT sb."batch_id"   AS batch_id,
           sb."product_id" AS product_id,
           sb."serial_id"  AS serial_id,
           sb."location_id",
           sb."quantity",
           to_char((now() AT TIME ZONE b."timezone")::date, 'YYYY-MM-DD') AS as_of
      FROM "stock_balances" sb
      JOIN "batches"  bt ON bt."id" = sb."batch_id"
      JOIN "branches" b  ON b."id"  = sb."branch_id"
     WHERE sb."branch_id" = ${branchId}::uuid
       AND sb."status"    = 'AVAILABLE'
       AND sb."quantity"  > 0
       AND bt."expires_on" IS NOT NULL
       -- ⚠️ STRICTLY BEFORE the branch's today. A lot dated the 31st is good
       --   THROUGH the 31st; less-than-or-equal would expire it at one minute
       --   past midnight on the morning it was still usable.
       AND bt."expires_on" < (now() AT TIME ZONE b."timezone")::date
     ORDER BY bt."expires_on" ASC
  `;

  return due.map((row) => ({
    batchId: row.batch_id,
    productId: row.product_id,
    serialId: row.serial_id,
    locationId: row.location_id,
    quantity: row.quantity.toString(),
    asOf: row.as_of,
  }));
}

/**
 * Move ONE bucket into `EXPIRED`, and mark its lot expired with it.
 *
 * The batch status follows the quantity in the SAME transaction as the movement
 * that made it true. A lot whose stock is in the EXPIRED bucket while the lot
 * still reads ACTIVE is the two-answers-to-one-question problem `setBatchHold`
 * exists to avoid, arrived at from the other direction.
 *
 * ⚠️ `updateMany` WITH `status: 'ACTIVE'` IN THE PREDICATE, NOT `update`. A lot
 *   with stock at three shelves is expired by three separate transactions; the
 *   second and third must be no-ops rather than restating a status they already
 *   set. It also leaves a QUARANTINED or RECALLED lot alone — expiry does not
 *   get to overwrite a hold somebody put on deliberately.
 */
export async function expireBucket(
  tx: TxClient,
  ctx: TenantContext,
  deps: MovementDeps,
  branchId: string,
  bucket: ExpiredBucket
): Promise<void> {
  await recordMovementIn(tx, ctx, deps, {
    branchId,
    productId: bucket.productId,
    batchId: bucket.batchId,
    serialId: bucket.serialId,
    movementType: 'EXPIRY',
    quantity: bucket.quantity,
    locationId: bucket.locationId,
    statusFrom: 'AVAILABLE',
    statusTo: 'EXPIRED',
    reasonCode: 'EXPIRED',
    reasonNote: `Expiry sweep for ${bucket.asOf} in the branch's timezone.`,
    referenceType: 'EXPIRY_SWEEP',
  });

  await tx.batch.updateMany({
    where: { id: bucket.batchId, status: 'ACTIVE' },
    data: { status: 'EXPIRED' },
  });
}

/**
 * How a caller opens one transaction. Supplied rather than imported, for the
 * same reason `MovementDeps` is: the API and the worker each have their own.
 */
export type RunInTenant = <T>(ctx: TenantContext, fn: (tx: TxClient) => Promise<T>) => Promise<T>;

/**
 * Sweep one branch: find what has expired, then move each bucket in its own
 * transaction.
 *
 * ⚠️ A FAILED BUCKET IS COUNTED AND THE SWEEP CONTINUES. One lot with a
 *   constraint problem, or one bucket that lost a race to a concurrent dispense,
 *   must not stop the other four hundred — which is exactly what the
 *   single-transaction version did. `bucketsFailed` is reported so a caller can
 *   log it rather than a run silently claiming to have finished.
 */
export async function sweepExpiredStock(
  ctx: TenantContext,
  deps: MovementDeps,
  run: RunInTenant,
  branchId: string,
  onError?: (bucket: ExpiredBucket, error: unknown) => void
): Promise<SweepResult> {
  const buckets = await run(ctx, (tx) => findExpiredBuckets(tx, branchId));

  const asOf = buckets[0]?.asOf ?? new Date().toISOString().slice(0, 10);
  const expiredBatches = new Set<string>();
  let moved = 0;
  let failed = 0;

  for (const bucket of buckets) {
    try {
      await run(ctx, (tx) => expireBucket(tx, ctx, deps, branchId, bucket));
      expiredBatches.add(bucket.batchId);
      moved += 1;
    } catch (error: unknown) {
      failed += 1;
      onError?.(bucket, error);
    }
  }

  return {
    branchId,
    asOf,
    batchesExpired: expiredBatches.size,
    movementsWritten: moved,
    bucketsFailed: failed,
  };
}
