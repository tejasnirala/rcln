/**
 * The numbers taken before the doctor sees the patient.
 *
 * ⚠️ EVERY COLUMN IN THIS TABLE IS PHI, AND THE UNSUBTLE KIND. A blood pressure
 *   or a blood glucose against a named person needs no interpretation and no
 *   join to be a clinical record. The three rules from `appointment.service.ts`
 *   apply here without exception:
 *
 *     1. Every read calls `recordDataAccess` inside the transaction that read it
 *        — including the list, because a visit's observations ARE clinical
 *        content, which is exactly the line the day board sits on the other side
 *        of.
 *     2. NOTHING numeric reaches `recordAudit`. `snapshot()` below records which
 *        observations were present, never what they were: an audit trail is read
 *        by compliance staff who have no business reading a patient's readings,
 *        and "systolic: 180" in an audit row is a disclosure with a timestamp.
 *        This is a stricter rule than the appointment service's, because there
 *        every field is either an id or an enum and here every field is a
 *        measurement.
 *     3. Ids only in logs, in Redis and in URLs.
 *
 * ⚠️ `branchId` AND `patientId` ARE COPIED OFF THE APPOINTMENT, NEVER ACCEPTED
 *   FROM THE CALLER. Both are denormalised onto the row so the patient timeline
 *   and the branch RLS policy can be answered without a join, and a caller-
 *   supplied value would let a reading be filed against the wrong person or —
 *   worse — into a branch the caller cannot otherwise see. The composite FKs
 *   make a cross-TENANT value unrepresentable; nothing but this makes a
 *   cross-patient one impossible.
 */
import { withTenant, type Prisma, type TenantContext } from '@rcln/db';
import type {
  RecordVitalsRequest,
  UpdateVitalsRequest,
  VitalsListResponse,
  VitalsReading,
  VitalsRevisionsResponse,
} from '@rcln/contracts';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import type { AppointmentActionOptions } from './appointment.service.js';
import { onVitalsRecorded } from './appointment.service.js';

const VITALS_SELECT = {
  id: true,
  appointmentId: true,
  patientId: true,
  branchId: true,
  heightCm: true,
  weightKg: true,
  temperatureC: true,
  pulseBpm: true,
  respiratoryRateBpm: true,
  systolicMmHg: true,
  diastolicMmHg: true,
  spo2Percent: true,
  bloodGlucoseMgDl: true,
  notes: true,
  recordedAt: true,
  recordedBy: true,
  recorder: { select: { fullName: true } },
  /* Set only on a superseded version. See `revision_of_id` in schema.prisma. */
  revisionOfId: true,
  supersededAt: true,
  supersededBy: true,
  amender: { select: { fullName: true } },
} satisfies Prisma.AppointmentVitalSelect;

type VitalsRow = Prisma.AppointmentVitalGetPayload<{ select: typeof VITALS_SELECT }>;

