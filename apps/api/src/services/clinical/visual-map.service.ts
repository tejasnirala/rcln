/**
 * The charts a consultation draws on (CE-6): what a map IS, and where its
 * places are.
 *
 * ⚠️ NO PHI IN THIS FILE. A map is a picture of a body — the 32 teeth of the FDI
 *   notation are the same 32 teeth in every dental practice on the platform. It
 *   names no patient, nothing here joins to `patients`, and nothing here is
 *   read-audited. What was FOUND on a chart is `clinical_findings`, which lives
 *   in `encounter-content.service.ts` beside the diagnoses, because that is what
 *   it is.
 *
 * ── THE TWO RULES THAT MATTER ────────────────────────────────────────────────
 *
 *   1. NOTHING READS A RAW `metadata`. Every path in and out goes through
 *      `parseRegionGeometry` / `parseVisualMap` from `@rcln/clinical`, which
 *      refuses a document that says nothing checkable (CD-10, CD-17). The moment
 *      one caller reaches into the JSONB directly, a `w` for `width` becomes a
 *      tooth silently missing from a chart — and the clinician reads the gap as
 *      a tooth the patient does not have.
 *
 *   2. THE WRITE PATH CANNOT TOUCH A PLATFORM MAP, AND THAT IS ENFORCED THREE
 *      TIMES — `tenant_isolation`'s WITH CHECK, the `platform_rows_immutable`
 *      trigger, and `assertMutable` below, which runs first only so the caller
 *      gets a sentence rather than a constraint name. Same shape as
 *      `template.service.ts` and `master.service.ts`.
 *
 * ⚠️ A MAP IS DEACTIVATED, NEVER DELETED. `clinical_findings.visual_region_id`
 *   and `encounter_procedures.visual_region_id` are `onDelete: Restrict`, so a
 *   region a finalized record cites cannot go — which is the correct outcome,
 *   because the record would otherwise stop being able to say where.
 */
/* `Prisma` as a VALUE, for `DbNull` — clearing a JSONB column is a SQL NULL and
   Prisma makes you say which kind of null you mean. See `setting.service.ts`. */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
/*
 * ⚠️ ONLY `parseRegionGeometry`. There is deliberately no server-side
 *   `parseVisualMap` of a STORED chart: a map whose geometry has gone wrong must
 *   not make a whole consultation unopenable with a patient in the chair. The
 *   browser parses what it is handed and says which region is broken; the write
 *   path below refuses a malformed document at the door, which is where it can
 *   be fixed.
 */
import { parseRegionGeometry } from '@rcln/clinical';
import type {
  CreateVisualMapRequest,
  CreateVisualRegionRequest,
  UpdateVisualMapRequest,
  UpdateVisualRegionRequest,
  VisualMap,
  VisualMapDetail,
  VisualMapListResponse,
  VisualMapQuery,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

export interface VisualMapActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

const MAP_SELECT = {
  id: true,
  organizationId: true,
  code: true,
  name: true,
  description: true,
  renderer: true,
  assetKey: true,
  careContextId: true,
  specialtyId: true,
  viewBox: true,
  isActive: true,
  careContext: { select: { name: true } },
  specialty: { select: { name: true } },
  /*
   * ⚠️ NO `_count: { regions: true }` HERE, AND THE REASON IS THE CE-2 TRAP.
   *   `visual_regions.map` is a COMPOSITE relation on `(organization_id,
   *   map_id)`, and on a PLATFORM row both sides are NULL — so the join Prisma
   *   writes for a relation count is `NULL = NULL`, which is never true. The
   *   count came back 0 for the odontogram every clinic can plainly see.
   *   Counted by `map_id` alone below, which is what the detail read already
   *   does. Same lesson `master.service.ts` records about its codings.
   */
} satisfies Prisma.VisualMapSelect;

const REGION_SELECT = {
  id: true,
  code: true,
  label: true,
  parentId: true,
  displayOrder: true,
  metadata: true,
} satisfies Prisma.VisualRegionSelect;

type MapRow = Prisma.VisualMapGetPayload<{ select: typeof MAP_SELECT }>;
type RegionRow = Prisma.VisualRegionGetPayload<{ select: typeof REGION_SELECT }>;

/**
 * ⚠️ THE ORDER IS TOTAL: `display_order`, then `code`. Two regions sharing an
 *   order would otherwise come back in whatever order Postgres happened to
 *   return — stable until an unrelated row is updated, and a chart whose teeth
 *   swap places between two reads is one a clinician stops trusting.
 *
 * Not `as const`: Prisma's `orderBy` takes a mutable array.
 */
const byOrder = (): ({ displayOrder: 'asc' } | { code: 'asc' })[] => [
  { displayOrder: 'asc' },
  { code: 'asc' },
];

function assertMutable(row: { organizationId: string | null }): void {
  if (row.organizationId === null) {
    throw new ValidationError(
      'This is a platform-wide chart and cannot be modified. Create your own for the same care context instead — yours will take precedence.'
    );
  }
}

function toMap(row: MapRow, regionCount: number): VisualMap {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    renderer: row.renderer,
    assetKey: row.assetKey,
    careContextId: row.careContextId,
    careContextName: row.careContext.name,
    specialtyId: row.specialtyId,
    specialtyName: row.specialty?.name ?? null,
    viewBox: row.viewBox,
    isActive: row.isActive,
    isOwn: row.organizationId !== null,
    regionCount,
  };
}

