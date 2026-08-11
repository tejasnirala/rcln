/**
 * The availability engine: what is free, for one doctor, at one branch, on one
 * day.
 *
 * Everything that books an appointment goes through `computeAvailability` —
 * the front desk's calendar, the booking call's own validation, and eventually
 * the patient portal. A second implementation is a second answer, and the
 * symptom of two answers is a receptionist looking at a 10:20 the portal says
 * does not exist.
 *
 * ⚠️ EVERY TIMEZONE CONVERSION IN THIS FILE HAPPENS IN POSTGRES.
 *   `doctor_schedules.start_time` is a bare `time`: "09:00" means nine in the
 *   morning AT THAT BRANCH, and `branches.timezone` is the only thing that says
 *   which instant that is. The conversion is `($date::date + start_time) AT TIME
 *   ZONE b.timezone`, in SQL, because the container runs UTC — composing a Date
 *   from local components in Node turns 09:00 IST into 03:30 and nothing
 *   anywhere says so. Once a block is a pair of instants, arithmetic on it in
 *   Node is safe, and that is the only arithmetic done here.
 *
 * ⚠️ THE ENGINE IS ADVICE; THE EXCLUDE CONSTRAINT IS THE ANSWER.
 *   Two things this cannot see:
 *
 *     1. A booking made by another transaction a millisecond ago. Under READ
 *        COMMITTED it is invisible until it commits.
 *     2. A booking for the SAME doctor at a branch outside the caller's scope.
 *        `appointments` is branch-scoped by RLS, so a receptionist at branch A
 *        cannot see that the doctor is also consulting at branch B at 10:20 —
 *        and must not: that row names another clinic's patient.
 *
 *   Both end at `appointments_no_doctor_overlap`, which refuses the insert. The
 *   booking service catches it and says "that time is no longer free" without
 *   naming who took it. Widening this read to make case 2 visible would mean
 *   reading across the branch boundary on every calendar poll, which trades a
 *   rare, correctly-handled conflict for a permanent hole.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import type {
  AvailabilityResponse,
  AvailabilitySlot,
  SlotUnavailableReason,
  WorkingDayReason,
  WorkingDaysResponse,
} from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { effectiveSlotMinutes } from '../doctor/doctor.service.js';

const MINUTE_MS = 60_000;

/** One block of working hours, already resolved to absolute instants. */
interface ResolvedBlock {
  startsAt: Date;
  endsAt: Date;
  slotMinutes: number;
  maxPatients: number | null;
}

interface DayFrameRow {
  timezone: string;
  day_start: Date;
  day_end: Date;
  is_closed: boolean;
}

interface BlockRow {
  starts_at: Date;
  ends_at: Date;
  slot_minutes: number | null;
  max_patients: number | null;
}

interface ExceptionRow {
  exception_type: 'LEAVE' | 'BLOCK' | 'EXTRA_SHIFT';
  starts_at: Date;
  ends_at: Date;
}

interface BookedRow {
  scheduled_start: Date;
  scheduled_end: Date;
}

/**
 * The day as absolute instants, plus whether the branch is shut.
 *
 * Also the tenancy check: `branches` is org-scoped by RLS, so a branch in
 * another organization simply does not come back, and the caller gets a 404
 * rather than an availability response for somebody else's clinic.
 */
async function dayFrame(
  tx: TxClient,
  branchId: string,
  date: string
): Promise<DayFrameRow | undefined> {
  /*
   * ⚠️ `::timestamp` IS LOAD-BEARING AND COST A DAY'S BOOKINGS TO FIND.
   *   `date` casts implicitly to BOTH `timestamp` and `timestamptz`, so bare
   *   `d::date AT TIME ZONE tz` resolves to the timestamptz overload — which
   *   means "render this instant as wall-clock in tz" and returns a `timestamp`,
   *   the exact inverse of what is wanted. In IST the day then started at 05:30Z
   *   instead of 18:30Z the previous evening, so every morning booking fell
   *   outside its own day: the board came back empty and the engine offered
   *   slots that were already taken. Both queries returned rows, neither raised,
   *   and only the counts were wrong.
   *
   *   `day_end` is safe either way — `date + interval` is already a `timestamp`
   *   — and is cast anyway so the two lines cannot drift apart.
   */
  const rows = await tx.$queryRaw<DayFrameRow[]>`
    SELECT b.timezone,
           (${date}::date)::timestamp                    AT TIME ZONE b.timezone AS day_start,
           (${date}::date + interval '1 day')::timestamp AT TIME ZONE b.timezone AS day_end,
           EXISTS (SELECT 1 FROM branch_closures c
                    WHERE c.branch_id = b.id AND c.closure_date = ${date}::date) AS is_closed
      FROM branches b
     WHERE b.id = ${branchId}::uuid AND b.deleted_at IS NULL
  `;
  return rows[0];
}

