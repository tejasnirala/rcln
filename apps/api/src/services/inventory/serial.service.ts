/**
 * Serials: one physically identifiable unit. An implant, a device, an
 * instrument set.
 *
 * ⚠️ THIS IS THE ONE FILE IN THE INVENTORY DOMAIN THAT TOUCHES PHI.
 *   `serials.assigned_patient_id` answers "which patient has device 7742" and,
 *   read the other way, "which devices does this patient have". Both are
 *   disclosures about an identifiable individual, both are answerable by primary
 *   key, and neither looks clinical from the column names — which is exactly why
 *   it gets said here in capitals.
 *
 *   So, per PI-ADR-016: every read that returns the column writes a
 *   `data_access_logs` row through `recordDataAccess`, with the new
 *   `INVENTORY_SERIAL` resource. IDS, ENUMS AND COUNTS ONLY in that table —
 *   never a product name beside a patient id, because "Ms Iyer, insulin pump" is
 *   a diagnosis written into the very table built to be safe to keep for ever.
 *
 * ⚠️ AND THE LIST IS LOGGED AS WELL AS THE DETAIL, WHENEVER THE PAGE ACTUALLY
 *   CONTAINS AN ASSIGNMENT. A branch-wide list returns the patient id of every
 *   device fitted there; the disclosure is the same whether it was asked for
 *   narrowly or fell out of a broad read, and logging only the detail read is
 *   how a search-shaped leak stays invisible to a disclosure review.
 *
 *   (`serialQuery` has no `patientId` filter. "Which devices does this patient
 *   have" is a question for the patient's own chart, behind the patient
 *   permissions — not for a stock screen behind `inventory.stock.read`.)
 *
 * A serial may exist without a batch: a device tracked `SERIAL` with no lot is
 * ordinary. `LOT_AND_SERIAL` needs both, and the ledger's tracking CHECK is what
 * enforces that at the point it matters.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AssignSerialRequest,
  CreateSerialRequest,
  SerialDetail,
  SerialListResponse,
  SerialQuery,
  SerialSummary,
  UpdateSerialRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { toCalendarDate, toDateColumn } from '../product/values.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { assertBranchInScope } from '../shared/branch.js';

const serialInclude = Prisma.validator<Prisma.SerialInclude>()({
  product: { select: { name: true } },
  batch: { select: { lotNumber: true } },
  currentLocation: { select: { name: true } },
});

type SerialRow = Prisma.SerialGetPayload<{ include: typeof serialInclude }>;

function toSummary(row: SerialRow): SerialSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    productId: row.productId,
    productName: row.product.name,
    serialNumber: row.serialNumber,
    status: row.status,
    batchId: row.batchId,
    lotNumber: row.batch?.lotNumber ?? null,
    currentLocationId: row.currentLocationId,
    currentLocationName: row.currentLocation?.name ?? null,
    expiresOn: row.expiresOn === null ? null : toCalendarDate(row.expiresOn),
    assignedPatientId: row.assignedPatientId,
    assignedAt: row.assignedAt?.toISOString() ?? null,
  };
}

async function findSerialOrThrow(tx: TxClient, id: string): Promise<SerialRow> {
  const row = await tx.serial.findUnique({ where: { id }, include: serialInclude });
  if (!row) throw new NotFoundError('Serial');
  return row;
}

/**
 * A lot and a shelf that genuinely belong to this serial's product and branch.
 *
 * ⚠️ SHARED BY CREATE **AND** UPDATE, AND THE UPDATE PATH ORIGINALLY HAD NONE OF
 *   IT. The composite FK is `(organization_id, batch_id)`, so it proves the lot
 *   is this TENANT'S and says nothing about whose PRODUCT it is or which BRANCH
 *   holds it — which made `PATCH /serials/:id { batchId }` a legal write onto
 *   another product's lot. Nothing corrupted: `recordMovementIn` re-reads and
 *   refuses the mismatch, so the serial simply became unmovable. A validation
 *   asymmetry between create and update is still the shape that produces the
 *   next real bug.
 */