function toDetail(row: MapRow, regions: readonly RegionRow[]): VisualMapDetail {
  return {
    ...toMap(row, regions.length),
    regions: regions.map((region) => ({
      id: region.id,
      code: region.code,
      label: region.label,
      parentId: region.parentId,
      displayOrder: region.displayOrder,
      /* ⚠️ Prisma's `JsonValue` includes `null` for SQL NULL; the wire says
         `null` for "this region groups and is not drawn". Same thing. */
      metadata: region.metadata ?? null,
    })),
  };
}

async function loadMap(tx: TxClient, mapId: string): Promise<MapRow> {
  const row = await tx.visualMap.findFirst({
    where: { id: mapId, deletedAt: null },
    select: MAP_SELECT,
  });
  /*
   * ⚠️ 404, NEVER 403, for a map belonging to another tenant. RLS has already
   *   filtered it out of the read, so it is genuinely indistinguishable from one
   *   that does not exist — and a 403 would confirm the id is real to somebody
   *   probing for it.
   */
  if (!row) throw new NotFoundError('Chart');
  return row;
}

async function regionsOf(tx: TxClient, mapId: string): Promise<RegionRow[]> {
  return tx.visualRegion.findMany({
    where: { mapId },
    select: REGION_SELECT,
    orderBy: byOrder(),
  });
}

