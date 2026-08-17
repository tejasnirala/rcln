/**
 * The supply itself — the highest-risk write in this programme.
 *
 * ── ONE TRANSACTION, AND WHAT IS IN IT ──────────────────────────────────────
 * A dispense has no draft (see the header on `pharmacy.prisma`): the medicine
 * leaves the shelf and goes into somebody's hand once. So `createDispense` opens
 * a single transaction and, per line, in this order:
 *
 *   1. re-assert the world           product, prescription, shelf — all of it
 *                                    was true when the workspace loaded and any
 *                                    of it may have changed since
 *   2. convert the quantity          through the one `toBaseUnits` the ledger
 *                                    uses; the caller never states base units
 *   3. plan or honour the allocation FEFO, or the lots a pharmacist chose, with
 *                                    a reason for anything that departs from it
 *   4. ASK THE LAW                   before any stock moves, and snapshot the
 *                                    answer (PI-ADR-008)
 *   5. move the stock                one `DISPENSING` leg per allocated lot,
 *                                    through `recordMovementIn` and nothing else
 *   6. issue the number              at the end, so a refusal burns none
 *   7. write the record + audit      and the queue row moves on
 *
 * ⚠️ STEP 4 BEFORE STEP 5, ALWAYS. Asking after the movement would mean a refused
 *   line had already taken stock off the shelf, and the correction would depend
 *   on the transaction rolling back rather than on the order of the calls — true
 *   today, and precisely the assumption that breaks the first time somebody
 *   splits this loop across two functions. Goods receipt has the same note.
 *
 * ⚠️ AND NOTHING HERE PRICES ANYTHING. Pharmacy owns no rate (PI-ADR-005/006).
 *   The hand-off to billing is a `charge_request` and it arrives in PI-8; there
 *   is no invoice line written from this file and no money column on any table it
 *   writes.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * A dispense is the densest PHI in the product: a named person, a medicine, a
 * day. Reads log through `recordDataAccess`; the audit row carries ids and
 * counts; no log line from this file names a patient or a product.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateDispenseRequest,
  DispenseDetail,
  DispenseLineRequest,
  DispenseListResponse,
  DispenseQuery,
  DispenseSummary,
  EvaluateRegulatoryRequest,
} from '@rcln/contracts';
import { toBaseUnits } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { movementDeps, recordMovementIn } from '../inventory/movement.service.js';
import { planStockAllocationWithin } from '../inventory/allocation.service.js';
import { raiseChargeRequestsWithin } from '../charging/charge-request.service.js';
import { consultForSupply } from './consult.js';
import {
  ageYearsOn,
  auditMeta,
  q,
  refreshFulfilment,
  resolveBranchId,
  resolveDispensingLocation,
} from './shared.js';
import type { PharmacyActionOptions } from './queue.service.js';

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

const detailInclude = Prisma.validator<Prisma.DispenseInclude>()({
  branch: { select: { name: true } },
  location: { select: { name: true } },
  dispensedBy: { select: { fullName: true } },
  patient: { select: { firstName: true, lastName: true, uhid: true } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
      substitutedForProduct: { select: { name: true } },
      unit: { select: { symbol: true } },
      regulatoryDecision: true,
      allocations: {
        orderBy: { createdAt: 'asc' },
        include: {
          location: { select: { name: true } },
          batch: { select: { lotNumber: true, expiresOn: true } },
          serial: { select: { serialNumber: true } },
        },
      },
    },
  },
  returns: {
    orderBy: { returnedAt: 'desc' },
    include: {
      receivedBy: { select: { fullName: true } },
      lines: { include: { dispenseLine: { include: { product: { select: { name: true } } } } } },
    },
  },
});

type DetailRow = Prisma.DispenseGetPayload<{ include: typeof detailInclude }>;

/** A patient's name from its two halves. Users carry one `full_name` instead. */
function patientName(patient: { firstName: string; lastName: string | null }): string {
  return patient.lastName ? `${patient.firstName} ${patient.lastName}` : patient.firstName;
}

/**
 * The stored decision, back in the shape the counter reads.
 *
 * ⚠️ READ OFF THE SNAPSHOT AND NEVER RE-EVALUATED (PI-ADR-008). Re-running the
 *   engine over a two-year-old dispense must never be necessary and must never
 *   change what it says — the rules may have been superseded twice since, and
 *   the record has to keep saying what it said on the day.
 */
