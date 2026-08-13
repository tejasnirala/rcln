/**
 * Suppliers and their tax identifiers (PI-4.1).
 *
 * ── ORG-SCOPED, WHICH IS THE ONE TENANCY CALL IN THIS DOMAIN WORTH ARGUING WITH ─
 * A supplier is the ORGANIZATION's vendor, not a branch's: a three-site group
 * negotiates one contract with one distributor, and branch-scoping this would mean
 * three rows, three sets of tax identifiers, three price lists and no way to
 * answer "what do we spend with them". What IS branch-scoped is every document.
 *
 * ⚠️ THE COST, WRITTEN DOWN: a branch-scoped storekeeper reads the whole
 *   organization's supplier list and price book. That is intended — they order
 *   from it — and it is why nothing branch-confidential may ever be added to these
 *   tables. Payment terms and a price per pack are the ceiling.
 *
 * ── THE TAX IDENTIFIERS DO NOT FEED THE TAX ENGINE ──────────────────────────
 * ⚠️ `supplier_tax_identifiers` RECORDS WHAT A SUPPLIER PRINTED ON THEIR INVOICE
 *   AND PRICES NOTHING. `@rcln/tax` prices SALES — what the clinic charges its
 *   patient — and is never called from here. Tax on a purchase is input tax, it is
 *   recorded rather than calculated (PI-ADR-006), and input-tax credit is out of
 *   scope for this programme.
 *
 * NO PHI. A supplier is a business.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateSupplierRequest,
  CreateSupplierTaxIdentifierRequest,
  SupplierDetail,
  SupplierListResponse,
  SupplierQuery,
  SupplierSummary,
  SupplierTaxIdentifierDetail,
  UpdateSupplierRequest,
  UpdateSupplierTaxIdentifierRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';
import { fromDateString, toDateString, toRequiredDateString } from './shared.js';

const detailInclude = Prisma.validator<Prisma.SupplierInclude>()({
  taxIdentifiers: { orderBy: [{ effectiveFrom: 'desc' }, { registrationNumber: 'asc' }] },
  _count: { select: { products: true } },
});

type DetailRow = Prisma.SupplierGetPayload<{ include: typeof detailInclude }>;

function toTaxIdentifier(row: DetailRow['taxIdentifiers'][number]): SupplierTaxIdentifierDetail {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme,
    registrationNumber: row.registrationNumber,
    legalName: row.legalName,
    // `effectiveFrom` is NOT NULL, so it goes through the required-column form.
    // See `toRequiredDateString` for why that is a second function rather than a
    // `?? ''` fallback or a `!`.
    effectiveFrom: toRequiredDateString(row.effectiveFrom),
    effectiveTo: toDateString(row.effectiveTo),
  };
}

function toSummary(row: DetailRow): SupplierSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    status: row.status,
    contactPerson: row.contactPerson,
    email: row.email,
    phone: row.phone,
    city: row.city,
    regionCode: row.regionCode,
    countryCode: row.countryCode,
    defaultCurrency: row.defaultCurrency,
    leadTimeDays: row.leadTimeDays,
    productCount: row._count.products,
    isDeleted: row.deletedAt !== null,
  };
}

function toDetail(row: DetailRow): SupplierDetail {
  return {
    ...toSummary(row),
    website: row.website,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    postalCode: row.postalCode,
    paymentTermsDays: row.paymentTermsDays,
    notes: row.notes,
    taxIdentifiers: row.taxIdentifiers.map(toTaxIdentifier),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findSupplierOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const row = await tx.supplier.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw new NotFoundError('Supplier');
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSuppliers(
  ctx: TenantContext,
  query: SupplierQuery
): Promise<SupplierListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.SupplierWhereInput = {
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.q !== undefined
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
              { legalName: { contains: query.q, mode: 'insensitive' } },
              { contactPerson: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.supplier.count({ where }),
      tx.supplier.findMany({
        where,
        include: detailInclude,
        // `id` last, so offset pagination means something when two suppliers share
        // a name. The same tie-break every list in this repository takes.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      suppliers: rows.map(toSummary),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  });
}

export async function getSupplier(ctx: TenantContext, id: string): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findSupplierOrThrow(tx, id)));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createSupplier(
  ctx: TenantContext,
  input: CreateSupplierRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ CHECKED HERE AS WELL AS BY `@@unique([organizationId, code])`, AND THE
     *   INDEX ALONE WOULD PRODUCE A 23505 NOBODY CAN READ. It also has to consider
     *   SOFT-DELETED rows, which the index does not distinguish: a clinic that
     *   removed `MEDIDIST` and re-adds it hits a duplicate key on a row they
     *   cannot see, which is unexplainable from the screen. Told plainly instead,
     *   with what to do about it.
     */
    const clash = await tx.supplier.findFirst({
      where: { code: input.code },
      select: { id: true, name: true, deletedAt: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.deletedAt === null
          ? `${input.code} is already the code for ${clash.name}.`
          : `${input.code} was the code for ${clash.name}, which has been removed. Restore that supplier or choose a different code — purchase orders still cite it.`
      );
    }

    const created = await tx.supplier.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        legalName: input.legalName ?? null,
        status: input.status,
        contactPerson: input.contactPerson ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        website: input.website ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        regionCode: input.regionCode ?? null,
        postalCode: input.postalCode ?? null,
        countryCode: input.countryCode ?? null,
        defaultCurrency: input.defaultCurrency ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        notes: input.notes ?? null,
      },
      select: { id: true },
    });

    const row = await findSupplierOrThrow(tx, created.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'supplier',
      entityId: row.id,
      after: { code: row.code, name: row.name, status: row.status },
      ...options,
    });

    return toDetail(row);
  });
}

