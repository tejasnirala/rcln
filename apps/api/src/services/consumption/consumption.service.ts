/**
 * What a procedure actually consumed — the record, the ledger legs, and the
 * hand-off to billing (PI-9).
 *
 * ── ONE TRANSACTION, AND WHAT IS IN IT ──────────────────────────────────────
 * A consumption has no draft, for the reason a dispense has none: the material
 * left the trolley once. `recordConsumption` opens a single transaction and,
 * per line, in this order:
 *
 *   1. re-assert the world          the encounter, the procedure, the product,
 *                                   the shelf — all of it was true when the
 *                                   panel loaded and any of it may have moved
 *   2. convert the quantity         through the one `toBaseUnits` the ledger
 *                                   uses; the caller never states base units
 *   3. DERIVE the variance          from the expected and the actual
 *                                   disagreeing, never from a client flag
 *   4. plan or honour the lots      FEFO, or the lots somebody chose, with a
 *                                   reason for anything that departs from it
 *   5. move the stock               one `CLINICAL_CONSUMPTION` leg per lot,
 *                                   through `recordMovementIn` and nothing else
 *   6. write the record + audit
 *   7. raise the charge requests    PI-8's engine, whose caller this is
 *
 * ⚠️ THE LAW IS NOT ASKED, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 *   `@rcln/regulatory` answers questions about SUPPLYING a product to a person —
 *   may this be dispensed, may it be substituted, was a prescription presented.
 *   A clinician using an anaesthetic on their own patient during a procedure
 *   they are performing is not a supply, no rule in the India pack (or in
 *   PI-5's rule types) addresses it, and calling `evaluateWithin` here would
 *   answer `UNDETERMINED` for every product on the platform — which refuses.
 *   PI-6.7's enforcement gate would swallow that today, which is exactly why it
 *   must not be relied on: the day somebody moves a pack to
 *   `PRODUCTION_ENABLED`, every procedure in the clinic would stop. When a rule
 *   type for administration exists, this is the call site, and it goes in with
 *   its own decision snapshot the way `dispense_lines` has one.
 *
 * ⚠️ AND NOTHING HERE PRICES ANYTHING (PI-ADR-005). A `NEVER_BILL` glove and a
 *   `SEPARATELY_BILLABLE` implant go through identical code; the charge policy
 *   decides, in `services/charging`, and this file does not know which is which.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * "This person had this implant fitted on this day" is the densest thing here.
 * Reads log through `recordDataAccess`; the audit row carries ids and counts; no
 * log line from this file names a patient or a product.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AmendConsumptionRequest,
  ConsumptionAllocationRequest,
  ConsumptionDetail,
  ConsumptionLineRequest,
  ConsumptionListResponse,
  ConsumptionPlanQuery,
  ConsumptionPlanResponse,
  ConsumptionQuery,
  ConsumptionSummary,
  CorrectConsumptionRequest,
  RecordConsumptionRequest,
} from '@rcln/contracts';
import { toBaseUnits } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { raiseChargeRequestsWithin } from '../charging/charge-request.service.js';
import { planStockAllocationWithin } from '../inventory/allocation.service.js';
import { movementDeps, recordMovementIn } from '../inventory/movement.service.js';
import { loadUnitGraph } from '../product/unit.service.js';
import { resolveTemplateInForceWithin, templateLineBase } from './template.service.js';
import {
  assertBranchInScope,
  assertMayOverride,
  auditMeta,
  q,
  resolveBranchId,
  resolveConsumptionLocation,
  type ConsumptionActionOptions,
} from './shared.js';

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

const DETAIL_INCLUDE = Prisma.validator<Prisma.ClinicalConsumptionInclude>()({
  branch: { select: { name: true } },
  location: { select: { name: true } },
  recordedBy: { select: { fullName: true } },
  amendedBy: { select: { fullName: true } },
  patient: { select: { firstName: true, lastName: true } },
  procedure: { select: { item: { select: { name: true } } } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      allocations: {
        /* `createdAt` ties across the allocations of one line — KNOWN_ISSUES #1. */
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          location: { select: { name: true } },
          batch: { select: { lotNumber: true, expiresOn: true } },
          serial: { select: { serialNumber: true } },
        },
      },
    },
  },
  correctedBy: {
    orderBy: { occurredAt: 'desc' },
    include: { recordedBy: { select: { fullName: true } }, _count: { select: { lines: true } } },
  },
});

type DetailRow = Prisma.ClinicalConsumptionGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/** A patient's name from its two halves. Users carry one `full_name` instead. */
function patientName(patient: { firstName: string; lastName: string | null }): string {
  return patient.lastName ? `${patient.firstName} ${patient.lastName}` : patient.firstName;
}

function toSummary(row: DetailRow): ConsumptionSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    kind: row.kind,
    /*
     * ⚠️ NARROWED TO THE TWO BUILT MEMBERS. The database enum carries
     *   `LAB_ORDER` and `IMAGING_STUDY` so their phases need no migration, and
     *   `clinical_consumptions_anchor_is_resolvable` refuses a row claiming
     *   either — so no stored row can reach this cast.
     */
    anchorKind: row.anchorKind as 'ENCOUNTER' | 'ENCOUNTER_PROCEDURE',
    encounterId: row.encounterId,
    encounterProcedureId: row.encounterProcedureId,
    procedureName: row.procedure?.item?.name ?? null,
    patientId: row.patientId,
    patientName: patientName(row.patient),
    locationId: row.locationId,
    locationName: row.location.name,
    templateId: row.templateId,
    occurredAt: row.occurredAt.toISOString(),
    recordedByName: row.recordedBy.fullName,
    lineCount: row.lines.length,
    hasVariance: row.lines.some((line) => line.isOverride),
    correctsConsumptionId: row.correctsConsumptionId,
    amendedAt: row.amendedAt?.toISOString() ?? null,
  };
}

function toDetail(row: DetailRow): ConsumptionDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    correctionReason: row.correctionReason,
    amendedByName: row.amendedBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      templateLineId: line.templateLineId,
      productId: line.productId,
      productName: line.product.name,
      expectedQuantityBase: q(line.expectedQuantityBase),
      quantityEntered: q(line.quantityEntered),
      unitId: line.unitId,
      unitSymbol: line.unit.symbol,
      quantityBase: q(line.quantityBase),
      baseUnitSymbol: line.product.baseUnit.symbol,
      /* Derived on the way out as well as on the way in. Never stored. */
      varianceBase: q(line.quantityBase.sub(line.expectedQuantityBase)),
      isOverride: line.isOverride,
      overrideReason: line.overrideReason,
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
    corrections: row.correctedBy.map((correction) => ({
      id: correction.id,
      kind: correction.kind,
      occurredAt: correction.occurredAt.toISOString(),
      reason: correction.correctionReason,
      recordedByName: correction.recordedBy.fullName,
      lineCount: correction._count.lines,
    })),
  };
}

export async function listConsumptions(
  ctx: TenantContext,
  query: ConsumptionQuery,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionListResponse> {
  if (query.branchId) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.ClinicalConsumptionWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.encounterId ? { encounterId: query.encounterId } : {}),
      ...(query.encounterProcedureId ? { encounterProcedureId: query.encounterProcedureId } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.productId ? { lines: { some: { productId: query.productId } } } : {}),
      ...(query.varianceOnly === true ? { lines: { some: { isOverride: true } } } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.clinicalConsumption.findMany({
        where,
        include: DETAIL_INCLUDE,
        /* Total order: `occurredAt` ties across the records of one session. */
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.clinicalConsumption.count({ where }),
    ]);

    /*
     * ⚠️ ON THE SAME TRANSACTION AS THE READ IT RECORDS. A disclosure row that
     *   can commit apart from its read is one that will, on the day the read
     *   rolls back — and a read that succeeded with a log write that failed is a
     *   disclosure with no record.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'CLINICAL_CONSUMPTION',
      /* ⚠️ Ids and a count. Never a patient name, never a product name. */
      resultCount: rows.length,
      ...(query.patientId !== undefined ? { patientId: query.patientId } : {}),
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return { items: rows.map(toSummary), total, page: query.page, limit: query.limit };
  });
}