function decisionFromSnapshot(row: DetailRow['lines'][number]['regulatoryDecision']): {
  outcome: 'PERMITTED' | 'PERMITTED_WITH_CONDITIONS' | 'REFUSED' | 'UNDETERMINED';
  messages: string[];
  conditions: { kind: string; detail: string }[];
  lowestPackMaturity: DetailRow['lines'][number]['regulatoryDecision']['lowestPackMaturity'];
  wasEnforced: boolean;
} {
  const reasons = Array.isArray(row.reasons)
    ? (row.reasons as { outcome?: string; message?: string }[])
    : [];
  const conditions = Array.isArray(row.conditions)
    ? (row.conditions as { kind?: string; detail?: string }[])
    : [];
  return {
    outcome: row.outcome,
    messages: reasons
      .filter((reason) => reason.outcome !== 'PERMITTED')
      .map((reason) => reason.message ?? '')
      .filter((message) => message.length > 0),
    conditions: conditions.map((condition) => ({
      kind: condition.kind ?? 'UNKNOWN',
      detail: condition.detail ?? '',
    })),
    lowestPackMaturity: row.lowestPackMaturity,
    wasEnforced: row.wasEnforced,
  };
}

function toSummary(row: DetailRow): DispenseSummary {
  return {
    id: row.id,
    dispenseNumber: row.dispenseNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    kind: row.kind,
    status: row.status,
    encounterId: row.encounterId,
    patientId: row.patientId,
    patientName: row.patient ? patientName(row.patient) : null,
    patientUhid: row.patient?.uhid ?? null,
    locationId: row.locationId,
    locationName: row.location.name,
    dispensedAt: row.dispensedAt.toISOString(),
    dispensedByName: row.dispensedBy.fullName,
    lineCount: row.lines.length,
    hasConditions: row.lines.some(
      (line) => decisionFromSnapshot(line.regulatoryDecision).conditions.length > 0
    ),
  };
}

function toDetail(row: DetailRow): DispenseDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      encounterPrescriptionId: line.encounterPrescriptionId,
      productId: line.productId,
      productName: line.product.name,
      substitutedForProductId: line.substitutedForProductId,
      substitutedForProductName: line.substitutedForProduct?.name ?? null,
      substitutionReason: line.substitutionReason,
      quantityEntered: q(line.quantityEntered),
      unitId: line.unitId,
      unitSymbol: line.unit.symbol,
      quantityBase: q(line.quantityBase),
      baseUnitSymbol: line.product.baseUnit.symbol,
      returnedQuantityBase: q(line.returnedQuantityBase),
      labelInstructions: line.labelInstructions,
      decision: decisionFromSnapshot(line.regulatoryDecision),
      allocations: line.allocations.map((allocation) => ({
        id: allocation.id,
        locationId: allocation.locationId,
        locationName: allocation.location.name,
        batchId: allocation.batchId,
        lotNumber: allocation.batch?.lotNumber ?? null,
        expiresOn: allocation.batch?.expiresOn?.toISOString().slice(0, 10) ?? null,
        serialId: allocation.serialId,
        serialNumber: allocation.serial?.serialNumber ?? null,
        quantityBase: q(allocation.quantityBase),
        isOverride: allocation.isOverride,
        overrideReason: allocation.overrideReason,
      })),
    })),
    returns: row.returns.map((ret) => ({
      id: ret.id,
      returnedAt: ret.returnedAt.toISOString(),
      receivedByName: ret.receivedBy.fullName,
      disposition: ret.disposition,
      reason: ret.reason,
      lines: ret.lines.map((line) => ({
        id: line.id,
        dispenseLineId: line.dispenseLineId,
        productName: line.dispenseLine.product.name,
        quantityBase: q(line.quantityBase),
      })),
    })),
  };
}

export async function listDispenses(
  ctx: TenantContext,
  query: DispenseQuery,
  options: PharmacyActionOptions = {}
): Promise<DispenseListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.DispenseWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.encounterId ? { encounterId: query.encounterId } : {}),
      ...(query.productId ? { lines: { some: { productId: query.productId } } } : {}),
      ...(query.from || query.to
        ? {
            dispensedAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.dispense.count({ where }),
      tx.dispense.findMany({
        where,
        orderBy: { dispensedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: detailInclude,
      }),
    ]);

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PRESCRIPTION',
      resultCount: rows.length,
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      dispenses: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getDispense(
  ctx: TenantContext,
  id: string,
  options: PharmacyActionOptions = {}
): Promise<DispenseDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.dispense.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: detailInclude,
    });
    if (!row) throw new NotFoundError('Dispense');

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PRESCRIPTION',
      resourceId: row.id,
      branchId: row.branchId,
      ...(row.patientId !== null ? { patientId: row.patientId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return toDetail(row);
  });
}

