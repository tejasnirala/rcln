/**
 * The clinical content of a consultation (CE-4): what was concluded,
 * prescribed, ordered, advised and asked for.
 *
 * ⚠️ THE DENSEST PHI IN THE PRODUCT LIVES BEHIND THIS FILE. `encounters` holds
 *   what the patient SAID; these eight tables hold what the clinic CONCLUDED
 *   about a named person. The patient rules apply unchanged and one of them
 *   harder: nothing reaches `recordAudit` except through the allow-list
 *   snapshots below, which report THAT a diagnosis was recorded and which
 *   coded term it was, never what was typed beside it.
 *
 * ── THE ONE RULE UNDERNEATH EVERY WRITER HERE ────────────────────────────────
 *
 * ⚠️ NOTHING EDITS A FINALIZED CONSULTATION (CD-2). Every function in this file
 *   loads its parent encounter and calls `assertDraft` before it touches
 *   anything — the same guard `encounter.service.ts` uses, reached through the
 *   same helper, because a second implementation of it is a second thing to
 *   forget. A signed record is corrected by an amendment, which COPIES this
 *   content onto a new encounter rather than moving it, so both records stay
 *   whole and readable for ever.
 *
 * ── WHY EVERY WRITE RETURNS THE WHOLE CONTENT ────────────────────────────────
 *
 * A response carrying only the row that changed would leave the browser
 * reconciling nine lists by hand — and one of the writes genuinely changes a
 * row in a DIFFERENT list: removing a diagnosis unlinks every procedure citing
 * it. Sending the lot means the screen never has to know which. This is not the
 * encounter autosave, which fires per keystroke and stays as small as it was.
 *
 * ── WHERE THE BRANCH COMES FROM ──────────────────────────────────────────────
 *
 * ⚠️ ALWAYS FROM THE PARENT ENCOUNTER AND NEVER FROM THE CALLER. `branch_id` is
 *   what the RLS policy reads, so a row filed at the wrong site is invisible to
 *   the people who need it and visible to people who should not have it. It is
 *   copied rather than inherited through a parent predicate for the reason the
 *   invoice children were: an org-only inherited policy under a branch-scoped
 *   parent re-opens the branch boundary.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CancelFollowUpRecommendationRequest,
  CreateEncounterAdviceRequest,
  CreateEncounterAttachmentRequest,
  CreateEncounterDiagnosisRequest,
  CreateEncounterInvestigationRequest,
  CreateEncounterPrescriptionRequest,
  CreateEncounterProcedureRequest,
  CreateEncounterReferralRequest,
  CreateEncounterSymptomRequest,
  EncounterContent,
  SetFollowUpRecommendationRequest,
  UpdateEncounterAdviceRequest,
  UpdateEncounterAttachmentRequest,
  UpdateEncounterDiagnosisRequest,
  UpdateEncounterInvestigationRequest,
  UpdateEncounterPrescriptionRequest,
  UpdateEncounterProcedureRequest,
  UpdateEncounterReferralRequest,
  UpdateEncounterSymptomRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

/** Request metadata, carried onto the audit trail. */
export interface ContentRequestOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

// ---------------------------------------------------------------------------
// Reading the content back
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE TERM IS SELECTED, NOT JOINED THROUGH A COMPOSITE RELATION. `item_id`
 *   is a PLAIN FK — a composite one would refuse the platform's vocabulary —
 *   so the relation is an ordinary single-column join and Prisma can follow it.
 *   RLS plus `item_visible` is what scopes the row.
 */
const TERM_SELECT = { select: { id: true, code: true, name: true } } as const;

const SYMPTOM_SELECT = {
  id: true,
  customText: true,
  durationValue: true,
  durationUnit: true,
  severity: true,
  frequency: true,
  site: true,
  notes: true,
  displayOrder: true,
  item: TERM_SELECT,
} as const;

const DIAGNOSIS_SELECT = {
  id: true,
  customText: true,
  role: true,
  certainty: true,
  notes: true,
  displayOrder: true,
  item: TERM_SELECT,
} as const;

const PROCEDURE_SELECT = {
  id: true,
  diagnosisId: true,
  performedOn: true,
  status: true,
  notes: true,
  displayOrder: true,
  item: TERM_SELECT,
} as const;

const PRESCRIPTION_SELECT = {
  id: true,
  strength: true,
  dose: true,
  doseUnit: true,
  route: true,
  frequency: true,
  frequencyUnit: true,
  durationValue: true,
  durationUnit: true,
  foodRelation: true,
  timing: true,
  quantity: true,
  startDate: true,
  endDate: true,
  isPrn: true,
  instructions: true,
  notes: true,
  displayOrder: true,
  product: { select: { id: true, code: true, name: true } },
} as const;

const INVESTIGATION_SELECT = {
  id: true,
  reason: true,
  priority: true,
  instructions: true,
  status: true,
  displayOrder: true,
  item: TERM_SELECT,
} as const;

const ADVICE_SELECT = {
  id: true,
  customText: true,
  isEdited: true,
  displayOrder: true,
  item: TERM_SELECT,
} as const;

const REFERRAL_SELECT = {
  id: true,
  specialtyId: true,
  doctorProfileId: true,
  externalName: true,
  reason: true,
  urgency: true,
  notes: true,
  displayOrder: true,
  specialty: { select: { name: true } },
  doctorProfile: { select: { user: { select: { fullName: true } } } },
} as const;

const ATTACHMENT_SELECT = {
  id: true,
  storedFileId: true,
  kind: true,
  caption: true,
  displayOrder: true,
  storedFile: { select: { originalName: true, mimeType: true, sizeBytes: true } },
} as const;

const RECOMMENDATION_SELECT = {
  id: true,
  encounterId: true,
  appointmentId: true,
  patientId: true,
  isRequired: true,
  intervalValue: true,
  intervalUnit: true,
  recommendedDate: true,
  followUpType: true,
  reason: true,
  notes: true,
  fulfilledByAppointmentId: true,
  fulfilledAt: true,
  cancelledAt: true,
  cancelledReason: true,
} as const;

