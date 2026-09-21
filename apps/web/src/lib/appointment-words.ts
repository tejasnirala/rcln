/**
 * What an appointment's status is CALLED and what COLOUR it is, in one place.
 *
 * ⚠️ SHARED BECAUSE FOUR SCREENS STATED THE SAME FACT AND TWO OF THEM DISAGREED.
 *   The day board said "Arrived", the consultation page said "Checked in", and
 *   the episode timeline and the visit history each kept a third copy. That is
 *   the failure `patient-words.ts` was written to stop, one domain over: the
 *   vocabulary the API uses is `appointmentStatus` in `@rcln/contracts`, and
 *   this is what it reads as on screen. "Arrived" won — it is what a front desk
 *   says out loud, and this vocabulary is read at a counter.
 *
 * ⚠️ COLOUR IS THE SECOND SIGNAL, NEVER THE ONLY ONE (WCAG 1.4.1, and
 *   apps/web/AGENTS.md lists it as a rule already got wrong once). Every chip
 *   below prints the WORD; the tint is what makes a cancelled row findable at a
 *   glance down a column of eleven, not what tells you it was cancelled. A
 *   screen reader, a monochrome print and a red-green colour-blind reader all
 *   get the same answer as everybody else.
 *
 * ⚠️ EVERY PAIR IS ONE THE APP HAS ALREADY MEASURED. These are the exact
 *   foreground/background pairs `Alert` ships (`bg-danger-tint text-danger` and
 *   its siblings), plus `bg-signal-tint text-signal` from the patient chart and
 *   `bg-drape text-paper`, which AGENTS.md names as THE way to write text on a
 *   solid accent. Nothing here invents a colour, and nothing here is a raw one —
 *   which is what keeps it correct in all ten appearance × accent combinations.
 */

import type { AppointmentStatusValue } from '@rcln/contracts';

export const APPOINTMENT_STATUS_WORDS: Record<AppointmentStatusValue, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Arrived',
  IN_PROGRESS: 'With the doctor',
  COMPLETED: 'Seen',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not attend',
};

/**
 * The same words, looked up from a status that is only typed as a string.
 *
 * ⚠️ FOR `visitHistory.appointmentStatus`, WHICH IS `z.string().nullable()` AND
 *   NOT THE ENUM. That is the contract's own choice — the visit history joins
 *   rows that may predate a status the enum knows about — so this is the one
 *   place a widened read is legitimate. It falls back to the raw value rather
 *   than to a blank: an unrecognised status should print as itself, because
 *   "COMPLETED" is at least true, and an empty cell is not.
 *
 * Anything holding a real `AppointmentStatusValue` should index
 * `APPOINTMENT_STATUS_WORDS` directly, or render `AppointmentStatusChip`.
 */
const LOOSE_WORDS: Record<string, string> = APPOINTMENT_STATUS_WORDS;

export function statusWord(status: string): string {
  return LOOSE_WORDS[status] ?? status;
}

/**
 * The chip: a border, a tint and a text colour, as one string.
 *
 * The ramp is a story rather than seven arbitrary hues — reading down it is
 * reading the day:
 *
 *   BOOKED       nothing has happened yet, so nothing is coloured.
 *   CONFIRMED    the accent: somebody has spoken to the patient.
 *   CHECKED_IN   `signal`, which in this app means one thing — happening now.
 *                The patient is in the building.
 *   IN_PROGRESS  the only SOLID chip on the board. The row you are looking for.
 *   COMPLETED    `success`. Done, and done well.
 *   CANCELLED    `danger`. Called off.
 *   NO_SHOW      `warning`, and deliberately NOT `danger` — a patient who did
 *                not turn up and a booking somebody called off are different
 *                facts with different follow-ups, and a board that paints them
 *                the same colour has thrown that difference away.
 */
export const APPOINTMENT_STATUS_CHIP: Record<AppointmentStatusValue, string> = {
  BOOKED: 'border-rule bg-card text-muted',
  CONFIRMED: 'border-drape/30 bg-drape-tint/60 text-drape-deep',
  CHECKED_IN: 'border-signal/40 bg-signal-tint text-signal',
  IN_PROGRESS: 'border-drape bg-drape text-paper',
  COMPLETED: 'border-success/30 bg-success-tint text-success',
  CANCELLED: 'border-danger/30 bg-danger-tint text-danger',
  NO_SHOW: 'border-warning/30 bg-warning-tint text-warning',
};

