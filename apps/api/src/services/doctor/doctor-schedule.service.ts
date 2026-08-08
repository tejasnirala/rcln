/**
 * Working hours and the exceptions to them — the input the availability engine
 * reads on every booking.
 *
 * ⚠️ TIMES HERE ARE WALL-CLOCK IN THE BRANCH'S TIMEZONE.
 *   `doctor_schedules.start_time` is a Postgres `time` with no date and no
 *   offset. "09:00" means nine in the morning AT THAT BRANCH, and
 *   `branches.timezone` is the only thing that says what instant that is. The
 *   conversion happens in Postgres (`AT TIME ZONE`) inside the availability
 *   engine, never here and never in Node — the container runs UTC, so building
 *   a Date from local components silently turns 09:00 IST into 03:30.
 *
 *   `toTime`/`fromTime` below are the same pair as `branch.service.ts`, and the
 *   comment there exists because this has already gone wrong once.
 *
 * ⚠️ EXCEPTIONS ARE `timestamptz`, NOT a date plus a time.
 *   "Away from Friday 18:00 until Monday 09:00" is one absolute interval that
 *   does not repeat, so there is nothing for a wall-clock reading to anchor to.
 */
import { withTenant, type Prisma, type TenantContext } from '@rcln/db';
import type {
  DecideScheduleExceptionRequest,
  DoctorScheduleDetail,
  DoctorScheduleExceptionDetail,
  DoctorScheduleExceptionRequest,
  DoctorScheduleRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { effectiveSlotMinutes, type DoctorActionOptions } from './doctor.service.js';

/**
 * Postgres `time` has no date, but Prisma surfaces it as a `DateTime`.
 *
 * The convention is the epoch date with the wanted clock time in UTC, applied
 * consistently in both directions. Building a Date from local components
 * instead shifts the value by the server's offset — in IST, 09:00 becomes
 * 03:30, with nothing to indicate it happened.
 */
function toTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

function fromTime(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** A bare `date` column: read it in UTC or it slides a day either way. */
function toDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00.000Z`);
}

function fromDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

const SCHEDULE_SELECT = {
  id: true,
  branchId: true,
  doctorProfileId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  slotMinutes: true,
  maxPatients: true,
  validFrom: true,
  validTo: true,
  isActive: true,
  branch: { select: { name: true } },
} as const;

const EXCEPTION_SELECT = {
  id: true,
  branchId: true,
  doctorProfileId: true,
  exceptionType: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  status: true,
  requestedBy: true,
  decidedBy: true,
  decidedAt: true,
  branch: { select: { name: true } },
} as const;

type ScheduleRow = Prisma.DoctorScheduleGetPayload<{ select: typeof SCHEDULE_SELECT }>;
type ExceptionRow = Prisma.DoctorScheduleExceptionGetPayload<{ select: typeof EXCEPTION_SELECT }>;

function toExceptionDetail(row: ExceptionRow): DoctorScheduleExceptionDetail {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch?.name ?? null,
    exceptionType: row.exceptionType,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function snapshotSchedule(row: ScheduleRow): Record<string, unknown> {
  return {
    doctorProfileId: row.doctorProfileId,
    branchId: row.branchId,
    dayOfWeek: row.dayOfWeek,
    startTime: fromTime(row.startTime),
    endTime: fromTime(row.endTime),
    slotMinutes: row.slotMinutes,
    maxPatients: row.maxPatients,
    validFrom: fromDate(row.validFrom),
    validTo: fromDate(row.validTo),
    isActive: row.isActive,
  };
}

/**
 * True when the error is the schedule-overlap EXCLUDE constraint firing.
 *
 * Narrowed STRUCTURALLY, per CONVENTIONS — `err.name` and the constraint name,
 * never `instanceof`. Prisma has no dedicated code for an exclusion violation;
 * it surfaces as a raw database error whose message carries the SQLSTATE
 * (23P01) and the constraint name.
 */
function isScheduleOverlap(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = String((err as { message?: unknown }).message ?? '');
  return message.includes('doctor_schedules_no_overlap') || message.includes('23P01');
}

export async function listSchedules(
  ctx: TenantContext,
  doctorId: string
): Promise<DoctorScheduleDetail[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.doctorSchedule.findMany({
      where: { doctorProfileId: doctorId },
      select: SCHEDULE_SELECT,
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    /*
     * Resolve each block's effective slot length through the ONE authoritative
     * chain (ADR-0015) rather than re-deriving it in the UI. Sequential on
     * purpose: the resolver batches keys, not calls, and a week is at most a
     * handful of rows.
     */
    const details: DoctorScheduleDetail[] = [];
    for (const row of rows) {
      details.push({
        id: row.id,
        branchId: row.branchId,
        branchName: row.branch.name,
        dayOfWeek: row.dayOfWeek,
        startTime: fromTime(row.startTime),
        endTime: fromTime(row.endTime),
        slotMinutes: row.slotMinutes,
        effectiveSlotMinutes: await effectiveSlotMinutes(
          tx,
          ctx,
          { branchId: row.branchId, doctorProfileId: row.doctorProfileId },
          row.slotMinutes
        ),
        maxPatients: row.maxPatients,
        validFrom: fromDate(row.validFrom) as string,
        validTo: fromDate(row.validTo),
        isActive: row.isActive,
      });
    }
    return details;
  });
}

export async function addSchedule(
  ctx: TenantContext,
  doctorId: string,
  input: DoctorScheduleRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
  if (!ctx.branchIds.includes(input.branchId)) throw new NotFoundError('Branch');

  try {
    await withTenant(ctx, async (tx) => {
      const doctor = await tx.doctorProfile.findFirst({
        where: { id: doctorId, deletedAt: null },
        select: { id: true },
      });
      if (!doctor) throw new NotFoundError('Doctor');

      const created = await tx.doctorSchedule.create({
        data: {
          organizationId: ctx.organizationId,
          doctorProfileId: doctorId,
          branchId: input.branchId,
          dayOfWeek: input.dayOfWeek,
          startTime: toTime(input.startTime),
          endTime: toTime(input.endTime),
          ...(input.slotMinutes !== undefined ? { slotMinutes: input.slotMinutes } : {}),
          ...(input.maxPatients !== undefined ? { maxPatients: input.maxPatients } : {}),
          validFrom: toDate(input.validFrom),
          ...(input.validTo !== undefined ? { validTo: toDate(input.validTo) } : {}),
          isActive: input.isActive,
        },
        select: SCHEDULE_SELECT,
      });

      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'doctor_schedule',
        entityId: created.id,
        after: snapshotSchedule(created),
        branchId: input.branchId,
        ...options,
      });
    });
  } catch (err) {
    /*
     * Caught OUTSIDE `withTenant`, and this is not a style choice: an exclusion
     * violation aborts the transaction, so anything attempted after it inside
     * the callback fails with 25P02 instead of producing this message.
     *
     * The database's DETAIL names the conflicting doctor and the exact range.
     * It is never echoed — under branch scoping the conflicting row may be one
     * this caller is not allowed to see.
     */
    if (isScheduleOverlap(err)) {
      throw new ConflictError(
        'Those hours overlap another block for this doctor at this branch on that day.'
      );
    }
    throw err;
  }
}

export async function removeSchedule(
  ctx: TenantContext,
  doctorId: string,
  scheduleId: string,
  options: DoctorActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.doctorSchedule.findFirst({
      where: { id: scheduleId, doctorProfileId: doctorId },
      select: SCHEDULE_SELECT,
    });
    if (!row) throw new NotFoundError('Schedule');

    await tx.doctorSchedule.delete({ where: { id: row.id } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'doctor_schedule',
      entityId: row.id,
      before: snapshotSchedule(row),
      branchId: row.branchId,
      ...options,
    });
  });
}

export async function listExceptions(
  ctx: TenantContext,
  doctorId: string
): Promise<DoctorScheduleExceptionDetail[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx.doctorScheduleException.findMany({
      where: { doctorProfileId: doctorId },
      select: EXCEPTION_SELECT,
      orderBy: { startsAt: 'desc' },
    })
  );
  return rows.map(toExceptionDetail);
}

/**
 * Raise an exception. Lands as REQUESTED and changes nothing until approved.
 *
 * Two permissions reach here: `doctor.schedule.request` (a doctor asking for
 * their own leave) and `doctor.schedule.manage` (an admin recording it). The
 * route decides which; the service records the same row either way.
 */
export async function requestException(
  ctx: TenantContext,
  doctorId: string,
  input: DoctorScheduleExceptionRequest,
  options: DoctorActionOptions = {}
): Promise<DoctorScheduleExceptionDetail> {
  if (input.branchId !== undefined && !ctx.branchIds.includes(input.branchId)) {
    throw new NotFoundError('Branch');
  }

  const row = await withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    const created = await tx.doctorScheduleException.create({
      data: {
        organizationId: ctx.organizationId,
        doctorProfileId: doctorId,
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        exceptionType: input.exceptionType,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        requestedBy: ctx.userId,
      },
      select: EXCEPTION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'doctor_schedule_exception',
      entityId: created.id,
      after: {
        doctorProfileId: doctorId,
        exceptionType: input.exceptionType,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: 'REQUESTED',
      },
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...options,
    });

    return created;
  });

  return toExceptionDetail(row);
}

/**
 * Approve or reject a pending exception.
 *
 * Behind `doctor.schedule.approve`, which is deliberately NOT granted to the
 * DOCTOR role: a doctor approving their own leave means the availability engine
 * loses those days with nobody having agreed to it.
 *
 * Only an APPROVED row affects availability, so this call is what actually
 * changes what the clinic can book.
 */
export async function decideException(
  ctx: TenantContext,
  doctorId: string,
  exceptionId: string,
  input: DecideScheduleExceptionRequest,
  options: DoctorActionOptions = {}
): Promise<DoctorScheduleExceptionDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.doctorScheduleException.findFirst({
      where: { id: exceptionId, doctorProfileId: doctorId },
      select: EXCEPTION_SELECT,
    });
    if (!before) throw new NotFoundError('Schedule exception');

    if (before.status !== 'REQUESTED') {
      throw new ConflictError(`That request has already been ${before.status.toLowerCase()}.`);
    }

    const after = await tx.doctorScheduleException.update({
      where: { id: exceptionId },
      data: {
        status: input.decision,
        decidedBy: ctx.userId,
        decidedAt: new Date(),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      select: EXCEPTION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'doctor_schedule_exception',
      entityId: exceptionId,
      before: { status: before.status },
      after: { status: after.status, decidedBy: ctx.userId },
      ...(before.branchId !== null ? { branchId: before.branchId } : {}),
      ...options,
    });

    return after;
  });

  return toExceptionDetail(row);
}
