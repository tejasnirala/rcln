/**
 * Units of measure and the conversions between them.
 *
 * The catalogue half — loading, listing and curating rows. The ARITHMETIC is in
 * `units.ts`, which reads no database and is unit-tested without a tenant.
 *
 * ── TENANCY ──────────────────────────────────────────────────────────────────
 * `units_of_measure` and `unit_conversions` are platform catalogue + tenant
 * extension. Every statement runs inside `withTenant`, so a clinic sees the
 * platform rows plus its own and nothing else.
 *
 * ⚠️ THE READ POLICY IS PERMISSIVE AND THE WRITE POLICY IS NOT, and the second
 *   half is what matters:
 *
 *       USING      (organization_id IS NULL OR organization_id = app_current_org())
 *       WITH CHECK (organization_id = app_current_org())
 *
 *   An UPDATE against a platform row FINDS the row — it is visible — and then
 *   fails the WITH CHECK, which is evaluated against the row as it would be
 *   after the write: a platform row's organization_id stays NULL. Postgres
 *   refuses it. `assertMutable` below is the SECOND layer, and exists only so
 *   the caller gets a sentence instead of a row-level-security error.
 *
 * ⚠️ A TENANT MAY NOT CREATE A BASE UNIT. The CHECK constraint
 *   `units_of_measure_base_is_platform` refuses it, and the contract does not
 *   expose the field. Two base units in one class gives that clinic's conversion
 *   graph two roots — it still resolves, and it resolves differently from every
 *   other clinic's.
 *
 * NO PHI. A unit is not a patient.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateUnitConversionRequest,
  CreateUnitRequest,
  UnitConversionSummary,
  UnitListResponse,
  UnitQuery,
  UnitSummary,
  UpdateUnitRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { buildUnitGraph, conversionFactor, type UnitGraph, type UnitClass } from './units.js';

export interface CatalogueActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /**
   * The caller's effective PERMISSION codes for the branch being acted on
   * (PI-8, closing KNOWN_ISSUES #5).
   *
   * ⚠️ IT LIVES ON THIS SHARED OPTIONS TYPE BECAUSE THE DOCUMENTS THAT NEED IT
   *   ALREADY TAKE IT. Goods receipt and stock transfer both consult
   *   `@rcln/regulatory` while posting, and both used to pass an EMPTY actor —
   *   so a `PHARMACIST_AUTHORITY` or `IMPORT_RESTRICTION` rule aimed at `STOCK`
   *   saw somebody holding nothing and refused. Adding a fourth options type
   *   just for them would have left the next document to rediscover it.
   *
   * ⚠️ OPTIONAL, AND ABSENT MEANS AN ACTOR HOLDING NOTHING — which satisfies no
   *   rule that names anything, so a call site that forgets refuses rather than
   *   permits. It has to be optional because the worker's sweeps post movements
   *   with no human caller at all.
   *
   * ⚠️ PERMISSION CODES, NEVER ROLE NAMES. A clinic may rename `PHARMACIST` to
   *   "Dispensary Lead", and a rule naming the role would then match nobody —
   *   which reads as the rule being wrong rather than the role having been
   *   renamed. See `RegulatoryActorInput`.
   */
  roleCodes?: readonly string[] | undefined;
}

interface UnitRow {
  id: string;
  organization_id: string | null;
  code: string;
  name: string;
  symbol: string;
  unit_class: UnitClass;
  is_base: boolean;
  is_active: boolean;
}

function toUnit(row: UnitRow): UnitSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    unitClass: row.unit_class,
    isBase: row.is_base,
    isActive: row.is_active,
    isOwn: row.organization_id !== null,
  };
}

/**
 * Refuse to mutate a platform row.
 *
 * The database refuses it too — see the file header. This runs first so the
 * caller is told the catalogue is platform-wide and offered the alternative,
 * rather than being shown a constraint name.
 */
