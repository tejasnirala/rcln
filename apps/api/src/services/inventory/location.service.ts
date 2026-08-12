/**
 * Inventory locations, and the areas and bins inside them (PI-ADR-012).
 *
 *     branch -> inventory_location -> storage_area -> storage_bin
 *
 * ⚠️ A BRANCH HAS MANY LOCATIONS, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 *   A clinic has a main pharmacy, a vaccine fridge, a controlled-drug cabinet
 *   and a dressing trolley in each procedure room. Those are four answers to
 *   "where is it", with four storage requirements and four people responsible.
 *   Folding them into "the branch's stock" makes cold chain, controlled-substance
 *   reconciliation and departmental consumption unexpressible at once, and it is
 *   unrecoverable without a migration under live stock.
 *
 * ⚠️ `kind` IS METADATA AND NEVER AUTHORIZATION. A `CONTROLLED_CABINET` is where
 *   a clinic chose to put a cabinet, not a statement that the law requires one
 *   or that anyone is barred from it. `requiresControlledAccess` records the
 *   clinic's own position and PI-5 decides what a jurisdiction actually demands.
 *   The same warning `TaxonomyNodeType` and `ProductType` already carry.
 *
 * NO PHI.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateInventoryLocationRequest,
  InventoryLocationDetail,
  InventoryLocationListResponse,
  InventoryLocationQuery,
  InventoryLocationSummary,
  ReplaceStorageAreasRequest,
  UpdateInventoryLocationRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';

const summaryInclude = Prisma.validator<Prisma.InventoryLocationInclude>()({
  branch: { select: { name: true } },
  storageProfile: { select: { name: true } },
  _count: { select: { areas: true } },
});

const detailInclude = Prisma.validator<Prisma.InventoryLocationInclude>()({
  ...summaryInclude,
  areas: {
    include: { bins: { orderBy: { code: 'asc' } } },
    orderBy: { code: 'asc' },
  },
});

type SummaryRow = Prisma.InventoryLocationGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.InventoryLocationGetPayload<{ include: typeof detailInclude }>;

function toSummary(row: SummaryRow): InventoryLocationSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    kind: row.kind,
    code: row.code,
    name: row.name,
    isDispensingPoint: row.isDispensingPoint,
    requiresControlledAccess: row.requiresControlledAccess,
    storageProfileId: row.storageProfileId,
    storageProfileName: row.storageProfile?.name ?? null,
    isActive: row.isActive,
    areaCount: row._count.areas,
  };
}

function toDetail(row: DetailRow): InventoryLocationDetail {
  return {
    ...toSummary(row),
    areas: row.areas.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      isActive: a.isActive,
      bins: a.bins.map((b) => ({
        id: b.id,
        code: b.code,
        label: b.label,
        isActive: b.isActive,
      })),
    })),
  };
}

/**
 * A branch the caller may actually touch.
 *
 * ⚠️ NOT FOUND, NEVER FORBIDDEN. A branch outside the caller's scope is already
 *   invisible to RLS, so it is indistinguishable from one that does not exist,
 *   and a 403 would confirm the id is real to somebody probing for it. The rule
 *   the whole codebase follows.
 */
function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

async function findLocationOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.inventoryLocation.findUnique({ where: { id }, include: detailInclude });
  if (!row || row.deletedAt) throw new NotFoundError('Inventory location');
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every location the caller can see.
 *
 * ⚠️ THE ONE UNPAGINATED LIST IN THIS PHASE, AND IT IS A DELIBERATE EXCEPTION.
 *   The bar everywhere else is "paginate in SQL", because a catalogue or a
 *   ledger grows without bound. Locations do not: they are the physical places a
 *   clinic keeps things — a pharmacy, a fridge, a cabinet, a room or two — and a
 *   site with more than a few dozen has a naming problem rather than a paging
 *   problem. Every consumer needs the whole set anyway: the screen groups by
 *   branch, and the pickers need to resolve a name for any id they are handed.
 *
 *   ⚠️ IF A CLINIC EVER REACHES A FEW HUNDRED, PAGINATE IT. The response has no
 *     `meta`, so adding one is a contract change; that is the cost of this
 *     exception and it is stated here rather than discovered.
 */
export async function listLocations(
  ctx: TenantContext,
  query: InventoryLocationQuery
): Promise<InventoryLocationListResponse> {
  if (query.branchId !== undefined) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const rows = await tx.inventoryLocation.findMany({
      where: {
        deletedAt: null,
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      include: summaryInclude,
      orderBy: [{ branchId: 'asc' }, { kind: 'asc' }, { name: 'asc' }],
    });

    return { locations: rows.map(toSummary) };
  });
}

export async function getLocation(
  ctx: TenantContext,
  id: string
): Promise<InventoryLocationDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findLocationOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createLocation(
  ctx: TenantContext,
  input: CreateInventoryLocationRequest,
  options: CatalogueActionOptions = {}
): Promise<InventoryLocationDetail> {
  assertBranchInScope(ctx, input.branchId);

  return withTenant(ctx, async (tx) => {
    const clash = await tx.inventoryLocation.findFirst({
      where: { branchId: input.branchId, code: input.code },
      select: { id: true, deletedAt: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.deletedAt
          ? `A location coded ${input.code} was removed from this branch. Codes are not reused, because every historical movement still cites it.`
          : `This branch already has a location coded ${input.code}.`
      );
    }

    const created = await tx.inventoryLocation.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        kind: input.kind,
        code: input.code,
        name: input.name,
        isDispensingPoint: input.isDispensingPoint,
        requiresControlledAccess: input.requiresControlledAccess,
        storageProfileId: input.storageProfileId ?? null,
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'inventory_location',
      entityId: created.id,
      branchId: input.branchId,
      after: {
        code: created.code,
        name: created.name,
        kind: created.kind,
        isDispensingPoint: created.isDispensingPoint,
        requiresControlledAccess: created.requiresControlledAccess,
      },
      ...options,
    });

    return toDetail(created);
  });
}

