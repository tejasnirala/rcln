/**
 * Visual maps: reading a chart's geometry out of the database, safely (CE-6).
 *
 * ⚠️ THE GEOMETRY IS THE REGION'S, NOT AN SVG FILE'S, AND THAT IS THE WHOLE
 *   REASON THIS FILE EXISTS (CD-17). A map is a set of ROWS — a code, a label
 *   and a shape in the map's own coordinate space — so `apps/web` holds ONE
 *   generic renderer and adding the scalp map in CE-7 is a seed, not a
 *   component. The alternative is one hand-drawn React component per chart,
 *   which is `HairConsultation.tsx` wearing a different name and is exactly
 *   what CE-7's definition of done forbids.
 *
 * ⚠️ AND NO CLINICAL DATA IS IN ANY OF IT (§22). A region says WHERE and WHAT
 *   IT IS CALLED. What was found there is a `clinical_findings` row, because a
 *   picture that carried its own findings could not be queried, reported on,
 *   audited or amended.
 *
 * ── THE PI-5 LESSON, IN THE ONE SHAPE IT TAKES HERE ──────────────────────────
 *
 *   ABSENT geometry is LEGAL and means "this region groups and is not drawn" —
 *   a quadrant of the odontogram is a real region with eight children and no
 *   shape of its own.
 *
 *   PRESENT and malformed is an ERROR. A `{ "shape": "rect", "w": 10 }` for
 *   `width` is one typo, and a parser that shrugged would drop one tooth off a
 *   chart with no message anywhere — the clinician sees a gap and assumes the
 *   patient has no tooth there.
 *
 *   Those two cases are different and are unit-tested separately. Covering only
 *   the first is precisely the gap that let PI-5 ship a permissive typo.
 *
 * No Prisma, no clock, no React, no country, no specialty — see the package
 * README.
 */
import type { Parsed } from './types.js';

function fail<T>(problem: string): Parsed<T> {
  return { ok: false, problem };
}