/**
 * The doctor's recurring blocks for that weekday, as instants.
 *
 * `EXTRACT(dow FROM date)` is 0 = Sunday, which is what `day_of_week` stores —
 * the same convention as `branch_operating_hours`, chosen because it is
 * Postgres's and therefore the one that cannot drift.
 */
async function scheduleBlocks(
  tx: TxClient,
  branchId: string,
  doctorProfileId: string,
  date: string
): Promise<BlockRow[]> {
  return tx.$queryRaw<BlockRow[]>`
    SELECT (${date}::date + s.start_time) AT TIME ZONE b.timezone AS starts_at,
           (${date}::date + s.end_time)   AT TIME ZONE b.timezone AS ends_at,
           s.slot_minutes,
           s.max_patients
      FROM doctor_schedules s
      JOIN branches b ON b.id = s.branch_id
     WHERE s.branch_id         = ${branchId}::uuid
       AND s.doctor_profile_id = ${doctorProfileId}::uuid
       AND s.is_active
       AND s.day_of_week = EXTRACT(dow FROM ${date}::date)
       AND s.valid_from <= ${date}::date
       AND (s.valid_to IS NULL OR s.valid_to >= ${date}::date)
     ORDER BY s.start_time
  `;
}

/**
 * Approved exceptions overlapping the day.
 *
 * ⚠️ ONLY `APPROVED` ROWS COUNT. A REQUESTED leave changes nothing — that is
 *   the entire point of the approval step, and treating a request as a fact
 *   would let any doctor empty their own diary.
 *
 * `branch_id IS NULL` means every branch, which is why this cannot be a plain
 * equality filter. `doctor_schedule_exceptions` is deliberately NOT
 * branch-scoped by RLS for the same reason: hiding a doctor's leave from a
 * branch-scoped reader would make this engine offer slots on a day they are
 * away, and phantom availability is worse than a visible absence.
 */
async function exceptions(
  tx: TxClient,
  branchId: string,
  doctorProfileId: string,
  dayStart: Date,
  dayEnd: Date
): Promise<ExceptionRow[]> {
  return tx.$queryRaw<ExceptionRow[]>`
    SELECT e.exception_type, e.starts_at, e.ends_at
      FROM doctor_schedule_exceptions e
     WHERE e.doctor_profile_id = ${doctorProfileId}::uuid
       AND e.status = 'APPROVED'
       AND (e.branch_id IS NULL OR e.branch_id = ${branchId}::uuid)
       AND e.starts_at < ${dayEnd}
       AND e.ends_at   > ${dayStart}
  `;
}

/**
 * What is already taken.
 *
 * Filtered on the same statuses as the EXCLUDE constraint's predicate, so the
 * engine and the database agree about what "holds a slot" means. Cancelling
 * frees the slot in both places by the same rule and with no UPDATE to
 * remember.
 */
