/**
 * The dispensary at a glance.
 *
 * ⚠️ COUNTS AND NOTHING ELSE, AND THAT IS A PRIVACY DECISION RATHER THAN A
 *   SCOPING ONE. This is the screen most likely to be left open on a counter
 *   that a waiting room can see, and "waiting: Mrs Rao — methadone" is a
 *   disclosure to everybody standing behind her. Names live one click away, on a
 *   screen somebody chose to open — and that click writes a `data_access_logs`
 *   row, which is the second reason the summary does not pre-empt it.
 *
 * ⚠️ NO `recordDataAccess` FROM HERE, DELIBERATELY. The rule is to log a read
 *   that discloses clinical content or singles out one patient's record; a count
 *   of eleven prescriptions waiting is neither, and logging it would turn that
 *   table into a per-poll firehose — the same call the appointment day board
 *   made.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type { PharmacyDashboardQuery, PharmacyDashboardResponse } from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { resolveBranchId } from './shared.js';
import type { PharmacyActionOptions } from './queue.service.js';

/** How far ahead "expiring soon" looks. A month is a dispensary's ordering cycle. */
const EXPIRY_HORIZON_DAYS = 30;

export async function getPharmacyDashboard(
  ctx: TenantContext,
  query: PharmacyDashboardQuery,
  options: PharmacyActionOptions = {}
): Promise<PharmacyDashboardResponse> {
  const branchId = resolveBranchId(ctx, query.branchId, options.actingBranchId);

  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, organizationId: ctx.organizationId },
      select: { id: true, name: true },
    });
    if (!branch) throw new NotFoundError('Branch');

    /*
     * ⚠️ THE DAY BOUNDARY IS UTC HERE AND THE BRANCH'S ELSEWHERE, WHICH IS A
     *   KNOWN ROUGH EDGE ON A COUNTER. "Dispensed today" straddling midnight in a
     *   clinic several hours off UTC will read a few hours early or late; the
     *   expiry SWEEP resolves the branch's own day in SQL because a lot expiring
     *   is a fact with consequences, and a count on a dashboard is not. Recorded
     *   rather than silently accepted — invariant 6's exception list is short and
     *   this is on it.
     */
    const startOfToday = new Date(new Date().toISOString().slice(0, 10));
    const horizon = new Date(startOfToday);
    horizon.setUTCDate(horizon.getUTCDate() + EXPIRY_HORIZON_DAYS);

    const [
      awaitingVerification,
      verifiedAwaitingSupply,
      partiallyDispensed,
      dispensedToday,
      returnsToday,
      expiringSoonBatches,
      quarantinedBatches,
      recalledBatches,
    ] = await Promise.all([
      /*
       * A finalized consultation that prescribed something and has no dispensary
       * row yet. `fulfilment: { is: null }` IS the `NEW` state — see the enum
       * comment on why `NEW` is never stored.
       */
      tx.encounter.count({
        where: {
          organizationId: ctx.organizationId,
          deletedAt: null,
          status: 'FINALIZED',
          branchId,
          prescriptions: { some: {} },
          fulfilment: { is: null },
        },
      }),
      tx.prescriptionFulfilment.count({
        where: { organizationId: ctx.organizationId, branchId, status: 'VERIFIED' },
      }),
      tx.prescriptionFulfilment.count({
        where: { organizationId: ctx.organizationId, branchId, status: 'PARTIALLY_DISPENSED' },
      }),
      tx.dispense.count({
        where: { organizationId: ctx.organizationId, branchId, dispensedAt: { gte: startOfToday } },
      }),
      tx.dispenseReturn.count({
        where: { organizationId: ctx.organizationId, branchId, returnedAt: { gte: startOfToday } },
      }),
      tx.batch.count({
        where: {
          organizationId: ctx.organizationId,
          branchId,
          status: 'ACTIVE',
          expiresOn: { gte: startOfToday, lt: horizon },
        },
      }),
      tx.batch.count({
        where: { organizationId: ctx.organizationId, branchId, status: 'QUARANTINED' },
      }),
      tx.batch.count({
        where: { organizationId: ctx.organizationId, branchId, status: 'RECALLED' },
      }),
    ]);

    return {
      branchId: branch.id,
      branchName: branch.name,
      awaitingVerification,
      verifiedAwaitingSupply,
      partiallyDispensed,
      dispensedToday,
      returnsToday,
      expiringSoonBatches,
      quarantinedBatches,
      recalledBatches,
    };
  });
}
