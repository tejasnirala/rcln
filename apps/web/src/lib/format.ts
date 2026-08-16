import { DEFAULT_TIME_FORMAT, type TimeFormat } from '@rcln/contracts';

/**
 * Dates that render the same on the server and in the browser.
 *
 * ⚠️ NEVER CALL `toLocaleDateString(undefined, …)` IN A COMPONENT THAT IS SSR-ED.
 *   `undefined` means "the runtime's locale", and the runtime differs: the
 *   Node container is `en-US` in UTC, the visitor's browser is whatever they set
 *   in whatever timezone they are in. React renders the server's string into the
 *   HTML, the client renders a different one, and hydration fails with the whole
 *   subtree thrown away and re-rendered.
 *
 *   It is not a cosmetic mismatch either. `2026-07-25T18:30:00Z` renders as
 *   "Jul 25, 2026" in UTC and "26 Jul 2026" in Asia/Kolkata — a period boundary
 *   that appears to be on a different DAY depending on who is looking at it.
 *
 * WHY UTC AND NOT THE VIEWER'S TIMEZONE
 *   A billing period is a contractual interval, not an event in someone's day.
 *   "This period ends on 25 July" has to mean the same thing to the clinic
 *   owner in Kolkata, the accountant in Dublin and the support engineer reading
 *   the same screen over their shoulder — and it has to match the invoice, which
 *   was generated in UTC (`@rcln/billing/periods.ts`, which is UTC throughout for
 *   the same reason). Rendering it locally would make a customer and a support
 *   agent read different dates off the same subscription.
 *
 *   This is the opposite of the right answer for anything clinical. An
 *   appointment at 09:00 means 09:00 where the clinic is, and those screens
 *   should format in `organizations.timezone` rather than using this.
 *
 * WHY `en-GB`
 *   Pinned rather than negotiated, because a pinned locale is the only kind that
 *   renders identically in both places. `en-GB` gives day-month-year, which is
 *   what India, the UK, Ireland and the UAE all read — the markets rcln
 *   publishes prices in — and it matches the British English the rest of the
 *   interface copy is written in.
 */

const BILLING_LOCALE = 'en-GB';

/** `25 Jul 2026`. For dense rows, tables and the period strip. */
export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat(BILLING_LOCALE, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** `25 July 2026`. For prose, where the month should not be abbreviated. */
export function formatLongDate(value: string | Date): string {
  return new Intl.DateTimeFormat(BILLING_LOCALE, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(value));
}

// ---------------------------------------------------------------------------
// Clinical time
// ---------------------------------------------------------------------------

/**
 * ⚠️ EVERYTHING ABOVE IS UTC AND EVERYTHING BELOW IS THE CLINIC'S ZONE. That is
 *   not an inconsistency — it is the distinction the header of this file draws.
 *   A billing period is a contractual interval that must read the same to a
 *   clinic owner in Kolkata and an accountant in Dublin. An appointment is an
 *   event in somebody's day: 16:40 means 16:40 WHERE THE CLINIC IS, and it is
 *   wrong in every other zone.
 *
 * ⚠️ THE ZONE IS ALWAYS PASSED IN, NEVER DEFAULTED, and never read from the
 *   runtime. `toLocaleString()` with no zone is the browser's zone in the
 *   browser and the CONTAINER'S UTC on the server — which is how a 16:40 IST
 *   booking rendered as 11:10 on the consultation page, plausibly and silently,
 *   five and a half hours out. Appointments carry `timezone` on the row for
 *   exactly this; other clinical screens take it from `timezoneOf(slug)`.
 *
 * ⚠️ THE CLOCK FACE IS THE CLINIC'S CHOICE, NOT A CONSTANT. This was pinned to
 *   24-hour on the reasoning that a diary is read as "16:40". That is true of a
 *   hospital in the UK and false of most Indian outpatient clinics, whose
 *   appointment cards say "4:40 pm". It is now `locale.time_format`, resolved
 *   per branch and carried on the session — `timeFormatOf(slug)` for a screen,
 *   or the branch's own `timeFormat` where one is in hand. It defaults to `12H`.
 *
 *   ⚠️ IT IS DISPLAY ONLY. Storage is UTC everywhere, the zone is the branch's,
 *     and this decides nothing but the shape of the string.
 *
 * ⚠️ `en-GB` PINNED FOR THE SAME REASON AS ABOVE. A pinned locale is the only
 *   kind that renders identically on the server and in the browser — so the
 *   12/24 choice is passed to `hour12` explicitly rather than being left to a
 *   locale, which would drag the date order along with it.
 */
const CLINICAL_LOCALE = 'en-GB';

/**
 * `4:40 pm` or `16:40`. The time alone, for a row that already says which day.
 *
 * ⚠️ `timeFormat` DEFAULTS RATHER THAN BEING REQUIRED, unlike `timeZone`. A
 *   missing zone renders a genuinely wrong instant — five and a half hours out,
 *   plausibly — and must never be guessable. A missing format renders the right
 *   instant in the wrong shape, which is a preference, not a bug, and forcing
 *   every call site to thread it would be noise for that.
 */
export function formatClinicTime(
  value: string | Date,
  timeZone: string,
  timeFormat: TimeFormat = DEFAULT_TIME_FORMAT
): string {
  return new Intl.DateTimeFormat(CLINICAL_LOCALE, {
    /*
     * `numeric` under 12-hour, `2-digit` under 24. An appointment card reads
     * "4:40 pm", never "04:40 pm" — but a 24-hour column has to stay a column,
     * and "9:05" next to "16:40" does not line up even in tabular figures.
     */
    hour: timeFormat === '12H' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: timeFormat === '12H',
    timeZone,
  }).format(new Date(value));
}

/** `9 Aug 2026`. */
export function formatClinicDate(value: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat(CLINICAL_LOCALE, {
    dateStyle: 'medium',
    timeZone,
  }).format(new Date(value));
}

/** `9 Aug 2026, 4:40 pm`. The full stamp, for a heading or an audit row. */
export function formatClinicDateTime(
  value: string | Date,
  timeZone: string,
  timeFormat: TimeFormat = DEFAULT_TIME_FORMAT
): string {
  return `${formatClinicDate(value, timeZone)}, ${formatClinicTime(value, timeZone, timeFormat)}`;
}

// ---------------------------------------------------------------------------
// Clinical time, the other way round: a control's value (CE-8)
// ---------------------------------------------------------------------------

/**
 * ⚠️ EVERYTHING ABOVE TURNS AN INSTANT INTO WORDS. THESE TWO TURN A CONTROL'S
 *   WALL CLOCK INTO AN INSTANT AND BACK, and they exist because
 *   `<input type="datetime-local">` has no zone at all: it reads and writes
 *   `2026-08-16T14:30`, which is 14:30 wherever whoever reads it next happens to
 *   be. Storing that in a clinical answer is the same five-and-a-half-hour bug
 *   the header of this file describes, one layer down — invisible, because the
 *   string looks exactly like a time.
 *
 *   So a DATETIME answer is stored as an ISO instant with a `Z` (invariant 6),
 *   the control is fed the branch's wall clock, and `@rcln/clinical` refuses to
 *   let a zoneless string be signed into a record.
 *
 * ⚠️ THE ZONE IS THE BRANCH'S AND IS ALWAYS PASSED IN, exactly as above. There
 *   is no correct default.
 */

/** How far the zone is from UTC AT THAT INSTANT — DST included, by construction. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat(CLINICAL_LOCALE, {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    /* `hour12: false` renders midnight as 24 in some engines. */
    read('hour') % 24,
    read('minute'),
    read('second')
  );
  return asUtc - instant.getTime();
}