export async function updateSupplier(
  ctx: TenantContext,
  id: string,
  input: UpdateSupplierRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findSupplierOrThrow(tx, id);
    if (existing.deletedAt) throw new NotFoundError('Supplier');

    /*
     * ⚠️ THE DOCUMENTS DO NOT CHANGE, AND THAT IS THE POINT OF THE SNAPSHOT. Every
     *   purchase order, receipt and return carries `supplier_name` as it was when
     *   the document was raised. Renaming a supplier here renames them on new
     *   documents and on nothing else — see `resolveSupplierForDocument`.
     */
    const updated = await tx.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.contactPerson !== undefined ? { contactPerson: input.contactPerson } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.website !== undefined ? { website: input.website } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.regionCode !== undefined ? { regionCode: input.regionCode } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.defaultCurrency !== undefined ? { defaultCurrency: input.defaultCurrency } : {}),
        ...(input.paymentTermsDays !== undefined
          ? { paymentTermsDays: input.paymentTermsDays }
          : {}),
        ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: detailInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'supplier',
      entityId: id,
      before: { name: existing.name, status: existing.status },
      after: { name: updated.name, status: updated.status },
      ...options,
    });

    return toDetail(updated);
  });
}

/**
 * Remove a supplier from the pickers.
 *
 * ⚠️ A SOFT DELETE, NECESSARILY, AND IT IS NOT THE SAME AS `BLACKLISTED`. Three
 *   years of purchase orders and receipts cite this row through a `Restrict`
 *   foreign key, so a hard delete is not available and would not be wanted —
 *   "which supplier did this lot come from" must keep having an answer for as long
 *   as the lot might be recalled.
 *
 *   `deleted_at` is "take it off the picker"; `BLACKLISTED` is "we refuse to deal
 *   with them, and everyone should see that we do". A clinic that blacklists a
 *   supplier for a quality failure wants the second, and deleting them instead
 *   hides the very fact that mattered.
 */
export async function deleteSupplier(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.supplier.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, deletedAt: true },
    });
    if (!existing || existing.deletedAt) throw new NotFoundError('Supplier');

    /*
     * ⚠️ AN OPEN ORDER IS REFUSED RATHER THAN ORPHANED. A supplier removed while a
     *   PO is still issued leaves a delivery nobody can receive against — the
     *   receipt form's supplier picker no longer offers them — and the buyer's only
     *   remaining move is to re-create the supplier under a new code, which splits
     *   their spend history in two.
     */
    const openOrders = await tx.purchaseOrder.count({
      where: { supplierId: id, status: { in: ['DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED'] } },
    });
    if (openOrders > 0) {
      throw new ValidationError(
        `${existing.name} has ${String(openOrders)} purchase order(s) still open. Receive or close them first — a supplier removed mid-order leaves a delivery nobody can sign for. Putting them on hold stops new orders without doing that.`
      );
    }

    const now = new Date();
    await tx.supplier.update({ where: { id }, data: { deletedAt: now } });
    /*
     * The price book goes with them. It is meaningless on its own — every row is
     * "what THIS supplier charges" — and leaving it active would keep offering
     * their prices in the purchase-order form.
     */
    await tx.supplierProduct.updateMany({
      where: { supplierId: id, deletedAt: null },
      data: { deletedAt: now },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'supplier',
      entityId: id,
      before: { code: existing.code, name: existing.name },
      ...options,
    });
  });
}

// ---------------------------------------------------------------------------
// Tax identifiers
// ---------------------------------------------------------------------------

