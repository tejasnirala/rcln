/**
 * The order itself: taken, accepted, stood down (PI-12).
 *
 * `fulfilment.service.ts` is the other half — packing, shipping, delivering.
 * The split is where the risk changes: nothing in THIS file moves stock except
 * `confirmOnlineOrder`, which HOLDS it, and nothing here ever dispenses.
 *
 * ── THE FOUR ACTS, AND WHICH ONE COSTS WHAT ─────────────────────────────────
 *
 *   create / update   a draft. Writes rows and nothing else. Abandoning one
 *                     costs the clinic nothing and burns no number.
 *   confirm           ⚠️ THE EXPENSIVE ONE. Per line: assert the world, check
 *                     the clinic has cleared the product for remote supply, ASK
 *                     THE LAW and snapshot the answer, plan FEFO, and HOLD the
 *                     lots. Then issue the number. One transaction.
 *   cancel            release every hold, and say why.
 *
 * ── THE GATE THAT MAKES "NO PRODUCT IS ONLINEABLE BY DEFAULT" TRUE ──────────
 * ⚠️ IT IS CHECKED HERE AND *ALSO* IN `@rcln/regulatory`, AND THE DUPLICATION IS
 *   THE WHOLE POINT. The engine raises the same gap as a decision reason, which
 *   is snapshotted and shown beside the law — but a REFUSED decision stops
 *   nothing until a named human signs the jurisdiction's pack off, and no pack
 *   is `PRODUCTION_ENABLED` today (`enforcement.ts` says why at length). So if
 *   the engine were the only gate, every product in every configured country
 *   would be sendable by post the day this shipped, which is the exact fail-open
 *   the phase exists to close.
 *
 *   What this file refuses is not a jurisdiction's law. It is the CLINIC's own
 *   record of what the product is here — `product_regulatory_profiles
 *   .online_sale_position`, written by whoever holds `product.regulatory.manage`
 *   — and refusing on the clinic's own configuration is the same class of check
 *   as `is_dispensing_point` and `products.status`, both of which the dispense
 *   service already enforces directly. `onlineSaleGapMessage` is shared with the
 *   engine so the two never say it differently.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * An order carries a named person's HOME ADDRESS beside the medicines going to
 * it. Reads log through `recordDataAccess` under `ONLINE_ORDER`; audit rows
 * carry ids and counts; no log line from this file names a patient, an address
 * or a product.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CancelOnlineOrderRequest,
  ConfirmOnlineOrderRequest,
  CreateOnlineOrderRequest,
  OnlineOrderDetail,
  PatientConsultationsQuery,
  PatientConsultationsResponse,
  OnlineOrderLineDetail,
  OnlineOrderListResponse,
  OnlineOrderQuery,
  OnlineOrderSummary,
  UpdateOnlineOrderRequest,
} from '@rcln/contracts';
import { formatJurisdiction, onlineSaleGap, onlineSaleGapMessage } from '@rcln/regulatory';
import { toBaseUnits } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { movementDeps } from '../inventory/movement.service.js';
import { planStockAllocationWithin } from '../inventory/allocation.service.js';
import { releaseReservationIn, reserveStockIn } from '../inventory/reservation.service.js';
import { branchJurisdictionWithin, loadProfile } from '../regulatory/evaluation.service.js';
import { startOfCalendarDay } from '../product/values.js';
import { consultForSupply, presentedPrescriptionFor } from './consult.js';
import { NOTIFICATION_JOB } from '@rcln/queue';

import { notifyAboutOrder } from './notify.js';
import {
  ageYearsOn,
  assertBranchInScope,
  auditMeta,
  q,
  resolveBranchId,
  resolveDispensingLocation,
} from './shared.js';
import type { PharmacyActionOptions } from './queue.service.js';

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

const detailInclude = Prisma.validator<Prisma.OnlineOrderInclude>()({
  branch: { select: { name: true } },
  location: { select: { name: true } },
  patient: { select: { firstName: true, lastName: true, uhid: true } },
  dispense: { select: { dispenseNumber: true } },
  placedBy: { select: { fullName: true } },
  confirmedBy: { select: { fullName: true } },
  packedBy: { select: { fullName: true } },
  cancelledBy: { select: { fullName: true } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
      regulatoryDecision: true,
    },
  },
  shipment: {
    include: {
      shippedBy: { select: { fullName: true } },
      deliveredBy: { select: { fullName: true } },
      failedBy: { select: { fullName: true } },
    },
  },
});

type DetailRow = Prisma.OnlineOrderGetPayload<{ include: typeof detailInclude }>;

function patientName(patient: { firstName: string; lastName: string | null }): string {
  return patient.lastName ? `${patient.firstName} ${patient.lastName}` : patient.firstName;
}

/**
 * The stored acceptance decision, back in the shape the counter reads.
 *
 * ⚠️ READ OFF THE SNAPSHOT AND NEVER RE-EVALUATED (PI-ADR-008), for the reason
 *   `dispense.service.ts` gives: the rules may have been superseded twice since
 *   the order was accepted, and the record has to keep saying what it said on
 *   the day the clinic told somebody their medicine was coming.
 */
