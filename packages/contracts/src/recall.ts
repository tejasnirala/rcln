/**
 * Recall & traceability: the notice, the stock it names, and — separately and
 * under its own permission — the people it reached (PI-10).
 *
 * `inventory.ts` says where a lot is, `pharmacy.ts` says what left a counter
 * into somebody's hand, `consumption.ts` says what was used ON somebody. This
 * is the surface that walks all three BACKWARDS, from a lot number to the
 * people who have it.
 *
 * ── WHAT THIS SURFACE DELIBERATELY CANNOT DO ────────────────────────────────
 * There is no field below through which a caller could:
 *
 *   state a quantity to hold            executing a recall moves whatever is in
 *                                       the AVAILABLE bucket at the moment it
 *                                       runs, read inside the transaction. A
 *                                       caller-supplied figure would be a number
 *                                       from a screen somebody opened ten
 *                                       minutes ago (PI-ADR-004)
 *   set a lot's status directly         a status is the RESULT of a movement,
 *                                       never a column edit — the same rule
 *                                       `batchHoldRequest` states
 *   ask for names in one call           the trace answers COUNTS under
 *                                       `recall.notice.read`. The names are a
 *                                       second request, a second permission and
 *                                       a `data_access_logs` row
 *   recall a lot at another branch      RLS makes it invisible, and the service
 *                                       returns NOT FOUND rather than FORBIDDEN
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ THE SHAPES SPLIT ON EXACTLY THIS LINE, AND IT IS THE WHOLE POINT OF THE
 *   FILE. `RecallImpact` carries counts and lot numbers and names nobody.
 *   `RecallAffectedParty` carries a patient id and a patient name, is returned
 *   by ONE route, and that route is gated on `recall.trace.patients` and writes
 *   a disclosure row per read. See TRACEABILITY.md § "Patient linkage and its
 *   limits" — the link always exists in the data; who may see it is an
 *   access-control question, and whether the clinic must act on it is a
 *   regulatory one that no rule pack answers yet.
 */
import { z } from 'zod';
import { uuid, calendarDate, paginationQuery } from './common.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in recall.prisma
// ---------------------------------------------------------------------------

export const recallStatus = z.enum(['DRAFT', 'EXECUTED', 'CLOSED', 'CANCELLED']);
export const recallClassification = z.enum(['CLASS_I', 'CLASS_II', 'CLASS_III', 'UNCLASSIFIED']);
export const recallSource = z.enum(['MANUFACTURER', 'REGULATOR', 'SUPPLIER', 'INTERNAL']);
export const recallBatchStatus = z.enum(['PENDING', 'HELD', 'RELEASED', 'DISPOSED', 'NO_STOCK']);

/**
 * How a lot's presence in a recall is being resolved.
 *
 * ⚠️ `RELEASED` AND `DISPOSED` ARE NOT SYMMETRIC AND MUST NOT BE COLLAPSED.
 *   Releasing puts the quantity BACK into AVAILABLE — it says the notice did
 *   not cover this lot. Disposing takes it out of the building entirely and is
 *   the `−` movement PI-2's enum comment reserves for a physical departure.
 */
export const recallBatchResolution = z.enum(['RELEASE', 'DISPOSE']);

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

export const createRecallRequest = z.object({
  /** ⚠️ ONE PRODUCT PER NOTICE. See the model comment on `Recall`. */
  productId: uuid,
  title: z.string().trim().min(1).max(255),
  classification: recallClassification.default('UNCLASSIFIED'),
  source: recallSource,
  noticeReference: z.string().trim().max(128).nullish(),
  /** The DAY the notice was issued, in the issuer's calendar. */
  noticeOn: calendarDate.nullish(),
  reason: z.string().trim().min(1).max(4000),
  notes: z.string().trim().max(4000).nullish(),
  /**
   * The lots, by id, if they are already known.
   *
   * ⚠️ OPTIONAL, AND AN EMPTY RECALL IS VALID. A notice arrives before anybody
   *   has walked the shelves, and refusing to record it until the scope is
   *   complete is how a notice ends up on a sticky note. The scope is assembled
   *   afterwards, against `GET /v1/recalls/:id/candidates`.
   */
  batchIds: z.array(uuid).max(500).optional(),
});

export const updateRecallRequest = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  classification: recallClassification.optional(),
  source: recallSource.optional(),
  noticeReference: z.string().trim().max(128).nullish(),
  noticeOn: calendarDate.nullish(),
  reason: z.string().trim().min(1).max(4000).optional(),
  notes: z.string().trim().max(4000).nullish(),
});

/**
 * Add lots to a DRAFT recall's scope.
 *
 * ⚠️ IDS, NOT LOT NUMBERS, AND THAT IS DELIBERATE EVEN THOUGH THE NOTICE ARRIVES
 *   AS LOT NUMBERS. A lot number is the MANUFACTURER's identifier and is unique
 *   per branch, not per organization — so `AB12` at two sites is two rows, and a
 *   request naming the string would be ambiguous about which of them it meant.
 *   The candidates endpoint resolves the number to the rows; the human confirms.
 */
