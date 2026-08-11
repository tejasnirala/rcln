/**
 * Quantity, in thousandths, as an integer.
 *
 * ⚠️ THE SAME ARGUMENT AS `Money`, FOR THE SAME REASON — AND IT IS NOT
 *   THEORETICAL HERE. `invoice_items.quantity` is `Decimal(14,3)` because half a
 *   tablet is real and so is 0.5 hours of physiotherapy. A JS float can hold 0.5
 *   exactly and cannot hold 0.001: `0.1 + 0.2` is famously not `0.3`, and
 *   `unitPrice * 1.15` on a float unit price is how a line comes out a paisa
 *   short of the sum of its parts. So this package multiplies by an integer
 *   count of thousandths and divides once, inside `scaleMoney`, which multiplies
 *   before it divides and never leaves integer arithmetic.
 *
 * The parse mirrors `fromMajor` in `@rcln/payments` on purpose: a value with
 * more than three decimal places THROWS rather than being quietly truncated. A
 * silently dropped digit on a dispensed quantity is a discrepancy between what
 * the pharmacy counted and what the patient was charged, discovered by neither.
 */
import { InvoicePricingError } from './errors.js';

/** `Decimal(14,3)` — the scale the column is declared at. */
export const QUANTITY_SCALE = 1000;

/**
 * `"1.5"` -> `1500`. Accepts the string Prisma's `Decimal` stringifies to, and a
 * number for the hand-written case.
 */
export function parseQuantity(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(3) : value.trim();

  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new InvoicePricingError(`quantity must be a non-negative decimal, got "${text}"`);
  }

  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > 3) {
    throw new InvoicePricingError(`quantity "${text}" has more than three decimal places`);
  }

  const milli = Number(whole) * QUANTITY_SCALE + Number(fraction.padEnd(3, '0') || '0');
  if (!Number.isSafeInteger(milli)) {
    throw new InvoicePricingError(`quantity "${text}" is out of range`);
  }
  return milli;
}

/** `1500` -> `"1.500"`, for the `Decimal(14,3)` column and for the printed line. */
export function formatQuantity(milli: number): string {
  const whole = Math.floor(milli / QUANTITY_SCALE);
  const fraction = milli % QUANTITY_SCALE;
  return `${String(whole)}.${String(fraction).padStart(3, '0')}`;
}