function decisionFromSnapshot(
  row: NonNullable<DetailRow['lines'][number]['regulatoryDecision']>
  /* ⚠️ `NonNullable`, because the CONTRACT field is nullable and this function
   *   is never called with a null row — a bare `acceptanceDecision` return type
   *   makes `.conditions` unreachable at every call site. */
): NonNullable<OnlineOrderLineDetail['acceptanceDecision']> {
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

function toSummary(row: DetailRow): OnlineOrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    branchId: row.branchId,
    branchName: row.branch.name,
    channel: row.channel,
    status: row.status,
    patientId: row.patientId,
    patientName: patientName(row.patient),
    patientUhid: row.patient.uhid,
    encounterId: row.encounterId,
    locationId: row.locationId,
    locationName: row.location.name,
    destination: formatJurisdiction({
      countryCode: row.destinationCountryCode,
      regionCode: row.destinationRegionCode,
    }),
    city: row.city,
    placedAt: row.placedAt.toISOString(),
    placedByName: row.placedBy.fullName,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    packedAt: row.packedAt?.toISOString() ?? null,
    lineCount: row.lines.length,
    dispenseId: row.dispenseId,
    dispenseNumber: row.dispense?.dispenseNumber ?? null,
    hasConditions: row.lines.some((line) => {
      const decision = line.regulatoryDecision;
      return decision !== null && decisionFromSnapshot(decision).conditions.length > 0;
    }),
  };
}

/**
 * How much of each line is currently HELD.
 *
 * ⚠️ DERIVED FROM `stock_reservations` AND NEVER STORED, for the reason pharmacy
 *   stores no dispensed-so-far column on the clinical record. The sweep can
 *   release a hold without telling this table, so a stored copy would be a
 *   second answer free to disagree with the buckets — and it is the buckets that
 *   decide whether the parcel can actually be made up.
 *
 * ⚠️ AND THE EMPTY CASE RETURNS AN EMPTY MAP RATHER THAN QUERYING WITH
 *   `{ in: [] }`. Prisma turns an empty `in` into a predicate that matches
 *   nothing here, which happens to be right — but the same shape read as `{}`
 *   elsewhere in this programme returned every row in the tenant (PI-10's
 *   review), so this codebase does not write it at all.
 */
async function heldByLine(
  tx: TxClient,
  organizationId: string,
  lineIds: readonly string[]
): Promise<Map<string, Prisma.Decimal>> {
  if (lineIds.length === 0) return new Map();

  const rows = await tx.stockReservation.groupBy({
    by: ['referenceId'],
    where: {
      organizationId,
      referenceType: 'ONLINE_ORDER',
      referenceId: { in: [...lineIds] },
      status: 'ACTIVE',
    },
    _sum: { quantityBase: true },
  });

  const out = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    if (row.referenceId === null) continue;
    out.set(row.referenceId, row._sum.quantityBase ?? new Prisma.Decimal(0));
  }
  return out;
}

async function toDetail(tx: TxClient, row: DetailRow): Promise<OnlineOrderDetail> {
  const held = await heldByLine(
    tx,
    row.organizationId,
    row.lines.map((line) => line.id)
  );

  return {
    ...toSummary(row),
    address: {
      recipientName: row.recipientName,
      recipientPhone: row.recipientPhone,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      destinationCountryCode: row.destinationCountryCode,
      destinationRegionCode: row.destinationRegionCode,
      patientAddressId: row.patientAddressId,
    },
    notes: row.notes,
    confirmedByName: row.confirmedBy?.fullName ?? null,
    packedByName: row.packedBy?.fullName ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledByName: row.cancelledBy?.fullName ?? null,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      encounterPrescriptionId: line.encounterPrescriptionId,
      productId: line.productId,
      productName: line.product.name,
      quantityEntered: q(line.quantityEntered),
      unitId: line.unitId,
      unitSymbol: line.unit.symbol,
      quantityBase: q(line.quantityBase),
      baseUnitSymbol: line.product.baseUnit.symbol,
      acceptanceDecision:
        line.regulatoryDecision === null ? null : decisionFromSnapshot(line.regulatoryDecision),
      heldQuantityBase: q(held.get(line.id) ?? new Prisma.Decimal(0)),
    })),
    shipment:
      row.shipment === null
        ? null
        : {
            id: row.shipment.id,
            carrierName: row.shipment.carrierName,
            serviceLevel: row.shipment.serviceLevel,
            trackingReference: row.shipment.trackingReference,
            packageCount: row.shipment.packageCount,
            shippedAt: row.shipment.shippedAt.toISOString(),
            shippedByName: row.shipment.shippedBy.fullName,
            deliveredAt: row.shipment.deliveredAt?.toISOString() ?? null,
            deliveredByName: row.shipment.deliveredBy?.fullName ?? null,
            receivedByName: row.shipment.receivedByName,
            failedAt: row.shipment.failedAt?.toISOString() ?? null,
            failedByName: row.shipment.failedBy?.fullName ?? null,
            failureReason: row.shipment.failureReason,
            notes: row.shipment.notes,
          },
  };
}

