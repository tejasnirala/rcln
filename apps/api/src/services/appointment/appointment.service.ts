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
  AppointmentVisitTypeValue,
  AvailabilityResponse,
  CreateAppointmentRequest,
  RescheduleAppointmentRequest,
  UpdateAppointmentRequest,
  WorkingDaysResponse,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { resolveEpisodeForBooking } from '../clinical/episode.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { resolveFee } from '../fees/fee-schedule.service.js';
import { liveInvoicesFor } from '../invoicing/appointment-billing.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { ensureRegistration } from '../patient/patient.service.js';
import {
  branchLocalDate,
  computeAvailability,
  computeWorkingDays,
} from './availability.service.js';
import { assertBranchInScope } from '../shared/branch.js';

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

/**
 * The fee key for moving a booking. Priced in the same grid as every visit
 * type, so a clinic sets a default and a doctor can override it like any row.
 */
const RESCHEDULE_FEE_TYPE = 'RESCHEDULE';

/**
 * What this visit costs, decided NOW and frozen onto the row.
 *
 * ⚠️ THE PRICE IS FIXED AT BOOKING, NOT AT INVOICE TIME (§0.2 decision 9). What
 *   the patient is quoted at the desk is what the bill states, and a fee change
 *   reaches visits booked after it and no others. There is deliberately no pro
 *   rata top-up when the price later rises — that was offered to the product
 *   owner and withdrawn: "it gave a very bad impression for a clinic".
 *
 * ⚠️ A FOLLOW-UP FALLS BACK TO `NEW`, AND NOTHING ELSE FALLS BACK TO ANYTHING.
 *   Most clinics fill in one price and leave the review blank, and reading that
 *   blank as free would bill every follow-up at nothing. `WALK_IN`,
 *   `TELECONSULT` and `PROCEDURE` deliberately do NOT fall back — they had no
 *   column before this feature and were quietly billed at the consultation rate,
 *   which is how a teleconsult ends up billed as an in-person visit: a wrong
 *   bill that looks right.
 *
 * ⚠️ NULL IS A LEGITIMATE ANSWER. An unpriced visit books; it is the invoice
 *   that reports `NO_RATE_CARD` / `NO_FEE_SET`, and a cashier can still bill it
 *   with an explicit amount. Refusing the booking would make an unset price stop
 *   a clinic from seeing patients.
 */
async function freezeFee(
  tx: TxClient,
  args: { doctorProfileId: string; branchId: string; visitType: AppointmentVisitTypeValue }
): Promise<Prisma.Decimal | null> {
  const resolved = await resolveFee(tx, { ...args, feeType: args.visitType });
  if (resolved !== null) return resolved.amount;

  if (args.visitType !== 'FOLLOW_UP') return null;
  const fallback = await resolveFee(tx, { ...args, feeType: 'NEW' });
  return fallback?.amount ?? null;
}

/**
 * Statuses a booking may still be withdrawn from — as opposed to cancelled.
 *
 * BOOKED only, and the delete path additionally refuses anything in the past.
 * The moment a booking is CONFIRMED somebody has spoken to the patient about it,
 * and from CHECKED_IN onwards the patient is in the building; both of those are
 * events that happened, and an event that happened gets cancelled with a reason,
 * not erased.
 */
const DELETABLE: AppointmentStatusValue[] = ['BOOKED'];

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
  parentAppointmentId: true,
  /* The journey. An id and, through the relation, its code — the detail screen
     links to the timeline and the day board ignores both. */
  clinicalEpisodeId: true,
  clinicalEpisode: { select: { code: true } },
  /*
   * ⚠️ NEITHER `parent` NOR `followUps` IS SELECTED HERE, for two reasons that
   *   happen to agree. This select feeds the day board, where a nested relation
   *   fires per row for a chain nobody on that screen reads; and Prisma cannot
   *   infer a payload through a nullable SELF-relation, so naming `parent` here
   *   types the whole row as `never`. `getAppointment` reads both directions
   *   itself, once, for the one booking it was asked about.
   */
  patient: { select: { firstName: true, lastName: true, uhid: true } },
  registration: { select: { mrn: true } },
  doctorProfile: { select: { user: { select: { fullName: true } } } },
  /*
   * ⚠️ THE ZONE TRAVELS WITH THE BOOKING, AND IT HAS TO. `scheduled_start` is an
   *   instant; "16:40" is that instant read in the branch's zone, and nothing in
   *   the ISO string says which zone that was. A client left to guess uses its
   *   own runtime's — which for a server-rendered page is the container's UTC,
   *   and 16:40 IST duly rendered as 11:10.
   *
   *   Carried per ROW rather than taken from the caller's active branch, because
   *   an org-wide admin scoped to Bengaluru can open a booking made in Dubai,
   *   and the booking's own branch is the only right answer. One extra column on
   *   a join that is already happening.
   */
  branch: { select: { timezone: true } },
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
    /* The zone the wall-clock times below are to be read in. See the select. */
    timezone: row.branch.timezone,
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
    /* An id, so it is safe here — and it is what makes a follow-up's audit row
       show the chain it belongs to rather than looking like a fresh booking. */
    parentAppointmentId: row.parentAppointmentId,
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