export const addRecallBatchesRequest = z.object({
  batchIds: z.array(uuid).min(1).max(500),
});

/**
 * Pull the stock.
 *
 * ⚠️ THERE IS NO LOT LIST HERE. Executing acts on the scope as it stands, which
 *   is what the person confirming has just been looking at. A per-call subset
 *   would mean the recall's own status ("executed") stopped describing the
 *   whole document.
 */
export const executeRecallRequest = z.object({
  /** Free text that lands on every movement's `reason_note`. */
  note: z.string().trim().max(2000).nullish(),
});

export const resolveRecallBatchRequest = z.object({
  resolution: recallBatchResolution,
  /** Required, and CHECKed in the database: a lot leaving a recall says why. */
  note: z.string().trim().min(1).max(2000),
});

export const closeRecallRequest = z.object({
  outcomeNote: z.string().trim().min(1).max(4000),
});

export const cancelRecallRequest = z.object({
  outcomeNote: z.string().trim().min(1).max(4000),
});

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

export const recallBatchDetail = z.object({
  id: uuid,
  batchId: uuid,
  branchId: uuid,
  branchName: z.string(),
  lotNumber: z.string(),
  expiresOn: calendarDate.nullable(),
  status: recallBatchStatus,
  /** In the product's base unit, as a string. Never a float. */
  quantityHeldBase: z.string().nullable(),
  /** What is STILL available at this moment — the reason to act, or not. */
  quantityAvailableBase: z.string(),
  heldAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  outcomeNote: z.string().nullable(),
});

