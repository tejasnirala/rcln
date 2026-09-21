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
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  DecideScheduleExceptionRequest,
  DoctorScheduleDetail,
  DoctorScheduleExceptionDetail,
  DoctorScheduleExceptionRequest,
  DoctorScheduleRequest,
  DoctorWeekResponse,
  SetDoctorWeekRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
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
export function isScheduleOverlap(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = String((err as { message?: unknown }).message ?? '');
  return message.includes('doctor_schedules_no_overlap') || message.includes('23P01');
}

/**
 * Two blocks the exclusion constraint would refuse each other.
 *
 * ⚠️ THIS IS A PRE-CHECK, NOT THE RULE. `doctor_schedules_no_overlap` is the
 *   authority and stays so — a race between two admins is caught there and
 *   nowhere else. This exists because a set of blocks submitted TOGETHER (a whole
 *   week, at registration) can clash with each other, and discovering that from
 *   the database means an aborted transaction with no way to say WHICH two rows
 *   were the problem. Catching it here names the pair.
 *
 * Mirrors the constraint's own predicate: same branch, same weekday, overlapping
 * clock ranges AND overlapping validity windows. A block that ends where the next
 * begins does not overlap — the ranges are half-open.
 */
function blocksClash(a: DoctorScheduleRequest, b: DoctorScheduleRequest): boolean {
  if (a.branchId !== b.branchId || a.dayOfWeek !== b.dayOfWeek) return false;
  if (a.startTime >= b.endTime || b.startTime >= a.endTime) return false;

  const aTo = a.validTo ?? '9999-12-31';
  const bTo = b.validTo ?? '9999-12-31';
  return a.validFrom <= bTo && b.validFrom <= aTo;
}

/**
 * Check a set of blocks against each other before any of them is written.
 *
 * Exported for `createDoctor`, which inserts a whole week inside one transaction
 * and must fail with a message rather than a 25P02.
 */
export function assertNoInternalOverlap(blocks: DoctorScheduleRequest[]): void {
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (a === undefined || b === undefined) continue;
      if (blocksClash(a, b)) {
        throw new ValidationError(
          `Two blocks of working hours overlap: ${a.startTime}–${a.endTime} and ${b.startTime}–${b.endTime} on the same day at the same branch.`
        );
      }
    }
  }
}

/**
 * Insert one block inside a caller's transaction, audit row included.
 *
 * ⚠️ NO try/catch HERE, AND THAT IS THE CALLER'S JOB. An exclusion violation
 *   aborts the whole transaction, so it can only be translated OUTSIDE the
 *   `withTenant` that contained it — see `addSchedule` below, which is the
 *   comment's original home and still the reason this split exists.
 */
export async function createScheduleRow(
  tx: TxClient,
  ctx: TenantContext,
  doctorId: string,
  input: DoctorScheduleRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
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
}

/**
 * Turn schedule rows into contract detail, resolving each block's effective slot
 * length through the ONE authoritative chain (ADR-0015).
 *
 * ⚠️ THE RESOLUTION IS MEMOISED PER (branch, doctor, override). The ladder is a
 *   read per call and a roster of forty doctors with a six-block week each is two
 *   hundred and forty of them to render one list — while the answer only ever
 *   varies by those three inputs. Memoising is what makes the batched list below
 *   cheaper than the per-doctor calls it replaced, rather than merely tidier.
 */
async function toScheduleDetails(
  tx: TxClient,
  ctx: TenantContext,
  rows: ScheduleRow[]
): Promise<DoctorScheduleDetail[]> {
  const resolved = new Map<string, number>();
  const details: DoctorScheduleDetail[] = [];

  for (const row of rows) {
    const key = `${row.branchId}|${row.doctorProfileId}|${String(row.slotMinutes)}`;
    let minutes = resolved.get(key);
    if (minutes === undefined) {
      minutes = await effectiveSlotMinutes(
        tx,
        ctx,
        { branchId: row.branchId, doctorProfileId: row.doctorProfileId },
        row.slotMinutes
      );
      resolved.set(key, minutes);
    }

    details.push({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      dayOfWeek: row.dayOfWeek,
      startTime: fromTime(row.startTime),
      endTime: fromTime(row.endTime),
      slotMinutes: row.slotMinutes,
      effectiveSlotMinutes: minutes,
      maxPatients: row.maxPatients,
      validFrom: fromDate(row.validFrom) as string,
      validTo: fromDate(row.validTo),
      isActive: row.isActive,
    });
  }

  return details;
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
    return toScheduleDetails(tx, ctx, rows);
  });
}

