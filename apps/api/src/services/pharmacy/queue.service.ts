/**
 * The prescription queue, and the one prescription a pharmacist is looking at.
 *
 * ⚠️ EVERY FUNCTION IN THIS FILE READS THE CLINICAL RECORD AND NONE OF THEM
 *   WRITES IT (invariant 7). What pharmacy writes is `prescription_fulfilments`,
 *   its own row beside the consultation, saying how far the DISPENSARY has got.
 *   There is no update path from here to `encounter_prescriptions`, and adding
 *   one — even a "dispensed so far" column — would put the pharmacy inside the
 *   clinical record.
 *
 * ── PHI, AND THE LOGGING THAT GOES WITH IT ──────────────────────────────────
 * ⚠️ EVERY READ HERE IS A DISCLOSURE AND WRITES A `data_access_logs` ROW. One row
 *   per REQUEST, never per result: the queue writes a single row with a count and
 *   no patient id, and the detail writes one naming the patient whose
 *   prescription was opened. That is the same rule the patient and encounter
 *   services follow, and the dedupe window keeps a pharmacist tabbing between
 *   panels of one prescription from writing thirty rows.
 *
 * ⚠️ AND NOTHING IS LOGGED THROUGH `logger`. A queue row is a person's name
 *   beside a consultation; the application log is not a place that goes.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CancelPrescriptionFulfilmentRequest,
  PharmacyPrescriptionDetail,
  PharmacyPrescriptionItem,
  PrescriptionFulfilmentStatus,
  PrescriptionQueueItem,
  PrescriptionQueueQuery,
  PrescriptionQueueResponse,
  VerifyPrescriptionRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import {
  assertBranchInScope,
  ageYearsOn,
  auditMeta,
  dispensedByPrescriptionLine,
  q,
} from './shared.js';

/** The audit/data-access metadata a route hands down. */
export interface PharmacyActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  route?: string | undefined;
  /** The branch the request is acting on, when the body does not name one. */
  actingBranchId?: string | null | undefined;
  /** The caller's effective permission codes for that branch. */
  roleCodes?: readonly string[] | undefined;
}

/**
 * A consultation is dispensable when the doctor has SIGNED it and nothing has
 * superseded it.
 *
 * ⚠️ `AMENDED` IS EXCLUDED AND THAT IS NOT A TECHNICALITY. An amended encounter
 *   has been replaced by a later one that cites it — dispensing against the old
 *   row supplies exactly what the correction was made to stop.
 */
function isDispensableStatus(status: string): boolean {
  return status === 'FINALIZED';
}

/** A patient's name from its two halves. Users carry one `full_name` instead. */
function displayName(patient: { firstName: string; lastName: string | null }): string {
  return patient.lastName ? `${patient.firstName} ${patient.lastName}` : patient.firstName;
}

/**
 * The queue.
 *
 * ⚠️ THE `branchId` FILTER NARROWS BY WHERE THE PRESCRIPTION WAS WRITTEN, AND
 *   OMITTING IT IS THE USEFUL DEFAULT. A group's patient may take a prescription
 *   written at the main site to the satellite's counter, so a queue hard-filtered
 *   to the counter's own branch would hide exactly the prescriptions that walk in
 *   through the door. RLS has already narrowed the rows to the caller's branch
 *   scope, which is the boundary that matters.
 */