export const recallSummary = z.object({
  id: uuid,
  reference: z.string(),
  title: z.string(),
  productId: uuid,
  productName: z.string(),
  productCode: z.string(),
  classification: recallClassification,
  source: recallSource,
  status: recallStatus,
  noticeReference: z.string().nullable(),
  noticeOn: calendarDate.nullable(),
  batchCount: z.number().int(),
  /** How many of those lots have actually been pulled. */
  heldCount: z.number().int(),
  raisedByName: z.string(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});

export const recallDetail = recallSummary.extend({
  reason: z.string(),
  notes: z.string().nullable(),
  outcomeNote: z.string().nullable(),
  executedByName: z.string().nullable(),
  closedByName: z.string().nullable(),
  baseUnitSymbol: z.string(),
  batches: z.array(recallBatchDetail),
});

export const recallQuery = paginationQuery.extend({
  status: recallStatus.optional(),
  productId: uuid.optional(),
  classification: recallClassification.optional(),
  /** Matches the clinic's reference, the notice reference or a lot number. */
  search: z.string().trim().max(128).optional(),
});

export const recallListResponse = z.object({
  items: z.array(recallSummary),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

/** A lot of the recalled product that is NOT yet in the scope. */
export const recallCandidateBatch = z.object({
  batchId: uuid,
  branchId: uuid,
  branchName: z.string(),
  lotNumber: z.string(),
  expiresOn: calendarDate.nullable(),
  batchStatus: z.string(),
  quantityOnHandBase: z.string(),
  quantityAvailableBase: z.string(),
  /** True when this lot is already named by ANOTHER live recall. */
  inOtherRecall: z.boolean(),
});

export const recallCandidatesResponse = z.object({
  productId: uuid,
  productName: z.string(),
  baseUnitSymbol: z.string(),
  items: z.array(recallCandidateBatch),
});

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

/**
 * FORWARD — "where did this go".
 *
 * ⚠️ COUNTS AND IDS ONLY. This is the shape a storekeeper sees, and it names
 *   nobody. Turning `supplyCount: 37` into thirty-seven people is
 *   `/v1/traceability/affected`, which is a different permission and a
 *   disclosure.
 */
const traceSubject = z.object({
  batchId: uuid.optional(),
  serialId: uuid.optional(),
});

/**
 * ⚠️ EXACTLY ONE SUBJECT, AND THE REFINEMENT IS NOT PEDANTRY. Neither would make
 *   the service invent a default; both would make it silently prefer one, and
 *   "why does tracing serial 7742 return the whole lot's history" is a question
 *   nobody would think to ask.
 */
const namesOneSubject = (value: {
  batchId?: string | undefined;
  serialId?: string | undefined;
}): boolean => (value.batchId === undefined) !== (value.serialId === undefined);

const ONE_SUBJECT = { message: 'Name exactly one of batchId or serialId.' };

export const forwardTraceQuery = traceSubject.refine(namesOneSubject, ONE_SUBJECT);

export const forwardTraceLocation = z.object({
  branchId: uuid,
  branchName: z.string(),
  locationId: uuid,
  locationName: z.string(),
  status: z.string(),
  quantityBase: z.string(),
});

export const forwardTraceResponse = z.object({
  batchId: uuid.nullable(),
  serialId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  productId: uuid,
  productName: z.string(),
  baseUnitSymbol: z.string(),
  /** Where it is now, by bucket. */
  onHand: z.array(forwardTraceLocation),
  quantityDispensedBase: z.string(),
  quantityConsumedBase: z.string(),
  /** How many supplies and procedures touched it, and how many people. */
  supplyCount: z.number().int(),
  procedureCount: z.number().int(),
  patientCount: z.number().int(),
  movementCount: z.number().int(),
});

/**
 * BACKWARD — "where did this come from".
 *
 * A lot to the delivery that introduced it, to the order, to the supplier. No
 * PHI anywhere in it: this direction is about paperwork, not people.
 */
export const backwardTraceQuery = traceSubject.refine(namesOneSubject, ONE_SUBJECT);

export const backwardTraceReceipt = z.object({
  goodsReceiptId: uuid,
  receiptNumber: z.string().nullable(),
  receivedAt: z.string(),
  branchId: uuid,
  branchName: z.string(),
  supplierId: uuid,
  /** Snapshotted on the receipt, so it reads as it did on the day. */
  supplierName: z.string(),
  supplierInvoiceNumber: z.string().nullable(),
  purchaseOrderId: uuid.nullable(),
  purchaseOrderNumber: z.string().nullable(),
  receivedQuantityBase: z.string(),
});

export const backwardTraceResponse = z.object({
  batchId: uuid.nullable(),
  serialId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  productId: uuid,
  productName: z.string(),
  manufacturerName: z.string().nullable(),
  manufacturedOn: calendarDate.nullable(),
  expiresOn: calendarDate.nullable(),
  baseUnitSymbol: z.string(),
  receipts: z.array(backwardTraceReceipt),
});

/**
 * ⚠️ THE PHI SHAPE. One route returns it, gated on `recall.trace.patients`, and
 *   every read writes a `data_access_logs` row with a count and no name.
 */
export const affectedPartyQuery = paginationQuery
  .extend({
    recallId: uuid.optional(),
    batchId: uuid.optional(),
    serialId: uuid.optional(),
  })
  /*
   * ⚠️ A SUBJECT IS MANDATORY. An unfiltered call would be "every patient who
   *   has ever received anything traceable", which is not a recall question and
   *   is the single largest PHI read this platform could serve.
   */
  .refine(
    (value) =>
      [value.recallId, value.batchId, value.serialId].filter((v) => v !== undefined).length === 1,
    { message: 'Name exactly one of recallId, batchId or serialId.' }
  );

export const affectedParty = z.object({
  /** `DISPENSE` or `CONSUMPTION` — how the product reached them. */
  route: z.enum(['DISPENSE', 'CONSUMPTION']),
  occurredAt: z.string(),
  branchId: uuid,
  branchName: z.string(),
  patientId: uuid,
  /** ⚠️ PHI. */
  patientName: z.string(),
  /** ⚠️ PHI. Nullable — a patient may have no number on file. */
  patientPhone: z.string().nullable(),
  patientCode: z.string(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  quantityBase: z.string(),
  sourceId: uuid,
});

export const affectedPartyResponse = z.object({
  items: z.array(affectedParty),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  baseUnitSymbol: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecallStatus = z.infer<typeof recallStatus>;
export type RecallClassification = z.infer<typeof recallClassification>;
export type RecallSource = z.infer<typeof recallSource>;
export type RecallBatchStatus = z.infer<typeof recallBatchStatus>;
export type RecallBatchResolution = z.infer<typeof recallBatchResolution>;

export type CreateRecallRequest = z.infer<typeof createRecallRequest>;
export type UpdateRecallRequest = z.infer<typeof updateRecallRequest>;
export type AddRecallBatchesRequest = z.infer<typeof addRecallBatchesRequest>;
export type ExecuteRecallRequest = z.infer<typeof executeRecallRequest>;
export type ResolveRecallBatchRequest = z.infer<typeof resolveRecallBatchRequest>;
export type CloseRecallRequest = z.infer<typeof closeRecallRequest>;
export type CancelRecallRequest = z.infer<typeof cancelRecallRequest>;

export type RecallBatchDetail = z.infer<typeof recallBatchDetail>;
export type RecallSummary = z.infer<typeof recallSummary>;
export type RecallDetail = z.infer<typeof recallDetail>;
export type RecallQuery = z.infer<typeof recallQuery>;
export type RecallListResponse = z.infer<typeof recallListResponse>;
export type RecallCandidateBatch = z.infer<typeof recallCandidateBatch>;
export type RecallCandidatesResponse = z.infer<typeof recallCandidatesResponse>;

export type ForwardTraceQuery = z.infer<typeof forwardTraceQuery>;
export type ForwardTraceLocation = z.infer<typeof forwardTraceLocation>;
export type ForwardTraceResponse = z.infer<typeof forwardTraceResponse>;
export type BackwardTraceQuery = z.infer<typeof backwardTraceQuery>;
export type BackwardTraceReceipt = z.infer<typeof backwardTraceReceipt>;
export type BackwardTraceResponse = z.infer<typeof backwardTraceResponse>;
export type AffectedPartyQuery = z.infer<typeof affectedPartyQuery>;
export type AffectedParty = z.infer<typeof affectedParty>;
export type AffectedPartyResponse = z.infer<typeof affectedPartyResponse>;
