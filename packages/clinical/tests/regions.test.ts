/**
 * The geometry grammar (CE-6).
 *
 * ⚠️ THE TWO CASES THAT MATTER ARE BOTH HERE, AND COVERING ONLY THE FIRST IS THE
 *   GAP THAT LET PI-5 SHIP A PERMISSIVE TYPO:
 *
 *     ABSENT geometry     legal — the region groups and is not drawn
 *     PRESENT but empty   REFUSED — `{}` is what a half-written import produces
 *
 *   A parser that read `{}` as "no geometry" would drop a tooth off a chart with
 *   no message anywhere, and the clinician reads the gap as a tooth the patient
 *   does not have.
 */
import {
  drawableRegions,
  labelAnchorOf,
  parseRegionGeometry,
  parseViewBox,
  parseVisualMap,
  regionGroups,
  type StoredRegion,
} from '../src/index.js';

const rect = (x: number, y: number): Record<string, unknown> => ({
  shape: { kind: 'RECT', x, y, width: 30, height: 40 },
});

const region = (over: Partial<StoredRegion> & { code: string }): StoredRegion => ({
  id: over.id ?? over.code,
  code: over.code,
  label: over.label ?? over.code,
  parentId: over.parentId ?? null,
  displayOrder: over.displayOrder ?? 0,
  metadata: over.metadata ?? null,
});

describe('parseViewBox', () => {
  it('reads four numbers', () => {
    const result = parseViewBox('0 0 640 320');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ minX: 0, minY: 0, width: 640, height: 320 });
  });

  it('accepts a negative origin, which is legal SVG', () => {
    const result = parseViewBox('-10 -5 100 50');
    expect(result.ok).toBe(true);
  });

  it('refuses three numbers', () => {
    const result = parseViewBox('0 0 640');
    expect(result.ok).toBe(false);
  });

  it('refuses a box with no width — an SVG that renders nothing at all', () => {
    const result = parseViewBox('0 0 0 320');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/no width/);
  });

  it('refuses something that is not a string', () => {
    expect(parseViewBox(undefined).ok).toBe(false);
    expect(parseViewBox(640).ok).toBe(false);
  });
});

describe('parseRegionGeometry', () => {
  it('reads an ABSENT document as a region that groups and is not drawn', () => {
    const absent = parseRegionGeometry(undefined, 'Region Q1');
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value).toBeNull();

    const sqlNull = parseRegionGeometry(null, 'Region Q1');
    expect(sqlNull.ok).toBe(true);
    if (sqlNull.ok) expect(sqlNull.value).toBeNull();
  });

  /** ⚠️ The other half of the pair. See the file header. */
  it('REFUSES a document that exists and is empty', () => {
    const result = parseRegionGeometry({}, 'Region TOOTH_36');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/empty geometry/);
  });

  it('refuses geometry that names no shape', () => {
    const result = parseRegionGeometry({ label: { x: 1, y: 2 } }, 'Region TOOTH_36');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/no "shape"/);
  });

  it('reads a rectangle', () => {
    const result = parseRegionGeometry(rect(8, 40), 'Region TOOTH_18');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value?.shape).toEqual({
        kind: 'RECT',
        x: 8,
        y: 40,
        width: 30,
        height: 40,
      });
  });

  /** ⚠️ The typo this package exists for: `w` for `width`. */
  it('refuses a rectangle whose width is misspelled', () => {
    const result = parseRegionGeometry(
      { shape: { kind: 'RECT', x: 8, y: 40, w: 30, height: 40 } },
      'Region TOOTH_18'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/"width"/);
  });

  it('refuses a rectangle with no height', () => {
    const result = parseRegionGeometry(
      { shape: { kind: 'RECT', x: 0, y: 0, width: 10, height: 0 } },
      'Region R'
    );
    expect(result.ok).toBe(false);
  });

  it('reads a circle and refuses one with no radius', () => {
    expect(parseRegionGeometry({ shape: { kind: 'CIRCLE', cx: 5, cy: 5, r: 3 } }, 'R').ok).toBe(
      true
    );
    expect(parseRegionGeometry({ shape: { kind: 'CIRCLE', cx: 5, cy: 5, r: 0 } }, 'R').ok).toBe(
      false
    );
  });

  it('reads a path and refuses one carrying something that is not geometry', () => {
    expect(parseRegionGeometry({ shape: { kind: 'PATH', d: 'M0 0 L10 10 Z' } }, 'R').ok).toBe(true);
    const injected = parseRegionGeometry(
      { shape: { kind: 'PATH', d: 'M0 0" onload="alert(1)' } },
      'R'
    );
    expect(injected.ok).toBe(false);
  });

  it('refuses a shape kind the renderer has no branch for', () => {
    const result = parseRegionGeometry({ shape: { kind: 'POLYGON', points: '1,2' } }, 'R');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/RECT, CIRCLE, PATH/);
  });

  /** ⚠️ An unknown key is a typo the author believes worked. */
  it('refuses an unknown key rather than ignoring it', () => {
    const result = parseRegionGeometry({ ...rect(0, 0), labelPos: { x: 1, y: 1 } }, 'R');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/labelPos/);
  });

  it('reads a label anchor', () => {
    const result = parseRegionGeometry({ ...rect(0, 0), label: { x: 3, y: 4 } }, 'R');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.label).toEqual({ x: 3, y: 4 });
  });
});

