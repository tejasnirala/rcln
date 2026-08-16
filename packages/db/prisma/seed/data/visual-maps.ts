/**
 * DATA ONLY — the platform's visual maps. `seedVisualMaps` writes them.
 *
 * ⚠️ THREE MAPS, AND THE SECOND AND THIRD COST NO COMPONENT (CE-7). The
 *   odontogram (CD-11) proved the engine draws a real chart; `HUMAN_SCALP` and
 *   `HUMAN_BODY` prove it draws two more without a line of new code in
 *   `apps/web` — which is CE-7's entire definition of done. §41 still holds:
 *   three reference charts is the ceiling, not a running start on a fourth.
 *
 * ⚠️ AND THE THREE ARE DELIBERATELY DIFFERENT SHAPES OF DOCUMENT, because the
 *   renderer has branches that untested data would leave unproven:
 *
 *     HUMAN_DENTAL  RECT, grouped four ways, labels at the shape's centre
 *     HUMAN_SCALP   PATH, entirely FLAT, every label anchored by hand
 *     HUMAN_BODY    RECT + CIRCLE, grouped two ways, twenty-four places
 *
 *   `labelAnchorOf` has no centre to compute for a path, so a scalp zone that
 *   did not state its anchor would draw with no label at all — which is why the
 *   flat map is the one that exercises the anchor.
 *
 * ⚠️ THE DENTAL REGION CODES ARE FDI TWO-DIGIT NOTATION — `TOOTH_11` … `TOOTH_48`, and
 *   NEVER an index. Universal and Palmer are RENDERINGS of the same stored
 *   codes; an index would have made that impossible, and a clinic that later
 *   switches display notation would have had to rewrite every record.
 *
 * ⚠️ AND THE GEOMETRY IS DATA, NOT A DRAWING (CD-17). The shapes below are in
 *   the map's own `view_box` coordinates and are parsed by `@rcln/clinical`
 *   before anything renders them. That is what makes one generic renderer in
 *   `apps/web` enough, and it is why the scalp map below is a seed rather than a
 *   `HairConsultation.tsx`.
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

// ── The scalp, from above ────────────────────────────────────────────────────
//
//   A trichology chart is the head seen from the top, face toward the top of
//   the page, divided into the zones a clinician grades: the hairline, the
//   frontal area, the two temples, the mid-scalp, the vertex, the occiput and
//   the nape — the last of which is the donor area, and is why it is a region
//   of its own rather than part of the occiput.
//
//   ⚠️ THE PATIENT'S RIGHT IS ON THE LEFT OF THE PAGE, exactly as it is on the
//     odontogram, because both charts are drawn as the clinician faces the
//     patient. Two charts in one product that disagreed about which side is
//     which is a mark recorded on the wrong temple.
//
//   ⚠️ AND THE MAP IS FLAT — NO GROUPING REGIONS AT ALL. The odontogram has
//     four quadrants; this has none, and `regionGroups` returns eight groups of
//     one rather than nothing. That case is unit-tested in `@rcln/clinical`,
//     and this is the shipped data that proves it renders.

const SCALP_CX = 180;
const SCALP_CY = 240;
const SCALP_RX = 140;
const SCALP_RY = 220;
/** Segments per edge. Eight is smooth at this size and keeps the `d` short. */
const SCALP_STEPS = 8;

/** The head's half-width at a given `y`. Zero outside the outline. */
function scalpHalfWidth(y: number): number {
  const offset = (y - SCALP_CY) / SCALP_RY;
  const inside = 1 - offset * offset;
  return inside <= 0 ? 0 : SCALP_RX * Math.sqrt(inside);
}

/**
 * A point on the scalp. `t` runs -1 (the patient's right edge) to 1 (their
 * left), as a fraction of the head's width AT THAT HEIGHT — so a zone's sides
 * follow the outline instead of cutting across it.
 */
function scalpX(y: number, t: number): number {
  return Math.round((SCALP_CX + t * scalpHalfWidth(y)) * 10) / 10;
}

/**
 * One zone of the scalp, as a closed path.
 *
 * ⚠️ IT STATES ITS LABEL ANCHOR, AND MUST. `labelAnchorOf` computes a centre for
 *   a rectangle and a circle and returns NOTHING for a path — parsing an
 *   arbitrary `d` to find its middle is not something the renderer does. A zone
 *   that omitted the anchor would draw correctly and be captioned nowhere.
 */