export async function listPrescriptionQueue(
  ctx: TenantContext,
  query: PrescriptionQueueQuery,
  options: PharmacyActionOptions = {}
): Promise<PrescriptionQueueResponse> {
  if (query.branchId) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.EncounterWhereInput = {
      organizationId: ctx.organizationId,
      deletedAt: null,
      /*
       * ⚠️ ONLY CONSULTATIONS THAT ACTUALLY PRESCRIBED SOMETHING. `some: {}` is
       *   the whole of "is there a prescription here" — an encounter with advice
       *   and no medicine has nothing for a dispensary to do and would sit in the
       *   queue forever.
       */
      prescriptions: { some: {} },
      status: 'FINALIZED',
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.encounterId ? { id: query.encounterId } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(query.status === 'NEW'
        ? { fulfilment: { is: null } }
        : query.status
          ? { fulfilment: { is: { status: query.status } } }
          : {}),
    };

    const [total, rows] = await Promise.all([
      tx.encounter.count({ where }),
      tx.encounter.findMany({
        where,
        /*
         * Oldest first. A dispensary queue is a waiting room: the person who has
         * been standing there longest is served next, which is the opposite of
         * every other list in this codebase and is why it is spelled out.
         */
        orderBy: [{ startedAt: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          encounterNumber: true,
          branchId: true,
          startedAt: true,
          finalizedAt: true,
          patientId: true,
          branch: { select: { name: true } },
          patient: { select: { firstName: true, lastName: true, uhid: true } },
          doctorProfile: { select: { user: { select: { fullName: true } } } },
          prescriptions: { select: { id: true, quantity: true } },
          fulfilment: { select: { status: true, verifiedAt: true } },
        },
      }),
    ]);

    const dispensed = await dispensedByPrescriptionLine(
      tx,
      ctx.organizationId,
      rows.flatMap((row) => row.prescriptions.map((line) => line.id))
    );

    const items: PrescriptionQueueItem[] = rows.map((row) => {
      const completed = row.prescriptions.filter((line) => {
        const supplied = dispensed.get(line.id) ?? new Prisma.Decimal(0);
        return line.quantity === null ? supplied.gt(0) : supplied.gte(line.quantity);
      }).length;

      const doctor = row.doctorProfile?.user;
      return {
        encounterId: row.id,
        encounterNumber: row.encounterNumber,
        branchId: row.branchId,
        branchName: row.branch.name,
        startedAt: row.startedAt.toISOString(),
        finalizedAt: row.finalizedAt?.toISOString() ?? null,
        patientId: row.patientId,
        patientName: displayName(row.patient),
        patientUhid: row.patient.uhid,
        prescriberName: doctor?.fullName ?? null,
        status: (row.fulfilment?.status ?? 'NEW') as PrescriptionFulfilmentStatus,
        verifiedAt: row.fulfilment?.verifiedAt?.toISOString() ?? null,
        itemCount: row.prescriptions.length,
        completedItemCount: completed,
      };
    });

    /*
     * ⚠️ ONE ROW, WITH A COUNT AND NO PATIENT ID. A queue names many people, and
     *   a row per result would turn this table into a per-poll firehose while
     *   answering no question better than the count does.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PRESCRIPTION',
      resultCount: items.length,
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      items,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

/**
 * One prescription, with what the shelf can do about each line.
 *
 * ⚠️ `availableQuantityBase` IS THE SAME FILTER `planStockAllocation` USES —
 *   AVAILABLE only, quantity above zero, an active location, an ACTIVE lot and
 *   not expired. Showing a number the allocator would then refuse to allocate is
 *   how a screen tells a pharmacist there is stock and the button says there is
 *   not.
 */
export async function getPharmacyPrescription(
  ctx: TenantContext,
  encounterId: string,
  options: PharmacyActionOptions = {}
): Promise<PharmacyPrescriptionDetail> {
  return withTenant(ctx, async (tx) => {
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId, organizationId: ctx.organizationId, deletedAt: null },
      select: {
        id: true,
        encounterNumber: true,
        branchId: true,
        startedAt: true,
        finalizedAt: true,
        status: true,
        patientId: true,
        branch: { select: { name: true } },
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
            dateOfBirth: true,
            subjectType: true,
          },
        },
        doctorProfile: {
          select: {
            userId: true,
            registrationNumber: true,
            user: { select: { fullName: true } },
          },
        },
        fulfilment: {
          select: {
            status: true,
            verifiedAt: true,
            notes: true,
            verifiedBy: { select: { fullName: true } },
          },
        },
        prescriptions: {
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            productId: true,
            strength: true,
            dose: true,
            doseUnit: true,
            route: true,
            frequency: true,
            frequencyUnit: true,
            durationValue: true,
            durationUnit: true,
            foodRelation: true,
            timing: true,
            isPrn: true,
            instructions: true,
            quantity: true,
            product: {
              select: {
                name: true,
                isStockItem: true,
                baseUnitId: true,
                baseUnit: { select: { symbol: true } },
              },
            },
          },
        },
      },
    });
    if (!encounter) throw new NotFoundError('Prescription');

    const dispensed = await dispensedByPrescriptionLine(
      tx,
      ctx.organizationId,
      encounter.prescriptions.map((line) => line.id)
    );

    const available = await availableByProduct(
      tx,
      encounter.branchId,
      encounter.prescriptions.map((line) => line.productId)
    );

    const items: PharmacyPrescriptionItem[] = encounter.prescriptions.map((line) => {
      const supplied = dispensed.get(line.id) ?? new Prisma.Decimal(0);
      const outstanding =
        line.quantity === null
          ? null
          : Prisma.Decimal.max(new Prisma.Decimal(0), line.quantity.sub(supplied));
      return {
        id: line.id,
        productId: line.productId,
        productName: line.product.name,
        isStockItem: line.product.isStockItem,
        baseUnitId: line.product.baseUnitId,
        baseUnitSymbol: line.product.baseUnit.symbol,
        strength: line.strength,
        dose: line.dose === null ? null : q(line.dose),
        doseUnit: line.doseUnit,
        route: line.route,
        frequency: line.frequency,
        frequencyUnit: line.frequencyUnit,
        durationValue: line.durationValue,
        durationUnit: line.durationUnit,
        foodRelation: line.foodRelation,
        timing: line.timing,
        isPrn: line.isPrn,
        instructions: line.instructions,
        quantityBase: line.quantity === null ? null : q(line.quantity),
        dispensedQuantityBase: q(supplied),
        outstandingQuantityBase: outstanding === null ? null : q(outstanding),
        availableQuantityBase: q(available.get(line.productId) ?? new Prisma.Decimal(0)),
      };
    });

    const verifier = encounter.fulfilment?.verifiedBy;
    const prescriber = encounter.doctorProfile?.user;

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PRESCRIPTION',
      patientId: encounter.patientId,
      resourceId: encounter.id,
      branchId: encounter.branchId,
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return {
      encounterId: encounter.id,
      encounterNumber: encounter.encounterNumber,
      branchId: encounter.branchId,
      branchName: encounter.branch.name,
      startedAt: encounter.startedAt.toISOString(),
      finalizedAt: encounter.finalizedAt?.toISOString() ?? null,
      encounterStatus: encounter.status,
      isDispensable: isDispensableStatus(encounter.status),
      patientId: encounter.patientId,
      patientName: displayName(encounter.patient),
      patientUhid: encounter.patient.uhid,
      patientAgeYears: ageYearsOn(encounter.patient.dateOfBirth, new Date()) ?? null,
      patientSubjectType: encounter.patient.subjectType,
      prescriberName: prescriber?.fullName ?? null,
      prescriberRegistrationNumber: encounter.doctorProfile?.registrationNumber ?? null,
      /*
       * ⚠️ SERVER-DERIVED, AND IT FEEDS A REGULATORY EXEMPTION. Some jurisdictions
       *   exclude a practitioner dispensing to their own patients from the
       *   registered-pharmacist requirement (India's Pharmacy Act s. 42(1) says so
       *   in the section itself). The dispense service passes the same comparison
       *   to the engine; a client that could assert it would be self-certifying
       *   into an exemption.
       */
      callerIsPrescriber: encounter.doctorProfile?.userId === ctx.userId,
      status: (encounter.fulfilment?.status ?? 'NEW') as PrescriptionFulfilmentStatus,
      verifiedAt: encounter.fulfilment?.verifiedAt?.toISOString() ?? null,
      verifiedByName: verifier?.fullName ?? null,
      fulfilmentNotes: encounter.fulfilment?.notes ?? null,
      items,
    };
  });
}

