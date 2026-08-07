/**
 * The three medical-history lists: allergies, problems, medicines.
 *
 * ⚠️ SEPARATE FROM `patient.service.ts` BECAUSE IT SITS BEHIND A SEPARATE
 * PERMISSION. `patient.medical_history.read` is granted to the doctor and the
 * nurse and withheld from the receptionist and the accountant, both of whom
 * hold `patient.read`. Folding these lists into the patient detail response
 * would collapse that distinction — either the front desk reads the problem
 * list, or nobody does.
 *
 * ⚠️ THIS IS THE MOST SENSITIVE READ IN THE PRODUCT. A name is identifying; a
 * diagnosis is the thing people lose jobs and custody over. Every read here
 * writes a `data_access_logs` row with `resource = MEDICAL_HISTORY`, and every
 * write records an audit row that says a row CHANGED without saying to what —
 * `allergenText`, `conditionText`, `medicineText`, `reaction` and `dosage` are
 * all in `REDACTED_KEYS` as the backstop, and the snapshots below never pass
 * them in the first place.
 *
 * WHY DELETES ARE SOFT
 *   "This allergy was recorded and later withdrawn" is clinically interesting.
 *   An allergy that vanishes without trace is indistinguishable from one that
 *   was never recorded, and the difference matters at the moment somebody is
 *   deciding whether to prescribe.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  PatientAllergyRequest,
  PatientConditionRequest,
  PatientHistoryResponse,
  PatientMedicationRequest,
} from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import type { PatientActionOptions } from './patient.service.js';

/** `Date | null` -> `YYYY-MM-DD`. The columns are bare dates; read them in UTC. */
function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` -> a UTC midnight `Date`, which is how bare dates are stored. */
function toDateColumn(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Who recorded this, by name.
 *
 * ⚠️ THE ONE NAME THAT IS SAFE HERE: it is a member of STAFF, not the patient.
 * "Dr Rao noted this allergy" is the provenance a prescriber needs — an
 * unattributed entry gets ignored, which is worse than not having it.
 */
const NOTER = { select: { fullName: true } } as const;

/** Confirm the patient exists — and is not soft-deleted — before touching them. */
async function assertPatientExists(tx: TxClient, patientId: string): Promise<void> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, deletedAt: null },
    select: { id: true },
  });
  if (!patient) throw new NotFoundError('Patient');
}

/**
 * All three lists, in one read and therefore one access-log row.
 *
 * One row per REQUEST, never one per record: a chart with forty entries is one
 * clinical act of looking, and logging forty rows would turn this table into a
 * firehose that nobody reads — which is the same as having no table.
 */
export async function getHistory(
  ctx: TenantContext,
  patientId: string,
  options: PatientActionOptions = {}
): Promise<PatientHistoryResponse> {
  return withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    const [allergies, conditions, medications] = await Promise.all([
      tx.patientAllergy.findMany({
        where: { patientId, deletedAt: null },
        select: {
          id: true,
          allergenType: true,
          allergenText: true,
          severity: true,
          reaction: true,
          notedOn: true,
          noter: NOTER,
        },
        /*
         * Severity is a Postgres enum ordered MILD, MODERATE, SEVERE, so
         * `desc` puts SEVERE first — which is the order a prescriber needs to
         * read it in, and the reason the enum is declared in that sequence.
         */
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      }),
      tx.patientCondition.findMany({
        where: { patientId, deletedAt: null },
        select: {
          id: true,
          conditionText: true,
          status: true,
          onsetDate: true,
          resolvedDate: true,
          note: true,
          noter: NOTER,
        },
        orderBy: [{ status: 'asc' }, { onsetDate: 'desc' }],
      }),
      tx.patientMedication.findMany({
        where: { patientId, deletedAt: null },
        select: {
          id: true,
          medicineText: true,
          dosage: true,
          startedOn: true,
          stoppedOn: true,
          isOngoing: true,
          noter: NOTER,
        },
        orderBy: [{ isOngoing: 'desc' }, { startedOn: 'desc' }],
      }),
    ]);

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'MEDICAL_HISTORY',
      patientId,
      resourceId: patientId,
      resultCount: allergies.length + conditions.length + medications.length,
      ...options,
    });

    return {
      allergies: allergies.map((a) => ({
        id: a.id,
        allergenType: a.allergenType,
        allergenText: a.allergenText,
        severity: a.severity,
        reaction: a.reaction,
        notedOn: isoDate(a.notedOn),
        notedByName: a.noter?.fullName ?? null,
      })),
      conditions: conditions.map((c) => ({
        id: c.id,
        conditionText: c.conditionText,
        status: c.status,
        onsetDate: isoDate(c.onsetDate),
        resolvedDate: isoDate(c.resolvedDate),
        note: c.note,
        notedByName: c.noter?.fullName ?? null,
      })),
      medications: medications.map((m) => ({
        id: m.id,
        medicineText: m.medicineText,
        dosage: m.dosage,
        startedOn: isoDate(m.startedOn),
        stoppedOn: isoDate(m.stoppedOn),
        isOngoing: m.isOngoing,
        notedByName: m.noter?.fullName ?? null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export async function addAllergy(
  ctx: TenantContext,
  patientId: string,
  input: PatientAllergyRequest,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    const created = await tx.patientAllergy.create({
      data: {
        organizationId: ctx.organizationId,
        patientId,
        allergenType: input.allergenType,
        allergenText: input.allergenText,
        severity: input.severity,
        ...(input.reaction !== undefined ? { reaction: input.reaction } : {}),
        ...(input.notedOn !== undefined ? { notedOn: toDateColumn(input.notedOn) } : {}),
        notedBy: ctx.userId,
      },
      select: { id: true },
    });

    /*
     * ⚠️ `allergenText` IS NOT ON THIS SNAPSHOT, and its absence is the whole
     * point. "A severe drug allergy was added to patient X" is the auditable
     * fact; WHICH drug is clinical content, and `audit_logs` is read by people
     * who are not treating this patient.
     */
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_allergy',
      entityId: created.id,
      after: { patientId, allergenType: input.allergenType, severity: input.severity },
      ...options,
    });
  });
}

export async function removeAllergy(
  ctx: TenantContext,
  patientId: string,
  allergyId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientAllergy.findFirst({
      where: { id: allergyId, patientId, deletedAt: null },
      select: { id: true, allergenType: true, severity: true },
    });
    if (!existing) throw new NotFoundError('Allergy');

    await tx.patientAllergy.update({
      where: { id: allergyId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient_allergy',
      entityId: allergyId,
      before: { patientId, allergenType: existing.allergenType, severity: existing.severity },
      ...options,
    });
  });
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export async function addCondition(
  ctx: TenantContext,
  patientId: string,
  input: PatientConditionRequest,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    const created = await tx.patientCondition.create({
      data: {
        organizationId: ctx.organizationId,
        patientId,
        conditionText: input.conditionText,
        status: input.status,
        ...(input.onsetDate !== undefined ? { onsetDate: toDateColumn(input.onsetDate) } : {}),
        ...(input.resolvedDate !== undefined
          ? { resolvedDate: toDateColumn(input.resolvedDate) }
          : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        notedBy: ctx.userId,
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_condition',
      entityId: created.id,
      // The diagnosis itself never reaches the trail. See the allergy note.
      after: { patientId, status: input.status },
      ...options,
    });
  });
}

export async function updateCondition(
  ctx: TenantContext,
  patientId: string,
  conditionId: string,
  input: PatientConditionRequest,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.patientCondition.findFirst({
      where: { id: conditionId, patientId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!before) throw new NotFoundError('Condition');

    await tx.patientCondition.update({
      where: { id: conditionId },
      data: {
        conditionText: input.conditionText,
        status: input.status,
        onsetDate: input.onsetDate !== undefined ? toDateColumn(input.onsetDate) : null,
        resolvedDate: input.resolvedDate !== undefined ? toDateColumn(input.resolvedDate) : null,
        note: input.note ?? null,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'patient_condition',
      entityId: conditionId,
      before: { patientId, status: before.status },
      after: { patientId, status: input.status },
      ...options,
    });
  });
}

export async function removeCondition(
  ctx: TenantContext,
  patientId: string,
  conditionId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientCondition.findFirst({
      where: { id: conditionId, patientId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundError('Condition');

    await tx.patientCondition.update({
      where: { id: conditionId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient_condition',
      entityId: conditionId,
      before: { patientId, status: existing.status },
      ...options,
    });
  });
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

export async function addMedication(
  ctx: TenantContext,
  patientId: string,
  input: PatientMedicationRequest,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    const created = await tx.patientMedication.create({
      data: {
        organizationId: ctx.organizationId,
        patientId,
        medicineText: input.medicineText,
        ...(input.dosage !== undefined ? { dosage: input.dosage } : {}),
        ...(input.startedOn !== undefined ? { startedOn: toDateColumn(input.startedOn) } : {}),
        ...(input.stoppedOn !== undefined ? { stoppedOn: toDateColumn(input.stoppedOn) } : {}),
        isOngoing: input.isOngoing,
        notedBy: ctx.userId,
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_medication',
      entityId: created.id,
      // Neither the medicine nor the dose. What someone is taking is the
      // diagnosis by another route.
      after: { patientId, isOngoing: input.isOngoing },
      ...options,
    });
  });
}

/**
 * Stop a medicine.
 *
 * A separate call from a general update because it is the only edit that
 * changes what a prescriber may safely do next, and because `isOngoing` and
 * `stoppedOn` must move together — the CHECK constraint refuses them apart.
 */
export async function stopMedication(
  ctx: TenantContext,
  patientId: string,
  medicationId: string,
  stoppedOn: string | undefined,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientMedication.findFirst({
      where: { id: medicationId, patientId, deletedAt: null },
      select: { id: true, isOngoing: true, startedOn: true },
    });
    if (!existing) throw new NotFoundError('Medication');

    /*
     * Default to today rather than requiring a date: the common case at the
     * counter is "they stopped it", said in the present tense. `new Date()` is
     * safe here in a way it is NOT for `staff_profiles.joinedOn` — this column
     * is a date the clinician states, not one derived from "what day is it
     * where the clinic is", and the route validates any supplied value.
     */
    const stopDate = stoppedOn !== undefined ? toDateColumn(stoppedOn) : new Date();

    await tx.patientMedication.update({
      where: { id: medicationId },
      data: { isOngoing: false, stoppedOn: stopDate },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'patient_medication',
      entityId: medicationId,
      before: { patientId, isOngoing: existing.isOngoing },
      after: { patientId, isOngoing: false },
      ...options,
    });
  });
}

export async function removeMedication(
  ctx: TenantContext,
  patientId: string,
  medicationId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientMedication.findFirst({
      where: { id: medicationId, patientId, deletedAt: null },
      select: { id: true, isOngoing: true },
    });
    if (!existing) throw new NotFoundError('Medication');

    await tx.patientMedication.update({
      where: { id: medicationId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient_medication',
      entityId: medicationId,
      before: { patientId, isOngoing: existing.isOngoing },
      ...options,
    });
  });
}
