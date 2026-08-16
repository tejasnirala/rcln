/**
 * The visual mapping engine (CE-6) — the chart a clinician draws ON, and what
 * they drew on it.
 *
 * ── TWO KINDS OF THING IN ONE FILE, AND THE LINE IS THE USUAL ONE ────────────
 *
 *   `visualMap` / `visualRegion`   CONFIGURATION. No PHI. A map is a picture of
 *     a body — the 32 teeth of the FDI notation are the same 32 teeth in every
 *     dental practice — so it is platform-extensible, safe in a URL, and not
 *     read-audited.
 *
 *   `clinicalFinding`              PHI. "Caries on tooth 36" is a statement
 *     about a named person, and it belongs to `encounterContent` beside the
 *     diagnoses and the prescriptions.
 *
 * ⚠️ `metadata` STAYS `unknown` ON THE WIRE, exactly as a template's
 *   `definition` does, and for exactly the same reason: the geometry grammar
 *   has ONE home, `@rcln/clinical`'s `regions.ts`. A Zod mirror of it here
 *   would be a second answer to what a shape is, and the two would drift the
 *   first time either was touched.
 *
 * ⚠️ AND THIS FILE IMPORTS NOTHING FROM `encounter-content.js`, WHICH IMPORTS
 *   FROM IT. A Zod module cycle fails at runtime rather than at lint — see
 *   `visit-history.ts`'s header, which records the same trap. The dependency
 *   runs one way.
 */
import { z } from 'zod';
import { uuid } from './common.js';

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** Mirrors `VisualMapRenderer`. */
export const visualMapRenderer = z.enum(['SVG', 'IMAGE_MAP']);
export type VisualMapRendererValue = z.infer<typeof visualMapRenderer>;

/**
 * ⚠️ FLAT, NOT A PATH, AND STABLE FOR EVER. A template names a map by this code
 *   (CD-6) — renaming one orphans every template citing it, and the symptom is
 *   a consultation whose chart section renders nothing.
 */
const mapCode = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'a code is uppercase letters, digits and underscores')
  .max(64);

const regionCode = mapCode;

/**
 * `"0 0 640 320"`.
 *
 * ⚠️ VALIDATED IN THREE PLACES AND THAT IS DELIBERATE — here, in
 *   `@rcln/clinical`'s `parseViewBox`, and by a CHECK constraint. This one
 *   catches a typo before the round trip; the engine catches a row written by a
 *   fixture; the CHECK catches one written by a seed or an import. Only the
 *   last is a guarantee.
 */
const viewBox = z
  .string()
  .trim()
  .regex(
    /^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/,
    'a view box is four numbers separated by spaces'
  )
  .max(64);

export const visualRegion = z.object({
  id: uuid,
  code: regionCode,
  label: z.string(),
  /** The grouping region this sits under — a quadrant, an arch. */
  parentId: uuid.nullable(),
  displayOrder: z.number().int(),
  /**
   * The region's shape, in the map's coordinates.
   *
   * ⚠️ `unknown`, AND PARSED BY `@rcln/clinical` BEFORE ANYTHING DRAWS IT. See
   *   the file header. `null` is legal and means the region groups and is not
   *   drawn.
   */
  metadata: z.unknown().nullable(),
});
export type VisualRegion = z.infer<typeof visualRegion>;

export const visualMap = z.object({
  id: uuid,
  code: mapCode,
  name: z.string(),
  description: z.string().nullable(),
  renderer: visualMapRenderer,
  assetKey: z.string().nullable(),
  careContextId: uuid,
  careContextName: z.string(),
  specialtyId: uuid.nullable(),
  specialtyName: z.string().nullable(),
  viewBox,
  isActive: z.boolean(),
  /**
   * Whether this clinic may edit it.
   *
   * ⚠️ THE SAME FIELD `consultationTemplate` CARRIES, AND FOR THE SAME REASON. A
   *   platform map is readable by everybody and writable by nobody at a clinic;
   *   a screen that offered an edit button on one would produce an error the
   *   clinic could do nothing about.
   */
  isOwn: z.boolean(),
  regionCount: z.number().int(),
});
export type VisualMap = z.infer<typeof visualMap>;

/** One map and its places — what the chart is drawn from. */
export const visualMapDetail = visualMap.extend({
  regions: z.array(visualRegion),
});
export type VisualMapDetail = z.infer<typeof visualMapDetail>;

