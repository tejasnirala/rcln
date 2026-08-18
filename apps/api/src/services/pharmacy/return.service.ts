/**
 * Something came back over the counter.
 *
 * ⚠️ A RETURN NEVER EDITS THE DISPENSE IT CITES. It is a `RETURN` ledger movement
 *   plus a record — the same discipline the invoice engine applies with a credit
 *   note, and for the same reason: a supply that happened cannot be un-happened,
 *   only answered. The only thing the original row gains is a status derived from
 *   how much has come back.
 *
 * ⚠️ AND THE STOCK IS ALWAYS ACCEPTED. Refusing to take back a medicine somebody
 *   has physically brought in is not a thing a system may do; the boxes are on
 *   the counter either way. What is decided is WHERE IT GOES — back to
 *   `AVAILABLE`, or into `QUARANTINED`. Many jurisdictions forbid restocking a
 *   dispensed medicine outright, because once it has left nobody can attest to
 *   how it was stored, so the default is quarantine and both the clinic and the
 *   engine have to agree before anything is resold.
 *
 * ⚠️ FINANCIALLY THIS DOES NOTHING, DELIBERATELY. A credit note is the invoice
 *   engine's, through a charge request, in PI-8. Nothing here touches money.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { CreateDispenseReturnRequest, DispenseReturnDetail } from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordMovementIn } from '../inventory/movement.service.js';
import { reverseChargeForReturnWithin } from '../charging/charge-request.service.js';
import { consultForReturn } from './consult.js';
import { auditMeta, q, refreshFulfilment, resolveDispensingLocation } from './shared.js';
import { loadDispenseForReturn, refreshDispenseStatus } from './dispense.service.js';
import type { PharmacyActionOptions } from './queue.service.js';

export async function createDispenseReturn(
  ctx: TenantContext,
  dispenseId: string,
  body: CreateDispenseReturnRequest,
  options: PharmacyActionOptions = {}
): Promise<DispenseReturnDetail> {
  const returnId = await withTenant(ctx, async (tx) => {
    const dispense = await loadDispenseForReturn(tx, ctx.organizationId, dispenseId);
    const returnedAt = new Date();

    /*
     * ⚠️ THE COUNTER IT WENT OUT OF, UNLESS THE CLINIC SAYS OTHERWISE. A rushed
     *   screen that had to pick a shelf would pick the wrong one, and stock put
     *   back in the wrong place is stock a stocktake finds and a dispensary does
     *   not.
     */
    const location = await resolveDispensingLocation(
      tx,
      dispense.branchId,
      body.locationId ?? dispense.locationId
    );

    /*
     * ⚠️ SORTED, FOR THE REASON EVERY OTHER BUCKET-TOUCHING LOOP IN THIS
     *   CODEBASE IS: each leg takes an advisory lock held to COMMIT, and two
     *   returns touching overlapping lots in opposite orders deadlock.
     */
    const ordered = [...body.lines].sort((a, b) =>
      a.dispenseLineId.localeCompare(b.dispenseLineId)
    );

    const created = await tx.dispenseReturn.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: dispense.branchId,
        dispenseId: dispense.id,
        // Overwritten below once the engine has answered for the first line.
        disposition: 'QUARANTINED',
        locationId: location.id,
        reason: body.reason,
        returnedAt,
        receivedById: ctx.userId,
      },
      select: { id: true },
    });

    /*
     * ⚠️ TWO PASSES, AND THE FIRST ONE WRITES NO STOCK. The disposition is a
     *   property of the whole bundle that came back across the counter — a return
     *   where one product may be restocked and one may not is quarantined as a
     *   whole — so it cannot be known until every line has been asked about. A
     *   single pass would have written the first line's ledger leg into AVAILABLE
     *   and then discovered the document was a quarantine, leaving one lot back on
     *   a sellable shelf under a header that says it is not.
     */
    interface PlannedReturnLine {
      dispenseLineId: string;
      productId: string;
      productName: string;
      allocationId: string;
      batchId: string | null;
      serialId: string | null;
      quantity: Prisma.Decimal;
    }

    const planned: PlannedReturnLine[] = [];
    let disposition: 'RESTOCKED' | 'QUARANTINED' = body.requestRestock
      ? 'RESTOCKED'
      : 'QUARANTINED';
    let decisionId: string | null = null;
    const seen = new Set<string>();

    for (const line of ordered) {
      /*
       * ⚠️ ONE ENTRY PER LINE. Two entries naming one line both measure against
       *   the same stored `returned_quantity_base` and both pass, which is how
       *   PI-3's receipt loop minted stock. The request-level accumulation and
       *   the CHECK constraint are the other two layers.
       */
      if (seen.has(line.dispenseLineId)) {
        throw new ValidationError(
          'Each supplied line may appear once on a return. Two entries for one line have two readings and neither should be guessed.'
        );
      }
      seen.add(line.dispenseLineId);

      /*
       * ⚠️ THE ROW IS LOCKED BEFORE IT IS MEASURED, BECAUSE THE CEILING IS A
       *   READ-THEN-WRITE. `outstanding` is computed below from the stored
       *   `returned_quantity_base` and applied as an `increment`, so two returns
       *   against one line that both start before either commits BOTH read the
       *   same untouched figure, both pass the check, and both increment — ten
       *   supplied become twenty returned. The `seen` set above closes the
       *   within-request half of this; the lock closes the across-request half.
       *
       *   The CHECK constraint (`returned_quantity_base <= quantity_base`) does
       *   stop the corruption, so this was never a data defect. What it was is a
       *   Postgres 23514 reaching `errorHandler`, which narrows
       *   `PrismaClientKnownRequestError` by `code` and has no case for a CHECK
       *   violation — so the loser got a 500 saying the system broke instead of
       *   the ValidationError written twenty lines below saying that stock
       *   already came back. Same lock idiom as `lockChargeRequest`.
       */
      await lockDispenseLine(tx, line.dispenseLineId);

      const dispenseLine = await tx.dispenseLine.findFirst({
        where: {
          id: line.dispenseLineId,
          organizationId: ctx.organizationId,
          dispenseId: dispense.id,
        },
        select: {
          id: true,
          productId: true,
          quantityBase: true,
          returnedQuantityBase: true,
          product: { select: { name: true } },
          allocations: {
            select: {
              id: true,
              batchId: true,
              serialId: true,
              quantityBase: true,
              batch: { select: { lotNumber: true, expiresOn: true } },
              serial: { select: { serialNumber: true } },
            },
          },
        },
      });
      if (!dispenseLine) throw new NotFoundError('Dispensed line');

      const quantity = new Prisma.Decimal(line.quantityBase);
      const outstanding = dispenseLine.quantityBase.sub(dispenseLine.returnedQuantityBase);
      if (quantity.gt(outstanding)) {
        throw new ValidationError(
          `Only ${outstanding.toString()} of the ${dispenseLine.product.name} supplied is still out. ` +
            'More cannot come back than went out.'
        );
      }

      /*
       * ⚠️ BACK INTO THE LOT IT CAME OUT OF. Returning stock to the wrong bucket
       *   makes a recall miss the units it went looking for — the whole reason
       *   `dispense_allocations` exists. Where the line came out of exactly one
       *   lot the answer is unambiguous and the caller need not say.
       */
      const allocation = line.dispenseAllocationId
        ? dispenseLine.allocations.find((row) => row.id === line.dispenseAllocationId)
        : dispenseLine.allocations.length === 1
          ? dispenseLine.allocations[0]
          : undefined;

      if (!allocation) {
        throw new ValidationError(
          `Say which lot of ${dispenseLine.product.name} is coming back. It went out of ` +
            `${String(dispenseLine.allocations.length)} different lots, and stock returned to the ` +
            'wrong one is stock a recall will not find.'
        );
      }
      if (quantity.gt(allocation.quantityBase)) {
        throw new ValidationError(
          `Only ${allocation.quantityBase.toString()} of the ${dispenseLine.product.name} came out of that lot.`
        );
      }

      const answer = await consultForReturn(tx, ctx, {
        branchId: dispense.branchId,
        productId: dispenseLine.productId,
        locationId: location.id,
        quantityBase: q(quantity),
        occurredAt: returnedAt,
        documentId: created.id,
        requestRestock: body.requestRestock,
        actor: { roleCodes: options.roleCodes ?? [] },
        traceability: {
          lotNumber: allocation.batch?.lotNumber ?? null,
          expiresOn: allocation.batch?.expiresOn?.toISOString().slice(0, 10) ?? null,
          serial: allocation.serial?.serialNumber ?? null,
        },
      });

      // The strictest answer on the document wins. See the two-pass note above.
      if (answer.disposition === 'QUARANTINED') disposition = 'QUARANTINED';
      decisionId = decisionId ?? answer.decisionId;

      planned.push({
        dispenseLineId: dispenseLine.id,
        productId: dispenseLine.productId,
        productName: dispenseLine.product.name,
        allocationId: allocation.id,
        batchId: allocation.batchId,
        serialId: allocation.serialId,
        quantity,
      });
    }

    /* Collected so the reversal charges can cite the return lines by id (PI-8). */
    const reversals: {
      dispenseReturnLineId: string;
      originalDispenseLineId: string;
      productId: string;
      quantityBase: string;
    }[] = [];

    for (const line of planned) {
      const returnLine = await tx.dispenseReturnLine.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: dispense.branchId,
          dispenseReturnId: created.id,
          dispenseLineId: line.dispenseLineId,
          dispenseAllocationId: line.allocationId,
          quantityBase: line.quantity,
        },
        select: { id: true },
      });

      reversals.push({
        dispenseReturnLineId: returnLine.id,
        originalDispenseLineId: line.dispenseLineId,
        productId: line.productId,
        quantityBase: q(line.quantity),
      });

      await tx.dispenseLine.update({
        where: { id: line.dispenseLineId },
        // `increment`, never an absolute assignment computed from a stale read.
        data: { returnedQuantityBase: { increment: line.quantity } },
      });

      /*
       * ⚠️ ONE `RETURN` LEG PER LOT, AND ITS `status_to` IS THE DOCUMENT'S
       *   DISPOSITION. The movement type is `RETURN` — coming back from a patient,
       *   INTO stock — and never `PURCHASE_RETURN`, which means "went back to the
       *   supplier" to every report that reads the column.
       */
      await recordMovementIn(tx, ctx, {
        branchId: dispense.branchId,
        productId: line.productId,
        batchId: line.batchId,
        serialId: line.serialId,
        movementType: 'RETURN',
        quantity: q(line.quantity),
        locationId: location.id,
        statusTo: disposition === 'RESTOCKED' ? 'AVAILABLE' : 'QUARANTINED',
        referenceType: 'DISPENSE',
        referenceId: dispense.id,
        occurredAt: returnedAt,
      });

      /*
       * A device that came back is `RETURNED` and is nobody's any more. ⚠️ The
       * patient link is CLEARED: "serial 7742 is in Mrs Rao" stops being true the
       * moment it is handed back, and leaving it set would have a recall knocking
       * on the wrong door.
       */
      if (line.serialId) {
        await tx.serial.update({
          where: { id: line.serialId },
          data: { status: 'RETURNED', assignedPatientId: null },
        });
      }
    }

    await tx.dispenseReturn.update({
      where: { id: created.id },
      data: { disposition, ...(decisionId ? { regulatoryDecisionId: decisionId } : {}) },
    });

    await refreshDispenseStatus(tx, dispense.id);

    /*
     * ⚠️ THE MONEY SIDE OF THE RETURN (PI-8), AFTER `refreshDispenseStatus` AND
     *   AFTER THE `returned_quantity_base` INCREMENTS ABOVE — WHICH IS THE
     *   ORDERING THAT MAKES IT CORRECT. `reverseChargeForReturnWithin` decides
     *   whether the original charge is cancelled by comparing the line's RUNNING
     *   returned total against what was supplied, and reading that before the
     *   increment would see the previous state: a return that completes a line
     *   would look partial, and the charge for stock now entirely back on the
     *   shelf would stay on the queue for somebody to bill.
     *
     * ⚠️ IT NEVER EDITS AN ISSUED INVOICE. Where the original charge has not
     *   reached a bill it is CANCELLED — nothing was owed, so nothing is
     *   credited. Where it has, the reversal stays PENDING and becomes a CREDIT
     *   NOTE through `services/invoicing/credit-note.service.ts`, because the
     *   lifecycle guard refuses an edit and because an issued invoice may have
     *   been claimed against insurance.
     */
    await reverseChargeForReturnWithin(tx, ctx, {
      branchId: dispense.branchId,
      /* Explicit since PI-9 gave the engine its second caller. */
      sourceType: 'PHARMACY',
      patientId: dispense.patientId,
      occurredAt: returnedAt,
      lines: reversals,
    });

    const encounter = await tx.dispense.findUnique({
      where: { id: dispense.id },
      select: { encounterId: true },
    });
    if (encounter?.encounterId) {
      await refreshFulfilment(tx, ctx, encounter.encounterId, dispense.branchId);
    }

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'dispense_return',
      entityId: created.id,
      branchId: dispense.branchId,
      after: {
        dispenseId: dispense.id,
        disposition,
        lineCount: ordered.length,
        locationId: location.id,
      },
      ...auditMeta(options),
    });

    return created.id;
  });

  return getDispenseReturn(ctx, returnId);
}

