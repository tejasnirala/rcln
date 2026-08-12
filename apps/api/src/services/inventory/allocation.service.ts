/**
 * FEFO allocation: which lots would be used, without using them (PI-3.5).
 *
 * ⚠️ THIS SERVICE WRITES NOTHING. Not a ledger row, not a reservation, not an
 *   audit row. It reads the candidate buckets and hands them to `planAllocation`
 *   in `@rcln/inventory`, which orders them and walks down the list. A caller
 *   that needs the stock HELD asks for a reservation; asking for a plan holds
 *   nothing, and two callers planning at once get the same answer.
 *
 *   That is not a limitation, it is the design. The dispensing screen shows
 *   which batch it will use and lets a pharmacist override it with a reason —
 *   an allocation that commits silently is one nobody can question, and "why did
 *   it give out the lot expiring next week instead of the one expiring tomorrow"
 *   gets asked.
 *
 * ── THE ORDERING LIVES IN THE PACKAGE, NOT HERE ─────────────────────────────
 * Deliberately. Ordering rules are wrong in ways no integration test notices — a
 * tie broken the wrong way dispenses the second-oldest lot, which looks entirely
 * normal until an audit asks why the oldest expired on the shelf. A pure
 * function in `@rcln/inventory` is testable against every tie, every null and
 * every shortfall. What is left here is the READ: which buckets are candidates
 * at all, which is a tenancy and a status question rather than an ordering one.
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext } from '@rcln/db';
import type { AllocationPlanRequest, AllocationPlanResponse } from '@rcln/contracts';
import {
  planAllocation,
  resolveStrategy,
  toBaseUnits,
  type AllocationCandidate,
} from '@rcln/inventory';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { movementDeps } from './movement.service.js';

function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

export async function planStockAllocation(
  ctx: TenantContext,
  input: AllocationPlanRequest
): Promise<AllocationPlanResponse> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: {
        id: true,
        name: true,
        baseUnitId: true,
        allocationStrategy: true,
        isStockItem: true,
        deletedAt: true,
        baseUnit: { select: { code: true, symbol: true } },
      },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so there is nothing to allocate. A consultation fee is a product to billing and never to inventory.`
      );
    }

    const requestedQuantityBase = await toBaseUnits(
      tx,
      movementDeps,
      { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
      input
    );

    const { strategy, source } = resolveStrategy(input.strategy, product.allocationStrategy);

    /*
     * ⚠️ THE FILTER IS THE WHOLE OF "WHAT MAY GO OUT", AND EVERY CLAUSE IS
     *   LOAD-BEARING. `planAllocation` trusts the list it is given and will
     *   happily allocate an expired lot if one is in it — which is correct, and
     *   is why deciding candidacy is this file's job:
     *
     *     status AVAILABLE     RESERVED, QUARANTINED, EXPIRED, DAMAGED,
     *                          RECALLED and IN_TRANSIT are all visible,
     *                          countable and valued, and NONE of them is
     *                          dispensable. That is the entire point of the
     *                          status axis (PI-ADR-013).
     *     quantity > 0         a fully-issued bucket leaves a zero row behind.
     *     location active      stock on a decommissioned shelf is somewhere
     *                          else by now.
     *     batch ACTIVE         a QUARANTINED or RECALLED lot has quantity in
     *                          the AVAILABLE bucket only until the hold
     *                          movement runs, and half a recalled lot going out
     *                          in that window is the exact failure a recall
     *                          exists to prevent.
     *     not expired          `expires_on >= today`, compared as DAYS. See
     *                          below.
     *
     *   PI-5's rule packs will narrow this further — a jurisdiction may forbid
     *   dispensing within N days of expiry — and they narrow it HERE, before the
     *   ordering runs. A rule that reordered rather than excluded would be
     *   overriding a decision a clinic made on purpose.
     */
    const balances = await tx.stockBalance.findMany({
      where: {
        branchId: input.branchId,
        productId: input.productId,
        status: 'AVAILABLE',
        quantity: { gt: 0 },
        ...(input.locationId != null ? { locationId: input.locationId } : {}),
        location: { isActive: true, deletedAt: null },
        OR: [
          { batchId: null },
          {
            batch: {
              status: 'ACTIVE',
              /*
               * ⚠️ `expiresOn` IS A `@db.Date` AND THE COMPARISON IS AGAINST A
               *   DAY, NOT AN INSTANT. A lot expiring today is still
               *   dispensable today — the date printed on the pack is the last
               *   day of use — so the test is `>= today`, and `today` is built
               *   from an ISO date string rather than from `new Date()` so the
               *   container's clock time cannot push a midnight query into
               *   yesterday. The BRANCH's day is what the expiry SWEEP resolves,
               *   in SQL; here the worst case is that a lot expiring today
               *   stays allocatable for a few hours longer at one site, which
               *   the sweep then corrects.
               */
              OR: [
                { expiresOn: null },
                { expiresOn: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
              ],
            },
          },
        ],
      },
      include: {
        location: { select: { name: true } },
        batch: { select: { lotNumber: true, expiresOn: true, receivedAt: true } },
        serial: { select: { serialNumber: true } },
      },
    });

    /*
     * ⚠️ NOTHING IS SUBTRACTED FOR RESERVATIONS, AND THAT IS NOT AN OMISSION.
     *   A `RESERVATION` movement moves quantity OUT of AVAILABLE and into
     *   RESERVED, so the AVAILABLE rows this query just read are already net of
     *   every active hold. Subtracting `stock_reservations` on top would
     *   double-count them and make the clinic look short of stock it is holding.
     *
     *   This is worth a paragraph because the opposite is true in most systems,
     *   where a reservation is a flag beside a quantity rather than a bucket the
     *   quantity moves into. Here the status axis does the work (PI-ADR-013),
     *   and the reservation ROW is the paperwork explaining who holds it — which
     *   is what a "why can I not dispense this" screen reads, and is not a number
     *   allocation needs.
     */

    const candidates: AllocationCandidate[] = balances.map((b) => ({
      locationId: b.locationId,
      batchId: b.batchId,
      serialId: b.serialId,
      availableQuantityBase: b.quantity.toString(),
      expiresOn: b.batch?.expiresOn?.toISOString().slice(0, 10) ?? null,
      /*
       * A bucket with no lot has no arrival date of its own, so the tie-break
       * falls back to the epoch — which orders untracked stock FIRST under FIFO
       * and is the honest answer: there is exactly one such bucket per
       * (location, status) and nothing to break a tie against.
       */
      receivedAt: (b.batch?.receivedAt ?? new Date(0)).toISOString(),
    }));

    const plan = planAllocation(candidates, requestedQuantityBase, strategy);

    const byBucket = new Map(
      balances.map((b) => [`${b.locationId}|${b.batchId ?? '-'}|${b.serialId ?? '-'}`, b])
    );

    return {
      productId: product.id,
      productName: product.name,
      baseUnitSymbol: product.baseUnit.symbol,
      requestedQuantityBase: plan.requestedQuantityBase,
      allocatedQuantityBase: plan.allocatedQuantityBase,
      shortfallQuantityBase: plan.shortfallQuantityBase,
      strategy,
      strategySource: source,
      lines: plan.lines.map((line) => {
        const key = `${line.candidate.locationId}|${line.candidate.batchId ?? '-'}|${line.candidate.serialId ?? '-'}`;
        const balance = byBucket.get(key);
        return {
          locationId: line.candidate.locationId,
          locationName: balance?.location.name ?? '',
          batchId: line.candidate.batchId,
          lotNumber: balance?.batch?.lotNumber ?? null,
          expiresOn: line.candidate.expiresOn,
          serialId: line.candidate.serialId,
          serialNumber: balance?.serial?.serialNumber ?? null,
          quantityBase: line.quantityBase,
          availableQuantityBase: (balance?.quantity ?? new Prisma.Decimal(0)).toString(),
        };
      }),
    };
  });
}
