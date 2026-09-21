/**
 * The reservation sweep: give back stock nobody came for (PI-3.4).
 *
 * The twin of `expiry.processor.ts`, and deliberately written as a twin — the
 * discovery query, the per-branch fan-out, the narrow tenant context and the
 * two layers of error catching are all the same, because the failure modes are
 * the same. What differs is documented where it differs and nowhere else.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 * A reservation moves quantity from `AVAILABLE` into `RESERVED`. One that nobody
 * releases holds it there for ever, and the clinic's only symptom is that it
 * cannot dispense a medicine it can see on the shelf. No error, no warning, just
 * a number smaller than the boxes on the rack.
 *
 * ── WHAT IS DIFFERENT FROM THE EXPIRY SWEEP ─────────────────────────────────
 * ⚠️ NO TIMEZONE ANYWHERE, AND THAT IS THE COLUMN'S TYPE RATHER THAN AN
 *   OVERSIGHT. A lot expires on a calendar DAY, which is a different instant at
 *   every clinic, so that sweep resolves `branches.timezone` in SQL. A
 *   reservation expires at an INSTANT somebody chose, and an instant is the same
 *   instant everywhere. Invariant 6 is satisfied by `expires_at` being a
 *   `Timestamptz` and by nothing in this file composing a date.
 *
 * ⚠️ IT MOVES STOCK **BACK INTO** THE DISPENSABLE POOL, WHERE THE EXPIRY SWEEP
 *   MOVES IT OUT. So the dangerous direction is reversed: expiry failing leaves
 *   an expired vial offerable, while this failing leaves good stock unofferable.
 *   The second is the less alarming of the two and it is still a clinic unable
 *   to dispense, which is why it runs hourly rather than nightly.
 *
 * ⚠️ NO PHI IN A LOG LINE OR A JOB PAYLOAD. Ids and counts. A reservation cites
 *   a `reference_id` that will be a prescription in PI-7; it is never logged
 *   beside anything that names a person, and no patient id appears in this
 *   domain at all.
 */
import { unsafeDbClient } from '@rcln/db/unsafe';
import { withTenant, type TenantContext } from '@rcln/db';
import {
  sweepExpiredReservations as sweepBranch,
  type ReservationSweepResult,
} from '@rcln/inventory';
import type { Logger } from 'pino';
import { movementDeps } from './deps.js';

/**
 * How many branches one tick looks at.
 *
 * A cap, not a filter: a platform with more due branches gets the rest on the
 * next tick, and the sweep is idempotent so nothing is lost. Same reasoning and
 * same number as the expiry sweep's.
 */
const BRANCHES_PER_TICK = 200;

interface DueBranch {
  branch_id: string;
  organization_id: string;
  actor_user_id: string;
}

/**
 * Ask which branches are holding stock past its reservation, and sweep each.
 *
 * ⚠️ THE DISCOVERY QUERY IS THE ONE UNSCOPED READ, AND IT IS AS NARROW AS THE
 *   QUESTION ALLOWS. A scheduler has to look at every clinic; that is what makes
 *   it a scheduler. `inventory_branches_with_due_reservations` is SECURITY
 *   DEFINER, returns three ids for only the branches actually due, takes no
 *   argument that widens it, and `rcln_app` keeps NOBYPASSRLS. Everything after
 *   it runs inside `withTenant`, under exactly the RLS a request would have got.
 */
export async function sweepDueReservations(logger: Logger): Promise<void> {
  const prisma = unsafeDbClient();

  const due = await prisma.$queryRaw<DueBranch[]>`
    SELECT branch_id, organization_id, actor_user_id
      FROM inventory_branches_with_due_reservations(${BRANCHES_PER_TICK})
  `;

  if (due.length === 0) {
    logger.debug('reservation sweep: nothing has run out of time');
    return;
  }

  logger.info({ branches: due.length }, 'reservation sweep: branches with due reservations');

  let swept = 0;
  let failed = 0;

  for (const branch of due) {
    const ctx: TenantContext = {
      organizationId: branch.organization_id,
      // ⚠️ EXACTLY ONE BRANCH IN SCOPE, so a bug in the engine cannot reach
      //   another site's stock even within the same organization.
      branchIds: [branch.branch_id],
      userId: branch.actor_user_id,
    };

    try {
      /*
       * `withTenant` is handed to the engine rather than wrapping the call,
       * because the engine opens ONE TRANSACTION PER RESERVATION — an advisory
       * bucket lock is held to COMMIT, and a single transaction covering fifty
       * releases accumulates fifty locks in expiry order, which is not lock
       * order. Measured on the expiry sweep in PI-2; not re-discovered here.
       */
      const result: ReservationSweepResult = await sweepBranch(
        ctx,
        movementDeps,
        withTenant,
        branch.branch_id,
        (reservation, error) => {
          logger.error(
            {
              organizationId: branch.organization_id,
              branchId: branch.branch_id,
              reservationId: reservation.id,
              locationId: reservation.locationId,
              err: error,
            },
            'reservation sweep: reservation failed'
          );
        }
      );
      swept += 1;

      /* After the releases for this branch, so a hold released on this tick is
       * already gone when the orders are checked. */
      await expireAbandonedOrders(ctx, branch.branch_id, logger);

      if (result.released > 0 || result.failed > 0) {
        logger.info(
          {
            organizationId: branch.organization_id,
            branchId: branch.branch_id,
            released: result.released,
            failed: result.failed,
          },
          'reservation sweep: stock released'
        );
      }
    } catch (err: unknown) {
      /*
       * Caught per branch on top of the per-reservation catch inside the engine.
       * One clinic's bad row must not stop every other clinic's stock being
       * released — and it would, silently, because BullMQ would retry the whole
       * tick and fail at the same branch every time.
       */
      failed += 1;
      logger.error(
        { organizationId: branch.organization_id, branchId: branch.branch_id, err },
        'reservation sweep: branch failed'
      );
    }
  }

  logger.info({ swept, failed, considered: due.length }, 'reservation sweep finished');
}