/** Prisma `Decimal` -> a plain number, or null. One place, so no caller guesses. */
function num(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * kg/m², to one decimal — derived on every read and stored nowhere.
 *
 * A stored BMI is wrong the moment somebody corrects the weight, and nothing in
 * the schema would make it recompute. Null unless both numbers are present:
 * a BMI from a guessed height is a number that looks measured.
 */
function bmiOf(heightCm: number | null, weightKg: number | null): number | null {
  if (heightCm === null || weightKg === null || heightCm <= 0) return null;
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

function toReading(row: VitalsRow): VitalsReading {
  const heightCm = num(row.heightCm);
  const weightKg = num(row.weightKg);

  return {
    id: row.id,
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    heightCm,
    weightKg,
    bmi: bmiOf(heightCm, weightKg),
    temperatureC: num(row.temperatureC),
    pulseBpm: row.pulseBpm,
    respiratoryRateBpm: row.respiratoryRateBpm,
    systolicMmHg: row.systolicMmHg,
    diastolicMmHg: row.diastolicMmHg,
    spo2Percent: row.spo2Percent,
    bloodGlucoseMgDl: num(row.bloodGlucoseMgDl),
    notes: row.notes,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
    recordedByName: row.recorder?.fullName ?? null,
  };
}

/**
 * What goes on the audit row: WHICH observations this row carries, never their
 * values, and never the note.
 *
 * ⚠️ DO NOT "IMPROVE" THIS BY SPREADING THE ROW IN. The audit trail is a
 *   different security domain from the chart — see the header. An allow-list
 *   that records booleans is the only thing standing between a clinic's
 *   compliance export and every blood pressure it has ever taken. `REDACTED_KEYS`
 *   will not save you here: these column names are PHI only on this table, which
 *   is exactly the case that deny-list deliberately does not cover.
 */
function snapshot(row: VitalsRow): Record<string, unknown> {
  return {
    appointment_id: row.appointmentId,
    patient_id: row.patientId,
    recorded_at: row.recordedAt.toISOString(),
    /*
     * The shape of the reading, as a sorted list of field names. Enough to
     * answer "was a blood pressure taken at this visit, and by whom?" — which is
     * a real audit question — without answering what it was.
     */
    observations: [
      row.heightCm !== null ? 'height' : null,
      row.weightKg !== null ? 'weight' : null,
      row.temperatureC !== null ? 'temperature' : null,
      row.pulseBpm !== null ? 'pulse' : null,
      row.respiratoryRateBpm !== null ? 'respiratory_rate' : null,
      row.systolicMmHg !== null ? 'blood_pressure' : null,
      row.spo2Percent !== null ? 'spo2' : null,
      row.bloodGlucoseMgDl !== null ? 'blood_glucose' : null,
    ].filter((f): f is string => f !== null),
    has_note: row.notes !== null,
  };
}

/**
 * Every reading taken at one visit, oldest first.
 *
 * ⚠️ WRITES A DATA-ACCESS ROW, UNLIKE THE DAY BOARD. `listDay` is exempt because
 *   a time and a name are not clinical content and polling it would drown the
 *   reads that matter. This is the opposite: it is the clinical content, it is
 *   one named patient, and it is read once when a screen opens.
 */
export async function listVitals(
  ctx: TenantContext,
  appointmentId: string,
  options: AppointmentActionOptions = {}
): Promise<VitalsListResponse> {
  return withTenant(ctx, async (tx) => {
    /*
     * Resolved through the appointment rather than by querying vitals directly,
     * so an appointment outside this caller's branch scope answers 404 rather
     * than an empty list — an empty list would say "that booking exists and had
     * no vitals", which is a fact about another branch's day.
     */
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: { id: true, patientId: true, branchId: true },
    });
    if (!appointment) throw new NotFoundError('Appointment');

    const rows = await tx.appointmentVital.findMany({
      /*
       * ⚠️ `revisionOfId: null` IS NOT OPTIONAL. A corrected reading leaves its
       *   previous version behind on this same table, and a version is not an
       *   observation — without this filter one blood pressure appears on the
       *   chart once per time somebody fixed a typo in it, each copy looking
       *   exactly like a repeat measurement.
       */
      where: { appointmentId, deletedAt: null, revisionOfId: null },
      select: VITALS_SELECT,
      orderBy: { recordedAt: 'asc' },
    });

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'VITALS',
      patientId: appointment.patientId,
      resourceId: appointment.id,
      resultCount: rows.length,
      branchId: appointment.branchId,
      ...options,
    });

    return { vitals: rows.map(toReading) };
  });
}

/**
 * Record a set of observations against a visit.
 *
 * MANY PER APPOINTMENT, DELIBERATELY. A repeat blood pressure twenty minutes
 * after a high first reading is the normal clinical act, and it is a second
 * observation rather than an edit of the first. There is no update endpoint for
 * the same reason.
 *
 * ⚠️ SIDE EFFECT: THIS MAY MOVE THE APPOINTMENT TO `CHECKED_IN`. Taking someone's
 *   vitals means they are physically present, so the board should not still be
 *   claiming they are merely BOOKED. The transition is done inside this
 *   transaction by `onVitalsRecorded`, so a reading can never commit while the
 *   status change it implies rolls back.
 */
