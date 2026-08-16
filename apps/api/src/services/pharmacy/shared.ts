/**
 * The pieces every pharmacy service needs, in one place so they cannot drift.
 *
 * Branch scoping, the dispensing point, the decision snapshot, and the
 * arithmetic that answers "how much of this prescription is still outstanding".
 *
 * NO PHI IS LOGGED FROM THIS FILE, and the one function that returns it —
 * `patientAgeYears` — returns an integer rather than a date of birth, because a
 * rule needs to know whether somebody is sixteen and never needs to know when
 * they were born.
 */
import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type { DispenseRegulatorySummary } from '@rcln/contracts';
import type { RegulatoryDecisionResponse } from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { isEnforceable } from '../regulatory/enforcement.js';

/**
 * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a branch outside the caller's scope. RLS has
 *   already made the row invisible, and a 403 would confirm to somebody probing
 *   that the id is real. Every branch-scoped service in this codebase does this.
 */
export function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

/**
 * Which counter is this request about?
 *
 * ⚠️ THE BRANCH THE REQUEST NAMES, OR THE ONE IT IS ACTING ON — NEVER THE FIRST
 *   ONE IN SCOPE. A pharmacist covering two sites in two states must not be
 *   evaluated against whichever branch id happened to sort first: the
 *   jurisdiction of the supply is where the counter is, and picking arbitrarily
 *   is wrong silently and about half the time. The evaluation service learned
 *   this the same way (see its `branchId` comment).
 */
export function resolveBranchId(
  ctx: TenantContext,
  named: string | undefined,
  acting: string | null | undefined
): string {
  const branchId = named ?? acting ?? (ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined);
  if (!branchId) {
    throw new ValidationError(
      'Say which branch this is for. You work at more than one and a supply happens at exactly one counter.'
    );
  }
  assertBranchInScope(ctx, branchId);
  return branchId;
}

export interface DispensingLocation {
  id: string;
  name: string;
  kind: string;
  requiresControlledAccess: boolean;
  hasControlledAccess: boolean;
}

/**
 * The shelf a supply goes out of, re-asserted at the moment of acting.
 *
 * ⚠️ `is_dispensing_point` IS CHECKED HERE AND NOWHERE ELSE. A clinic marks which
 *   of its locations is a counter; dispensing out of the bulk store or the
 *   goods-in bay is a stock movement nobody at the counter made, and it is the
 *   sort of thing a mis-selected dropdown does quietly.
 */
export async function resolveDispensingLocation(
  tx: TxClient,
  branchId: string,
  locationId: string
): Promise<DispensingLocation> {
  const location = await tx.inventoryLocation.findFirst({
    where: { id: locationId, branchId, deletedAt: null },
    select: {
      id: true,
      name: true,
      kind: true,
      isActive: true,
      isDispensingPoint: true,
      requiresControlledAccess: true,
      storageProfile: { select: { requiresControlledAccess: true } },
    },
  });
  if (!location) throw new NotFoundError('Location');
  if (!location.isActive) {
    throw new ValidationError(`${location.name} is no longer in use, so nothing can go out of it.`);
  }
  if (!location.isDispensingPoint) {
    throw new ValidationError(
      `${location.name} is not a dispensing point. Supply from the counter this branch dispenses from.`
    );
  }
  return {
    id: location.id,
    name: location.name,
    kind: location.kind,
    requiresControlledAccess: location.requiresControlledAccess,
    // Either establishes it, exactly as the evaluation service reads it.
    hasControlledAccess:
      location.requiresControlledAccess ||
      (location.storageProfile?.requiresControlledAccess ?? false),
  };
}

/**
 * The decision, as the counter reads it.
 *
 * ⚠️ RULE IDS AND PACK VERSIONS ARE DROPPED HERE, ON PURPOSE. The workspace shows
 *   a pharmacist what the law says and what to do about it, not what the engine
 *   did (FRONTEND_ARCHITECTURE.md). The full decision — ids, versions, every
 *   reason — is snapshotted in `regulatory_decisions` whatever this returns.
 */