function asRecord(value: unknown, what: string): Parsed<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${what} is not an object`);
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * A map's coordinate space: `"0 0 640 320"`.
 *
 * ⚠️ ON THE MAP AND NOT ON THE REGION. One space per picture is what makes
 *   thirty-two teeth layoutable beside one another; a per-region box would be
 *   thirty-two pictures that happen to share a table.
 */
export interface ViewBox {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The shapes a region may be.
 *
 * ⚠️ A CLOSED SET, FOR THE REASON EVERY OTHER CLOSED SET IN THIS PACKAGE IS ONE.
 *   The renderer has one branch per member; a document naming `polygon` is a
 *   rejected row rather than a region that silently fails to draw.
 */
export type RegionShapeKind = 'RECT' | 'CIRCLE' | 'PATH';

export const REGION_SHAPE_KINDS: readonly RegionShapeKind[] = ['RECT', 'CIRCLE', 'PATH'];

/** A rounded rectangle. The odontogram's tooth. */
export interface RectShape {
  readonly kind: 'RECT';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Corner radius. Absent is a square corner, which is a shape and not a gap. */
  readonly radius?: number;
}

export interface CircleShape {
  readonly kind: 'CIRCLE';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/**
 * An arbitrary outline, as an SVG path.
 *
 * ⚠️ THE STRING IS NOT PARSED, AND IT IS NOT ALLOWED TO BE ANYTHING. It reaches
 *   the browser as the `d` attribute of a `<path>`, which is a geometry
 *   grammar and not a script — but it comes out of a database column a clinic
 *   can write, so the characters are restricted to the ones a path is made of.
 *   A `d` containing a quote or an angle bracket is a row that was trying to be
 *   something else.
 */
export interface PathShape {
  readonly kind: 'PATH';
  readonly d: string;
}

export type RegionShape = RectShape | CircleShape | PathShape;

/** Where a region's label sits, if the map says. Defaults to the shape's centre. */
export interface LabelAnchor {
  readonly x: number;
  readonly y: number;
}

/** A region's geometry document, parsed. */
export interface RegionGeometry {
  readonly shape: RegionShape;
  readonly label?: LabelAnchor;
}

/** One region of a map, after parsing. */
export interface MapRegion {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly displayOrder: number;
  /** `null` = a grouping region, drawn by nothing. See the header. */
  readonly geometry: RegionGeometry | null;
}

/** A whole chart, after parsing: its space and its places. */
export interface VisualMapDocument {
  readonly code: string;
  readonly viewBox: ViewBox;
  readonly regions: readonly MapRegion[];
}

/** A region and the regions grouped under it. One level, which is all any map has. */
export interface RegionGroup {
  readonly region: MapRegion;
  readonly children: readonly MapRegion[];
}

const PATH_PATTERN = /^[MmLlHhVvCcSsQqTtAaZz0-9,.\s+-]+$/;

function readNumber(source: Record<string, unknown>, key: string, where: string): Parsed<number> {
  const raw = source[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail(`${where} does not give a number for "${key}"`);
  }
  return { ok: true, value: raw };
}

function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  where: string
): Parsed<number | undefined> {
  if (source[key] === undefined) return { ok: true, value: undefined };
  const read = readNumber(source, key, where);
  return read.ok ? { ok: true, value: read.value } : fail(read.problem);
}

/**
 * `"0 0 640 320"` → four numbers.
 *
 * ⚠️ A ZERO OR NEGATIVE EXTENT IS REFUSED. An SVG with `width: 0` renders
 *   nothing at all, and "the chart is blank" is the failure mode with no error
 *   message that this package exists to make impossible. The database refuses
 *   it too — the CHECK on `visual_maps.view_box` — because a row written by a
 *   seed or an import never passes through here.
 */
export function parseViewBox(value: unknown): Parsed<ViewBox> {
  if (typeof value !== 'string') return fail('the map does not state a "viewBox"');
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 4) {
    return fail(`"${value}" is not a view box — it must be four numbers`);
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isFinite(n))) {
    return fail(`"${value}" is not a view box — every part must be a number`);
  }
  const [minX, minY, width, height] = numbers as [number, number, number, number];
  if (width <= 0 || height <= 0) {
    return fail(`"${value}" is not a view box — it has no width or no height`);
  }
  return { ok: true, value: { minX, minY, width, height } };
}

function parseShape(source: Record<string, unknown>, where: string): Parsed<RegionShape> {
  const kind = source['kind'];
  if (typeof kind !== 'string' || !REGION_SHAPE_KINDS.includes(kind as RegionShapeKind)) {
    return fail(
      `${where} does not name a shape "kind" the renderer has — expected one of ${REGION_SHAPE_KINDS.join(', ')}`
    );
  }

  if (kind === 'RECT') {
    const x = readNumber(source, 'x', where);
    if (!x.ok) return fail(x.problem);
    const y = readNumber(source, 'y', where);
    if (!y.ok) return fail(y.problem);
    const width = readNumber(source, 'width', where);
    if (!width.ok) return fail(width.problem);
    const height = readNumber(source, 'height', where);
    if (!height.ok) return fail(height.problem);
    if (width.value <= 0 || height.value <= 0) {
      return fail(`${where} is a rectangle with no width or no height`);
    }
    const radius = readOptionalNumber(source, 'radius', where);
    if (!radius.ok) return fail(radius.problem);
    return {
      ok: true,
      value: {
        kind: 'RECT',
        x: x.value,
        y: y.value,
        width: width.value,
        height: height.value,
        ...(radius.value !== undefined ? { radius: radius.value } : {}),
      },
    };
  }

  if (kind === 'CIRCLE') {
    const cx = readNumber(source, 'cx', where);
    if (!cx.ok) return fail(cx.problem);
    const cy = readNumber(source, 'cy', where);
    if (!cy.ok) return fail(cy.problem);
    const r = readNumber(source, 'r', where);
    if (!r.ok) return fail(r.problem);
    if (r.value <= 0) return fail(`${where} is a circle with no radius`);
    return { ok: true, value: { kind: 'CIRCLE', cx: cx.value, cy: cy.value, r: r.value } };
  }

  const d = source['d'];
  if (typeof d !== 'string' || d.trim() === '') {
    return fail(`${where} is a path and does not give a "d"`);
  }
  if (!PATH_PATTERN.test(d)) {
    return fail(`${where} has a "d" containing something that is not path geometry`);
  }
  return { ok: true, value: { kind: 'PATH', d: d.trim() } };
}

/**
 * A region's `metadata`, as geometry.
 *
 * ⚠️ ABSENT IS LEGAL AND MALFORMED IS NOT. See the header — a quadrant has no
 *   shape and that is a statement; `{ "shape": {} }` is a typo, and both cases
 *   are tested.
 */
export function parseRegionGeometry(
  metadata: unknown,
  where: string
): Parsed<RegionGeometry | null> {
  if (metadata === undefined || metadata === null) return { ok: true, value: null };

  const document = asRecord(metadata, `${where}'s geometry`);
  if (!document.ok) return fail(document.problem);

  /*
   * ⚠️ AN EMPTY DOCUMENT IS REFUSED RATHER THAN READ AS "no geometry". `{}` is
   *   what a half-written import produces, and treating it as a grouping region
   *   means a tooth quietly missing from a chart that looks deliberate. A region
   *   that groups carries NO metadata at all, which is a different thing from a
   *   document that says nothing.
   */
  if (Object.keys(document.value).length === 0) {
    return fail(
      `${where} has an empty geometry document. A region that is not drawn carries no metadata at all.`
    );
  }

  const rawShape = document.value['shape'];
  if (rawShape === undefined) {
    return fail(`${where} has geometry that names no "shape"`);
  }
  const shapeRecord = asRecord(rawShape, `${where}'s shape`);
  if (!shapeRecord.ok) return fail(shapeRecord.problem);
  const shape = parseShape(shapeRecord.value, `${where}'s shape`);
  if (!shape.ok) return fail(shape.problem);

  const geometry: { shape: RegionShape; label?: LabelAnchor } = { shape: shape.value };

  const rawLabel = document.value['label'];
  if (rawLabel !== undefined) {
    const labelRecord = asRecord(rawLabel, `${where}'s label anchor`);
    if (!labelRecord.ok) return fail(labelRecord.problem);
    const x = readNumber(labelRecord.value, 'x', `${where}'s label anchor`);
    if (!x.ok) return fail(x.problem);
    const y = readNumber(labelRecord.value, 'y', `${where}'s label anchor`);
    if (!y.ok) return fail(y.problem);
    geometry.label = { x: x.value, y: y.value };
  }

  /*
   * ⚠️ AN UNKNOWN KEY IS REFUSED, exactly as it is on a field descriptor. A
   *   parser that ignores `labelPos` cannot tell a typo from an extension, and
   *   the author is left believing they positioned a label.
   */
  const allowed = new Set(['shape', 'label']);
  const unknown = Object.keys(document.value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return fail(`${where} has geometry with unknown key(s): ${unknown.join(', ')}`);
  }

  return { ok: true, value: geometry };
}