export async function recordVitals(
  ctx: TenantContext,
  appointmentId: string,
  input: RecordVitalsRequest,
  options: AppointmentActionOptions = {}
): Promise<VitalsReading> {
  return withTenant(ctx, async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: { id: true, patientId: true, branchId: true, status: true },
    });
    if (!appointment) throw new NotFoundError('Appointment');

    /*
     * A booking that was called off or never attended has no visit to observe.
     * Allowing it would put readings on a row every later report treats as
     * "did not happen", and there is no screen that would ever show them again.
     */
    if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
      throw new ConflictError('That booking did not go ahead, so vitals cannot be recorded on it.');
    }

    const created = await tx.appointmentVital.create({
      data: {
        organizationId: ctx.organizationId,
        // ⚠️ Off the appointment, never off the request. See the file header.
        branchId: appointment.branchId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        ...(input.heightCm !== undefined ? { heightCm: input.heightCm } : {}),
        ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
        ...(input.temperatureC !== undefined ? { temperatureC: input.temperatureC } : {}),
        ...(input.pulseBpm !== undefined ? { pulseBpm: input.pulseBpm } : {}),
        ...(input.respiratoryRateBpm !== undefined
          ? { respiratoryRateBpm: input.respiratoryRateBpm }
          : {}),
        ...(input.systolicMmHg !== undefined ? { systolicMmHg: input.systolicMmHg } : {}),
        ...(input.diastolicMmHg !== undefined ? { diastolicMmHg: input.diastolicMmHg } : {}),
        ...(input.spo2Percent !== undefined ? { spo2Percent: input.spo2Percent } : {}),
        ...(input.bloodGlucoseMgDl !== undefined
          ? { bloodGlucoseMgDl: input.bloodGlucoseMgDl }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.recordedAt !== undefined ? { recordedAt: new Date(input.recordedAt) } : {}),
        ...(ctx.userId !== undefined ? { recordedBy: ctx.userId } : {}),
      },
      select: VITALS_SELECT,
    });

    // Same transaction as the reading, so the board and the chart cannot disagree.
    await onVitalsRecorded(tx, ctx, appointment.id, appointment.status);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'appointment_vital',
      entityId: created.id,
      after: snapshot(created),
      branchId: appointment.branchId,
      ...options,
    });

    return toReading(created);
  });
}

/**
 * The measurements a reading can carry, in the order they are reported.
 *
 * Named separately from `snapshot()` so the amendment below can walk them
 * without either function knowing the other's business.
 */
const MEASUREMENTS = [
  'heightCm',
  'weightKg',
  'temperatureC',
  'pulseBpm',
  'respiratoryRateBpm',
  'systolicMmHg',
  'diastolicMmHg',
  'spo2Percent',
  'bloodGlucoseMgDl',
] as const;

/**
 * One measurement off a row, as a plain number.
 *
 * ⚠️ HALF THESE COLUMNS ARE `Decimal` AND HALF ARE `Int`, AND THE DIFFERENCE HAS
 *   TO BE ABSORBED HERE. A `Decimal` is an object: two of them holding 120 are
 *   not `===`, so comparing the raw fields reports every decimal measurement as
 *   changed on every amendment — which is the same as reporting nothing.
 */
function measurementValue(row: VitalsRow, field: (typeof MEASUREMENTS)[number]): number | null {
  const value = row[field];
  if (value === null) return null;
  return typeof value === 'object' ? num(value) : value;
}

/** Which measurements differ between two versions of a row. Names, never values. */
function changedMeasurements(before: VitalsRow, after: VitalsRow): string[] {
  return MEASUREMENTS.filter(
    (field) => measurementValue(before, field) !== measurementValue(after, field)
  ).map((field) =>
    /* snake_case, matching `observations` in `snapshot()`, so a compliance
       reader is not asked to reconcile two spellings of "blood pressure". */
    field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  );
}

/**
 * Every correction ever made to one reading, with both values.
 *
 * ⚠️ THIS IS THE CLINICAL TRAIL, AND IT IS A DIFFERENT SURFACE FROM `audit_logs`
 *   ON PURPOSE. The audit row says a correction happened, who made it and which
 *   measurements moved — readable by compliance staff through
 *   `audit.record.read`. This says what the numbers WERE, which is clinical
 *   content: behind `clinical.vitals.record`, and it writes a `data_access_logs`
 *   row like every other read of a patient's observations.
 *
 * ⚠️ THE PAIRS ARE BUILT BY WALKING THE CHAIN FORWARDS. Each stored version is
 *   the state BEFORE one correction, so a version's "after" is the next version
 *   — or, for the most recent one, the live reading. Reading a version's own
 *   fields as both sides would report every correction as a change from a value
 *   to itself.
 */
