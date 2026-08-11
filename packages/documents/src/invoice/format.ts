/**
 * The document's formatters.
 *
 * ⚠️ EVERY LOCALE HERE IS PINNED, AND THAT IS THE ONLY REASON THE PREVIEW AND
 *   THE PRINT AGREE. This is `apps/web/src/lib/format.ts`'s rule applied to a
 *   harder case: that file only has to survive the same string being produced by
 *   a Node container and a browser, and this one has to survive it being
 *   produced by a Node container, a browser, and a headless Chromium in a third
 *   container in a fourth timezone. `Intl.DateTimeFormat(undefined, …)` means
 *   "whatever the runtime feels like", and the runtime is different in all
 *   three. `50000` is `50,000` in en-US and `50 000` in fr-FR; nothing throws.
 *
 * ⚠️ AND EVERY ZONE IS PASSED IN, NEVER DEFAULTED — invariant 6. The worker
 *   renders in a UTC container. A missing `timeZone` there does not fail, it
 *   prints the wrong day: 00:30 IST on 1 April is 19:00 UTC on 31 March, which
 *   is a different financial year on a document that states one.
 */

/*
 * The `/money` entry point, not the package root. The root re-exports the
 * gateway adapters, which import `node:crypto` — and this module is rendered
 * inside `apps/web`. That entry point's own header describes exactly this case.
 */
import { minorUnitExponent } from '@rcln/payments/money';

import type { InvoiceDocumentData } from './types.js';

/**
 * Dates, pinned exactly as `apps/web/src/lib/format.ts` pins them.
 *
 * `en-GB` for day-month-year, which is what India, the UK, Ireland, Australia
 * and the UAE all read, and which matches the British English the rest of the
 * interface is written in.
 */
const DATE_LOCALE = 'en-GB';

/**
 * Number grouping, which — unlike the date — is NOT one pinned locale.
 *
 * ⚠️ `12,34,567.00` IS NOT A TYPO, IT IS HOW INDIA WRITES MONEY. Digits group
 *   in lakhs and crores after the first three, and an Indian clinic's invoice
 *   showing `1,234,567.00` reads as foreign software the way `$` in place of `₹`
 *   would. Deriving the grouping from `countryCode` — which the snapshot already
 *   carries — keeps it deterministic in all three runtimes, which is the actual
 *   requirement; pinning ONE locale everywhere would satisfy determinism and get
 *   the largest market wrong.
 *
 *   Unlisted countries fall back to `en-GB`'s western grouping, which is right
 *   for most of the world and, importantly, is a decimal POINT — a locale whose
 *   decimal separator is a comma would print `1.234,50` beside a `numeric(14,2)`
 *   column that means something else entirely.
 */
const GROUPING_LOCALE: Readonly<Record<string, string>> = {
  IN: 'en-IN',
  US: 'en-US',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  SG: 'en-SG',
  AE: 'en-AE',
  GB: 'en-GB',
  IE: 'en-IE',
};

function groupingLocale(countryCode: string): string {
  return GROUPING_LOCALE[countryCode.toUpperCase()] ?? DATE_LOCALE;
}

/**
 * A formatter bound to one document.
 *
 * Built once and threaded through the template rather than being a set of free
 * functions each re-reading the currency and the zone. `Intl` constructors are
 * not cheap, an invoice has a formatter call per cell, and — more to the point —
 * a free function is one a component can call while forgetting to pass the zone.
 */
export interface InvoiceFormatter {
  /** `1,234.50`. Bare — the currency is stated once, in the column head. */
  amount: (minor: number) => string;
  /** `−1,234.50`, or `—` for zero. For a discount, which is always a subtraction. */
  deduction: (minor: number) => string;
  /** `₹` / `€` / `$`. Printed in the column head and beside the grand total. */
  currencySymbol: string;
  /** `9 Aug 2026`. */
  date: (iso: string) => string;
  /** `1`, `0.5`, `2.25` — trailing zeros of the `Decimal(14,3)` column dropped. */
  quantity: (value: string) => string;
  /** `6%`, `2.5%`, `9.975%`. */
  rate: (bps: number) => string;
}

export function createFormatter(data: InvoiceDocumentData): InvoiceFormatter {
  const exponent = minorUnitExponent(data.currency);
  const locale = groupingLocale(data.countryCode);
  const scale = 10 ** exponent;

  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    useGrouping: true,
  });

  const date = new Intl.DateTimeFormat(DATE_LOCALE, {
    dateStyle: 'medium',
    timeZone: data.timezone,
  });

  const amount = (minor: number): string => number.format(minor / scale);

  return {
    amount,
    deduction: (minor: number): string =>
      /*
       * A zero discount prints an em dash rather than `0.00`. A column of
       * zeroes is noise a reader has to scan past to find the one line that was
       * actually discounted; a column of dashes has the discount jump out of it.
       */
      minor === 0 ? '—' : `−${amount(Math.abs(minor))}`,
    currencySymbol: currencySymbolFor(locale, data.currency),
    date: (iso: string): string => date.format(new Date(iso)),
    quantity: formatQuantity,
    rate: formatRate,
  };
}

/**
 * `₹` rather than `INR`, when the locale has one.
 *
 * Pulled out of `formatToParts` rather than hard-coded, so a currency nobody
 * anticipated still prints something correct. ⚠️ This is the one string on the
 * invoice that made the font choice non-negotiable: ₹ is U+20B9, which is not
 * in WinAnsi and not in the `latin` subset — see `scripts/build-fonts.mjs`.
 */
function currencySymbolFor(locale: string, currency: string): string {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency;
}

/**
 * `1.000` → `1`, `0.500` → `0.5`, `2.250` → `2.25`.
 *
 * The column is `Decimal(14,3)` because half a tablet is real, and printing
 * `1.000` boxes of dressing on every line of every invoice is three digits of
 * noise for the one line in fifty that needs them. Purely presentational —
 * `@rcln/invoicing` still refuses a fourth decimal place at the input.
 */
export function formatQuantity(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/**
 * Basis points as a percentage, with no trailing zeros.
 *
 * ⚠️ THE RATE IS BASIS POINTS AND NOT A PERCENT BECAUSE QUEBEC'S QST IS 9.975%.
 *   A whole-number percent column would print it as 10% — a rate no authority
 *   levies, on a document a business claims input credit against.
 */
export function formatRate(bps: number): string {
  const percent = bps / 100;
  return `${String(Number(percent.toFixed(3)))}%`;
}
