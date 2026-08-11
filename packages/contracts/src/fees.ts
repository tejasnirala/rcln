/**
 * What a clinic charges for an appointment.
 *
 * ⚠️ THE FEE TYPE IS THE VISIT TYPE, AND THERE IS NO SECOND PICKER.
 *   `AppointmentVisitType` already carries `NEW`, `FOLLOW_UP`, `WALK_IN`,
 *   `TELECONSULT` and `PROCEDURE`, chosen by whoever takes the booking. A
 *   parallel "appointment type" would be a second thing for the front desk to
 *   pick and a second thing that can disagree with the first. `RESCHEDULE` is
 *   the one key with no visit behind it — it prices MOVING a booking, which is
 *   an act rather than a consultation.
 *
 * ⚠️ AND IT IS A STRING, NOT AN ENUM, ON THE WIRE AND IN THE COLUMN. A clinic
 *   -defined catalogue is a decision nobody has taken yet (§0.2 decision 2); a
 *   `varchar` leaves the door open without a migration, and `KNOWN_FEE_TYPES`
 *   below is what every screen renders today.
 *
 * ⚠️ NULL MEANS INHERIT; ZERO MEANS FREE. Both scoping columns are nullable and
 *   both nulls are meaningful — `branchId: null` is every branch,
 *   `doctorProfileId: null` is the clinic's default that every doctor inherits.
 *   An `amountMinor` of `null` on a WRITE deletes the row, which is how a
 *   clinic un-sets an override; an amount of `0` is a price the clinic chose,
 *   and it resolves rather than falling through. Reading a blank as free bills
 *   every review at nothing, silently.
 *
 * Amounts are minor units, integers, like every other money field on the wire —
 * `numeric(14,2)` in the column, converted at exactly one boundary
 * (`services/invoicing/money.ts`).
 */
import { z } from 'zod';

import { uuid } from './common.js';

/**
 * What the fee grid renders today: the five visit types plus the move charge.
 *
 * Advisory rather than a validator. The column accepts any key so a
 * clinic-defined catalogue can arrive later, and a screen that hard-codes six
 * strings would then show a price nobody can see.
 */
export const KNOWN_FEE_TYPES = [
  'NEW',
  'FOLLOW_UP',
  'WALK_IN',
  'TELECONSULT',
  'PROCEDURE',
  'RESCHEDULE',
] as const;
export type KnownFeeType = (typeof KNOWN_FEE_TYPES)[number];

/**
 * The key itself.
 *
 * Upper snake case is enforced because the resolver matches it exactly against
 * `AppointmentVisitType`, and `follow_up` silently pricing nothing is the kind
 * of failure that shows up as a zero on a patient's bill.
 */
export const feeType = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'upper snake case, e.g. FOLLOW_UP');
export type FeeTypeValue = z.infer<typeof feeType>;

/**
 * Which of the four scopes answered, most specific first.
 *
 * On the wire because a screen has to be able to say "inherited from the
 * clinic" rather than showing a doctor a number with no provenance — an admin
 * who cannot tell an override from an inherited default will set overrides
 * everywhere just to be sure, and then the clinic's default stops meaning
 * anything.
 */
export const feeScopeLevel = z.enum([
  'DOCTOR_BRANCH',
  'DOCTOR_ORGANIZATION',
  'CLINIC_BRANCH',
  'CLINIC_ORGANIZATION',
]);
export type FeeScopeLevel = z.infer<typeof feeScopeLevel>;

/** One stored row, as the grid lists it. */
export const feeScheduleEntry = z.object({
  id: uuid,
  /** Null = every branch. */
  branchId: uuid.nullable(),
  branchName: z.string().nullable(),
  /** Null = the clinic's default, which every doctor inherits. */
  doctorProfileId: uuid.nullable(),
  doctorName: z.string().nullable(),
  feeType,
  amountMinor: z.int(),
  updatedAt: z.iso.datetime(),
});
export type FeeScheduleEntry = z.infer<typeof feeScheduleEntry>;

