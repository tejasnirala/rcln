import { VITAL_RANGES, recordVitalsRequest, vitalRangeMessage } from '@rcln/contracts';
import type { VitalKey } from '@rcln/contracts';

/**
 * The bounds on a set of observations.
 *
 * ⚠️ THESE ARE SURVIVABILITY BOUNDS, NOT NORMALITY BOUNDS. A pulse of 38 and a
 *   saturation of 62 are both alarming, both real, and both must go in — a form
 *   that refuses them is a form that loses the observation that mattered, and the
 *   nurse writes it on paper instead. Every bound exists to catch a TYPO. The
 *   "admits" cases below are the ones that would break if somebody tightened a
 *   range because a value "looked wrong"; they are the point of this file as
 *   much as the rejections are.
 */
describe('vital ranges', () => {
  const keys = Object.keys(VITAL_RANGES) as VitalKey[];

  /**
   * One reading, isolating `key` at `value`.
   *
   * ⚠️ THE TWO HALVES OF A BLOOD PRESSURE CANNOT BE TESTED ALONE. The contract
   *   refuses half a blood pressure, and separately refuses a systolic that is
   *   not above its diastolic — so a bare `{ systolicMmHg: 40 }` fails for
   *   reasons that have nothing to do with the range under test, and every case
   *   here would pass or fail for the wrong one. The partner is supplied at a
   *   value that keeps both refinements satisfied across the whole range.
   */
  function reading(key: VitalKey, value: number): Record<string, number> {
    if (key === 'systolicMmHg') return { systolicMmHg: value, diastolicMmHg: 20 };
    if (key === 'diastolicMmHg') return { systolicMmHg: 300, diastolicMmHg: value };
    return { [key]: value };
  }

  describe('the contract refuses what no living patient produces', () => {
    /*
     * The complaint this was written for: every box accepted a negative number
     * on the way in. They never reached the database — the contract already
     * refused them — but nothing said so until after a round trip.
     */
    it.each(keys)('refuses a negative %s', (key) => {
      const result = recordVitalsRequest.safeParse(reading(key, -5));
      expect(result.success).toBe(false);
    });

    it.each(keys)('refuses a zero %s', (key) => {
      // Zero is below every minimum in the table, and it is what an empty box
      // used to become before `measurement()` learned to send nothing instead.
      const result = recordVitalsRequest.safeParse(reading(key, 0));
      expect(result.success).toBe(false);
    });

    it.each(keys)('refuses a %s one step below its minimum', (key) => {
      const range = VITAL_RANGES[key];
      const result = recordVitalsRequest.safeParse(reading(key, range.min - range.step));
      expect(result.success).toBe(false);
    });

    it.each(keys)('refuses a %s one step above its maximum', (key) => {
      const range = VITAL_RANGES[key];
      const result = recordVitalsRequest.safeParse(reading(key, range.max + range.step));
      expect(result.success).toBe(false);
    });

    it.each(keys)('accepts a %s at either end of its range', (key) => {
      const range = VITAL_RANGES[key];
      expect(recordVitalsRequest.safeParse(reading(key, range.min)).success).toBe(true);
      expect(recordVitalsRequest.safeParse(reading(key, range.max)).success).toBe(true);
    });

    /* A whole-number measurement is a whole number: 72.5 breaths a minute is a
       value somebody typed into the wrong box. */
    it.each(keys.filter((key) => VITAL_RANGES[key].step === 1))(
      'refuses a fractional %s',
      (key) => {
        const range = VITAL_RANGES[key];
        const result = recordVitalsRequest.safeParse(reading(key, range.min + 0.5));
        expect(result.success).toBe(false);
      }
    );
  });

  describe('the readings a clinic actually sees', () => {
    /*
     * ⚠️ EVERY ONE OF THESE IS ABNORMAL AND EVERY ONE MUST GO IN. This is the
     *   guard against somebody "tidying up" a range into a normality check.
     */
    it.each([
      ['a bradycardia', { pulseBpm: 38 }],
      ['a tachycardia', { pulseBpm: 190 }],
      ['a hypotensive pressure', { systolicMmHg: 70, diastolicMmHg: 40 }],
      ['a hypertensive crisis', { systolicMmHg: 220, diastolicMmHg: 130 }],
      ['a dangerous saturation', { spo2Percent: 62 }],
      ['a hypothermic patient', { temperatureC: 32 }],
      ['a high fever', { temperatureC: 41.5 }],
      ['a newborn', { weightKg: 2.6, heightCm: 48 }],
      ['a diabetic emergency', { bloodGlucoseMgDl: 480 }],
    ])('records %s', (_label, reading) => {
      expect(recordVitalsRequest.safeParse(reading).success).toBe(true);
    });
  });

  describe('what the clinician is told', () => {
    /*
     * Zod's own text is "Too small: expected number to be >=20", which on a form
     * with nine boxes does not say what is too small, what it should be, or what
     * to do about it.
     */
    it('names the measurement, both numbers and the unit', () => {
      const result = recordVitalsRequest.safeParse({ pulseBpm: 900 });
      expect(result.success).toBe(false);
      if (result.success) return;

      const message = result.error.issues[0]?.message ?? '';
      expect(message).toBe('A pulse is between 20 and 300 bpm. Check the reading.');
      expect(message).not.toContain('expected number');
    });

    it('puts no space before a percent or a degree sign', () => {
      expect(vitalRangeMessage(VITAL_RANGES.spo2Percent)).toContain('100%.');
      expect(vitalRangeMessage(VITAL_RANGES.temperatureC)).toContain('45°C.');
      expect(vitalRangeMessage(VITAL_RANGES.pulseBpm)).toContain('300 bpm.');
    });

    it('points the error at the field that caused it', () => {
      const result = recordVitalsRequest.safeParse({ spo2Percent: 900 });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.path).toEqual(['spo2Percent']);
    });
  });

  describe('the table itself', () => {
    it('has a minimum below its maximum, and a positive step, for every entry', () => {
      for (const key of keys) {
        const range = VITAL_RANGES[key];
        expect(range.min).toBeLessThan(range.max);
        expect(range.step).toBeGreaterThan(0);
        // Nothing measured here can be zero or negative in any unit.
        expect(range.min).toBeGreaterThan(0);
      }
    });
  });
});
