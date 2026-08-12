/**
 * The expiry sweep — THE FIRST REAL PROCESSOR IN THIS WORKER THAT CHANGES
 * CLINICAL STATE.
 *
 * Documents render a PDF of a decision already made. Billing charges a card.
 * This one moves stock from `AVAILABLE` to `EXPIRED`, which is the difference
 * between a pharmacist being offered an expired vial and not.
 *
 * ── WHY A SWEEP AND NOT A JOB PER BATCH ─────────────────────────────────────
 * A delayed job per lot means one scheduled job per batch in the platform, each
 * needing cancelling and rescheduling whenever an expiry is corrected, a lot is
 * quarantined, or stock is transferred. The state that decides when a lot
 * expires already lives in `batches.expires_on`; the sweep reads it, so there is
 * one source of truth and nothing to keep in step. Same reasoning as the billing
 * sweep, written down in that processor's header.
 *
 * ── SAFE TO RUN TWICE, ALWAYS ───────────────────────────────────────────────
 * The sweep only ever moves what is CURRENTLY in the `AVAILABLE` bucket of an
 * already-expired lot, so a second run on the same day finds nothing — the first
 * run emptied it. Idempotence is a property of the query, not of a
 * `last_swept_at` column that would be a second source of truth about work the
 * ledger already records.
 *
 * ── THE THINGS THAT ARE EASY TO GET WRONG HERE ──────────────────────────────
 * ⚠️ "TODAY" IS THE BRANCH'S TODAY. This container runs UTC. The day comparison
 *   happens in SQL beside `branches.timezone` — see `@rcln/inventory`'s
 *   `sweepExpiredStockIn`. Nothing in this file composes a date.
 *
 * ⚠️ THE ACTOR IS A REAL USER. `stock_ledger.actor_user_id` is NOT NULL, and the
 *   discovery function returns the organization's OWNER for exactly this. An
 *   organization with no owner is not swept rather than being attributed to an
 *   invented system id — the same decision `InvoicePdfJob.requestedBy` forced.
 *
 * ⚠️ ONE BRANCH FAILING MUST NOT TAKE THE REST DOWN. The fan-out is per branch
 *   and each is caught and logged, because the alternative is that one clinic's
 *   bad row stops every other clinic's stock expiring — silently, since the job
 *   would just be retried and fail again at the same branch.
 *
 * ⚠️ NO PHI IN A LOG LINE OR A JOB PAYLOAD. Ids and counts. A job payload is
 *   JSON in Redis, persisted to disk, and echoed into the log line of every
 *   failure.
 */
import { unsafeDbClient } from '@rcln/db/unsafe';
import { withTenant, type TenantContext } from '@rcln/db';
import { sweepExpiredStock as sweepBranch, type SweepResult } from '@rcln/inventory';
import type { Logger } from 'pino';
import { movementDeps } from './deps.js';

/**
 * How many branches one tick looks at.
 *
 * ⚠️ A CAP, NOT A FILTER, AND THE LOOP BELOW IS WHAT MAKES IT SAFE. A platform
 *   with more due branches than this gets the rest on the next tick; the sweep
 *   is idempotent, so nothing is lost. Treating one call as draining the queue
 *   would leave the tail permanently unswept.
 */
const BRANCHES_PER_TICK = 200;

interface DueBranch {
  branch_id: string;
  organization_id: string;
  actor_user_id: string;
}

/**
 * Ask which branches are holding expired stock, and sweep each.
 *
 * ⚠️ THE DISCOVERY QUERY IS THE ONE UNSCOPED READ, AND IT IS AS NARROW AS THE
 *   QUESTION ALLOWS. A scheduler has to look at every clinic; that is what makes
 *   it a scheduler. `inventory_branches_with_expired_stock` is a SECURITY
 *   DEFINER function returning three ids for only the branches that are actually
 *   due, and `rcln_app` keeps NOBYPASSRLS. The alternatives — widening a policy,
 *   or handing the worker an owner connection — and why each was rejected are
 *   recorded in the `inventory_expiry_sweep_function` migration.
 *
 *   Everything after the discovery runs inside `withTenant`, under exactly the
 *   RLS a request would have got.
 */
export async function sweepExpiredStock(logger: Logger): Promise<void> {
  const prisma = unsafeDbClient();

  const due = await prisma.$queryRaw<DueBranch[]>`
    SELECT branch_id, organization_id, actor_user_id
      FROM inventory_branches_with_expired_stock(${BRANCHES_PER_TICK})
  `;

  if (due.length === 0) {
    logger.debug('expiry sweep: nothing has expired');
    return;
  }

  logger.info({ branches: due.length }, 'expiry sweep: branches with expired stock');

  let swept = 0;
  let failed = 0;

  for (const branch of due) {
    const ctx: TenantContext = {
      organizationId: branch.organization_id,
      // ⚠️ EXACTLY ONE BRANCH IN SCOPE. The sweep's tenant context is the
      //   narrowest one that can do its job, so a bug in the engine cannot reach
      //   another site's stock even within the same organization.
      branchIds: [branch.branch_id],
      userId: branch.actor_user_id,
    };

    try {
      /*
       * ⚠️ `withTenant` IS HANDED TO THE ENGINE RATHER THAN WRAPPING THE CALL,
       *   AND THE ENGINE OPENS ONE TRANSACTION PER BUCKET. An advisory lock is
       *   held to COMMIT, so a single transaction covering every expired bucket
       *   accumulates locks in expiry order — which is not lock order — and can
       *   deadlock against a concurrent status transition, rolling back the
       *   whole branch. See the package's header.
       *
       * ⚠️ A BUCKET THAT FAILS IS COUNTED, LOGGED AND STEPPED OVER. One bad lot
       *   must not stop the other four hundred.
       */
      const result: SweepResult = await sweepBranch(
        ctx,
        movementDeps,
        withTenant,
        branch.branch_id,
        (bucket, error) => {
          logger.error(
            {
              organizationId: branch.organization_id,
              branchId: branch.branch_id,
              batchId: bucket.batchId,
              locationId: bucket.locationId,
              err: error,
            },
            'expiry sweep: bucket failed'
          );
        }
      );
      swept += 1;

      if (result.movementsWritten > 0 || result.bucketsFailed > 0) {
        logger.info(
          {
            organizationId: branch.organization_id,
            branchId: branch.branch_id,
            asOf: result.asOf,
            batches: result.batchesExpired,
            movements: result.movementsWritten,
            failed: result.bucketsFailed,
          },
          'expiry sweep: stock expired'
        );
      }
    } catch (err: unknown) {
      /*
       * Caught per branch, on top of the per-bucket catch inside the engine.
       * This one only fires if the DISCOVERY read fails — one clinic's bad row
       * must not stop every other clinic's stock expiring, and it would,
       * silently, because BullMQ would simply retry the whole tick and fail at
       * the same branch every time.
       */
      failed += 1;
      logger.error(
        { organizationId: branch.organization_id, branchId: branch.branch_id, err },
        'expiry sweep: branch failed'
      );
    }
  }

  logger.info({ swept, failed, considered: due.length }, 'expiry sweep finished');
}