/**
 * What is on the shelf, per product, at one branch.
 *
 * ⚠️ THE SAME CANDIDACY FILTER AS `planStockAllocation`, RESTATED HERE RATHER
 *   THAN SHARED, AND THAT IS A DELIBERATE DUPLICATION WITH A COST. Sharing would
 *   mean loading a plan per line to render a list, which is one query per row.
 *   The risk is the two drifting; the mitigation is that the allocator is the
 *   authority and this is a display, so a disagreement shows up as "the number
 *   said 30 and it allocated 18" rather than as a wrong supply.
 */
async function availableByProduct(
  tx: TxClient,
  branchId: string,
  productIds: readonly string[]
): Promise<Map<string, Prisma.Decimal>> {
  if (productIds.length === 0) return new Map();

  const today = new Date(new Date().toISOString().slice(0, 10));
  const rows = await tx.stockBalance.groupBy({
    by: ['productId'],
    where: {
      branchId,
      productId: { in: [...productIds] },
      status: 'AVAILABLE',
      quantity: { gt: 0 },
      location: { isActive: true, deletedAt: null },
      OR: [
        { batchId: null },
        { batch: { status: 'ACTIVE', OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] } },
      ],
    },
    _sum: { quantity: true },
  });

  return new Map(rows.map((row) => [row.productId, row._sum.quantity ?? new Prisma.Decimal(0)]));
}

/**
 * "I have read this and it is sound."
 *
 * ⚠️ IT VERIFIES THE PRESCRIPTION AND SUPPLIES NOTHING. Nothing moves, no ledger
 *   row is written and no number is burned — which is why a verification may be
 *   recorded before the patient has even arrived at the counter.
 */
