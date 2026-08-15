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
import { calendarDate, uuid } from './common.js';
import { appointmentInvoiceLink } from './invoices.js';
import { fromCelsius, type TemperatureUnit } from './locale.js';

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

/**
 * The longest span the working-day probe will answer for.
 *
 * A calendar month plus the leading and trailing days a month grid draws, with
 * room to spare. The picker asks a month at a time.
 */
export const WORKING_DAYS_MAX_SPAN = 62;

/**
 * "Which days can this doctor be booked on at all?"
 *
 * ⚠️ A DIFFERENT QUESTION FROM `availabilityQuery`, AND DELIBERATELY A CHEAPER
 *   ONE. That one cuts a day into slots and says which are free; this one answers
 *   yes/no for each of thirty-odd days and never enumerates a single slot. The
 *   date picker needs the second question — greying out a Wednesday the doctor
 *   never works — and asking the first one thirty times to get it would run the
 *   whole engine per day for an answer that fits in a bit.
 *
 * Same parameters, same permission, same disclosure: a branch, a doctor and a
 * span of dates are nobody's surname, and the reply never mentions a patient.
 */
export const workingDaysQuery = z
  .object({
    branchId: uuid,
    doctorProfileId: uuid,
    from: calendarDate,
    to: calendarDate,
  })
  .superRefine((v, ctx) => {
    if (v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the first day' });
      return;
    }
    if (daysSpanned(v.from, v.to) > WORKING_DAYS_MAX_SPAN) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `at most ${String(WORKING_DAYS_MAX_SPAN)} days at a time`,
      });
    }
  });

/** Why a whole day cannot be booked. Null when some part of it can. */
export const workingDayReason = z.enum(['PAST', 'NOT_SCHEDULED', 'ON_LEAVE', 'BRANCH_CLOSED']);

export const workingDay = z.object({
  /** `YYYY-MM-DD` in the branch's zone. */
  date: z.string(),
  /**
   * Whether the doctor has any working hours here that day that have not
   * already gone.
   *
   * ⚠️ NOT "HAS A FREE SLOT". A fully booked day is still bookable in this
   *   sense: the picker's job is to stop the desk landing on a day with no
   *   clinic at all, and the slot grid is what says the 10:20 is taken. Fusing
   *   them would grey out a day where somebody has just cancelled.
   */
  bookable: z.boolean(),
  reason: workingDayReason.nullable(),
});

export const workingDaysResponse = z.object({
  branchId: uuid,
  doctorProfileId: uuid,
  /** The branch's zone, which is also what decided where "past" starts. */
  timezone: z.string(),
  /** One entry per day in the span, in order, none missing. */
  days: z.array(workingDay),
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
  /**
   * The treatment journey this booking joins — the front desk saying "this is
   * about the same thing as last time" (CE-1).
   *
   * ⚠️ ABSENT OPENS A NEW JOURNEY. It does NOT fall back to the patient's most
   *   recent open episode, and that restraint is deliberate: guessing that a
   *   sore throat in March belongs to January's diabetes journey is a clinical
   *   claim made by a default value. Joining an existing journey is always
   *   somebody's explicit decision — this field, or the follow-up link, which
   *   inherits without asking because a follow-up IS a continuation by
   *   definition.
   *
   * ⚠️ IT MUST BELONG TO `patientId`, and the service re-checks that rather than
   *   trusting the pair. Both arrive from one form, and a picker that does not
   *   re-filter when the patient changes would file one person's visit under
   *   another person's treatment history.
   */
  clinicalEpisodeId: uuid.optional(),
});

/**
 * Move a booking. Deliberately NOT a PATCH of `startsAt` on the update
 * endpoint: a reschedule re-runs the availability check and writes a status
 * history row, and folding it into a general update is how one of those gets
 * skipped.
 */
/**
 * Who asked for the booking to move.
 *
 * ⚠️ RECORDED BECAUSE THE SYSTEM CANNOT TELL, AND BECAUSE MONEY DEPENDS ON IT.
 *   A clinic-initiated move — the doctor took leave, the branch closed — is
 *   never charged. Billing a patient because your consultant called in sick is
 *   the bill that ends up on Google Reviews. A patient-initiated move is charged
 *   once per move, and carries a reason.
 */
export const rescheduleInitiator = z.enum(['PATIENT', 'CLINIC']);
export type RescheduleInitiatorValue = z.infer<typeof rescheduleInitiator>;