export const visualMapListResponse = z.object({
  items: z.array(visualMap),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type VisualMapListResponse = z.infer<typeof visualMapListResponse>;

export const visualMapQuery = z.object({
  careContextId: uuid.optional(),
  specialtyId: uuid.optional(),
  includeInactive: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type VisualMapQuery = z.infer<typeof visualMapQuery>;

export const createVisualMapRequest = z.object({
  code: mapCode,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullish(),
  renderer: visualMapRenderer.optional(),
  /** ⚠️ Required for an IMAGE_MAP and refused for an SVG — a CHECK says so. */
  assetKey: z.string().trim().max(120).nullish(),
  careContextId: uuid,
  specialtyId: uuid.nullish(),
  viewBox,
});
export type CreateVisualMapRequest = z.infer<typeof createVisualMapRequest>;

/**
 * ⚠️ `code` IS NOT UPDATABLE. Templates cite it, and a rename would silently
 *   detach every one of them — the same call `consultationTemplate` makes.
 */
export const updateVisualMapRequest = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullish(),
  specialtyId: uuid.nullish(),
  viewBox: viewBox.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateVisualMapRequest = z.infer<typeof updateVisualMapRequest>;

export const createVisualRegionRequest = z.object({
  code: regionCode,
  label: z.string().trim().min(1).max(160),
  parentId: uuid.nullish(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
  /** The geometry document. `@rcln/clinical` is what says whether it means anything. */
  metadata: z.unknown().nullish(),
});
export type CreateVisualRegionRequest = z.infer<typeof createVisualRegionRequest>;

export const updateVisualRegionRequest = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  parentId: uuid.nullish(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
  metadata: z.unknown().nullish(),
});
export type UpdateVisualRegionRequest = z.infer<typeof updateVisualRegionRequest>;

// ---------------------------------------------------------------------------
// What was found on it — ⚠️ PHI from here down
// ---------------------------------------------------------------------------

/**
 * Mirrors `ClinicalSeverity`.
 *
 * ⚠️ RESTATED HERE RATHER THAN IMPORTED FROM `encounter-content.js`, AND THE
 *   REASON IS LOAD ORDER. That file imports the finding shapes from this one to
 *   put them on `encounterContent`; importing back would make whichever module
 *   evaluated second read `undefined`, and every request against the schema
 *   would fail at runtime. `encounter-content.ts` records the identical trap
 *   about `clinicalDurationUnit`. The two lists are asserted equal by a
 *   type-level check in `services/clinical/sections.ts`.
 */
export const findingSeverity = z.enum(['MILD', 'MODERATE', 'SEVERE']);
export type FindingSeverityValue = z.infer<typeof findingSeverity>;

/** Where on the map, as the chart needs to render it. */
export const findingRegionRef = z.object({
  id: uuid,
  code: regionCode,
  label: z.string(),
});
export type FindingRegionRef = z.infer<typeof findingRegionRef>;

/**
 * One mark on a chart. ⚠️ PHI.
 *
 * ⚠️ A FINDING IS NOT A DIAGNOSIS, AND `diagnosisId` IS THE OPTIONAL LINK
 *   BETWEEN THEM. "Caries" is what the dentist SEES on tooth 36; "Dental
 *   caries" is what it MEANS. Collapsing the two would make the chart claim a
 *   conclusion nobody has committed to.
 */
export const clinicalFinding = z.object({
  id: uuid,
  /** Which VISUAL_MAPPING section it was drawn on — the type is repeatable. */
  sectionKey: z.string(),
  region: findingRegionRef,
  /** The `FINDING_TYPE` word. Never null — a mark with no name reads as nothing. */
  item: z.object({ id: uuid, code: z.string(), name: z.string() }),
  diagnosisId: uuid.nullable(),
  severity: findingSeverity.nullable(),
  /** ⚠️ PHI. */
  notes: z.string().nullable(),
  /** Per-finding qualifiers the map wants and no column should own. */
  metadata: z.unknown().nullable(),
  displayOrder: z.number().int(),
});
export type ClinicalFinding = z.infer<typeof clinicalFinding>;

export const createClinicalFindingRequest = z.object({
  sectionKey: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/, 'a section key is lowercase letters, digits and underscores')
    .max(64),
  visualRegionId: uuid,
  findingItemId: uuid,
  diagnosisId: uuid.nullish(),
  severity: findingSeverity.nullish(),
  notes: z.string().trim().max(4000).nullish(),
  metadata: z.unknown().nullish(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
});
export type CreateClinicalFindingRequest = z.infer<typeof createClinicalFindingRequest>;

/**
 * ⚠️ NEITHER THE REGION NOR THE WORD IS UPDATABLE. Changing which tooth a
 *   finding is on, or what it is called, is not an edit to that finding — it is
 *   a different finding, and the one that was there was wrong and should be
 *   removed. Allowing it in place would leave the display order and the linked
 *   diagnosis attached to a statement nobody made.
 */
export const updateClinicalFindingRequest = z.object({
  diagnosisId: uuid.nullish(),
  severity: findingSeverity.nullish(),
  notes: z.string().trim().max(4000).nullish(),
  metadata: z.unknown().nullish(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
});
export type UpdateClinicalFindingRequest = z.infer<typeof updateClinicalFindingRequest>;
