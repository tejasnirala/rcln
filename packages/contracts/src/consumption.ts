/**
 * Clinical consumption: what a procedure was expected to use, and what it
 * actually used (PI-9).
 *
 * `products.ts` says what a thing IS, `inventory.ts` says where it is,
 * `pharmacy.ts` says what left a counter into somebody's hand — and this is
 * what was used ON somebody, in a treatment room, during a procedure.
 *
 * ── WHAT THIS SURFACE DELIBERATELY CANNOT DO ────────────────────────────────
 * There is no field below through which a caller could:
 *
 *   state a price, a policy or a tax   PI-ADR-005 — consumption is NOT a charge.
 *                                      The service emits a `charge_request` per
 *                                      line and knows nothing about billability;
 *                                      the charge policy decides. A `NEVER_BILL`
 *                                      glove and a `SEPARATELY_BILLABLE` implant
 *                                      travel through identical code.
 *   state a signed or base quantity    the server converts through the one
 *                                      `toBaseUnits` the ledger uses, and the
 *                                      SIGN is a property of the movement type
 *   declare its own variance           `isOverride` is DERIVED server-side from
 *                                      the actual and the expected disagreeing.
 *                                      A flag the client sets is a control only
 *                                      the honest client applies — which is what
 *                                      PI-8.11's dispensing CRITICAL was
 *   claim a template line for a        the pairing is re-checked against the
 *   different product                  template: a line may not cite template
 *                                      line L (for gloves) while consuming an
 *                                      implant
 *   write anything clinical            invariant 7. Consumption reads the
 *                                      consultation and writes only beside it
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * A consumption record names a patient and a device serial. A TEMPLATE does
 * not — it is a statement about a procedure — and the two halves of this file
 * are deliberately different in that respect. Every READ of the record shapes
 * writes one `data_access_logs` row carrying ids, enums and counts, and never a
 * patient name or a product name.
 */
import { z } from 'zod';
import { uuid, calendarDate, paginationQuery } from './common.js';
import { positiveQuantity } from './inventory.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in consumption.prisma
// ---------------------------------------------------------------------------

/**
 * ⚠️ ONLY THE TWO BUILT MEMBERS ARE ON THE WIRE. `LAB_ORDER` and
 *   `IMAGING_STUDY` exist in the database enum so the phase that builds those
 *   modules needs no enum migration, and the CHECK constraint refuses them
 *   today — so accepting them here would be an API that promises something the
 *   database declines, which is worse than a 400.
 */
export const consumptionAnchorKind = z.enum(['ENCOUNTER', 'ENCOUNTER_PROCEDURE']);

export const consumptionTemplateStatus = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);

export const clinicalConsumptionKind = z.enum([
  'CONSUMPTION',
  'ADDITIONAL_CONSUMPTION',
  'CONSUMPTION_REVERSAL',
]);

/** The two kinds a caller may ASK for. `CONSUMPTION` comes from the other route. */
export const consumptionCorrectionKind = z.enum(['ADDITIONAL_CONSUMPTION', 'CONSUMPTION_REVERSAL']);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const consumptionTemplateLineRequest = z.object({
  productId: uuid,
  /** In whatever unit the clinic thinks in — "2 pairs", "2 mL". Never a base. */
  quantity: positiveQuantity,
  unitId: uuid,
  /** Pre-filled at ZERO rather than at its quantity, so it is added on purpose. */
  isOptional: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  note: z.string().trim().max(2000).nullish(),
});

export const createConsumptionTemplateRequest = z.object({
  /** The PROCEDURE this is for. Checked to be a `PROCEDURE` master item. */
  itemId: uuid,
  name: z.string().trim().min(1).max(255),
  /**
   * ⚠️ A DATE, NOT AN INSTANT, and it is what decides which version pre-fills a
   *   procedure. Defaults to today in the service, resolved in the BRANCH's
   *   timezone rather than the container's (invariant 6).
   */
  effectiveFrom: calendarDate.optional(),
  effectiveTo: calendarDate.nullish(),
  status: consumptionTemplateStatus.default('DRAFT'),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(consumptionTemplateLineRequest).max(200).default([]),
});

/**
 * ⚠️ THE LINE SET IS REPLACED WHOLESALE WHERE IT IS SENT, AND OMITTED WHERE IT
 *   IS NOT. `lines: []` empties the template and `lines` absent leaves it alone,
 *   which are different intentions and must not collapse into one — the reason
 *   this is `.optional()` rather than `.default([])` as the create is.
 */
export const updateConsumptionTemplateRequest = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  status: consumptionTemplateStatus.optional(),
  effectiveFrom: calendarDate.optional(),
  effectiveTo: calendarDate.nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(consumptionTemplateLineRequest).max(200).optional(),
});

