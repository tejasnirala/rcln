/**
 * The flat catalogue masters: manufacturers, active ingredients, compositions
 * and storage requirement profiles.
 *
 * Categories are NOT here — they are a tree, and tree traversal is its own
 * problem with its own recursive CTEs (`category.service.ts`). Units are not
 * here either, because they carry a conversion graph. What is left is four
 * masters that are genuinely just rows, and keeping them together is what stops
 * four near-identical files drifting apart.
 *
 * ── THE GENERIC/BRAND TRIANGLE ───────────────────────────────────────────────
 *
 *     active_ingredients ──< composition_ingredients >── compositions ──< products
 *                              (strength, strength unit)
 *
 * A composition is a NAMED SET of ingredients at strengths, and many products —
 * every brand and the generic — point at one. That single foreign key is what
 * makes "what else is this same medicine?" answerable by a join instead of by
 * comparing names that never match. `products.composition_id` is nullable: a
 * glove has no composition, and that nullability is a more honest discriminator
 * between "catalogue item" and "medicinal product" than a boolean.
 *
 * ⚠️ THIS FILE SAYS WHAT IS CHEMICALLY THE SAME. It never says what may be
 *   SUBSTITUTED — that is a per-jurisdiction regulatory decision that lands in
 *   PI-5, and it depends on the prescriber's instruction and on whether the drug
 *   has a narrow therapeutic index. Nothing here may be read as permission.
 *
 * ── TENANCY ──────────────────────────────────────────────────────────────────
 * All four are platform catalogue + tenant extension: read permissive, write
 * strict. See the header of `unit.service.ts` for why an UPDATE against a
 * platform row is refused by Postgres and not merely by `assertMutable`.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ActiveIngredientSummary,
  CompositionSummary,
  CreateActiveIngredientRequest,
  CreateCompositionRequest,
  CreateManufacturerRequest,
  CreateStorageProfileRequest,
  ManufacturerSummary,
  StorageProfileSummary,
  UpdateActiveIngredientRequest,
  UpdateCompositionRequest,
  UpdateManufacturerRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';
import { decimalToString } from './values.js';

function assertMutable(organizationId: string | null, noun: string): void {
  if (organizationId === null) {
    throw new ValidationError(
      `This ${noun} is part of the platform catalogue and cannot be changed. Add your own instead.`
    );
  }
}

// ---------------------------------------------------------------------------
// Manufacturers
// ---------------------------------------------------------------------------

export async function listManufacturers(
  ctx: TenantContext,
  includeInactive: boolean
): Promise<ManufacturerSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.manufacturer.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      countryCode: m.countryCode,
      licenceNumber: m.licenceNumber,
      gs1Prefix: m.gs1Prefix,
      isActive: m.isActive,
      isOwn: m.organizationId !== null,
    }));
  });
}

export async function createManufacturer(
  ctx: TenantContext,
  input: CreateManufacturerRequest,
  options: CatalogueActionOptions = {}
): Promise<ManufacturerSummary> {
  return withTenant(ctx, async (tx) => {
    const clash = await tx.manufacturer.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A manufacturer with this code already exists.');

    const created = await tx.manufacturer.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        countryCode: input.countryCode ?? null,
        licenceNumber: input.licenceNumber ?? null,
        gs1Prefix: input.gs1Prefix ?? null,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'manufacturer',
      entityId: created.id,
      after: { code: created.code, name: created.name, countryCode: created.countryCode },
      ...options,
    });

    return {
      id: created.id,
      code: created.code,
      name: created.name,
      countryCode: created.countryCode,
      licenceNumber: created.licenceNumber,
      gs1Prefix: created.gs1Prefix,
      isActive: created.isActive,
      isOwn: true,
    };
  });
}

export async function updateManufacturer(
  ctx: TenantContext,
  manufacturerId: string,
  input: UpdateManufacturerRequest,
  options: CatalogueActionOptions = {}
): Promise<ManufacturerSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.manufacturer.findUnique({ where: { id: manufacturerId } });
    if (!existing || existing.deletedAt) throw new NotFoundError('Manufacturer');
    assertMutable(existing.organizationId, 'manufacturer');

    if (input.isActive === false) {
      const inUse = await tx.product.count({
        where: { manufacturerId, deletedAt: null },
      });
      if (inUse > 0) {
        throw new ConflictError(
          `${inUse} product(s) name this manufacturer. Change them before deactivating it.`
        );
      }
    }

    const updated = await tx.manufacturer.update({
      where: { id: manufacturerId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.licenceNumber !== undefined ? { licenceNumber: input.licenceNumber } : {}),
        ...(input.gs1Prefix !== undefined ? { gs1Prefix: input.gs1Prefix } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'manufacturer',
      entityId: manufacturerId,
      before: { name: existing.name, isActive: existing.isActive },
      after: { name: updated.name, isActive: updated.isActive },
      ...options,
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      countryCode: updated.countryCode,
      licenceNumber: updated.licenceNumber,
      gs1Prefix: updated.gs1Prefix,
      isActive: updated.isActive,
      isOwn: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Active ingredients
// ---------------------------------------------------------------------------

/**
 * `synonyms` is stored as a JSONB array of STRINGS.
 *
 * ⚠️ A DOCUMENT, NEVER FOREIGN KEYS (ADR-0006). A synonym that needs an id is
 *   another ingredient and belongs in the table. This reads defensively because
 *   the column is JSONB and a hand-written row could hold anything.
 */