// ---------------------------------------------------------------------------
// The supply
// ---------------------------------------------------------------------------

interface ResolvedAllocation {
  locationId: string;
  batchId: string | null;
  serialId: string | null;
  quantityBase: Prisma.Decimal;
  isOverride: boolean;
  overrideReason: string | null;
  /** For the traceability evidence handed to the engine. */
  lotNumber: string | null;
  expiresOn: Date | null;
  serialNumber: string | null;
}

/**
 * Which lots this line comes out of.
 *
 * ⚠️ THE FEFO PLAN IS THE DEFAULT AND THE OVERRIDE IS RECORDED, NEVER REFUSED. A
 *   pharmacist has legitimate grounds to reach past the oldest lot — a damaged
 *   strip, matching a patient's own supply — and a system that forbids it gets
 *   worked around by keying a false quantity somewhere else.
 *
 * ⚠️ WHAT IS *NOT* NEGOTIABLE IS CANDIDACY. Whether a lot may go out at all —
 *   AVAILABLE, unexpired, an ACTIVE batch, an active location — belongs to the
 *   allocator's filter and is re-checked below for every lot a caller names.
 *   Expired, quarantined and recalled stock is refused from every route into
 *   this function, which is PI-7's first test.
 */
async function resolveAllocations(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  productId: string,
  productName: string,
  quantityBase: string,
  requested: DispenseLineRequest['allocations']
): Promise<ResolvedAllocation[]> {
  /*
   * ⚠️ THE PLAN IS NOT NARROWED TO THE COUNTER'S OWN LOCATION, WHICH IS WHY
   *   `locationId` IS ABSENT BELOW. A dispensary supplies out of the fridge and
   *   the controlled cabinet as well as the shelf behind it, and pinning the plan
   *   to the counter would report a shortfall while the stock sits ten feet away.
   *   The COUNTER is where the supply happened; the LOT is where each unit came
   *   from, and they are different facts.
   *
   * ⚠️ AND THE QUANTITY IS ALREADY IN BASE UNITS, SO NO `unitId` IS PASSED. The
   *   conversion happened once, above, through the same `toBaseUnits` the ledger
   *   legs use; converting again here would be a second answer to one question.
   */
  const plan = await planStockAllocationWithin(tx, ctx, {
    branchId,
    productId,
    quantity: quantityBase,
  });

  const candidates = new Map(
    plan.lines.map((line) => [
      `${line.locationId}|${line.batchId ?? '-'}|${line.serialId ?? '-'}`,
      line,
    ])
  );

  if (!requested || requested.length === 0) {
    if (new Prisma.Decimal(plan.shortfallQuantityBase).gt(0)) {
      throw new ValidationError(
        `There is not enough ${productName} on the shelf: ${plan.allocatedQuantityBase} of ` +
          `${plan.requestedQuantityBase} available. Expired, quarantined and recalled stock is ` +
          'deliberately not counted.'
      );
    }
    return plan.lines.map((line) => ({
      locationId: line.locationId,
      batchId: line.batchId,
      serialId: line.serialId,
      quantityBase: new Prisma.Decimal(line.quantityBase),
      isOverride: false,
      overrideReason: null,
      lotNumber: line.lotNumber,
      expiresOn: line.expiresOn === null ? null : new Date(line.expiresOn),
      serialNumber: line.serialNumber,
    }));
  }

  /*
   * A caller-supplied allocation is checked against the SAME candidate list the
   * plan was built from. A lot that is not in it is not dispensable — it is
   * expired, quarantined, recalled, on a decommissioned shelf, or somebody
   * else's — and the message deliberately does not say which, because a caller
   * probing lot ids should not learn what a clinic holds.
   */
  const out: ResolvedAllocation[] = [];
  let total = new Prisma.Decimal(0);

  for (const line of requested) {
    const key = `${line.locationId}|${line.batchId ?? '-'}|${line.serialId ?? '-'}`;
    const candidate = candidates.get(key);
    if (!candidate) {
      throw new ValidationError(
        `That lot of ${productName} cannot be supplied. It is expired, on hold, recalled or no ` +
          'longer where it was — reload the workspace and choose again.'
      );
    }
    const wanted = new Prisma.Decimal(line.quantityBase);
    if (wanted.gt(candidate.availableQuantityBase)) {
      throw new ValidationError(
        `There is only ${candidate.availableQuantityBase} of that lot of ${productName} on the shelf.`
      );
    }
    /*
     * ⚠️ AN OVERRIDE IS ANYTHING THE PLAN DID NOT SAY, AND THE SERVICE DECIDES
     *   THAT RATHER THAN THE CLIENT. A screen that forgot to set the flag would
     *   otherwise record a silent departure from FEFO as routine.
     */
    const planned = new Prisma.Decimal(candidate.quantityBase);
    const isOverride = line.isOverride || !planned.eq(wanted);
    if (isOverride && !(line.overrideReason ?? '').trim()) {
      throw new ValidationError(
        `Say why this lot of ${productName} is being used instead of the one the plan chose. ` +
          '"Why did it give out the lot expiring next week" is a question that gets asked.'
      );
    }
    total = total.add(wanted);
    out.push({
      locationId: line.locationId,
      batchId: line.batchId ?? null,
      serialId: line.serialId ?? null,
      quantityBase: wanted,
      isOverride,
      overrideReason: isOverride ? (line.overrideReason ?? null) : null,
      lotNumber: candidate.lotNumber,
      expiresOn: candidate.expiresOn === null ? null : new Date(candidate.expiresOn),
      serialNumber: candidate.serialNumber,
    });
  }

  if (!total.eq(new Prisma.Decimal(quantityBase))) {
    throw new ValidationError(
      `The lots chosen for ${productName} add up to ${total.toString()}, and the line is for ` +
        `${quantityBase}. A supply whose lots do not add up is a supply nobody can trace.`
    );
  }
  return out;
}