export const consumptionTemplateLineDetail = z.object({
  id: uuid,
  productId: uuid,
  productName: z.string(),
  quantity: z.string(),
  unitId: uuid,
  unitSymbol: z.string(),
  /** The same figure in the product's base unit — what a consumption compares against. */
  quantityBase: z.string(),
  baseUnitSymbol: z.string(),
  isOptional: z.boolean(),
  displayOrder: z.number().int(),
  note: z.string().nullable(),
});

export const consumptionTemplateSummary = z.object({
  id: uuid,
  itemId: uuid,
  itemName: z.string(),
  name: z.string(),
  version: z.number().int(),
  status: consumptionTemplateStatus,
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  lineCount: z.number().int(),
  updatedAt: z.string(),
});

export const consumptionTemplateDetail = consumptionTemplateSummary.extend({
  notes: z.string().nullable(),
  lines: z.array(consumptionTemplateLineDetail),
});

export const consumptionTemplateQuery = paginationQuery.extend({
  itemId: uuid.optional(),
  status: consumptionTemplateStatus.optional(),
  /** Free-text over the template name and the procedure's name. */
  search: z.string().trim().max(120).optional(),
});

export const consumptionTemplateListResponse = z.object({
  items: z.array(consumptionTemplateSummary),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

// ---------------------------------------------------------------------------
// The plan — what the panel shows before anybody confirms anything
// ---------------------------------------------------------------------------

export const consumptionPlanQuery = z.object({
  branchId: uuid.optional(),
  encounterId: uuid,
  encounterProcedureId: uuid.optional(),
  /** Which trolley or cabinet the material will come off. */
  locationId: uuid.optional(),
});

/**
 * One lot — or one numbered device — the panel may take this line from.
 *
 * ⚠️ IT IS THE FEFO PLANNER'S OWN CANDIDATE LIST, IN ITS OWN ORDER, and the
 *   panel offers it rather than deciding for the clinician. A dentist fitting a
 *   specific numbered implant has to be able to say WHICH one: the serial is
 *   what makes a device recall answerable at patient level, and "whichever one
 *   FEFO picked" is not an answer when the device in the patient has a number
 *   printed on it.
 *
 * ⚠️ `plannedQuantityBase` IS WHAT FEFO WOULD TAKE, NOT WHAT WILL BE TAKEN. The
 *   panel pre-fills from it so the ordinary case needs no interaction at all;
 *   anything the clinician changes becomes a recorded override with a reason,
 *   decided by the SERVER from the plan it re-runs inside the posting
 *   transaction — never from a flag the screen sets.
 */
export const consumptionCandidateLot = z.object({
  locationId: uuid,
  locationName: z.string(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.string().nullable(),
  serialId: uuid.nullable(),
  /** ⚠️ PHI-adjacent once it is consumed: the device that is now inside somebody. */
  serialNumber: z.string().nullable(),
  /** What this bucket holds as AVAILABLE, less anything reserved on it. */
  availableQuantityBase: z.string(),
  /** What FEFO proposes taking from this bucket for the expected quantity. */
  plannedQuantityBase: z.string(),
});

/**
 * One suggested line, with what is actually on the shelf beside it.
 *
 * ⚠️ THIS WRITES NOTHING. A template deducts no stock; only an actual recording
 *   moves quantity. `availableQuantityBase` is a read of the balance at the
 *   moment the panel loaded and is re-asserted inside the posting transaction,
 *   because the shelf may have moved since.
 */
export const consumptionPlanLine = z.object({
  templateLineId: uuid.nullable(),
  productId: uuid,
  productName: z.string(),
  /** The template's figure, in the unit the template stated it in. */
  expectedQuantity: z.string(),
  unitId: uuid,
  unitSymbol: z.string(),
  expectedQuantityBase: z.string(),
  baseUnitSymbol: z.string(),
  isOptional: z.boolean(),
  /** What FEFO would give out, and what is there at all. */
  availableQuantityBase: z.string(),
  isSerialTracked: z.boolean(),
  /**
   * ⚠️ EMPTY FOR UNTRACKED STOCK, AND THAT IS NOT A GAP. A box of gloves has one
   *   bucket and nothing to choose between; offering a one-item picker for every
   *   consumable on the tray is how a screen teaches people to click past it.
   *   Populated whenever the product is batch- or serial-tracked.
   */
  candidateLots: z.array(consumptionCandidateLot),
  note: z.string().nullable(),
});

export const consumptionPlanResponse = z.object({
  branchId: uuid,
  encounterId: uuid,
  encounterProcedureId: uuid.nullable(),
  patientId: uuid,
  /** NULL where this procedure has no template in force — an ordinary case. */
  templateId: uuid.nullable(),
  templateName: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  /** Whether the anchor is still open to amendment. See `canAmend` in the service. */
  encounterIsOpen: z.boolean(),
  lines: z.array(consumptionPlanLine),
});

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export const consumptionAllocationRequest = z.object({
  locationId: uuid,
  batchId: uuid.nullish(),
  serialId: uuid.nullish(),
  /** In the product's BASE unit. The allocations must sum to the line quantity. */
  quantityBase: positiveQuantity,
  isOverride: z.boolean().default(false),
  overrideReason: z.string().trim().max(2000).nullish(),
});

/**
 * ⚠️ THERE IS NO `isOverride` ON A LINE, AND ITS ABSENCE IS THE CONTROL. Whether
 *   the actual departs from the expected is arithmetic the server does over two
 *   numbers it already holds; a client-supplied flag would let a screen record a
 *   departure as routine by simply not setting it. `overrideReason` IS accepted,
 *   because only a human can supply it — and it is REQUIRED, by the database,
 *   whenever the server derives an override.
 */
export const consumptionLineRequest = z.object({
  /** The template line this answers, where the panel pre-filled it. */
  templateLineId: uuid.nullish(),
  productId: uuid,
  /** What the clinician says was used, in the unit they thought in. */
  quantity: positiveQuantity,
  unitId: uuid,
  /** Why it differs from what the template expected. Required when it does. */
  overrideReason: z.string().trim().max(2000).nullish(),
  allocations: z.array(consumptionAllocationRequest).max(50).optional(),
});

export const recordConsumptionRequest = z
  .object({
    branchId: uuid.optional(),
    anchorKind: consumptionAnchorKind.default('ENCOUNTER_PROCEDURE'),
    encounterId: uuid,
    /** Required when the anchor is a procedure, refused when it is not. */
    encounterProcedureId: uuid.nullish(),
    /** The trolley, cabinet or room. Need not be a dispensing point. */
    locationId: uuid,
    /**
     * ⚠️ WHEN IT WAS USED, not when it was keyed in. Defaults to now. Every
     *   ledger leg and the charge request both carry it, and the latter is what
     *   selects the effective-dated tax rule.
     */
    occurredAt: z.iso.datetime().optional(),
    /** ⚠️ PHI-capable. */
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(consumptionLineRequest).min(1).max(100),
  })
  .refine(
    (body) => body.anchorKind !== 'ENCOUNTER_PROCEDURE' || body.encounterProcedureId != null,
    'a consumption anchored to a procedure has to say which procedure'
  )
  .refine(
    (body) => body.anchorKind !== 'ENCOUNTER' || body.encounterProcedureId == null,
    'a consumption filed against the visit itself names no procedure'
  );

/**
 * Restating a record while the consultation is still open.
 *
 * ⚠️ THE WHOLE LINE SET IS SENT, AND IT REPLACES WHAT IS THERE. A partial patch
 *   would need the client to know which lines it is not sending, and the delta
 *   arithmetic — which is what actually moves stock — is computed by the server
 *   against the stored quantities either way.
 */
export const amendConsumptionRequest = z.object({
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(consumptionLineRequest).min(1).max(100),
  /** Why the record is being restated. Recorded on the audit row. */
  reason: z.string().trim().min(1).max(2000),
});

/**
 * Correcting a record after the consultation has closed.
 *
 * ⚠️ A SECOND RECORD, NEVER AN EDIT, and the quantities are POSITIVE in both
 *   directions — `kind` carries the sign, for the reason `stock_ledger` keeps
 *   the sign out of the quantity.
 */
export const correctConsumptionRequest = z.object({
  kind: consumptionCorrectionKind,
  reason: z.string().trim().min(1).max(2000),
  occurredAt: z.iso.datetime().optional(),
  lines: z.array(consumptionLineRequest).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export const consumptionAllocationDetail = z.object({
  id: uuid,
  locationId: uuid,
  locationName: z.string(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.string().nullable(),
  serialId: uuid.nullable(),
  /** ⚠️ PHI-adjacent: the device that is now inside a named person. */
  serialNumber: z.string().nullable(),
  quantityBase: z.string(),
  isOverride: z.boolean(),
  overrideReason: z.string().nullable(),
});

export const consumptionLineDetail = z.object({
  id: uuid,
  lineNumber: z.number().int(),
  templateLineId: uuid.nullable(),
  productId: uuid,
  productName: z.string(),
  expectedQuantityBase: z.string(),
  quantityEntered: z.string(),
  unitId: uuid,
  unitSymbol: z.string(),
  quantityBase: z.string(),
  baseUnitSymbol: z.string(),
  /**
   * ⚠️ DERIVED ON THE WAY OUT AS WELL AS ON THE WAY IN, and never stored.
   *   `actual − expected`, so it is negative when less was used than expected.
   */
  varianceBase: z.string(),
  isOverride: z.boolean(),
  overrideReason: z.string().nullable(),
  allocations: z.array(consumptionAllocationDetail),
});

export const consumptionSummary = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  kind: clinicalConsumptionKind,
  anchorKind: consumptionAnchorKind,
  encounterId: uuid,
  encounterProcedureId: uuid.nullable(),
  /** What the procedure is called, where there is one. */
  procedureName: z.string().nullable(),
  patientId: uuid,
  /** ⚠️ PHI. */
  patientName: z.string(),
  locationId: uuid,
  locationName: z.string(),
  templateId: uuid.nullable(),
  occurredAt: z.string(),
  recordedByName: z.string(),
  lineCount: z.number().int(),
  /** Whether any line departed from what the template expected. */
  hasVariance: z.boolean(),
  correctsConsumptionId: uuid.nullable(),
  amendedAt: z.string().nullable(),
});

export const consumptionDetail = consumptionSummary.extend({
  notes: z.string().nullable(),
  correctionReason: z.string().nullable(),
  amendedByName: z.string().nullable(),
  createdAt: z.string(),
  lines: z.array(consumptionLineDetail),
  /** The corrections written against this record, newest first. */
  corrections: z.array(
    z.object({
      id: uuid,
      kind: clinicalConsumptionKind,
      occurredAt: z.string(),
      reason: z.string().nullable(),
      recordedByName: z.string(),
      lineCount: z.number().int(),
    })
  ),
});

export const consumptionQuery = paginationQuery.extend({
  branchId: uuid.optional(),
  encounterId: uuid.optional(),
  encounterProcedureId: uuid.optional(),
  patientId: uuid.optional(),
  productId: uuid.optional(),
  kind: clinicalConsumptionKind.optional(),
  /** Only the records where something departed from the template. */
  varianceOnly: z.coerce.boolean().optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export const consumptionListResponse = z.object({
  items: z.array(consumptionSummary),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsumptionAnchorKind = z.infer<typeof consumptionAnchorKind>;
export type ConsumptionTemplateStatus = z.infer<typeof consumptionTemplateStatus>;
export type ClinicalConsumptionKind = z.infer<typeof clinicalConsumptionKind>;
export type ConsumptionCorrectionKind = z.infer<typeof consumptionCorrectionKind>;

export type ConsumptionTemplateLineRequest = z.infer<typeof consumptionTemplateLineRequest>;
export type CreateConsumptionTemplateRequest = z.infer<typeof createConsumptionTemplateRequest>;
export type UpdateConsumptionTemplateRequest = z.infer<typeof updateConsumptionTemplateRequest>;
export type ConsumptionTemplateLineDetail = z.infer<typeof consumptionTemplateLineDetail>;
export type ConsumptionTemplateSummary = z.infer<typeof consumptionTemplateSummary>;
export type ConsumptionTemplateDetail = z.infer<typeof consumptionTemplateDetail>;
export type ConsumptionTemplateQuery = z.infer<typeof consumptionTemplateQuery>;
export type ConsumptionTemplateListResponse = z.infer<typeof consumptionTemplateListResponse>;

export type ConsumptionPlanQuery = z.infer<typeof consumptionPlanQuery>;
export type ConsumptionCandidateLot = z.infer<typeof consumptionCandidateLot>;
export type ConsumptionPlanLine = z.infer<typeof consumptionPlanLine>;
export type ConsumptionPlanResponse = z.infer<typeof consumptionPlanResponse>;

export type ConsumptionAllocationRequest = z.infer<typeof consumptionAllocationRequest>;
export type ConsumptionLineRequest = z.infer<typeof consumptionLineRequest>;
export type RecordConsumptionRequest = z.infer<typeof recordConsumptionRequest>;
export type AmendConsumptionRequest = z.infer<typeof amendConsumptionRequest>;
export type CorrectConsumptionRequest = z.infer<typeof correctConsumptionRequest>;

export type ConsumptionAllocationDetail = z.infer<typeof consumptionAllocationDetail>;
export type ConsumptionLineDetail = z.infer<typeof consumptionLineDetail>;
export type ConsumptionSummary = z.infer<typeof consumptionSummary>;
export type ConsumptionDetail = z.infer<typeof consumptionDetail>;
export type ConsumptionQuery = z.infer<typeof consumptionQuery>;
export type ConsumptionListResponse = z.infer<typeof consumptionListResponse>;