/**
 * An order whose hold lapsed stops claiming to be confirmed (PI-24).
 *
 * ⚠️ THE SWEEP ABOVE RELEASES A HOLD AND KNOWS NOTHING ABOUT WHAT PLACED IT, and
 *   that is correct — `@rcln/inventory` is the movement engine and has no
 *   business knowing what an online order is. The consequence was that an order
 *   nobody packed kept saying CONFIRMED for ever while its stock had gone back
 *   to the shelf: the screen said a parcel was coming, and the shelf disagreed.
 *   KNOWN_ISSUES #23.
 *
 * ⚠️ SO IT IS A SECOND PASS HERE, IN THE WORKER, WHERE THE PHARMACY DOMAIN IS
 *   ALLOWED TO BE KNOWN. It runs after the releases for the same branch, so a
 *   hold released this tick is already gone by the time the orders are checked.
 *
 * ⚠️ `EXPIRED`, NOT `DRAFT` AND NOT `CANCELLED`. A draft carries no order number
 *   — the CHECK constraint says so — and rolling back would destroy the
 *   reference the patient was given. A cancellation carries a reason somebody
 *   wrote, and nobody wrote one. The hold expired; that is its own fact.
 */
export async function expireAbandonedOrders(
  ctx: TenantContext,
  branchId: string,
  logger: Logger
): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const confirmed = await tx.onlineOrder.findMany({
      where: { organizationId: ctx.organizationId, branchId, status: 'CONFIRMED' },
      select: { id: true, lines: { select: { id: true } } },
    });
    if (confirmed.length === 0) return 0;

    /*
     * ⚠️ THE HOLDS ARE KEYED ON THE LINE, NOT THE ORDER. `stock_reservations`
     *   carries `reference_type = 'ONLINE_ORDER'` with the LINE's id in
     *   `reference_id` — one hold per line per lot — so asking about the order
     *   id would match nothing and expire every confirmed order on the platform.
     */
    const lineIds = confirmed.flatMap((order) => order.lines.map((line) => line.id));
    if (lineIds.length === 0) return 0;

    const stillHeld = new Set(
      (
        await tx.stockReservation.findMany({
          where: {
            organizationId: ctx.organizationId,
            referenceType: 'ONLINE_ORDER',
            referenceId: { in: lineIds },
            status: 'ACTIVE',
          },
          select: { referenceId: true },
        })
      ).map((row) => row.referenceId)
    );

    const abandoned = confirmed.filter(
      (order) => !order.lines.some((line) => stillHeld.has(line.id))
    );
    if (abandoned.length === 0) return 0;

    await tx.onlineOrder.updateMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: abandoned.map((order) => order.id) },
        /* Re-asserted, because somebody may have packed one between the read
         * and here — and packing is exactly what must not be overwritten. */
        status: 'CONFIRMED',
      },
      data: { status: 'EXPIRED' },
    });

    /*
     * ⚠️ WRITTEN DIRECTLY RATHER THAN THROUGH `movementDeps.recordAudit`, which
     *   is typed to the one action the movement engine ever takes (`CREATE`).
     *   Widening that interface so a status change could borrow it would make
     *   the engine's contract answer a question it does not ask.
     */
    for (const order of abandoned) {
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'UPDATE',
          entityType: 'online_order',
          entityId: order.id,
          branchId,
          beforeData: { status: 'CONFIRMED' },
          afterData: { status: 'EXPIRED', reason: 'stock hold expired' },
        },
      });
    }

    logger.info(
      { organizationId: ctx.organizationId, branchId, expired: abandoned.length },
      'reservation sweep: abandoned orders expired'
    );
    return abandoned.length;
  });
}