export const rescheduleAppointmentRequest = z
  .object({
    startsAt: z.iso.datetime(),
    durationMinutes: z.number().int().min(5).max(240).optional(),
    /**
     * Moving to a different doctor is a reschedule, not a new booking.
     *
     * ⚠️ AND IT RE-RESOLVES THE FROZEN FEE. A different practitioner gives a
     *   different consultation; billing a consultant at a junior's rate loses
     *   real money. This is not the pro-rata rule that was deliberately
     *   withdrawn (§0.2 decision 10) — that was ONE doctor's price moving over
     *   time, which a frozen fee is meant to survive.
     */
    doctorProfileId: uuid.optional(),
    note: z.string().max(500).optional(),
    /**
     * ⚠️ DEFAULTS TO `CLINIC`, AND THE DEFAULT IS THE SAFE DIRECTION. An
     *   unstated initiator charges the patient nothing. The opposite default
     *   would mean every caller that has not been updated starts quietly adding
     *   a fee to somebody's bill.
     */
    initiatedBy: rescheduleInitiator.default('CLINIC'),
    /** ⚠️ PHI-capable — "chemotherapy clashes". Never enters the audit trail. */
    reason: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    /*
     * A patient-initiated move is charged, so it has to be explicable. "Why was
     * I billed 200 for moving my appointment?" is a question the desk must be
     * able to answer from the record rather than from memory.
     */
    if (value.initiatedBy === 'PATIENT' && (value.reason ?? '').trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A patient-requested change needs a reason.',
      });
    }
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
 * Book the next visit in the same chain.
 *
 * Everything the patient and the clinic already agreed — which patient, which
 * branch — is read off the parent rather than accepted from the caller, so a
 * follow-up cannot quietly become a booking for somebody else. Only the time is
 * genuinely new, and the doctor only because a follow-up is occasionally handed
 * to a colleague.
 *
 * ⚠️ THE FOLLOW-UP GETS ITS OWN APPOINTMENT NUMBER. The chain is carried by
 *   `parentAppointmentId`, which the database enforces; reusing the parent's
 *   token string would make two live rows answer to one number called out in a
 *   waiting room. See the column comment on `appointments.parent_appointment_id`.
 */