/**
 * `2026-08-16T14:30` in the clinic's zone → `2026-08-16T09:00:00.000Z`.
 *
 * ⚠️ THE OFFSET IS APPLIED TWICE, AND THE SECOND PASS IS THE DST CORRECTION. The
 *   first uses the offset at the wrong instant — the wall clock read as if it
 *   were UTC — which lands an hour out for the two nights a year a zone shifts.
 *   Re-reading the offset at the answer and re-applying it converges.
 */
export function clinicInstantOf(local: string, timeZone: string): string | undefined {
  /* Minutes only, because `datetime-local` with no `step` offers no seconds —
     and `clinicInputValueOf` truncates there too, so the round trip is exact. */
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (match === null) return undefined;
  const naive = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}:${match[3] ?? ''}:00Z`);
  if (Number.isNaN(naive)) return undefined;

  const once = naive - offsetMsAt(new Date(naive), timeZone);
  const twice = naive - offsetMsAt(new Date(once), timeZone);
  return new Date(twice).toISOString();
}

/**
 * `2026-08-16T09:00:00.000Z` → `2026-08-16T14:30`, for the control to render.
 *
 * ⚠️ A ZONELESS VALUE RENDERS AS BLANK, AND THE `Z` TEST IS WHY THIS FUNCTION
 *   CANNOT JUST TRY `new Date`. Per the ECMAScript spec a date-time string with
 *   no offset is parsed as BROWSER-LOCAL rather than as `NaN` — so an answer
 *   stored before the engine required an instant would not fail the guard
 *   below; it would render shifted by the browser-to-branch delta, plausibly,
 *   and a doctor who then re-saved would write that shift back as fact.
 *
 *   Blank is the honest rendering of a value that names no moment. The engine
 *   refuses it at the signature (`isInstant`), so the field is re-entered by
 *   somebody who knows what it was meant to say.
 */
export function clinicInputValueOf(iso: string, timeZone: string): string {
  if (!iso.endsWith('Z')) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const shifted = new Date(instant.getTime() + offsetMsAt(instant, timeZone));
  return shifted.toISOString().slice(0, 16);
}

/**
 * A count, formatted the same on both sides.
 *
 * `Number.toLocaleString()` with no argument has exactly the same problem as the
 * date functions above — `50000` is `50,000` in `en-US` and `50 000` in `fr-FR`.
 */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(BILLING_LOCALE).format(value);
}
