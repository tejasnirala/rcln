/**
 * Branches: the places a clinic operates from.
 *
 * SCOPING
 *   `branches` carries tenant_isolation but no branch_isolation policy, so RLS
 *   narrows a query to the organization and no further. Every function here
 *   additionally filters to `ctx.branchIds` — the branches this caller actually
 *   holds an assignment for. An ORG_OWNER has an org-wide assignment and so gets
 *   every branch; a BRANCH_ADMIN gets theirs. Without that filter a branch admin
 *   at one location could rename another location, and no policy would stop it.
 *
 *   `branchIds` is recomputed per request by loadUserAccess, not carried in the
 *   JWT, so a branch created now is visible to an org-wide admin on their very
 *   next request rather than after they sign in again.
 *
 * OPERATING HOURS
 *   Written only through the branch parent. `branch_operating_hours` has no
 *   organization_id; it is isolated by an EXISTS against its branch (migration
 *   20260726090000). Addressing a row by its own id would still be refused by
 *   that policy, but it would come back as a silent zero-row update rather than
 *   an error — so the nested-write form is the one to keep using.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type {
  BranchDetail,
  CreateBranchRequest,
  OperatingHour,
  UpdateBranchRequest,
} from '@rcln/contracts';
import {
  countryInfo,
  defaultTimezoneFor,
  isValidPostalCode,
  isValidRegion,
  postalFormatFor,
  regionsFor,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { invalidateOrganizationAccess } from '../auth/access.service.js';
import { recordAudit } from '../audit/audit.service.js';

/** Request metadata carried onto the audit row. */
export interface BranchActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The branch's tax jurisdiction and postcode, checked against each other.
 *
 * ⚠️ CHECKED HERE AND NOT IN THE ZOD CONTRACT BECAUSE THE COUNTRY MAY BE
 *   INHERITED. A PATCH that sets only a region, or a create that omits the
 *   country entirely, has to be judged against the country the branch will
 *   actually end up with — which is known here and nowhere earlier. The old
 *   contract-level `^\d{6}$` on the postcode was India's PIN format applied to
 *   every country, and it made an Irish or Emirati branch unsaveable.
 *
 * A region on a country that does not register tax by subdivision is refused
 * rather than ignored: `IE-D` looks like a jurisdiction and matches no
 * registration, so an invoice raised there would silently carry no tax.
 */
function assertJurisdiction(
  countryCode: string,
  regionCode: string | null,
  pincode: string | undefined
): void {
  if (!countryInfo(countryCode)) {
    throw new ValidationError('Unknown country', {
      countryCode: [`${countryCode} is not a country this product knows how to bill in`],
    });
  }

  if (!isValidRegion(countryCode, regionCode)) {
    const known = regionsFor(countryCode);
    throw new ValidationError('Unknown region', {
      regionCode: [
        known.length === 0
          ? `${countryCode} does not register tax by state or province — leave this empty`
          : `not a ${countryCode} subdivision, e.g. ${known[0]?.code ?? ''}`,
      ],
    });
  }

  if (!isValidPostalCode(countryCode, pincode)) {
    const format = postalFormatFor(countryCode);
    throw new ValidationError('Invalid postcode', {
      pincode: [
        format
          ? `does not look like a valid ${countryCode} postcode, e.g. ${format.example}`
          : 'this country has no postcode',
      ],
    });
  }
}

/**
 * Postgres `time` has no date, but Prisma surfaces it as a `DateTime`.
 *
 * The convention is the epoch date with the wanted clock time in UTC, and it
 * has to be applied consistently in both directions: build a Date from local
 * components instead and the value shifts by the server's offset, which in IST
 * turns 09:00 into 03:30 with nothing to indicate it happened.
 */
function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