export const followUpAppointmentRequest = z.object({
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  /** Absent = the same doctor. A follow-up is normally with whoever saw them. */
  doctorProfileId: uuid.optional(),
  /** ⚠️ PHI. Why they are coming back. */
  reason: z.string().max(2000).optional(),
  /**
   * The recommendation this booking satisfies (CD-13, CE-4).
   *
   * ⚠️ OPTIONAL IN BOTH DIRECTIONS, AND NEITHER ABSENCE IS AN ERROR. A patient
   *   may book a follow-up nobody recommended, and a recommendation may never
   *   be booked at all — the second is the entire recall list. What a
   *   recommendation and a booking are NOT is one row: "who was told to come
   *   back and hasn't" is unanswerable if an unbooked recommendation does not
   *   exist.
   *
   * ⚠️ FULFILMENT IS ONE-TO-ONE, BY PARTIAL UNIQUE INDEX. One appointment
   *   cannot satisfy two recommendations, and re-posting the same booking
   *   changes nothing.
   */
  fulfilsRecommendationId: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

/**
 * What each observation is measured in, and the values a living patient can
 * actually produce.
 *
 * ⚠️ ONE TABLE, READ BY THE CONTRACT BELOW AND BY THE FORM. The bounds used to
 *   be written inline in the schema and nowhere else, so the number inputs had
 *   no `min`, no `max` and no `step` — a nurse could type a pulse of -5, or 900,
 *   and find out only after a round trip, in a sentence that said "Too small:
 *   expected number to be >=20". The value never reached the database; what was
 *   missing was the form knowing what the contract knew. Deriving both from here
 *   is what stops the two drifting.
 *
 * ⚠️ THESE ARE SURVIVABILITY BOUNDS, NOT NORMALITY BOUNDS, AND THE DIFFERENCE IS
 *   THE WHOLE DESIGN. A pulse of 38 is alarming and real; a saturation of 62 is
 *   why the patient is in the room. A form that refuses those is a form that
 *   loses the observation that mattered, and the nurse writes it on paper
 *   instead. Every bound here is set to catch a TYPO — a transposed digit, a
 *   stuck key, a value typed into the wrong box — and nothing tighter. Do not
 *   narrow one because a value "looks wrong": that judgement belongs to the
 *   clinician holding the cuff, and the range flags on the chart are where it
 *   gets expressed.
 *
 * ⚠️ `step` IS THE RESOLUTION THE COLUMN ACTUALLY STORES, so the form cannot
 *   offer precision that is about to be rounded away. `height_cm` and
 *   `weight_kg` are `Decimal(5, 1)`, the integers are `SmallInt`. Temperature is
 *   the exception and is handled per country — see `vitalRangeForUnit`.
 */
export interface VitalRange {
  min: number;
  max: number;
  /** Also says whether decimals are allowed at all: 1 means whole numbers. */
  step: number;
  /** What follows the number, on the label and in the error. */
  unit: string;
  /** How the error names it: "A pulse is between …". */
  noun: string;
}

export const VITAL_RANGES = {
  heightCm: { min: 20, max: 280, step: 0.1, unit: 'cm', noun: 'A height' },
  weightKg: { min: 0.3, max: 500, step: 0.1, unit: 'kg', noun: 'A weight' },
  temperatureC: { min: 25, max: 45, step: 0.1, unit: '°C', noun: 'A temperature' },
  pulseBpm: { min: 20, max: 300, step: 1, unit: 'bpm', noun: 'A pulse' },
  respiratoryRateBpm: { min: 4, max: 120, step: 1, unit: 'breaths/min', noun: 'A breathing rate' },
  systolicMmHg: { min: 40, max: 300, step: 1, unit: 'mmHg', noun: 'A systolic pressure' },
  diastolicMmHg: { min: 20, max: 200, step: 1, unit: 'mmHg', noun: 'A diastolic pressure' },
  spo2Percent: { min: 50, max: 100, step: 1, unit: '%', noun: 'An oxygen saturation' },
  bloodGlucoseMgDl: { min: 10, max: 1000, step: 0.1, unit: 'mg/dL', noun: 'A blood glucose' },
} as const satisfies Record<string, VitalRange>;

export type VitalKey = keyof typeof VITAL_RANGES;

/**
 * The sentence a clinician reads when a reading is out of range.
 *
 * ⚠️ IT NAMES THE MEASUREMENT, THE TWO NUMBERS AND THE UNIT. Zod's own
 *   "Too small: expected number to be >=20" is a developer's sentence: it does
 *   not say what is too small, what it should be, or what to do — and on a form
 *   with nine boxes, "what" is the first thing you need. See
 *   apps/web/AGENTS.md on interface copy.
 */
export function vitalRangeMessage(range: VitalRange): string {
  return `${range.noun} is between ${String(range.min)} and ${String(range.max)}${range.unit === '%' || range.unit.startsWith('°') ? '' : ' '}${range.unit}. Check the reading.`;
}

/**
 * The temperature range in the unit the clinic actually types in.
 *
 * ⚠️ DERIVED FROM THE CELSIUS BOUNDS, NEVER WRITTEN OUT TWICE. `temperatureC` in
 *   the table above is the authority — it is what the API enforces — and 77–113
 *   is that same pair of numbers converted. A second hand-written Fahrenheit
 *   pair is how a form ends up refusing a reading the API would have taken, or
 *   taking one it refuses.
 */
export function temperatureRangeFor(unit: TemperatureUnit): VitalRange {
  const celsius: VitalRange = VITAL_RANGES.temperatureC;
  if (unit === 'C') return celsius;

  return {
    min: fromCelsius(celsius.min, 'F'),
    max: fromCelsius(celsius.max, 'F'),
    /* 0.1 °F is finer than 0.1 °C, and `temperature_c` is stored at 0.01 °C
       precisely so it survives the trip back. See the column comment. */
    step: 0.1,
    unit: '°F',
    noun: celsius.noun,
  };
}

/** A bounded number, with a message somebody can act on, from one entry. */
function bounded(key: VitalKey): z.ZodNumber {
  const range: VitalRange = VITAL_RANGES[key];
  const message = vitalRangeMessage(range);
  const base = range.step === 1 ? z.number().int(message) : z.number();
  return base.min(range.min, message).max(range.max, message);
}

/**
 * One set of observations.
 *
 * ⚠️ EVERY FIELD IS OPTIONAL, BUT NOT ALL OF THEM AT ONCE — the refinement
 *   below rejects an empty submission. A front desk that takes a blood pressure
 *   and nothing else is normal; a row recording nothing is a mis-click.
 *
 * Every bound comes from `VITAL_RANGES` above, which the form also renders its
 * `min`/`max`/`step` from. This is the authority; the form is the courtesy.
 */
export const recordVitalsRequest = z
  .object({
    /** Centimetres. */
    heightCm: bounded('heightCm').optional(),
    /** Kilograms. */
    weightKg: bounded('weightKg').optional(),
    /** Degrees Celsius — in every country. See `temperature_c` in the schema. */
    temperatureC: bounded('temperatureC').optional(),
    pulseBpm: bounded('pulseBpm').optional(),
    respiratoryRateBpm: bounded('respiratoryRateBpm').optional(),
    systolicMmHg: bounded('systolicMmHg').optional(),
    diastolicMmHg: bounded('diastolicMmHg').optional(),
    spo2Percent: bounded('spo2Percent').optional(),
    /** mg/dL — the unit Indian clinics report in. */
    bloodGlucoseMgDl: bounded('bloodGlucoseMgDl').optional(),
    /** ⚠️ PHI. "Repeated after 10 minutes, patient had climbed the stairs." */
    notes: z.string().max(1000).optional(),
    /**
     * When it was taken, if that is not now. The front desk types up a paper
     * slip an hour later often enough that defaulting to the write time would
     * misdate the trend.
     */
    recordedAt: z.iso.datetime().optional(),
  })
  .refine(
    (v) =>
      v.heightCm !== undefined ||
      v.weightKg !== undefined ||
      v.temperatureC !== undefined ||
      v.pulseBpm !== undefined ||
      v.respiratoryRateBpm !== undefined ||
      v.systolicMmHg !== undefined ||
      v.diastolicMmHg !== undefined ||
      v.spo2Percent !== undefined ||
      v.bloodGlucoseMgDl !== undefined,
    { message: 'Record at least one observation.' }
  )
  /*
   * Half a blood pressure is not a blood pressure. Recording 120 with no
   * diastolic produces a row that every later trend and range check has to
   * special-case, so it is refused at the edge instead.
   */
  .refine((v) => (v.systolicMmHg === undefined) === (v.diastolicMmHg === undefined), {
    message: 'A blood pressure needs both numbers.',
    path: ['diastolicMmHg'],
  })
  .refine((v) => v.systolicMmHg === undefined || v.systolicMmHg > (v.diastolicMmHg ?? 0), {
    message: 'Systolic must be higher than diastolic — check the two are not swapped.',
    path: ['systolicMmHg'],
  });

/** Whole days between two `YYYY-MM-DD` dates, inclusive of both ends. */
function daysSpanned(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * The longest range the board will answer for, in days.
 *
 * A calendar month is 31; the extra room is for a month view whose arrows have
 * been pushed to a long month, not for a client that wants a year. An unbounded
 * range is a list of every patient the clinic has ever seen, which is not a
 * screen anybody asked for — this is where that limit is stated.
 */
export const APPOINTMENT_RANGE_MAX_DAYS = 45;

/**
 * Correct a reading that was mistyped.
 *
 * ⚠️ THIS IS AN AMENDMENT, NOT A SECOND OBSERVATION, AND THE DISTINCTION IS
 *   CLINICAL. A repeat blood pressure twenty minutes after a high first reading
 *   is a NEW reading and goes through `recordVitalsRequest` — the first one is
 *   why the patient was sat down, and overwriting it would erase the reason for
 *   the intervention. This is for the other case, which is just as real: a nurse
 *   typed 1200 for 120, and until now the only remedy was to withdraw the whole
 *   reading and retype it.
 *
 * ⚠️ IT REPLACES EVERY VALUE, IT DOES NOT MERGE. The form is populated with what
 *   is already recorded, so an empty box means "this was not measured" — the
 *   same thing it means when the reading is first taken. Merging would make a
 *   cleared box unclearable, and "not measured" and "measured, unchanged" must
 *   not be the same gesture.
 *
 * The same shape and the same bounds as recording one, deliberately aliased
 * rather than restated: two schemas for one row is how a value the form accepts
 * becomes a value the amendment refuses.
 */
export const updateVitalsRequest = recordVitalsRequest;

/**
 * The board.
 *
 * `date` is required and is the FIRST day. `to` widens it to a range — a week
 * or a month on the same screen — and is inclusive, so a single day is
 * `to` absent or `to === date`.
 *
 * ⚠️ BOTH ARE CALENDAR DATES IN THE BRANCH'S ZONE, and the range is turned into
 *   two instants in Postgres, exactly as one day always was. A range composed in
 *   Node would be a month whose first and last days are an hour wrong on either
 *   side of a DST boundary.
 */
export const appointmentListQuery = z
  .object({
    branchId: uuid,
    date: calendarDate,
    /** Inclusive last day. Absent = the one day in `date`. */
    to: calendarDate.optional(),
    doctorProfileId: uuid.optional(),
    status: appointmentStatus.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.to === undefined) return;
    if (v.to < v.date) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the first day' });
      return;
    }
    if (daysSpanned(v.date, v.to) > APPOINTMENT_RANGE_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `at most ${String(APPOINTMENT_RANGE_MAX_DAYS)} days at a time`,
      });
    }
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
  /**
   * The BRANCH'S zone, and the only thing that makes the instants below
   * readable.
   *
   * ⚠️ `scheduledStart` IS AN INSTANT; "16:40" IS THAT INSTANT IN THIS ZONE.
   *   Nothing in an ISO-8601 string says which zone it was meant to be read in,
   *   so a client that formats without one uses its own runtime's — the
   *   container's UTC on a server-rendered page. That is not hypothetical: the
   *   consultation header rendered a 16:40 IST booking as 11:10, because
   *   `toLocaleString()` with no zone is UTC in Node.
   *
   *   Sent per row rather than looked up alongside, for the same reason
   *   `availabilityResponse` carries it: the client should never have to
   *   re-derive which clinic an instant belongs to in order to print it.
   */
  timezone: z.string(),
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
  /**
   * Whether this visit is already billed, and on what.
   *
   * ⚠️ THREE STATES, AND THE THIRD IS THE KEY BEING ABSENT. An object means the
   *   visit has a live invoice; `null` means it has none; the field MISSING
   *   means this caller does not hold `billing.invoice.read` and the question was
   *   never asked. A doctor's board must not silently read as "nothing is
   *   billed" — that is the difference between an answer and no answer, and
   *   collapsing it into `null` is how a front desk stops trusting the column.
   *
   * ⚠️ LIVE, NOT "ANY INVOICE CITING THIS APPOINTMENT". `invoices.appointment_id`
   *   is deliberately not unique — a visit billed, voided and billed again has
   *   two rows, and the void keeps its reference so the correction stays
   *   explicable. A cancelled or voided invoice leaves the visit unbilled.
   *
   * Absent from every write's response as well: the board and the detail read
   * pay for the extra query, a reschedule does not.
   */
  liveInvoice: appointmentInvoiceLink.nullable().optional(),
});