export async function listOnlineOrders(
  ctx: TenantContext,
  query: OnlineOrderQuery,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderListResponse> {
  /*
   * ⚠️ THE HOUSE PATTERN, AND IT WAS MISSING (PI-12, security review).
   *   `branch_isolation` already makes an out-of-scope filter return nothing, so
   *   this is defence in depth rather than a fix — but `queue.service.ts` and
   *   `consumption.service.ts` both do it on the identical shape, and a list
   *   that diverges from its two siblings is the one somebody later reads as
   *   evidence the check is optional.
   */
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.OnlineOrderWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.encounterId ? { encounterId: query.encounterId } : {}),
      ...(query.productId ? { lines: { some: { productId: query.productId } } } : {}),
      ...(query.trackingReference
        ? { shipment: { trackingReference: query.trackingReference } }
        : {}),
      ...(query.from || query.to
        ? {
            placedAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.onlineOrder.count({ where }),
      tx.onlineOrder.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: detailInclude,
      }),
    ]);

    /*
     * ⚠️ ONE ROW PER REQUEST, NOT PER RESULT, AND UNDER ITS OWN RESOURCE. The
     *   list returns a page of named people and the towns their medicine is
     *   going to, which is a broader disclosure than the dispensing list and is
     *   exactly why `ONLINE_ORDER` is not folded into `PRESCRIPTION`.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'ONLINE_ORDER',
      resultCount: rows.length,
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      orders: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getOnlineOrder(
  ctx: TenantContext,
  id: string,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.onlineOrder.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: detailInclude,
    });
    if (!row) throw new NotFoundError('Online order');

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'ONLINE_ORDER',
      resourceId: row.id,
      branchId: row.branchId,
      patientId: row.patientId,
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return toDetail(tx, row);
  });
}

// ---------------------------------------------------------------------------
// The world an order asserts, re-asserted at every act that relies on it
// ---------------------------------------------------------------------------

interface ResolvedLine {
  encounterPrescriptionId: string | null;
  productId: string;
  quantityEntered: string;
  unitId: string;
  quantityBase: string;
}

/**
 * The patient this order is for, and the consultation behind it.
 *
 * ⚠️ THE PATIENT IS RE-READ RATHER THAN TRUSTED FROM THE ROW, AND WHERE AN
 *   ENCOUNTER IS CITED THE TWO MUST AGREE. An order whose encounter belongs to
 *   somebody else would file one person's prescription against another person's
 *   address — the online equivalent of the body-supplied-patient hole
 *   `createDispense` closes on the prescription path.
 */
async function resolveSubject(
  tx: TxClient,
  ctx: TenantContext,
  patientId: string,
  encounterId: string | null
): Promise<{
  dateOfBirth: Date | null;
  subjectType: 'HUMAN' | 'ANIMAL';
  species: string | null;
  encounter: {
    id: string;
    finalizedAt: Date | null;
    startedAt: Date;
    prescriberUserId: string | null;
    prescriptions: {
      id: string;
      productId: string;
      repeatsAuthorised: boolean | null;
      repeatsAuthorisedLimit: number | null;
    }[];
  } | null;
}> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, organizationId: ctx.organizationId, deletedAt: null },
    select: {
      id: true,
      dateOfBirth: true,
      subjectType: true,
      animalProfile: { select: { species: true } },
    },
  });
  if (!patient) throw new NotFoundError('Patient');

  if (encounterId === null) {
    return {
      dateOfBirth: patient.dateOfBirth,
      subjectType: patient.subjectType,
      species: patient.animalProfile?.species ?? null,
      encounter: null,
    };
  }

  const encounter = await tx.encounter.findFirst({
    where: { id: encounterId, organizationId: ctx.organizationId, deletedAt: null },
    select: {
      id: true,
      status: true,
      patientId: true,
      finalizedAt: true,
      startedAt: true,
      doctorProfile: { select: { userId: true } },
      prescriptions: {
        select: {
          id: true,
          productId: true,
          repeatsAuthorised: true,
          repeatsAuthorisedLimit: true,
        },
      },
    },
  });
  if (!encounter) throw new NotFoundError('Prescription');

  if (encounter.patientId !== patientId) {
    throw new ValidationError(
      'That consultation belongs to a different patient. An order fills one person’s prescription, to one person’s address.'
    );
  }
  if (encounter.status !== 'FINALIZED') {
    throw new ValidationError(
      encounter.status === 'DRAFT'
        ? 'This consultation has not been signed, so there is no prescription to send out.'
        : 'This consultation has been superseded or cancelled. Ask the prescriber for a current prescription.'
    );
  }

  return {
    dateOfBirth: patient.dateOfBirth,
    subjectType: patient.subjectType,
    species: patient.animalProfile?.species ?? null,
    encounter: {
      id: encounter.id,
      finalizedAt: encounter.finalizedAt,
      startedAt: encounter.startedAt,
      prescriberUserId: encounter.doctorProfile?.userId ?? null,
      prescriptions: encounter.prescriptions,
    },
  };
}

/**
 * The lines, converted and checked against the prescription they cite.
 *
 * ⚠️ THE CONVERSION GOES THROUGH THE ONE `toBaseUnits` THE LEDGER USES, at the
 *   moment the line is written and again at nothing — the base quantity is what
 *   the hold and the parcel are both measured in, so re-converting later would
 *   be a second answer to the question the reservation was built on.
 */