function readSynonyms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export async function listActiveIngredients(
  ctx: TenantContext,
  query: { q?: string | undefined; includeInactive: boolean; limit: number }
): Promise<ActiveIngredientSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.activeIngredient.findMany({
      where: {
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { innName: { contains: query.q, mode: 'insensitive' as const } },
                { code: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: query.limit,
    });

    return rows.map((i) => ({
      id: i.id,
      code: i.code,
      name: i.name,
      innName: i.innName,
      synonyms: readSynonyms(i.synonyms),
      description: i.description,
      isActive: i.isActive,
      isOwn: i.organizationId !== null,
    }));
  });
}

export async function createActiveIngredient(
  ctx: TenantContext,
  input: CreateActiveIngredientRequest,
  options: CatalogueActionOptions = {}
): Promise<ActiveIngredientSummary> {
  return withTenant(ctx, async (tx) => {
    const clash = await tx.activeIngredient.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('An ingredient with this code already exists.');

    const created = await tx.activeIngredient.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        innName: input.innName ?? null,
        synonyms: input.synonyms ?? [],
        description: input.description ?? null,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'active_ingredient',
      entityId: created.id,
      after: { code: created.code, name: created.name, innName: created.innName },
      ...options,
    });

    return {
      id: created.id,
      code: created.code,
      name: created.name,
      innName: created.innName,
      synonyms: readSynonyms(created.synonyms),
      description: created.description,
      isActive: created.isActive,
      isOwn: true,
    };
  });
}