export const appointmentDetail = appointmentSummary.extend({
  /** ⚠️ PHI. Behind the detail endpoint, which writes a data-access row. */
  reason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  mrn: z.string(),
  statusHistory: z.array(appointmentStatusEvent),
  /**
   * The visit this one follows up on, if any. An id and its number, not the
   * whole parent: the diagnosis page needs a link to walk back through the
   * chain, and embedding the parent would recurse for a third or fourth visit.
   */
  parentAppointmentId: uuid.nullable(),
  parentAppointmentNumber: z.string().nullable(),
  /**
   * The treatment journey this visit belongs to (CE-1).
   *
   * ⚠️ A DIFFERENT ANSWER FROM `parentAppointmentId`, AND BOTH ARE NEEDED. The
   *   parent is the immediate predecessor — A -> B -> C. The episode is the
   *   whole journey — A, B, C. The consultation screen walks the first to show
   *   the previous visit, and links the second to show the timeline.
   *
   * Never nullable: every appointment belongs to exactly one journey, and an
   * episode of one is the ordinary case.
   */
  clinicalEpisodeId: uuid,
  clinicalEpisodeCode: z.string(),
  /** Follow-ups already booked off this visit, earliest first. */
  followUps: z.array(
    z.object({
      id: uuid,
      appointmentNumber: z.string(),
      scheduledStart: z.iso.datetime(),
      status: appointmentStatus,
    })
  ),
});

