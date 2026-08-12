/**
 * The reservation sweep: give back stock nobody came for (PI-3.4).
 *
 * A reservation moves quantity from `AVAILABLE` into `RESERVED`. One that nobody
 * releases holds it there for ever, and the clinic's only visible symptom is
 * that it cannot dispense a medicine it can see on the shelf — no error, no
 * warning, just a number that is smaller than the boxes on the rack. That is why
 * `expires_at` is NOT NULL and why this exists.
 *
 * ── SAME SHAPE AS THE EXPIRY SWEEP, AND FOR THE SAME REASONS ────────────────
 * It lives in this package rather than in `apps/worker` because it writes
 * movements, and PI-ADR-004 says `recordMovementIn` is the only thing that does.
 * It takes `run` rather than importing `withTenant`, so the caller decides the
 * unit of work. And it opens ONE TRANSACTION PER RESERVATION:
 *
 * ⚠️ AN ADVISORY LOCK IS HELD UNTIL COMMIT, so a single transaction covering
 *   fifty reservations accumulates fifty bucket locks in expiry order — which is
 *   not lock order — and can deadlock against a concurrent dispense, rolling
 *   back the whole branch. Measured in PI-2 on the expiry sweep; not
 *   re-discovered here.
 *
 * ── WHY "TODAY" DOES NOT APPEAR ANYWHERE IN THIS FILE ───────────────────────
 * ⚠️ `expires_at` IS A `Timestamptz`, NOT A DATE, WHICH IS THE OPPOSITE OF THE
 *   EXPIRY SWEEP'S PROBLEM AND MAKES IT SIMPLER. A lot expires on a DAY in the
 *   branch's calendar, so that sweep has to resolve the branch's timezone in
 *   SQL. A reservation expires at an INSTANT that somebody chose, and an instant
 *   is the same instant everywhere: `expires_at <= now()` is correct in any
 *   timezone and needs no branch join at all. Invariant 6 is satisfied by
 *   storing it in UTC and never composing a date here.
 *
 * ── SAFE TO RUN TWICE ───────────────────────────────────────────────────────
 * The query selects only `ACTIVE` reservations, and releasing one sets `EXPIRED`
 * in the same transaction as its movement. A second run finds nothing.
 *
 * NO PHI. A reservation names ids, a quantity and a place.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import { recordMovementIn, type MovementDeps } from './movement.js';
import type { RunInTenant } from './expiry.js';

/** One reservation that has run out of time. */
export interface DueReservation {
  id: string;
  branchId: string;
  productId: string;
  batchId: string | null;
  serialId: string | null;
  locationId: string;
  quantityBase: string;
}

export interface ReservationSweepResult {
  branchId: string;
  released: number;
  /**
   * Reservations that could not be released. Non-zero means a later tick has
   * work left — the sweep reports rather than pretending it finished.
   */
  failed: number;
}

/**
 * ⚠️ READ IN ITS OWN TRANSACTION, AND THE LIST GOING STALE IS HARMLESS. A
 *   reservation released by a person between this read and its own write is no
 *   longer `ACTIVE`, so the conditional update below matches nothing and the
 *   movement is skipped — the set only ever shrinks, exactly as the expiry
 *   sweep's does.
 */
export async function findDueReservations(
  tx: TxClient,
  branchId: string
): Promise<DueReservation[]> {
  const rows = await tx.stockReservation.findMany({
    where: { branchId, status: 'ACTIVE', expiresAt: { lte: new Date() } },
    select: {
      id: true,
      branchId: true,
      productId: true,
      batchId: true,
      serialId: true,
      locationId: true,
      quantityBase: true,
    },
    orderBy: { expiresAt: 'asc' },
  });

  return rows.map((r) => ({
    id: r.id,
    branchId: r.branchId,
    productId: r.productId,
    batchId: r.batchId,
    serialId: r.serialId,
    locationId: r.locationId,
    quantityBase: r.quantityBase.toString(),
  }));
}

/**
 * Release one, and mark it expired with it.
 *
 * ⚠️ THE STATUS UPDATE IS CONDITIONAL ON IT STILL BEING `ACTIVE`, AND THAT IS
 *   WHAT MAKES A CONCURRENT MANUAL RELEASE SAFE. `updateMany` with the status in
 *   the predicate returns a count; zero means somebody released it between the
 *   discovery read and here, and the movement must NOT be written — writing it
 *   would return the same quantity to `AVAILABLE` twice, which the ledger would
 *   happily record and which would leave the clinic holding stock it does not
 *   have.
 *
 *   So the update comes FIRST and the movement second, which is the reverse of
 *   `reserveStock`'s order and is reversed for exactly this reason: there, the
 *   movement is the thing that can fail and must fail before a row is claimed;
 *   here, the row is the thing that decides whether the movement happens at all.
 */
export async function releaseDueReservation(
  tx: TxClient,
  ctx: TenantContext,
  deps: MovementDeps,
  reservation: DueReservation
): Promise<boolean> {
  const claimed = await tx.stockReservation.updateMany({
    where: { id: reservation.id, status: 'ACTIVE' },
    data: {
      status: 'EXPIRED',
      releasedAt: new Date(),
      // ⚠️ `released_by_id` STAYS NULL. That is how a screen tells "the sweep
      //   gave it back" from "a pharmacist did", and the two mean different
      //   things to whoever is asking why the stock is available again.
    },
  });
  if (claimed.count === 0) return false;

  await recordMovementIn(tx, ctx, deps, {
    branchId: reservation.branchId,
    productId: reservation.productId,
    batchId: reservation.batchId,
    serialId: reservation.serialId,
    movementType: 'RELEASE',
    quantity: reservation.quantityBase,
    locationId: reservation.locationId,
    statusFrom: 'RESERVED',
    statusTo: 'AVAILABLE',
    referenceType: 'MANUAL',
    referenceId: reservation.id,
    reasonNote: 'Reservation expired and was released automatically.',
  });

  return true;
}

/**
 * Sweep one branch: find what has run out of time, release each in its own
 * transaction.
 *
 * ⚠️ A FAILED RESERVATION IS COUNTED AND THE SWEEP CONTINUES. One reservation
 *   that lost a race must not stop the other four hundred — the same decision
 *   the expiry sweep made after its single-transaction version was found to
 *   abandon a whole branch on one bad bucket.
 */
export async function sweepExpiredReservations(
  ctx: TenantContext,
  deps: MovementDeps,
  run: RunInTenant,
  branchId: string,
  onError?: (reservation: DueReservation, error: unknown) => void
): Promise<ReservationSweepResult> {
  const due = await run(ctx, (tx) => findDueReservations(tx, branchId));

  let released = 0;
  let failed = 0;

  for (const reservation of due) {
    try {
      const done = await run(ctx, (tx) => releaseDueReservation(tx, ctx, deps, reservation));
      if (done) released += 1;
    } catch (error: unknown) {
      failed += 1;
      onError?.(reservation, error);
    }
  }

  return { branchId, released, failed };
}