async function resolveLines(
  tx: TxClient,
  lines: CreateOnlineOrderRequest['lines'],
  prescribed: Map<string, { productId: string }>
): Promise<ResolvedLine[]> {
  const seen = new Set<string>();
  const out: ResolvedLine[] = [];

  for (const line of lines) {
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
        `${product.name} is not stocked, so there is nothing of it to send out.`
      );
    }
    if (product.status !== 'ACTIVE') {
      throw new ValidationError(
        `${product.name} is no longer active in the catalogue. Choose the product the clinic is currently using.`
      );
    }

    /*
     * ⚠️ ONE LINE PER PRODUCT, AND THE REASON IS THE HOLD RATHER THAN TIDINESS.
     *   Each line's reservations cite THAT LINE's id, which is what lets packing
     *   put the right lots against the right line; two lines naming one product
     *   would be indistinguishable to a report reading reservations by product,
     *   and merging them would silently change what the patient asked for. A
     *   prescription that genuinely lists the same medicine twice is two orders,
     *   or one line for the total.
     */
    if (seen.has(product.id)) {
      throw new ValidationError(
        `${product.name} is on this order twice. Put the whole quantity on one line — the stock is held per line, and two holds for one medicine is two answers to how much is coming.`
      );
    }
    seen.add(product.id);

    if (line.encounterPrescriptionId != null) {
      const prescription = prescribed.get(line.encounterPrescriptionId);
      if (!prescription) {
        throw new ValidationError(
          'One of these lines cites a prescribed medicine that is not on this prescription.'
        );
      }
      /*
       * ⚠️ NO SUBSTITUTION ON THIS SURFACE (see the contract header). A line that
       *   cites a prescribed medicine has to BE that medicine — the counter can
       *   record a substitution because the patient is standing there to be told
       *   about it, and an order that is confirmed today and packed on Thursday
       *   cannot.
       */
      if (prescription.productId !== product.id) {
        throw new ValidationError(
          `${product.name} is not what was prescribed on the line it cites. An online order cannot substitute — cancel it and place a new one for what the patient has agreed to.`
        );
      }
    }

    const quantityBase = await toBaseUnits(
      tx,
      movementDeps,
      { id: product.id, baseUnitId: product.baseUnitId, baseUnitCode: product.baseUnit.code },
      { quantity: line.quantity, unitId: line.unitId }
    );

    out.push({
      encounterPrescriptionId: line.encounterPrescriptionId ?? null,
      productId: product.id,
      quantityEntered: line.quantity,
      unitId: line.unitId,
      quantityBase,
    });
  }

  return out;
}

/**
 * If the order says which stored address it was copied from, is that this
 * person's address?
 *
 * ⚠️ THE COLUMN IS ADVISORY AND IT IS STILL CHECKED (PI-12, security review).
 *   `patient_address_id` carries no foreign key on purpose — the delivery is the
 *   seven snapshotted columns, and a correction to `patient_addresses` must not
 *   rewrite where a parcel WAS sent. But "advisory" is not "unvalidated": the id
 *   comes back on the detail response, and an id pointing at somebody else's
 *   address is a claim about that person waiting for the first screen that joins
 *   on it. The composite `(organization_id, patient_id)` filter is what makes
 *   another clinic's address unrepresentable as well as another patient's.
 */
async function assertAddressBelongsToPatient(
  tx: TxClient,
  ctx: TenantContext,
  patientId: string,
  patientAddressId: string | null
): Promise<void> {
  if (patientAddressId === null) return;

  const address = await tx.patientAddress.findFirst({
    where: { id: patientAddressId, organizationId: ctx.organizationId, patientId },
    select: { id: true },
  });
  if (!address) {
    throw new ValidationError(
      'That address is not on this patient\u2019s record. Leave the stored address blank if you are typing a new one.'
    );
  }
}

/*
 * ⚠️ THERE IS DELIBERATELY NO `assertDestinationIsAPlace` HERE, AND ONE WAS
 *   WRITTEN AND REMOVED RATHER THAN NEVER ATTEMPTED (PI-12, after the security
 *   review raised the declared-destination gap).
 *
 *   The idea was to refuse a region that names no row in `jurisdictions`, so a
 *   typo could not silently disable every regional rule. It refused `IN-KA` on
 *   the first run. `jurisdictions` is a table of places rcln has WRITTEN RULES
 *   FOR — India has a country-wide row and no state rows — not a gazetteer of
 *   places that exist, so it cannot tell Karnataka from a typo, and a check
 *   built on it refuses real addresses while proving nothing.
 *
 *   Nor could it be narrowed to "once we know a country's regions": seeding
 *   `IN-KA` because Karnataka has a state pack says nothing about Maharashtra,
 *   so the check would start refusing the next real state instead.
 *
 *   So the region is UNVALIDATED, it is said plainly in the contract header
 *   rather than papered over, and what bounds it is: the declared pair is frozen
 *   on the order beside the address it is supposed to describe, the snapshotted
 *   decision cites it, and both halves are on the audit row. Closing it properly
 *   needs an address the platform can resolve to a place.
 */

