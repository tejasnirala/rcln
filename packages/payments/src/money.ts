/**
 * Money, in minor units, as integers.
 *
 * WHY NOT A DECIMAL, AND WHY NOT A FLOAT
 *   The database stores `numeric(14,2)` and Prisma hands back a `Decimal`. That
 *   is the right shape for a ledger. It is the wrong shape for a payment
 *   gateway: every provider on earth quotes in minor units (paise, cents, fils)
 *   or in a fixed-scale major string, and the conversion is where the money goes
 *   missing. `4999.995` is representable in `numeric` and not chargeable by
 *   anyone.
 *
 *   So this package speaks one language — an integer count of the currency's
 *   smallest unit — and converts at both boundaries, explicitly, in one place.
 *   Nothing here is ever a float. `Number` is used because a JS integer is exact
 *   to 2^53, which is ₹90 trillion in paise; a subscription invoice that large
 *   has other problems.
 *
 * ROUNDING IS A DECISION, NOT A DEFAULT
 *   Proration divides. Every division here takes an explicit rounding mode, and
 *   the caller states which way the customer should be favoured. Silent
 *   `Math.round` was the first version and it made a 30-day upgrade credit
 *   differ from the sum of its 30 daily parts.
 */

import { minorUnitExponent } from './currency.js';

/** An amount and the currency it is denominated in. Immutable. */
export interface Money {
  /** Integer count of the currency's smallest unit. 1999 INR-minor = ₹19.99. */
  readonly amountMinor: number;
  /** ISO 4217, uppercase. */
  readonly currency: string;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`amountMinor must be a safe integer, got ${String(amountMinor)}`);
  }
  return { amountMinor, currency: currency.toUpperCase() };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negateMoney(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function maxMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return a.amountMinor >= b.amountMinor ? a : b;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

export type Rounding = 'up' | 'down' | 'half-up';

/**
 * Multiply by a rational fraction without ever leaving integer arithmetic.
 *
 * Used for proration: `amount * elapsedDays / periodDays`. Written as one
 * operation rather than a multiply followed by a divide so the intermediate
 * never becomes a float — `(4999_00 * 17) / 30` is exact here and is not if the
 * division happens first.
 */
export function scaleMoney(
  amount: Money,
  numerator: number,
  denominator: number,
  rounding: Rounding = 'half-up'
): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError('scaleMoney takes integer numerator and denominator');
  }
  if (denominator === 0) throw new MoneyError('scaleMoney: denominator is zero');

  const product = amount.amountMinor * numerator;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError('scaleMoney overflowed the safe integer range');
  }

  return money(divideRounded(product, denominator, rounding), amount.currency);
}

/** Integer division with an explicit rounding mode, correct for negatives. */
export function divideRounded(numerator: number, denominator: number, rounding: Rounding): number {
  const quotient = numerator / denominator;
  switch (rounding) {
    case 'up':
      return Math.ceil(quotient);
    case 'down':
      return Math.floor(quotient);
    case 'half-up':
      // Away from zero at the midpoint, so -0.5 rounds to -1 rather than to 0.
      // `Math.round(-0.5)` is 0, which makes a credit and its reversal disagree.
      return Math.sign(quotient) * Math.round(Math.abs(quotient));
  }
}

/**
 * Minor units -> the decimal string a provider's JSON expects ("1499.00").
 *
 * A string, never a number: `order_amount: 1499.00` serialises as `1499` and at
 * least one provider has historically treated a missing scale as a different
 * amount. It also keeps zero-decimal currencies honest — JPY 1500 must be sent
 * as "1500", not "15.00".
 */
export function toMajorString(amount: Money): string {
  const exponent = minorUnitExponent(amount.currency);
  if (exponent === 0) return String(amount.amountMinor);

  const divisor = 10 ** exponent;
  const sign = amount.amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amount.amountMinor);
  const whole = Math.floor(absolute / divisor);
  const fraction = absolute % divisor;
  return `${sign}${String(whole)}.${String(fraction).padStart(exponent, '0')}`;
}

/**
 * The inverse, for reading a provider's response and for reading the `numeric`
 * columns Prisma hands back as `Decimal`.
 *
 * Accepts a string or a number because both arrive in practice; a number is
 * checked for having survived its own JSON round-trip. Anything with more
 * fractional digits than the currency has is a bug upstream and throws rather
 * than being quietly truncated — a silently dropped digit on a refund is a
 * customer-visible discrepancy nobody can explain later.
 */
export function fromMajor(value: string | number, currency: string): Money {
  const exponent = minorUnitExponent(currency);
  const text = typeof value === 'number' ? value.toFixed(exponent) : value.trim();

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError(`not a decimal amount: ${text}`);

  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new MoneyError(`${text} has more precision than ${currency} supports`);
  }

  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
  return money(sign === '-' ? -minor : minor, currency);
}

/**
 * Human-facing rendering. Server-side default locale on purpose — the caller
 * that knows the viewer's locale should pass it.
 */
export function formatMoney(amount: Money, locale = 'en'): string {
  const exponent = minorUnitExponent(amount.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amount.amountMinor / 10 ** exponent);
}