describe('parseVisualMap', () => {
  it('parses a small map and orders its regions totally', () => {
    const result = parseVisualMap({
      code: 'TEST',
      viewBox: '0 0 100 100',
      regions: [
        region({ code: 'B', displayOrder: 10, metadata: rect(0, 0) }),
        region({ code: 'A', displayOrder: 10, metadata: rect(40, 0) }),
        region({ code: 'C', displayOrder: 0, metadata: rect(80, 0) }),
      ],
    });
    expect(result.ok).toBe(true);
    /* displayOrder, then code — so two rows sharing an order never swap. */
    if (result.ok) expect(result.value.regions.map((r) => r.code)).toEqual(['C', 'A', 'B']);
  });

  it('refuses two regions with the same code', () => {
    const result = parseVisualMap({
      code: 'TEST',
      viewBox: '0 0 100 100',
      regions: [region({ code: 'A', id: 'one' }), region({ code: 'A', id: 'two' })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/two regions coded/);
  });

  it('refuses a parent that is not on this map', () => {
    const result = parseVisualMap({
      code: 'TEST',
      viewBox: '0 0 100 100',
      regions: [region({ code: 'A', parentId: 'somewhere-else' })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not on this map/);
  });

  it('refuses a cycle in the grouping', () => {
    const result = parseVisualMap({
      code: 'TEST',
      viewBox: '0 0 100 100',
      regions: [
        region({ code: 'A', id: 'a', parentId: 'b' }),
        region({ code: 'B', id: 'b', parentId: 'a' }),
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a region grouped under itself', () => {
    const result = parseVisualMap({
      code: 'TEST',
      viewBox: '0 0 100 100',
      regions: [region({ code: 'A', id: 'a', parentId: 'a' })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/under itself/);
  });

  it('names the region in the problem when its geometry is wrong', () => {
    const result = parseVisualMap({
      code: 'HUMAN_DENTAL',
      viewBox: '0 0 100 100',
      regions: [region({ code: 'TOOTH_36', metadata: { shape: { kind: 'RECT' } } })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/TOOTH_36/);
  });
});

describe('reading a parsed map', () => {
  const parsed = parseVisualMap({
    code: 'TEST',
    viewBox: '0 0 200 100',
    regions: [
      region({ code: 'Q1', id: 'q1', displayOrder: 0 }),
      region({ code: 'A', id: 'a', parentId: 'q1', displayOrder: 10, metadata: rect(0, 0) }),
      region({ code: 'B', id: 'b', parentId: 'q1', displayOrder: 20, metadata: rect(40, 0) }),
      region({ code: 'LOOSE', id: 'loose', displayOrder: 30, metadata: rect(80, 0) }),
    ],
  });
  if (!parsed.ok) throw new Error(parsed.problem);
  const map = parsed.value;

  /** ⚠️ A quadrant drawn over its teeth would swallow every click meant for one. */
  it('draws only the regions that have geometry', () => {
    expect(drawableRegions(map).map((r) => r.code)).toEqual(['A', 'B', 'LOOSE']);
  });

  it('groups the children under their parent and keeps ungrouped regions', () => {
    const groups = regionGroups(map);
    expect(groups.map((g) => g.region.code)).toEqual(['Q1', 'LOOSE']);
    expect(groups[0]?.children.map((c) => c.code)).toEqual(['A', 'B']);
    /* A flat map is not an empty one: LOOSE comes back as its own group. */
    expect(groups[1]?.children).toHaveLength(0);
  });

  it('anchors a label at the shape centre unless the map says otherwise', () => {
    const a = map.regions.find((r) => r.code === 'A');
    expect(a && labelAnchorOf(a)).toEqual({ x: 15, y: 20 });
    const q1 = map.regions.find((r) => r.code === 'Q1');
    expect(q1 && labelAnchorOf(q1)).toBeNull();
  });
});