async function assertSerialReferences(
  tx: TxClient,
  product: { id: string; name: string },
  branchId: string,
  refs: { batchId?: string | null | undefined; locationId?: string | null | undefined }
): Promise<void> {
  if (refs.batchId != null) {
    const batch = await tx.batch.findUnique({
      where: { id: refs.batchId },
      select: { productId: true, branchId: true, lotNumber: true },
    });
    if (!batch) throw new NotFoundError('Batch');
    if (batch.productId !== product.id) {
      throw new ValidationError(`Lot ${batch.lotNumber} is not a lot of ${product.name}.`);
    }
    if (batch.branchId !== branchId) {
      throw new ValidationError(`Lot ${batch.lotNumber} is held at a different branch.`);
    }
  }

  if (refs.locationId != null) {
    const location = await tx.inventoryLocation.findUnique({
      where: { id: refs.locationId },
      select: { branchId: true, name: true, deletedAt: true },
    });
    if (!location || location.deletedAt) throw new NotFoundError('Inventory location');
    if (location.branchId !== branchId) {
      throw new ValidationError(`${location.name} is at a different branch.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reads — every one of which is a potential PHI read
// ---------------------------------------------------------------------------

export async function listSerials(
  ctx: TenantContext,
  query: SerialQuery,
  options: CatalogueActionOptions = {}
): Promise<SerialListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.SerialWhereInput = {
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.q !== undefined
        ? { serialNumber: { contains: query.q, mode: 'insensitive' } }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.serial.count({ where }),
      tx.serial.findMany({
        where,
        include: serialInclude,
        orderBy: [{ createdAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    /*
     * ⚠️ LOGGED WHENEVER THE PAGE ACTUALLY CONTAINS AN ASSIGNMENT, not only when
     *   the caller filtered by patient. A list of every serial at a branch
     *   returns the patient ids of every device fitted there — the disclosure is
     *   the same whether it was asked for narrowly or fell out of a broad read.
     *
     *   A count and a resource, no ids of the patients themselves beyond the one
     *   the query named. `SEARCH` rather than `VIEW`, so it is deliberately NOT
     *   deduplicated: repeatedly listing the same devices is itself the signal.
     */
    const disclosed = rows.filter((r) => r.assignedPatientId !== null).length;
    if (disclosed > 0) {
      await recordDataAccess(tx, ctx, {
        accessType: 'SEARCH',
        resource: 'INVENTORY_SERIAL',
        resultCount: disclosed,
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
        ...options,
      });
    }

    return {
      serials: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getSerial(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<SerialDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await findSerialOrThrow(tx, id);

    if (row.assignedPatientId !== null) {
      await recordDataAccess(tx, ctx, {
        accessType: 'VIEW',
        resource: 'INVENTORY_SERIAL',
        resourceId: row.id,
        patientId: row.assignedPatientId,
        branchId: row.branchId,
        ...options,
      });
    }

    return { ...toSummary(row), notes: row.notes };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createSerial(
  ctx: TenantContext,
  input: CreateSerialRequest,
  options: CatalogueActionOptions = {}
): Promise<SerialDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, name: true, trackingMode: true, isStockItem: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(`${product.name} is not stocked, so it has no serials.`);
    }
    if (product.trackingMode === 'NONE' || product.trackingMode === 'LOT_BATCH') {
      throw new ValidationError(
        `${product.name} is not serial-tracked, so a serial recorded for it could never be moved. Change its tracking mode first if it should be.`
      );
    }

    await assertSerialReferences(tx, product, input.branchId, {
      batchId: input.batchId,
      locationId: input.currentLocationId,
    });

    /*
     * ⚠️ UNIQUE PER (TENANT, PRODUCT), NOT GLOBALLY. Serial numbers are the
     *   manufacturer's, and two manufacturers reuse each other's freely — a
     *   global unique would refuse a legitimate second device on the day a
     *   clinic bought from a new supplier.
     */
    const clash = await tx.serial.findFirst({
      where: { productId: input.productId, serialNumber: input.serialNumber },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        `Serial ${input.serialNumber} is already recorded for ${product.name}.`
      );
    }

    const created = await tx.serial.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        batchId: input.batchId ?? null,
        serialNumber: input.serialNumber,
        currentLocationId: input.currentLocationId ?? null,
        expiresOn: toDateColumn(input.expiresOn),
        notes: input.notes ?? null,
      },
      include: serialInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'serial',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        productId: created.productId,
        serialNumber: created.serialNumber,
        batchId: created.batchId,
      },
      ...options,
    });

    return { ...toSummary(created), notes: created.notes };
  });
}

export async function updateSerial(
  ctx: TenantContext,
  id: string,
  input: UpdateSerialRequest,
  options: CatalogueActionOptions = {}
): Promise<SerialDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findSerialOrThrow(tx, id);

    // The same checks `createSerial` makes. See `assertSerialReferences`.
    await assertSerialReferences(
      tx,
      { id: existing.productId, name: existing.product.name },
      existing.branchId,
      { batchId: input.batchId, locationId: input.currentLocationId }
    );

    const updated = await tx.serial.update({
      where: { id },
      data: {
        ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
        ...(input.currentLocationId !== undefined
          ? { currentLocationId: input.currentLocationId }
          : {}),
        ...(input.expiresOn !== undefined ? { expiresOn: toDateColumn(input.expiresOn) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: serialInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'serial',
      entityId: id,
      branchId: existing.branchId,
      before: { batchId: existing.batchId, currentLocationId: existing.currentLocationId },
      after: { batchId: updated.batchId, currentLocationId: updated.currentLocationId },
      ...options,
    });

    /*
     * ⚠️ THE RESPONSE CARRIES `assignedPatientId`, SO THIS READ IS A DISCLOSURE
     *   TOO. `PATCH /serials/:id { notes }` on an issued device answers "device
     *   7742 is in patient P" just as surely as `GET` does — and it originally
     *   wrote no `data_access_logs` row, which made the file header's "every read
     *   that returns it goes through recordDataAccess" false for one of its three
     *   paths. Logged as a VIEW, because what the caller learns is a read.
     */
    if (updated.assignedPatientId !== null) {
      await recordDataAccess(tx, ctx, {
        accessType: 'VIEW',
        resource: 'INVENTORY_SERIAL',
        resourceId: updated.id,
        patientId: updated.assignedPatientId,
        branchId: updated.branchId,
        ...options,
      });
    }

    return { ...toSummary(updated), notes: updated.notes };
  });
}

/**
 * Assign a serial to a patient. A PHI WRITE, and its own operation.
 *
 * ⚠️ SEPARATE FROM `updateSerial` DELIBERATELY. Folding it into the general
 *   patch would run every note correction through the same audit and access path
 *   as "this implant went into this named person", which makes the narrow thing
 *   indistinguishable from the routine one in every review of the trail. Same
 *   reasoning that gives `clinical.vitals.record` its own permission code.
 *
 * ⚠️ THE COMPOSITE FK IS WHAT STOPS A CROSS-TENANT ASSIGNMENT, and the explicit
 *   lookup below is what turns that into a sentence. `(organization_id,
 *   assigned_patient_id) -> patients(organization_id, id)` cannot name another
 *   clinic's patient at all; the read exists so a patient id from another BRANCH
 *   — which RLS does permit, because `patients` is org-scoped and follows the
 *   person across the group — is at least confirmed to exist.
 */
export async function assignSerial(
  ctx: TenantContext,
  id: string,
  input: AssignSerialRequest,
  options: CatalogueActionOptions = {}
): Promise<SerialDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findSerialOrThrow(tx, id);

    if (existing.assignedPatientId !== null) {
      throw new ConflictError(
        `Serial ${existing.serialNumber} is already assigned. Record its return before assigning it again.`
      );
    }
    if (existing.status !== 'IN_STOCK' && existing.status !== 'RETURNED') {
      throw new ConflictError(
        `Serial ${existing.serialNumber} is ${existing.status.toLowerCase().replace('_', ' ')} and cannot be issued.`
      );
    }

    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: { id: true, deletedAt: true },
    });
    if (!patient || patient.deletedAt) throw new NotFoundError('Patient');

    const updated = await tx.serial.update({
      where: { id },
      data: {
        assignedPatientId: patient.id,
        // Both columns move together — `serials_assignment_dated` insists on it.
        assignedAt: input.assignedAt === undefined ? new Date() : new Date(input.assignedAt),
        status: 'ISSUED',
      },
      include: serialInclude,
    });

    /*
     * ⚠️ `recordAudit` AND NOT `recordDataAccess`, AND THE DISTINCTION IS THE
     *   ONE `DataAccessType` MAKES: that enum is VIEW/SEARCH/PRINT/EXPORT/SHARE,
     *   all of them READS, because `data_access_logs` answers "who looked at
     *   whose record". Assigning is a WRITE, and the caller supplied the patient
     *   id — nothing was disclosed TO them that they did not already have. The
     *   mutation trail is where this belongs, and `getSerial` is where the
     *   disclosure is logged.
     *
     * ⚠️ IDS ONLY, AND NO PRODUCT NAME. "Ms Iyer, insulin pump" is a diagnosis;
     *   the product appears as an id and the patient appears as an id.
     */
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'serial',
      entityId: id,
      branchId: existing.branchId,
      before: { status: existing.status, assignedPatientId: null },
      after: { status: updated.status, assignedPatientId: patient.id },
      ...options,
    });

    return { ...toSummary(updated), notes: updated.notes };
  });
}