function scalpZone(y0: number, y1: number, tFrom: number, tTo: number): Record<string, unknown> {
  const points: string[] = [];
  for (let step = 0; step <= SCALP_STEPS; step += 1) {
    const y = y0 + ((y1 - y0) * step) / SCALP_STEPS;
    points.push(`${scalpX(y, tFrom)},${y}`);
  }
  for (let step = SCALP_STEPS; step >= 0; step -= 1) {
    const y = y0 + ((y1 - y0) * step) / SCALP_STEPS;
    points.push(`${scalpX(y, tTo)},${y}`);
  }

  const midY = (y0 + y1) / 2;
  return {
    shape: { kind: 'PATH', d: `M ${points.join(' L ')} Z` },
    label: { x: scalpX(midY, (tFrom + tTo) / 2), y: midY },
  };
}

/** The lateral fraction the temples start at, and the mid-band ends at. */
const TEMPLE_EDGE = 0.45;

const SCALP_REGIONS: VisualRegionSeed[] = [
  { code: 'FRONTAL_HAIRLINE', label: 'Hairline', metadata: scalpZone(40, 95, -1, 1) },
  {
    code: 'FRONTAL',
    label: 'Frontal',
    metadata: scalpZone(95, 175, -TEMPLE_EDGE, TEMPLE_EDGE),
  },
  {
    code: 'TEMPORAL_RIGHT',
    label: 'Temporal R',
    metadata: scalpZone(95, 300, -1, -TEMPLE_EDGE),
  },
  {
    code: 'TEMPORAL_LEFT',
    label: 'Temporal L',
    metadata: scalpZone(95, 300, TEMPLE_EDGE, 1),
  },
  {
    code: 'MID_SCALP',
    label: 'Mid-scalp',
    metadata: scalpZone(175, 245, -TEMPLE_EDGE, TEMPLE_EDGE),
  },
  { code: 'VERTEX', label: 'Vertex', metadata: scalpZone(245, 300, -TEMPLE_EDGE, TEMPLE_EDGE) },
  { code: 'OCCIPITAL', label: 'Occipital', metadata: scalpZone(300, 380, -1, 1) },
  { code: 'NAPE', label: 'Nape', metadata: scalpZone(380, 440, -1, 1) },
];

// ── The body, front and back ─────────────────────────────────────────────────
//
//   Two silhouettes side by side, each twelve places, grouped by the view they
//   belong to. A lesion is recorded on the front of the left forearm or the
//   back of the right calf, and a chart with one silhouette can say neither.
//
//   ⚠️ LEFT AND RIGHT ARE THE PATIENT'S ON BOTH VIEWS, which means the two
//     silhouettes MIRROR each other: on the front view the patient's right arm
//     is on the left of the page, and on the back view it is on the right. That
//     is what a clinician standing in front of the patient and then behind them
//     actually sees, and a chart that laid both out identically would collect
//     half its marks on the wrong limb.
//
//   ⚠️ THE FIGURE IS ROUNDED BOXES AND ONE CIRCLE, NOT AN ANATOMICAL OUTLINE.
//     A region is a target a clinician clicks and a name a record reads back;
//     rendering fidelity beyond "which limb" buys nothing and costs a path
//     nobody can edit in the chart admin.

/** Where each silhouette starts, in the map's coordinates. Each is 200 wide. */
const BODY_TOP = 24;
const ANTERIOR_X = 20;
const POSTERIOR_X = 240;

function box(
  originX: number,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): Record<string, unknown> {
  return {
    shape: { kind: 'RECT', x: originX + x, y: BODY_TOP + y, width, height, radius },
  };
}

/**
 * One silhouette.
 *
 * `prefix` codes the view, `side` names the sides in the order they appear ON
 * THE PAGE — the patient's right first on the front view, their left first on
 * the back. See the mirroring note above.
 */
