/**
 * Weight-based dosing (PI-11).
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE ARITHMETIC ONES, AND THEY ARE FIRST.
 *   Every other test here would pass against a `number`-based implementation
 *   that is wrong once in a thousand doses — which is the worst kind of wrong,
 *   because nobody finds it and when they do it is at a bedside. `0.1 + 0.2` and
 *   the cap-by-a-thousandth cases are the ones that would not.
 *
 * No drug appears in this file, and none may. The package holds no formulary and
 * originates no mg/kg figure — see the header of `src/dosing.ts`.
 */
import { weightBasedDose, type DoseRequest } from '../src/dosing.js';

const ok = (request: DoseRequest) => {
  const result = weightBasedDose(request);
  if (!result.ok) throw new Error(`expected a dose, got: ${result.problem}`);
  return result.value;
};

const problem = (request: DoseRequest): string => {
  const result = weightBasedDose(request);
  if (result.ok) throw new Error('expected a refusal');
  return result.problem;
};

describe('exactness', () => {
  it('multiplies a weight by a rate without floating point drift', () => {
    /*
     * `0.1 * 3` is `0.30000000000000004` in IEEE 754. The whole reason this
     * module holds integer rationals is that the same class of error, compounded
     * over a cap comparison, silently exceeds a stated maximum.
     */
    expect(ok({ weightKg: '0.1', dosePerKg: '3' }).singleDose).toBe('0.300');
    expect(ok({ weightKg: '3.2', dosePerKg: '0.1' }).singleDose).toBe('0.320');
  });

  it('reports rounding rather than hiding it', () => {
    const third = ok({ weightKg: '1', dosePerKg: '0.333334' });
    expect(third.singleDose).toBe('0.333');
    expect(third.exact).toBe(false);

    expect(ok({ weightKg: '18.4', dosePerKg: '15' }).exact).toBe(true);
  });

  /**
   * ⚠️ THE ONE PLACE IN THE CODEBASE THAT ROUNDS DOWN RATHER THAN HALF-UP, AND
   *   THE ASYMMETRY IS THE POINT. `@rcln/inventory` rounds a stock conversion
   *   half-up because a count that is systematically low is its own kind of
   *   wrong. Rounding a dose up past a maximum is an overdose; rounding down is
   *   a marginally weak dose. The two errors are not comparable.
   */
  it('rounds down, never up', () => {
    expect(ok({ weightKg: '1', dosePerKg: '0.9999' }).singleDose).toBe('0.999');
  });

  /**
   * ⚠️ THE PAIR ALWAYS MULTIPLIES, AND THAT BEATS REPORTING A MORE PRECISE DAILY
   *   TOTAL (PI-11 review). This previously derived the daily figure from the
   *   exact value and asserted `0.000` a dose beside `0.001` a day — two numbers
   *   that contradict each other, which is precisely what this file's header
   *   argues against.
   *
   *   Giving `0.000` three times is `0.000`. That is the honest answer, and
   *   `exact: false` is how the caller learns the dose is too small to express at
   *   this scale — which is a unit problem (mcg, not mg), not a rounding one.
   */
  it('reports a daily total that is the printed dose times the frequency', () => {
    const tiny = ok({ weightKg: '1', dosePerKg: '0.0005', dosesPerDay: 3 });
    expect(tiny.singleDose).toBe('0.000');
    expect(tiny.dailyDose).toBe('0.000');
    expect(tiny.exact).toBe(false);
  });

  /**
   * The property, stated once and checked across the awkward cases: whatever
   * else is true, three times the printed dose IS the printed daily total.
   */
  it.each([
    ['18.4', '15', 3],
    ['3.2', '0.1', 4],
    ['40', '15', 3],
    ['1', '0.333334', 2],
    ['0.1', '3', 1],
  ])('single × frequency equals the daily total (%s kg, %s/kg, %i a day)', (w, r, n) => {
    const dose = ok({ weightKg: w, dosePerKg: r, dosesPerDay: n as number });
    const single = Number(dose.singleDose);
    const daily = Number(dose.dailyDose);
    /* Compared as numbers only because the assertion is about agreement, not
       about precision — the strings are what the product carries. */
    expect(daily).toBeCloseTo(single * (n as number), 3);
  });
});