export async function updateLocation(
  ctx: TenantContext,
  id: string,
  input: UpdateInventoryLocationRequest,
  options: CatalogueActionOptions = {}
): Promise<InventoryLocationDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findLocationOrThrow(tx, id);

    /*
     * ⚠️ DEACTIVATING A LOCATION THAT STILL HOLDS STOCK IS REFUSED. The balances
     *   would remain, invisible to every screen that filters on active
     *   locations, and the stock would be neither counted nor findable — which
     *   is precisely the "it vanished" complaint the ledger exists to make
     *   impossible. Move the stock out first; the movements are the record of
     *   where it went.
     */
    if (input.isActive === false && existing.isActive) {
      /*
       * ⚠️ THE LOCATION ROW IS LOCKED FIRST, AND WITHOUT THAT THE CHECK IS A
       *   READ-THEN-WRITE WITH NOTHING SERIALISING IT. A concurrent
       *   `recordMovement` into this location commits between the balance read
       *   and the update — the movement path only refuses a location that is
       *   ALREADY inactive, and its advisory lock is on the BUCKET, not on the
       *   location. The result is precisely the state the comment below calls
       *   unrecoverable: balances sitting under a location that no screen shows.
       *
       *   `FOR UPDATE` works here and would not work on `stock_balances`: this
       *   table keeps its UPDATE grant, and that table deliberately does not.
       */
      await tx.$executeRaw`
        SELECT 1 FROM "inventory_locations" WHERE "id" = ${id}::uuid FOR UPDATE
      `;

      const held = await tx.stockBalance.findFirst({
        where: { locationId: id, quantity: { gt: 0 } },
        select: { id: true },
      });
      if (held) {
        throw new ConflictError(
          `${existing.name} still holds stock. Move it somewhere else before taking the location out of use.`
        );
      }
    }

    const updated = await tx.inventoryLocation.update({
      where: { id },
      data: {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isDispensingPoint !== undefined
          ? { isDispensingPoint: input.isDispensingPoint }
          : {}),
        ...(input.requiresControlledAccess !== undefined
          ? { requiresControlledAccess: input.requiresControlledAccess }
          : {}),
        ...(input.storageProfileId !== undefined
          ? { storageProfileId: input.storageProfileId }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'inventory_location',
      entityId: id,
      branchId: existing.branchId,
      before: {
        kind: existing.kind,
        name: existing.name,
        isDispensingPoint: existing.isDispensingPoint,
        requiresControlledAccess: existing.requiresControlledAccess,
        storageProfileId: existing.storageProfileId,
        isActive: existing.isActive,
      },
      after: {
        kind: updated.kind,
        name: updated.name,
        isDispensingPoint: updated.isDispensingPoint,
        requiresControlledAccess: updated.requiresControlledAccess,
        storageProfileId: updated.storageProfileId,
        isActive: updated.isActive,
      },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Replace a location's shelving wholesale.
 *
 * The same call `replacePackagings` makes, and for a related reason: a layout is
 * edited as a layout, and per-row endpoints turn one save into n requests that
 * can half-apply. Bins arrive nested inside their area so the two can never be
 * posted inconsistently.
 *
 * ⚠️ AREAS AND BINS ARE ADDRESSES, NOT QUANTITIES. `stock_balances` is keyed by
 *   LOCATION and not by bin, so deleting a bin loses a label and never a number.
 *   That is what makes replacing the whole set safe here and unsafe for anything
 *   the ledger cites.
 */
export async function replaceStorageAreas(
  ctx: TenantContext,
  locationId: string,
  input: ReplaceStorageAreasRequest,
  options: CatalogueActionOptions = {}
): Promise<InventoryLocationDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findLocationOrThrow(tx, locationId);

    const codes = new Set(input.areas.map((a) => a.code));
    if (codes.size !== input.areas.length) {
      throw new ValidationError('Two areas share a code. Each area code must be unique here.');
    }
    for (const area of input.areas) {
      const binCodes = new Set(area.bins.map((b) => b.code));
      if (binCodes.size !== area.bins.length) {
        throw new ValidationError(`Two bins in ${area.code} share a code.`);
      }
    }

    /*
     * Delete-then-create in one transaction, so no reader ever sees a location
     * with half its shelving. An in-place upsert would be order-dependent —
     * renaming area B to A collides with the A that has not been removed yet.
     * The bins cascade with their area.
     */
    await tx.storageArea.deleteMany({ where: { locationId } });

    for (const area of input.areas) {
      await tx.storageArea.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: existing.branchId,
          locationId,
          code: area.code,
          name: area.name,
          isActive: area.isActive,
          bins: {
            create: area.bins.map((b) => ({
              organizationId: ctx.organizationId,
              branchId: existing.branchId,
              code: b.code,
              label: b.label ?? null,
              isActive: b.isActive,
            })),
          },
        },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'storage_area',
      entityId: locationId,
      branchId: existing.branchId,
      before: { areas: existing.areas.length },
      after: { areas: input.areas.length },
      ...options,
    });

    return toDetail(await findLocationOrThrow(tx, locationId));
  });
}