/**
 * ⚠️ THE ORDER IS TOTAL: `display_order`, then `created_at`. Two rows sharing an
 *   order would otherwise render in whatever order Postgres happened to return,
 *   which is stable until an unrelated row is updated — and a prescription list
 *   that reshuffles between two reads of the same chart is one a clinician
 *   stops trusting. Same rule `visibleSections` states for the template.
 *
 * Not `as const`: Prisma's `orderBy` takes a mutable array.
 */
const byOrder = (): ({ displayOrder: 'asc' } | { createdAt: 'asc' })[] => [
  { displayOrder: 'asc' },
  { createdAt: 'asc' },
];

/** `2026-08-15`, from a Postgres `date`. Never a locale format. */
function isoDate(value: Date | null): string | null {
  return value === null ? null : (value.toISOString().slice(0, 10) as string);
}

/** A `Decimal` as the string the wire carries. See `decimalString`. */
function decimal(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * When a recommendation actually falls due.
 *
 * ⚠️ COMPUTED, NEVER STORED. A stored due date would be a fourth copy of the
 *   same fact, drifting the moment either input is corrected — and the recall
 *   list is the only thing that reads it.
 *
 * ⚠️ AND IT IS COUNTED FROM THE ADVICE, NOT FROM TODAY. "Come back in 15 days"
 *   said on the 1st is due on the 16th whenever anybody asks; anchoring it to
 *   the read would make every recall permanently fifteen days away.
 */
function dueOn(row: {
  isRequired: boolean;
  intervalValue: number | null;
  intervalUnit: string | null;
  recommendedDate: Date | null;
  createdAt?: Date;
}): string | null {
  if (!row.isRequired) return null;
  if (row.recommendedDate !== null) return isoDate(row.recommendedDate);
  if (row.intervalValue === null || row.intervalUnit === null) return null;

  const from = new Date(row.createdAt ?? new Date());
  const due = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (row.intervalUnit === 'DAYS') due.setUTCDate(due.getUTCDate() + row.intervalValue);
  else if (row.intervalUnit === 'WEEKS') due.setUTCDate(due.getUTCDate() + row.intervalValue * 7);
  else due.setUTCMonth(due.getUTCMonth() + row.intervalValue);
  return isoDate(due);
}

type RecommendationRow = Prisma.EncounterFollowUpRecommendationGetPayload<{
  select: typeof RECOMMENDATION_SELECT;
}> & { createdAt?: Date };

function toRecommendation(row: RecommendationRow): EncounterContent['followUp'] {
  return {
    id: row.id,
    encounterId: row.encounterId,
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    isRequired: row.isRequired,
    intervalValue: row.intervalValue,
    intervalUnit: row.intervalUnit,
    recommendedDate: isoDate(row.recommendedDate),
    dueOn: dueOn(row),
    followUpType: row.followUpType,
    reason: row.reason,
    notes: row.notes,
    fulfilledByAppointmentId: row.fulfilledByAppointmentId,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
  };
}

/**
 * Everything hanging off one consultation.
 *
 * ⚠️ EXPORTED, BECAUSE `encounter.service.ts` PUTS IT ON `EncounterDetail`. One
 *   reader for the content and one shape for it: a second assembly in the
 *   encounter service would be the same query written twice, and the two would
 *   start to disagree about ordering the first time either was touched.
 *
 * ⚠️ LOADED BY THE ENCOUNTER'S ID AND SCOPED BY RLS, never by a composite
 *   relation traversal. The CE-2 trap does not bite here — these parents are
 *   never platform rows — but the habit is what keeps it from biting later.
 */
export async function encounterContentOf(
  tx: TxClient,
  encounterId: string
): Promise<EncounterContent> {
  const where = { encounterId };
  const [
    symptoms,
    diagnoses,
    procedures,
    prescriptions,
    investigations,
    advice,
    referrals,
    attachments,
    followUp,
  ] = await Promise.all([
    tx.encounterSymptom.findMany({ where, select: SYMPTOM_SELECT, orderBy: byOrder() }),
    tx.encounterDiagnosis.findMany({ where, select: DIAGNOSIS_SELECT, orderBy: byOrder() }),
    tx.encounterProcedure.findMany({ where, select: PROCEDURE_SELECT, orderBy: byOrder() }),
    tx.encounterPrescription.findMany({
      where,
      select: PRESCRIPTION_SELECT,
      orderBy: byOrder(),
    }),
    tx.encounterInvestigation.findMany({
      where,
      select: INVESTIGATION_SELECT,
      orderBy: byOrder(),
    }),
    tx.encounterAdvice.findMany({ where, select: ADVICE_SELECT, orderBy: byOrder() }),
    tx.encounterReferral.findMany({ where, select: REFERRAL_SELECT, orderBy: byOrder() }),
    tx.encounterAttachment.findMany({ where, select: ATTACHMENT_SELECT, orderBy: byOrder() }),
    /*
     * ⚠️ THE ONE THAT IS NOT A LIST. A consultation states its follow-up plan
     *   once; `deletedAt` is checked because a superseded plan is soft-deleted
     *   rather than removed — "the doctor changed their mind" is itself part of
     *   the record.
     */
    tx.encounterFollowUpRecommendation.findFirst({
      where: { encounterId, deletedAt: null },
      select: { ...RECOMMENDATION_SELECT, createdAt: true },
    }),
  ]);

  return {
    symptoms: symptoms.map((row) => ({
      id: row.id,
      item: row.item,
      customText: row.customText,
      durationValue: row.durationValue,
      durationUnit: row.durationUnit,
      severity: row.severity,
      frequency: row.frequency,
      site: row.site,
      notes: row.notes,
      displayOrder: row.displayOrder,
    })),
    diagnoses: diagnoses.map((row) => ({
      id: row.id,
      item: row.item,
      customText: row.customText,
      role: row.role,
      certainty: row.certainty,
      notes: row.notes,
      displayOrder: row.displayOrder,
    })),
    procedures: procedures.map((row) => ({
      id: row.id,
      item: row.item,
      diagnosisId: row.diagnosisId,
      performedOn: isoDate(row.performedOn),
      status: row.status,
      notes: row.notes,
      displayOrder: row.displayOrder,
    })),
    prescriptions: prescriptions.map((row) => ({
      id: row.id,
      product: row.product,
      strength: row.strength,
      dose: decimal(row.dose),
      doseUnit: row.doseUnit,
      route: row.route,
      frequency: row.frequency,
      frequencyUnit: row.frequencyUnit,
      durationValue: row.durationValue,
      durationUnit: row.durationUnit,
      foodRelation: row.foodRelation,
      timing: row.timing,
      quantity: decimal(row.quantity),
      startDate: isoDate(row.startDate),
      endDate: isoDate(row.endDate),
      isPrn: row.isPrn,
      instructions: row.instructions,
      notes: row.notes,
      displayOrder: row.displayOrder,
    })),
    investigations: investigations.map((row) => ({
      id: row.id,
      item: row.item,
      reason: row.reason,
      priority: row.priority,
      instructions: row.instructions,
      status: row.status,
      displayOrder: row.displayOrder,
    })),
    advice: advice.map((row) => ({
      id: row.id,
      item: row.item,
      customText: row.customText,
      isEdited: row.isEdited,
      displayOrder: row.displayOrder,
    })),
    referrals: referrals.map((row) => ({
      id: row.id,
      specialtyId: row.specialtyId,
      specialtyName: row.specialty?.name ?? null,
      doctorProfileId: row.doctorProfileId,
      doctorName: row.doctorProfile?.user.fullName ?? null,
      externalName: row.externalName,
      reason: row.reason,
      urgency: row.urgency,
      notes: row.notes,
      displayOrder: row.displayOrder,
    })),
    attachments: attachments.map((row) => ({
      id: row.id,
      storedFileId: row.storedFileId,
      kind: row.kind,
      caption: row.caption,
      originalName: row.storedFile?.originalName ?? '',
      mimeType: row.storedFile?.mimeType ?? '',
      /* ⚠️ A BigInt does not survive JSON. Files are megabytes, not exabytes. */
      sizeBytes: Number(row.storedFile?.sizeBytes ?? 0n),
      displayOrder: row.displayOrder,
    })),
    followUp: followUp === null ? null : toRecommendation(followUp),
  };
}

// ---------------------------------------------------------------------------
// The guards every writer shares
// ---------------------------------------------------------------------------

interface DraftParent {
  id: string;
  branchId: string;
  patientId: string;
  appointmentId: string | null;
  status: string;
}

/**
 * The consultation this content belongs to, checked and open for writing.
 *
 * ⚠️ THREE CHECKS, AND EACH FAILS DIFFERENTLY ON PURPOSE. A missing encounter
 *   and one at a branch outside the caller's scope both answer 404, because
 *   whether a consultation exists at another site is itself tenant
 *   information. A FINALIZED one answers 409 with the sentence that says what
 *   to do instead — the correction is an amendment, and a clinician told
 *   "forbidden" would try again rather than amending.
 */
async function draftParent(
  tx: TxClient,
  ctx: TenantContext,
  encounterId: string
): Promise<DraftParent> {
  const row = await tx.encounter.findFirst({
    where: { id: encounterId, deletedAt: null },
    select: { id: true, branchId: true, patientId: true, appointmentId: true, status: true },
  });
  if (!row) throw new NotFoundError('Encounter');
  if (!ctx.branchIds.includes(row.branchId)) throw new NotFoundError('Encounter');

  if (row.status !== 'DRAFT') {
    if (row.status === 'CANCELLED') throw new ConflictError('This consultation was cancelled.');
    throw new ConflictError(
      'This consultation has been signed. Correct it by recording an amendment, which keeps both records.'
    );
  }
  return row;
}

/**
 * Where the next row in a list goes.
 *
 * ⚠️ COUNTED SERVER-SIDE RATHER THAN SENT BY THE CLIENT. A browser deriving an
 *   order from its own array index writes the whole list back on every add, and
 *   two tabs adding at once each believe they are third.
 */
async function nextOrder(count: Promise<number>, requested: number | undefined): Promise<number> {
  return requested ?? (await count) * 10;
}

/** The columns every child carries, taken from the parent and never the caller. */
function ownership(
  ctx: TenantContext,
  parent: DraftParent
): { organizationId: string; branchId: string; encounterId: string } {
  return {
    organizationId: ctx.organizationId,
    branchId: parent.branchId,
    encounterId: parent.id,
  };
}

/**
 * ⚠️ THE AUDIT SNAPSHOT FOR EVERY CONTENT ROW, AND IT CARRIES NO FREE TEXT.
 *   Which coded term was recorded is an id — meaningless without the chart, and
 *   the fact an auditor actually asks about. What the clinician typed beside it
 *   belongs to whoever may read the record. DO NOT WIDEN THIS.
 */
function contentSnapshot(
  kind: string,
  row: { id: string; itemId?: string | null; productId?: string | null }
): Record<string, unknown> {
  return {
    id: row.id,
    kind,
    ...(row.itemId !== undefined ? { itemId: row.itemId } : {}),
    ...(row.productId !== undefined ? { productId: row.productId } : {}),
  };
}

/**
 * Every content write is audited the same way, and the entity type is the
 * table's noun so the history screen can group them.
 */
async function auditContent(
  tx: TxClient,
  ctx: TenantContext,
  parent: DraftParent,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityType: string,
  entityId: string,
  snapshot: Record<string, unknown>,
  options: ContentRequestOptions
): Promise<void> {
  await recordAudit(tx, ctx, {
    action,
    entityType,
    entityId,
    ...(action === 'DELETE' ? { before: snapshot } : { after: snapshot }),
    branchId: parent.branchId,
    ...options,
  });
}

/**
 * A `null` clears the column, an absent key leaves it alone.
 *
 * ⚠️ THE TWO ARE NOT THE SAME AND CONFLATING THEM IS THE BUG THIS EXISTS TO
 *   PREVENT. A clinician who deletes the severity they set must be able to;
 *   treating `undefined` as "clear it" would wipe every field a partial update
 *   did not mention.
 */
function patch<T>(value: T | null | undefined): { set: T | null } | undefined {
  return value === undefined ? undefined : { set: value ?? null };
}

/** `patch`, flattened for Prisma's scalar update shape. */
function assign<T extends Record<string, unknown>>(
  input: T,
  keys: readonly (keyof T)[]
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    const wrapped = patch(input[key]);
    if (wrapped !== undefined) data[key as string] = wrapped.set;
  }
  return data;
}