export async function getConsumption(
  ctx: TenantContext,
  id: string,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.clinicalConsumption.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundError('Consumption');

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'CLINICAL_CONSUMPTION',
      resourceId: row.id,
      branchId: row.branchId,
      patientId: row.patientId,
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return toDetail(row);
  });
}

// ---------------------------------------------------------------------------
// The plan — what the panel shows before anybody confirms anything
// ---------------------------------------------------------------------------

/**
 * A quantity no clinic holds, asked for so the planner returns every candidate.
 *
 * ⚠️ A PROBE, NOT A LIMIT, AND IT CANNOT OVER-ALLOCATE ANYTHING. `planAllocation`
 *   walks the buckets it is given and stops when the request is covered or the
 *   candidates run out; asking for more than exists simply returns all of them
 *   with a large `shortfallQuantityBase`, which this function ignores because it
 *   is not asking whether the shelf can cover anything. Planning writes nothing.
 *
 * ⚠️ IT IS THE LARGEST VALUE `Decimal(18,6)` HOLDS, so it cannot be reached by a
 *   real balance and cannot overflow the column the planner compares against.
 *   The alternative — reading `stock_balances` for a total first — duplicates
 *   the allocator's own candidacy filter (expired, quarantined, decommissioned
 *   shelf) and would therefore ask for a number that is wrong in the direction
 *   that hides lots.
 */
const EVERYTHING_ON_THE_SHELF = '999999999999';

/**
 * What this procedure normally uses, and what is on the shelf.
 *
 * ⚠️ IT WRITES NOTHING, INCLUDING NO RESERVATION. Two clinicians planning at
 *   once get the same answer, and the shelf is re-asserted inside the posting
 *   transaction — which is where the refusal belongs, because that is the moment
 *   the stock actually moves. `allocation.service.ts` makes the same argument at
 *   length.
 */