function silhouette(
  prefix: string,
  originX: number,
  labels: { trunkUpper: string; trunkLower: string },
  pageLeft: 'R' | 'L'
): VisualRegionSeed[] {
  const pageRight = pageLeft === 'R' ? 'L' : 'R';
  const view = prefix === 'ANT' ? 'VIEW_ANTERIOR' : 'VIEW_POSTERIOR';

  return [
    {
      code: `${prefix}_HEAD`,
      label: 'Head',
      parentCode: view,
      metadata: { shape: { kind: 'CIRCLE', cx: originX + 100, cy: BODY_TOP + 40, r: 32 } },
    },
    {
      code: `${prefix}_NECK`,
      label: 'Neck',
      parentCode: view,
      metadata: box(originX, 84, 72, 32, 18, 6),
    },
    {
      code: `${prefix}_TRUNK_UPPER`,
      label: labels.trunkUpper,
      parentCode: view,
      metadata: box(originX, 52, 90, 96, 80, 8),
    },
    {
      code: `${prefix}_TRUNK_LOWER`,
      label: labels.trunkLower,
      parentCode: view,
      metadata: box(originX, 52, 172, 96, 72, 8),
    },
    {
      code: `${prefix}_ARM_${pageLeft}`,
      label: `${pageLeft} arm`,
      parentCode: view,
      metadata: box(originX, 4, 94, 44, 140, 12),
    },
    {
      code: `${prefix}_ARM_${pageRight}`,
      label: `${pageRight} arm`,
      parentCode: view,
      metadata: box(originX, 152, 94, 44, 140, 12),
    },
    {
      code: `${prefix}_HAND_${pageLeft}`,
      label: `${pageLeft} hand`,
      parentCode: view,
      metadata: box(originX, 4, 238, 44, 32, 10),
    },
    {
      code: `${prefix}_HAND_${pageRight}`,
      label: `${pageRight} hand`,
      parentCode: view,
      metadata: box(originX, 152, 238, 44, 32, 10),
    },
    {
      code: `${prefix}_LEG_${pageLeft}`,
      label: `${pageLeft} leg`,
      parentCode: view,
      metadata: box(originX, 54, 248, 44, 160, 12),
    },
    {
      code: `${prefix}_LEG_${pageRight}`,
      label: `${pageRight} leg`,
      parentCode: view,
      metadata: box(originX, 102, 248, 44, 160, 12),
    },
    {
      code: `${prefix}_FOOT_${pageLeft}`,
      label: `${pageLeft} foot`,
      parentCode: view,
      metadata: box(originX, 54, 412, 44, 30, 8),
    },
    {
      code: `${prefix}_FOOT_${pageRight}`,
      label: `${pageRight} foot`,
      parentCode: view,
      metadata: box(originX, 102, 412, 44, 30, 8),
    },
  ];
}

/** ⚠️ No `metadata`: a view groups and is not drawn. Same rule as a quadrant. */
const BODY_VIEWS: VisualRegionSeed[] = [
  { code: 'VIEW_ANTERIOR', label: 'Front' },
  { code: 'VIEW_POSTERIOR', label: 'Back' },
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
  {
    code: 'HUMAN_SCALP',
    name: 'Scalp zones',
    description:
      'The scalp from above, face to the top of the page, in the zones a hair and scalp consultation grades. The nape is the donor area.',
    careContextCode: 'HUMAN',
    /* Dermatology, not Trichology: a scalp chart is offered to the whole
       department, and the hair and scalp template is what narrows it. */
    specialtyCode: 'DERMATOLOGY',
    viewBox: '0 0 360 480',
    regions: SCALP_REGIONS,
  },
  {
    code: 'HUMAN_BODY',
    name: 'Body regions (front and back)',
    description:
      'Twelve places on each of two views, for anything recorded somewhere on the body rather than in one specialty’s organ.',
    careContextCode: 'HUMAN',
    /*
     * ⚠️ NO SPECIALTY, AND THE ABSENCE IS THE POINT — the schema comment on
     *   `visual_maps.specialty_id` says it in as many words: a body diagram is
     *   nobody's specialty in particular. A dermatologist maps a rash on it, a
     *   physiotherapist a painful joint, a surgeon a wound.
     */
    viewBox: '0 0 460 500',
    regions: [
      ...BODY_VIEWS,
      ...silhouette('ANT', ANTERIOR_X, { trunkUpper: 'Chest', trunkLower: 'Abdomen' }, 'R'),
      ...silhouette('POST', POSTERIOR_X, { trunkUpper: 'Upper back', trunkLower: 'Low back' }, 'L'),
    ],
  },
];