function fromTime(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** The shape Prisma is asked for, so list and detail cannot drift apart. */
const BRANCH_SELECT = {
  id: true,
  name: true,
  code: true,
  branchType: true,
  status: true,
  isPrimary: true,
  timezone: true,
  phone: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  pincode: true,
  countryCode: true,
  regionCode: true,
  operatingHours: {
    select: {
      dayOfWeek: true,
      opensAt: true,
      closesAt: true,
      isClosed: true,
      slotMinutes: true,
    },
    orderBy: { dayOfWeek: 'asc' },
  },
} as const;

interface BranchRow {
  id: string;
  name: string;
  code: string;
  branchType: BranchDetail['branchType'];
  status: BranchDetail['status'];
  isPrimary: boolean;
  timezone: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  countryCode: string;
  regionCode: string | null;
  operatingHours: {
    dayOfWeek: number;
    opensAt: Date;
    closesAt: Date;
    isClosed: boolean;
    slotMinutes: number;
  }[];
}

function toDetail(row: BranchRow): BranchDetail {
  return {
    ...row,
    operatingHours: row.operatingHours.map((h) => ({
      dayOfWeek: h.dayOfWeek,
      opensAt: fromTime(h.opensAt),
      closesAt: fromTime(h.closesAt),
      isClosed: h.isClosed,
      slotMinutes: h.slotMinutes,
    })),
  };
}

/**
 * Audit snapshots are the branch's own configuration only.
 *
 * Deliberately excludes operating hours: they are replaced as a set, and
 * dumping fourteen timestamps into before/after buries the field that actually
 * changed. setOperatingHours records its own summary instead.
 */
function snapshot(row: BranchRow): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  delete rest['operatingHours'];
  return rest;
}

export async function listBranches(ctx: TenantContext): Promise<BranchDetail[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx.branch.findMany({
      where: { id: { in: ctx.branchIds }, deletedAt: null },
      select: BRANCH_SELECT,
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    })
  );

  return rows.map(toDetail);
}

export async function getBranch(ctx: TenantContext, branchId: string): Promise<BranchDetail> {
  const row = await withTenant(ctx, (tx) =>
    tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: BRANCH_SELECT,
    })
  );

  // Not in scope is reported exactly as not existing. Distinguishing them tells
  // a branch admin how many other locations the clinic has.
  if (!row || !ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
  return toDetail(row);
}

export async function createBranch(
  ctx: TenantContext,
  input: CreateBranchRequest,
  options: BranchActionOptions = {}
): Promise<BranchDetail> {
  return withTenant(ctx, async (tx) => {
    const clash = await tx.branch.findFirst({
      where: { code: input.code, deletedAt: null },
      select: { id: true },
    });
    // @@unique([organizationId, code]) would raise this as a bare 409 anyway.
    // Checking first only buys a message that names the field.
    if (clash) throw new ConflictError(`A branch with code ${input.code} already exists.`);

    /*
     * ⚠️ THE ORGANIZATION IS THE DEFAULT, NOT THE COLUMN'S `IN`.
     *   Country, region and time zone were previously unsettable through this
     *   endpoint at all, so every branch took the schema defaults — `IN` and
     *   `Asia/Kolkata` — no matter where its organization was. For an Irish clinic
     *   that meant its branches looked Indian to the tax engine, so its VAT
     *   registration covered nothing and every invoice came out untaxed with no
     *   error. Inheriting is right for the single-country clinic and correctable
     *   for the group that opens abroad.
     */
    const organization = await tx.organization.findFirst({
      where: { id: ctx.organizationId },
      select: { countryCode: true, regionCode: true, timezone: true },
    });

    const countryCode = input.countryCode ?? organization?.countryCode ?? 'IN';
    const regionCode =
      input.regionCode !== undefined ? input.regionCode : (organization?.regionCode ?? null);

    assertJurisdiction(countryCode, regionCode, input.pincode);

    const created = await tx.branch.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        code: input.code,
        branchType: input.branchType,
        timezone: input.timezone ?? organization?.timezone ?? defaultTimezoneFor(countryCode),
        countryCode,
        regionCode,
        // exactOptionalPropertyTypes: a conditional spread, never `key: undefined`.
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
        // isPrimary stays false: the first branch was made primary at
        // registration, and moving that flag is its own deliberate action.
      },
      select: BRANCH_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'branch',
      entityId: created.id,
      after: snapshot(created),
      branchId: created.id,
      ...options,
    });

    return toDetail(created);
  }).then(async (created) => {
    // After COMMIT, never inside it: a rolled-back create that had already
    // dropped the cache would leave every org-wide member paying for a rebuild
    // of something that did not change.
    await invalidateOrganizationAccess(ctx.organizationId);
    return created;
  });
}