export async function planConsumption(
  ctx: TenantContext,
  query: ConsumptionPlanQuery,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionPlanResponse> {
  const branchId = resolveBranchId(ctx, query.branchId, options.actingBranchId);

  return withTenant(ctx, async (tx) => {
    const anchor = await loadAnchor(tx, ctx, {
      encounterId: query.encounterId,
      encounterProcedureId: query.encounterProcedureId ?? null,
    });

    const template = anchor.procedureItemId
      ? await resolveTemplateInForceWithin(
          tx,
          ctx.organizationId,
          anchor.procedureItemId,
          new Date()
        )
      : null;

    const graph = await loadUnitGraph(tx);

    const lines: ConsumptionPlanResponse['lines'] = [];
    for (const line of template?.lines ?? []) {
      const expectedBase = templateLineBase(graph, line);
      /*
       * ⚠️ THE PLAN IS ASKED FOR THE WHOLE OF WHAT IS ON THE SHELF, NOT FOR WHAT
       *   THE TEMPLATE EXPECTS, AND THAT IS WHAT MAKES THE PICKER POSSIBLE
       *   (PI-9.9). `planAllocation` walks the candidate buckets in FEFO order
       *   and STOPS once the requested quantity is covered — so asking for the
       *   expected quantity returns only the lots FEFO happened to pick, and a
       *   template expecting one implant would offer exactly one serial. Asking
       *   for an unreachable quantity turns the plan into the CANDIDATE LIST,
       *   which is the thing a clinician needs in order to reach past the oldest
       *   lot, or to say which numbered device actually went in. The dispensing
       *   workspace makes the identical call for the identical reason.
       *
       * ⚠️ AND `allocatedQuantityBase` IS THEN THE TRUE AVAILABLE TOTAL. Under
       *   the old call it was `min(available, expected)`, so a line with plenty
       *   of stock and a line with exactly enough reported the same number and
       *   the panel could not tell them apart.
       *
       * It writes nothing — see the header — and a shortfall is reported rather
       * than thrown, because a procedure with one item short is still a
       * procedure somebody is about to perform.
       */
      const plan = await planStockAllocationWithin(tx, ctx, {
        branchId,
        productId: line.productId,
        quantity: EVERYTHING_ON_THE_SHELF,
      });

      /*
       * What FEFO would take for the EXPECTED quantity, walked down the
       * candidate list above. The same arithmetic the server does when the
       * caller sends no allocations, so the numbers the panel pre-fills are the
       * numbers it would have posted anyway.
       */
      let remaining = new Prisma.Decimal(expectedBase);
      const planned = plan.lines.map((candidate) => {
        const take = Prisma.Decimal.max(
          0,
          Prisma.Decimal.min(remaining, new Prisma.Decimal(candidate.availableQuantityBase))
        );
        remaining = remaining.sub(take);
        return { candidate, take };
      });

      /*
       * ⚠️ THE CANDIDATE LIST IS OFFERED FOR TRACKED STOCK AND WITHHELD FOR
       *   UNTRACKED (PI-9.9). A box of gloves has one bucket and nothing to
       *   choose between; a picker with one option on every consumable on the
       *   tray is how a screen teaches people to click past it. A batch or a
       *   serial is a real choice — and for a numbered implant it is the whole
       *   point, because "whichever one FEFO picked" is not an answer when the
       *   device in the patient has a number printed on it.
       *
       * ⚠️ IT IS THE PLANNER'S OWN LIST IN THE PLANNER'S OWN ORDER, AND IT IS
       *   NOT NARROWED TO WHAT FEFO WOULD TAKE. A clinician reaching past the
       *   oldest lot needs to see the lots the plan did not choose — that is
       *   what reaching past one means — and the server re-plans inside the
       *   posting transaction and decides for itself what counts as an override.
       */
      const isTracked = plan.lines.some(
        (candidate) => candidate.batchId !== null || candidate.serialId !== null
      );

      lines.push({
        templateLineId: line.id,
        productId: line.productId,
        productName: line.product.name,
        expectedQuantity: q(line.quantity),
        unitId: line.unitId,
        unitSymbol: line.unit.symbol,
        expectedQuantityBase: expectedBase,
        baseUnitSymbol: line.product.baseUnit.symbol,
        isOptional: line.isOptional,
        availableQuantityBase: plan.allocatedQuantityBase,
        isSerialTracked: plan.lines.some((planned) => planned.serialId !== null),
        candidateLots: isTracked
          ? planned.map(({ candidate, take }) => ({
              locationId: candidate.locationId,
              locationName: candidate.locationName,
              batchId: candidate.batchId,
              lotNumber: candidate.lotNumber,
              expiresOn: candidate.expiresOn,
              serialId: candidate.serialId,
              serialNumber: candidate.serialNumber,
              availableQuantityBase: candidate.availableQuantityBase,
              plannedQuantityBase: q(take),
            }))
          : [],
        note: line.note,
      });
    }

    /*
     * ⚠️ THE PANEL IS A READ OF A PATIENT'S PROCEDURE, so it logs a disclosure
     *   even though it returns no quantity anybody consumed yet. It names the
     *   patient and the products a named person is about to have used on them.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'CLINICAL_CONSUMPTION',
      resourceId: anchor.encounterId,
      branchId,
      patientId: anchor.patientId,
      resultCount: lines.length,
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      branchId,
      encounterId: anchor.encounterId,
      encounterProcedureId: anchor.encounterProcedureId,
      patientId: anchor.patientId,
      templateId: template?.id ?? null,
      templateName: template?.name ?? null,
      templateVersion: template?.version ?? null,
      encounterIsOpen: anchor.isOpen,
      lines,
    };
  });
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

interface ResolvedAnchor {
  encounterId: string;
  encounterProcedureId: string | null;
  procedureItemId: string | null;
  patientId: string;
  /** Whether the consultation is still amendable. See `amendConsumption`. */
  isOpen: boolean;
}

/**
 * The consultation, and the procedure within it, re-read and re-asserted.
 *
 * ⚠️ THE PATIENT IS TAKEN FROM THE ENCOUNTER AND NEVER FROM THE BODY. There is
 *   no `patientId` on the request at all for that reason: a body that could name
 *   a different patient is a body that can file somebody else's implant on your
 *   record. `createDispense` learned the same thing.
 *
 * ⚠️ AND THE PROCEDURE IS CHECKED TO BELONG TO THE ENCOUNTER. Both ids are
 *   client-supplied and both are tenant-scoped by RLS, so the cross-tenant case
 *   is closed — but "procedure 7 of somebody ELSE'S consultation at my own
 *   clinic" is not, and it would file a hip stem against the wrong visit.
 */
async function loadAnchor(
  tx: TxClient,
  ctx: TenantContext,
  input: { encounterId: string; encounterProcedureId: string | null }
): Promise<ResolvedAnchor> {
  const encounter = await tx.encounter.findFirst({
    where: { id: input.encounterId, organizationId: ctx.organizationId, deletedAt: null },
    select: { id: true, status: true, patientId: true },
  });
  if (!encounter) throw new NotFoundError('Consultation');
  if (encounter.status === 'CANCELLED') {
    throw new ValidationError(
      'This consultation was abandoned. Nothing can be recorded as consumed against it.'
    );
  }

  if (input.encounterProcedureId === null) {
    return {
      encounterId: encounter.id,
      encounterProcedureId: null,
      procedureItemId: null,
      patientId: encounter.patientId,
      isOpen: encounter.status === 'DRAFT',
    };
  }

  const procedure = await tx.encounterProcedure.findFirst({
    where: { id: input.encounterProcedureId, organizationId: ctx.organizationId },
    select: { id: true, encounterId: true, itemId: true, status: true },
  });
  if (!procedure || procedure.encounterId !== encounter.id) {
    throw new NotFoundError('Procedure');
  }
  if (procedure.status === 'CANCELLED') {
    throw new ValidationError(
      'That procedure was cancelled. Record what was used against the procedure that was actually performed.'
    );
  }

  return {
    encounterId: encounter.id,
    encounterProcedureId: procedure.id,
    procedureItemId: procedure.itemId,
    patientId: encounter.patientId,
    isOpen: encounter.status === 'DRAFT',
  };
}

// ---------------------------------------------------------------------------
// Preparing a line
// ---------------------------------------------------------------------------

interface ResolvedAllocation {
  locationId: string;
  batchId: string | null;
  serialId: string | null;
  quantityBase: Prisma.Decimal;
  isOverride: boolean;
  overrideReason: string | null;
}

interface PreparedLine {
  productId: string;
  productName: string;
  templateLineId: string | null;
  quantityEntered: string;
  unitId: string;
  quantityBase: string;
  expectedQuantityBase: string;
  isOverride: boolean;
  overrideReason: string | null;
  allocations: ResolvedAllocation[];
}

/**
 * Which lots this line comes out of, when stock is going OUT.
 *
 * ⚠️ THE FEFO PLAN IS THE DEFAULT AND AN OVERRIDE IS RECORDED, NEVER REFUSED —
 *   the argument `resolveAllocations` makes in `dispense.service.ts`, verbatim.
 *   What is NOT negotiable is candidacy: whether a lot may be used at all —
 *   AVAILABLE, unexpired, an ACTIVE batch, an active location — belongs to the
 *   allocator's filter and is re-checked here for every lot a caller names.
 */
async function resolveIssueAllocations(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  productId: string,
  productName: string,
  quantityBase: string,
  requested: readonly ConsumptionAllocationRequest[] | undefined
): Promise<ResolvedAllocation[]> {
  /*
   * ⚠️ TWO DIFFERENT QUESTIONS, AND ASKING ONE PLAN BOTH OF THEM IS A BUG THIS
   *   PHASE HAD AND FIXED (PI-9.9).
   *
   *     "what would FEFO take for this quantity"  →  plan for `quantityBase`
   *     "may this lot be used at all"             →  plan for EVERYTHING
   *
   *   `planAllocation` walks the candidate buckets in order and STOPS once the
   *   request is covered. So a plan for the line's own quantity returns only the
   *   lots FEFO picked — and validating a caller's chosen lots against THAT set
   *   refuses every lot the plan did not choose, which is precisely the act the
   *   override exists to permit. A clinician reaching past the oldest lot, or
   *   naming the second of two numbered devices, got "that lot cannot be used".
   *
   *   The candidacy rules are identical either way — AVAILABLE, unexpired, an
   *   ACTIVE batch, an active location — because they are the allocator's filter
   *   and not a property of the quantity asked for. Expired, quarantined and
   *   recalled stock is still refused from every route into this function.
   */
  const plan = await planStockAllocationWithin(tx, ctx, {
    branchId,
    productId,
    quantity: requested && requested.length > 0 ? EVERYTHING_ON_THE_SHELF : quantityBase,
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
    }));
  }

  /*
   * ⚠️ WHAT FEFO WOULD HAVE TAKEN FOR *THIS LINE*, WALKED DOWN THE FULL
   *   CANDIDATE LIST. It is what an override is measured against, and it is not
   *   the same as `candidate.quantityBase` — that is what the whole-shelf probe
   *   above would take from each bucket, which is the bucket's entire contents.
   *   Comparing against THAT would mark every allocation an override and demand
   *   a reason for supplying exactly what the plan chose.
   */
  const plannedForLine = new Map<string, Prisma.Decimal>();
  let toCover = new Prisma.Decimal(quantityBase);
  for (const candidate of plan.lines) {
    const take = Prisma.Decimal.max(
      0,
      Prisma.Decimal.min(toCover, new Prisma.Decimal(candidate.availableQuantityBase))
    );
    toCover = toCover.sub(take);
    plannedForLine.set(
      `${candidate.locationId}|${candidate.batchId ?? '-'}|${candidate.serialId ?? '-'}`,
      take
    );
  }

  const out: ResolvedAllocation[] = [];
  let total = new Prisma.Decimal(0);

  for (const line of requested) {
    const key = `${line.locationId}|${line.batchId ?? '-'}|${line.serialId ?? '-'}`;
    const candidate = candidates.get(key);
    /*
     * The message deliberately does not say WHICH of the reasons applies: a
     * caller probing lot ids should not learn what a clinic holds.
     */
    if (!candidate) {
      throw new ValidationError(
        `That lot of ${productName} cannot be used. It is expired, on hold, recalled or no longer ` +
          'where it was — reload the panel and choose again.'
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
     *   THAT RATHER THAN THE CLIENT — a screen that forgot to set the flag would
     *   otherwise record a silent departure from FEFO as routine.
     */
    const planned = plannedForLine.get(key) ?? new Prisma.Decimal(0);
    const isOverride = line.isOverride || !planned.eq(wanted);
    if (isOverride && !(line.overrideReason ?? '').trim()) {
      throw new ValidationError(
        `Say why this lot of ${productName} is being used instead of the one the plan chose.`
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
    });
  }

  if (!total.eq(new Prisma.Decimal(quantityBase))) {
    throw new ValidationError(
      `The lots chosen for ${productName} add up to ${total.toString()}, and the line is for ` +
        `${quantityBase}. A consumption whose lots do not add up is one nobody can trace.`
    );
  }
  return out;
}

interface PrepareContext {
  branchId: string;
  /** Template line id -> the expected figure in base units, and its product. */
  expected: Map<string, { productId: string; expectedBase: string }>;
  options: ConsumptionActionOptions;
}

/**
 * One requested line, checked, converted and allocated.
 *
 * ⚠️ THE TEMPLATE PAIRING IS RE-DERIVED AND NEVER TRUSTED. A line may not cite
 *   template line L (for gloves) while consuming an implant: that is the PI-9
 *   analogue of PI-8.11's dispensing CRITICAL, where a supply cited a
 *   prescription line for a DIFFERENT product, no control noticed because every
 *   control hung off a client-set field, and the stored row then asserted the
 *   substitute was what the prescriber wrote. Here the consequence would be an
 *   implant recorded as having been expected — variance zero — because the
 *   expectation was read off the wrong template line.
 */
async function prepareLine(
  tx: TxClient,
  ctx: TenantContext,
  context: PrepareContext,
  line: ConsumptionLineRequest
): Promise<PreparedLine> {
  const product = await tx.product.findFirst({
    where: {
      id: line.productId,
      deletedAt: null,
      OR: [{ organizationId: ctx.organizationId }, { organizationId: null }],
    },
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
      `${product.name} is not stocked, so it cannot come off a shelf. A consultation fee is a product to billing and never to inventory.`
    );
  }
  if (product.status !== 'ACTIVE') {
    throw new ValidationError(
      `${product.name} is no longer active in the catalogue. Record what the clinic is currently using.`
    );
  }

  let templateLineId: string | null = null;
  let expectedBase = '0';
  if (line.templateLineId) {
    const expectation = context.expected.get(line.templateLineId);
    if (!expectation) {
      throw new ValidationError(
        'One of these lines cites a template line that is not on the template in force for this procedure.'
      );
    }
    if (expectation.productId !== line.productId) {
      throw new ValidationError(
        `${product.name} does not match the template line this cites. A line that claimed the wrong ` +
          'expectation would report a variance of zero for something the template never listed.'
      );
    }
    templateLineId = line.templateLineId;
    expectedBase = expectation.expectedBase;
  }

  const quantityBase = await toBaseUnits(
    tx,
    movementDeps,
    { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
    { quantity: line.quantity, unitId: line.unitId }
  );

  /*
   * ⚠️ DERIVED, NEVER TAKEN FROM THE CLIENT — there is no `isOverride` on the
   *   request at all, which is the control. A line with no template expects
   *   nothing, so using something the template never listed IS a variance and is
   *   recorded as one: "we used a product nobody planned for" is exactly what a
   *   variance report is for.
   */
  const isOverride = !new Prisma.Decimal(quantityBase).eq(new Prisma.Decimal(expectedBase));
  if (isOverride) {
    assertMayOverride(context.options, product.name, expectedBase, quantityBase);
    if (!(line.overrideReason ?? '').trim()) {
      throw new ValidationError(
        `${product.name}: the template expected ${expectedBase} and this records ${quantityBase}. ` +
          'Say why — a variance with no reason is indistinguishable from a typo, and the report ' +
          'that reads these is how a clinic finds out its templates are wrong.'
      );
    }
  }

  const allocations = await resolveIssueAllocations(
    tx,
    ctx,
    context.branchId,
    product.id,
    product.name,
    quantityBase,
    line.allocations
  );

  return {
    productId: product.id,
    productName: product.name,
    templateLineId,
    quantityEntered: line.quantity,
    unitId: line.unitId,
    quantityBase,
    expectedQuantityBase: expectedBase,
    isOverride,
    overrideReason: isOverride ? (line.overrideReason ?? null) : null,
    allocations,
  };
}

/**
 * One product, one line.
 *
 * ⚠️ NOT A TIDINESS RULE — it is what makes an AMENDMENT tractable. Amending
 *   matches the incoming lines against the stored ones BY PRODUCT, so two lines
 *   for gloves would leave the delta arithmetic with two candidates and no way
 *   to choose. The template enforces the same rule for the same shape of reason.
 */
function assertOneLinePerProduct(lines: readonly ConsumptionLineRequest[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.productId)) {
      throw new ValidationError(
        'One product, one line. Add the quantities together rather than recording the same thing twice.'
      );
    }
    seen.add(line.productId);
  }
}

/**
 * Sort into a canonical order before any bucket is touched.
 *
 * ⚠️ EVERY LEDGER LEG TAKES AN ADVISORY BUCKET LOCK HELD TO COMMIT, so two
 *   records touching overlapping lots in opposite orders deadlock. Dispensing
 *   and goods receipt sort for the same reason, measured on PI-2's expiry sweep.
 */
function inLockOrder<T extends { productId: string }>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export async function recordConsumption(
  ctx: TenantContext,
  body: RecordConsumptionRequest,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionDetail> {
  const branchId = resolveBranchId(ctx, body.branchId, options.actingBranchId);
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  assertOneLinePerProduct(body.lines);

  const id = await withTenant(ctx, async (tx) => {
    const location = await resolveConsumptionLocation(tx, branchId, body.locationId);
    const anchor = await loadAnchor(tx, ctx, {
      encounterId: body.encounterId,
      encounterProcedureId: body.encounterProcedureId ?? null,
    });

    const template = anchor.procedureItemId
      ? await resolveTemplateInForceWithin(
          tx,
          ctx.organizationId,
          anchor.procedureItemId,
          occurredAt
        )
      : null;

    const context: PrepareContext = {
      branchId,
      expected: expectationsOf(template, await loadUnitGraph(tx)),
      options,
    };

    const prepared: PreparedLine[] = [];
    for (const line of inLockOrder(body.lines)) {
      prepared.push(await prepareLine(tx, ctx, context, line));
    }

    const consumptionId = randomUUID();
    await tx.clinicalConsumption.create({
      data: {
        id: consumptionId,
        organizationId: ctx.organizationId,
        branchId,
        kind: 'CONSUMPTION',
        anchorKind: body.anchorKind,
        encounterId: anchor.encounterId,
        encounterProcedureId: anchor.encounterProcedureId,
        patientId: anchor.patientId,
        locationId: location.id,
        templateId: template?.id ?? null,
        recordedById: ctx.userId,
        occurredAt,
        notes: body.notes ?? null,
      },
    });

    const written = await writeLines(tx, ctx, {
      consumptionId,
      branchId,
      startingLineNumber: 0,
      patientId: anchor.patientId,
      occurredAt,
      lines: prepared,
      movementType: 'CLINICAL_CONSUMPTION',
    });

    /*
     * ⚠️ THE MONEY SIDE, IN THE SAME TRANSACTION, AND CONSUMPTION STILL KNOWS
     *   NOTHING ABOUT BILLABILITY (PI-ADR-005). This is the caller PI-8 built
     *   the `INVENTORY` path for and left unwritten. A charge request that could
     *   commit without its consumption would, on the day the consumption rolls
     *   back — and the clinic bills for an implant nobody fitted.
     *
     * ⚠️ AND IT CANNOT STOP THE RECORDING. Every configuration gap in there is a
     *   nullable column, never an exception: a clinician must never be blocked
     *   because an accountant has not priced a bone graft. Most of these lines
     *   are `NEVER_BILL` gloves and reach `SUPPRESSED` with a reason, which is
     *   the normal outcome and not a failure.
     */
    await raiseChargeRequestsWithin(tx, ctx, {
      branchId,
      sourceType: 'INVENTORY',
      kind: 'SUPPLY',
      patientId: anchor.patientId,
      occurredAt,
      lines: written.map((line) => ({
        consumptionLineId: line.id,
        productId: line.productId,
        quantityBase: line.quantityBase,
      })),
    });

    /* ⚠️ Ids and counts. No product name, no patient name. */
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'clinical_consumption',
      entityId: consumptionId,
      branchId,
      after: {
        encounterId: anchor.encounterId,
        encounterProcedureId: anchor.encounterProcedureId,
        locationId: location.id,
        templateId: template?.id ?? null,
        lineCount: prepared.length,
        varianceLineCount: prepared.filter((line) => line.isOverride).length,
      },
      ...auditMeta(options),
    });

    return consumptionId;
  });

  return getConsumption(ctx, id, options);
}

/** The template's expectations, keyed by line id and already in base units. */
function expectationsOf(
  template: Awaited<ReturnType<typeof resolveTemplateInForceWithin>>,
  graph: Parameters<typeof templateLineBase>[0]
): Map<string, { productId: string; expectedBase: string }> {
  const out = new Map<string, { productId: string; expectedBase: string }>();
  for (const line of template?.lines ?? []) {
    out.set(line.id, {
      productId: line.productId,
      /*
       * ⚠️ AN OPTIONAL LINE EXPECTS ZERO, WHICH IS WHY IT IS PRE-FILLED AT ZERO
       *   AND NOT AT ITS QUANTITY. Using one is then a recorded variance —
       *   deliberately, because "sometimes we use a rubber dam" is exactly the
       *   thing a clinic wants counted rather than assumed.
       */
      expectedBase: line.isOptional ? '0' : templateLineBase(graph, line),
    });
  }
  return out;
}

interface WriteLinesInput {
  consumptionId: string;
  branchId: string;
  startingLineNumber: number;
  patientId: string;
  occurredAt: Date;
  lines: readonly PreparedLine[];
  movementType: 'CLINICAL_CONSUMPTION' | 'RETURN';
}

/**
 * Write the lines, their allocations and the ledger legs.
 *
 * ⚠️ ONE LEG PER LOT, THROUGH `recordMovementIn` AND NOTHING ELSE (PI-ADR-004).
 *   The sign is a property of the movement type and is CHECKed in the database;
 *   the quantity here is positive in both directions.
 */
async function writeLines(
  tx: TxClient,
  ctx: TenantContext,
  input: WriteLinesInput
): Promise<{ id: string; productId: string; quantityBase: string }[]> {
  const out: { id: string; productId: string; quantityBase: string }[] = [];
  let lineNumber = input.startingLineNumber;

  for (const line of input.lines) {
    lineNumber += 1;
    const created = await tx.consumptionLine.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        consumptionId: input.consumptionId,
        lineNumber,
        templateLineId: line.templateLineId,
        productId: line.productId,
        expectedQuantityBase: new Prisma.Decimal(line.expectedQuantityBase),
        quantityEntered: new Prisma.Decimal(line.quantityEntered),
        unitId: line.unitId,
        quantityBase: new Prisma.Decimal(line.quantityBase),
        isOverride: line.isOverride,
        overrideReason: line.overrideReason,
      },
      select: { id: true },
    });

    for (const allocation of line.allocations) {
      await tx.consumptionAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: input.branchId,
          consumptionLineId: created.id,
          locationId: allocation.locationId,
          batchId: allocation.batchId,
          serialId: allocation.serialId,
          quantityBase: allocation.quantityBase,
          isOverride: allocation.isOverride,
          overrideReason: allocation.overrideReason,
        },
      });

      await recordMovementIn(tx, ctx, {
        branchId: input.branchId,
        productId: line.productId,
        batchId: allocation.batchId,
        serialId: allocation.serialId,
        movementType: input.movementType,
        quantity: q(allocation.quantityBase),
        locationId: allocation.locationId,
        ...(input.movementType === 'CLINICAL_CONSUMPTION'
          ? { statusFrom: 'AVAILABLE' as const }
          : { statusTo: 'AVAILABLE' as const }),
        referenceType: 'CONSUMPTION',
        referenceId: input.consumptionId,
        occurredAt: input.occurredAt,
      });

      if (allocation.serialId) {
        await moveSerial(
          tx,
          allocation.serialId,
          input.movementType === 'CLINICAL_CONSUMPTION' ? input.patientId : null
        );
      }
    }

    out.push({ id: created.id, productId: line.productId, quantityBase: line.quantityBase });
  }

  return out;
}