/** The address columns, in the shape both writes use. */
function addressColumns(address: CreateOnlineOrderRequest['address']): {
  recipientName: string;
  recipientPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  destinationCountryCode: string;
  destinationRegionCode: string | null;
  patientAddressId: string | null;
} {
  return {
    recipientName: address.recipientName,
    recipientPhone: address.recipientPhone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    pincode: address.pincode ?? null,
    destinationCountryCode: address.destinationCountryCode,
    /*
     * ⚠️ AN EMPTY STRING IS NOT A REGION, AND STORING ONE WOULD MAKE
     *   `formatJurisdiction` RENDER `IN-`. The contract trims but does not
     *   refuse empty, because a form that clears the field sends `''`.
     */
    destinationRegionCode:
      address.destinationRegionCode != null && address.destinationRegionCode !== ''
        ? address.destinationRegionCode.toUpperCase()
        : null,
    patientAddressId: address.patientAddressId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Taking the order
// ---------------------------------------------------------------------------

export async function createOnlineOrder(
  ctx: TenantContext,
  body: CreateOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  const branchId = resolveBranchId(ctx, body.branchId, options.actingBranchId);

  const id = await withTenant(ctx, async (tx) => {
    const location = await resolveDispensingLocation(tx, branchId, body.locationId);
    const subject = await resolveSubject(tx, ctx, body.patientId, body.encounterId ?? null);

    const prescribed = new Map(
      (subject.encounter?.prescriptions ?? []).map((line) => [line.id, line])
    );
    const lines = await resolveLines(tx, body.lines, prescribed);

    const address = addressColumns(body.address);
    await assertAddressBelongsToPatient(tx, ctx, body.patientId, address.patientAddressId);

    const order = await tx.onlineOrder.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        channel: body.channel,
        status: 'DRAFT',
        patientId: body.patientId,
        encounterId: subject.encounter?.id ?? null,
        locationId: location.id,
        ...address,
        notes: body.notes ?? null,
        placedById: ctx.userId,
      },
      select: { id: true },
    });

    /*
     * ⚠️ THE LINES ARE WRITTEN SEPARATELY RATHER THAN NESTED UNDER THE ORDER, AND
     *   PRISMA IS WHY. A nested `create` infers the parent's relation scalars and
     *   REFUSES to be given them — but `online_order_lines` is joined to its
     *   parent by the COMPOSITE key `(organization_id, online_order_id)`, so
     *   `organizationId` is one of the inferred fields and passing it is an
     *   `Unknown argument` at runtime. Writing them flat keeps every tenant
     *   column explicit, which is the rule this codebase follows anyway
     *   (ADR-0005: defence in depth on tenant columns, never left to RLS alone).
     */
    await tx.onlineOrderLine.createMany({
      data: lines.map((line, index) => ({
        organizationId: ctx.organizationId,
        branchId,
        onlineOrderId: order.id,
        lineNumber: index + 1,
        encounterPrescriptionId: line.encounterPrescriptionId,
        productId: line.productId,
        quantityEntered: new Prisma.Decimal(line.quantityEntered),
        unitId: line.unitId,
        quantityBase: new Prisma.Decimal(line.quantityBase),
      })),
    });

    /*
     * ⚠️ IDS AND COUNTS. No address, no medicine name, no patient name — an
     *   audit row is read by people reviewing changes, and "sent methadone to
     *   14 Laburnum Road" in that table is a disclosure rather than a change
     *   record.
     */
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId,
      after: {
        channel: body.channel,
        status: 'DRAFT',
        lineCount: lines.length,
        encounterId: subject.encounter?.id ?? null,
        locationId: location.id,
        /* ⚠️ THE PAIR, NOT JUST THE COUNTRY. The region is the half a wrong
         * declaration hides in, and an audit row carrying only the country could
         * not show it was ever wrong. Still ids and codes — never an address. */
        destinationCountryCode: address.destinationCountryCode,
        destinationRegionCode: address.destinationRegionCode,
      },
      ...auditMeta(options),
    });

    return order.id;
  });

  return getOnlineOrder(ctx, id, options);
}

/**
 * Amend a draft.
 *
 * ⚠️ A DRAFT ONLY, AND THE 409 IS THE POINT. Once the order is CONFIRMED the law
 *   has been asked about these exact lines and the stock is held against them;
 *   editing them would leave a frozen decision describing something else and
 *   holds pointing at quantities nobody asked for.
 */
export async function updateOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: UpdateOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.onlineOrder.findFirst({
      where: { id, organizationId: ctx.organizationId },
      select: { id: true, branchId: true, status: true, patientId: true, encounterId: true },
    });
    if (!existing) throw new NotFoundError('Online order');
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        'This order has already been accepted, so it can no longer be edited. Cancel it and place a new one.'
      );
    }

    const branchId = existing.branchId;
    const locationId = body.locationId ?? undefined;
    const location =
      locationId === undefined ? null : await resolveDispensingLocation(tx, branchId, locationId);

    /*
     * ⚠️ `undefined` LEAVES THE ENCOUNTER ALONE AND `null` DETACHES IT, WHICH IS
     *   WHY `encounterId` IS COMPARED AGAINST `undefined` RATHER THAN COALESCED
     *   WITH `??`. An order whose prescription was cited by mistake has to be
     *   able to stop citing one, and `body.encounterId ?? existing.encounterId`
     *   would make that impossible while looking correct.
     */
    const encounterId =
      body.encounterId === undefined ? existing.encounterId : (body.encounterId ?? null);

    const subject = await resolveSubject(tx, ctx, existing.patientId, encounterId);
    const prescribed = new Map(
      (subject.encounter?.prescriptions ?? []).map((line) => [line.id, line])
    );

    const lines = body.lines === undefined ? null : await resolveLines(tx, body.lines, prescribed);

    const address = body.address ? addressColumns(body.address) : null;
    if (address) {
      await assertAddressBelongsToPatient(tx, ctx, existing.patientId, address.patientAddressId);
    }

    await tx.onlineOrder.update({
      where: { id: existing.id },
      data: {
        ...(location ? { locationId: location.id } : {}),
        encounterId,
        ...(address ?? {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      },
    });

    /*
     * ⚠️ REPLACED WHOLESALE, NOT MERGED. A draft's lines are what somebody read
     *   back over the telephone; a partial merge would leave a line nobody
     *   mentioned still on the order, and the holds are taken from this list at
     *   confirmation.
     *
     * Written flat rather than nested, for the reason `createOnlineOrder` gives.
     */
    if (lines) {
      await tx.onlineOrderLine.deleteMany({
        where: { organizationId: ctx.organizationId, onlineOrderId: existing.id },
      });
      await tx.onlineOrderLine.createMany({
        data: lines.map((line, index) => ({
          organizationId: ctx.organizationId,
          branchId,
          onlineOrderId: existing.id,
          lineNumber: index + 1,
          encounterPrescriptionId: line.encounterPrescriptionId,
          productId: line.productId,
          quantityEntered: new Prisma.Decimal(line.quantityEntered),
          unitId: line.unitId,
          quantityBase: new Prisma.Decimal(line.quantityBase),
        })),
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: existing.id,
      branchId,
      after: {
        encounterId,
        ...(location ? { locationId: location.id } : {}),
        ...(lines ? { lineCount: lines.length } : {}),
      },
      ...auditMeta(options),
    });
  });

  return getOnlineOrder(ctx, id, options);
}