/**
 * Zero-filled rather than sparse: a board header that renders "Cancelled 3" one
 * minute and nothing the next, because the key vanished when the count reached
 * zero, reads as a bug in the board.
 */
function emptyCounts(): Record<AppointmentStatusValue, number> {
  return Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
    AppointmentStatusValue,
    number
  >;
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
// Automatic status
//
// The status a booking is IN should be a consequence of what has happened to the
// patient, not a thing somebody remembers to click. A front desk working through
// a waiting room does not stop to press "Check in" — it takes the blood pressure
// — and a board that still says BOOKED for a patient sitting in the corridor is
// a board nobody trusts.
//
// So the clinical acts drive it:
//
//   vitals recorded          ->  CHECKED_IN   (they are physically here)
//   diagnosis page opened    ->  IN_PROGRESS  (the doctor has taken them in)
//
// Two rules bind every function below, and both are why they take a `tx` instead
// of opening their own:
//
//   1. THE TRANSITION COMMITS WITH THE EVENT THAT CAUSED IT, or not at all. A
//      reading that saved while the check-in it implies rolled back is worse
//      than no automation, because the two screens then disagree permanently.
//   2. THEY NEVER MOVE A BOOKING BACKWARDS OR OUT OF A TERMINAL STATE, and they
//      never throw when they decline to act. A doctor re-opening the diagnosis
//      page of a visit they already completed is an ordinary thing to do; it
//      must not fail, and it must not re-open the visit. `assertTransition` is
//      therefore deliberately NOT used here — it exists to reject a human's
//      impossible request, and this is not one.
// ---------------------------------------------------------------------------

/**
 * Advance to `to` only if that is a legal forward step from where we are.
 *
 * Silent by design: the caller is an event handler, and "already there" is the
 * expected outcome most of the time.
 */
async function advanceAutomatically(
  tx: TxClient,
  ctx: TenantContext,
  appointmentId: string,
  from: AppointmentStatusValue,
  to: AppointmentStatusValue,
  note: string
): Promise<void> {
  if (from === to || !TRANSITIONS[from].includes(to)) return;

  const now = new Date();
  await tx.appointment.update({
    where: { id: appointmentId },
    data: {
      status: to,
      ...(to === 'CHECKED_IN' ? { checkedInAt: now } : {}),
      ...(to === 'IN_PROGRESS' ? { startedAt: now } : {}),
      ...(to === 'COMPLETED' ? { completedAt: now } : {}),
    },
  });

  /*
   * The trail records these exactly like a manual change, with a note naming
   * what triggered it. "Who checked this patient in?" must not answer "nobody"
   * just because a machine decided it — `ctx.userId` is the person whose action
   * caused it, which is the true answer.
   */
  await recordTransition(tx, ctx, appointmentId, from, to, note);
}

/**
 * Vitals were taken, so the patient is here.
 *
 * BOOKED and CONFIRMED both advance; anything from CHECKED_IN onwards is already
 * at least this far along and is left alone.
 */
export async function onVitalsRecorded(
  tx: TxClient,
  ctx: TenantContext,
  appointmentId: string,
  currentStatus: AppointmentStatusValue
): Promise<void> {
  await advanceAutomatically(
    tx,
    ctx,
    appointmentId,
    currentStatus,
    'CHECKED_IN',
    'Checked in automatically when vitals were recorded.'
  );
}

/**
 * The doctor opened the consultation, so the visit is under way.
 *
 * ⚠️ ONLY FROM CHECKED_IN. A doctor opening tomorrow's booking to read the
 *   reason for the visit must not start it — the patient has not arrived, and an
 *   IN_PROGRESS row skews every waiting-time figure the clinic reports.
 *   `TRANSITIONS` already says BOOKED cannot reach IN_PROGRESS, so this is a
 *   consequence of the table rather than a second rule to keep in step with it.
 */
export async function onConsultationOpened(
  tx: TxClient,
  ctx: TenantContext,
  appointmentId: string,
  currentStatus: AppointmentStatusValue
): Promise<void> {
  await advanceAutomatically(
    tx,
    ctx,
    appointmentId,
    currentStatus,
    'IN_PROGRESS',
    'Started automatically when the consultation was opened.'
  );
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
 * Which days the doctor consults on, across a span — what the date picker greys
 * out. The cheap question; `getAvailability` is the expensive one.
 */
export async function getWorkingDays(
  ctx: TenantContext,
  input: { branchId: string; doctorProfileId: string; from: string; to: string }
): Promise<WorkingDaysResponse> {
  assertBranchInScope(ctx, input.branchId);
  return withTenant(ctx, (tx) => computeWorkingDays(tx, input));
}

/**
 * The board — one day, or a week or a month of them when `to` is given.
 *
 * The wider ranges are the same read with a wider bound, not a different
 * endpoint: the row shape, the permission and the `ownDoctorOnly` narrowing all
 * have to be identical whichever span the front desk is looking at, and the
 * contract caps the span so "unbounded" never becomes reachable.
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
/**
 * How wide a caller's view of the day board is.
 *
 * ⚠️ `ownDoctorOnly` IS AN ACCESS CONTROL, NOT A CONVENIENCE FILTER. The route
 *   sets it from `DOCTOR_DIRECTORY_READ` — a caller who may not enumerate the
 *   practitioners may not read across them either — and it OVERRIDES
 *   `query.doctorProfileId` rather than defaulting it. Defaulting would leave
 *   `?doctorProfileId=<a colleague>` as a working way around it, which is how a
 *   filter that was meant to be a boundary stops being one.
 */
export interface DayBoardScope {
  ownDoctorOnly: boolean;
  /**
   * Whether to answer "is this visit already billed?" per row.
   *
   * ⚠️ SET FROM `billing.invoice.read`, AND FALSE IS NOT "NO BILL". It leaves
   *   `liveInvoice` OFF the row entirely rather than sending null, because a
   *   doctor who cannot read invoices must not be shown a column that says every
   *   visit is unbilled. See the field's note in the contract.
   */
  withBilling?: boolean;
}

export async function listDay(
  ctx: TenantContext,
  query: AppointmentListQuery,
  scope: DayBoardScope = { ownDoctorOnly: false }
): Promise<AppointmentListResponse> {
  assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const [start, end] = await rangeBounds(tx, query.branchId, query.date, query.to ?? query.date);

    let doctorProfileId = query.doctorProfileId;

    if (scope.ownDoctorOnly) {
      const own = await tx.doctorProfile.findFirst({
        where: { userId: ctx.userId, deletedAt: null },
        select: { id: true },
      });
      /*
       * No profile and no directory access means there is no diary this caller
       * could be asking about. An empty board, not an error: the alternative is
       * a 403 on a screen their navigation offered them.
       */
      if (!own) return { appointments: [], counts: emptyCounts() };
      doctorProfileId = own.id;
    }

    const rows = await tx.appointment.findMany({
      where: {
        branchId: query.branchId,
        deletedAt: null,
        scheduledStart: { gte: start, lt: end },
        ...(doctorProfileId !== undefined ? { doctorProfileId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      select: APPOINTMENT_SELECT,
      orderBy: [{ scheduledStart: 'asc' }, { status: 'asc' }],
    });

    const counts = emptyCounts();
    for (const row of rows) counts[row.status] += 1;

    /* One query for the whole board, never one per row. See `liveInvoicesFor`. */
    const billing = scope.withBilling
      ? await liveInvoicesFor(
          tx,
          rows.map((row) => row.id)
        )
      : null;

    return {
      appointments: rows.map((row) =>
        billing === null
          ? toSummary(row)
          : { ...toSummary(row), liveInvoice: billing.get(row.id) ?? null }
      ),
      counts,
    };
  });
}

/**
 * The range's bounds as instants, converted in Postgres from the branch's zone.
 *
 * `to` is INCLUSIVE — the caller means "up to and including this day" — so the
 * upper bound is the midnight after it and the query is `>= start, < end`.
 *
 * ⚠️ THE CONVERSION STAYS IN POSTGRES EVEN FOR A RANGE, and especially for one.
 *   A month spanning a DST change has a first and a last midnight at different
 *   UTC offsets; composing `start + 30 days` in Node would put the boundary an
 *   hour out and silently drop or double-count the bookings sitting either side
 *   of it. Two `AT TIME ZONE` conversions, one per end, is the whole fix.
 */
async function rangeBounds(
  tx: TxClient,
  branchId: string,
  from: string,
  to: string
): Promise<[Date, Date]> {
  /* ⚠️ `::timestamp` is load-bearing — see the note in availability.service.ts. */
  const rows = await tx.$queryRaw<{ day_start: Date; day_end: Date }[]>`
    SELECT (${from}::date)::timestamp                  AT TIME ZONE b.timezone AS day_start,
           (${to}::date + interval '1 day')::timestamp AT TIME ZONE b.timezone AS day_end
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
  options: AppointmentActionOptions = {},
  scope: { withBilling?: boolean } = {}
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

    const followUps = await tx.appointment.findMany({
      where: { parentAppointmentId: appointmentId, deletedAt: null },
      select: { id: true, appointmentNumber: true, scheduledStart: true, status: true },
      orderBy: { scheduledStart: 'asc' },
    });

    /*
     * The parent's number, backwards up the chain. A separate read rather than a
     * relation on APPOINTMENT_SELECT — see the note there. `findFirst` rather
     * than `findUnique` so RLS decides whether it is visible: a follow-up booked
     * at another branch must not disclose the parent's token through this field.
     */
    const parent =
      row.parentAppointmentId === null
        ? null
        : await tx.appointment.findFirst({
            where: { id: row.parentAppointmentId },
            select: { appointmentNumber: true },
          });

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'APPOINTMENT',
      patientId: row.patientId,
      resourceId: row.id,
      branchId: row.branchId,
      ...options,
    });

    const billing = scope.withBilling ? await liveInvoicesFor(tx, [row.id]) : null;

    return detailOf(
      row,
      history.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        changedBy: h.changedBy,
        changedByName: h.changer?.fullName ?? null,
        note: h.note,
        changedAt: h.changedAt.toISOString(),
      })),
      {
        parentAppointmentNumber: parent?.appointmentNumber ?? null,
        followUps: followUps.map((f) => ({
          id: f.id,
          appointmentNumber: f.appointmentNumber,
          scheduledStart: f.scheduledStart.toISOString(),
          status: f.status,
        })),
        ...(billing === null ? {} : { liveInvoice: billing.get(row.id) ?? null }),
      }
    );
  });
}

/**
 * The consultation, from the doctor's side.
 *
 * Everything `getAppointment` returns, plus the side effect of STARTING the
 * visit — opening the consultation is the act that makes it IN_PROGRESS, so the
 * board reflects a doctor who has taken the patient in without anybody pressing
 * a button. See the "Automatic status" section.
 *
 * ⚠️ A SEPARATE ENTRY POINT FROM `getAppointment` PRECISELY BECAUSE IT MUTATES.
 *   The front desk opening a booking to check the time must not start the visit,
 *   and a GET that silently transitions state depending on who called it is a
 *   trap. This one is reached from the diagnosis screen and nowhere else.
 */
export async function openConsultation(
  ctx: TenantContext,
  appointmentId: string,
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundError('Appointment');

    await onConsultationOpened(tx, ctx, row.id, row.status);
  });

  /*
   * Re-read in its own transaction so the response carries the status the
   * transition above just wrote, and so the data-access row is written exactly
   * once by the function that owns that responsibility.
   */
  return getAppointment(ctx, appointmentId, options);
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
       * Which treatment journey this visit belongs to (CE-1).
       *
       * ⚠️ ABSENT MEANS A NEW JOURNEY, NOT "THE PATIENT'S MOST RECENT OPEN ONE".
       *   See `resolveEpisodeForBooking` — the tempting fallback is a diagnosis
       *   made by a default value.
       *
       * Before `issueNumber`, because opening an episode takes its own counter
       * lock and holding two of them at once is how two counters deadlock
       * against each other under concurrent booking.
       */
      const clinicalEpisodeId = await resolveEpisodeForBooking(tx, ctx, {
        patientId: input.patientId,
        branchId: input.branchId,
        clinicalEpisodeId: input.clinicalEpisodeId,
      });

      /* The price, decided now and frozen onto the row. See `freezeFee`. */
      const bookedFee = await freezeFee(tx, {
        doctorProfileId: input.doctorProfileId,
        branchId: input.branchId,
        visitType: input.visitType,
      });

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
          clinicalEpisodeId,
          appointmentNumber: number.formatted,
          scheduledStart: startsAt,
          scheduledEnd: endsAt,
          visitType: input.visitType,
          source: input.source,
          ...(bookedFee !== null ? { bookedFee } : {}),
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
 *
 * Three things happen here that did not before, and all three are §0.2 decision
 * 12:
 *
 * ⚠️ WHO ASKED IS RECORDED, BECAUSE THE SYSTEM CANNOT TELL. A clinic-initiated
 *   move — the doctor took leave — is never charged; a patient-initiated one is
 *   charged once per move and carries a reason. Nothing in the row that existed
 *   before could distinguish the two, and billing a patient because your
 *   consultant called in sick is the bill that ends up on Google Reviews.
 *
 * ⚠️ THE CHARGE IS PER MOVE, NOT PER BOOKING. Three moves are three rows and
 *   three lines on the bill. It is resolved through the same fee grid as every
 *   visit type, under `RESCHEDULE`, so a clinic sets a default and a doctor can
 *   override it — and an unpriced `RESCHEDULE` charges nothing rather than
 *   refusing the move, because a missing price must not stop the desk working.
 *
 * ⚠️ A MOVE TO A DIFFERENT DOCTOR RE-RESOLVES THE FROZEN FEE, and a move that
 *   only changes the time does not. This is not the withdrawn pro-rata rule
 *   (decision 10) coming back: that was ONE doctor's price moving over time,
 *   which a frozen fee is meant to survive. This is a different practitioner
 *   giving a different consultation, and billing a consultant at a junior's rate
 *   loses real money.
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

      /*
       * A different practitioner is a different consultation, so the frozen fee
       * is resolved again against the new doctor. Same doctor, new time — the
       * frozen fee stands, price rises included.
       */
      const doctorChanged = doctorProfileId !== before.doctorProfileId;
      const bookedFee = doctorChanged
        ? await freezeFee(tx, {
            doctorProfileId,
            branchId: before.branchId,
            visitType: before.visitType,
          })
        : undefined;

      /*
       * A clinic-initiated move costs nothing, and an unpriced `RESCHEDULE`
       * costs nothing either — the grid deciding what a move costs is the
       * clinic's to fill in, and its absence must not become a refusal at the
       * desk. Resolved against the doctor the patient is moving TO, which is who
       * will actually give the consultation.
       */
      const charge =
        input.initiatedBy === 'PATIENT'
          ? ((
              await resolveFee(tx, {
                doctorProfileId,
                branchId: before.branchId,
                feeType: RESCHEDULE_FEE_TYPE,
              })
            )?.amount ?? null)
          : null;

      const after = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          scheduledStart: startsAt,
          scheduledEnd: endsAt,
          doctorProfileId,
          ...(bookedFee !== undefined ? { bookedFee } : {}),
        },
        select: APPOINTMENT_SELECT,
      });

      /*
       * ⚠️ THE MOVE IS ITS OWN ROW, AND `reason` LIVES ONLY HERE. It is
       *   PHI-capable — "chemotherapy clashes" is a diagnosis — so it is written
       *   to `appointment_reschedules` and is deliberately absent from the audit
       *   snapshot below, exactly as `appointments.reason` is.
       */
      await tx.appointmentReschedule.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: before.branchId,
          appointmentId,
          fromStart: before.scheduledStart,
          toStart: startsAt,
          fromDoctorProfileId: before.doctorProfileId,
          toDoctorProfileId: doctorProfileId,
          initiatedBy: input.initiatedBy,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(charge !== null ? { chargeAmount: charge } : {}),
          ...(ctx.userId !== undefined ? { createdBy: ctx.userId } : {}),
        },
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
        after: {
          ...snapshot(after),
          /*
           * The three facts about the MOVE that an auditor asks for — who asked
           * for it and what it cost — with the reason represented only by
           * whether there was one. Same rule as `hasReason` in `snapshot()`.
           */
          rescheduleInitiatedBy: input.initiatedBy,
          rescheduleChargeAmount: charge?.toString() ?? '0',
          rescheduleHasReason: input.reason !== undefined,
        },
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

    /*
     * ⚠️ CHANGING THE KIND OF VISIT RE-FREEZES THE PRICE, because the frozen fee
     *   IS the price of that kind of visit with that doctor. A booking corrected
     *   from NEW to TELECONSULT and still carrying the in-person fee is the
     *   wrong bill that looks right — the same failure the migration refused to
     *   paper over when it left teleconsults unpriced.
     *
     *   This does re-read today's grid rather than the one in force at booking,
     *   which is a narrow exception to decision 9. It is the same exception the
     *   doctor swap makes and for the same reason: the visit being priced is not
     *   the visit that was priced.
     */
    const visitTypeChanged = input.visitType !== undefined && input.visitType !== before.visitType;
    const bookedFee = visitTypeChanged
      ? await freezeFee(tx, {
          doctorProfileId: before.doctorProfileId,
          branchId: before.branchId,
          visitType: input.visitType as AppointmentVisitTypeValue,
        })
      : undefined;

    const after = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        ...(input.visitType !== undefined ? { visitType: input.visitType } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(bookedFee !== undefined ? { bookedFee } : {}),
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

/**
 * Book the next visit in the same chain.
 *
 * WHAT IS INHERITED AND WHAT IS NOT
 *   The patient and the branch are read off the parent and cannot be overridden
 *   — a follow-up is by definition the same person coming back, and accepting
 *   either from the caller would let this endpoint book for somebody else while
 *   looking like a continuation. The doctor may be overridden, because a
 *   follow-up handed to a colleague is a real thing. `visitType` is forced to
 *   FOLLOW_UP: billing reads it, and a follow-up inside the free window is not
 *   chargeable.
 *
 * ⚠️ THE FOLLOW-UP GETS ITS OWN APPOINTMENT NUMBER, NOT THE PARENT'S. The number
 *   is issued from the branch counter like any other booking. Sharing the
 *   parent's token would put two live rows behind one number that gets called
 *   out in a waiting room, and would collide with the branch's uniqueness
 *   constraint on the second visit. The continuity the clinic needs is
 *   `parentAppointmentId`, which the database enforces and a reused string never
 *   could — the chain is what a cumulative prescription is assembled from.
 *
 * The registration is re-resolved rather than copied: the parent's row is a
 * branch-local attendance record, and it is the correct one only because the
 * branch is inherited. `ensureRegistration` is idempotent, so this returns the
 * same row it would have copied — and keeps doing so if a follow-up at another
 * branch is ever allowed.
 */
export async function createFollowUp(
  ctx: TenantContext,
  parentAppointmentId: string,
  input: {
    startsAt: string;
    durationMinutes?: number | undefined;
    doctorProfileId?: string | undefined;
    reason?: string | undefined;
    /** The recommendation this booking satisfies (CD-13, CE-4). */
    fulfilsRecommendationId?: string | undefined;
  },
  options: AppointmentActionOptions = {}
): Promise<AppointmentDetail> {
  const startsAt = new Date(input.startsAt);

  try {
    const row = await withTenant(ctx, async (tx) => {
      const parent = await tx.appointment.findFirst({
        where: { id: parentAppointmentId, deletedAt: null },
        select: {
          id: true,
          branchId: true,
          patientId: true,
          doctorProfileId: true,
          clinicalEpisodeId: true,
          patient: { select: { status: true } },
        },
      });
      if (!parent) throw new NotFoundError('Appointment');

      if (parent.patient.status === 'MERGED') {
        throw new ConflictError('That record has been merged into another one.');
      }
      if (parent.patient.status === 'DECEASED') {
        throw new ConflictError('That patient is recorded as deceased.');
      }

      const doctorProfileId = input.doctorProfileId ?? parent.doctorProfileId;

      const date = await branchLocalDate(tx, parent.branchId, startsAt);
      const availability = await computeAvailability(tx, ctx, {
        branchId: parent.branchId,
        doctorProfileId,
        date,
      });
      const endsAt = resolveSlotEnd(availability, startsAt, input.durationMinutes);

      const registration = await ensureRegistration(tx, ctx, parent.patientId, parent.branchId);

      /* Frozen at booking like any other visit — `FOLLOW_UP`, falling back to
         `NEW` where the clinic priced only the first consultation. */
      const bookedFee = await freezeFee(tx, {
        doctorProfileId,
        branchId: parent.branchId,
        visitType: 'FOLLOW_UP',
      });

      // ⚠️ LAST, immediately before the insert — same lock reasoning as
      //    `createAppointment`. See the comment there.
      const number = await issueNumber(tx, ctx, {
        type: 'APPOINTMENT',
        branchId: parent.branchId,
        prefix: APPOINTMENT_PREFIX,
      });

      const created = await tx.appointment.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: parent.branchId,
          patientId: parent.patientId,
          patientRegistrationId: registration.id,
          doctorProfileId,
          parentAppointmentId: parent.id,
          /*
           * ⚠️ INHERITED FROM THE PARENT WITHOUT ANYBODY BEING ASKED, and this
           *   is the one place that is right. A follow-up IS by definition a
           *   continuation of the visit it follows, so the journey is not a
           *   decision anyone at the desk has to make — the same reasoning that
           *   makes the patient and the branch inherited rather than accepted.
           *
           *   That gives the chain and the journey their separate jobs:
           *     parentAppointmentId  A -> B -> C   the immediate predecessor
           *     clinicalEpisodeId    A, B, C       the whole journey
           */
          clinicalEpisodeId: parent.clinicalEpisodeId,
          appointmentNumber: number.formatted,
          scheduledStart: startsAt,
          scheduledEnd: endsAt,
          visitType: 'FOLLOW_UP',
          source: 'FRONT_DESK',
          ...(bookedFee !== null ? { bookedFee } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(ctx.userId !== undefined ? { bookedBy: ctx.userId } : {}),
        },
        select: APPOINTMENT_SELECT,
      });

      await recordTransition(tx, ctx, created.id, null, 'BOOKED');

      /*
       * ⚠️ FULFILMENT IS THE LAST THING AND IS OPTIONAL IN BOTH DIRECTIONS
       *   (CD-13). A patient may book a follow-up nobody recommended, and a
       *   recommendation may never be booked at all — the second is the entire
       *   recall list. Neither is an error.
       *
       * ⚠️ AND IT IS THE ONE WRITE TO A RECOMMENDATION THAT REACHES A FINALIZED
       *   CONSULTATION, deliberately. Booking happens days later, at the desk;
       *   it is a fact about the recommendation's FATE and not an edit to the
       *   clinical record. Nothing the doctor wrote changes.
       */
      if (input.fulfilsRecommendationId !== undefined) {
        await fulfilRecommendation(tx, input.fulfilsRecommendationId, created.id, parent.patientId);
      }

      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'appointment',
        entityId: created.id,
        after: snapshot(created),
        branchId: parent.branchId,
        ...options,
      });

      return created;
    });

    return detailOf(row, []);
  } catch (err) {
    // Caught outside `withTenant` — see the note in `createAppointment`.
    if (isOverlapViolation(err)) throw slotTakenError();
    throw err;
  }
}

/**
 * Mark a recommendation as satisfied by this booking (CD-13).
 *
 * ⚠️ THE PATIENT CHECK IS NOT PARANOIA. Both ids arrive from one form, and a
 *   recall list that does not re-filter when the patient changes would record
 *   one person's booking as the answer to another person's recall — and then
 *   both are wrong: one patient is chased who has come, and one is not chased
 *   who has not.
 *
 * ⚠️ ONE-TO-ONE, BY PARTIAL UNIQUE INDEX. `fulfilled_by_appointment_id` is
 *   unique where it is not null, so one appointment cannot satisfy two
 *   recommendations — the index is the guarantee and this read is only what
 *   turns its violation into a sentence.
 *
 * ⚠️ AND IT REFUSES RATHER THAN IGNORING. A desk that ticked "this fulfils the
 *   recall" and got a silent no-op would leave the patient on the list and
 *   nobody looking for the reason.
 */
async function fulfilRecommendation(
  tx: TxClient,
  recommendationId: string,
  appointmentId: string,
  patientId: string
): Promise<void> {
  const recommendation = await tx.encounterFollowUpRecommendation.findFirst({
    where: { id: recommendationId, deletedAt: null },
    select: {
      id: true,
      patientId: true,
      cancelledAt: true,
      fulfilledByAppointmentId: true,
    },
  });
  if (!recommendation) throw new NotFoundError('Follow-up recommendation');
  if (recommendation.patientId !== patientId) {
    throw new NotFoundError('Follow-up recommendation');
  }
  if (recommendation.cancelledAt !== null) {
    throw new ConflictError('That follow-up recommendation was cancelled.');
  }
  /* Idempotent when it is the SAME booking; a different one is a real clash. */
  if (recommendation.fulfilledByAppointmentId !== null) {
    if (recommendation.fulfilledByAppointmentId === appointmentId) return;
    throw new ConflictError('That follow-up has already been booked.');
  }

  await tx.encounterFollowUpRecommendation.update({
    where: { id: recommendation.id },
    data: { fulfilledByAppointmentId: appointmentId, fulfilledAt: new Date() },
    select: { id: true },
  });
}

/**
 * Withdraw a booking that should never have been made.
 *
 * ⚠️ NOT A CANCELLATION, AND THE DIFFERENCE IS THE POINT. Cancelling records
 *   that a real appointment was called off, with a reason, and feeds the
 *   utilisation and no-show reports. This erases a mis-click — the wrong
 *   patient, the wrong doctor, a double tap — from those reports, where its
 *   presence would be a false signal about the clinic's patients.
 *
 * Three conditions, each narrowing the last:
 *
 *   1. `appointment.delete`, which is not `appointment.cancel` (the route).
 *   2. Status is BOOKED. From CONFIRMED onwards somebody has spoken to the
 *      patient about this time; that conversation happened and cancelling is
 *      the honest record of it.
 *   3. `scheduled_start` is in the FUTURE. A slot whose time has passed is
 *      history — either they came, they did not, or it was called off — and
 *      history is not withdrawn. This is checked against the database clock
 *      rather than Node's, so it cannot be shifted by a skewed app server.
 *
 * A SOFT delete. The row leaves every screen and every report and stays in the
 * table: "who deleted the 3pm and when" is exactly the question a clinic asks
 * when a patient turns up for an appointment nobody can find.
 *
 * ⚠️ THE STATUS IS MOVED TO CANCELLED AS WELL AS `deleted_at` BEING SET, AND
 *   BOTH ARE REQUIRED. `appointments_no_doctor_overlap` is deliberately NOT
 *   partial on `deleted_at` — see the `appointments` migration, which reasons
 *   that a soft-deleted row still reading as BOOKED is a bug and holding its
 *   slot is the safer failure. So `deleted_at` alone would hide the booking from
 *   every screen while silently blocking the slot forever, which is precisely
 *   the failure that comment predicts. The status change is what frees it.
 *
 *   The pair is not a contradiction: `deleted_at` is what keeps this out of the
 *   cancellation reports, and the status is only ever read for rows that are not
 *   deleted. Anything counting cancellations must filter `deleted_at IS NULL` —
 *   as every query in this service already does.
 */
export async function deleteAppointment(
  ctx: TenantContext,
  appointmentId: string,
  options: AppointmentActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: APPOINTMENT_SELECT,
    });
    if (!row) throw new NotFoundError('Appointment');

    if (!DELETABLE.includes(row.status)) {
      throw new ConflictError(
        'Only a booking that is still just booked can be deleted. Cancel it instead.'
      );
    }

    /*
     * Postgres' clock, not Node's. `now()` is the same instant the row was
     * written against and the same one the EXCLUDE constraint reasons about; an
     * app server whose clock has drifted forward would otherwise start allowing
     * today's finished appointments to be erased.
     */
    const clock = await tx.$queryRaw<{ is_future: boolean }[]>`
      SELECT ${row.scheduledStart} > now() AS is_future
    `;
    // A one-row SELECT with no FROM always returns a row; `?? false` is what
    // `noUncheckedIndexedAccess` requires and refuses the delete if it ever does
    // not, which is the safe direction.
    if (clock[0]?.is_future !== true) {
      throw new ConflictError(
        'That appointment time has already passed. Cancel it or mark it as not attended.'
      );
    }

    /*
     * A parent with follow-ups hanging off it cannot be withdrawn — the FK is
     * ON DELETE RESTRICT for the hard case, and this is the soft equivalent,
     * spelled out so the caller gets a sentence instead of an orphaned chain.
     */
    const followUps = await tx.appointment.count({
      where: { parentAppointmentId: appointmentId, deletedAt: null },
    });
    if (followUps > 0) {
      throw new ConflictError('A follow-up is booked against this visit. Delete that one first.');
    }

    if (ctx.userId === undefined) {
      // Unreachable behind `requireAuth`; the CHECK constraint on
      // `cancelled_by` would refuse the row anyway. Named, not surfaced raw.
      throw new ValidationError('A deletion must record who made it.');
    }

    await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        deletedAt: new Date(),
        // See the header: this is what releases the slot, not `deletedAt`.
        status: 'CANCELLED',
        cancelledBy: ctx.userId,
        cancellationReason: 'Booking withdrawn.',
      },
    });

    /*
     * The trail records the status change that actually happened, with a note
     * saying it was a withdrawal rather than a cancellation. Without this the
     * row would end in CANCELLED with nothing in its history explaining how.
     */
    await recordTransition(
      tx,
      ctx,
      appointmentId,
      row.status,
      'CANCELLED',
      'Booking deleted before it took place.'
    );

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'appointment',
      entityId: appointmentId,
      before: snapshot(row),
      branchId: row.branchId,
      ...options,
    });
  });
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
  statusHistory: AppointmentDetail['statusHistory'],
  chain: {
    parentAppointmentNumber?: string | null;
    followUps?: AppointmentDetail['followUps'];
    /**
     * Present only when the caller may read invoices — see the contract. Absent
     * here means the key is absent from the response, which is a different
     * answer from `null`.
     */
    liveInvoice?: AppointmentDetail['liveInvoice'];
  } = {}
): AppointmentDetail {
  return {
    ...toSummary(row),
    ...('liveInvoice' in chain ? { liveInvoice: chain.liveInvoice } : {}),
    reason: row.reason,
    cancellationReason: row.cancellationReason,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    mrn: row.registration.mrn,
    statusHistory,
    parentAppointmentId: row.parentAppointmentId,
    clinicalEpisodeId: row.clinicalEpisodeId,
    clinicalEpisodeCode: row.clinicalEpisode.code,
    /*
     * The id is always on the row; the NUMBER needs a second read, so a write's
     * response reports the link without it. Only `getAppointment` pays for it,
     * and only that endpoint has a screen that renders it.
     */
    parentAppointmentNumber: chain.parentAppointmentNumber ?? null,
    followUps: chain.followUps ?? [],
  };
}
