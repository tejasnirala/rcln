/**
 * Booking, moving, and driving an appointment through its life.
 *
 * ⚠️ AN APPOINTMENT IS PHI, AND MORE OF IT THAN IT LOOKS. A patient, a doctor
 *   and a reason are three facts that disclose a fourth: "cardiology, Tuesday"
 *   is a diagnosis with extra steps. The patient rules apply here unchanged:
 *
 *     1. Every read that discloses ONE booking calls `recordDataAccess`, inside
 *        the transaction that read it. The day board does not — see `listDay`.
 *     2. Nothing reaches `recordAudit` except through `snapshot()` below.
 *        ⚠️ `reason` and `cancellationReason` are deliberately NOT in
 *        `REDACTED_KEYS`: that deny-list is only for keys that are PHI on EVERY
 *        entity carrying them, and `doctor_schedule_exceptions.reason` is
 *        "annual leave". So the allow-list snapshot is the ONLY thing keeping a
 *        chief complaint out of the audit trail. Do not widen it.
 *     3. Ids only in logs, in Redis and in a URL.
 *
 * ⚠️ THE SLOT CHECK IS ADVICE AND THE EXCLUDE CONSTRAINT IS THE ANSWER.
 *   `computeAvailability` runs on this transaction, so it sees everything
 *   committed — and cannot see an uncommitted insert from the receptionist at
 *   the next desk, nor a booking for the same doctor at a branch outside this
 *   caller's scope. `appointments_no_doctor_overlap` catches both. The check
 *   exists so the ordinary case gets a sentence rather than a constraint name.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AppointmentDetail,
  AppointmentListQuery,
  AppointmentListResponse,
  AppointmentStatusValue,
  AppointmentSummary,
  AvailabilityResponse,
  CreateAppointmentRequest,
  RescheduleAppointmentRequest,
  UpdateAppointmentRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { ensureRegistration } from '../patient/patient.service.js';
import { branchLocalDate, computeAvailability } from './availability.service.js';

/** Request metadata, carried onto both trails. */
export interface AppointmentActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/**
 * Branch-local, six digits, one series per branch that never resets.
 *
 * A financial-year reset is deliberately not applied: an appointment number is
 * said out loud on the telephone and looked up months later, and a series that
 * restarts every April makes "A000123" ambiguous. Invoices reset because the tax
 * authority requires it; this does not.
 */
const APPOINTMENT_PREFIX = 'A';

const STATUS_ORDER: AppointmentStatusValue[] = [
  'BOOKED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

/**
 * What may follow what.
 *
 * ⚠️ NO_SHOW IS UNREACHABLE ONCE SOMEBODY HAS CHECKED IN, and that is the point:
 *   a patient standing at the desk cannot retrospectively not have turned up.
 *   Marking them absent instead of cancelling is how a clinic ends up charging a
 *   no-show fee to someone who was there.
 *
 * The three terminal states have no outgoing edges. Re-opening a completed
 * appointment is not an edit — it is a new booking, and it should look like one.
 */
const TRANSITIONS: Record<AppointmentStatusValue, AppointmentStatusValue[]> = {
  BOOKED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Statuses whose time may still be changed. A visit under way cannot be moved. */
const RESCHEDULABLE: AppointmentStatusValue[] = ['BOOKED', 'CONFIRMED'];

const APPOINTMENT_SELECT = {
  id: true,
  appointmentNumber: true,
  branchId: true,
  patientId: true,
  doctorProfileId: true,
  scheduledStart: true,
  scheduledEnd: true,
  visitType: true,
  source: true,
  status: true,
  reason: true,
  cancellationReason: true,
  checkedInAt: true,
  startedAt: true,
  completedAt: true,
  patient: { select: { firstName: true, lastName: true, uhid: true } },
  registration: { select: { mrn: true } },
  doctorProfile: { select: { user: { select: { fullName: true } } } },
} as const;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

/**
 * A patient's display name. `users` carries one `full_name` column; `patients`
 * carries the two halves separately, because a duplicate check on a surname is
 * the thing that stops one human being from getting two UHIDs.
 */
function patientName(parts: { firstName: string; lastName: string | null }): string {
  return parts.lastName === null ? parts.firstName : `${parts.firstName} ${parts.lastName}`;
}

function toSummary(row: AppointmentRow): AppointmentSummary {
  return {
    id: row.id,
    appointmentNumber: row.appointmentNumber,
    branchId: row.branchId,
    patientId: row.patientId,
    patientName: patientName(row.patient),
    uhid: row.patient.uhid,
    doctorProfileId: row.doctorProfileId,
    doctorName: row.doctorProfile.user.fullName,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    visitType: row.visitType,
    source: row.source,
    status: row.status,
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
  };
}

/**
 * ⚠️ THE ALLOW-LIST. Everything that may reach `audit_logs` about a booking, and
 *   nothing else. No name, no reason, no cancellation text.
 *
 *   `uhid` is here for the same reason it is exempt from `REDACTED_KEYS`: it is
 *   the identifier the audit row is ABOUT, and a trail that cannot say which
 *   patient record was touched records nothing useful.
 */
function snapshot(row: AppointmentRow): Record<string, unknown> {
  return {
    appointmentNumber: row.appointmentNumber,
    branchId: row.branchId,
    patientId: row.patientId,
    uhid: row.patient.uhid,
    doctorProfileId: row.doctorProfileId,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    visitType: row.visitType,
    source: row.source,
    status: row.status,
    hasReason: row.reason !== null,
  };
}

/**
 * True when the error is the double-booking EXCLUDE constraint firing.
 *
 * Narrowed STRUCTURALLY, per CONVENTIONS — the constraint name and the SQLSTATE,
 * never `instanceof`. Prisma has no dedicated code for an exclusion violation;
 * it arrives as a raw database error whose message carries 23P01.
 */
function isOverlapViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = String((err as { message?: unknown }).message ?? '');
  return message.includes('appointments_no_doctor_overlap') || message.includes('23P01');
}

/**
 * The clash message. Deliberately says nothing about who holds the slot.
 *
 * The database's DETAIL names the conflicting range and would let a caller
 * enumerate another branch's diary one probe at a time. It is never echoed.
 */
function slotTakenError(): ConflictError {
  return new ConflictError('That time is no longer free. Pick another slot.');
}

function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  /*
   * 404, not 403. Whether a branch exists is itself tenant information, and the
   * two responses tell an outsider apart from a colleague.
   */
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');
}

