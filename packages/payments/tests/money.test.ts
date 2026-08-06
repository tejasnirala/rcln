import {
  addMoney,
  divideRounded,
  formatMoney,
  fromMajor,
  money,
  MoneyError,
  scaleMoney,
  subtractMoney,
  toMajorString,
} from '../src/money.js';
import { currencyForCountry, isBillingCurrency, minorUnitExponent } from '../src/currency.js';

describe('minor units', () => {
  it('defaults to two decimal places', () => {
    expect(minorUnitExponent('INR')).toBe(2);
    expect(minorUnitExponent('usd')).toBe(2);
  });

  it('knows the zero-decimal currencies', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KRW')).toBe(0);
  });

  it('knows the three-decimal currencies', () => {
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('BHD')).toBe(3);
  });
});

describe('toMajorString', () => {
  it('renders two-decimal currencies at full scale', () => {
    expect(toMajorString(money(149_900, 'INR'))).toBe('1499.00');
    expect(toMajorString(money(5, 'INR'))).toBe('0.05');
  });

  it('does not invent decimals for a zero-decimal currency', () => {
    // The factor-of-100 bug this guards: ¥1500 sent as "1500.00" bills ¥150,000
    // to a provider reading minor units.
    expect(toMajorString(money(1500, 'JPY'))).toBe('1500');
  });

  it('uses three places for a three-decimal currency', () => {
    expect(toMajorString(money(1234, 'KWD'))).toBe('1.234');
  });

  it('keeps the sign on a credit', () => {
    expect(toMajorString(money(-2550, 'USD'))).toBe('-25.50');
  });
});

describe('fromMajor', () => {
  it('round-trips through toMajorString', () => {
    for (const [minor, currency] of [
      [149_900, 'INR'],
      [1500, 'JPY'],
      [1234, 'KWD'],
      [-2550, 'USD'],
    ] as const) {
      expect(fromMajor(toMajorString(money(minor, currency)), currency).amountMinor).toBe(minor);
    }
  });

  it('accepts a value with no fractional part', () => {
    expect(fromMajor('1499', 'INR').amountMinor).toBe(149_900);
  });

  it('refuses more precision than the currency has', () => {
    // Truncating here would silently lose money on a refund.
    expect(() => fromMajor('19.999', 'USD')).toThrow(MoneyError);
  });

  it('refuses something that is not a number', () => {
    expect(() => fromMajor('1,499.00', 'INR')).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within one currency', () => {
    expect(addMoney(money(100, 'INR'), money(250, 'INR')).amountMinor).toBe(350);
    expect(subtractMoney(money(100, 'INR'), money(250, 'INR')).amountMinor).toBe(-150);
  });

  it('refuses to mix currencies', () => {
    expect(() => addMoney(money(100, 'INR'), money(100, 'USD'))).toThrow(MoneyError);
  });

  it('refuses a non-integer amount', () => {
    expect(() => money(10.5, 'INR')).toThrow(MoneyError);
  });
});

describe('scaleMoney', () => {
  it('prorates exactly, without a float in the middle', () => {
    // 17 of 30 days of ₹4999.
    expect(scaleMoney(money(499_900, 'INR'), 17, 30).amountMinor).toBe(283_277);
  });

  it('rounds half away from zero for a credit as well as a charge', () => {
    expect(scaleMoney(money(5, 'INR'), 1, 2, 'half-up').amountMinor).toBe(3);
    expect(scaleMoney(money(-5, 'INR'), 1, 2, 'half-up').amountMinor).toBe(-3);
  });

  it('honours an explicit direction', () => {
    expect(scaleMoney(money(5, 'INR'), 1, 2, 'down').amountMinor).toBe(2);
    expect(scaleMoney(money(5, 'INR'), 1, 2, 'up').amountMinor).toBe(3);
  });

  it('refuses a zero denominator rather than returning Infinity', () => {
    expect(() => scaleMoney(money(100, 'INR'), 1, 0)).toThrow(MoneyError);
  });
});

describe('divideRounded', () => {
  it('rounds -0.5 away from zero, unlike Math.round', () => {
    expect(Math.round(-0.5)).toBe(-0);
    expect(divideRounded(-1, 2, 'half-up')).toBe(-1);
  });
});

describe('formatMoney', () => {
  it('renders the currency at its own scale', () => {
    expect(formatMoney(money(149_900, 'INR'), 'en-IN')).toContain('1,499.00');
    expect(formatMoney(money(1500, 'JPY'), 'en')).not.toContain('.');
  });
});

describe('currencyForCountry', () => {
  it('gives a country its own currency when we price in it', () => {
    expect(currencyForCountry('IN')).toBe('INR');
    expect(currencyForCountry('de')).toBe('EUR');
    expect(currencyForCountry('AE')).toBe('AED');
  });

  it('falls back rather than guessing a currency we cannot charge', () => {
    expect(currencyForCountry('BR')).toBe('USD');
    expect(currencyForCountry(null)).toBe('USD');
  });

  it('respects what the plan is actually priced in', () => {
    // A German clinic on a plan with no EUR price must not be quoted EUR.
    expect(currencyForCountry('DE', ['INR', 'USD'])).toBe('USD');
    expect(currencyForCountry('DE', ['INR'])).toBe('INR');
  });

  it('recognises its own catalogue', () => {
    expect(isBillingCurrency('inr')).toBe(true);
    expect(isBillingCurrency('BRL')).toBe(false);
  });
});