export async function listVitalsRevisions(
  ctx: TenantContext,
  appointmentId: string,
  vitalsId: string,
  options: AppointmentActionOptions = {}
): Promise<VitalsRevisionsResponse> {
  return withTenant(ctx, async (tx) => {
    const live = await tx.appointmentVital.findFirst({
      /* `appointmentId` in the predicate, as everywhere else on this service:
         without it an id from another visit reads successfully through here. */
      where: { id: vitalsId, appointmentId, deletedAt: null, revisionOfId: null },
      select: VITALS_SELECT,
    });
    if (!live) throw new NotFoundError('Vitals');

    const versions = await tx.appointmentVital.findMany({
      where: { revisionOfId: vitalsId },
      select: VITALS_SELECT,
      orderBy: { supersededAt: 'asc' },
    });

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'VITALS',
      patientId: live.patientId,
      resourceId: live.id,
      resultCount: versions.length,
      branchId: live.branchId,
      ...options,
    });

    /*
     * ⚠️ PAIRED IN CHRONOLOGICAL ORDER AND REVERSED AFTERWARDS — NOT FETCHED
     *   DESCENDING. Version n's "after" is version n+1, and the last one's
     *   "after" is the reading as it stands now, so the pairing only holds while
     *   the list runs forwards. Flipping the `orderBy` to get a newest-first
     *   response would silently invert every pair: a correction from 180 to 120
     *   would read as 120 to 180, which is a false clinical record and one
     *   nothing else would catch.
     */
    const revisions = versions.map((version, index) => {
      const next = versions[index + 1] ?? live;

      const changes = MEASUREMENTS.filter(
        (field) => measurementValue(version, field) !== measurementValue(next, field)
      ).map((field) => ({
        field,
        before: measurementValue(version, field),
        after: measurementValue(next, field),
      }));

      return {
        id: version.id,
        supersededAt: (version.supersededAt ?? version.recordedAt).toISOString(),
        supersededBy: version.supersededBy,
        supersededByName: version.amender?.fullName ?? null,
        changes,
        noteBefore: version.notes,
        noteAfter: next.notes,
        noteChanged: version.notes !== next.notes,
      };
    });

    /*
     * Newest first, which is what a trail is read for: "what was changed last?"
     * is the question somebody opening this has, and the correction from three
     * weeks ago is context rather than the answer. `RecordHistory` orders the
     * audit trail the same way (`occurredAt: 'desc'`), so the two drawers do not
     * disagree about which end is the top.
     */
    return { revisions: revisions.reverse() };
  });
}

/**
 * Correct a reading that was mistyped.
 *
 * ⚠️ AN AMENDMENT, NOT A SECOND OBSERVATION, AND NOT A LICENCE TO REWRITE
 *   HISTORY. `recordVitals` above is still the way a repeat blood pressure is
 *   taken, and readings still accumulate. This exists for the case that had no
 *   remedy at all: 1200 typed for 120, discovered thirty seconds later, with
 *   nothing to do about it but withdraw the whole reading and start again.
 *
 * ⚠️ THE AUDIT ROW SAYS WHICH MEASUREMENTS MOVED AND NEVER WHAT THEY WERE.
 *   `snapshot()` records the SHAPE of a reading precisely because an audit trail
 *   is read by compliance staff who have no business reading a patient's
 *   numbers — and an amendment is the case where the naive fix is most
 *   tempting, because a before/after of the values is exactly what a diff wants
 *   to show. `amended` carries the field NAMES, so the trail answers "the blood
 *   pressure on this visit was corrected at 16:52 by Sita" without answering
 *   "from what to what". The chart is where the numbers live; the trail says
 *   that they changed.
 *
 * ⚠️ EVERY MEASUREMENT IS WRITTEN, INCLUDING THE ABSENT ONES, WHICH BECOME NULL.
 *   The contract is a replacement (see `updateVitalsRequest`): the form arrives
 *   populated, so a box that is now empty means the measurement was not taken.
 *   A merge would leave a mistakenly-entered value with no way to clear it.
 */