// ---------------------------------------------------------------------------
// Accepting it: the law, then the hold
// ---------------------------------------------------------------------------

/**
 * Has the clinic cleared this product for remote supply, here?
 *
 * ⚠️ THIS IS THE GATE, AND IT THROWS RATHER THAN REPORTING. See the file header
 *   for why it cannot be left to the engine's own answer. The message comes from
 *   `@rcln/regulatory` so the refusal reads identically wherever it surfaces.
 *
 * ⚠️ `place` IS THE FULFILLING BRANCH'S JURISDICTION, NOT THE DESTINATION'S, AND
 *   THAT IS DELIBERATE RATHER THAN AN OVERSIGHT (PI-12, security review asked).
 *   It is the same place `evaluateWithin` loads the profile for, and the two
 *   MUST agree — a gate that refused on the destination's profile while the
 *   engine reasoned about the branch's would be two answers to one question,
 *   and the "configured, visible and inert" failure this programme keeps finding
 *   is exactly what a disagreement like that produces.
 *
 *   The reasoning behind it: a regulatory PROFILE is what a product IS somewhere
 *   — its classification, its schedule, its position on remote supply — and the
 *   clinic asserting it can only speak for the place it operates in. Where the
 *   parcel ARRIVES is a question for RULES, and the rules get it: `destination`
 *   is passed to `consultForSupply` and `ONLINE_DISPENSING` reads it.
 *
 *   ⚠️ THE COST, STATED: a product a clinic recorded as PROHIBITED for remote
 *     supply in the destination state but PERMITTED in its own passes this gate.
 *     Closing that needs a rule in the destination's pack, which is the layer
 *     that is allowed to speak for somewhere the clinic does not operate.
 */
async function assertRemoteSupplyIsOpen(
  tx: TxClient,
  productId: string,
  productName: string,
  place: { countryCode: string; regionCode: string | null },
  on: Date
): Promise<void> {
  const profile = await loadProfile(tx, productId, place, startOfCalendarDay(on));
  const gap = onlineSaleGap('ONLINE_DISPENSE', profile);
  if (gap === null) return;

  throw new ValidationError(
    `${productName}: ${onlineSaleGapMessage(gap, formatJurisdiction(place))}`
  );
}

/**
 * Accept it.
 *
 * One transaction, and per line in this order:
 *
 *   1. re-assert the world     product, prescription, shelf
 *   2. THE CLINIC'S GATE       has anybody cleared this for remote supply here
 *   3. ASK THE LAW             transaction `ONLINE_DISPENSE`, with the
 *                              DESTINATION, and snapshot the answer
 *   4. plan FEFO               which lots would go, refusing on a shortfall
 *   5. HOLD them               one `RESERVATION` leg per lot, AVAILABLE ->
 *                              RESERVED, cited to the ORDER LINE
 *
 * then the number, then the status. The number last, so a refusal burns none.
 *
 * ⚠️ STEP 3 BEFORE STEP 5, FOR THE REASON `createDispense` PUTS IT BEFORE THE
 *   LEDGER. A refused line must not already have taken stock out of AVAILABLE,
 *   and relying on the rollback rather than on the order of the calls is exactly
 *   the assumption that breaks when somebody splits this loop.
 *
 * @throws RegulatoryRefusalError 422 when the rules refuse a line AND the pack
 *         is one a human has signed off (`enforcement.ts`).
 */
