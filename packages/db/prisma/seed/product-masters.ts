/**
 * Writes the STRUCTURAL product catalogue as PLATFORM rows: units of measure and
 * their conversions, the category tree, and storage requirement profiles.
 *
 * The lists live in `data/product-masters.ts` — this file is only the write
 * logic. Read that file's header before adding anything: it records why there is
 * no medicine data here and why no agent may invent any.
 *
 * ⚠️ `findFirst` THEN create/update RATHER THAN `upsert`, THROUGHOUT.
 *   The uniques are `(organization_id, code)` with `NULLS NOT DISTINCT`, and
 *   Prisma refuses to build a `where` for a compound unique with a nullable
 *   component — `organization_id` is NULL on every row this file writes. Same
 *   constraint and the same workaround as the settings and clinical-masters
 *   seeds. See PITFALLS.
 *
 * Idempotent: safe to re-run, and re-running is how a new unit or category
 * reaches an existing environment.
 */
import { prisma } from './client.js';
import { CATEGORIES, STORAGE_PROFILES, UNITS, UNIT_CONVERSIONS } from './data/product-masters.js';

export async function seedProductMasters(): Promise<void> {
  // -- units ---------------------------------------------------------------
  const unitIdByCode = new Map<string, string>();

  for (const unit of UNITS) {
    const payload = {
      name: unit.name,
      symbol: unit.symbol,
      unitClass: unit.unitClass,
      isBase: unit.isBase ?? false,
    };

    const existing = await prisma.unitOfMeasure.findFirst({
      where: { organizationId: null, code: unit.code },
      select: { id: true },
    });

    const id = existing
      ? (await prisma.unitOfMeasure.update({ where: { id: existing.id }, data: payload })).id
      : (
          await prisma.unitOfMeasure.create({
            data: { organizationId: null, code: unit.code, ...payload },
          })
        ).id;

    unitIdByCode.set(unit.code, id);
  }

  // -- conversions ---------------------------------------------------------
  for (const conversion of UNIT_CONVERSIONS) {
    const fromId = unitIdByCode.get(conversion.from);
    const toId = unitIdByCode.get(conversion.to);
    if (!fromId || !toId) {
      throw new Error(
        `UNIT_CONVERSIONS references an unknown unit code: ${conversion.from} -> ${conversion.to}`
      );
    }

    const payload = {
      numerator: BigInt(conversion.numerator),
      denominator: BigInt(conversion.denominator ?? 1),
    };

    const existing = await prisma.unitConversion.findFirst({
      where: { organizationId: null, fromUnitId: fromId, toUnitId: toId },
      select: { id: true },
    });

    if (existing) {
      await prisma.unitConversion.update({ where: { id: existing.id }, data: payload });
    } else {
      // The `unit_conversions_same_class` trigger fires here. A mistyped unit
      // code that happens to exist in another class is caught by the database
      // rather than by review.
      await prisma.unitConversion.create({
        data: { organizationId: null, fromUnitId: fromId, toUnitId: toId, ...payload },
      });
    }
  }

  // -- categories ----------------------------------------------------------
  /*
   * Parents before children, resolved recursively so the source list can be in
   * any order. Memoised on `code`, so the whole tree costs one pass.
   *
   * ⚠️ A NODE IS NEVER WRITTEN WITHOUT ITS PARENT. Writing them flat and
   *   re-parenting afterwards is what the clinical-masters seed used to do, and
   *   it breaks the moment a sibling-name constraint exists — every row is
   *   momentarily a sibling of every other. `inFlight` catches a parent cycle in
   *   THIS FILE with a legible error, rather than letting it recurse until the
   *   stack gives out or the no-cycle trigger fires mid-write.
   */
  const categoryByCode = new Map(CATEGORIES.map((c) => [c.code, c]));
  const orderOf = new Map(CATEGORIES.map((c, i) => [c.code, i]));
  const resolved = new Map<string, string>();
  const inFlight = new Set<string>();

  async function ensureCategory(code: string): Promise<string> {
    const cached = resolved.get(code);
    if (cached) return cached;

    const category = categoryByCode.get(code);
    if (!category) throw new Error(`CATEGORIES references unknown parent code "${code}"`);

    if (inFlight.has(code)) {
      throw new Error(
        `CATEGORIES contains a parent cycle through "${code}" — check the \`parent\` fields`
      );
    }
    inFlight.add(code);
    const parentId = category.parent ? await ensureCategory(category.parent) : null;
    inFlight.delete(code);

    const payload = {
      name: category.name,
      parentId,
      description: category.description ?? null,
      // Position in the source array, so sibling order is whatever this file
      // reads as and `ORDER BY display_order, name` is total.
      displayOrder: orderOf.get(code) ?? 0,
    };

    const existing = await prisma.productCategory.findFirst({
      where: { organizationId: null, code },
      select: { id: true },
    });

    const id = existing
      ? (await prisma.productCategory.update({ where: { id: existing.id }, data: payload })).id
      : (
          await prisma.productCategory.create({
            data: { organizationId: null, code, ...payload },
          })
        ).id;

    resolved.set(code, id);
    return id;
  }

  for (const category of CATEGORIES) {
    await ensureCategory(category.code);
  }

  // -- storage profiles ----------------------------------------------------
  for (const profile of STORAGE_PROFILES) {
    const payload = {
      name: profile.name,
      minTemperatureC: profile.minTemperatureC ?? null,
      maxTemperatureC: profile.maxTemperatureC ?? null,
      minHumidityPct: profile.minHumidityPct ?? null,
      maxHumidityPct: profile.maxHumidityPct ?? null,
      lightSensitivity: profile.lightSensitivity ?? ('NONE' as const),
      requiresControlledAccess: profile.requiresControlledAccess ?? false,
      hazardClass: profile.hazardClass ?? null,
      handlingNotes: profile.handlingNotes ?? null,
    };

    const existing = await prisma.storageRequirementProfile.findFirst({
      where: { organizationId: null, code: profile.code },
      select: { id: true },
    });

    if (existing) {
      await prisma.storageRequirementProfile.update({ where: { id: existing.id }, data: payload });
    } else {
      await prisma.storageRequirementProfile.create({
        data: { organizationId: null, code: profile.code, ...payload },
      });
    }
  }

  console.warn(`  units            ${UNITS.length}`);
  console.warn(`  unit conversions ${UNIT_CONVERSIONS.length}`);
  console.warn(`  product categories ${CATEGORIES.length}`);
  console.warn(`  storage profiles ${STORAGE_PROFILES.length}`);
  console.warn(`  products         0  — deliberate; see data/product-masters.ts (OD-4)`);
}
