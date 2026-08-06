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

/**
 * A count, formatted the same on both sides.
 *
 * `Number.toLocaleString()` with no argument has exactly the same problem as the
 * date functions above — `50000` is `50,000` in `en-US` and `50 000` in `fr-FR`.
 */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(BILLING_LOCALE).format(value);
}