export async function updateBranch(
  ctx: TenantContext,
  branchId: string,
  input: UpdateBranchRequest,
  options: BranchActionOptions = {}
): Promise<BranchDetail> {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  return withTenant(ctx, async (tx) => {
    const before = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: BRANCH_SELECT,
    });
    if (!before) throw new NotFoundError('Branch');

    if (input.code !== undefined && input.code !== before.code) {
      const clash = await tx.branch.findFirst({
        where: { code: input.code, deletedAt: null, NOT: { id: branchId } },
        select: { id: true },
      });
      if (clash) throw new ConflictError(`A branch with code ${input.code} already exists.`);
    }

    /*
     * Judged against what the branch will END UP as, not against what was sent: a
     * PATCH that moves only the region has to be checked against the country
     * already on the row, and one that moves only the country has to re-check the
     * region and postcode that stay behind. Checking the payload alone lets
     * `{ countryCode: 'IE' }` land on a branch still carrying `KA`.
     */
    assertJurisdiction(
      input.countryCode ?? before.countryCode,
      input.regionCode !== undefined ? input.regionCode : before.regionCode,
      input.pincode ?? before.pincode ?? undefined
    );

    const after = await tx.branch.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
      // Only the keys the caller actually sent. updateBranchRequest is a
      // `.partial()`, so an absent key means "leave it alone", not "set null".
      data: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      select: BRANCH_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'branch',
      entityId: branchId,
      before: snapshot(before),
      after: snapshot(after),
      branchId,
      ...options,
    });

    return toDetail(after);
  });
}

/**
 * Replace a branch's whole week of operating hours.
 *
 * Not a partial update: see the contract. A day absent from `hours` is removed,
 * which is how a branch drops to a six-day week.
 */
export async function setOperatingHours(
  ctx: TenantContext,
  branchId: string,
  hours: OperatingHour[],
  options: BranchActionOptions = {}
): Promise<BranchDetail> {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  const days = new Set(hours.map((h) => h.dayOfWeek));
  if (days.size !== hours.length) {
    throw new ConflictError('Each day of the week may appear only once.');
  }

  for (const hour of hours) {
    // Checked here rather than in the schema because it is a relationship
    // between two fields, and a zero-length day is a mistake, not a closure —
    // `isClosed` is how a closed day is expressed.
    if (!hour.isClosed && hour.closesAt <= hour.opensAt) {
      throw new ConflictError(
        `Closing time must be after opening time (day ${String(hour.dayOfWeek)}).`
      );
    }
  }

  return withTenant(ctx, async (tx) => {
    const before = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: BRANCH_SELECT,
    });
    if (!before) throw new NotFoundError('Branch');

    // Through the parent, never by child id — see the file header.
    const after = await tx.branch.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
      data: {
        operatingHours: {
          deleteMany: {},
          create: hours.map((h) => ({
            dayOfWeek: h.dayOfWeek,
            opensAt: toTime(h.opensAt),
            closesAt: toTime(h.closesAt),
            isClosed: h.isClosed,
            slotMinutes: h.slotMinutes,
          })),
        },
      },
      select: BRANCH_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'branch_operating_hours',
      entityId: branchId,
      // The set as a whole, in a form a human can read back.
      before: { hours: toDetail(before).operatingHours },
      after: { hours: toDetail(after).operatingHours },
      branchId,
      ...options,
    });

    return toDetail(after);
  });
}

/**
 * Retire a branch.
 *
 * Soft delete — `deletedAt`, never an `isDeleted` boolean, because when it
 * closed is part of the record. Appointments, invoices and stock ledger rows
 * keep pointing at it and must stay readable.
 */
export async function deleteBranch(
  ctx: TenantContext,
  branchId: string,
  options: BranchActionOptions = {}
): Promise<void> {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  await withTenant(ctx, async (tx) => {
    const before = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: BRANCH_SELECT,
    });
    if (!before) throw new NotFoundError('Branch');

    if (before.isPrimary) {
      throw new ConflictError(
        'The primary branch cannot be removed. Make another branch primary first.'
      );
    }

    // An organization with no location cannot take a booking, and nothing else
    // in the system expects that state to be reachable.
    const remaining = await tx.branch.count({
      where: { deletedAt: null, NOT: { id: branchId } },
    });
    if (remaining === 0) {
      throw new ConflictError('A clinic must have at least one branch.');
    }

    const after = await tx.branch.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: branchId } },
      data: { deletedAt: new Date(), status: 'CLOSED' },
      select: BRANCH_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'branch',
      entityId: branchId,
      before: snapshot(before),
      after: snapshot(after),
      branchId,
      ...options,
    });
  });

  // Same reason as createBranch: an org-wide member's branchIds just shrank.
  await invalidateOrganizationAccess(ctx.organizationId);
}