export async function confirmOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: ConfirmOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  await withTenant(ctx, async (tx) => {
    const order = await tx.onlineOrder.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!order) throw new NotFoundError('Online order');
    if (order.status !== 'DRAFT') {
      throw new ConflictError(
        order.status === 'CANCELLED'
          ? 'This order was stood down. Place a new one.'
          : 'This order has already been accepted.'
      );
    }
    if (order.lines.length === 0) {
      throw new ValidationError('There is nothing on this order to accept.');
    }

    const now = new Date();
    const location = await resolveDispensingLocation(tx, order.branchId, order.locationId);
    const subject = await resolveSubject(tx, ctx, order.patientId, order.encounterId);
    const place = await branchJurisdictionWithin(tx, ctx.organizationId, order.branchId);

    const destination = {
      countryCode: order.destinationCountryCode,
      regionCode: order.destinationRegionCode,
    };

    const expiresAt = new Date(now.getTime() + body.holdForDays * 86_400_000);

    /*
     * ⚠️ SORTED INTO A CANONICAL ORDER BEFORE ANY BUCKET IS TOUCHED. Every
     *   reservation leg takes an advisory bucket lock held to COMMIT, so two
     *   confirmations touching overlapping lots in opposite orders deadlock —
     *   the same note `createDispense` and goods receipt both carry.
     *
     * ⚠️ THE SORT PREVENTS DEADLOCK AND NOTHING ELSE — IT IS NOT WHAT STOPS AN
     *   OVERSELL (PI-12 review, which found this comment claiming more than it
     *   does). The plan below is an optimistic read; what makes acting on a
     *   stale one safe is that `reserveStockIn` writes the MOVEMENT first, and
     *   the movement takes the bucket lock and refuses a hold the shelf cannot
     *   cover with a 409. Losing that race is an ordinary outcome.
     */
    const ordered = [...order.lines].sort((a, b) => a.productId.localeCompare(b.productId));

    for (const line of ordered) {
      const product = await tx.product.findFirst({
        where: { id: line.productId, deletedAt: null },
        select: { id: true, name: true, status: true, isStockItem: true },
      });
      if (!product) throw new NotFoundError('Product');
      if (!product.isStockItem || product.status !== 'ACTIVE') {
        throw new ValidationError(
          `${product.name} is no longer something this clinic supplies. Take it off the order before accepting it.`
        );
      }

      await assertRemoteSupplyIsOpen(tx, product.id, product.name, place, now);

      const prescriptionLine =
        line.encounterPrescriptionId === null
          ? undefined
          : subject.encounter?.prescriptions.find(
              (prescribed) => prescribed.id === line.encounterPrescriptionId
            );
      if (line.encounterPrescriptionId !== null && prescriptionLine === undefined) {
        throw new ValidationError(
          'One of these lines cites a prescribed medicine that is no longer on this prescription.'
        );
      }

      const prescriptionFacts = await presentedPrescriptionFor(
        tx,
        ctx,
        subject.encounter,
        prescriptionLine
      );

      const ageYears = ageYearsOn(subject.dateOfBirth, now);

      const consultation = await consultForSupply(tx, ctx, {
        branchId: order.branchId,
        productId: product.id,
        locationId: location.id,
        quantityBase: q(line.quantityBase),
        transaction: 'ONLINE_DISPENSE',
        destination,
        occurredAt: now,
        documentId: order.id,
        patientId: order.patientId,
        ...(prescriptionFacts ? { prescription: prescriptionFacts } : {}),
        patient: {
          subjectType: subject.subjectType,
          /* Hoisted, so the value is computed once and no assertion is needed to
           * bridge the guard and the use — `dispense.service.ts` still has the
           * two-call shape and should follow. */
          ...(ageYears !== undefined ? { ageYears } : {}),
          /* Read off the animal's profile, never sent by a client (PI-11). */
          ...(subject.species != null && subject.species !== ''
            ? { species: subject.species }
            : {}),
        },
        actor: {
          roleCodes: options.roleCodes ?? [],
          ...(subject.encounter
            ? { isPrescriber: subject.encounter.prescriberUserId === ctx.userId }
            : {}),
        },
      });

      await tx.onlineOrderLine.update({
        where: { id: line.id },
        data: { regulatoryDecisionId: consultation.decisionId },
      });

      /*
       * ⚠️ THE PLAN IS NOT NARROWED TO THE PACKING COUNTER, WHICH IS WHY NO
       *   `locationId` IS PASSED. A dispensary makes parcels up out of the
       *   fridge and the controlled cabinet as well as the shelf behind it; the
       *   COUNTER is where the parcel is made up, and the LOT is where each unit
       *   came from.
       */
      const plan = await planStockAllocationWithin(tx, ctx, {
        branchId: order.branchId,
        productId: product.id,
        quantity: q(line.quantityBase),
      });

      if (new Prisma.Decimal(plan.shortfallQuantityBase).gt(0)) {
        throw new ValidationError(
          `There is not enough ${product.name} on the shelf to accept this order: ` +
            `${plan.allocatedQuantityBase} of ${plan.requestedQuantityBase} available. Expired, ` +
            'quarantined, recalled and already-reserved stock is deliberately not counted.'
        );
      }

      for (const allocated of plan.lines) {
        await reserveStockIn(
          tx,
          ctx,
          {
            branchId: order.branchId,
            productId: product.id,
            batchId: allocated.batchId,
            serialId: allocated.serialId,
            locationId: allocated.locationId,
            quantityBase: allocated.quantityBase,
            referenceType: 'ONLINE_ORDER',
            /*
             * ⚠️ THE ORDER **LINE**, NOT THE ORDER, AND THAT CHOICE IS WHAT MAKES
             *   PACKING UNAMBIGUOUS. Reservations carry a product and a lot and
             *   no line, so an order citing the same product twice would leave
             *   packing unable to say which line each hold belonged to. The line
             *   id is the only key that never collides — and `resolveLines`
             *   refuses a duplicate product as a second guard on the same thing.
             */
            referenceId: line.id,
            expiresAt,
            notes: null,
          },
          auditMeta(options)
        );
      }
    }

    /*
     * ⚠️ THE NUMBER IS TAKEN AFTER EVERY LINE HAS BEEN CONSULTED AND HELD, SO A
     *   REFUSAL BURNS NONE — the rule every procurement document follows. Still
     *   inside the transaction, so a later failure rolls it back too.
     */
    const number = await issueNumber(tx, ctx, {
      type: 'ONLINE_ORDER',
      branchId: order.branchId,
      periodKey: '',
      prefix: 'ORD-',
    });

    await tx.onlineOrder.update({
      where: { id: order.id },
      data: {
        status: 'CONFIRMED',
        orderNumber: number.formatted,
        confirmedAt: now,
        confirmedById: ctx.userId,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: 'DRAFT' },
      after: {
        status: 'CONFIRMED',
        orderNumber: number.formatted,
        lineCount: order.lines.length,
        holdExpiresAt: expiresAt.toISOString(),
      },
      ...auditMeta(options),
    });
  });

  /* Accepted, and the stock is held. Tell the patient — after the commit. */
  const confirmed = await getOnlineOrder(ctx, id, options);
  await notifyAboutOrder(ctx, NOTIFICATION_JOB.ONLINE_ORDER_CONFIRMED, confirmed);
  return confirmed;
}

