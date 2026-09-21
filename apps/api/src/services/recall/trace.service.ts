/**
 * Traceability: the nine questions the data model exists to answer, in two
 * directions (PI-10).
 *
 *   BACKWARD   "where did this come from"   lot -> receipt -> order -> supplier
 *   FORWARD    "where did this go"          lot -> balances, dispenses, procedures
 *
 * Traceability owns no tables. It is a set of QUERIES, and TRACEABILITY.md says
 * so at the top: several columns in PI-2 exist purely so these can be written.
 * Every one of them is an indexed read —
 * `(organization_id, batch_id)` on `dispense_allocations` and
 * `consumption_allocations`, and `(organization_id, reference_type,
 * reference_id)` on `stock_ledger` — because the forward walk happens while
 * somebody is on the phone to a regulator.
 *
 * ── THE LINE THIS FILE IS BUILT AROUND ──────────────────────────────────────
 * ⚠️ THE FORWARD TRACE ANSWERS IN COUNTS AND THE AFFECTED-PARTY LIST ANSWERS IN
 *   NAMES, AND THEY ARE TWO ROUTES, TWO PERMISSIONS AND TWO AUDIT STORIES.
 *
 *   TRACEABILITY.md § "Patient linkage and its limits" is explicit about all
 *   three halves of this:
 *
 *     1. The LINK always exists in the data. A dispense cites a patient; without
 *        it a recall cannot reach the people who took the product, which is the
 *        whole purpose of a recall. So it is never omitted from the model.
 *     2. WHO MAY SEE IT is an access-control question — `recall.trace.patients`,
 *        which nothing else implies — and it is `recordDataAccess` territory.
 *     3. Whether CONTACTING them is required is a regulatory question, answered
 *        by a rule per jurisdiction and not by a hard-coded policy here. No such
 *        rule type exists in PI-5; the call site is marked in `recall.service.ts`.
 *
 * ⚠️ AND `listAffectedParties` IS THE BROADEST PHI READ THIS PLATFORM SERVES.
 *   Every other disclosure in this codebase is one patient, or a search that
 *   named one. This is "everybody who received lot AB12" — dozens of
 *   identifiable people in one response, to a storekeeper. It files ONE
 *   `data_access_logs` row of resource `RECALL_TRACE` carrying the COUNT, which
 *   is why that member exists rather than reusing `PRESCRIPTION`.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AffectedParty,
  AffectedPartyQuery,
  AffectedPartyResponse,
  BackwardTraceQuery,
  BackwardTraceResponse,
  ForwardTraceQuery,
  ForwardTraceResponse,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { toCalendarDate } from '../product/values.js';
import { q } from './shared.js';
import type { RecallActionOptions } from './shared.js';

/**
 * The lot or the device, resolved once.
 *
 * ⚠️ A SERIAL NARROWS TO ONE UNIT AND A BATCH WIDENS TO THE LOT, and the two are
 *   never mixed. Tracing serial 7742 must not return the history of the whole
 *   lot it came from: the question "which patient has THIS device" is the one a
 *   device recall is answered with, and a lot-wide answer to it names people who
 *   received a different unit.
 */
interface TraceSubject {
  batchId: string | null;
  serialId: string | null;
  productId: string;
  productName: string;
  baseUnitSymbol: string;
  lotNumber: string | null;
  serialNumber: string | null;
  manufacturerName: string | null;
  manufacturedOn: Date | null;
  expiresOn: Date | null;
}

async function resolveSubject(
  tx: TxClient,
  input: { batchId?: string | undefined; serialId?: string | undefined }
): Promise<TraceSubject> {
  if (input.serialId !== undefined) {
    const serial = await tx.serial.findUnique({
      where: { id: input.serialId },
      select: {
        id: true,
        serialNumber: true,
        expiresOn: true,
        productId: true,
        product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
        batch: {
          select: {
            lotNumber: true,
            manufacturedOn: true,
            expiresOn: true,
            manufacturer: { select: { name: true } },
          },
        },
      },
    });
    if (!serial) throw new NotFoundError('Serial');
    return {
      batchId: null,
      serialId: serial.id,
      productId: serial.productId,
      productName: serial.product.name,
      baseUnitSymbol: serial.product.baseUnit.symbol,
      lotNumber: serial.batch?.lotNumber ?? null,
      serialNumber: serial.serialNumber,
      manufacturerName: serial.batch?.manufacturer?.name ?? null,
      manufacturedOn: serial.batch?.manufacturedOn ?? null,
      expiresOn: serial.expiresOn ?? serial.batch?.expiresOn ?? null,
    };
  }

  if (input.batchId === undefined) {
    // Unreachable through the contract, which refines for exactly one subject.
    // Stated rather than left as an undefined read, for the day a second caller
    // reaches this function without going through the route.
    throw new ValidationError('Name exactly one of batchId or serialId.');
  }

  const batch = await tx.batch.findUnique({
    where: { id: input.batchId },
    select: {
      id: true,
      lotNumber: true,
      manufacturedOn: true,
      expiresOn: true,
      productId: true,
      product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
      manufacturer: { select: { name: true } },
    },
  });
  if (!batch) throw new NotFoundError('Batch');
  return {
    batchId: batch.id,
    serialId: null,
    productId: batch.productId,
    productName: batch.product.name,
    baseUnitSymbol: batch.product.baseUnit.symbol,
    lotNumber: batch.lotNumber,
    serialNumber: null,
    manufacturerName: batch.manufacturer?.name ?? null,
    manufacturedOn: batch.manufacturedOn,
    expiresOn: batch.expiresOn,
  };
}