/** A `YYYY-MM-DD` as the UTC midnight Postgres stores in a `date`. */
function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

export async function addSymptom(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterSymptomRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const displayOrder = await nextOrder(
      tx.encounterSymptom.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterSymptom.create({
      data: {
        ...ownership(ctx, parent),
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        ...(input.customText !== undefined ? { customText: input.customText } : {}),
        ...(input.durationValue != null ? { durationValue: input.durationValue } : {}),
        ...(input.durationUnit != null ? { durationUnit: input.durationUnit } : {}),
        ...(input.severity != null ? { severity: input.severity } : {}),
        ...(input.frequency != null ? { frequency: input.frequency } : {}),
        ...(input.site != null ? { site: input.site } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
        displayOrder,
      },
      select: { id: true, itemId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_symptom',
      created.id,
      contentSnapshot('SYMPTOM', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updateSymptom(
  ctx: TenantContext,
  encounterId: string,
  symptomId: string,
  input: UpdateEncounterSymptomRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterSymptom.findFirst({
      where: { id: symptomId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Symptom');

    await tx.encounterSymptom.update({
      where: { id: existing.id },
      data: assign(input, [
        'durationValue',
        'durationUnit',
        'severity',
        'frequency',
        'site',
        'notes',
        'displayOrder',
      ]),
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_symptom',
      existing.id,
      contentSnapshot('SYMPTOM', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removeSymptom(
  ctx: TenantContext,
  encounterId: string,
  symptomId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterSymptom.findFirst({
      where: { id: symptomId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Symptom');

    await tx.encounterSymptom.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_symptom',
      existing.id,
      contentSnapshot('SYMPTOM', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE PARTIAL UNIQUE INDEX IS WHAT ENFORCES ONE PRIMARY, AND THIS CHECK IS
 *   WHAT TURNS ITS VIOLATION INTO A SENTENCE. Without the read the clinician
 *   gets a 500 from a constraint name; with it they are told there is already a
 *   primary diagnosis and which one. The index is still the guarantee — under a
 *   race the second INSERT fails on it rather than succeeding quietly.
 */
async function assertNoOtherPrimary(
  tx: TxClient,
  encounterId: string,
  role: string | undefined,
  exceptId?: string
): Promise<void> {
  if (role !== 'PRIMARY') return;
  const clash = await tx.encounterDiagnosis.findFirst({
    where: {
      encounterId,
      role: 'PRIMARY',
      ...(exceptId !== undefined ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash !== null) {
    throw new ConflictError(
      'This consultation already has a primary diagnosis. Change that one first, or record this as secondary.'
    );
  }
}

export async function addDiagnosis(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterDiagnosisRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    await assertNoOtherPrimary(tx, parent.id, input.role);
    const displayOrder = await nextOrder(
      tx.encounterDiagnosis.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterDiagnosis.create({
      data: {
        ...ownership(ctx, parent),
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        ...(input.customText !== undefined ? { customText: input.customText } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.certainty !== undefined ? { certainty: input.certainty } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
        displayOrder,
      },
      select: { id: true, itemId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_diagnosis',
      created.id,
      contentSnapshot('DIAGNOSIS', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updateDiagnosis(
  ctx: TenantContext,
  encounterId: string,
  diagnosisId: string,
  input: UpdateEncounterDiagnosisRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterDiagnosis.findFirst({
      where: { id: diagnosisId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Diagnosis');
    await assertNoOtherPrimary(tx, parent.id, input.role, existing.id);

    await tx.encounterDiagnosis.update({
      where: { id: existing.id },
      data: assign(input, ['role', 'certainty', 'notes', 'displayOrder']),
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_diagnosis',
      existing.id,
      contentSnapshot('DIAGNOSIS', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

/**
 * ⚠️ THE PROCEDURES CITING IT ARE UNLINKED FIRST, AND THAT IS NOT A CONVENIENCE.
 *   The FK is `Restrict` because the composite includes `organization_id`,
 *   which is NOT NULL, so Postgres cannot SetNull the pair — the same
 *   constraint `appointments.parent_appointment_id` lives under. Deleting
 *   without unlinking would give the clinician a foreign-key violation for an
 *   action that is entirely reasonable.
 *
 *   Unlinking rather than cascading is also the honest clinical outcome: what
 *   was DONE stays on the record, and only the claim about why it was done
 *   goes.
 */
export async function removeDiagnosis(
  ctx: TenantContext,
  encounterId: string,
  diagnosisId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterDiagnosis.findFirst({
      where: { id: diagnosisId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Diagnosis');

    await tx.encounterProcedure.updateMany({
      where: { encounterId: parent.id, diagnosisId: existing.id },
      data: { diagnosisId: null },
    });
    await tx.encounterDiagnosis.delete({ where: { id: existing.id } });

    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_diagnosis',
      existing.id,
      contentSnapshot('DIAGNOSIS', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE DIAGNOSIS MUST BELONG TO THIS CONSULTATION, and the composite FK does
 *   not say so on its own — it only says "same tenant". A procedure citing a
 *   diagnosis from a different visit is a claim the chart cannot render and the
 *   shape a copied id produces.
 */
async function assertDiagnosisIsOurs(
  tx: TxClient,
  encounterId: string,
  diagnosisId: string | null | undefined
): Promise<void> {
  if (diagnosisId == null) return;
  const found = await tx.encounterDiagnosis.findFirst({
    where: { id: diagnosisId, encounterId },
    select: { id: true },
  });
  if (!found) throw new NotFoundError('Diagnosis');
}

export async function addProcedure(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterProcedureRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    await assertDiagnosisIsOurs(tx, parent.id, input.diagnosisId);
    const displayOrder = await nextOrder(
      tx.encounterProcedure.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterProcedure.create({
      data: {
        ...ownership(ctx, parent),
        itemId: input.itemId,
        ...(input.diagnosisId != null ? { diagnosisId: input.diagnosisId } : {}),
        ...(input.performedOn != null ? { performedOn: toDate(input.performedOn) as Date } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
        displayOrder,
      },
      select: { id: true, itemId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_procedure',
      created.id,
      contentSnapshot('PROCEDURE', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updateProcedure(
  ctx: TenantContext,
  encounterId: string,
  procedureId: string,
  input: UpdateEncounterProcedureRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterProcedure.findFirst({
      where: { id: procedureId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Procedure');
    await assertDiagnosisIsOurs(tx, parent.id, input.diagnosisId);

    await tx.encounterProcedure.update({
      where: { id: existing.id },
      data: {
        ...assign(input, ['diagnosisId', 'status', 'notes', 'displayOrder']),
        ...(input.performedOn !== undefined
          ? { performedOn: toDate(input.performedOn) ?? null }
          : {}),
      },
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_procedure',
      existing.id,
      contentSnapshot('PROCEDURE', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removeProcedure(
  ctx: TenantContext,
  encounterId: string,
  procedureId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterProcedure.findFirst({
      where: { id: procedureId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Procedure');

    await tx.encounterProcedure.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_procedure',
      existing.id,
      contentSnapshot('PROCEDURE', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

const PRESCRIPTION_FIELDS = [
  'strength',
  'doseUnit',
  'route',
  'frequency',
  'frequencyUnit',
  'durationValue',
  'durationUnit',
  'foodRelation',
  'timing',
  'isPrn',
  'instructions',
  'notes',
  'displayOrder',
] as const;

/**
 * ⚠️ THE PRODUCT IS CHECKED HERE AS WELL AS BY `product_visible`, AND THE TWO
 *   ANSWER DIFFERENT QUESTIONS. The RLS policy stops a clinic citing ANOTHER
 *   TENANT'S medicine — it is the tenancy boundary and it is not optional. This
 *   read stops a clinic prescribing a WITHDRAWN one, which is its own decision
 *   about its own catalogue and is not RLS's business.
 */
async function assertProductPrescribable(tx: TxClient, productId: string): Promise<void> {
  const product = await tx.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!product) throw new NotFoundError('Product');
  if (product.status === 'WITHDRAWN') {
    throw new ConflictError('That medicine has been withdrawn and cannot be prescribed.');
  }
}

export async function addPrescription(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterPrescriptionRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    await assertProductPrescribable(tx, input.productId);
    const displayOrder = await nextOrder(
      tx.encounterPrescription.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterPrescription.create({
      data: {
        ...ownership(ctx, parent),
        productId: input.productId,
        ...(input.strength != null ? { strength: input.strength } : {}),
        ...(input.dose != null ? { dose: input.dose } : {}),
        ...(input.doseUnit != null ? { doseUnit: input.doseUnit } : {}),
        ...(input.route != null ? { route: input.route } : {}),
        ...(input.frequency != null ? { frequency: input.frequency } : {}),
        ...(input.frequencyUnit != null ? { frequencyUnit: input.frequencyUnit } : {}),
        ...(input.durationValue != null ? { durationValue: input.durationValue } : {}),
        ...(input.durationUnit != null ? { durationUnit: input.durationUnit } : {}),
        ...(input.foodRelation != null ? { foodRelation: input.foodRelation } : {}),
        ...(input.timing != null ? { timing: input.timing } : {}),
        ...(input.quantity != null ? { quantity: input.quantity } : {}),
        ...(input.startDate != null ? { startDate: toDate(input.startDate) as Date } : {}),
        ...(input.endDate != null ? { endDate: toDate(input.endDate) as Date } : {}),
        ...(input.isPrn !== undefined ? { isPrn: input.isPrn } : {}),
        ...(input.instructions != null ? { instructions: input.instructions } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
        displayOrder,
      },
      select: { id: true, productId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_prescription',
      created.id,
      contentSnapshot('PRESCRIPTION', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updatePrescription(
  ctx: TenantContext,
  encounterId: string,
  prescriptionId: string,
  input: UpdateEncounterPrescriptionRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterPrescription.findFirst({
      where: { id: prescriptionId, encounterId: parent.id },
      select: { id: true, productId: true },
    });
    if (!existing) throw new NotFoundError('Prescription');

    await tx.encounterPrescription.update({
      where: { id: existing.id },
      data: {
        ...assign(input, PRESCRIPTION_FIELDS),
        ...(input.dose !== undefined ? { dose: input.dose ?? null } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity ?? null } : {}),
        ...(input.startDate !== undefined ? { startDate: toDate(input.startDate) ?? null } : {}),
        ...(input.endDate !== undefined ? { endDate: toDate(input.endDate) ?? null } : {}),
      },
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_prescription',
      existing.id,
      contentSnapshot('PRESCRIPTION', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removePrescription(
  ctx: TenantContext,
  encounterId: string,
  prescriptionId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterPrescription.findFirst({
      where: { id: prescriptionId, encounterId: parent.id },
      select: { id: true, productId: true },
    });
    if (!existing) throw new NotFoundError('Prescription');

    await tx.encounterPrescription.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_prescription',
      existing.id,
      contentSnapshot('PRESCRIPTION', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

export async function addInvestigation(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterInvestigationRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const displayOrder = await nextOrder(
      tx.encounterInvestigation.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterInvestigation.create({
      data: {
        ...ownership(ctx, parent),
        itemId: input.itemId,
        ...(input.reason != null ? { reason: input.reason } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.instructions != null ? { instructions: input.instructions } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        displayOrder,
      },
      select: { id: true, itemId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_investigation',
      created.id,
      contentSnapshot('INVESTIGATION', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updateInvestigation(
  ctx: TenantContext,
  encounterId: string,
  investigationId: string,
  input: UpdateEncounterInvestigationRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterInvestigation.findFirst({
      where: { id: investigationId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Investigation');

    await tx.encounterInvestigation.update({
      where: { id: existing.id },
      data: assign(input, ['reason', 'priority', 'instructions', 'status', 'displayOrder']),
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_investigation',
      existing.id,
      contentSnapshot('INVESTIGATION', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removeInvestigation(
  ctx: TenantContext,
  encounterId: string,
  investigationId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterInvestigation.findFirst({
      where: { id: investigationId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Investigation');

    await tx.encounterInvestigation.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_investigation',
      existing.id,
      contentSnapshot('INVESTIGATION', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

export async function addAdvice(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterAdviceRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const displayOrder = await nextOrder(
      tx.encounterAdvice.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterAdvice.create({
      data: {
        ...ownership(ctx, parent),
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        ...(input.customText !== undefined ? { customText: input.customText } : {}),
        /*
         * ⚠️ FALSE ON CREATE, ALWAYS. Advice typed from scratch is not "edited
         *   library advice" — the flag exists to tell a clinic which of ITS
         *   standard advice reaches patients unchanged, and a custom entry was
         *   never standard advice to begin with.
         */
        isEdited: false,
        displayOrder,
      },
      select: { id: true, itemId: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_advice',
      created.id,
      contentSnapshot('ADVICE', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

/**
 * Tailor a piece of advice.
 *
 * ⚠️ THE ONE UPDATE IN THIS FILE THAT TOUCHES THE TEXT, AND THE ONLY PLACE
 *   `isEdited` IS SET. "Brushing technique" becoming "brushing technique, and
 *   stop using the hard brush" is the ordinary case. The flag is derived here
 *   rather than accepted from the caller, because a client-supplied one would
 *   be an assertion nothing checks.
 *
 * ⚠️ AND IT MOVES THE ROW FROM CODED TO TYPED, WHICH THE CHECK CONSTRAINT
 *   REQUIRES. `num_nonnulls(item_id, custom_text) = 1`: tailoring library
 *   advice means the row now says the clinician's words, so the item pointer is
 *   cleared. Which library entry it started from is the audit row.
 */
export async function updateAdvice(
  ctx: TenantContext,
  encounterId: string,
  adviceId: string,
  input: UpdateEncounterAdviceRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterAdvice.findFirst({
      where: { id: adviceId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Advice');

    await tx.encounterAdvice.update({
      where: { id: existing.id },
      data: {
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.customText !== undefined
          ? { customText: input.customText, itemId: null, isEdited: existing.itemId !== null }
          : {}),
      },
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_advice',
      existing.id,
      contentSnapshot('ADVICE', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removeAdvice(
  ctx: TenantContext,
  encounterId: string,
  adviceId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterAdvice.findFirst({
      where: { id: adviceId, encounterId: parent.id },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('Advice');

    await tx.encounterAdvice.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_advice',
      existing.id,
      contentSnapshot('ADVICE', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export async function addReferral(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterReferralRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);

    /*
     * ⚠️ A REFERRAL TO ONESELF IS A CONFIGURATION ERROR RATHER THAN A CLINICAL
     *   STATEMENT, but it is not refused here: a doctor legitimately refers a
     *   patient to their OWN other clinic sitting under a second profile. What
     *   IS checked is that the colleague exists in this organization at all —
     *   the composite FK says the same thing, and this turns its violation into
     *   a 404 rather than a 500.
     */
    if (input.doctorProfileId != null) {
      const doctor = await tx.doctorProfile.findFirst({
        where: { id: input.doctorProfileId, deletedAt: null },
        select: { id: true },
      });
      if (!doctor) throw new NotFoundError('Doctor');
    }

    const displayOrder = await nextOrder(
      tx.encounterReferral.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterReferral.create({
      data: {
        ...ownership(ctx, parent),
        ...(input.specialtyId != null ? { specialtyId: input.specialtyId } : {}),
        ...(input.doctorProfileId != null ? { doctorProfileId: input.doctorProfileId } : {}),
        ...(input.externalName != null ? { externalName: input.externalName } : {}),
        ...(input.reason != null ? { reason: input.reason } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
        displayOrder,
      },
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_referral',
      created.id,
      contentSnapshot('REFERRAL', created),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

/**
 * ⚠️ THE DESTINATION IS NOT EDITABLE — see the contract. Sending a patient to a
 *   different clinician is a different referral, and editing one in place would
 *   leave the record saying the first destination was never named.
 */
export async function updateReferral(
  ctx: TenantContext,
  encounterId: string,
  referralId: string,
  input: UpdateEncounterReferralRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterReferral.findFirst({
      where: { id: referralId, encounterId: parent.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('Referral');

    await tx.encounterReferral.update({
      where: { id: existing.id },
      data: assign(input, ['reason', 'urgency', 'notes', 'displayOrder']),
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_referral',
      existing.id,
      contentSnapshot('REFERRAL', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function removeReferral(
  ctx: TenantContext,
  encounterId: string,
  referralId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterReferral.findFirst({
      where: { id: referralId, encounterId: parent.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('Referral');

    await tx.encounterReferral.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_referral',
      existing.id,
      contentSnapshot('REFERRAL', existing),
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Attach a file that has already been uploaded.
 *
 * ⚠️ THE BYTES DO NOT COME THROUGH HERE (§27). The upload goes to the documents
 *   surface, which owns providers, checksums and the `files` row; this says
 *   that a stored file belongs to this consultation and what it is clinically.
 *
 * ⚠️ AND THE FILE IS RE-TYPED AS `CLINICAL_ATTACHMENT`. It arrives as an
 *   `UPLOAD`, because at upload time nothing knew what it was for. The two
 *   are retained differently and exported differently in a subject-access
 *   request, so the moment the chart claims a file is the moment its type
 *   becomes true.
 */
export async function addAttachment(
  ctx: TenantContext,
  encounterId: string,
  input: CreateEncounterAttachmentRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);

    const file = await tx.storedFile.findFirst({
      where: { id: input.storedFileId, deletedAt: null },
      select: { id: true, status: true, organizationId: true },
    });
    if (!file) throw new NotFoundError('File');
    /*
     * ⚠️ A PLATFORM FILE CANNOT BE ATTACHED, and the composite FK refuses it
     *   anyway. Turning that into a sentence here is the difference between a
     *   clinician being told what happened and a 500.
     */
    if (file.organizationId !== ctx.organizationId) throw new NotFoundError('File');
    if (file.status !== 'READY') {
      throw new ConflictError('That file has not finished uploading yet.');
    }

    const already = await tx.encounterAttachment.findFirst({
      where: { encounterId: parent.id, storedFileId: file.id },
      select: { id: true },
    });
    if (already !== null) {
      /* Idempotent: a double-click is not a second attachment. */
      return encounterContentOf(tx, parent.id);
    }

    const displayOrder = await nextOrder(
      tx.encounterAttachment.count({ where: { encounterId: parent.id } }),
      input.displayOrder
    );

    const created = await tx.encounterAttachment.create({
      data: {
        ...ownership(ctx, parent),
        storedFileId: file.id,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.caption != null ? { caption: input.caption } : {}),
        displayOrder,
      },
      select: { id: true },
    });

    await tx.storedFile.update({
      where: { id: file.id },
      data: { documentType: 'CLINICAL_ATTACHMENT' },
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_attachment',
      created.id,
      { id: created.id, kind: 'ATTACHMENT', storedFileId: file.id },
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

export async function updateAttachment(
  ctx: TenantContext,
  encounterId: string,
  attachmentId: string,
  input: UpdateEncounterAttachmentRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterAttachment.findFirst({
      where: { id: attachmentId, encounterId: parent.id },
      select: { id: true, storedFileId: true },
    });
    if (!existing) throw new NotFoundError('Attachment');

    await tx.encounterAttachment.update({
      where: { id: existing.id },
      data: assign(input, ['kind', 'caption', 'displayOrder']),
      select: { id: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'UPDATE',
      'encounter_attachment',
      existing.id,
      { id: existing.id, kind: 'ATTACHMENT', storedFileId: existing.storedFileId },
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

/**
 * ⚠️ THE LINK GOES AND THE FILE STAYS. Deleting the bytes from here would let
 *   one careless click destroy a clinical photograph that a finalized
 *   amendment's copy also cites — and the `files` row is the documents
 *   surface's to retire, not the chart's.
 */
export async function removeAttachment(
  ctx: TenantContext,
  encounterId: string,
  attachmentId: string,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    const existing = await tx.encounterAttachment.findFirst({
      where: { id: attachmentId, encounterId: parent.id },
      select: { id: true, storedFileId: true },
    });
    if (!existing) throw new NotFoundError('Attachment');

    await tx.encounterAttachment.delete({ where: { id: existing.id } });
    await auditContent(
      tx,
      ctx,
      parent,
      'DELETE',
      'encounter_attachment',
      existing.id,
      { id: existing.id, kind: 'ATTACHMENT', storedFileId: existing.storedFileId },
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

// ---------------------------------------------------------------------------
// The follow-up recommendation (CD-13)
// ---------------------------------------------------------------------------

/**
 * State the follow-up plan. One per consultation, so this replaces.
 *
 * ⚠️ IT NEEDS AN APPOINTMENT, AND A WALK-IN HAS NONE (CD-1). The table
 *   denormalises `appointment_id` so the recall list can be assembled without
 *   joining through the encounter, and the column is NOT NULL. That is a real
 *   limitation stated honestly rather than worked around: a walk-in consultation
 *   cannot yet record a recommendation, and the sentence says so.
 *
 * ⚠️ THE PREVIOUS PLAN IS SOFT-DELETED RATHER THAN OVERWRITTEN. "The doctor
 *   said 15 days and then changed it to 30" is part of the record; an UPDATE in
 *   place would leave the chart claiming 30 was always the plan.
 *
 * ⚠️ AND A FULFILLED RECOMMENDATION IS NOT REPLACED. Once a patient has booked
 *   against it, the advice they booked against is a fact about a booking that
 *   happened — restating it would leave that appointment fulfilling a
 *   recommendation nobody ever made.
 */
export async function setFollowUpRecommendation(
  ctx: TenantContext,
  encounterId: string,
  input: SetFollowUpRecommendationRequest,
  options: ContentRequestOptions = {}
): Promise<EncounterContent> {
  return withTenant(ctx, async (tx) => {
    const parent = await draftParent(tx, ctx, encounterId);
    if (parent.appointmentId === null) {
      throw new ValidationError(
        'A follow-up can only be recommended from a booked visit. Book this walk-in first.'
      );
    }

    const existing = await tx.encounterFollowUpRecommendation.findFirst({
      where: { encounterId: parent.id, deletedAt: null },
      select: { id: true, fulfilledByAppointmentId: true },
    });
    if (existing !== null) {
      if (existing.fulfilledByAppointmentId !== null) {
        throw new ConflictError(
          'The patient has already booked against this recommendation, so it cannot be restated.'
        );
      }
      await tx.encounterFollowUpRecommendation.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
    }

    const created = await tx.encounterFollowUpRecommendation.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: parent.branchId,
        encounterId: parent.id,
        appointmentId: parent.appointmentId,
        patientId: parent.patientId,
        isRequired: input.isRequired,
        ...(input.intervalValue != null ? { intervalValue: input.intervalValue } : {}),
        ...(input.intervalUnit != null ? { intervalUnit: input.intervalUnit } : {}),
        ...(input.recommendedDate != null
          ? { recommendedDate: toDate(input.recommendedDate) as Date }
          : {}),
        ...(input.followUpType !== undefined ? { followUpType: input.followUpType } : {}),
        ...(input.reason != null ? { reason: input.reason } : {}),
        ...(input.notes != null ? { notes: input.notes } : {}),
      },
      select: { id: true, isRequired: true },
    });

    await auditContent(
      tx,
      ctx,
      parent,
      'CREATE',
      'encounter_follow_up_recommendation',
      created.id,
      {
        id: created.id,
        isRequired: created.isRequired,
        /* THAT a reason was given, never the sentence. */
        hasReason: input.reason != null && input.reason !== '',
      },
      options
    );
    return encounterContentOf(tx, parent.id);
  });
}

/**
 * The patient declined, or the plan changed before they booked.
 *
 * ⚠️ RECORDED RATHER THAN DELETED. "We asked and they said no" is the answer to
 *   a recall chase; a deleted row makes the desk ring them again next month.
 *
 * ⚠️ AND THIS IS THE ONE CONTENT WRITER THAT WORKS ON A FINALIZED
 *   CONSULTATION, deliberately. Declining is something that happens WEEKS after
 *   the visit, at the front desk, and it is a fact about the recommendation's
 *   fate rather than an edit to the clinical record — exactly as fulfilment is.
 *   Nothing the doctor wrote changes.
 */
export async function cancelFollowUpRecommendation(
  ctx: TenantContext,
  recommendationId: string,
  input: CancelFollowUpRecommendationRequest,
  options: ContentRequestOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.encounterFollowUpRecommendation.findFirst({
      where: { id: recommendationId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        cancelledAt: true,
        fulfilledByAppointmentId: true,
      },
    });
    if (!row) throw new NotFoundError('Follow-up recommendation');
    if (!ctx.branchIds.includes(row.branchId)) throw new NotFoundError('Follow-up recommendation');
    if (row.fulfilledByAppointmentId !== null) {
      throw new ConflictError('The patient has already booked this follow-up.');
    }
    /* Idempotent: cancelling twice is a double-click. */
    if (row.cancelledAt !== null) return;

    await tx.encounterFollowUpRecommendation.update({
      where: { id: row.id },
      data: {
        cancelledAt: new Date(),
        ...(ctx.userId !== undefined ? { cancelledBy: ctx.userId } : {}),
        ...(input.reason !== undefined ? { cancelledReason: input.reason } : {}),
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'encounter_follow_up_recommendation',
      entityId: row.id,
      after: { id: row.id, cancelled: true, hasReason: input.reason !== undefined },
      branchId: row.branchId,
      ...options,
    });
  });
}

// ---------------------------------------------------------------------------
// Copying content onto an amendment (CD-2)
// ---------------------------------------------------------------------------

/**
 * Copy one consultation's content onto its amendment.
 *
 * ⚠️ COPIED, NEVER MOVED. The record being corrected keeps everything it was
 *   signed with — that is the entire difference between an amendment and an
 *   edit, and it is why both rows stay readable for ever.
 *
 * ⚠️ AND THE DIAGNOSIS LINKS ARE REMAPPED. `encounter_procedures.diagnosis_id`
 *   points at a row in the list beside it; a straight copy would leave every
 *   procedure on the amendment citing a diagnosis on the ORIGINAL, which the
 *   composite FK happily permits — same tenant, same shape — and which renders
 *   as "this procedure treats a diagnosis that is not on this consultation".
 *   The old-to-new map is what this function is really for.
 *
 * ⚠️ THE FOLLOW-UP RECOMMENDATION IS NOT COPIED. It is denormalised onto the
 *   appointment and carries a fulfilment link; two live rows for one visit
 *   would give the recall list two answers. The amendment states its own plan,
 *   which is the honest outcome — restating the record is exactly when the plan
 *   might change.
 */
export async function copyContentToAmendment(
  tx: TxClient,
  ctx: TenantContext,
  from: { id: string },
  to: { id: string; branchId: string }
): Promise<void> {
  const own = {
    organizationId: ctx.organizationId,
    branchId: to.branchId,
    encounterId: to.id,
  };

  const symptoms = await tx.encounterSymptom.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of symptoms) {
    await tx.encounterSymptom.create({
      data: {
        ...own,
        itemId: row.itemId,
        customText: row.customText,
        durationValue: row.durationValue,
        durationUnit: row.durationUnit,
        severity: row.severity,
        frequency: row.frequency,
        site: row.site,
        notes: row.notes,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const diagnoses = await tx.encounterDiagnosis.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  /* The map that keeps every procedure pointing at the right diagnosis. */
  const newDiagnosisId = new Map<string, string>();
  for (const row of diagnoses) {
    const copy = await tx.encounterDiagnosis.create({
      data: {
        ...own,
        itemId: row.itemId,
        customText: row.customText,
        role: row.role,
        certainty: row.certainty,
        notes: row.notes,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
    newDiagnosisId.set(row.id, copy.id);
  }

  const procedures = await tx.encounterProcedure.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of procedures) {
    await tx.encounterProcedure.create({
      data: {
        ...own,
        itemId: row.itemId,
        diagnosisId:
          row.diagnosisId === null ? null : (newDiagnosisId.get(row.diagnosisId) ?? null),
        performedOn: row.performedOn,
        status: row.status,
        notes: row.notes,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const prescriptions = await tx.encounterPrescription.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of prescriptions) {
    await tx.encounterPrescription.create({
      data: {
        ...own,
        productId: row.productId,
        strength: row.strength,
        dose: row.dose,
        doseUnit: row.doseUnit,
        route: row.route,
        frequency: row.frequency,
        frequencyUnit: row.frequencyUnit,
        durationValue: row.durationValue,
        durationUnit: row.durationUnit,
        foodRelation: row.foodRelation,
        timing: row.timing,
        quantity: row.quantity,
        startDate: row.startDate,
        endDate: row.endDate,
        isPrn: row.isPrn,
        instructions: row.instructions,
        notes: row.notes,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const investigations = await tx.encounterInvestigation.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of investigations) {
    await tx.encounterInvestigation.create({
      data: {
        ...own,
        itemId: row.itemId,
        reason: row.reason,
        priority: row.priority,
        instructions: row.instructions,
        status: row.status,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const advice = await tx.encounterAdvice.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of advice) {
    await tx.encounterAdvice.create({
      data: {
        ...own,
        itemId: row.itemId,
        customText: row.customText,
        isEdited: row.isEdited,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const referrals = await tx.encounterReferral.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of referrals) {
    await tx.encounterReferral.create({
      data: {
        ...own,
        specialtyId: row.specialtyId,
        doctorProfileId: row.doctorProfileId,
        externalName: row.externalName,
        reason: row.reason,
        urgency: row.urgency,
        notes: row.notes,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }

  const attachments = await tx.encounterAttachment.findMany({
    where: { encounterId: from.id },
    orderBy: byOrder(),
  });
  for (const row of attachments) {
    /*
     * ⚠️ THE SAME `stored_file_id`, NOT A COPY OF THE BYTES. Two consultations
     *   citing one photograph is correct — it is one photograph — and it is why
     *   `removeAttachment` unlinks rather than deleting the file.
     */
    await tx.encounterAttachment.create({
      data: {
        ...own,
        storedFileId: row.storedFileId,
        kind: row.kind,
        caption: row.caption,
        displayOrder: row.displayOrder,
      },
      select: { id: true },
    });
  }
}