// ---------------------------------------------------------------------------
// Standing it down
// ---------------------------------------------------------------------------

/**
 * Cancel it, and give the stock back.
 *
 * ⚠️ BEFORE PACKING ONLY, AND THE CHECK CONSTRAINT SAYS SO TOO. After packing
 *   the medicine has physically left; undoing that is a `dispense_returns` row
 *   through the existing return path, exactly as it is for a counter supply. A
 *   CANCELLED status reachable after the ledger moved would be a cancellation
 *   the stock ledger has never heard of.
 *
 * ⚠️ AND A HOLD THE SWEEP ALREADY RELEASED IS NOT AN ERROR.
 *   `releaseReservationIn` claims the row before writing the movement and
 *   returns `false` when somebody got there first; a cancellation that threw on
 *   that would be unable to cancel exactly the orders most in need of it.
 */
export async function cancelOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: CancelOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  await withTenant(ctx, async (tx) => {
    const order = await tx.onlineOrder.findFirst({
      where: { id, organizationId: ctx.organizationId },
      select: {
        id: true,
        branchId: true,
        status: true,
        lines: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundError('Online order');
    if (order.status === 'CANCELLED') {
      throw new ConflictError('This order has already been stood down.');
    }
    if (order.status !== 'DRAFT' && order.status !== 'CONFIRMED') {
      throw new ConflictError(
        'This order has already been packed, so the medicine has left the shelf. Record a return against the dispense instead.'
      );
    }

    const lineIds = order.lines.map((line) => line.id);
    const held =
      lineIds.length === 0
        ? []
        : await tx.stockReservation.findMany({
            where: {
              organizationId: ctx.organizationId,
              referenceType: 'ONLINE_ORDER',
              referenceId: { in: lineIds },
              status: 'ACTIVE',
            },
            select: {
              id: true,
              branchId: true,
              productId: true,
              batchId: true,
              serialId: true,
              locationId: true,
              quantityBase: true,
            },
          });

    let released = 0;
    for (const reservation of held) {
      if (await releaseReservationIn(tx, ctx, reservation, auditMeta(options))) released += 1;
    }

    await tx.onlineOrder.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: ctx.userId,
        cancellationReason: body.reason,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: order.status },
      after: { status: 'CANCELLED', reservationsReleased: released },
      ...auditMeta(options),
    });
  });

  return getOnlineOrder(ctx, id, options);
}

/**
 * A patient's recent consultations, for the order form's picker (PI-24).
 *
 * ⚠️ IT IS NOT `visit-history`, AND THE DIFFERENCE IS A PERMISSION. That endpoint
 *   answers the same question and returns DIAGNOSES, gated on
 *   `clinical.encounter.read` — right for a doctor reading a patient's clinical
 *   past, wrong for a pharmacy assistant taking a delivery order over the phone.
 *   Pointing the picker at it would have put a list of diagnoses in a dropdown
 *   on the pharmacy counter. This returns when, who, and how many items were
 *   prescribed, and nothing else. (KNOWN_ISSUES #33.)
 *
 * ⚠️ IT STILL WRITES A `data_access_logs` ROW. "Which consultations has this
 *   person had" is a disclosure about a named patient even without the findings,
 *   and it is read on the same screen that already logs the patient search.
 *
 * ⚠️ FINALIZED BY DEFAULT. An order is dispensed against a prescription a doctor
 *   has signed. An open consultation has not been signed and its prescription
 *   may still change, so it is offered only when the caller asks.
 */
export async function listPatientConsultations(
  ctx: TenantContext,
  patientId: string,
  query: PatientConsultationsQuery,
  options: PharmacyActionOptions = {}
): Promise<PatientConsultationsResponse> {
  return withTenant(ctx, async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundError('Patient');

    const rows = await tx.encounter.findMany({
      where: {
        organizationId: ctx.organizationId,
        patientId,
        deletedAt: null,
        branchId: { in: ctx.branchIds },
        ...(query.includeOpen ? {} : { status: 'FINALIZED' }),
      },
      orderBy: [{ finalizedAt: 'desc' }, { startedAt: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        status: true,
        startedAt: true,
        finalizedAt: true,
        branch: { select: { name: true } },
        doctorProfile: { select: { user: { select: { fullName: true } } } },
        _count: { select: { prescriptions: true } },
      },
    });

    await recordDataAccess(tx, ctx, {
      /* A list of somebody's consultations is a VIEW of their record, not a
       * SEARCH across the register — the term-hashing branch is for the latter. */
      accessType: 'VIEW',
      resource: 'ENCOUNTER',
      patientId,
      resultCount: rows.length,
      ...(options.ipAddress ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    });

    return {
      consultations: rows.map((row) => ({
        id: row.id,
        /* The moment the consultation is filed under — signed if it is signed,
         * otherwise opened. UTC with a `Z`; the screen renders it in the
         * branch's zone. */
        occurredAt: (row.finalizedAt ?? row.startedAt).toISOString(),
        status: row.status,
        doctorName: row.doctorProfile.user.fullName,
        branchName: row.branch.name,
        prescribedItemCount: row._count.prescriptions,
      })),
    };
  });
}