/**
 * Check the requested time against the engine, and return the slot end.
 *
 * A booking longer than one slot has to consume CONSECUTIVE free slots — a
 * 45-minute procedure at 10:00 needs 10:00, 10:15 and 10:30 all free, and all
 * three inside the same block of working hours. Checking only the first is how
 * a procedure gets booked over the end of the clinic.
 */
function resolveSlotEnd(
  availability: AvailabilityResponse,
  startsAt: Date,
  durationMinutes: number | undefined
): Date {
  const index = availability.slots.findIndex(
    (s) => new Date(s.startsAt).getTime() === startsAt.getTime()
  );
  const first = availability.slots[index];
  if (index === -1 || first === undefined) {
    throw new ValidationError('That is not a slot this doctor works. Pick one that is offered.');
  }

  const slotMs = new Date(first.endsAt).getTime() - new Date(first.startsAt).getTime();
  const needed = durationMinutes === undefined ? 1 : Math.ceil((durationMinutes * 60_000) / slotMs);

  let end = new Date(first.startsAt);
  for (let i = 0; i < needed; i += 1) {
    const slot = availability.slots[index + i];
    if (slot === undefined) {
      throw new ValidationError('That does not fit in the doctor’s hours. Try a shorter booking.');
    }
    if (!slot.available) {
      throw slot.reason === 'BOOKED' || slot.reason === 'BLOCK_FULL'
        ? slotTakenError()
        : new ValidationError('That time cannot be booked.');
    }
    /*
     * Contiguity is not implied by adjacency in the array: a morning block ends
     * and an evening block begins, and the two slots sit next to each other in
     * the list with three hours between them.
     */
    if (new Date(slot.startsAt).getTime() !== end.getTime()) {
      throw new ValidationError('That does not fit in one block of the doctor’s hours.');
    }
    end = new Date(slot.endsAt);
  }

  return end;
}

