/**
 * Turning product column values into wire values, in one place.
 *
 * WHY THIS FILE EXISTS
 *   `toCalendarDate` had three identical copies (product, identifier and
 *   tax-classification services) and `decimalToString` had two. That is exactly
 *   the duplication `pnpm kb:find` exists to prevent, and it was not harmless:
 *   the three date copies all carried the same off-by-one, so fixing it meant
 *   finding all three. One of them would have been missed.
 *
 * ⚠️ THE DATE MODEL, BECAUSE IT IS THE PART THAT GOES WRONG
 *   `effective_from` and `effective_to` are `@db.Date` — a CALENDAR DAY, with no
 *   time and no zone. Prisma hands one back as a JavaScript `Date` pinned to UTC
 *   midnight, which is a faithful representation and a trap: the moment you
 *   compare it against `new Date()` you are comparing a day against an instant,
 *   and the day loses.
 *
 *   Concretely, that was the bug. `effectiveTo >= new Date()` on an identifier
 *   valid THROUGH 2026-12-31 reads as `2026-12-31T00:00:00Z >= 2026-12-31T09:14Z`
 *   → false, from nine in the morning on the last valid day. The window is
 *   inclusive by contract ("false once `effectiveTo` has passed"), so the row
 *   stopped being current a full day early — every day, for every row, silently.
 *
 *   So: never compare one of these columns to an instant. Compare day to day,
 *   which is what `startOfCalendarDay` produces and what everything here takes.
 */

/**
 * `YYYY-MM-DD` from a `@db.Date` column.
 *
 * Prisma returns the column as a `Date` at UTC midnight, so `toISOString()`
 * yields the calendar date that was STORED — this is not a timezone conversion
 * and must not become one. `toLocaleDateString` here would render the
 * container's zone and shift the date by a day for half the world.
 */
export function toCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * An instant, flattened to the UTC midnight of its own calendar day — the same
 * shape Prisma gives back for a `@db.Date` column, so the two are comparable.
 *
 * ⚠️ THE DAY IS TAKEN IN UTC, AND FOR THESE COLUMNS THAT IS THE POINT. A
 *   regulatory validity window is a property of the record, not of the branch
 *   reading it: an identifier withdrawn on the 31st is withdrawn on the 31st for
 *   everyone. This is deliberately NOT the clinic-timezone rule that governs
 *   appointments and anything else a person experiences at a wall clock.
 *
 *   Where the DAY OF SUPPLY genuinely matters — which tax applied when this was
 *   sold — the caller passes it in (`resolveTaxCategory(…, on)`) having worked
 *   it out in the branch's zone. This function then only flattens it.
 */
export function startOfCalendarDay(value: Date): Date {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** Today as a calendar day, comparable with a `@db.Date` column. */
export function calendarToday(): Date {
  return startOfCalendarDay(new Date());
}

/**
 * Is a validity window still open on a given day?
 *
 * ⚠️ INCLUSIVE OF `effectiveTo`. A row valid through the 31st is current ON the
 *   31st. `null` means open-ended. Both halves are contract, not preference —
 *   `productIdentifierDetail.isCurrent` says "false once `effectiveTo` has
 *   passed", and a row that expires the day before it says it does is the kind
 *   of defect that surfaces as one unscannable barcode nobody can reproduce.
 */
export function isCurrentOn(effectiveTo: Date | null, on: Date = calendarToday()): boolean {
  if (effectiveTo === null) return true;
  return startOfCalendarDay(effectiveTo).getTime() >= startOfCalendarDay(on).getTime();
}

/**
 * `YYYY-MM-DD` from a contract into the UTC midnight a `@db.Date` column holds.
 *
 * The inverse of `toCalendarDate`, and it lives here for the reason this file's
 * header gives: `toCalendarDate` had three identical copies and they all carried
 * the same off-by-one. This one had four — `doctor.service.ts`,
 * `patient.service.ts`, `patient-history.service.ts` and PI-2's
 * `batch.service.ts` — in three subtly different signatures.
 *
 * ⚠️ THE THREE OLDER COPIES ARE STILL THERE. Collapsing them means touching
 *   Phase 3's doctor and patient services and their tests, which is not PI-2's
 *   change to make; this is the canonical one and the place the next person
 *   should find. Recorded in the PI-2 tracker as a follow-up.
 */
export function toDateColumn(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(`${value}T00:00:00.000Z`);
}

/**
 * `Decimal` columns come back as a Prisma Decimal. `toString()` preserves every
 * digit; `Number()` would not, which is the whole reason quantities are strings
 * on the wire.
 */
export function decimalToString(value: { toString(): string } | null): string | null {
  return value === null ? null : value.toString();
}