/**
 * Supply it.
 *
 * @throws RegulatoryRefusalError 422 when the rules of this place refuse a line
 *         AND the pack is one a human has signed off (`enforcement.ts`).
 */
export async function createDispense(
  ctx: TenantContext,
  body: CreateDispenseRequest,
  options: PharmacyActionOptions = {}
): Promise<DispenseDetail> {
  const branchId = resolveBranchId(ctx, body.branchId, options.actingBranchId);
  const dispensedAt = body.dispensedAt ? new Date(body.dispensedAt) : new Date();

  const id = await withTenant(ctx, async (tx) => {
    const location = await resolveDispensingLocation(tx, branchId, body.locationId);

    /*
     * ⚠️ THE PRESCRIPTION IS RE-READ AND RE-ASSERTED HERE, NOT TRUSTED FROM THE
     *   WORKSPACE. It may have been amended or cancelled since the screen loaded,
     *   and dispensing against a superseded consultation supplies exactly what the
     *   correction was made to stop.
     */
    const encounter =
      body.kind === 'PRESCRIPTION' && body.encounterId
        ? await tx.encounter.findFirst({
            where: { id: body.encounterId, organizationId: ctx.organizationId, deletedAt: null },
            select: {
              id: true,
              status: true,
              patientId: true,
              finalizedAt: true,
              startedAt: true,
              doctorProfile: { select: { userId: true } },
              patient: { select: { dateOfBirth: true, subjectType: true } },
              prescriptions: {
                select: {
                  id: true,
                  productId: true,
                  quantity: true,
                  instructions: true,
                  /* The prescriber's endorsement of a repeat (PI-8, #8). */
                  repeatsAuthorised: true,
                  repeatsAuthorisedLimit: true,
                },
              },
            },
          })
        : null;

    if (body.kind === 'PRESCRIPTION') {
      if (!encounter) throw new NotFoundError('Prescription');
      if (encounter.status !== 'FINALIZED') {
        throw new ValidationError(
          encounter.status === 'DRAFT'
            ? 'This consultation has not been signed, so there is no prescription to dispense.'
            : 'This consultation has been superseded or cancelled. Ask the prescriber for a current prescription.'
        );
      }
    }

    const patientId = encounter ? encounter.patientId : (body.patientId ?? null);

    /*
     * ⚠️ THE PATIENT IS TAKEN FROM THE ENCOUNTER AND NEVER FROM THE BODY ON THE
     *   PRESCRIPTION PATH. A body that could name a different patient is a body
     *   that can file somebody else's medicine on your record.
     */
    if (patientId !== null) {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!patient) throw new NotFoundError('Patient');
    }

    const prescribed = new Map((encounter?.prescriptions ?? []).map((line) => [line.id, line]));

    /*
     * ⚠️ SORTED INTO A CANONICAL ORDER BEFORE ANY BUCKET IS TOUCHED. Every ledger
     *   leg takes an advisory bucket lock held to COMMIT, so two supplies touching
     *   overlapping lots in opposite orders deadlock. Goods receipt sorts for the
     *   same reason, measured on PI-2's expiry sweep.
     */
    const ordered = [...body.lines].sort((a, b) =>
      a.productId === b.productId
        ? (a.encounterPrescriptionId ?? '').localeCompare(b.encounterPrescriptionId ?? '')
        : a.productId.localeCompare(b.productId)
    );

    const dispenseId = randomUUID();
    const prepared: {
      line: DispenseLineRequest;
      lineNumber: number;
      productId: string;
      quantityBase: string;
      allocations: ResolvedAllocation[];
      decisionId: string;
      labelInstructions: string | null;
      /**
       * Filled in when the line is written, and read by the charge-request pass
       * afterwards (PI-8). ⚠️ NOT optional in practice — every entry gets one
       * before the loop that writes them ends — and typed as it is because the
       * id does not exist when the entry is pushed.
       */
      dispenseLineId: string;
    }[] = [];

    let lineNumber = 0;
    for (const line of ordered) {
      lineNumber += 1;

      const product = await tx.product.findFirst({
        where: { id: line.productId, deletedAt: null },
        select: {
          id: true,
          name: true,
          status: true,
          isStockItem: true,
          baseUnitId: true,
          baseUnit: { select: { code: true } },
        },
      });
      if (!product) throw new NotFoundError('Product');
      if (!product.isStockItem) {
        throw new ValidationError(
          `${product.name} is not stocked, so it cannot be supplied from a shelf.`
        );
      }
      if (product.status !== 'ACTIVE') {
        throw new ValidationError(
          `${product.name} is no longer active in the catalogue. Choose the product the clinic is currently using.`
        );
      }

      const prescriptionLine = line.encounterPrescriptionId
        ? prescribed.get(line.encounterPrescriptionId)
        : undefined;
      if (line.encounterPrescriptionId && !prescriptionLine) {
        throw new ValidationError(
          'One of these lines cites a prescribed medicine that is not on this prescription.'
        );
      }

      /*
       * ⚠️ SUPPLYING SOMETHING OTHER THAN WHAT WAS PRESCRIBED *IS* A SUBSTITUTION,
       *   AND THE CLIENT DOES NOT GET TO DECIDE WHETHER TO CALL IT ONE. Without
       *   this, a line could cite prescription line P (for product A) while
       *   supplying product B and simply omit `substitutedForProductId` — and
       *   because BOTH contract refinements are conditioned on that field being
       *   set, omitting it skipped the mandatory reason AND the self-substitution
       *   check. Worse, the engine is told a substitution happened only by
       *   `...(line.substitutedForProductId ? { substitution: … } : {})` below, so
       *   every `SUBSTITUTION_RESTRICTION` rule sat out and the frozen decision on
       *   `dispense_lines.regulatory_decision_id` recorded a PERMITTED supply for a
       *   question nobody asked. The stored row then read
       *   `substituted_for_product_id = NULL`, which asserts B is what the
       *   prescriber wrote, and `refreshFulfilment` closed the prescription off
       *   because it sums by prescription line without looking at the product.
       *
       *   The declaration is derived from the two products disagreeing, never
       *   trusted. The web workspace always sent the field — but the workspace is
       *   not the boundary, and this is the one place that can tell.
       */
      if (prescriptionLine) {
        if (line.productId !== prescriptionLine.productId && !line.substitutedForProductId) {
          throw new ValidationError(
            'This line supplies a different product from the one prescribed. Record it as a substitution, with the reason, so the law is asked the substitution question.'
          );
        }
        /*
         * Both directions: a declared substitution must name the product on the
         * line it cites — which refuses an undeclared swap AND a claimed one that
         * points at some third product, whose only effect would be to put a name
         * on the record that was never prescribed.
         */
        if (
          line.substitutedForProductId &&
          line.substitutedForProductId !== prescriptionLine.productId
        ) {
          throw new ValidationError(
            'A substitution has to name the product that was actually prescribed on the line it cites.'
          );
        }
      }

      const quantityBase = await toBaseUnits(
        tx,
        movementDeps,
        { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
        { quantity: line.quantity, unitId: line.unitId }
      );

      const allocations = await resolveAllocations(
        tx,
        ctx,
        branchId,
        product.id,
        product.name,
        quantityBase,
        line.allocations
      );

      /*
       * ⚠️ THE EVIDENCE HANDED TO THE ENGINE IS THE FIRST LOT'S, WHICH IS A KNOWN
       *   NARROWING AND NOT AN OVERSIGHT. A `TRACEABILITY_REQUIREMENT` rule asks
       *   whether a lot number and an expiry are recorded at all; every allocation
       *   on the line carries both or none, because they come from the same
       *   candidate filter. A rule that needed to see EVERY lot would need the
       *   engine to take a list, which is a change to `@rcln/regulatory` rather
       *   than a loop here.
       */
      const evidence = allocations[0];

      const prescriptionFacts: EvaluateRegulatoryRequest['prescription'] | undefined = encounter
        ? {
            presented: true,
            /*
             * ⚠️ A FINALIZED CONSULTATION IS A SIGNED PRESCRIPTION. `FINALIZED` is
             *   the doctor putting their name to it — the same act
             *   `clinical.prescription.sign` describes — and it was asserted above.
             */
            signedByQualifiedPrescriber: true,
            issuedOn: (encounter.finalizedAt ?? encounter.startedAt).toISOString().slice(0, 10),
            /*
             * ⚠️ HOW MANY TIMES THIS PRESCRIBED LINE HAS ALREADY BEEN SUPPLIED,
             *   NOT HOW MUCH. A repeat rule counts DISPENSINGS; counting quantity
             *   would let three part-supplies of one course read as three repeats.
             */
            refillsUsed: prescriptionLine
              ? await tx.dispenseLine.count({
                  where: {
                    organizationId: ctx.organizationId,
                    encounterPrescriptionId: prescriptionLine.id,
                  },
                })
              : 0,
            /*
             * ⚠️ THE PRESCRIBER'S ENDORSEMENT, READ FROM THE CLINICAL RECORD
             *   (PI-8, closing KNOWN_ISSUES #8). PI-7 closed the framework half —
             *   the engine has been able to be TOLD a repeat was endorsed since
             *   then — and nothing could tell it, because `encounter_prescriptions`
             *   had a quantity and a duration and no field saying "may be
             *   dispensed twice". A lawful endorsed repeat was therefore refused.
             *
             * ⚠️ ABSENT IS STILL NOT `false`, AND THAT IS WHY THE COLUMN IS
             *   NULLABLE AND THESE ARE SPREAD RATHER THAN COERCED. NULL is "the
             *   prescriber did not address repeats", which is the ordinary case
             *   and is what the engine treats as no endorsement; `false` is a
             *   positive instruction that this may NOT be repeated. Sending
             *   `repeatsAuthorised: false` for every prescription ever written
             *   would turn silence into a refusal the prescriber never wrote.
             *
             * ⚠️ AND A `true` WITH NO LIMIT STILL RESOLVES `UNDETERMINED`, WHICH
             *   REFUSES. An endorsement stating no number is not an unlimited
             *   one — PI-7's tests pin exactly that, and nothing here weakens it.
             */
            ...(prescriptionLine?.repeatsAuthorised != null
              ? { repeatsAuthorised: prescriptionLine.repeatsAuthorised }
              : {}),
            ...(prescriptionLine?.repeatsAuthorisedLimit != null
              ? { repeatsAuthorisedLimit: prescriptionLine.repeatsAuthorisedLimit }
              : {}),
          }
        : undefined;

      const consultation = await consultForSupply(tx, ctx, {
        branchId,
        productId: product.id,
        locationId: location.id,
        quantityBase,
        transaction: body.kind === 'COUNTER_SALE' ? 'COUNTER_SALE' : 'DISPENSE',
        occurredAt: dispensedAt,
        documentId: dispenseId,
        /*
         * ⚠️ WHO THIS IS FOR, SO A QUANTITY LIMIT CAN BE COUNTED (PI-8). NULL on
         *   a counter sale to somebody with no patient record — there is no
         *   history to sum, so a period rule stays `UNDETERMINED` and refuses
         *   rather than reading as "they have had none".
         */
        patientId,
        ...(prescriptionFacts ? { prescription: prescriptionFacts } : {}),
        ...(encounter
          ? {
              patient: {
                subjectType: encounter.patient.subjectType,
                ...(ageYearsOn(encounter.patient.dateOfBirth, dispensedAt) !== undefined
                  ? { ageYears: ageYearsOn(encounter.patient.dateOfBirth, dispensedAt) as number }
                  : {}),
              },
            }
          : {}),
        ...(line.substitutedForProductId ? { substitution: { isSubstitution: true } } : {}),
        ...(evidence
          ? {
              traceability: {
                lotNumber: evidence.lotNumber,
                expiresOn: evidence.expiresOn?.toISOString().slice(0, 10) ?? null,
                serial: evidence.serialNumber,
              },
            }
          : {}),
        actor: {
          roleCodes: options.roleCodes ?? [],
          /*
           * ⚠️ DERIVED HERE, FROM THE ENCOUNTER, AND NEVER FROM THE REQUEST. It
           *   opens a statutory proviso in several jurisdictions — a practitioner
           *   dispensing to their own patients — and a client that could assert it
           *   would be self-certifying into an exemption.
           */
          ...(encounter ? { isPrescriber: encounter.doctorProfile?.userId === ctx.userId } : {}),
        },
      });

      prepared.push({
        line,
        lineNumber,
        productId: product.id,
        quantityBase,
        allocations,
        decisionId: consultation.decisionId,
        labelInstructions: line.labelInstructions ?? prescriptionLine?.instructions ?? null,
        /* Replaced with the real id the moment the line row is written, below. */
        dispenseLineId: '',
      });
    }

    /*
     * ⚠️ THE NUMBER IS TAKEN AFTER EVERY LINE HAS BEEN CONSULTED AND PLANNED, SO A
     *   REFUSAL BURNS NONE. A gap in a dispensing series is a gap an inspector
     *   asks about. It is still inside the transaction, so a later failure rolls
     *   it back with everything else.
     */
    const number = await issueNumber(tx, ctx, {
      type: 'DISPENSE',
      branchId,
      periodKey: '',
      prefix: 'DSP-',
    });

    await tx.dispense.create({
      data: {
        id: dispenseId,
        organizationId: ctx.organizationId,
        branchId,
        dispenseNumber: number.formatted,
        kind: body.kind,
        status: 'DISPENSED',
        encounterId: encounter?.id ?? null,
        patientId,
        locationId: location.id,
        dispensedById: ctx.userId,
        dispensedAt,
        notes: body.notes ?? null,
      },
    });

    for (const item of prepared) {
      const created = await tx.dispenseLine.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          dispenseId,
          lineNumber: item.lineNumber,
          encounterPrescriptionId: item.line.encounterPrescriptionId ?? null,
          productId: item.productId,
          substitutedForProductId: item.line.substitutedForProductId ?? null,
          substitutionReason: item.line.substitutionReason ?? null,
          quantityEntered: new Prisma.Decimal(item.line.quantity),
          unitId: item.line.unitId,
          quantityBase: new Prisma.Decimal(item.quantityBase),
          regulatoryDecisionId: item.decisionId,
          labelInstructions: item.labelInstructions,
        },
        select: { id: true },
      });

      /*
       * Kept so the charge requests can cite the lines by id after the loop
       * (PI-8). Raising them inside this loop would mean resolving the policy,
       * the price and the tax category per line with the unit graph and the
       * branch's jurisdiction re-read each time.
       */
      item.dispenseLineId = created.id;

      for (const allocation of item.allocations) {
        await tx.dispenseAllocation.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            dispenseLineId: created.id,
            locationId: allocation.locationId,
            batchId: allocation.batchId,
            serialId: allocation.serialId,
            quantityBase: allocation.quantityBase,
            isOverride: allocation.isOverride,
            overrideReason: allocation.overrideReason,
          },
        });

        /*
         * ⚠️ ONE LEG PER LOT, THROUGH `recordMovementIn` AND NOTHING ELSE
         *   (PI-ADR-004). The sign is a property of `DISPENSING` and is CHECKed in
         *   the database; the quantity handed over is positive. `occurredAt` is
         *   when it was HANDED OVER, not when it was keyed in.
         */
        await recordMovementIn(tx, ctx, {
          branchId,
          productId: item.productId,
          batchId: allocation.batchId,
          serialId: allocation.serialId,
          movementType: 'DISPENSING',
          quantity: q(allocation.quantityBase),
          locationId: allocation.locationId,
          statusFrom: 'AVAILABLE',
          referenceType: 'DISPENSE',
          referenceId: dispenseId,
          occurredAt: dispensedAt,
        });

        /*
         * A serialised unit that has been handed to somebody is ISSUED, and the
         * serial says whose it is. ⚠️ PHI on `serials.assigned_patient_id`, which
         * is exactly why PI-2 gave reading it its own data-access resource.
         */
        if (allocation.serialId) {
          await tx.serial.update({
            where: { id: allocation.serialId },
            data: {
              status: 'ISSUED',
              ...(patientId !== null ? { assignedPatientId: patientId } : {}),
            },
          });
        }
      }
    }

    if (encounter) {
      await refreshFulfilment(tx, ctx, encounter.id, branchId);
    }

    /*
     * ⚠️ THE MONEY SIDE, IN THE SAME TRANSACTION AS THE SUPPLY (PI-8), AND
     *   PHARMACY STILL OWNS NO RATE. This writes `charge_requests` — the
     *   structured hand-off PI-ADR-005 requires — and no invoice, no price
     *   decision and no tax figure. `raiseChargeRequestsWithin` resolves the
     *   clinic's charge POLICY, reads its price list and asks
     *   `resolveTaxCategory` for a category string; everything downstream is
     *   `services/invoicing` and `@rcln/tax`, untouched.
     *
     * ⚠️ SAME TRANSACTION, BECAUSE A CHARGE THAT COULD COMMIT WITHOUT ITS
     *   DISPENSE WILL, on the day the dispense rolls back — and the clinic bills
     *   for medicine that never left the shelf.
     *
     * ⚠️ AND IT CANNOT STOP THE SUPPLY. A missing price or an unclassified
     *   product is written as a NULL column and shown on the charge-review
     *   screen; nothing in that path throws. A pharmacist handing somebody their
     *   medicine must never be blocked because an accountant has not filled in a
     *   grid — see the service header for how the two requirements are
     *   reconciled.
     */
    await raiseChargeRequestsWithin(tx, ctx, {
      branchId,
      kind: 'SUPPLY',
      patientId,
      /* The instant it was HANDED OVER — it becomes the invoice's `suppliedAt`. */
      occurredAt: dispensedAt,
      lines: prepared.map((item) => ({
        dispenseLineId: item.dispenseLineId,
        productId: item.productId,
        quantityBase: item.quantityBase,
      })),
    });

    /*
     * ⚠️ IDS AND COUNTS. No medicine name, no patient name — an audit row is read
     *   by people reviewing changes, and "dispensed methadone to Mrs Rao" in that
     *   table is a disclosure rather than a change record.
     */
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'dispense',
      entityId: dispenseId,
      branchId,
      after: {
        dispenseNumber: number.formatted,
        kind: body.kind,
        lineCount: prepared.length,
        encounterId: encounter?.id ?? null,
        locationId: location.id,
      },
      ...auditMeta(options),
    });

    return dispenseId;
  });

  return getDispense(ctx, id, options);
}