async function bookedRanges(
  tx: TxClient,
  doctorProfileId: string,
  dayStart: Date,
  dayEnd: Date
): Promise<BookedRow[]> {
  return tx.$queryRaw<BookedRow[]>`
    SELECT a.scheduled_start, a.scheduled_end
      FROM appointments a
     WHERE a.doctor_profile_id = ${doctorProfileId}::uuid
       AND a.status NOT IN ('CANCELLED', 'NO_SHOW')
       AND a.deleted_at IS NULL
       AND a.scheduled_start < ${dayEnd}
       AND a.scheduled_end   > ${dayStart}
  `;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Cut the slots of one block, and say why each one cannot be booked.
 *
 * The order the reasons are tested in is the order they are useful in: a slot
 * in the past is in the past whatever else is true of it, and "the doctor is on
 * leave" explains a whole afternoon where "booked" would explain one slot.
 */
function cutBlock(
  block: ResolvedBlock,
  context: {
    now: Date;
    branchClosed: boolean;
    blocked: ExceptionRow[];
    booked: BookedRow[];
  }
): AvailabilitySlot[] {
  const slots: AvailabilitySlot[] = [];
  const step = block.slotMinutes * MINUTE_MS;

  /*
   * ADVISORY, exactly as the model comment says. Counting here and refusing
   * there is a check-then-act with no lock, so two concurrent bookings into
   * two different free slots can still take a block one over its cap. Enforcing
   * it properly would mean serialising every booking for the block behind one
   * row lock, which is a real cost for a soft limit a clinic sets as guidance.
   */
  const bookedInBlock = context.booked.filter((b) =>
    overlaps(b.scheduled_start, b.scheduled_end, block.startsAt, block.endsAt)
  ).length;
  const blockFull = block.maxPatients !== null && bookedInBlock >= block.maxPatients;

  for (
    let start = block.startsAt.getTime();
    start + step <= block.endsAt.getTime();
    start += step
  ) {
    const startsAt = new Date(start);
    const endsAt = new Date(start + step);

    let reason: SlotUnavailableReason | null = null;
    if (endsAt <= context.now) reason = 'PAST';
    else if (context.branchClosed) reason = 'BRANCH_CLOSED';
    else if (context.blocked.some((e) => overlaps(startsAt, endsAt, e.starts_at, e.ends_at)))
      reason = 'ON_LEAVE';
    else if (
      context.booked.some((b) => overlaps(startsAt, endsAt, b.scheduled_start, b.scheduled_end))
    )
      reason = 'BOOKED';
    else if (blockFull) reason = 'BLOCK_FULL';

    slots.push({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      available: reason === null,
      reason,
    });
  }

  return slots;
}

/**
 * What is free for this doctor, at this branch, on this date.
 *
 * Runs on the caller's transaction so the booking path can check availability
 * and insert without a second connection seeing a different world in between.
 */
export async function computeAvailability(
  tx: TxClient,
  ctx: TenantContext,
  input: { branchId: string; doctorProfileId: string; date: string },
  now: Date = new Date()
): Promise<AvailabilityResponse> {
  const frame = await dayFrame(tx, input.branchId, input.date);
  if (!frame) throw new NotFoundError('Branch');

  const doctor = await tx.doctorProfile.findFirst({
    where: { id: input.doctorProfileId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!doctor) throw new NotFoundError('Doctor');

  /*
   * Resolved ONCE for the day, through the one authoritative chain (ADR-0015).
   * A block with its own `slot_minutes` overrides it; everything else inherits
   * DOCTOR → BRANCH → ORGANIZATION → PLATFORM → 15.
   */
  const inherited = await effectiveSlotMinutes(
    tx,
    ctx,
    { branchId: input.branchId, doctorProfileId: input.doctorProfileId },
    null
  );

  const [rawBlocks, rawExceptions, booked] = await Promise.all([
    scheduleBlocks(tx, input.branchId, input.doctorProfileId, input.date),
    exceptions(tx, input.branchId, input.doctorProfileId, frame.day_start, frame.day_end),
    bookedRanges(tx, input.doctorProfileId, frame.day_start, frame.day_end),
  ]);

  const blocked = rawExceptions.filter((e) => e.exception_type !== 'EXTRA_SHIFT');

  const blocks: ResolvedBlock[] = rawBlocks.map((row) => ({
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    slotMinutes: row.slot_minutes ?? inherited,
    maxPatients: row.max_patients,
  }));

  /*
   * An EXTRA_SHIFT is a block of working hours that exists for one day only —
   * the Saturday clinic that is not in the recurring week. It is already a pair
   * of instants, so it needs no conversion, and it has no per-block override,
   * so it runs at the inherited cadence.
   */
  for (const extra of rawExceptions) {
    if (extra.exception_type !== 'EXTRA_SHIFT') continue;
    blocks.push({
      startsAt: extra.starts_at > frame.day_start ? extra.starts_at : frame.day_start,
      endsAt: extra.ends_at < frame.day_end ? extra.ends_at : frame.day_end,
      slotMinutes: inherited,
      maxPatients: null,
    });
  }

  blocks.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const slots = blocks.flatMap((block) =>
    cutBlock(block, { now, branchClosed: frame.is_closed, blocked, booked })
  );

  return {
    branchId: input.branchId,
    doctorProfileId: input.doctorProfileId,
    date: input.date,
    timezone: frame.timezone,
    slotMinutes: inherited,
    slots,
    /*
     * "No hours here today" is a different sentence from "every slot has gone",
     * and a screen that cannot tell them apart sends the front desk hunting for
     * a cancellation that was never going to appear. An ARCHIVED or INACTIVE
     * doctor reads as not working rather than as an error: the schedule rows may
     * well still exist, and the honest answer is that nothing can be booked.
     */
    notWorking: blocks.length === 0 || doctor.status !== 'ACTIVE',
  };
}

/**
 * One row of the working-day probe, straight out of Postgres.
 *
 * Every flag is an `EXISTS`, so the whole span is one statement and one pass —
 * see `computeWorkingDays`.
 */
interface WorkingDayRow {
  date: string;
  is_past: boolean;
  scheduled: boolean;
  extra_shift: boolean;
  closed: boolean;
  blocked: boolean;
}

/**
 * Which days this doctor can be booked on at all, across a span.
 *
 * ⚠️ THIS IS NOT `computeAvailability` RUN IN A LOOP, AND IT MUST NOT BECOME
 *   THAT. The picker asks about a month at a time and only needs a bit per day;
 *   the engine cuts slots, resolves the settings ladder and reads every booking.
 *   Thirty of those, on every change of doctor, to grey out four Wednesdays is
 *   not a trade worth making.
 *
 *   What it DOES share is the facts and their meanings — the same
 *   `doctor_schedules` validity window, the same `EXTRACT(dow)` convention, the
 *   same "only APPROVED exceptions count", the same `branch_closures`, the same
 *   treatment of an EXTRA_SHIFT as a working block that the recurring week does
 *   not have. Where the two could drift, they are wrong together rather than
 *   separately, and the slot grid remains the authority: this only decides what
 *   the picker offers.
 *
 * ⚠️ "BOOKABLE" MEANS "HAS HOURS", NOT "HAS A FREE SLOT". A full day stays
 *   selectable. Greying it out would hide the day somebody has just cancelled
 *   out of, and the slot grid already says, per slot, what is taken.
 *
 * ⚠️ A LEAVE ONLY REMOVES A DAY WHEN IT COVERS THE WHOLE OF IT. A doctor away
 *   from two until six is still bookable that morning, and a picker that greys
 *   the day out would lose those bookings entirely. Partial leave is what the
 *   slot grid marks `ON_LEAVE`.
 *
 * `PAST` is decided against `now()` in the BRANCH's zone, in SQL, for the reason
 * stated on `branchLocalDate` below.
 */
export async function computeWorkingDays(
  tx: TxClient,
  input: { branchId: string; doctorProfileId: string; from: string; to: string }
): Promise<WorkingDaysResponse> {
  const branch = await tx.$queryRaw<{ id: string; timezone: string }[]>`
    SELECT b.id, b.timezone FROM branches b
     WHERE b.id = ${input.branchId}::uuid AND b.deleted_at IS NULL
  `;
  const found = branch[0];
  /* Org-scoped by RLS, so another clinic's branch is a 404, never a 403. */
  if (!found) throw new NotFoundError('Branch');

  const doctor = await tx.doctorProfile.findFirst({
    where: { id: input.doctorProfileId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!doctor) throw new NotFoundError('Doctor');

  const rows = await tx.$queryRaw<WorkingDayRow[]>`
    WITH b AS (
      SELECT id, timezone FROM branches WHERE id = ${input.branchId}::uuid
    ),
    span AS (
      SELECT generate_series(${input.from}::date, ${input.to}::date, interval '1 day')::date AS day
    )
    SELECT to_char(span.day, 'YYYY-MM-DD') AS date,
           span.day < (now() AT TIME ZONE b.timezone)::date AS is_past,
           EXISTS (
             SELECT 1 FROM doctor_schedules s
              WHERE s.branch_id         = b.id
                AND s.doctor_profile_id = ${input.doctorProfileId}::uuid
                AND s.is_active
                AND s.day_of_week = EXTRACT(dow FROM span.day)
                AND s.valid_from <= span.day
                AND (s.valid_to IS NULL OR s.valid_to >= span.day)
           ) AS scheduled,
           EXISTS (
             SELECT 1 FROM doctor_schedule_exceptions e
              WHERE e.doctor_profile_id = ${input.doctorProfileId}::uuid
                AND e.exception_type = 'EXTRA_SHIFT'
                AND e.status = 'APPROVED'
                AND (e.branch_id IS NULL OR e.branch_id = b.id)
                AND e.starts_at < frame.day_end
                AND e.ends_at   > frame.day_start
           ) AS extra_shift,
           EXISTS (
             SELECT 1 FROM branch_closures c
              WHERE c.branch_id = b.id AND c.closure_date = span.day
           ) AS closed,
           EXISTS (
             SELECT 1 FROM doctor_schedule_exceptions e
              WHERE e.doctor_profile_id = ${input.doctorProfileId}::uuid
                AND e.exception_type IN ('LEAVE', 'BLOCK')
                AND e.status = 'APPROVED'
                AND (e.branch_id IS NULL OR e.branch_id = b.id)
                /* Covers the WHOLE day — see the note above. */
                AND e.starts_at <= frame.day_start
                AND e.ends_at   >= frame.day_end
           ) AS blocked
      FROM span
      CROSS JOIN b
      CROSS JOIN LATERAL (
        /* ⚠️ The ::timestamp casts are load-bearing — see the note on dayFrame. */
        SELECT (span.day)::timestamp                    AT TIME ZONE b.timezone AS day_start,
               (span.day + interval '1 day')::timestamp AT TIME ZONE b.timezone AS day_end
      ) frame
     ORDER BY span.day
  `;

  /*
   * An ARCHIVED or INACTIVE doctor has no bookable days at all, whatever their
   * schedule rows still say — the same rule `notWorking` applies on the slot
   * response, so the picker and the grid cannot disagree about it.
   */
  const consulting = doctor.status === 'ACTIVE';

  return {
    branchId: input.branchId,
    doctorProfileId: input.doctorProfileId,
    timezone: found.timezone,
    days: rows.map((row) => {
      const hasHours = consulting && (row.scheduled || row.extra_shift);
      /*
       * Most useful reason first: a day that has gone has gone whatever else is
       * true of it, and a closed clinic explains more than an empty rota.
       */
      const reason: WorkingDayReason | null = row.is_past
        ? 'PAST'
        : row.closed
          ? 'BRANCH_CLOSED'
          : !hasHours
            ? 'NOT_SCHEDULED'
            : row.blocked
              ? 'ON_LEAVE'
              : null;

      return { date: row.date, bookable: reason === null, reason };
    }),
  };
}

/**
 * The calendar date, in the BRANCH's timezone, that an instant falls on.
 *
 * ⚠️ IN POSTGRES, NOT IN NODE. `new Date(iso).toISOString().slice(0, 10)` is the
 *   same expression evaluated in UTC, and for anything after 18:30 IST it
 *   returns tomorrow — so the booking would be validated against the wrong day's
 *   availability and pass, because that day is usually empty.
 */
export async function branchLocalDate(
  tx: TxClient,
  branchId: string,
  instant: Date
): Promise<string> {
  const rows = await tx.$queryRaw<{ local_date: string }[]>`
    SELECT to_char((${instant}::timestamptz AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') AS local_date
      FROM branches b
     WHERE b.id = ${branchId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Branch');
  return row.local_date;
}