/**
 * One recorded set of observations.
 *
 * ⚠️ EVERY NUMBER HERE IS PHI. This shape is only ever returned from an endpoint
 *   that writes a `data_access_logs` row, and never appears on the day board.
 *
 * The numbers cross the wire as numbers, not as the Prisma `Decimal` they are
 * stored in — the service does the conversion in one place so no consumer has to
 * know the storage type.
 */
export const vitalsReading = z.object({
  id: uuid,
  appointmentId: uuid,
  patientId: uuid,
  heightCm: z.number().nullable(),
  weightKg: z.number().nullable(),
  /**
   * Derived from height and weight, never stored — a stored BMI goes stale the
   * moment either number is corrected. Null unless both are present.
   */
  bmi: z.number().nullable(),
  temperatureC: z.number().nullable(),
  pulseBpm: z.number().int().nullable(),
  respiratoryRateBpm: z.number().int().nullable(),
  systolicMmHg: z.number().int().nullable(),
  diastolicMmHg: z.number().int().nullable(),
  spo2Percent: z.number().int().nullable(),
  bloodGlucoseMgDl: z.number().nullable(),
  /** ⚠️ PHI. */
  notes: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  recordedBy: uuid.nullable(),
  /** Staff, not a patient — a name here is who took the reading. */
  recordedByName: z.string().nullable(),
});