export async function addSupplierTaxIdentifier(
  ctx: TenantContext,
  supplierId: string,
  input: CreateSupplierTaxIdentifierRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!supplier || supplier.deletedAt) throw new NotFoundError('Supplier');

    if (input.effectiveTo != null && input.effectiveTo < input.effectiveFrom) {
      throw new ValidationError(
        'This registration is recorded as lapsing before it took effect. Check the two dates.'
      );
    }

    /*
     * ⚠️ THE CLASH IS ON `(country, scheme, NUMBER)` AND NOT ON `(country,
     *   scheme)`, WHICH IS THE SAME CALL `issuer_tax_registrations` ARGUES AT
     *   LENGTH. A supplier legitimately holds two GSTINs in one state — India has
     *   allowed a second per state for a separate business vertical since 2019 —
     *   and they keep the ones they no longer use, because a purchase order raised
     *   today for last year's delivery has to cite the number in force THEN. You
     *   cannot record the same registration twice; everything else is a business
     *   fact rather than a constraint.
     */
    const clash = await tx.supplierTaxIdentifier.findFirst({
      where: {
        supplierId,
        countryCode: input.countryCode,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        `${input.registrationNumber} is already recorded for ${supplier.name}. Edit the dates on the existing entry if it has changed.`
      );
    }

    const created = await tx.supplierTaxIdentifier.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId,
        countryCode: input.countryCode,
        regionCode: input.regionCode ?? null,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
        legalName: input.legalName ?? null,
        effectiveFrom: fromDateString(input.effectiveFrom),
        effectiveTo: input.effectiveTo != null ? fromDateString(input.effectiveTo) : null,
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'supplier_tax_identifier',
      entityId: created.id,
      after: {
        supplierId,
        countryCode: input.countryCode,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
      },
      ...options,
    });

    return toDetail(await findSupplierOrThrow(tx, supplierId));
  });
}

/**
 * ⚠️ THE NUMBER, THE COUNTRY AND THE SCHEME ARE NOT EDITABLE. Together they ARE
 *   the registration; changing one would silently restate which authority a past
 *   purchase order was raised under. A different number is a different row, which
 *   is what a supplier re-registering means — and the dates are what say which of
 *   the two was in force when.
 */
export async function updateSupplierTaxIdentifier(
  ctx: TenantContext,
  supplierId: string,
  identifierId: string,
  input: UpdateSupplierTaxIdentifierRequest,
  options: CatalogueActionOptions = {}
): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.supplierTaxIdentifier.findUnique({
      where: { id: identifierId },
      select: {
        id: true,
        supplierId: true,
        registrationNumber: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    if (!existing || existing.supplierId !== supplierId) {
      throw new NotFoundError('Supplier tax identifier');
    }

    const from = input.effectiveFrom ?? toDateString(existing.effectiveFrom);
    const to =
      input.effectiveTo !== undefined ? input.effectiveTo : toDateString(existing.effectiveTo);
    if (from != null && to != null && to < from) {
      throw new ValidationError(
        'This registration is recorded as lapsing before it took effect. Check the two dates.'
      );
    }

    await tx.supplierTaxIdentifier.update({
      where: { id: identifierId },
      data: {
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: fromDateString(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo === null ? null : fromDateString(input.effectiveTo) }
          : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'supplier_tax_identifier',
      entityId: identifierId,
      before: { registrationNumber: existing.registrationNumber },
      after: { effectiveFrom: from, effectiveTo: to },
      ...options,
    });

    return toDetail(await findSupplierOrThrow(tx, supplierId));
  });
}

/**
 * ⚠️ A HARD DELETE, AND IT IS THE ONE IN THIS FILE. Nothing cites a tax identifier
 *   by id — purchase orders snapshot the NUMBER as a string, exactly as invoices
 *   snapshot the issuer's — so removing the row breaks no document and rewrites no
 *   history. A number entered wrongly is a typo and should disappear; the way to
 *   record one that genuinely lapsed is `effectiveTo`.
 */
export async function removeSupplierTaxIdentifier(
  ctx: TenantContext,
  supplierId: string,
  identifierId: string,
  options: CatalogueActionOptions = {}
): Promise<SupplierDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.supplierTaxIdentifier.findUnique({
      where: { id: identifierId },
      select: { id: true, supplierId: true, registrationNumber: true, scheme: true },
    });
    if (!existing || existing.supplierId !== supplierId) {
      throw new NotFoundError('Supplier tax identifier');
    }

    await tx.supplierTaxIdentifier.delete({ where: { id: identifierId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'supplier_tax_identifier',
      entityId: identifierId,
      before: { registrationNumber: existing.registrationNumber, scheme: existing.scheme },
      ...options,
    });

    return toDetail(await findSupplierOrThrow(tx, supplierId));
  });
}