async function detail(tx: TxClient, mapId: string): Promise<VisualMapDetail> {
  const row = await loadMap(tx, mapId);
  return toDetail(row, await regionsOf(tx, mapId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listVisualMaps(
  ctx: TenantContext,
  query: VisualMapQuery
): Promise<VisualMapListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.VisualMapWhereInput = {
      deletedAt: null,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.careContextId !== undefined ? { careContextId: query.careContextId } : {}),
      ...(query.specialtyId !== undefined ? { specialtyId: query.specialtyId } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.visualMap.findMany({
        where,
        select: MAP_SELECT,
        /* Own maps first, then the platform's: a clinic that has configured its
           own chart is looking for that one. Then by name, so the order is
           total. */
        orderBy: [{ organizationId: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.visualMap.count({ where }),
    ]);

    /* Counted by `map_id` alone — see the note on MAP_SELECT. */
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const grouped = await tx.visualRegion.groupBy({
        by: ['mapId'],
        where: { mapId: { in: rows.map((row) => row.id) } },
        _count: { _all: true },
      });
      for (const group of grouped) counts.set(group.mapId, group._count._all);
    }

    return {
      items: rows.map((row) => toMap(row, counts.get(row.id) ?? 0)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  });
}

export async function getVisualMap(ctx: TenantContext, mapId: string): Promise<VisualMapDetail> {
  return withTenant(ctx, (tx) => detail(tx, mapId));
}

/**
 * The charts a template's `mapCode`s name, resolved to rows.
 *
 * ⚠️ CODES IN, ROWS OUT, AND THAT IS CD-6. A definition never carries an id: a
 *   template exported from one clinic and imported into another would otherwise
 *   arrive holding ids that belong to somebody else. The resolution happens
 *   HERE, against rows the database can actually constrain — exactly as
 *   `sectionConfigs` resolves scope codes to taxonomy ids.
 *
 * ⚠️ A CODE THAT MATCHES NOTHING IS ABSENT FROM THE MAP RATHER THAN AN ERROR.
 *   A template citing a chart the clinic later deactivated must still open — the
 *   section says so on screen. Refusing here would make a whole consultation
 *   unopenable because of a configuration mistake somebody else made, with a
 *   patient in the chair. Finalization is where a REQUIRED chart with nothing
 *   drawn on it is refused, and that is the right place for it.
 *
 * ⚠️ AND THE CLINIC'S OWN MAP WINS OVER THE PLATFORM'S OF THE SAME CODE. Both
 *   are visible under `tenant_isolation`, so without a rule the answer would be
 *   whichever row Postgres returned first.
 */
export async function mapsForCodes(
  tx: TxClient,
  codes: readonly string[]
): Promise<Map<string, VisualMapDetail>> {
  const resolved = new Map<string, VisualMapDetail>();
  if (codes.length === 0) return resolved;

  const rows = await tx.visualMap.findMany({
    where: { code: { in: [...new Set(codes)] }, isActive: true, deletedAt: null },
    select: MAP_SELECT,
    /* Own first: `Map.set` below keeps the LAST write, so the platform row is
       written first and the clinic's own overwrites it. */
    orderBy: [{ organizationId: 'asc' }],
  });
  if (rows.length === 0) return resolved;

  const regions = await tx.visualRegion.findMany({
    where: { mapId: { in: rows.map((row) => row.id) } },
    select: { ...REGION_SELECT, mapId: true },
    orderBy: byOrder(),
  });

  const byMap = new Map<string, RegionRow[]>();
  for (const region of regions) {
    const list = byMap.get(region.mapId) ?? [];
    list.push(region);
    byMap.set(region.mapId, list);
  }

  for (const row of rows) resolved.set(row.code, toDetail(row, byMap.get(row.id) ?? []));
  return resolved;
}

// ---------------------------------------------------------------------------
// Writes — `clinical.visual_map.manage`
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE `renderer`/`assetKey` PAIR IS CHECKED HERE AND BY A CHECK CONSTRAINT,
 *   and the constraint is the guarantee. This exists so the person configuring
 *   a chart is told what is wrong rather than shown a constraint name.
 */
function assertAssetMatchesRenderer(renderer: string, assetKey: string | null): void {
  if (renderer === 'IMAGE_MAP' && assetKey === null) {
    throw new ValidationError('An image map is drawn over an image. Name its asset.');
  }
  if (renderer === 'SVG' && assetKey !== null) {
    throw new ValidationError(
      'An SVG chart draws its own regions and is not drawn over an image. Remove the asset, or make this an image map.'
    );
  }
}

export async function createVisualMap(
  ctx: TenantContext,
  input: CreateVisualMapRequest,
  options: VisualMapActionOptions = {}
): Promise<VisualMapDetail> {
  return withTenant(ctx, async (tx) => {
    const renderer = input.renderer ?? 'SVG';
    const assetKey = input.assetKey ?? null;
    assertAssetMatchesRenderer(renderer, assetKey);

    const clash = await tx.visualMap.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code },
      select: { id: true },
    });
    if (clash !== null) {
      throw new ConflictError(`You already have a chart coded ${input.code}.`);
    }

    const created = await tx.visualMap.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        ...(input.description != null ? { description: input.description } : {}),
        renderer,
        ...(assetKey !== null ? { assetKey } : {}),
        careContextId: input.careContextId,
        ...(input.specialtyId != null ? { specialtyId: input.specialtyId } : {}),
        viewBox: input.viewBox,
      },
      select: { id: true, code: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'visual_map',
      entityId: created.id,
      after: { id: created.id, code: created.code },
      ...options,
    });

    return detail(tx, created.id);
  });
}

export async function updateVisualMap(
  ctx: TenantContext,
  mapId: string,
  input: UpdateVisualMapRequest,
  options: VisualMapActionOptions = {}
): Promise<VisualMapDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadMap(tx, mapId);
    assertMutable(existing);

    await tx.visualMap.update({
      where: { id: mapId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.specialtyId !== undefined ? { specialtyId: input.specialtyId ?? null } : {}),
        ...(input.viewBox !== undefined ? { viewBox: input.viewBox } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'visual_map',
      entityId: mapId,
      after: { id: mapId, code: existing.code },
      ...options,
    });

    return detail(tx, mapId);
  });
}

/**
 * ⚠️ GEOMETRY IS PARSED BEFORE IT IS STORED, AND A MALFORMED DOCUMENT IS
 *   REFUSED AT THE DOOR. The alternative is a row that writes fine, reads fine
 *   and throws when a clinician opens the consultation — which is the one place
 *   it must not.
 */
function checkedGeometry(metadata: unknown, code: string): Prisma.InputJsonValue | null {
  if (metadata === undefined || metadata === null) return null;
  const parsed = parseRegionGeometry(metadata, `Region ${code}`);
  if (!parsed.ok) throw new ValidationError(parsed.problem);
  return metadata as Prisma.InputJsonValue;
}

