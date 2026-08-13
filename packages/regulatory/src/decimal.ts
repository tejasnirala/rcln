/**
 * Comparing two quantities exactly, with no floating point anywhere.
 *
 * A quantity limit is the one rule type in this package that does arithmetic,
 * and it does it on `Decimal(18,6)` values that arrive as strings. `Number("0.1")
 * + Number("0.2") > Number("0.3")` is `true`, and a dispensing limit that is
 * wrong once in a thousand comparisons is worse than one that is wrong always:
 * nobody finds it, and when they do it is at a controlled-substance
 * reconciliation.
 *
 * ⚠️ WHY THIS IS NOT `compareQuantities` FROM `@rcln/inventory`, WHICH DOES
 *   EXACTLY THIS. That package depends on `@rcln/db`, and PI-ADR-007 says this
 *   one holds no Prisma client and reads no database — importing it would pull
 *   the client into the package whose entire value is that it can be tested with
 *   nothing but a fixture. The same trade `costing.ts` recorded when it declined
 *   to reuse `apportion()` from `@rcln/invoicing`.
 *
 *   The duplication is nine lines and it is bounded: this compares, and that is
 *   all it will ever do. Anything that needs to CONVERT between units belongs on
 *   the caller's side of the seam, which already has the unit graph.
 */

/** Digits, optionally signed, optionally with a decimal part. Nothing else. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * The widest fractional part this module handles, matching `Decimal(18,6)`'s
 * column with room to spare.
 *
 * ⚠️ IT IS ENFORCED BY `isDecimal`, AND THAT IS THE POINT. Previously
 *   `isDecimal` accepted any number of decimal places while `compareDecimals`
 *   threw above eighteen — so a rule written with nineteen passed validation,
 *   was stored, and then failed at EVERY evaluation with "the quantities
 *   supplied are not decimal values". The quantities were fine; the rule was at
 *   fault, and the message pointed at the wrong party while the rule sat
 *   permanently inert and apparently configured.
 */
const MAX_SCALE = 18;

/**
 * `-1`, `0` or `1`, comparing two decimal strings exactly.
 *
 * Throws on a value that is not a decimal, rather than coercing it. A rule whose
 * parameter is `"ten"` is a broken rule, and the engine turns that into
 * `UNDETERMINED` — which refuses — instead of comparing against `NaN`, which
 * permits everything silently.
 */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const left = toScaledBigInt(a);
  const right = toScaledBigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Exact addition of two decimal strings, at the wider of the two scales. */
export function addDecimals(a: string, b: string): string {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const factor = 10n ** BigInt(scale);
  const sum = toScaledBigInt(a, scale) + toScaledBigInt(b, scale);

  const negative = sum < 0n;
  const magnitude = negative ? -sum : sum;
  const whole = magnitude / factor;
  const fraction = magnitude % factor;

  const sign = negative ? '-' : '';
  if (scale === 0) return `${sign}${whole.toString()}`;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(scale, '0')}`;
}

export function isDecimal(value: string): boolean {
  const match = DECIMAL.exec(value.trim());
  if (!match) return false;
  return (match[3] ?? '').length <= MAX_SCALE;
}

function scaleOf(value: string): number {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a decimal quantity`);
  return (match[3] ?? '').length;
}

/**
 * The value as an integer at a common scale. Both operands are scaled to the
 * SAME power of ten before comparison, so `1.5` and `1.500000` compare equal —
 * the ledger writes the second and a rule's parameter is written the first way.
 */
function toScaledBigInt(value: string, scale?: number): bigint {
  const text = value.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`"${value}" is not a decimal quantity`);

  const [, sign = '', whole = '0', fraction = ''] = match;
  const target = scale ?? MAX_SCALE;
  if (fraction.length > target) {
    // Only reachable when a caller asks for a narrower scale than the value
    // carries. Truncating here would silently round a quantity, so it does not.
    throw new Error(`"${value}" has more decimal places than the requested scale`);
  }

  const digits = `${whole}${fraction.padEnd(target, '0')}`;
  return BigInt(digits) * (sign === '-' ? -1n : 1n);
}