/**
 * Every listed doctor's week, in ONE query.
 *
 * ⚠️ THIS REPLACED AN N+1 THE WEB APP WAS MAKING OVER HTTP. The roster page used
 *   to call `GET /doctors/:id/schedules` once per doctor after listing them —
 *   thirty doctors, thirty extra round trips, each opening its own transaction.
 *   Runs inside the caller's `withTenant` so the schedules and the profiles they
 *   belong to are read in the same snapshot.
 */
export async function listSchedulesForDoctors(
  tx: TxClient,
  ctx: TenantContext,
  doctorIds: string[]
): Promise<Map<string, DoctorScheduleDetail[]>> {
  const byDoctor = new Map<string, DoctorScheduleDetail[]>();
  if (doctorIds.length === 0) return byDoctor;

  const rows = await tx.doctorSchedule.findMany({
    where: { doctorProfileId: { in: doctorIds } },
    select: SCHEDULE_SELECT,
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });

  const details = await toScheduleDetails(tx, ctx, rows);
  for (const [index, detail] of details.entries()) {
    // `toScheduleDetails` preserves order, so the row at the same index is the
    // one this detail came from — and it carries the doctor the detail does not.
    const doctorId = rows[index]?.doctorProfileId;
    if (doctorId === undefined) continue;
    const bucket = byDoctor.get(doctorId) ?? [];
    bucket.push(detail);
    byDoctor.set(doctorId, bucket);
  }
  return byDoctor;
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

      await createScheduleRow(tx, ctx, doctorId, input, options);
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

// -- the week, as the schedule table edits it (DS-1) -------------------------

/**
 * A doctor's week at one branch, in the shape the table renders.
 *
 * ⚠️ THE TABLE IS A VIEW OF `doctor_schedules`, NOT A SECOND STORE. Two rows for
 *   one day become the morning and evening columns; anything a clinic created
 *   through the old block form still reads back here. A third block on one day
 *   — which the old form allowed and this one cannot create — is not silently
 *   dropped: it is folded into the span, so the table shows the doctor's real
 *   working window rather than pretending the row does not exist. Saving then
 *   normalises it to two periods, which is the only lossy moment and is the
 *   user's own edit.
 */
export async function getDoctorWeek(
  ctx: TenantContext,
  doctorId: string,
  branchId: string
): Promise<DoctorWeekResponse> {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: {
        name: true,
        operatingHours: {
          select: { dayOfWeek: true, opensAt: true, closesAt: true, isClosed: true },
          orderBy: { dayOfWeek: 'asc' },
        },
      },
    });
    if (!branch) throw new NotFoundError('Branch');

    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    const [setting, rows, minutes] = await Promise.all([
      tx.doctorBranchSetting.findFirst({
        where: { doctorProfileId: doctorId, branchId },
        select: { followsBranchHours: true },
      }),
      tx.doctorSchedule.findMany({
        where: { doctorProfileId: doctorId, branchId, isActive: true },
        select: {
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          slotMinutes: true,
          maxPatients: true,
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
      effectiveSlotMinutes(tx, ctx, { branchId, doctorProfileId: doctorId }, null),
    ]);

    const days = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
      const blocks = rows.filter((r) => r.dayOfWeek === dayOfWeek);
      const first = blocks[0];
      const rest = blocks.slice(1);

      return {
        dayOfWeek,
        morning: first
          ? { startTime: fromTime(first.startTime), endTime: fromTime(first.endTime) }
          : null,
        /*
         * Everything after the first block collapses into ONE evening period
         * spanning from the second block's start to the last block's end. A
         * clinic with three blocks on a Tuesday is rare and was expressible; the
         * table shows the true outer window rather than hiding the third.
         */
        evening:
          rest.length > 0 && rest[0] && rest[rest.length - 1]
            ? {
                startTime: fromTime(rest[0].startTime),
                endTime: fromTime(rest[rest.length - 1]!.endTime),
              }
            : null,
        slotMinutes: first?.slotMinutes ?? null,
        maxPatients: first?.maxPatients ?? null,
      };
    });

    return {
      branchId,
      branchName: branch.name,
      followsBranchHours: setting?.followsBranchHours ?? false,
      days,
      branchHours: branch.operatingHours.map((h) => ({
        dayOfWeek: h.dayOfWeek,
        opensAt: fromTime(h.opensAt),
        closesAt: fromTime(h.closesAt),
        isClosed: h.isClosed,
      })),
      effectiveSlotMinutes: minutes,
    };
  });
}

