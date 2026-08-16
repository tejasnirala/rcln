/**
 * DATA ONLY — the platform's visual maps. `seedVisualMaps` writes them.
 *
 * ⚠️ ONE MAP, AND IT IS THE 32-TOOTH ADULT ODONTOGRAM (CD-11). §41 keeps the
 *   seeded data deliberately small: this is enough to prove the engine draws a
 *   real chart, and the scalp and body maps are CE-7's, where they prove it
 *   draws a SECOND one without a line of new component code.
 *
 * ⚠️ THE REGION CODES ARE FDI TWO-DIGIT NOTATION — `TOOTH_11` … `TOOTH_48`, and
 *   NEVER an index. Universal and Palmer are RENDERINGS of the same stored
 *   codes; an index would have made that impossible, and a clinic that later
 *   switches display notation would have had to rewrite every record.
 *
 * ⚠️ AND THE GEOMETRY IS DATA, NOT A DRAWING (CD-17). The shapes below are in
 *   the map's own `view_box` coordinates and are parsed by `@rcln/clinical`
 *   before anything renders them. That is what makes one generic renderer in
 *   `apps/web` enough, and it is why adding the scalp map in CE-7 is a seed
 *   rather than a `HairConsultation.tsx`.
 *
 * ⚠️ NO CLINICAL DATA HERE (§22). A region says where a tooth is and what it is
 *   called. What is wrong with it is a `clinical_findings` row.
 *
 * ── THE LAYOUT, WRITTEN OUT ONCE ─────────────────────────────────────────────
 *
 *   The chart a dentist reads: the upper arch across the top, the lower arch
 *   across the bottom, each running from the patient's RIGHT to their LEFT —
 *   which is left to right on the page, because the chart is drawn as the
 *   clinician faces the patient.
 *
 *     18 17 16 15 14 13 12 11 │ 21 22 23 24 25 26 27 28
 *     48 47 46 45 44 43 42 41 │ 31 32 33 34 35 36 37 38
 *
 *   The four quadrants are REGIONS WITH NO GEOMETRY. They group and are not
 *   drawn — a rectangle over a quadrant would swallow every click meant for a
 *   tooth inside it.
 */

export interface VisualRegionSeed {
  code: string;
  label: string;
  /** The code of the region this groups under. */
  parentCode?: string;
  metadata?: Record<string, unknown>;
}

export interface VisualMapSeed {
  code: string;
  name: string;
  description: string;
  careContextCode: string;
  /** Taxonomy node code. NULL-ish means "the whole care context". */
  specialtyCode?: string;
  viewBox: string;
  regions: VisualRegionSeed[];
}

/** Tooth box: 34 wide, 38 apart, with 12 more across the midline. */
const TOOTH_WIDTH = 34;
const TOOTH_HEIGHT = 60;
const TOOTH_PITCH = 38;
const MARGIN_X = 8;
const MIDLINE_GAP = 12;
const UPPER_Y = 40;
const LOWER_Y = 150;

/** `column` runs 0…15 left to right across the page. */
function toothAt(column: number, y: number): Record<string, unknown> {
  const x = MARGIN_X + column * TOOTH_PITCH + (column >= 8 ? MIDLINE_GAP : 0);
  return {
    shape: { kind: 'RECT', x, y, width: TOOTH_WIDTH, height: TOOTH_HEIGHT, radius: 6 },
  };
}

/**
 * One arch, as sixteen regions.
 *
 * `rightQuadrant` is the patient's right — quadrant 1 upper, 4 lower — and its
 * teeth run 8 → 1 across the page toward the midline. `leftQuadrant` runs 1 → 8
 * away from it. That asymmetry is the FDI notation itself, not a layout choice.
 */
function arch(rightQuadrant: number, leftQuadrant: number, y: number): VisualRegionSeed[] {
  const regions: VisualRegionSeed[] = [];

  for (let column = 0; column < 8; column += 1) {
    const tooth = 8 - column;
    regions.push({
      code: `TOOTH_${rightQuadrant}${tooth}`,
      label: `${rightQuadrant}${tooth}`,
      parentCode: `QUADRANT_${rightQuadrant}`,
      metadata: toothAt(column, y),
    });
  }

  for (let column = 8; column < 16; column += 1) {
    const tooth = column - 7;
    regions.push({
      code: `TOOTH_${leftQuadrant}${tooth}`,
      label: `${leftQuadrant}${tooth}`,
      parentCode: `QUADRANT_${leftQuadrant}`,
      metadata: toothAt(column, y),
    });
  }

  return regions;
}

/**
 * ⚠️ NO `metadata` ON A QUADRANT AT ALL, AND THAT IS THE POINT. An ABSENT
 *   geometry document means "this region groups and is not drawn"; an EMPTY one
 *   (`{}`) is refused by the parser, because it is what a half-written import
 *   produces. Both cases are unit-tested in `@rcln/clinical`.
 */
const QUADRANTS: VisualRegionSeed[] = [
  { code: 'QUADRANT_1', label: 'Upper right' },
  { code: 'QUADRANT_2', label: 'Upper left' },
  { code: 'QUADRANT_3', label: 'Lower left' },
  { code: 'QUADRANT_4', label: 'Lower right' },
];

export const VISUAL_MAPS: VisualMapSeed[] = [
  {
    code: 'HUMAN_DENTAL',
    name: 'Adult odontogram (FDI)',
    description:
      'The 32 permanent teeth in FDI two-digit notation, drawn as the clinician faces the patient.',
    careContextCode: 'HUMAN',
    specialtyCode: 'DEN',
    viewBox: '0 0 640 260',
    regions: [...QUADRANTS, ...arch(1, 2, UPPER_Y), ...arch(4, 3, LOWER_Y)],
  },
];