/**
 * A serialised unit that has been fitted, or has come back off the trolley
 * unused.
 *
 * ⚠️ THE PATIENT ASSIGNMENT IS THE WHOLE POINT (PI-9.9, deferred here from
 *   PI-2). "Serial 7742 is in Mrs Rao" is what makes a device recall answerable
 *   at patient level rather than at lot level, and `serials.assigned_patient_id`
 *   is PHI for exactly that reason.
 *
 * ⚠️ AND A REVERSAL CLEARS IT. A device recorded in error and then corrected is
 *   back in stock; leaving the assignment behind would tell a recall that a
 *   named person has an implant they do not have, which is the more frightening
 *   of the two wrong answers.
 */
async function moveSerial(tx: TxClient, serialId: string, patientId: string | null): Promise<void> {
  await tx.serial.update({
    where: { id: serialId },
    data:
      patientId === null
        ? /*
           * ⚠️ `IN_STOCK`, NOT `RETURNED`. A device recorded in error never left
           *   the building — it came back off the trolley before anybody fitted
           *   it — and `RETURNED` means a patient brought one back, which is a
           *   different fact and a different question in a device audit.
           *
           * ⚠️ AND `assigned_at` GOES WITH IT. `serials_assignment_dated` is
           *   `(assigned_patient_id IS NULL) = (assigned_at IS NULL)`, so the
           *   two move together or the row is refused.
           */
          { status: 'IN_STOCK' as const, assignedPatientId: null, assignedAt: null }
        : { status: 'ISSUED', assignedPatientId: patientId, assignedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Amending, before the consultation closes
// ---------------------------------------------------------------------------

/**
 * Restate a record while the consultation is still open.
 *
 * ⚠️ "AMEND" MEANS THE RECORD IS RESTATED. THE LEDGER IS STILL APPEND-ONLY. Every
 *   quantity that changes writes a DELTA leg — `CLINICAL_CONSUMPTION` for more,
 *   `RETURN` for less — because `stock_ledger` has no update path and never will
 *   (PI-ADR-004). What an amendment buys over a correction is that the RECORD
 *   reads as one event rather than as three, which is what a clinician correcting
 *   a typo thirty seconds later actually means.
 *
 * ⚠️ THE ROW IS LOCKED FIRST. This is a read-then-write over running totals — the
 *   class that has cost this programme three phases — and two people amending one
 *   record would otherwise both compute their delta against the same stale
 *   quantities and both write legs.
 *
 * ⚠️ AND IT REFUSES ONCE THE MONEY HAS MOVED. A line that has reached an invoice
 *   is corrected by the returns and credit-note path, which knows how to reverse
 *   a document somebody has already been handed.
 */
export async function amendConsumption(
  ctx: TenantContext,
  id: string,
  body: AmendConsumptionRequest,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionDetail> {
  assertOneLinePerProduct(body.lines);

  await withTenant(ctx, async (tx) => {
    await lockConsumption(tx, id);

    const record = await tx.clinicalConsumption.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        lines: {
          include: {
            product: { select: { name: true } },
            allocations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
            chargeRequests: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (!record) throw new NotFoundError('Consumption');

    if (record.kind !== 'CONSUMPTION') {
      throw new ConflictError(
        'A correction is a record in its own right and is not amended. Write another correction.'
      );
    }

    const anchor = await loadAnchor(tx, ctx, {
      encounterId: record.encounterId,
      encounterProcedureId: record.encounterProcedureId,
    });
    if (!anchor.isOpen) {
      throw new ConflictError(
        'This consultation has been signed, so what it consumed is part of the record. ' +
          'Correct it with a compensating entry instead — the ledger is corrected by another ' +
          'movement, never by an edit.'
      );
    }

    const invoiced = record.lines.some((line) =>
      line.chargeRequests.some((charge) => charge.status === 'INVOICED')
    );
    if (invoiced) {
      throw new ConflictError(
        'Something on this record has reached a patient bill. Raise a credit note against that ' +
          'invoice rather than restating what was used.'
      );
    }

    const template = record.templateId
      ? await resolveTemplateInForceWithin(
          tx,
          ctx.organizationId,
          anchor.procedureItemId ?? '',
          record.occurredAt
        )
      : null;
    const context: PrepareContext = {
      branchId: record.branchId,
      expected: expectationsOf(template, await loadUnitGraph(tx)),
      options,
    };

    const existingByProduct = new Map(record.lines.map((line) => [line.productId, line]));
    const requestedProducts = new Set(body.lines.map((line) => line.productId));

    /*
     * ⚠️ REMOVED LINES ARE UN-RECORDED IN FULL, AND THE ROW GOES WITH THEM. A
     *   line restated to zero cannot be stored — `consumption_lines_quantities_valid`
     *   refuses a zero quantity, deliberately, because "used none of it" is a
     *   line nobody should have written rather than a zero-quantity ledger leg.
     *   So the stock goes back with `RETURN` legs and the row is deleted, taking
     *   its PENDING charge request with it by cascade.
     *
     *   The durable record is the LEDGER, which keeps both legs for ever: the
     *   consumption that took it off the shelf and the return that put it back.
     *   Deleting the line loses no history that anybody can be billed or audited
     *   against — and this path is reachable only while the consultation is
     *   still open and nothing has been invoiced, both asserted above.
     */
    for (const line of record.lines) {
      if (requestedProducts.has(line.productId)) continue;
      await returnQuantity(tx, ctx, record, line, line.quantityBase);
      await tx.consumptionLine.delete({ where: { id: line.id } });
    }

    let maxLineNumber = record.lines.reduce((max, line) => Math.max(max, line.lineNumber), 0);
    const added: PreparedLine[] = [];

    for (const requested of inLockOrder(body.lines)) {
      const existing = existingByProduct.get(requested.productId);
      if (!existing) {
        added.push(await prepareLine(tx, ctx, context, requested));
        continue;
      }
      await restateLine(tx, ctx, record, existing, requested, context);
    }

    if (added.length > 0) {
      const written = await writeLines(tx, ctx, {
        consumptionId: record.id,
        branchId: record.branchId,
        startingLineNumber: maxLineNumber,
        patientId: record.patientId,
        occurredAt: record.occurredAt,
        lines: added,
        movementType: 'CLINICAL_CONSUMPTION',
      });
      maxLineNumber += added.length;

      await raiseChargeRequestsWithin(tx, ctx, {
        branchId: record.branchId,
        sourceType: 'INVENTORY',
        kind: 'SUPPLY',
        patientId: record.patientId,
        occurredAt: record.occurredAt,
        lines: written.map((line) => ({
          consumptionLineId: line.id,
          productId: line.productId,
          quantityBase: line.quantityBase,
        })),
      });
    }

    await tx.clinicalConsumption.update({
      where: { id: record.id },
      data: {
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        amendedById: ctx.userId,
        amendedAt: new Date(),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinical_consumption',
      entityId: record.id,
      branchId: record.branchId,
      before: { lineCount: record.lines.length },
      after: { lineCount: body.lines.length, reason: body.reason },
      ...auditMeta(options),
    });
  });

  return getConsumption(ctx, id, options);
}

type StoredLine = Prisma.ConsumptionLineGetPayload<{
  include: {
    product: { select: { name: true } };
    allocations: true;
    chargeRequests: { select: { id: true; status: true } };
  };
}>;

type StoredRecord = { id: string; branchId: string; patientId: string; occurredAt: Date };

/**
 * Move one stored line to a new quantity, writing only the difference.
 *
 * ⚠️ THE CHARGE REQUEST IS UPDATED IN PLACE RATHER THAN RE-RAISED, AND THAT IS
 *   NOT A SHORTCUT. `charge_requests_one_per_consumption_line_key` allows
 *   exactly one row per line, so a second could not be written; and the POLICY
 *   and the PRICE on that row are a SNAPSHOT taken at the moment of the original
 *   recording (PI-8, decision 4). An amendment corrects the QUANTITY somebody
 *   used, not the clinic's pricing decision, so re-resolving would restate a
 *   Friday supply at Monday's prices for no reason anybody asked for.
 */
async function restateLine(
  tx: TxClient,
  ctx: TenantContext,
  record: StoredRecord,
  existing: StoredLine,
  requested: ConsumptionLineRequest,
  context: PrepareContext
): Promise<void> {
  const prepared = await prepareLineForRestatement(tx, context, requested, existing);
  const before = existing.quantityBase;
  const after = new Prisma.Decimal(prepared.quantityBase);

  if (after.gt(before)) {
    const delta = after.sub(before);
    const allocations = await resolveIssueAllocations(
      tx,
      ctx,
      record.branchId,
      existing.productId,
      existing.product.name,
      q(delta),
      requested.allocations
    );
    for (const allocation of allocations) {
      await tx.consumptionAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: record.branchId,
          consumptionLineId: existing.id,
          locationId: allocation.locationId,
          batchId: allocation.batchId,
          serialId: allocation.serialId,
          quantityBase: allocation.quantityBase,
          isOverride: allocation.isOverride,
          overrideReason: allocation.overrideReason,
        },
      });
      await recordMovementIn(tx, ctx, {
        branchId: record.branchId,
        productId: existing.productId,
        batchId: allocation.batchId,
        serialId: allocation.serialId,
        movementType: 'CLINICAL_CONSUMPTION',
        quantity: q(allocation.quantityBase),
        locationId: allocation.locationId,
        statusFrom: 'AVAILABLE',
        referenceType: 'CONSUMPTION',
        referenceId: record.id,
        occurredAt: record.occurredAt,
      });
      if (allocation.serialId) await moveSerial(tx, allocation.serialId, record.patientId);
    }
  } else if (after.lt(before)) {
    await returnQuantity(tx, ctx, record, existing, before.sub(after));
  }

  await tx.consumptionLine.update({
    where: { id: existing.id },
    data: {
      quantityEntered: new Prisma.Decimal(prepared.quantityEntered),
      unitId: prepared.unitId,
      quantityBase: after,
      expectedQuantityBase: new Prisma.Decimal(prepared.expectedQuantityBase),
      isOverride: prepared.isOverride,
      overrideReason: prepared.overrideReason,
    },
  });

  if (!after.eq(before)) {
    /*
     * The billed quantity is derived from the base figure by the charge engine,
     * so restating it here would need the unit graph and the priced unit — which
     * is what `raiseChargeRequestsWithin` does. Rather than duplicate that
     * arithmetic, the row is CANCELLED and the line's charge is re-raised, which
     * the partial unique permits because a cancelled row is deleted first.
     */
    const pending = existing.chargeRequests.filter((charge) => charge.status !== 'INVOICED');
    if (pending.length > 0) {
      await tx.chargeRequest.deleteMany({ where: { id: { in: pending.map((c) => c.id) } } });
      await raiseChargeRequestsWithin(tx, ctx, {
        branchId: record.branchId,
        sourceType: 'INVENTORY',
        kind: 'SUPPLY',
        patientId: record.patientId,
        occurredAt: record.occurredAt,
        lines: [
          {
            consumptionLineId: existing.id,
            productId: existing.productId,
            quantityBase: q(after),
          },
        ],
      });
    }
  }
}

/**
 * `prepareLine`, minus the allocation planning the caller does itself.
 *
 * ⚠️ IT EXISTS BECAUSE A RESTATEMENT ALLOCATES THE DELTA, NOT THE TOTAL. Calling
 *   `prepareLine` would plan the whole new quantity against the shelf and then
 *   the caller would move only the difference — so a line going from 10 to 11
 *   would be refused whenever the shelf held fewer than 11, which is wrong: 10
 *   of them are already off it.
 */
async function prepareLineForRestatement(
  tx: TxClient,
  context: PrepareContext,
  requested: ConsumptionLineRequest,
  existing: StoredLine
): Promise<Omit<PreparedLine, 'allocations'>> {
  const product = await tx.product.findFirst({
    where: { id: existing.productId },
    select: { id: true, name: true, baseUnitId: true, baseUnit: { select: { code: true } } },
  });
  if (!product) throw new NotFoundError('Product');

  const quantityBase = await toBaseUnits(
    tx,
    movementDeps,
    { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
    { quantity: requested.quantity, unitId: requested.unitId }
  );

  /*
   * ⚠️ THE EXPECTATION IS RE-READ FROM THE TEMPLATE, NOT KEPT FROM THE STORED
   *   ROW, so that a line whose template pairing CHANGES in the amendment gets
   *   the pairing re-checked. The `productId` match inside `expected` is what
   *   refuses a line claiming somebody else's template line.
   */
  let expectedBase = '0';
  let templateLineId: string | null = null;
  if (requested.templateLineId) {
    const expectation = context.expected.get(requested.templateLineId);
    if (!expectation || expectation.productId !== product.id) {
      throw new ValidationError(`${product.name} does not match the template line this cites.`);
    }
    templateLineId = requested.templateLineId;
    expectedBase = expectation.expectedBase;
  }

  const isOverride = !new Prisma.Decimal(quantityBase).eq(new Prisma.Decimal(expectedBase));
  if (isOverride) {
    assertMayOverride(context.options, product.name, expectedBase, quantityBase);
    if (!(requested.overrideReason ?? '').trim()) {
      throw new ValidationError(
        `${product.name}: the template expected ${expectedBase} and this records ${quantityBase}. Say why.`
      );
    }
  }

  return {
    productId: product.id,
    productName: product.name,
    templateLineId,
    quantityEntered: requested.quantity,
    unitId: requested.unitId,
    quantityBase,
    expectedQuantityBase: expectedBase,
    isOverride,
    overrideReason: isOverride ? (requested.overrideReason ?? null) : null,
  };
}

/**
 * Put quantity back, into the lots it came out of.
 *
 * ⚠️ THE LOT IT GOES BACK INTO IS THE LOT IT CAME OUT OF, NEWEST ALLOCATION
 *   FIRST. Returning to whichever lot is oldest would make a recall miss the
 *   units it went looking for — `dispense_return_lines` states the same rule and
 *   for the same reason.
 *
 * ⚠️ AND THE ALLOCATION ROWS ARE REDUCED, NOT LEFT STANDING. The allocations of
 *   a line have to keep summing to its quantity or the traceability read stops
 *   agreeing with the record it is a breakdown of.
 */
async function returnQuantity(
  tx: TxClient,
  ctx: TenantContext,
  record: StoredRecord,
  line: StoredLine,
  quantity: Prisma.Decimal
): Promise<void> {
  let remaining = quantity;
  /* Newest first: the most recently added allocation is the one being undone. */
  const allocations = [...line.allocations].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
  );

  for (const allocation of allocations) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(remaining, allocation.quantityBase);
    if (take.lte(0)) continue;

    await recordMovementIn(tx, ctx, {
      branchId: record.branchId,
      productId: line.productId,
      batchId: allocation.batchId,
      serialId: allocation.serialId,
      movementType: 'RETURN',
      quantity: q(take),
      locationId: allocation.locationId,
      statusTo: 'AVAILABLE',
      referenceType: 'CONSUMPTION',
      referenceId: record.id,
      occurredAt: record.occurredAt,
    });

    const left = allocation.quantityBase.sub(take);
    if (left.lte(0)) {
      await tx.consumptionAllocation.delete({ where: { id: allocation.id } });
      /* A device that was not used after all is back in stock and unassigned. */
      if (allocation.serialId) await moveSerial(tx, allocation.serialId, null);
    } else {
      await tx.consumptionAllocation.update({
        where: { id: allocation.id },
        data: { quantityBase: left },
      });
    }
    remaining = remaining.sub(take);
  }

  if (remaining.gt(0)) {
    /*
     * Unreachable while the allocations sum to the line quantity — which the
     * write path guarantees and this function maintains. Stated rather than
     * assumed, because a silent shortfall here would put stock back that the
     * clinic never took off the shelf.
     */
    throw new ConflictError(
      `${line.product.name}: the lots recorded against this line do not cover the quantity being put back.`
    );
  }
}

/**
 * Serialise two people changing one record.
 *
 * `FOR UPDATE` on the row rather than an advisory lock, because the row is real,
 * the lock is released by COMMIT without anybody remembering to, and RLS applies
 * to it — a lock on another tenant's id locks nothing and the subsequent read
 * 404s, which is the same answer every other path gives. `decideChargeRequest`
 * uses the identical shape.
 */
async function lockConsumption(tx: TxClient, consumptionId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM clinical_consumptions WHERE id = ${consumptionId}::uuid FOR UPDATE
  `;
}

// ---------------------------------------------------------------------------
// Correcting, after the consultation has closed
// ---------------------------------------------------------------------------

/**
 * A compensating record against one that can no longer be amended.
 *
 * ⚠️ A SECOND RECORD, NEVER AN EDIT — the discipline the ledger itself applies,
 *   and the one an invoice applies through a credit note. What was recorded
 *   stays recorded; the correction cites it and carries its own reason.
 *
 * ⚠️ THE ORIGINAL IS LOCKED, because a `CONSUMPTION_REVERSAL` is a read-then-write
 *   over a running total: how much of this product may still be put back is what
 *   was consumed minus what has already been reversed, and two corrections
 *   raced would both measure against the same untouched remainder and both
 *   commit. That is PI-8.11's `alreadyCreditedByItem` finding, exactly.
 */
export async function correctConsumption(
  ctx: TenantContext,
  id: string,
  body: CorrectConsumptionRequest,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionDetail> {
  assertOneLinePerProduct(body.lines);

  const correctionId = await withTenant(ctx, async (tx) => {
    await lockConsumption(tx, id);

    const original = await tx.clinicalConsumption.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        lines: {
          include: {
            product: { select: { name: true } },
            allocations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
            chargeRequests: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (!original) throw new NotFoundError('Consumption');
    if (original.kind !== 'CONSUMPTION') {
      throw new ConflictError(
        'A correction cites the original record, not another correction. Cite the original.'
      );
    }

    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
    const newId = randomUUID();

    await tx.clinicalConsumption.create({
      data: {
        id: newId,
        organizationId: ctx.organizationId,
        branchId: original.branchId,
        kind: body.kind,
        anchorKind: original.anchorKind,
        encounterId: original.encounterId,
        encounterProcedureId: original.encounterProcedureId,
        patientId: original.patientId,
        locationId: original.locationId,
        templateId: original.templateId,
        recordedById: ctx.userId,
        occurredAt,
        correctsConsumptionId: original.id,
        correctionReason: body.reason,
      },
    });

    if (body.kind === 'ADDITIONAL_CONSUMPTION') {
      await recordAdditional(tx, ctx, original, newId, occurredAt, body, options);
    } else {
      await recordReversal(tx, ctx, original, newId, occurredAt, body);
    }

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'clinical_consumption',
      entityId: newId,
      branchId: original.branchId,
      after: {
        kind: body.kind,
        correctsConsumptionId: original.id,
        lineCount: body.lines.length,
        reason: body.reason,
      },
      ...auditMeta(options),
    });

    return newId;
  });

  return getConsumption(ctx, correctionId, options);
}

type OriginalRecord = Prisma.ClinicalConsumptionGetPayload<{
  include: {
    lines: {
      include: {
        product: { select: { name: true } };
        allocations: true;
        chargeRequests: { select: { id: true; status: true } };
      };
    };
  };
}>;

/** More was used than was recorded. Stock goes out; a SUPPLY charge follows. */
async function recordAdditional(
  tx: TxClient,
  ctx: TenantContext,
  original: OriginalRecord,
  correctionId: string,
  occurredAt: Date,
  body: CorrectConsumptionRequest,
  options: ConsumptionActionOptions
): Promise<void> {
  /*
   * ⚠️ A CORRECTION EXPECTS NOTHING, SO EVERY LINE ON IT IS A VARIANCE. That is
   *   the honest reading: the template's expectation was already answered by the
   *   original record, and counting it twice would double the expected column in
   *   every variance report. The reason is therefore always required, which
   *   `correctConsumptionRequest` asks for at the document level too.
   */
  const context: PrepareContext = { branchId: original.branchId, expected: new Map(), options };

  const prepared: PreparedLine[] = [];
  for (const line of inLockOrder(body.lines)) {
    prepared.push(
      await prepareLine(tx, ctx, context, {
        ...line,
        templateLineId: null,
        overrideReason: line.overrideReason ?? body.reason,
      })
    );
  }

  const written = await writeLines(tx, ctx, {
    consumptionId: correctionId,
    branchId: original.branchId,
    startingLineNumber: 0,
    patientId: original.patientId,
    occurredAt,
    lines: prepared,
    movementType: 'CLINICAL_CONSUMPTION',
  });

  await raiseChargeRequestsWithin(tx, ctx, {
    branchId: original.branchId,
    sourceType: 'INVENTORY',
    kind: 'SUPPLY',
    patientId: original.patientId,
    occurredAt,
    lines: written.map((line) => ({
      consumptionLineId: line.id,
      productId: line.productId,
      quantityBase: line.quantityBase,
    })),
  });
}

/**
 * Less was used than was recorded. Stock goes back; a REVERSAL charge follows.
 *
 * ⚠️ THE CEILING IS WHAT THE ORIGINAL CONSUMED MINUS WHAT HAS ALREADY COME BACK,
 *   AND IT IS COMPUTED UNDER THE LOCK THE CALLER TOOK. Without it a product
 *   could be reversed twice and the ledger would put back more than ever came
 *   off the shelf — the balance CHECK would eventually refuse it, but as a
 *   Postgres 23514 reaching `errorHandler` with no case for it, which is a 500
 *   where the honest answer is "that has already been put back".
 */
async function recordReversal(
  tx: TxClient,
  ctx: TenantContext,
  original: OriginalRecord,
  correctionId: string,
  occurredAt: Date,
  body: CorrectConsumptionRequest
): Promise<void> {
  const originalByProduct = new Map(original.lines.map((line) => [line.productId, line]));

  const alreadyReversed = await tx.consumptionLine.groupBy({
    by: ['productId'],
    where: {
      organizationId: ctx.organizationId,
      consumption: { correctsConsumptionId: original.id, kind: 'CONSUMPTION_REVERSAL' },
    },
    _sum: { quantityBase: true },
  });
  const reversedByProduct = new Map(
    alreadyReversed.map((row) => [row.productId, row._sum.quantityBase ?? new Prisma.Decimal(0)])
  );

  let lineNumber = 0;
  const written: { id: string; productId: string; quantityBase: string }[] = [];

  for (const requested of inLockOrder(body.lines)) {
    const source = originalByProduct.get(requested.productId);
    if (!source) {
      throw new ValidationError(
        'One of these lines names a product the original record does not. Nothing can be put back that was never taken.'
      );
    }

    const product = await tx.product.findFirst({
      where: { id: requested.productId },
      select: { id: true, name: true, baseUnitId: true, baseUnit: { select: { code: true } } },
    });
    if (!product) throw new NotFoundError('Product');

    const quantityBase = new Prisma.Decimal(
      await toBaseUnits(
        tx,
        movementDeps,
        { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
        { quantity: requested.quantity, unitId: requested.unitId }
      )
    );

    const remaining = source.quantityBase.sub(
      reversedByProduct.get(product.id) ?? new Prisma.Decimal(0)
    );
    if (quantityBase.gt(remaining)) {
      throw new ConflictError(
        `${product.name}: ${q(remaining)} of what was recorded is still outstanding, and this puts ` +
          `back ${q(quantityBase)}. Nothing can be un-used twice.`
      );
    }

    lineNumber += 1;
    const created = await tx.consumptionLine.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: original.branchId,
        consumptionId: correctionId,
        lineNumber,
        templateLineId: null,
        productId: product.id,
        /* A correction expects nothing — see `recordAdditional`. */
        expectedQuantityBase: new Prisma.Decimal(0),
        quantityEntered: new Prisma.Decimal(requested.quantity),
        unitId: requested.unitId,
        quantityBase,
        isOverride: true,
        overrideReason: requested.overrideReason ?? body.reason,
      },
      select: { id: true },
    });

    /*
     * ⚠️ IT GOES BACK INTO THE LOTS IT CAME OUT OF, which is why the ORIGINAL
     *   line's allocations are walked rather than a fresh FEFO plan being made.
     *   FEFO answers "which lot should go out next" and has nothing to say about
     *   where something belongs on its way in; putting it back in the wrong lot
     *   makes a recall miss the units it went looking for.
     */
    let remainingToPlace = quantityBase;
    for (const allocation of source.allocations) {
      if (remainingToPlace.lte(0)) break;
      const take = Prisma.Decimal.min(remainingToPlace, allocation.quantityBase);
      if (take.lte(0)) continue;

      await tx.consumptionAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: original.branchId,
          consumptionLineId: created.id,
          locationId: allocation.locationId,
          batchId: allocation.batchId,
          serialId: allocation.serialId,
          quantityBase: take,
          isOverride: false,
          overrideReason: null,
        },
      });

      await recordMovementIn(tx, ctx, {
        branchId: original.branchId,
        productId: product.id,
        batchId: allocation.batchId,
        serialId: allocation.serialId,
        movementType: 'RETURN',
        quantity: q(take),
        locationId: allocation.locationId,
        statusTo: 'AVAILABLE',
        referenceType: 'CONSUMPTION',
        referenceId: correctionId,
        occurredAt,
      });

      if (allocation.serialId) await moveSerial(tx, allocation.serialId, null);
      remainingToPlace = remainingToPlace.sub(take);
    }

    written.push({ id: created.id, productId: product.id, quantityBase: q(quantityBase) });
  }

  /*
   * ⚠️ A REVERSAL CHARGE, NOT AN EDIT OF THE ORIGINAL ONE. Where the original
   *   never reached a bill this reduces nothing anybody owed and the pair is
   *   reconciled on the charge queue; where it DID, the reversal becomes a
   *   credit note through the engine PI-8 built. Either way the original charge
   *   request stands, because rewriting it would lose the fact that the material
   *   was recorded as used.
   */
  await raiseChargeRequestsWithin(tx, ctx, {
    branchId: original.branchId,
    sourceType: 'INVENTORY',
    kind: 'REVERSAL',
    patientId: original.patientId,
    occurredAt,
    lines: written.map((line) => ({
      consumptionLineId: line.id,
      productId: line.productId,
      quantityBase: line.quantityBase,
    })),
  });
}