/**
 * One row of the grid a human edits: what applies, and where it came from.
 *
 * `amountMinor` is the EFFECTIVE price — what a patient booking this visit with
 * this doctor at this branch would be quoted. `ownAmountMinor` is the value
 * stored at the scope being edited, and it is null whenever the effective
 * number is inherited from a broader one.
 */
export const feeScheduleRow = z.object({
  feeType,
  /** Null when nothing is set at any level. The screen shows "not set". */
  amountMinor: z.int().nullable(),
  level: feeScopeLevel.nullable(),
  /** What is stored at the scope this grid edits. Null = inherits. */
  ownAmountMinor: z.int().nullable(),
});
export type FeeScheduleRow = z.infer<typeof feeScheduleRow>;

/**
 * The grid for one scope.
 *
 * `branchId: null` is the org-wide sheet — the clinic's default everywhere,
 * which is what a single-branch clinic edits and never thinks about again.
 */
export const feeScheduleView = z.object({
  /** What `amountMinor` is denominated in. The organization's. */
  currency: z.string().length(3),
  branchId: uuid.nullable(),
  doctorProfileId: uuid.nullable(),
  rows: z.array(feeScheduleRow),
});
export type FeeScheduleView = z.infer<typeof feeScheduleView>;

/**
 * Save a scope's prices.
 *
 * ⚠️ A PARTIAL LIST. Only the fee types named are touched; a type left out is
 *   left alone. Sending `amountMinor: null` is how a row is REMOVED, and it is
 *   the only way to go back to inheriting — the alternative, treating a missing
 *   key as a delete, would wipe a clinic's grid the first time a screen posted
 *   a filtered subset.
 */
/**
 * One priced row: a visit type and what it costs at the scope being written.
 *
 * Extracted so `createDoctorRequest` can carry the same rows inline — a doctor's
 * opening prices are set in the same submission that creates them. One schema,
 * so the create path and the grid cannot disagree about what a fee row is.
 */
export const feeScheduleAmount = z.object({
  feeType,
  /** Null deletes the row at this scope. Zero is a price. */
  amountMinor: z.int().min(0).max(99_999_999).nullable(),
});
export type FeeScheduleAmount = z.infer<typeof feeScheduleAmount>;

export const setFeeScheduleRequest = z.object({
  /** Null = every branch. Must be a branch this caller may touch when set. */
  branchId: uuid.nullable().default(null),
  fees: z.array(feeScheduleAmount).min(1).max(64),
});
export type SetFeeScheduleRequest = z.infer<typeof setFeeScheduleRequest>;

export const feeScheduleQuery = z.object({
  /**
   * Which sheet to read. Absent means the org-wide one; a uuid means that
   * branch's, with what it inherits already folded in.
   */
  branchId: uuid.optional(),
});
export type FeeScheduleQuery = z.infer<typeof feeScheduleQuery>;

/**
 * What this visit would cost, before it is booked.
 *
 * ⚠️ THE SAME FUNCTION THE BOOKING FREEZE CALLS, AND THAT IS THE WHOLE POINT OF
 *   THE ENDPOINT. A fee frozen at booking that nobody sees until the invoice is
 *   a quote the patient was never given (§0.2 decision 13). A second
 *   implementation behind the screen is how the desk says one number and the
 *   bill states another.
 */
export const feeQuoteQuery = z.object({
  doctorProfileId: uuid,
  branchId: uuid,
  /** A visit type, or any other fee key — `RESCHEDULE` included. */
  feeType,
});
export type FeeQuoteQuery = z.infer<typeof feeQuoteQuery>;

export const feeQuote = z.object({
  currency: z.string().length(3),
  doctorProfileId: uuid,
  branchId: uuid,
  feeType,
  /** Null when no row applies at any level — unpriced, not free. */
  amountMinor: z.int().nullable(),
  level: feeScopeLevel.nullable(),
});
export type FeeQuote = z.infer<typeof feeQuote>;