/**
 * One measurement that moved, with both values.
 *
 * ⚠️ THIS IS THE PART `audit_logs` DELIBERATELY CANNOT CARRY. That table is read
 *   through `audit.record.read` — a compliance code held by people with no
 *   clinical access — so it records THAT a blood pressure was corrected and
 *   never what it was. This shape is served from the clinical side instead:
 *   behind `clinical.vitals.record`, from an endpoint that writes a
 *   `data_access_logs` row, exactly like reading the reading itself.
 *
 * `field` is the contract's own name for the measurement (`systolicMmHg`), so a
 * client can label it from the same table it draws the form from rather than
 * re-prettifying a column name.
 */
export const vitalsChange = z.object({
  field: z.string(),
  /** ⚠️ PHI. Null where the measurement was not recorded before. */
  before: z.number().nullable(),
  /** ⚠️ PHI. Null where it was cleared. */
  after: z.number().nullable(),
});

/**
 * One correction to one reading: what changed, from what, to what, by whom.
 *
 * ⚠️ THE NOTE IS REPORTED AS A CHANGE OF TEXT, NOT AS "has_note: yes". A note
 *   says why a reading looks the way it does — "repeated after 10 minutes,
 *   patient had climbed the stairs" — and a trail that records only its presence
 *   cannot show that the explanation itself was rewritten.
 */
export const vitalsRevision = z.object({
  id: uuid,
  /** When this version stopped being the current one. */
  supersededAt: z.iso.datetime(),
  /** Who made the correction — not who took the observation. */
  supersededBy: uuid.nullable(),
  supersededByName: z.string().nullable(),
  /** Every measurement that moved, in the order the form shows them. */
  changes: z.array(vitalsChange),
  /** ⚠️ PHI. The note before and after, when it changed. */
  noteBefore: z.string().nullable(),
  noteAfter: z.string().nullable(),
  noteChanged: z.boolean(),
});

export const vitalsRevisionsResponse = z.object({
  /**
   * NEWEST CORRECTION FIRST — the same order as the audit trail.
   *
   * ⚠️ THE SERVICE PAIRS THE VERSIONS CHRONOLOGICALLY AND REVERSES AFTERWARDS.
   *   Each stored version is the state BEFORE one correction, so its "after" is
   *   the next version along; fetching them descending to save the reverse would
   *   invert every pair and report a correction from 180 to 120 as one from 120
   *   to 180.
   */
  revisions: z.array(vitalsRevision),
});

export const vitalsListResponse = z.object({
  /** Oldest first: a repeat reading reads as a follow-on, not a correction. */
  vitals: z.array(vitalsReading),
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
export type WorkingDaysQuery = z.infer<typeof workingDaysQuery>;
export type WorkingDayReason = z.infer<typeof workingDayReason>;
export type WorkingDay = z.infer<typeof workingDay>;
export type WorkingDaysResponse = z.infer<typeof workingDaysResponse>;
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
export type FollowUpAppointmentRequest = z.infer<typeof followUpAppointmentRequest>;
export type RecordVitalsRequest = z.infer<typeof recordVitalsRequest>;
export type UpdateVitalsRequest = z.infer<typeof updateVitalsRequest>;
export type VitalsReading = z.infer<typeof vitalsReading>;
export type VitalsListResponse = z.infer<typeof vitalsListResponse>;
export type VitalsChange = z.infer<typeof vitalsChange>;
export type VitalsRevision = z.infer<typeof vitalsRevision>;
export type VitalsRevisionsResponse = z.infer<typeof vitalsRevisionsResponse>;