/** One region as the database hands it over, before parsing. */
export interface StoredRegion {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly displayOrder: number;
  readonly metadata: unknown;
}

/**
 * A whole map, parsed and checked as one thing.
 *
 * ⚠️ THE CHECKS BETWEEN REGIONS ARE WHY THIS IS NOT JUST `map` OVER
 *   `parseRegionGeometry`. A duplicate code makes findings ambiguous, a parent
 *   outside the map makes the grouping walk leave the picture, and a cycle
 *   makes it not terminate. The database refuses the second (a trigger) and the
 *   first (a unique index); this refuses all three, because a fixture and a
 *   future import both reach the screen through here.
 */
export function parseVisualMap(input: {
  code: string;
  viewBox: unknown;
  regions: readonly StoredRegion[];
}): Parsed<VisualMapDocument> {
  const viewBox = parseViewBox(input.viewBox);
  if (!viewBox.ok) return fail(`Map ${input.code}: ${viewBox.problem}`);

  const byId = new Map<string, StoredRegion>();
  const seenCodes = new Set<string>();
  for (const region of input.regions) {
    if (seenCodes.has(region.code)) {
      return fail(`Map ${input.code} has two regions coded "${region.code}"`);
    }
    seenCodes.add(region.code);
    byId.set(region.id, region);
  }

  const parsed: MapRegion[] = [];
  for (const region of input.regions) {
    const where = `Map ${input.code}, region ${region.code}`;
    const geometry = parseRegionGeometry(region.metadata, where);
    if (!geometry.ok) return fail(geometry.problem);

    if (region.parentId !== null && !byId.has(region.parentId)) {
      return fail(`${where} is grouped under a region that is not on this map`);
    }

    /* A walk up from every node: cheap on maps this size, and the only thing
       that catches a cycle the database's per-row trigger cannot see. */
    let cursor: string | null = region.parentId;
    let steps = 0;
    while (cursor !== null) {
      if (cursor === region.id) return fail(`${where} is grouped under itself`);
      if (++steps > byId.size) return fail(`Map ${input.code} has a cycle in its grouping`);
      cursor = byId.get(cursor)?.parentId ?? null;
    }

    parsed.push({
      id: region.id,
      code: region.code,
      label: region.label,
      parentId: region.parentId,
      displayOrder: region.displayOrder,
      geometry: geometry.value,
    });
  }

  return {
    ok: true,
    value: { code: input.code, viewBox: viewBox.value, regions: ordered(parsed) },
  };
}