/**
 * Move a dispense's status after something came back.
 *
 * ⚠️ THE ONLY MUTABLE COLUMN ON A POSTED DISPENSE, AND IT IS DERIVED. Everything
 *   else about a supply is what happened; this says how much of it has since been
 *   undone, and it is computed from the lines rather than set by a caller.
 */
export async function refreshDispenseStatus(tx: TxClient, dispenseId: string): Promise<void> {
  const lines = await tx.dispenseLine.findMany({
    where: { dispenseId },
    select: { quantityBase: true, returnedQuantityBase: true },
  });
  if (lines.length === 0) return;

  const fullyReturned = lines.every((line) => line.returnedQuantityBase.gte(line.quantityBase));
  const anyReturned = lines.some((line) => line.returnedQuantityBase.gt(0));

  const status = fullyReturned ? 'RETURNED' : anyReturned ? 'PARTIALLY_RETURNED' : 'DISPENSED';
  await tx.dispense.update({ where: { id: dispenseId }, data: { status } });
}

/** Guard used by the return path, kept here so both agree on what "posted" means. */
export async function loadDispenseForReturn(
  tx: TxClient,
  organizationId: string,
  dispenseId: string
): Promise<{ id: string; branchId: string; locationId: string; patientId: string | null }> {
  const row = await tx.dispense.findFirst({
    where: { id: dispenseId, organizationId },
    select: { id: true, branchId: true, locationId: true, patientId: true, status: true },
  });
  if (!row) throw new NotFoundError('Dispense');
  if (row.status === 'RETURNED') {
    throw new ConflictError('Everything on this supply has already come back.');
  }
  return {
    id: row.id,
    branchId: row.branchId,
    locationId: row.locationId,
    patientId: row.patientId,
  };
}
