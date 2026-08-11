import {
  VITAL_RANGES,
  fromCelsius,
  temperatureRangeFor,
  temperatureUnitFor,
  toCelsius,
} from '@rcln/contracts';

/**
 * The one conversion in the product.
 *
 * ⚠️ THE ROUND TRIP IS THE POINT OF THIS FILE. A nurse types 99.4, it is stored
 *   in Celsius, and the chart redraws from what was stored — if those two
 *   numbers are not the same on screen, the record looks wrong to the person who
 *   wrote it, and no amount of being right to three decimal places helps. At one
 *   decimal place of Celsius (what the column held before) 99.4 came back as
 *   99.3, which is why `temperature_c` is now `Decimal(4, 2)`.
 */
describe('body temperature', () => {
  describe('which unit a country writes in', () => {
    it('is Fahrenheit across the subcontinent and the United States', () => {
      for (const code of ['IN', 'NP', 'LK', 'BD', 'US']) {
        expect(temperatureUnitFor(code)).toBe('F');
      }
    });

    it('is Celsius everywhere else in the table', () => {
      for (const code of ['GB', 'IE', 'AE', 'SG', 'AU']) {
        expect(temperatureUnitFor(code)).toBe('C');
      }
    });

    /*
     * Celsius is the STORAGE unit, so an unknown country falls back to the case
     * where entry and storage agree and no conversion can be got wrong.
     * Guessing Fahrenheit would silently multiply every reading.
     */
    it('falls back to Celsius for a country it does not know', () => {
      expect(temperatureUnitFor('ZZ')).toBe('C');
      expect(temperatureUnitFor(null)).toBe('C');
      expect(temperatureUnitFor(undefined)).toBe('C');
    });
  });

  describe('converting', () => {
    it('agrees with the two readings every clinician knows', () => {
      expect(toCelsius(98.6, 'F')).toBe(37);
      expect(fromCelsius(37, 'F')).toBe(98.6);
      expect(toCelsius(212, 'F')).toBe(100);
      expect(toCelsius(32, 'F')).toBe(0);
    });

    it('leaves a Celsius clinic alone entirely', () => {
      expect(toCelsius(37.4, 'C')).toBe(37.4);
      expect(fromCelsius(37.4, 'C')).toBe(37.4);
    });

    /*
     * Every tenth of a degree across the range a clinic actually sees, from a
     * cold patient to a dangerous fever. This is the test that fails if the
     * column is ever narrowed back to one decimal place.
     */
    it('returns exactly what was typed, to a tenth, right across the clinical range', () => {
      for (let tenths = 940; tenths <= 1080; tenths += 1) {
        const typed = tenths / 10;
        const stored = toCelsius(typed, 'F');
        expect(fromCelsius(stored, 'F')).toBeCloseTo(typed, 5);
      }
    });

    it('stores no more precision than the column holds', () => {
      for (let tenths = 940; tenths <= 1080; tenths += 1) {
        const stored = toCelsius(tenths / 10, 'F');
        // Two decimal places, which is what Decimal(4, 2) keeps.
        expect(Math.round(stored * 100)).toBe(stored * 100);
      }
    });
  });

  describe('the range offered to the form', () => {
    /*
     * The Celsius bounds are `recordVitalsRequest`'s and are the authority.
     * These are the same two numbers converted, so a form can reject a typo
     * while the clinician is still looking at the field rather than after a
     * round trip that complains about a Celsius value they never typed.
     */
    it('is the contract survivability bounds, in the unit being typed', () => {
      expect(temperatureRangeFor('C')).toMatchObject({ min: 25, max: 45, unit: '°C' });
      expect(temperatureRangeFor('F')).toMatchObject({ min: 77, max: 113, unit: '°F' });
    });

    /*
     * The Fahrenheit pair is DERIVED, never typed out twice — a second
     * hand-written pair is how a form ends up refusing a reading the API would
     * take. This asserts the derivation, not the numbers.
     */
    it('derives Fahrenheit from the Celsius bounds the API enforces', () => {
      const celsius = VITAL_RANGES.temperatureC;
      expect(temperatureRangeFor('F').min).toBe(fromCelsius(celsius.min, 'F'));
      expect(temperatureRangeFor('F').max).toBe(fromCelsius(celsius.max, 'F'));
    });

    it('admits every real reading and refuses an obvious transposition', () => {
      const range = temperatureRangeFor('F');
      expect(94).toBeGreaterThan(range.min);
      expect(107).toBeLessThan(range.max);
      // 199 for 99 — a stuck key, and the reason the check exists.
      expect(199).toBeGreaterThan(range.max);
    });
  });
});