const LOOSE_CHIP: Record<string, string> = APPOINTMENT_STATUS_CHIP;

/**
 * The chip's classes, for a status that is only typed as a string.
 *
 * ⚠️ THE FALLBACK IS THE NEUTRAL CHIP, NEVER A COLOURED ONE. A status this app
 *   has not learnt about must not be painted green or red on a guess — "I do not
 *   know what this is" and "this went fine" are different answers, and only one
 *   of them is safe to invent. `statusWord` prints the raw value beside it, so
 *   an unknown status reads as itself in a plain box rather than disappearing.
 *
 * The loose signature exists because two contracts genuinely type this as a
 * string — `visitHistory.appointmentStatus` and the appointments on
 * `clinicalEpisodeDetail` — and a cast at those call sites would be a lie the
 * type system stopped checking. See `statusWord`.
 */
export function statusChipClass(status: string): string {
  return LOOSE_CHIP[status] ?? APPOINTMENT_STATUS_CHIP.BOOKED;
}

/**
 * The same seven colours as a 2px rail down the left edge of a list row.
 *
 * ⚠️ THE RAIL IS WHAT MAKES THE BOARD SCANNABLE, AND IT IS DECORATION. It runs
 *   the full height of the row, so it survives being glanced at from across a
 *   desk in a way a chip three columns in does not — but it says nothing on its
 *   own, and the chip beside it is what carries the meaning. `BOOKED` gets a
 *   transparent rail rather than a grey one: an ordinary booking is the majority
 *   of any day, and a colour every row has is not a signal.
 */
export const APPOINTMENT_STATUS_RAIL: Record<AppointmentStatusValue, string> = {
  BOOKED: 'border-l-transparent',
  CONFIRMED: 'border-l-drape/40',
  CHECKED_IN: 'border-l-signal',
  IN_PROGRESS: 'border-l-drape',
  COMPLETED: 'border-l-success',
  CANCELLED: 'border-l-danger',
  NO_SHOW: 'border-l-warning',
};

/**
 * The same seven colours as a solid dot, for the day tally's legend.
 *
 * ⚠️ DECORATIVE, AND IT HAS TO BE `aria-hidden` AT THE CALL SITE. The tally's
 *   chips already print the word and the count; the dot exists so the code the
 *   rows are painted in is LEARNABLE — you see "3 Cancelled" beside a red dot
 *   once and the red rail down the board means something afterwards. Solid
 *   rather than tinted, because eight pixels of a tint is invisible.
 *
 *   `BOOKED` gets a real grey here rather than the transparent rail: in a legend
 *   an absent dot reads as a rendering fault, where on a row it reads as "this
 *   one is ordinary", which is what it means.
 */
export const APPOINTMENT_STATUS_DOT: Record<AppointmentStatusValue, string> = {
  BOOKED: 'bg-muted',
  CONFIRMED: 'bg-drape/50',
  CHECKED_IN: 'bg-signal',
  IN_PROGRESS: 'bg-drape',
  COMPLETED: 'bg-success',
  CANCELLED: 'bg-danger',
  NO_SHOW: 'bg-warning',
};

/**
 * The three statuses with no outgoing edge in `TRANSITIONS`.
 *
 * A completed, cancelled or missed booking is finished: it cannot be moved on,
 * cancelled again, or have vitals or a follow-up hung off it. Both the board and
 * the consultation page asked this question with their own copy of the same
 * three-way `||`; this is that question with a name.
 */
export function isFinished(status: AppointmentStatusValue): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'NO_SHOW';
}

/**
 * Whether the visit actually took place.
 *
 * ⚠️ NOT THE INVERSE OF `isFinished` — `COMPLETED` is both finished and a visit
 *   that happened. This is the question the API asks before it accepts vitals
 *   (`recordVitals`) or a follow-up (`createFollowUp`), and the screens ask it
 *   here so they stop OFFERING what the API would refuse. Keeping the two in
 *   step matters more than the wording: a button that always 409s is worse than
 *   no button, because the desk learns to distrust the screen rather than the
 *   booking.
 */
export function didNotHappen(status: AppointmentStatusValue): boolean {
  return status === 'CANCELLED' || status === 'NO_SHOW';
}
