/**
 * The date helpers behind `effective_from` / `effective_to`.
 *
 * ⚠️ THESE EXIST BECAUSE THE SAME OFF-BY-ONE SHIPPED IN FOUR PLACES AT ONCE.
 *   `toCalendarDate` had three identical copies, and each one sat next to a
 *   comparison of the form `effectiveTo >= new Date()`. That compares a
 *   `@db.Date` column — which Prisma returns pinned to UTC midnight — against an
 *   instant, so a row valid THROUGH the 31st stopped being current at 00:00:00.001
 *   on the 31st. A full day early, every day, with nothing to show for it.
 *
 *   The failure is invisible in every way that matters: no error, no log, no
 *   count going to zero. One barcode stops scanning, one tax rate silently falls
 *   back to the previous one, and it is unreproducible by anyone who tries it
 *   the next morning. So the boundary is pinned here explicitly.
 */
import {
  calendarToday,
  isCurrentOn,
  startOfCalendarDay,
  toCalendarDate,
  decimalToString,
} from '../../src/services/product/values.js';

describe('calendar dates', () => {
  it('reads back the date that was stored, not a local rendering of it', () => {
    // How Prisma hands back a `@db.Date`: midnight UTC on the stored day.
    expect(toCalendarDate(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-12-31');
  });

  it('flattens an instant to its own UTC day', () => {
    expect(startOfCalendarDay(new Date('2026-12-31T09:14:22.512Z')).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z'
    );
  });

  it('gives today as a day, not as a moment', () => {
    const today = calendarToday();
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
    expect(today.getUTCMilliseconds()).toBe(0);
  });
});

describe('whether a validity window is still open', () => {
  const LAST_DAY = new Date('2026-12-31T00:00:00.000Z');

  it('is still current ON the final day, not just before it', () => {
    /*
     * THE REGRESSION. Under `effectiveTo >= new Date()` this was false from one
     * millisecond past midnight on the 31st, because the column is midnight and
     * "now" never is. The contract says `isCurrent` is false once `effectiveTo`
     * has PASSED — the 31st has not passed while it is still the 31st.
     */
    expect(isCurrentOn(LAST_DAY, new Date('2026-12-31T09:14:22.512Z'))).toBe(true);
  });

  it('is still current at the very last instant of the final day', () => {
    expect(isCurrentOn(LAST_DAY, new Date('2026-12-31T23:59:59.999Z'))).toBe(true);
  });

  it('is not current the next day', () => {
    expect(isCurrentOn(LAST_DAY, new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('is current well before the end', () => {
    expect(isCurrentOn(LAST_DAY, new Date('2026-06-01T12:00:00.000Z'))).toBe(true);
  });

  it('treats a null end date as open-ended', () => {
    expect(isCurrentOn(null, new Date('2099-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('decimal columns on the wire', () => {
  it('preserves every digit rather than going through a float', () => {
    /*
     * `Number('1234567890.123456')` loses the tail. Quantities are strings on
     * the wire for exactly this reason, so the helper must never be "improved"
     * into a numeric conversion.
     */
    const decimalLike = { toString: () => '1234567890.123456' };
    expect(decimalToString(decimalLike)).toBe('1234567890.123456');
  });

  it('passes null through', () => {
    expect(decimalToString(null)).toBeNull();
  });
});