export async function getDispenseReturn(
  ctx: TenantContext,
  id: string
): Promise<DispenseReturnDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.dispenseReturn.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        dispense: { select: { dispenseNumber: true } },
        location: { select: { name: true } },
        receivedBy: { select: { fullName: true } },
        regulatoryDecision: { select: { reasons: true } },
        lines: {
          include: {
            dispenseLine: {
              select: {
                productId: true,
                product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundError('Return');

    const reasons = Array.isArray(row.regulatoryDecision?.reasons)
      ? (row.regulatoryDecision.reasons as { outcome?: string; message?: string }[])
      : [];

    return {
      id: row.id,
      dispenseId: row.dispenseId,
      dispenseNumber: row.dispense.dispenseNumber,
      branchId: row.branchId,
      disposition: row.disposition,
      dispositionMessages: reasons
        .filter((reason) => reason.outcome !== 'PERMITTED')
        .map((reason) => reason.message ?? '')
        .filter((message) => message.length > 0),
      locationId: row.locationId,
      locationName: row.location.name,
      reason: row.reason,
      returnedAt: row.returnedAt.toISOString(),
      receivedByName: row.receivedBy.fullName,
      lines: row.lines.map((line) => ({
        id: line.id,
        dispenseLineId: line.dispenseLineId,
        dispenseAllocationId: line.dispenseAllocationId,
        productId: line.dispenseLine.productId,
        productName: line.dispenseLine.product.name,
        quantityBase: q(line.quantityBase),
        baseUnitSymbol: line.dispenseLine.product.baseUnit.symbol,
      })),
    };
  });
}

/**
 * Take the row lock the return ceiling is measured under.
 *
 * ⚠️ `FOR UPDATE` ON THE LINE, TAKEN INSIDE THE POSTING TRANSACTION, so it is
 *   released by COMMIT without anybody remembering to — and RLS applies to it, so
 *   a lock on another tenant's id locks nothing and the read that follows 404s,
 *   which is the answer every other path in this service gives. Lines are locked
 *   in the request's own `ordered` sequence, which `createDispenseReturn` sorts,
 *   so two concurrent returns naming the same pair of lines cannot take them in
 *   opposite orders and deadlock.
 */
async function lockDispenseLine(tx: TxClient, dispenseLineId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM dispense_lines WHERE id = ${dispenseLineId}::uuid FOR UPDATE
  `;
}