/** The `where` that selects allocations for whichever subject was named. */
function allocationWhere(subject: {
  batchId: string | null;
  serialId: string | null;
}): { batchId: string } | { serialId: string } {
  return subject.serialId !== null
    ? { serialId: subject.serialId }
    : { batchId: subject.batchId as string };
}

// ---------------------------------------------------------------------------
// Forward — "where did this go"
// ---------------------------------------------------------------------------

/**
 * ⚠️ NO `recordDataAccess` ROW, AND THAT IS CORRECT RATHER THAN AN OMISSION.
 *   Nothing in this response identifies a person: `patientCount` is the SIZE of
 *   a set of ids that is discarded before the function returns. Filing a
 *   disclosure row for a read that discloses nobody would bury the reads that
 *   do — the same line `consumption.routes.ts` draws between its template routes
 *   and its record routes.
 */
export async function forwardTrace(
  ctx: TenantContext,
  query: ForwardTraceQuery
): Promise<ForwardTraceResponse> {
  return withTenant(ctx, async (tx) => {
    const subject = await resolveSubject(tx, query);
    const where = allocationWhere(subject);

    const [balances, dispenseAllocations, consumptionAllocations, movementCount] =
      await Promise.all([
        tx.stockBalance.findMany({
          where: { ...where, quantity: { gt: 0 } },
          select: {
            branchId: true,
            status: true,
            quantity: true,
            locationId: true,
            branch: { select: { name: true } },
            location: { select: { name: true } },
          },
        }),
        tx.dispenseAllocation.findMany({
          where,
          select: {
            quantityBase: true,
            dispenseLine: {
              select: { dispenseId: true, dispense: { select: { patientId: true } } },
            },
          },
        }),
        tx.consumptionAllocation.findMany({
          where,
          select: {
            quantityBase: true,
            consumptionLine: {
              select: { consumptionId: true, consumption: { select: { patientId: true } } },
            },
          },
        }),
        tx.stockLedgerEntry.count({ where }),
      ]);

    /*
     * ⚠️ THE PATIENT COUNT IS A SET, NOT A ROW COUNT, and the distinction is the
     *   number a clinic acts on. One person who collected the same lot three
     *   times is ONE person to contact; reporting three would put a figure on a
     *   regulator's form that overstates the exposure.
     *
     *   Ids only — no name is read, and none is logged. This response is served
     *   under `recall.notice.read`, which is not a PHI code.
     */
    const patients = new Set<string>();
    for (const row of dispenseAllocations) {
      const id = row.dispenseLine.dispense.patientId;
      if (id !== null) patients.add(id);
    }
    for (const row of consumptionAllocations) {
      patients.add(row.consumptionLine.consumption.patientId);
    }

    const dispensed = dispenseAllocations.reduce(
      (t, r) => t.add(r.quantityBase),
      new Prisma.Decimal(0)
    );
    const consumed = consumptionAllocations.reduce(
      (t, r) => t.add(r.quantityBase),
      new Prisma.Decimal(0)
    );

    return {
      batchId: subject.batchId,
      serialId: subject.serialId,
      lotNumber: subject.lotNumber,
      serialNumber: subject.serialNumber,
      productId: subject.productId,
      productName: subject.productName,
      baseUnitSymbol: subject.baseUnitSymbol,
      onHand: balances.map((b) => ({
        branchId: b.branchId,
        branchName: b.branch.name,
        locationId: b.locationId,
        locationName: b.location.name,
        status: b.status,
        quantityBase: q(b.quantity),
      })),
      quantityDispensedBase: q(dispensed),
      quantityConsumedBase: q(consumed),
      supplyCount: new Set(dispenseAllocations.map((r) => r.dispenseLine.dispenseId)).size,
      procedureCount: new Set(consumptionAllocations.map((r) => r.consumptionLine.consumptionId))
        .size,
      patientCount: patients.size,
      movementCount,
    };
  });
}

