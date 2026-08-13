/**
 * The arithmetic, on its own, because a quantity limit that is wrong once in a
 * thousand comparisons is worse than one that is wrong always: nobody finds it,
 * and when they do it is at a controlled-substance reconciliation.
 */
import { addDecimals, compareDecimals, isDecimal } from '../src/decimal.js';

describe('compareDecimals', () => {
  it('compares across scales, which is the case the ledger actually produces', () => {
    // The ledger writes Decimal(18,6); a rule's parameter is written by a human.
    expect(compareDecimals('30', '30.000000')).toBe(0);
    expect(compareDecimals('30.000001', '30')).toBe(1);
    expect(compareDecimals('29.999999', '30')).toBe(-1);
  });

  it('is exact where a float is not', () => {
    // Number('0.1') + Number('0.2') > Number('0.3') is true. This is not.
    expect(compareDecimals(addDecimals('0.1', '0.2'), '0.3')).toBe(0);
  });

  it('handles quantities far beyond a safe integer', () => {
    expect(compareDecimals('9007199254740993', '9007199254740992')).toBe(1);
  });

  it('throws rather than coercing a value that is not a decimal', () => {
    expect(() => compareDecimals('ten', '10')).toThrow();
    expect(isDecimal('ten')).toBe(false);
  });

  it('compares negatives, in both directions and against zero', () => {
    expect(compareDecimals('-1', '1')).toBe(-1);
    expect(compareDecimals('-1.5', '-1.4')).toBe(-1);
    expect(compareDecimals('-0.000001', '0')).toBe(-1);
    expect(compareDecimals('-0', '0')).toBe(0);
  });

  it('rejects a value it could not compare, rather than accepting it and throwing later', () => {
    /*
     * ⚠️ THE TWO USED TO DISAGREE. `isDecimal` accepted nineteen decimal places
     *   and `compareDecimals` threw on them, so a rule written that way passed
     *   validation, stored, and then failed at every evaluation with a message
     *   blaming the caller's quantities. Inert, and apparently configured.
     */
    const nineteen = '0.1234567890123456789';
    expect(isDecimal(nineteen)).toBe(false);
    expect(isDecimal('0.123456789012345678')).toBe(true);
    expect(() => compareDecimals('0.123456789012345678', '1')).not.toThrow();
  });
});

describe('addDecimals', () => {
  it('adds at the wider of the two scales', () => {
    expect(addDecimals('40', '30')).toBe('70');
    expect(addDecimals('40.5', '29.500000')).toBe('70.000000');
  });

  it('does not drift over a long run of awkward values', () => {
    let total = '0';
    for (let i = 0; i < 1000; i += 1) total = addDecimals(total, '0.001');
    expect(compareDecimals(total, '1')).toBe(0);
  });
});