export async function amendVitals(
  ctx: TenantContext,
  appointmentId: string,
  vitalsId: string,
  input: UpdateVitalsRequest,
  options: AppointmentActionOptions = {}
): Promise<VitalsReading> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.appointmentVital.findFirst({
      /*
       * `appointmentId` is in the predicate, not just the path — the same rule
       * as `deleteVitals`. Without it, an id belonging to another visit would
       * amend successfully through this route.
       */
      where: { id: vitalsId, appointmentId, deletedAt: null },
      select: VITALS_SELECT,
    });
    if (!before) throw new NotFoundError('Vitals');

    /*
     * ⚠️ THE PREVIOUS VERSION IS KEPT BEFORE THE UPDATE OVERWRITES IT, AND IT IS
     *   KEPT WITH ITS VALUES. "Who changed this blood pressure from 180 to 120,
     *   and when" is a question a medical record has to answer years later, and
     *   `audit_logs` cannot be where it is answered — that table is read through
     *   a compliance code held by people with no clinical access, so a
     *   measurement in it is a disclosure with a timestamp. This row is the
     *   clinical record: same table, same RLS policy, same branch scoping, read
     *   behind `clinical.vitals.record`.
     *
     * ⚠️ IT COPIES `recordedAt` AND `recordedBy` FROM THE ORIGINAL. They describe
     *   the OBSERVATION — when it was taken and by whom — which a correction does
     *   not change. Who corrected it is `supersededBy`, which is a different
     *   person often enough that conflating them would misattribute the reading.
     */
    await tx.appointmentVital.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: before.branchId,
        patientId: before.patientId,
        appointmentId,
        heightCm: before.heightCm,
        weightKg: before.weightKg,
        temperatureC: before.temperatureC,
        pulseBpm: before.pulseBpm,
        respiratoryRateBpm: before.respiratoryRateBpm,
        systolicMmHg: before.systolicMmHg,
        diastolicMmHg: before.diastolicMmHg,
        spo2Percent: before.spo2Percent,
        bloodGlucoseMgDl: before.bloodGlucoseMgDl,
        notes: before.notes,
        recordedAt: before.recordedAt,
        ...(before.recordedBy !== null ? { recordedBy: before.recordedBy } : {}),
        /* What makes this a version rather than an observation. */
        revisionOfId: vitalsId,
        supersededAt: new Date(),
        ...(ctx.userId !== undefined ? { supersededBy: ctx.userId } : {}),
      },
    });

    const after = await tx.appointmentVital.update({
      where: { id: vitalsId },
      data: {
        /*
         * `?? null` on every one: absent means "not measured", so the column is
         * cleared rather than left holding the old value. See the header.
         *
         * ⚠️ `branchId`, `patientId` AND `appointmentId` ARE NOT HERE AND MUST
         *   NOT BE. They are what the row IS; an amendment that could move a
         *   reading to another patient is not an amendment.
         */
        heightCm: input.heightCm ?? null,
        weightKg: input.weightKg ?? null,
        temperatureC: input.temperatureC ?? null,
        pulseBpm: input.pulseBpm ?? null,
        respiratoryRateBpm: input.respiratoryRateBpm ?? null,
        systolicMmHg: input.systolicMmHg ?? null,
        diastolicMmHg: input.diastolicMmHg ?? null,
        spo2Percent: input.spo2Percent ?? null,
        bloodGlucoseMgDl: input.bloodGlucoseMgDl ?? null,
        notes: input.notes ?? null,
        ...(input.recordedAt !== undefined ? { recordedAt: new Date(input.recordedAt) } : {}),
      },
      select: VITALS_SELECT,
    });

    const amended = changedMeasurements(before, after);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'appointment_vital',
      entityId: vitalsId,
      before: snapshot(before),
      after: { ...snapshot(after), amended },
      branchId: before.branchId,
      ...options,
    });

    /*
     * ⚠️ `recordedBy` IS NOT TOUCHED, AND THAT IS NOT AN OVERSIGHT. It names who
     *   TOOK the observation, which an amendment does not change — a nurse
     *   fixing a colleague's typo did not take the blood pressure. Who amended
     *   it, and when, is the audit row written above.
     */
    return toReading(after);
  });
}

/**
 * Withdraw a reading that should not be on the chart at all.
 *
 * ⚠️ A DIFFERENT ACT FROM AMENDING, AND BOTH EXIST FOR DIFFERENT MISTAKES. A
 *   mistyped value is corrected by `amendVitals`, which keeps the reading and
 *   records that it moved. This is for a reading that should never have been
 *   entered — filed against the wrong visit, or a mis-click with no measurement
 *   behind it. Soft, so the chart loses it and the table does not.
 */
export async function deleteVitals(
  ctx: TenantContext,
  appointmentId: string,
  vitalsId: string,
  options: AppointmentActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.appointmentVital.findFirst({
      // `appointmentId` is in the predicate, not just the path: without it, an id
      // from another visit would delete successfully through this route.
      where: { id: vitalsId, appointmentId, deletedAt: null },
      select: VITALS_SELECT,
    });
    if (!row) throw new NotFoundError('Vitals');

    await tx.appointmentVital.update({
      where: { id: vitalsId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'appointment_vital',
      entityId: vitalsId,
      before: snapshot(row),
      branchId: row.branchId,
      ...options,
    });
  });
}