export async function updateActiveIngredient(
  ctx: TenantContext,
  ingredientId: string,
  input: UpdateActiveIngredientRequest,
  options: CatalogueActionOptions = {}
): Promise<ActiveIngredientSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.activeIngredient.findUnique({ where: { id: ingredientId } });
    if (!existing || existing.deletedAt) throw new NotFoundError('Active ingredient');
    assertMutable(existing.organizationId, 'ingredient');

    if (input.isActive === false) {
      const inUse = await tx.compositionIngredient.count({ where: { ingredientId } });
      if (inUse > 0) {
        throw new ConflictError(
          `This ingredient appears in ${inUse} composition(s). Remove it from them first.`
        );
      }
    }

    const updated = await tx.activeIngredient.update({
      where: { id: ingredientId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.innName !== undefined ? { innName: input.innName } : {}),
        ...(input.synonyms !== undefined ? { synonyms: input.synonyms } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'active_ingredient',
      entityId: ingredientId,
      before: { name: existing.name, innName: existing.innName, isActive: existing.isActive },
      after: { name: updated.name, innName: updated.innName, isActive: updated.isActive },
      ...options,
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      innName: updated.innName,
      synonyms: readSynonyms(updated.synonyms),
      description: updated.description,
      isActive: updated.isActive,
      isOwn: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

const compositionInclude = {
  ingredients: {
    include: {
      ingredient: { select: { name: true, innName: true } },
      strengthUnit: { select: { symbol: true } },
    },
    orderBy: { displayOrder: 'asc' as const },
  },
  _count: { select: { products: true } },
} as const;

/**
 * Derived from the loader rather than hand-written, so adding a field to
 * `compositionInclude` cannot leave the mapper describing a shape that no longer
 * arrives. Function declarations hoist, so the alias may precede it.
 */
type CompositionWithIngredients = Awaited<ReturnType<typeof findCompositionOrThrow>>;

/*
 * The return type is DELIBERATELY inferred. It is Prisma's payload type for
 * `compositionInclude`, and writing it out by hand would freeze a shape that
 * changes whenever a field is added to that include — the mapper below derives
 * `CompositionWithIngredients` from this signature precisely so the two cannot
 * drift. An explicit annotation here defeats the thing it looks like it improves.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function findCompositionOrThrow(tx: TxClient, id: string) {
  const row = await tx.composition.findUnique({ where: { id }, include: compositionInclude });
  if (!row || row.deletedAt) throw new NotFoundError('Composition');
  return row;
}

function toComposition(row: CompositionWithIngredients): CompositionSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dosageForm: row.dosageForm,
    isActive: row.isActive,
    isOwn: row.organizationId !== null,
    productCount: row._count.products,
    ingredients: row.ingredients.map((ci) => ({
      ingredientId: ci.ingredientId,
      ingredientName: ci.ingredient.name,
      innName: ci.ingredient.innName,
      strength: ci.strength.toString(),
      strengthUnitId: ci.strengthUnitId,
      strengthUnitSymbol: ci.strengthUnit.symbol,
      perQuantity: decimalToString(ci.perQuantity),
      displayOrder: ci.displayOrder,
    })),
  };
}

export async function listCompositions(
  ctx: TenantContext,
  query: { q?: string | undefined; includeInactive: boolean; limit: number }
): Promise<CompositionSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.composition.findMany({
      where: {
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { code: { contains: query.q, mode: 'insensitive' as const } },
                // Searching by what is IN it, not only by what it is called.
                // "amoxicillin" should find "Co-amoxiclav 500/125".
                {
                  ingredients: {
                    some: {
                      ingredient: {
                        OR: [
                          { name: { contains: query.q, mode: 'insensitive' as const } },
                          { innName: { contains: query.q, mode: 'insensitive' as const } },
                        ],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: compositionInclude,
      orderBy: { name: 'asc' },
      take: query.limit,
    });
    return rows.map(toComposition);
  });
}

export async function getComposition(
  ctx: TenantContext,
  compositionId: string
): Promise<CompositionSummary> {
  return withTenant(ctx, async (tx) =>
    toComposition(await findCompositionOrThrow(tx, compositionId))
  );
}

export async function createComposition(
  ctx: TenantContext,
  input: CreateCompositionRequest,
  options: CatalogueActionOptions = {}
): Promise<CompositionSummary> {
  return withTenant(ctx, async (tx) => {
    const clash = await tx.composition.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A composition with this code already exists.');

    assertDistinctIngredients(input.ingredients);

    const created = await tx.composition.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        dosageForm: input.dosageForm ?? null,
        ingredients: {
          create: input.ingredients.map((ci) => ({
            /*
             * The child carries the SAME organizationId as its parent, which the
             * composite FK (organization_id, composition_id) then enforces. It
             * is set explicitly rather than left to a default because there is
             * no default that could be right: NULL would mean "platform", and
             * RLS refuses a tenant writing that.
             */
            organizationId: ctx.organizationId,
            ingredientId: ci.ingredientId,
            strength: ci.strength,
            strengthUnitId: ci.strengthUnitId,
            perQuantity: ci.perQuantity ?? null,
            displayOrder: ci.displayOrder,
          })),
        },
      },
      include: compositionInclude,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'composition',
      entityId: created.id,
      after: {
        code: created.code,
        name: created.name,
        ingredientCount: created.ingredients.length,
      },
      ...options,
    });

    return toComposition(created);
  });
}