// ---------------------------------------------------------------------------
// Backward — "where did this come from"
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE SUPPLIER NAME COMES OFF THE RECEIPT, NOT OFF `suppliers`. PI-4
 *   snapshots it there precisely so the document reads as it did on the day; a
 *   supplier renamed or merged since would otherwise rewrite the history of
 *   every delivery it ever made.
 *
 * NO PHI. This direction is about paperwork, not people, which is why it needs
 * no `recordDataAccess` row and the forward one's sibling does.
 */
export async function backwardTrace(
  ctx: TenantContext,
  query: BackwardTraceQuery
): Promise<BackwardTraceResponse> {
  return withTenant(ctx, async (tx) => {
    const subject = await resolveSubject(tx, query);

    const lines = await tx.goodsReceiptLine.findMany({
      where:
        subject.serialId !== null ? { serialId: subject.serialId } : { batchId: subject.batchId },
      select: {
        receivedQuantityBase: true,
        goodsReceipt: {
          select: {
            id: true,
            receiptNumber: true,
            receivedAt: true,
            branchId: true,
            supplierId: true,
            supplierName: true,
            supplierInvoiceNumber: true,
            purchaseOrderId: true,
            branch: { select: { name: true } },
            purchaseOrder: { select: { orderNumber: true } },
          },
        },
      },
      orderBy: [{ goodsReceipt: { receivedAt: 'asc' } }],
    });

    return {
      batchId: subject.batchId,
      serialId: subject.serialId,
      lotNumber: subject.lotNumber,
      serialNumber: subject.serialNumber,
      productId: subject.productId,
      productName: subject.productName,
      manufacturerName: subject.manufacturerName,
      manufacturedOn:
        subject.manufacturedOn === null ? null : toCalendarDate(subject.manufacturedOn),
      expiresOn: subject.expiresOn === null ? null : toCalendarDate(subject.expiresOn),
      baseUnitSymbol: subject.baseUnitSymbol,
      receipts: lines.map((line) => ({
        goodsReceiptId: line.goodsReceipt.id,
        receiptNumber: line.goodsReceipt.receiptNumber,
        receivedAt: line.goodsReceipt.receivedAt.toISOString(),
        branchId: line.goodsReceipt.branchId,
        branchName: line.goodsReceipt.branch.name,
        supplierId: line.goodsReceipt.supplierId,
        supplierName: line.goodsReceipt.supplierName,
        supplierInvoiceNumber: line.goodsReceipt.supplierInvoiceNumber,
        purchaseOrderId: line.goodsReceipt.purchaseOrderId,
        purchaseOrderNumber: line.goodsReceipt.purchaseOrder?.orderNumber ?? null,
        receivedQuantityBase: q(line.receivedQuantityBase),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// The names
// ---------------------------------------------------------------------------

function patientName(patient: { firstName: string; lastName: string | null }): string {
  return `${patient.firstName} ${patient.lastName ?? ''}`.trim();
}

/**
 * Who has it. ⚠️ THE PHI ROUTE.
 *
 * ⚠️ SORTED NEWEST FIRST AND PAGINATED IN MEMORY, AND THAT IS A DELIBERATE
 *   TRADE-OFF RATHER THAN AN OVERSIGHT. The list is the UNION of two tables with
 *   different shapes; a database-side union would need raw SQL over both, and
 *   the set is bounded by what one lot can reach — a lot of a thousand strips
 *   dispensed thirty at a time is a few dozen rows. If a clinic ever produces a
 *   lot with tens of thousands of supplies, this becomes a raw UNION ALL with a
 *   keyset cursor; it is written down here rather than discovered.
 */
export async function listAffectedParties(
  ctx: TenantContext,
  query: AffectedPartyQuery,
  options: RecallActionOptions = {}
): Promise<AffectedPartyResponse> {
  return withTenant(ctx, async (tx) => {
    let subjects: { batchId: string | null; serialId: string | null }[];
    let baseUnitSymbol = '';

    if (query.recallId !== undefined) {
      const recall = await tx.recall.findUnique({
        where: { id: query.recallId },
        select: {
          product: { select: { baseUnit: { select: { symbol: true } } } },
          batches: { select: { batchId: true } },
        },
      });
      if (!recall) throw new NotFoundError('Recall');
      baseUnitSymbol = recall.product.baseUnit.symbol;
      subjects = recall.batches.map((b) => ({ batchId: b.batchId, serialId: null }));
    } else {
      const subject = await resolveSubject(tx, query);
      baseUnitSymbol = subject.baseUnitSymbol;
      subjects = [{ batchId: subject.batchId, serialId: subject.serialId }];
    }

    const batchIds = subjects.map((s) => s.batchId).filter((id): id is string => id !== null);
    const serialIds = subjects.map((s) => s.serialId).filter((id): id is string => id !== null);

    /*
     * ⚠️ AN EMPTY SCOPE MUST NOT BECOME AN UNFILTERED READ. `{ batchId: { in: [] } }`
     *   matches nothing, which is right — but a `where` assembled by spreading
     *   only the non-empty halves would collapse to `{}` and return every
     *   dispense the clinic has ever made, to a caller who asked about a recall
     *   with no lots in it yet.
     */
    const allocationWhereClause: Prisma.DispenseAllocationWhereInput = {
      OR: [{ batchId: { in: batchIds } }, { serialId: { in: serialIds } }],
    };

    const [dispenseRows, consumptionRows] = await Promise.all([
      tx.dispenseAllocation.findMany({
        where: allocationWhereClause,
        select: {
          quantityBase: true,
          batch: { select: { lotNumber: true } },
          serial: { select: { serialNumber: true } },
          dispenseLine: {
            select: {
              dispenseId: true,
              dispense: {
                select: {
                  id: true,
                  branchId: true,
                  dispensedAt: true,
                  patientId: true,
                  branch: { select: { name: true } },
                  patient: {
                    select: { id: true, firstName: true, lastName: true, uhid: true, phone: true },
                  },
                },
              },
            },
          },
        },
      }),
      tx.consumptionAllocation.findMany({
        where: {
          OR: [{ batchId: { in: batchIds } }, { serialId: { in: serialIds } }],
        },
        select: {
          quantityBase: true,
          batch: { select: { lotNumber: true } },
          serial: { select: { serialNumber: true } },
          consumptionLine: {
            select: {
              consumptionId: true,
              consumption: {
                select: {
                  id: true,
                  branchId: true,
                  occurredAt: true,
                  branch: { select: { name: true } },
                  patient: {
                    select: { id: true, firstName: true, lastName: true, uhid: true, phone: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const items: AffectedParty[] = [];

    for (const row of dispenseRows) {
      const dispense = row.dispenseLine.dispense;
      /*
       * ⚠️ AN OVER-THE-COUNTER SUPPLY HAS NO PATIENT, AND IT IS SKIPPED RATHER
       *   THAN RENDERED AS "unknown". `dispenses.patient_id` is nullable for
       *   exactly that case; a row with no person on it is not an affected party
       *   a clinic can contact, and padding the list with them would make the
       *   count on a regulator's form wrong in the direction that matters.
       *   The forward trace's `supplyCount` still counts it.
       */
      if (dispense.patient === null) continue;
      items.push({
        route: 'DISPENSE',
        occurredAt: dispense.dispensedAt.toISOString(),
        branchId: dispense.branchId,
        branchName: dispense.branch.name,
        patientId: dispense.patient.id,
        patientName: patientName(dispense.patient),
        patientPhone: dispense.patient.phone,
        patientCode: dispense.patient.uhid,
        lotNumber: row.batch?.lotNumber ?? null,
        serialNumber: row.serial?.serialNumber ?? null,
        quantityBase: q(row.quantityBase),
        sourceId: dispense.id,
      });
    }

    for (const row of consumptionRows) {
      const consumption = row.consumptionLine.consumption;
      items.push({
        route: 'CONSUMPTION',
        occurredAt: consumption.occurredAt.toISOString(),
        branchId: consumption.branchId,
        branchName: consumption.branch.name,
        patientId: consumption.patient.id,
        patientName: patientName(consumption.patient),
        patientPhone: consumption.patient.phone,
        patientCode: consumption.patient.uhid,
        lotNumber: row.batch?.lotNumber ?? null,
        serialNumber: row.serial?.serialNumber ?? null,
        quantityBase: q(row.quantityBase),
        sourceId: consumption.id,
      });
    }

    items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    const page = items.slice((query.page - 1) * query.limit, query.page * query.limit);

    /*
     * ⚠️ ONE ROW, CARRYING THE COUNT, AND NOT ONE PER PATIENT. A disclosure
     *   review asks "who pulled the affected-patient list for lot AB12" — that
     *   is one act by one person — and thirty-seven rows would bury it under the
     *   very reads it exists to surface. `resultCount` is what makes the SIZE of
     *   the disclosure legible.
     *
     * ⚠️ AND `patientId` IS DELIBERATELY UNSET. Naming one of the thirty-seven
     *   would be arbitrary and would make the row read as a single-patient
     *   lookup, which is the opposite of what happened.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'RECALL_TRACE',
      resultCount: page.length,
      ...(query.recallId !== undefined ? { resourceId: query.recallId } : {}),
      ...(query.batchId !== undefined ? { resourceId: query.batchId } : {}),
      ...(query.serialId !== undefined ? { resourceId: query.serialId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      items: page,
      total: items.length,
      page: query.page,
      limit: query.limit,
      baseUnitSymbol,
    };
  });
}