export async function verifyPrescription(
  ctx: TenantContext,
  encounterId: string,
  body: VerifyPrescriptionRequest,
  options: PharmacyActionOptions = {}
): Promise<PharmacyPrescriptionDetail> {
  await withTenant(ctx, async (tx) => {
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId, organizationId: ctx.organizationId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        status: true,
        _count: { select: { prescriptions: true } },
      },
    });
    if (!encounter) throw new NotFoundError('Prescription');

    if (!isDispensableStatus(encounter.status)) {
      throw new ValidationError(
        encounter.status === 'DRAFT'
          ? 'This consultation has not been signed yet, so there is no prescription to verify.'
          : 'This consultation has been superseded or cancelled. Ask the prescriber for a current prescription.'
      );
    }
    if (encounter._count.prescriptions === 0) {
      throw new ValidationError('This consultation prescribed no medicines.');
    }

    /*
     * ⚠️ THE BRANCH THAT IS DISPENSING, WHICH IS THE ONE THE PHARMACIST IS
     *   STANDING IN — not the one that wrote the prescription. A satellite
     *   verifying a prescription from the main site is the ordinary reason a
     *   group has a queue at all.
     */
    const branchId = body.branchId ?? options.actingBranchId ?? encounter.branchId;
    assertBranchInScope(ctx, branchId);

    const existing = await tx.prescriptionFulfilment.findUnique({
      where: { organizationId_encounterId: { organizationId: ctx.organizationId, encounterId } },
      select: { id: true, status: true },
    });

    if (existing && existing.status !== 'CANCELLED' && existing.status !== 'VERIFIED') {
      throw new ConflictError(
        'Something has already been supplied against this prescription, so it cannot be verified again.'
      );
    }

    const data = {
      status: 'VERIFIED' as const,
      branchId,
      verifiedById: ctx.userId,
      verifiedAt: new Date(),
      notes: body.notes ?? null,
      cancelledById: null,
      cancelledAt: null,
    };

    if (existing) {
      await tx.prescriptionFulfilment.update({ where: { id: existing.id }, data });
    } else {
      await tx.prescriptionFulfilment.create({
        data: { organizationId: ctx.organizationId, encounterId, ...data },
      });
    }

    /*
     * ⚠️ THE AUDIT ROW CARRIES NO MEDICINE AND NO NAME. `audit_logs` is read by
     *   people reviewing what changed, and "verified Mrs Rao's methadone" is a
     *   disclosure dressed as a change record. The entity id points at the
     *   consultation for anybody with the permission to open it.
     */
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'prescription_fulfilment',
      entityId: encounterId,
      branchId,
      before: { status: existing?.status ?? 'NEW' },
      after: { status: 'VERIFIED' },
      ...auditMeta(options),
    });
  });

  return getPharmacyPrescription(ctx, encounterId, options);
}

/**
 * "We are not going to supply this."
 *
 * ⚠️ THIS CANCELS THE DISPENSARY'S INTENTION, NOT THE PRESCRIPTION. Withdrawing a
 *   prescription is the prescriber's act and lives in the clinical record;
 *   pharmacy has no path to it and must not grow one.
 */
export async function cancelPrescriptionFulfilment(
  ctx: TenantContext,
  encounterId: string,
  body: CancelPrescriptionFulfilmentRequest,
  options: PharmacyActionOptions = {}
): Promise<PharmacyPrescriptionDetail> {
  await withTenant(ctx, async (tx) => {
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!encounter) throw new NotFoundError('Prescription');

    const branchId = body.branchId ?? options.actingBranchId ?? encounter.branchId;
    assertBranchInScope(ctx, branchId);

    const existing = await tx.prescriptionFulfilment.findUnique({
      where: { organizationId_encounterId: { organizationId: ctx.organizationId, encounterId } },
      select: { id: true, status: true },
    });

    if (existing?.status === 'PARTIALLY_DISPENSED' || existing?.status === 'COMPLETED') {
      throw new ConflictError(
        'Something has already been supplied against this prescription. Record a return instead — a supply that happened cannot be un-intended.'
      );
    }

    const data = {
      status: 'CANCELLED' as const,
      branchId,
      cancelledById: ctx.userId,
      cancelledAt: new Date(),
      notes: body.reason,
    };

    if (existing) {
      await tx.prescriptionFulfilment.update({ where: { id: existing.id }, data });
    } else {
      await tx.prescriptionFulfilment.create({
        data: { organizationId: ctx.organizationId, encounterId, ...data },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'prescription_fulfilment',
      entityId: encounterId,
      branchId,
      before: { status: existing?.status ?? 'NEW' },
      after: { status: 'CANCELLED' },
      ...auditMeta(options),
    });
  });

  return getPharmacyPrescription(ctx, encounterId, options);
}