/** Write the status trail row. Append-only: nothing ever updates one. */
async function recordTransition(
  tx: TxClient,
  ctx: TenantContext,
  appointmentId: string,
  from: AppointmentStatusValue | null,
  to: AppointmentStatusValue,
  note?: string | undefined
): Promise<void> {
  await tx.appointmentStatusHistory.create({
    data: {
      organizationId: ctx.organizationId,
      appointmentId,
      ...(from !== null ? { fromStatus: from } : {}),
      toStatus: to,
      ...(ctx.userId !== undefined ? { changedBy: ctx.userId } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAvailability(
  ctx: TenantContext,
  input: { branchId: string; doctorProfileId: string; date: string }
): Promise<AvailabilityResponse> {
  assertBranchInScope(ctx, input.branchId);
  return withTenant(ctx, (tx) => computeAvailability(tx, ctx, input));
}

/**
 * The day board.
 *
 * ⚠️ NO `data_access_logs` ROW, DELIBERATELY.
 *   The rule is: log a read that discloses clinical content, or that singles out
 *   one patient's record. A list of who is expected at the front desk today,
 *   read by the person running that desk, is neither — and it is polled. Logging
 *   it would turn a table meant to answer "who looked at this patient's file?"
 *   into a per-refresh firehose, which is the same as not having it.
 *
 *   The row therefore carries the patient's NAME (a desk that cannot see who is
 *   arriving at 10:20 cannot work) but NOT `reason`. Name plus reason on a
 *   screen anyone can glance at is the disclosure this split exists to prevent;
 *   `reason` lives on the detail response, which does log.
 */
export async function listDay(
  ctx: TenantContext,
  query: AppointmentListQuery
): Promise<AppointmentListResponse> {
  assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const [start, end] = await dayBounds(tx, query.branchId, query.date);

    const rows = await tx.appointment.findMany({
      where: {
        branchId: query.branchId,
        deletedAt: null,
        scheduledStart: { gte: start, lt: end },
        ...(query.doctorProfileId !== undefined ? { doctorProfileId: query.doctorProfileId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      select: APPOINTMENT_SELECT,
      orderBy: [{ scheduledStart: 'asc' }, { status: 'asc' }],
    });

    /*
     * Zero-filled rather than sparse: a board header that renders
     * "Cancelled 3" one minute and nothing the next, because the key vanished
     * when the count reached zero, reads as a bug in the board.
     */
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
      AppointmentStatusValue,
      number
    >;
    for (const row of rows) counts[row.status] += 1;

    return { appointments: rows.map(toSummary), counts };
  });
}

/** The day's bounds as instants, converted in Postgres from the branch's zone. */
async function dayBounds(tx: TxClient, branchId: string, date: string): Promise<[Date, Date]> {
  /* ⚠️ `::timestamp` is load-bearing — see the note in availability.service.ts. */
  const rows = await tx.$queryRaw<{ day_start: Date; day_end: Date }[]>`
    SELECT (${date}::date)::timestamp                    AT TIME ZONE b.timezone AS day_start,
           (${date}::date + interval '1 day')::timestamp AT TIME ZONE b.timezone AS day_end
      FROM branches b
     WHERE b.id = ${branchId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Branch');
  return [row.day_start, row.day_end];
}

/**
 * One booking, in full.
 *
 * This one DOES log: it discloses `reason`, which is clinical content, about one
 * named patient. The log is written inside the transaction that read it — a read
 * whose evidence can fail independently is a read with no evidence.
 */
export async function getAppointment(
  ctx: TenantContext,
  appointmentId: string,
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!row) throw new NotFoundError('Appointment');

    const history = await tx.appointmentStatusHistory.findMany({
      where: { appointmentId },
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        changedBy: true,
        note: true,
        changedAt: true,
        changer: { select: { fullName: true } },
      },
      orderBy: { changedAt: 'asc' },
    });

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'APPOINTMENT',
      patientId: row.patientId,
      resourceId: row.id,
      branchId: row.branchId,
      ...options,
    });

    return {
      ...toSummary(row),
      reason: row.reason,
      cancellationReason: row.cancellationReason,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      mrn: row.registration.mrn,
      statusHistory: history.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        changedBy: h.changedBy,
        changedByName: h.changer?.fullName ?? null,
        note: h.note,
        changedAt: h.changedAt.toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createAppointment(
  ctx: TenantContext,
  input: CreateAppointmentRequest,
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  assertBranchInScope(ctx, input.branchId);
  const startsAt = new Date(input.startsAt);

  try {
    const row = await withTenant(ctx, async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: input.patientId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!patient) throw new NotFoundError('Patient');
      if (patient.status === 'MERGED') {
        throw new ConflictError('That record has been merged into another one.');
      }
      if (patient.status === 'DECEASED') {
        throw new ConflictError('That patient is recorded as deceased.');
      }

      /*
       * The date is resolved in Postgres from the branch's zone. Deriving it in
       * Node would validate an 19:00 IST booking against tomorrow's
       * availability — which is usually empty, so it would pass.
       */
      const date = await branchLocalDate(tx, input.branchId, startsAt);
      const availability = await computeAvailability(tx, ctx, {
        branchId: input.branchId,
        doctorProfileId: input.doctorProfileId,
        date,
      });
      const endsAt = resolveSlotEnd(availability, startsAt, input.durationMinutes);

      const registration = await ensureRegistration(tx, ctx, input.patientId, input.branchId);

      /*
       * ⚠️ LAST, IMMEDIATELY BEFORE THE INSERT. `issueNumber` takes a row lock
       * held until COMMIT, which serialises every concurrent booking at this
       * branch. Everything above — availability, registration — is done first so
       * the lock window is one statement wide rather than the whole booking.
       */
      const number = await issueNumber(tx, ctx, {
        type: 'APPOINTMENT',
        branchId: input.branchId,
        prefix: APPOINTMENT_PREFIX,
      });

      const created = await tx.appointment.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: input.branchId,
          patientId: input.patientId,
          patientRegistrationId: registration.id,
          doctorProfileId: input.doctorProfileId,
          appointmentNumber: number.formatted,
          scheduledStart: startsAt,
          scheduledEnd: endsAt,
          visitType: input.visitType,
          source: input.source,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(ctx.userId !== undefined ? { bookedBy: ctx.userId } : {}),
        },
        select: APPOINTMENT_SELECT,
      });

      await recordTransition(tx, ctx, created.id, null, 'BOOKED');

      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'appointment',
        entityId: created.id,
        after: snapshot(created),
        branchId: input.branchId,
        ...options,
      });

      return created;
    });

    return detailOf(row, []);
  } catch (err) {
    /*
     * Caught OUTSIDE `withTenant`: an exclusion violation aborts the
     * transaction, so anything attempted after it inside the callback fails
     * with 25P02 instead of producing this message.
     */
    if (isOverlapViolation(err)) throw slotTakenError();
    throw err;
  }
}

/**
 * Move a booking, possibly to a different doctor.
 *
 * A separate call from `updateAppointment` on purpose: this one re-runs the
 * availability check and writes to the status trail. Folding it into a general
 * PATCH is how one of those gets skipped.
 */
export async function rescheduleAppointment(
  ctx: TenantContext,
  appointmentId: string,
  input: RescheduleAppointmentRequest,
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const startsAt = new Date(input.startsAt);

  try {
    const row = await withTenant(ctx, async (tx) => {
      const before = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: APPOINTMENT_SELECT,
      });
      if (!before) throw new NotFoundError('Appointment');
      if (!RESCHEDULABLE.includes(before.status)) {
        throw new ConflictError(
          `An appointment that is ${before.status.toLowerCase().replace('_', ' ')} cannot be moved.`
        );
      }

      const doctorProfileId = input.doctorProfileId ?? before.doctorProfileId;
      const date = await branchLocalDate(tx, before.branchId, startsAt);
      const availability = await computeAvailability(tx, ctx, {
        branchId: before.branchId,
        doctorProfileId,
        date,
      });
      const endsAt = resolveSlotEnd(availability, startsAt, input.durationMinutes);

      const after = await tx.appointment.update({
        where: { id: appointmentId },
        data: { scheduledStart: startsAt, scheduledEnd: endsAt, doctorProfileId },
        select: APPOINTMENT_SELECT,
      });

      /*
       * No status-trail row: the status did not change, and a
       * `BOOKED -> BOOKED` entry would make every waiting-time report have to
       * learn to ignore it. The move is in `audit_logs`, where a before/after
       * of two timestamps is exactly what that table is for.
       */
      await recordAudit(tx, ctx, {
        action: 'UPDATE',
        entityType: 'appointment',
        entityId: appointmentId,
        before: snapshot(before),
        after: snapshot(after),
        branchId: before.branchId,
        ...options,
      });

      return after;
    });

    return detailOf(row, []);
  } catch (err) {
    if (isOverlapViolation(err)) throw slotTakenError();
    throw err;
  }
}

/** Visit type and reason. Neither moves the booking nor changes its status. */
export async function updateAppointment(
  ctx: TenantContext,
  appointmentId: string,
  input: UpdateAppointmentRequest,
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!before) throw new NotFoundError('Appointment');

    const after = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        ...(input.visitType !== undefined ? { visitType: input.visitType } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      select: APPOINTMENT_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'appointment',
      entityId: appointmentId,
      before: snapshot(before),
      after: snapshot(after),
      branchId: before.branchId,
      ...options,
    });

    return after;
  });

  return detailOf(row, []);
}

/**
 * CONFIRMED, CHECKED_IN, IN_PROGRESS, COMPLETED.
 *
 * ⚠️ THE TIMESTAMPS ARE SET HERE AND NOWHERE ELSE, and CHECK constraints refuse
 *   the row without them: a CHECKED_IN appointment with no `checked_in_at` makes
 *   every waiting-time report silently wrong, and nothing else would notice.
 */
export async function transitionAppointment(
  ctx: TenantContext,
  appointmentId: string,
  input: { status: AppointmentStatusValue; note?: string | undefined },
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!before) throw new NotFoundError('Appointment');

    assertTransition(before.status, input.status);

    const now = new Date();
    const after = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        status: input.status,
        ...(input.status === 'CHECKED_IN' ? { checkedInAt: now } : {}),
        ...(input.status === 'IN_PROGRESS' ? { startedAt: now } : {}),
        ...(input.status === 'COMPLETED' ? { completedAt: now } : {}),
      },
      select: APPOINTMENT_SELECT,
    });

    await recordTransition(tx, ctx, appointmentId, before.status, input.status, input.note);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { status: before.status },
      after: { status: after.status },
      branchId: before.branchId,
      ...options,
    });

    return after;
  });

  return detailOf(row, []);
}

/**
 * Cancel. Frees the slot, because the EXCLUDE constraint's predicate excludes
 * CANCELLED — there is no separate release step to forget.
 *
 * `cancelledBy` is enforced by a CHECK constraint as well as set here: a
 * cancellation with nobody's name on it is the row the clinic cannot explain to
 * the patient who turned up anyway.
 */
export async function cancelAppointment(
  ctx: TenantContext,
  appointmentId: string,
  input: { reason: string },
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!before) throw new NotFoundError('Appointment');
    assertTransition(before.status, 'CANCELLED');

    if (ctx.userId === undefined) {
      /*
       * Unreachable through the API — every route here is behind
       * `requireAuth`. The CHECK constraint would refuse the row anyway; this
       * names the reason instead of surfacing a constraint violation.
       */
      throw new ValidationError('A cancellation must record who made it.');
    }

    const after = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CANCELLED',
        cancelledBy: ctx.userId,
        cancellationReason: input.reason,
      },
      select: APPOINTMENT_SELECT,
    });

    await recordTransition(tx, ctx, appointmentId, before.status, 'CANCELLED');

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { status: before.status },
      /* ⚠️ The reason itself is PHI and stays out. THAT it was given is not. */
      after: { status: 'CANCELLED', cancelledBy: ctx.userId, hasCancellationReason: true },
      branchId: before.branchId,
      ...options,
    });

    return after;
  });

  return detailOf(row, []);
}

/**
 * Mark a patient absent.
 *
 * Its own endpoint rather than a value on the transition call, because it is a
 * fact ABOUT THE PATIENT that a billing rule may later act on, and because the
 * transition map refuses it after check-in — someone standing at the desk
 * cannot retrospectively not have turned up.
 */
export async function markNoShow(
  ctx: TenantContext,
  appointmentId: string,
  input: { note?: string | undefined },
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!before) throw new NotFoundError('Appointment');
    assertTransition(before.status, 'NO_SHOW');

    const after = await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: 'NO_SHOW' },
      select: APPOINTMENT_SELECT,
    });

    await recordTransition(tx, ctx, appointmentId, before.status, 'NO_SHOW', input.note);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { status: before.status },
      after: { status: 'NO_SHOW' },
      branchId: before.branchId,
      ...options,
    });

    return after;
  });

  return detailOf(row, []);
}

function assertTransition(from: AppointmentStatusValue, to: AppointmentStatusValue): void {
  if (from === to) {
    throw new ConflictError(`That appointment is already ${from.toLowerCase().replace('_', ' ')}.`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictError(
      `An appointment that is ${from.toLowerCase().replace('_', ' ')} cannot become ` +
        `${to.toLowerCase().replace('_', ' ')}.`
    );
  }
}

/**
 * A write's response.
 *
 * The status trail is left empty rather than re-read: a caller that wants the
 * history asks for the detail, which is the endpoint that logs the disclosure.
 * Returning it here would hand back clinical notes from a call that only moved a
 * booking, with no data-access row saying so.
 */
function detailOf(
  row: AppointmentRow,
  statusHistory: AppointmentDetail['statusHistory']
): AppointmentDetail {
  return {
    ...toSummary(row),
    reason: row.reason,
    cancellationReason: row.cancellationReason,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    mrn: row.registration.mrn,
    statusHistory,
  };
}
