/**
 * Appointments: what is free, what is booked, and what happened to it.
 *
 * ⚠️ TWO KINDS OF TIME LIVE IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE.
 *   `date` is a CALENDAR DATE in the branch's timezone — what a receptionist
 *   means by "Tuesday". `scheduledStart` is an ABSOLUTE INSTANT in ISO-8601
 *   with an offset. The conversion between them happens in Postgres, inside the
 *   availability engine, using `branches.timezone`; it never happens in Node,
 *   where the container's UTC would turn 09:00 IST into 03:30 with nothing to
 *   show for it.
 *
 *   So the availability request takes a `date` and the booking request takes a
 *   `startsAt` — the client books the exact instant the engine handed it back,
 *   rather than restating a wall-clock time the server would have to re-guess.
 *
 * ⚠️ `reason` IS PHI. It reaches an audit row through nothing, ever, and it is
 *   deliberately absent from the day-board row — a list that names the patient
 *   AND why they are coming discloses a diagnosis to whoever glances at the
 *   front-desk screen. It is on the detail response only.
 */
import { z } from 'zod';
import { uuid } from './common.js';

/** `YYYY-MM-DD`, a calendar date in the BRANCH's timezone. Never an instant. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const appointmentStatus = z.enum([
  'BOOKED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);

export const appointmentVisitType = z.enum([
  'NEW',
  'FOLLOW_UP',
  'WALK_IN',
  'TELECONSULT',
  'PROCEDURE',
]);

export const appointmentSource = z.enum(['FRONT_DESK', 'ONLINE', 'PHONE', 'WHATSAPP']);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * "What is free on this day?"
 *
 * A GET, unlike the patient search: the parameters are a branch, a doctor and a
 * date. None of them is anybody's surname, so none of them is a disclosure when
 * it lands in a proxy log.
 */
export const availabilityQuery = z.object({
  branchId: uuid,
  doctorProfileId: uuid,
  /** One day. A range would be a different endpoint with a different cost. */
  date: calendarDate,
});

export const createAppointmentRequest = z.object({
  branchId: uuid,
  patientId: uuid,
  doctorProfileId: uuid,
  /**
   * The exact instant the availability response offered. Sent back verbatim
   * rather than re-composed from a wall-clock time, so there is exactly one
   * timezone conversion in the whole flow and it happened in Postgres.
   */
  startsAt: z.iso.datetime(),
  /**
   * Absent = the slot length the engine resolved for that block (ADR-0015).
   * Present only for a procedure that genuinely runs long; it still has to fit
   * inside the doctor's working hours and still has to not overlap anything.
   */
  durationMinutes: z.number().int().min(5).max(240).optional(),
  visitType: appointmentVisitType.default('NEW'),
  source: appointmentSource.default('FRONT_DESK'),
  /** ⚠️ PHI. "Chest pain since Tuesday" is a clinical statement. */
  reason: z.string().max(2000).optional(),
});

/**
 * Move a booking. Deliberately NOT a PATCH of `startsAt` on the update
 * endpoint: a reschedule re-runs the availability check and writes a status
 * history row, and folding it into a general update is how one of those gets
 * skipped.
 */
export const rescheduleAppointmentRequest = z.object({
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  /** Moving to a different doctor is a reschedule, not a new booking. */
  doctorProfileId: uuid.optional(),
  note: z.string().max(500).optional(),
});

/** Everything about a booking that is not its time or its status. */
export const updateAppointmentRequest = z.object({
  visitType: appointmentVisitType.optional(),
  reason: z.string().max(2000).optional(),
});

/**
 * Drive the booking forward: CONFIRMED, CHECKED_IN, IN_PROGRESS, COMPLETED.
 *
 * Cancellation and no-show are their own endpoints — both are terminal, both
 * free the slot, and only one of them is a fact about the patient.
 */
export const appointmentTransitionRequest = z.object({
  status: z.enum(['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']),
  /** ⚠️ PHI. Free text a clinician typed. */
  note: z.string().max(500).optional(),
});

export const cancelAppointmentRequest = z.object({
  /**
   * ⚠️ PHI, and required. A cancellation nobody wrote a reason for is the row
   * the clinic cannot explain to the patient who turned up anyway.
   */
  reason: z.string().min(1).max(500),
});

export const noShowAppointmentRequest = z.object({
  note: z.string().max(500).optional(),
});