export async function addVisualRegion(
  ctx: TenantContext,
  mapId: string,
  input: CreateVisualRegionRequest,
  options: VisualMapActionOptions = {}
): Promise<VisualMapDetail> {
  return withTenant(ctx, async (tx) => {
    const map = await loadMap(tx, mapId);
    assertMutable(map);

    const clash = await tx.visualRegion.findFirst({
      where: { mapId, code: input.code },
      select: { id: true },
    });
    if (clash !== null) {
      throw new ConflictError(`This chart already has a region coded ${input.code}.`);
    }

    if (input.parentId != null) {
      /*
       * ⚠️ CHECKED HERE AS WELL AS BY THE TRIGGER, for the reason every other
       *   pre-check in this codebase exists: the trigger is the guarantee and
       *   this is the sentence. Grouping a scalp zone under a dental quadrant
       *   would otherwise come back as a raw check_violation.
       */
      const parent = await tx.visualRegion.findFirst({
        where: { id: input.parentId, mapId },
        select: { id: true },
      });
      if (parent === null) {
        throw new ValidationError('A region is grouped under a region of the same chart.');
      }
    }

    const displayOrder =
      input.displayOrder ?? (await tx.visualRegion.count({ where: { mapId } })) * 10;

    const geometry = checkedGeometry(input.metadata, input.code);

    const created = await tx.visualRegion.create({
      data: {
        organizationId: ctx.organizationId,
        mapId,
        code: input.code,
        label: input.label,
        ...(input.parentId != null ? { parentId: input.parentId } : {}),
        displayOrder,
        ...(geometry !== null ? { metadata: geometry } : {}),
      },
      select: { id: true, code: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'visual_region',
      entityId: created.id,
      after: { id: created.id, mapId, code: created.code },
      ...options,
    });

    return detail(tx, mapId);
  });
}

export async function updateVisualRegion(
  ctx: TenantContext,
  mapId: string,
  regionId: string,
  input: UpdateVisualRegionRequest,
  options: VisualMapActionOptions = {}
): Promise<VisualMapDetail> {
  return withTenant(ctx, async (tx) => {
    const map = await loadMap(tx, mapId);
    assertMutable(map);

    const existing = await tx.visualRegion.findFirst({
      where: { id: regionId, mapId },
      select: { id: true, code: true },
    });
    if (!existing) throw new NotFoundError('Region');

    if (input.parentId != null) {
      if (input.parentId === regionId) {
        throw new ValidationError('A region cannot be grouped under itself.');
      }
      const parent = await tx.visualRegion.findFirst({
        where: { id: input.parentId, mapId },
        select: { id: true },
      });
      if (parent === null) {
        throw new ValidationError('A region is grouped under a region of the same chart.');
      }
    }

    await tx.visualRegion.update({
      where: { id: regionId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId ?? null } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.metadata !== undefined
          ? {
              metadata: checkedGeometry(input.metadata, existing.code) ?? Prisma.DbNull,
            }
          : {}),
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'visual_region',
      entityId: regionId,
      after: { id: regionId, mapId, code: existing.code },
      ...options,
    });

    return detail(tx, mapId);
  });
}

/**
 * ⚠️ A HARD DELETE, AND THE FOREIGN KEYS ARE WHAT MAKE IT SAFE. A region cited
 *   by a finding or a procedure is `onDelete: Restrict`, so removing one that a
 *   record depends on fails rather than orphaning it — and the sentence below is
 *   what turns that into something a clinic can act on. A region that has never
 *   been used is genuinely a configuration mistake and deleting it is right.
 */
export async function removeVisualRegion(
  ctx: TenantContext,
  mapId: string,
  regionId: string,
  options: VisualMapActionOptions = {}
): Promise<VisualMapDetail> {
  return withTenant(ctx, async (tx) => {
    const map = await loadMap(tx, mapId);
    assertMutable(map);

    const existing = await tx.visualRegion.findFirst({
      where: { id: regionId, mapId },
      select: { id: true, code: true },
    });
    if (!existing) throw new NotFoundError('Region');

    const children = await tx.visualRegion.count({ where: { parentId: regionId } });
    if (children > 0) {
      throw new ConflictError(
        'This region groups others. Move them out of it first — deleting it would silently promote every one of them.'
      );
    }

    const [findings, procedures] = await Promise.all([
      tx.clinicalFinding.count({ where: { visualRegionId: regionId } }),
      tx.encounterProcedure.count({ where: { visualRegionId: regionId } }),
    ]);
    if (findings > 0 || procedures > 0) {
      throw new ConflictError(
        'Consultations already refer to this region, so it cannot be removed. Rename it if it is wrong; the records that cite it stay readable either way.'
      );
    }

    await tx.visualRegion.delete({ where: { id: regionId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'visual_region',
      entityId: regionId,
      before: { id: regionId, mapId, code: existing.code },
      ...options,
    });

    return detail(tx, mapId);
  });
}