describe('ceilings', () => {
  it('holds the dose to a stated single maximum', () => {
    const dose = ok({ weightKg: '40', dosePerKg: '15', maxSingleDose: '500' });
    expect(dose.singleDose).toBe('500.000');
    expect(dose.cappedBy).toBe('SINGLE');
  });

  /**
   * ⚠️ THE PAIR ALWAYS MULTIPLIES, AND THIS IS THE TEST THAT SAYS SO. The obvious
   *   implementation computes the single dose, multiplies it out and clamps the
   *   daily figure — returning "220 mg, three times a day, 500 mg daily", which
   *   is two instructions that contradict each other. Dividing the daily cap by
   *   the frequency answers the question actually asked: how much each time.
   */
  it('reduces the single dose when a daily ceiling binds', () => {
    const dose = ok({ weightKg: '40', dosePerKg: '15', dosesPerDay: 3, maxDailyDose: '500' });
    expect(dose.singleDose).toBe('166.666');
    /*
     * ⚠️ `499.998`, NOT `500.000`, AND THAT IS THE POINT (PI-11 review). The
     *   ceiling is 500 and the printed dose is what will actually be given three
     *   times — so the day's real total is 499.998. Reporting the cap itself here
     *   would put two figures on the screen that do not agree, and would overstate
     *   what the animal receives.
     */
    expect(dose.dailyDose).toBe('499.998');
    expect(dose.cappedBy).toBe('DAILY');
    /* Still under the stated ceiling, which is the direction that matters. */
    expect(Number(dose.dailyDose)).toBeLessThanOrEqual(500);
  });

  it('names the ceiling that actually bound when both are stated', () => {
    /* Uncapped: 600. Single cap 500, daily cap 900 over 3 doses = 300 each. */
    const dose = ok({
      weightKg: '40',
      dosePerKg: '15',
      dosesPerDay: 3,
      maxSingleDose: '500',
      maxDailyDose: '900',
    });
    expect(dose.singleDose).toBe('300.000');
    expect(dose.cappedBy).toBe('DAILY');
  });

  it('reports no cap when neither binds', () => {
    const dose = ok({ weightKg: '18.4', dosePerKg: '15', dosesPerDay: 3, maxDailyDose: '5000' });
    expect(dose.singleDose).toBe('276.000');
    expect(dose.dailyDose).toBe('828.000');
    expect(dose.exact).toBe(true);
    expect(dose.cappedBy).toBeNull();
  });

  /**
   * ⚠️ THE CAP IS APPLIED TO THE EXACT VALUE, BEFORE ROUNDING. Applying it after
   *   would let a dose that truncated upward escape the ceiling by a thousandth
   *   — impossible today, and one edit to `toDecimal` away from being possible.
   */
  it('never returns more than the stated maximum', () => {
    expect(ok({ weightKg: '1', dosePerKg: '1000.9999', maxSingleDose: '1000' }).singleDose).toBe(
      '1000.000'
    );
  });
});

describe('what it refuses', () => {
  it('refuses a weight of zero rather than answering zero', () => {
    expect(problem({ weightKg: '0', dosePerKg: '15' })).toMatch(/weight is zero/i);
  });

  it.each([['-3'], ['three'], ['3.2.1'], ['']])('refuses %p as a weight', (weightKg) => {
    expect(problem({ weightKg, dosePerKg: '15' })).toMatch(/weight/i);
  });

  /**
   * ⚠️ SIX DECIMALS, THE *SCALE* OF `Decimal(18,6)` — the constant used to read
   *   18, its PRECISION, under a comment claiming it matched the column (PI-11
   *   review). Seven is refused, which is also where the HTTP contract's
   *   `doseAmount` caps.
   */
  it('refuses more decimal places than a column could hold', () => {
    expect(problem({ weightKg: '1', dosePerKg: '0.3333335' })).toMatch(/decimal places/i);
    expect(ok({ weightKg: '1', dosePerKg: '0.333333' }).singleDose).toBe('0.333');
  });

  /**
   * ⚠️ A STATED CAP THAT NOTHING CAN EVALUATE IS AN ERROR, NOT A CAP QUIETLY
   *   IGNORED. The caller said there is a daily limit; answering without applying
   *   it returns a number that looks checked and is not. The same discipline
   *   `@rcln/regulatory`'s `parameters.ts` applies to a rule that says nothing.
   */
  it('refuses a daily maximum with no frequency to apply it over', () => {
    expect(problem({ weightKg: '18.4', dosePerKg: '15', maxDailyDose: '500' })).toMatch(
      /how many doses a day/i
    );
  });

  it.each([[0], [-1], [1.5]])('refuses %p doses a day', (dosesPerDay) => {
    expect(problem({ weightKg: '18.4', dosePerKg: '15', dosesPerDay })).toMatch(/whole number/i);
  });

  it('leaves the daily total null when no frequency was asked for', () => {
    expect(ok({ weightKg: '18.4', dosePerKg: '15' }).dailyDose).toBeNull();
  });
});