export function toDecisionSummary(decision: RegulatoryDecisionResponse): DispenseRegulatorySummary {
  return {
    outcome: decision.outcome,
    messages: decision.reasons
      .filter((reason) => reason.outcome !== 'PERMITTED')
      .map((reason) => reason.message),
    conditions: decision.conditions.map((condition) => ({
      kind: condition.kind,
      detail: condition.detail,
    })),
    lowestPackMaturity: decision.lowestPackMaturity,
    wasEnforced: isEnforceable(decision),
  };
}

/** The codes that did not permit. Log-safe: a code, never a patient. */
export function refusingRuleCodes(decision: RegulatoryDecisionResponse): string[] {
  return decision.reasons
    .filter((reason) => reason.outcome !== 'PERMITTED')
    .map((reason) => reason.ruleCode)
    .filter((code): code is string => code !== null);
}

export interface DecisionSnapshotInput {
  branchId: string;
  productId: string;
  transaction: 'DISPENSE' | 'COUNTER_SALE' | 'ONLINE_DISPENSE';
  quantityBase: string;
  decision: RegulatoryDecisionResponse;
}

/**
 * Freeze what the engine said (PI-ADR-008).
 *
 * ⚠️ WRITTEN INSIDE THE TRANSACTION THAT ACTS ON IT, so a supply that rolls back
 *   leaves no decision claiming to have permitted something that never happened.
 *
 * ⚠️ AND NEVER UPDATED. The table is append-only in two layers — `rcln_app` holds
 *   no UPDATE or DELETE and a trigger refuses both. A different answer is a new
 *   evaluation, with its own row.
 */
export async function recordDecision(
  tx: TxClient,
  ctx: TenantContext,
  input: DecisionSnapshotInput
): Promise<string> {
  const { decision } = input;
  const row = await tx.regulatoryDecision.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      transaction: input.transaction,
      outcome: decision.outcome,
      /*
       * ⚠️ THE JURISDICTION AS CODES, PARSED BACK OUT OF THE LABEL THE RESPONSE
       *   CARRIES. `formatJurisdiction` renders `IN` or `IN-KA`; splitting it is
       *   the only way to get the pair without re-reading the branch, and the
       *   pair is what a report groups by.
       */
      countryCode: decision.jurisdiction.slice(0, 2).toUpperCase(),
      regionCode: decision.jurisdiction.includes('-')
        ? decision.jurisdiction.slice(decision.jurisdiction.indexOf('-') + 1)
        : null,
      lowestPackMaturity: decision.lowestPackMaturity,
      wasEnforced: isEnforceable(decision),
      quantityBase: new Prisma.Decimal(input.quantityBase),
      evaluatedAt: new Date(decision.evaluatedAt),
      packVersions: decision.packVersionIds as unknown as Prisma.InputJsonValue,
      reasons: decision.reasons as unknown as Prisma.InputJsonValue,
      conditions: decision.conditions as unknown as Prisma.InputJsonValue,
      ruleCodes: refusingRuleCodes(decision),
      actorUserId: ctx.userId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * How far through a prescription the dispensary has got.
 *
 * ⚠️ DERIVED, NEVER STORED ON THE CLINICAL ROW. Pharmacy does not write a column
 *   on `encounter_prescriptions` — not even a progress one (invariant 7) — so the
 *   sum lives here, over `dispense_lines` net of returns. A stored counter would
 *   be a second answer to the same question, free to disagree with the lines.
 */
export async function dispensedByPrescriptionLine(
  tx: TxClient,
  organizationId: string,
  encounterPrescriptionIds: readonly string[]
): Promise<Map<string, Prisma.Decimal>> {
  if (encounterPrescriptionIds.length === 0) return new Map();

  const rows = await tx.dispenseLine.groupBy({
    by: ['encounterPrescriptionId'],
    where: {
      organizationId,
      encounterPrescriptionId: { in: [...encounterPrescriptionIds] },
    },
    _sum: { quantityBase: true, returnedQuantityBase: true },
  });

  const out = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    if (row.encounterPrescriptionId === null) continue;
    const supplied = row._sum.quantityBase ?? new Prisma.Decimal(0);
    const returned = row._sum.returnedQuantityBase ?? new Prisma.Decimal(0);
    out.set(row.encounterPrescriptionId, supplied.sub(returned));
  }
  return out;
}