function assertMutable(organizationId: string | null, noun: string): void {
  if (organizationId === null) {
    throw new ValidationError(
      `This ${noun} is part of the platform catalogue and cannot be changed. Add your own instead.`
    );
  }
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Load every unit and conversion visible to this tenant, as a graph.
 *
 * ⚠️ LOADED WHOLE, ON PURPOSE. The temptation is to fetch only the two units a
 *   conversion names, which turns a two-hop path (`box -> strip -> tablet`) into
 *   "no conversion recorded" — the failure is silent, correct-looking, and only
 *   appears for products with more than one packaging level. The table is a few
 *   dozen rows per clinic; load it and let the traversal work.
 *
 * Takes a `TxClient` rather than a `TenantContext` so a caller already inside a
 * transaction reuses it. Every write path here needs the graph AND the write in
 * one transaction, or a conversion can be deleted between the check and the use.
 */
export async function loadUnitGraph(tx: TxClient): Promise<UnitGraph> {
  const [units, conversions] = await Promise.all([
    tx.unitOfMeasure.findMany({
      where: { isActive: true },
      select: { id: true, code: true, unitClass: true },
    }),
    tx.unitConversion.findMany({
      select: { fromUnitId: true, toUnitId: true, numerator: true, denominator: true },
    }),
  ]);

  return buildUnitGraph(
    units.map((u) => ({ id: u.id, code: u.code, unitClass: u.unitClass as UnitClass })),
    conversions.map((c) => ({
      fromUnitId: c.fromUnitId,
      toUnitId: c.toUnitId,
      // Prisma hands back `bigint` for a BigInt column; the arithmetic needs it.
      numerator: c.numerator,
      denominator: c.denominator,
    }))
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listUnits(ctx: TenantContext, query: UnitQuery): Promise<UnitListResponse> {
  return withTenant(ctx, async (tx) => {
    // Independent queries, so they go together — same as `loadUnitGraph` above.
    // Awaiting them in sequence is two round trips for no ordering requirement.
    const [units, conversions] = await Promise.all([
      tx.unitOfMeasure.findMany({
        where: {
          ...(query.unitClass !== undefined ? { unitClass: query.unitClass } : {}),
          ...(query.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ unitClass: 'asc' }, { isBase: 'desc' }, { code: 'asc' }],
      }),
      tx.unitConversion.findMany({
        include: {
          fromUnit: { select: { code: true } },
          toUnit: { select: { code: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      units: units.map((u) =>
        toUnit({
          id: u.id,
          organization_id: u.organizationId,
          code: u.code,
          name: u.name,
          symbol: u.symbol,
          unit_class: u.unitClass as UnitClass,
          is_base: u.isBase,
          is_active: u.isActive,
        })
      ),
      conversions: conversions.map((c): UnitConversionSummary => ({
        id: c.id,
        fromUnitId: c.fromUnitId,
        fromUnitCode: c.fromUnit.code,
        toUnitId: c.toUnitId,
        toUnitCode: c.toUnit.code,
        // Back to `number` for the wire. Both are CHECKed positive and capped
        // by the contract at 1e9, so neither loses precision as a double.
        numerator: Number(c.numerator),
        denominator: Number(c.denominator),
        isOwn: c.organizationId !== null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createUnit(
  ctx: TenantContext,
  input: CreateUnitRequest,
  options: CatalogueActionOptions = {}
): Promise<UnitSummary> {
  return withTenant(ctx, async (tx) => {
    /*
     * A clash against a PLATFORM code is checked as well as against this
     * clinic's own, and refused. The unique index would not catch it — the key
     * is (organization_id, code), so a tenant `ML` beside the platform `ML` is
     * perfectly legal to Postgres. It is not legal to the conversion graph:
     * every lookup by code becomes ambiguous, and every picker shows the same
     * unit twice with no way to tell which is which.
     */
    const clash = await tx.unitOfMeasure.findFirst({
      where: { code: input.code },
      select: { id: true, organizationId: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.organizationId === null
          ? `"${input.code}" is already a platform unit. Use it rather than defining your own.`
          : `You already have a unit with the code "${input.code}".`
      );
    }

    const created = await tx.unitOfMeasure.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        symbol: input.symbol,
        unitClass: input.unitClass,
        // Never true from this path — see the file header and the CHECK.
        isBase: false,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'unit_of_measure',
      entityId: created.id,
      after: { code: created.code, name: created.name, unitClass: created.unitClass },
      ...options,
    });

    return toUnit({
      id: created.id,
      organization_id: created.organizationId,
      code: created.code,
      name: created.name,
      symbol: created.symbol,
      unit_class: created.unitClass as UnitClass,
      is_base: created.isBase,
      is_active: created.isActive,
    });
  });
}

export async function updateUnit(
  ctx: TenantContext,
  unitId: string,
  input: UpdateUnitRequest,
  options: CatalogueActionOptions = {}
): Promise<UnitSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.unitOfMeasure.findUnique({ where: { id: unitId } });
    // NOT FOUND, never FORBIDDEN: RLS has already filtered another tenant's row
    // out of the read, so it is genuinely indistinguishable from a missing one.
    if (!existing) throw new NotFoundError('Unit');
    assertMutable(existing.organizationId, 'unit');

    if (input.isActive === false) {
      /*
       * Deactivating a unit a product is denominated in would leave that product
       * with a base unit the conversion graph no longer loads, so every quantity
       * for it stops resolving. Refuse, and name the count.
       */
      const inUse = await tx.product.count({ where: { baseUnitId: unitId } });
      if (inUse > 0) {
        throw new ConflictError(
          `${inUse} product(s) are measured in this unit. Change them first.`
        );
      }
    }

    const updated = await tx.unitOfMeasure.update({
      where: { id: unitId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'unit_of_measure',
      entityId: unitId,
      before: { name: existing.name, symbol: existing.symbol, isActive: existing.isActive },
      after: { name: updated.name, symbol: updated.symbol, isActive: updated.isActive },
      ...options,
    });

    return toUnit({
      id: updated.id,
      organization_id: updated.organizationId,
      code: updated.code,
      name: updated.name,
      symbol: updated.symbol,
      unit_class: updated.unitClass as UnitClass,
      is_base: updated.isBase,
      is_active: updated.isActive,
    });
  });
}

/**
 * Record that one unit converts into another.
 *
 * The cross-class refusal is enforced by a database trigger; the check here runs
 * first so the message can explain what to do instead. See `conversionFactor`
 * for why the two must not be allowed to disagree.
 */
export async function createUnitConversion(
  ctx: TenantContext,
  input: CreateUnitConversionRequest,
  options: CatalogueActionOptions = {}
): Promise<UnitConversionSummary> {
  return withTenant(ctx, async (tx) => {
    const [from, to] = await Promise.all([
      tx.unitOfMeasure.findUnique({ where: { id: input.fromUnitId } }),
      tx.unitOfMeasure.findUnique({ where: { id: input.toUnitId } }),
    ]);

    if (!from) throw new NotFoundError('Source unit');
    if (!to) throw new NotFoundError('Target unit');

    if (from.id === to.id) {
      throw new ValidationError('A unit already converts to itself. Pick two different units.');
    }

    if (from.unitClass !== to.unitClass) {
      throw new ValidationError(
        `${from.code} measures ${from.unitClass.toLowerCase()} and ${to.code} measures ` +
          `${to.unitClass.toLowerCase()}. If one of this product's ${from.code} genuinely holds a ` +
          `fixed ${to.code}, record it as packaging on the product — it is a fact about that ` +
          `product, not about the units.`
      );
    }

    const existing = await tx.unitConversion.findFirst({
      where: {
        OR: [
          { fromUnitId: from.id, toUnitId: to.id },
          // The reverse direction is the same statement said backwards, and the
          // graph already walks edges both ways. Two rows can disagree.
          { fromUnitId: to.id, toUnitId: from.id },
        ],
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        `A conversion between ${from.code} and ${to.code} already exists. Edit that one instead — ` +
          `a second, in either direction, can contradict it.`
      );
    }

    /*
     * ⚠️ THE DIRECT-PAIR CHECK ABOVE IS NOT ENOUGH, BECAUSE THE GRAPH IS
     *   TRANSITIVE. A contradiction does not need two rows for the same pair —
     *   it only needs a new edge that disagrees with a path that already exists:
     *
     *     STRIP → TAB   = 10     (already recorded)
     *     BOX   → STRIP = 10     (already recorded)
     *     BOX   → TAB   = 90     ← accepted by the check above. 90 ≠ 100.
     *
     *   And it does not merely sit there being wrong. `conversionFactor` is
     *   BREADTH-FIRST, so the new ONE-HOP edge is found before the correct
     *   two-hop path and WINS. The clinic's answer to "how many tablets in a
     *   box" silently changes from 100 to 90 the moment this row is written,
     *   for every product denominated in tablets, with no other symptom.
     *
     *   So the new edge is checked against the graph as it stands. If the two
     *   already reach each other and the existing path disagrees, the row is
     *   refused and the message names both numbers — because the caller is
     *   usually correcting one of the other two edges and needs to know which.
     *
     *   Cross-class was already refused above, so a throw from
     *   `conversionFactor` here can only mean "no path", which is the normal
     *   case and exactly what we want to allow.
     */
    const graph = await loadUnitGraph(tx);
    let existingPath: { n: bigint; d: bigint } | null = null;
    try {
      existingPath = conversionFactor(graph, from.id, to.id);
    } catch {
      existingPath = null;
    }

    if (existingPath !== null) {
      const proposedN = BigInt(input.numerator);
      const proposedD = BigInt(input.denominator);
      // Cross-multiply rather than divide: these are exact integer ratios and
      // a/b === c/d exactly when a*d === c*b. No floats anywhere near this.
      if (existingPath.n * proposedD !== proposedN * existingPath.d) {
        throw new ConflictError(
          `${from.code} already converts to ${to.code} through the conversions you have ` +
            `(${existingPath.n}/${existingPath.d}), and this one says ${proposedN}/${proposedD}. ` +
            `Two answers for the same question is worse than none — correct the existing ` +
            `conversions instead, or this one will silently win over them.`
        );
      }
    }

    const created = await tx.unitConversion.create({
      data: {
        organizationId: ctx.organizationId,
        fromUnitId: from.id,
        toUnitId: to.id,
        numerator: BigInt(input.numerator),
        denominator: BigInt(input.denominator),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'unit_conversion',
      entityId: created.id,
      after: {
        from: from.code,
        to: to.code,
        numerator: input.numerator,
        denominator: input.denominator,
      },
      ...options,
    });

    return {
      id: created.id,
      fromUnitId: from.id,
      fromUnitCode: from.code,
      toUnitId: to.id,
      toUnitCode: to.code,
      numerator: input.numerator,
      denominator: input.denominator,
      isOwn: true,
    };
  });
}

export async function deleteUnitConversion(
  ctx: TenantContext,
  conversionId: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.unitConversion.findUnique({
      where: { id: conversionId },
      include: { fromUnit: { select: { code: true } }, toUnit: { select: { code: true } } },
    });
    if (!existing) throw new NotFoundError('Unit conversion');
    assertMutable(existing.organizationId, 'conversion');

    /*
     * A hard delete, unlike everything else in this catalogue, and deliberately:
     * a conversion is a STATEMENT OF FACT rather than a record of anything that
     * happened. Nothing references it by id — the graph is rebuilt per request —
     * so there is no history to preserve, and a soft-deleted conversion would
     * keep occupying the (from, to) key it can no longer justify.
     */
    await tx.unitConversion.delete({ where: { id: conversionId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'unit_conversion',
      entityId: conversionId,
      before: { from: existing.fromUnit.code, to: existing.toUnit.code },
      ...options,
    });
  });
}