/**
 * ⚠️ THE ORDER IS TOTAL: `displayOrder`, then `code`. Two regions sharing an
 *   order would otherwise render in whatever order Postgres returned, which is
 *   stable until an unrelated row is updated — and a chart whose teeth swap
 *   places between two reads is one a clinician stops trusting. Same rule
 *   `visibleSections` states for the template.
 */
function ordered(regions: readonly MapRegion[]): readonly MapRegion[] {
  return regions
    .slice()
    .sort((a, b) =>
      a.displayOrder === b.displayOrder
        ? a.code.localeCompare(b.code)
        : a.displayOrder - b.displayOrder
    );
}

/**
 * The regions that are actually drawn.
 *
 * ⚠️ A GROUPING REGION IS NOT ONE OF THEM. Drawing a quadrant would put a
 *   rectangle over the eight teeth inside it and swallow every click meant for
 *   a tooth — which is the whole reason `geometry` is nullable rather than a
 *   flag beside it.
 */
export function drawableRegions(map: VisualMapDocument): readonly MapRegion[] {
  return map.regions.filter((region) => region.geometry !== null);
}

/**
 * The map as groups: each grouping region, and what is under it.
 *
 * ⚠️ REGIONS WITH NO GROUP COME BACK IN A GROUP OF THEIR OWN RATHER THAN BEING
 *   DROPPED. A map may be entirely flat — a scalp with four zones and no
 *   quadrants — and a caller that iterated groups would render nothing at all.
 */
export function regionGroups(map: VisualMapDocument): readonly RegionGroup[] {
  const children = new Map<string, MapRegion[]>();
  for (const region of map.regions) {
    if (region.parentId === null) continue;
    const list = children.get(region.parentId) ?? [];
    list.push(region);
    children.set(region.parentId, list);
  }

  return map.regions
    .filter((region) => region.parentId === null)
    .map((region) => ({ region, children: ordered(children.get(region.id) ?? []) }));
}

/**
 * Where a region's label goes: what the map said, or the shape's centre.
 *
 * ⚠️ COMPUTED HERE RATHER THAN IN THE RENDERER, so the answer is the same for
 *   an SVG, a legend and a print sheet. A path has no computable centre without
 *   parsing it, so one that wants a label says where.
 */
export function labelAnchorOf(region: MapRegion): LabelAnchor | null {
  const geometry = region.geometry;
  if (geometry === null) return null;
  if (geometry.label !== undefined) return geometry.label;

  const shape = geometry.shape;
  if (shape.kind === 'RECT') {
    return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  }
  if (shape.kind === 'CIRCLE') return { x: shape.cx, y: shape.cy };
  return null;
}