/**
 * Move the queue row on after something was supplied or came back.
 *
 * ⚠️ THE ROW IS CREATED IF IT DOES NOT EXIST, because dispensing without
 *   verifying is legal, common and not this function's business to refuse: a
 *   counter that supplies straight off the prescription still has to appear in
 *   the queue as partially dispensed.
 *
 * ⚠️ A LINE WITH NO PRESCRIBED QUANTITY COUNTS AS COMPLETE ONCE ANYTHING HAS GONE
 *   OUT AGAINST IT. "An ointment, as needed" states no total, so there is no
 *   arithmetic that could ever call it finished — and leaving such a prescription
 *   forever `PARTIALLY_DISPENSED` would fill the queue with rows nobody can clear.
 */
export async function refreshFulfilment(
  tx: TxClient,
  ctx: TenantContext,
  encounterId: string,
  branchId: string
): Promise<void> {
  const prescribed = await tx.encounterPrescription.findMany({
    where: { organizationId: ctx.organizationId, encounterId },
    select: { id: true, quantity: true },
  });
  if (prescribed.length === 0) return;

  const dispensed = await dispensedByPrescriptionLine(
    tx,
    ctx.organizationId,
    prescribed.map((line) => line.id)
  );

  let completed = 0;
  let started = 0;
  for (const line of prescribed) {
    const supplied = dispensed.get(line.id) ?? new Prisma.Decimal(0);
    if (supplied.gt(0)) started += 1;
    if (line.quantity === null ? supplied.gt(0) : supplied.gte(line.quantity)) completed += 1;
  }

  const status =
    completed === prescribed.length
      ? 'COMPLETED'
      : started > 0
        ? 'PARTIALLY_DISPENSED'
        : 'VERIFIED';

  const existing = await tx.prescriptionFulfilment.findUnique({
    where: { organizationId_encounterId: { organizationId: ctx.organizationId, encounterId } },
    select: { id: true, status: true, verifiedById: true, verifiedAt: true },
  });

  if (!existing) {
    await tx.prescriptionFulfilment.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        encounterId,
        status,
        /*
         * ⚠️ SUPPLYING IS NOT VERIFYING, AND THE ATTRIBUTION SAYS SO. The CHECK
         *   constraint wants a verifier on any row that is not cancelled, and the
         *   honest answer for a counter that dispensed without a separate check
         *   is that the person who supplied it is the person who read it.
         */
        verifiedById: ctx.userId,
        verifiedAt: new Date(),
      },
    });
    return;
  }

  // A cancelled intention that is then supplied against is no longer cancelled.
  await tx.prescriptionFulfilment.update({
    where: { id: existing.id },
    data: {
      status,
      ...(existing.verifiedById === null
        ? { verifiedById: ctx.userId, verifiedAt: new Date() }
        : {}),
      ...(existing.status === 'CANCELLED' ? { cancelledById: null, cancelledAt: null } : {}),
    },
  });
}

/** Whole years, from a date of birth the caller must not otherwise pass on. */
export function ageYearsOn(dateOfBirth: Date | null, on: Date): number | undefined {
  if (!dateOfBirth) return undefined;
  let age = on.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = on.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;
  return age < 0 ? undefined : age;
}

/**
 * The two fields `recordAudit` takes, pulled out of the wider options object.
 *
 * ⚠️ EXPLICIT RATHER THAN `...options`, BECAUSE THE PHARMACY OPTIONS CARRY MORE
 *   THAN AUDIT WANTS — a route pattern, the acting branch, the caller's
 *   permission codes. Spreading them would put the caller's effective
 *   permissions into an audit row's shape and nobody would notice for a while.
 */
export function auditMeta(options: {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}): { ipAddress?: string; userAgent?: string } {
  return {
    ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
}

/** A decimal as the wire wants it: a string, never a float. */
export function q(value: Prisma.Decimal | number | string): string {
  return new Prisma.Decimal(value).toString();
}