/**
 * The day board.
 *
 * `date` is required — an unbounded appointment list is a list of every patient
 * the clinic has ever seen, and it is not a screen anybody asked for.
 */
export const appointmentListQuery = z.object({
  branchId: uuid,
  date: calendarDate,
  doctorProfileId: uuid.optional(),
  status: appointmentStatus.optional(),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Why a slot cannot be booked. Null when it can. */
export const slotUnavailableReason = z.enum([
  'BOOKED',
  'PAST',
  'ON_LEAVE',
  'BRANCH_CLOSED',
  'BLOCK_FULL',
]);

export const availabilitySlot = z.object({
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  available: z.boolean(),
  /**
   * ⚠️ NEVER NAMES WHO HOLDS THE SLOT. `BOOKED` is the whole answer: telling a
   * caller which patient is in the 10:20 is a disclosure the calendar has no
   * business making, and on the patient portal it would be a stranger's.
   */
  reason: slotUnavailableReason.nullable(),
});

export const availabilityResponse = z.object({
  branchId: uuid,
  doctorProfileId: uuid,
  date: z.string(),
  /** The branch's zone, so the client formats without re-deriving it. */
  timezone: z.string(),
  /** What the settings ladder resolved for this day (ADR-0015). */
  slotMinutes: z.number().int(),
  slots: z.array(availabilitySlot),
  /**
   * Set when the doctor has no working hours here that day at all, which is a
   * different fact from "every slot is taken" and reads differently on screen.
   */
  notWorking: z.boolean(),
});

export const appointmentStatusEvent = z.object({
  id: uuid,
  fromStatus: appointmentStatus.nullable(),
  toStatus: appointmentStatus,
  changedBy: uuid.nullable(),
  changedByName: z.string().nullable(),
  note: z.string().nullable(),
  changedAt: z.iso.datetime(),
});

/**
 * The day-board row.
 *
 * Carries the patient's name — a front desk that cannot see who is arriving at
 * 10:20 cannot do its job — but deliberately NOT `reason`. Name plus reason on
 * a screen anybody can glance at is a diagnosis with extra steps.
 */
export const appointmentSummary = z.object({
  id: uuid,
  appointmentNumber: z.string(),
  branchId: uuid,
  patientId: uuid,
  patientName: z.string(),
  uhid: z.string(),
  doctorProfileId: uuid,
  doctorName: z.string(),
  scheduledStart: z.iso.datetime(),
  scheduledEnd: z.iso.datetime(),
  visitType: appointmentVisitType,
  source: appointmentSource,
  status: appointmentStatus,
  checkedInAt: z.iso.datetime().nullable(),
});

export const appointmentDetail = appointmentSummary.extend({
  /** ⚠️ PHI. Behind the detail endpoint, which writes a data-access row. */
  reason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  mrn: z.string(),
  statusHistory: z.array(appointmentStatusEvent),
});

export const appointmentListResponse = z.object({
  appointments: z.array(appointmentSummary),
  /** Per-status tallies for the board header. Zero-filled, never sparse. */
  counts: z.record(appointmentStatus, z.number().int()),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppointmentStatusValue = z.infer<typeof appointmentStatus>;
export type AppointmentVisitTypeValue = z.infer<typeof appointmentVisitType>;
export type AppointmentSourceValue = z.infer<typeof appointmentSource>;
export type SlotUnavailableReason = z.infer<typeof slotUnavailableReason>;
export type AvailabilitySlot = z.infer<typeof availabilitySlot>;
export type AvailabilityResponse = z.infer<typeof availabilityResponse>;
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;
export type AppointmentStatusEvent = z.infer<typeof appointmentStatusEvent>;
export type AppointmentSummary = z.infer<typeof appointmentSummary>;
export type AppointmentDetail = z.infer<typeof appointmentDetail>;
export type AppointmentListResponse = z.infer<typeof appointmentListResponse>;
export type AppointmentListQuery = z.infer<typeof appointmentListQuery>;
export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequest>;
export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentRequest>;
export type UpdateAppointmentRequest = z.infer<typeof updateAppointmentRequest>;
export type AppointmentTransitionRequest = z.infer<typeof appointmentTransitionRequest>;
export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequest>;
export type NoShowAppointmentRequest = z.infer<typeof noShowAppointmentRequest>;