/**
 * Replace a doctor's whole week at one branch.
 *
 * ⚠️ NOT A PARTIAL UPDATE, for the reason `setOperatingHours` is not one: a week
 *   is read as a set, and a per-day write leaves the doctor half on the new rota
 *   and half on the old with nothing recording which is which.
 *
 * ⚠️ `followsBranchHours` SHORT-CIRCUITS THE DAYS AND DOES NOT DELETE THEM. A
 *   doctor moved onto clinic hours keeps whatever week they had, inert; moving
 *   them back restores it. Deleting would make the toggle destructive in a way
 *   nothing on the screen warns about, and "same as the clinic" is a sentence
 *   people flip back and forth while setting a practice up.
 *
 * ⚠️ AND THE OLD ROWS ARE DELETED RATHER THAN CLOSED OFF WITH `valid_to`.
 *   `doctor_schedules` is effective-dated so a clinic can post next month's rota
 *   in advance, but this endpoint edits THE CURRENT WEEK — and appointments
 *   already booked carry their own times, so nothing historical reads these
 *   rows. Keeping supserseded weeks would mean the engine had to pick between
 *   two rotas for the same Tuesday, which is exactly the ambiguity the old form
 *   produced.
 */
export async function setDoctorWeek(
  ctx: TenantContext,
  doctorId: string,
  input: SetDoctorWeekRequest,
  options: DoctorActionOptions = {}
): Promise<DoctorWeekResponse> {
  if (!ctx.branchIds.includes(input.branchId)) throw new NotFoundError('Branch');

  await withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    const before = await tx.doctorSchedule.findMany({
      where: { doctorProfileId: doctorId, branchId: input.branchId },
      select: { dayOfWeek: true, startTime: true, endTime: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
    const previous = await tx.doctorBranchSetting.findFirst({
      where: { doctorProfileId: doctorId, branchId: input.branchId },
      select: { id: true, followsBranchHours: true },
    });

    /*
     * The flag lives on the doctor↔branch relationship, which may not exist yet
     * — a doctor registered without branch settings is ordinary. `findFirst`
     * then create/update rather than `upsert`, the same call every other write
     * against a compound unique in this codebase makes.
     */
    if (previous) {
      await tx.doctorBranchSetting.update({
        where: { id: previous.id },
        data: { followsBranchHours: input.followsBranchHours },
      });
    } else {
      await tx.doctorBranchSetting.create({
        data: {
          organizationId: ctx.organizationId,
          doctorProfileId: doctorId,
          branchId: input.branchId,
          followsBranchHours: input.followsBranchHours,
        },
      });
    }

    if (!input.followsBranchHours) {
      await tx.doctorSchedule.deleteMany({
        where: { doctorProfileId: doctorId, branchId: input.branchId },
      });

      const validFrom = new Date(`${input.validFrom ?? todayIso()}T00:00:00Z`);

      const blocks = input.days.flatMap((day) =>
        (['morning', 'evening'] as const).flatMap((key) => {
          const period = day[key];
          if (!period) return [];
          return [
            {
              organizationId: ctx.organizationId,
              doctorProfileId: doctorId,
              branchId: input.branchId,
              dayOfWeek: day.dayOfWeek,
              startTime: toTime(period.startTime),
              endTime: toTime(period.endTime),
              slotMinutes: day.slotMinutes,
              maxPatients: day.maxPatients,
              validFrom,
              isActive: true,
            },
          ];
        })
      );

      if (blocks.length > 0) await tx.doctorSchedule.createMany({ data: blocks });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'doctor_schedules',
      entityId: doctorId,
      before: {
        followsBranchHours: previous?.followsBranchHours ?? false,
        // The week as a whole, in a form a human can read back.
        week: before.map(
          (b) => `${String(b.dayOfWeek)} ${fromTime(b.startTime)}-${fromTime(b.endTime)}`
        ),
      },
      after: {
        followsBranchHours: input.followsBranchHours,
        week: input.followsBranchHours
          ? 'the branch’s own opening hours'
          : input.days.flatMap((d) =>
              [d.morning, d.evening]
                .filter((p) => p !== null)
                .map((p) => `${String(d.dayOfWeek)} ${p.startTime}-${p.endTime}`)
            ),
      },
      branchId: input.branchId,
      ...options,
    });
  });

  return getDoctorWeek(ctx, doctorId, input.branchId);
}

/** Today, as a calendar day. The rota starts applying now unless told otherwise. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