export async function updateComposition(
  ctx: TenantContext,
  compositionId: string,
  input: UpdateCompositionRequest,
  options: CatalogueActionOptions = {}
): Promise<CompositionSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await findCompositionOrThrow(tx, compositionId);
    assertMutable(existing.organizationId, 'composition');

    if (input.isActive === false) {
      const inUse = await tx.product.count({ where: { compositionId, deletedAt: null } });
      if (inUse > 0) {
        throw new ConflictError(
          `${inUse} product(s) reference this composition. Change them before deactivating it.`
        );
      }
    }

    if (input.ingredients !== undefined) {
      assertDistinctIngredients(input.ingredients);
      /*
       * Replace wholesale rather than diff.
       *
       * ⚠️ THE SET IS THE COMPOSITION. An ingredient omitted from the request
       *   means "this is not in the medicine", which is a clinically different
       *   statement from "leave it as it was" — so a partial update would let a
       *   caller believe they had removed a substance that is still recorded.
       *   Delete-then-create inside the same transaction, so no reader ever sees
       *   a composition with half its ingredients.
       */
      await tx.compositionIngredient.deleteMany({ where: { compositionId } });
      await tx.compositionIngredient.createMany({
        data: input.ingredients.map((ci) => ({
          organizationId: ctx.organizationId,
          compositionId,
          ingredientId: ci.ingredientId,
          strength: ci.strength,
          strengthUnitId: ci.strengthUnitId,
          perQuantity: ci.perQuantity ?? null,
          displayOrder: ci.displayOrder,
        })),
      });
    }

    await tx.composition.update({
      where: { id: compositionId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.dosageForm !== undefined ? { dosageForm: input.dosageForm } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true },
    });

    const after = await findCompositionOrThrow(tx, compositionId);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'composition',
      entityId: compositionId,
      before: { name: existing.name, ingredientCount: existing.ingredients.length },
      after: { name: after.name, ingredientCount: after.ingredients.length },
      ...options,
    });

    return toComposition(after);
  });
}

/**
 * One ingredient may appear once.
 *
 * The unique index says the same thing. This runs first because the index's
 * error names a constraint, and because two rows for one substance is a
 * strength that silently disagrees with itself rather than a duplicate row.
 */
function assertDistinctIngredients(ingredients: { ingredientId: string }[]): void {
  const seen = new Set<string>();
  for (const ci of ingredients) {
    if (seen.has(ci.ingredientId)) {
      throw new ValidationError(
        'The same ingredient is listed twice. Give it one row with the total strength.'
      );
    }
    seen.add(ci.ingredientId);
  }
}

// ---------------------------------------------------------------------------
// Storage requirement profiles
// ---------------------------------------------------------------------------

export async function listStorageProfiles(
  ctx: TenantContext,
  includeInactive: boolean
): Promise<StorageProfileSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.storageRequirementProfile.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      minTemperatureC: decimalToString(s.minTemperatureC),
      maxTemperatureC: decimalToString(s.maxTemperatureC),
      minHumidityPct: s.minHumidityPct,
      maxHumidityPct: s.maxHumidityPct,
      lightSensitivity: s.lightSensitivity,
      requiresControlledAccess: s.requiresControlledAccess,
      hazardClass: s.hazardClass,
      handlingNotes: s.handlingNotes,
      isActive: s.isActive,
      isOwn: s.organizationId !== null,
    }));
  });
}

export async function createStorageProfile(
  ctx: TenantContext,
  input: CreateStorageProfileRequest,
  options: CatalogueActionOptions = {}
): Promise<StorageProfileSummary> {
  return withTenant(ctx, async (tx) => {
    const clash = await tx.storageRequirementProfile.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A storage profile with this code already exists.');

    const created = await tx.storageRequirementProfile.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        minTemperatureC: input.minTemperatureC ?? null,
        maxTemperatureC: input.maxTemperatureC ?? null,
        minHumidityPct: input.minHumidityPct ?? null,
        maxHumidityPct: input.maxHumidityPct ?? null,
        lightSensitivity: input.lightSensitivity,
        requiresControlledAccess: input.requiresControlledAccess,
        hazardClass: input.hazardClass ?? null,
        handlingNotes: input.handlingNotes ?? null,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'storage_requirement_profile',
      entityId: created.id,
      after: { code: created.code, name: created.name },
      ...options,
    });

    return {
      id: created.id,
      code: created.code,
      name: created.name,
      minTemperatureC: decimalToString(created.minTemperatureC),
      maxTemperatureC: decimalToString(created.maxTemperatureC),
      minHumidityPct: created.minHumidityPct,
      maxHumidityPct: created.maxHumidityPct,
      lightSensitivity: created.lightSensitivity,
      requiresControlledAccess: created.requiresControlledAccess,
      hazardClass: created.hazardClass,
      handlingNotes: created.handlingNotes,
      isActive: created.isActive,
      isOwn: true,
    };
  });
}
