/**
 * Weight-based dosing (PI-11). Pure — no Prisma, no tenant, no clock, no
 * country, no species.
 *
 * `animal_profiles.weight_kg` has carried the schema comment "a dose is
 * calculated from it" since CE-1 and nothing ever calculated one. This is that
 * calculation, and it lives here rather than in `apps/api` for the reason
 * `validate.ts` does: it is arithmetic that is wrong in a way no integration
 * test notices, so it is unit-tested with fixtures instead of with a database.
 *
 * ── WHAT THIS IS AND, MUCH MORE IMPORTANTLY, WHAT IT IS NOT ─────────────────
 *
 * ⚠️ IT IS A CALCULATOR, NOT A DRUG REFERENCE. It multiplies a weight by a rate
 *   the CALLER supplied and applies caps the CALLER supplied. It knows no
 *   medicine, holds no formulary, and has no opinion about whether 15 mg/kg of
 *   anything is a sensible thing to give a cat. Every number in `DoseRequest`
 *   comes from a clinician reading a label; nothing here originates one.
 *
 *   That boundary is deliberate and it is the same one `@rcln/regulatory` draws.
 *   A module that shipped its own mg/kg figures would be a formulary maintained
 *   by whoever last edited a TypeScript file, and the failure mode is a wrong
 *   dose delivered with the authority of a computed number.
 *
 * ⚠️ AND IT IS NOT A PRESCRIPTION. Nothing here writes anything. The clinician
 *   reads the answer and decides; `encounter_prescriptions` is where a decision
 *   is recorded, behind `clinical.prescription.create`, which is DOCTOR's alone
 *   (invariant 7).
 *
 * ── WHY EXACT RATIONALS AND NOT `number` ────────────────────────────────────
 * The same argument `@rcln/inventory`'s `units.ts` makes about stock, with a
 * sharper edge on it. `0.1 + 0.2 === 0.30000000000000004`, and here the number
 * that comes out is not a shelf count but a quantity of drug given to a living
 * thing. A cap of exactly 500 mg must not be exceeded by 4e-14 mg because the
 * arithmetic drifted, and a 3.2 kg cat must produce the same answer on every
 * machine that computes it.
 *
 * So a weight and a rate are integer numerators over integer denominators held
 * in `bigint`, and the value is rounded exactly once, at the end, where the
 * caller can see it happen.
 *
 * ⚠️ ROUNDING IS DOWNWARD, NOT HALF-UP, AND THIS IS THE ONE PLACE IN THE
 *   CODEBASE WHERE THOSE DIFFER ON PURPOSE. `@rcln/inventory` rounds a
 *   conversion half-up because a stock count that is systematically low is its
 *   own kind of wrong. A dose is not symmetric: rounding up past a maximum is
 *   an overdose and rounding down is a marginally weak dose, so the two errors
 *   are not comparable and the safe direction is chosen rather than the accurate
 *   one. `exact` is false whenever anything was discarded, and a caller that
 *   must not lose a fraction reads it.
 */
import type { Parsed } from './types.js';

/**
 * Decimal places the answer is reported to.
 *
 * Three, matching `animal_profiles.weight_kg`'s own `Decimal(8,3)` — a milligram
 * when the caller is working in milligrams, a thousandth of a millilitre when
 * they are working in millilitres. The unit is the caller's; this module only
 * ever counts decimal places.
 */
export const DOSE_SCALE = 3;

/** Digits, optionally with a decimal part. No sign: nothing here may be negative. */
const UNSIGNED_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * The widest fractional part accepted on the way in.
 *
 * ⚠️ SIX, THE *SCALE* OF `Decimal(18,6)` — NOT EIGHTEEN, WHICH IS ITS PRECISION
 *   (PI-11 review). The constant read 18 under a comment claiming it matched the
 *   column, so it accepted 7–18 fractional digits no column can hold and the
 *   error message described a bound that was not the storage bound. Unreachable
 *   through the HTTP contract, which caps at 6 — but this function is exported
 *   from `@rcln/clinical` for any caller.
 */
const MAX_INPUT_SCALE = 6;

/** An exact non-negative rational. Always reduced, denominator always positive. */
interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export interface DoseRequest {
  /**
   * The subject's weight in kilograms, as a decimal string.
   *
   * ⚠️ A STRING, NOT A NUMBER, ALL THE WAY FROM THE COLUMN. `weight_kg` is
   *   `Decimal(8,3)` and a JSON number does not survive the round trip.
   */
  readonly weightKg: string;
  /** How much per kilogram, per single administration. A decimal string. */
  readonly dosePerKg: string;
  /**
   * How many times a day the dose is given. Omit when the caller only wants the
   * single dose — the daily total then comes back null rather than assuming one.
   */
  readonly dosesPerDay?: number;
  /** The label's ceiling on ONE dose, where it states one. */
  readonly maxSingleDose?: string;
  /**
   * The label's ceiling on a DAY's total, where it states one.
   *
   * ⚠️ IT IS ONLY CHECKABLE WITH `dosesPerDay`. A daily maximum and no frequency
   *   is a request this module cannot answer, and it refuses rather than
   *   silently ignoring the cap — see `weightBasedDose`.
   */
  readonly maxDailyDose?: string;
}

/** Which ceiling bound the answer, when one did. */
export type DoseCap = 'SINGLE' | 'DAILY';

export interface DoseResult {
  /** One administration, at `DOSE_SCALE` places. */
  readonly singleDose: string;
  /** `singleDose × dosesPerDay`, or null when no frequency was given. */
  readonly dailyDose: string | null;
  /**
   * Which stated maximum the answer is sitting on, or null when the calculated
   * dose is below both.
   *
   * ⚠️ A CAP IS NOT A WARNING, IT IS THE ANSWER. When this is set, `singleDose`
   *   is the CAPPED figure and not what weight × rate came to — a screen that
   *   renders the cap as a footnote beside an uncapped number has shown a dose
   *   the label prohibits.
   */
  readonly cappedBy: DoseCap | null;
  /**
   * False when the exact value needed more than `DOSE_SCALE` decimal places and
   * was rounded DOWN. Never rounded up — see the file header.
   */
  readonly exact: boolean;
}

// ---------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

function rational(n: bigint, d: bigint): Rational {
  const g = gcd(n, d);
  return g === 0n ? { n: 0n, d: 1n } : { n: n / g, d: d / g };
}

function multiply(a: Rational, b: Rational): Rational {
  /* Cross-reduce before multiplying, so a chain of these keeps the bigints in
   * the range the inputs were in. Same reasoning as `@rcln/inventory`. */
  const left = rational(a.n, b.d);
  const right = rational(b.n, a.d);
  return { n: left.n * right.n, d: left.d * right.d };
}

/** `-1`, `0` or `1`. Cross-multiplied, so nothing is divided and nothing rounds. */
function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * A decimal string as an exact rational.
 *
 * Refuses a sign, refuses anything that is not digits and one point, and refuses
 * more decimal places than `Decimal(18,6)` could have carried. A weight of
 * `"-3"` or `"three"` is a broken input, and this module answers with a sentence
 * rather than with a number derived from `NaN`.
 */
function parseDecimal(value: string, what: string): Parsed<Rational> {
  const match = UNSIGNED_DECIMAL.exec(value.trim());
  if (!match) {
    return { ok: false, problem: `${what} must be a positive number, and "${value}" is not one` };
  }
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > MAX_INPUT_SCALE) {
    return { ok: false, problem: `${what} has more decimal places than can be stored` };
  }
  return {
    ok: true,
    value: rational(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)),
  };
}

/**
 * The rational as a decimal string at `DOSE_SCALE` places, rounded DOWN, with a
 * flag saying whether anything was discarded.
 *
 * ⚠️ TRUNCATION, NOT ROUNDING. See the file header: rounding a dose up past a
 *   stated maximum is an overdose, and there is no cap check downstream of this
 *   that would catch it, because the cap was applied to the exact value before
 *   the truncation happened.
 */
function toDecimal(value: Rational): { text: string; exact: boolean } {
  const factor = 10n ** BigInt(DOSE_SCALE);
  const scaled = (value.n * factor) / value.d;
  const exact = scaled * value.d === value.n * factor;

  const whole = scaled / factor;
  const fraction = scaled % factor;
  return {
    text: `${whole.toString()}.${fraction.toString().padStart(DOSE_SCALE, '0')}`,
    exact,
  };
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

/**
 * Weight × rate, held to whichever stated maximum binds first.
 *
 * ⚠️ A DAILY CEILING REDUCES THE SINGLE DOSE; IT DOES NOT TRIM THE TOTAL
 *   AFTERWARDS. The obvious implementation computes the single dose, multiplies
 *   it out, and clamps the daily figure — which returns a pair that does not
 *   multiply, and a clinician reading "220 mg, three times a day, 500 mg daily"
 *   has been handed two instructions that contradict each other. Dividing the
 *   daily cap by the frequency answers the question they actually asked: how
 *   much may I give each time.
 *
 * ⚠️ AND THE REPORTED PAIR ALWAYS MULTIPLIES. `dailyDose` is the ROUNDED single
 *   dose times the frequency, not the exact value times it — see the note at the
 *   bottom of this function.
 *
 * ⚠️ AND EVERY CAP IS APPLIED TO THE EXACT VALUE, BEFORE ROUNDING. Applying it
 *   afterwards lets a dose that truncated upward — which cannot happen here, but
 *   would the moment somebody changed `toDecimal` to round half-up — escape the
 *   ceiling by a thousandth.
 *
 * Returns a problem rather than throwing, so a route turns it into a 422 naming
 * the field instead of a 500.
 */
export function weightBasedDose(request: DoseRequest): Parsed<DoseResult> {
  const weight = parseDecimal(request.weightKg, 'The weight');
  if (!weight.ok) return weight;
  const rate = parseDecimal(request.dosePerKg, 'The dose per kilogram');
  if (!rate.ok) return rate;

  const zero: Rational = { n: 0n, d: 1n };
  if (compare(weight.value, zero) === 0) {
    return { ok: false, problem: 'The weight is zero, so no dose can be calculated from it.' };
  }
  if (compare(rate.value, zero) === 0) {
    return { ok: false, problem: 'The dose per kilogram is zero.' };
  }

  const { dosesPerDay } = request;
  if (dosesPerDay !== undefined && (!Number.isInteger(dosesPerDay) || dosesPerDay < 1)) {
    return {
      ok: false,
      problem: 'The number of doses a day must be a whole number of at least 1.',
    };
  }

  /*
   * ⚠️ A DAILY CEILING WITH NO FREQUENCY IS REFUSED, NOT IGNORED. The caller
   *   stated a limit; answering without applying it would return a number that
   *   looks checked and is not. Same discipline as `parameters.ts` in
   *   `@rcln/regulatory`: a constraint nothing can evaluate is an error.
   */
  if (request.maxDailyDose !== undefined && dosesPerDay === undefined) {
    return {
      ok: false,
      problem: 'A daily maximum can only be applied when you say how many doses a day are given.',
    };
  }

  let dose = multiply(weight.value, rate.value);
  let cappedBy: DoseCap | null = null;

  if (request.maxSingleDose !== undefined) {
    const cap = parseDecimal(request.maxSingleDose, 'The maximum single dose');
    if (!cap.ok) return cap;
    if (compare(dose, cap.value) > 0) {
      dose = cap.value;
      cappedBy = 'SINGLE';
    }
  }

  if (request.maxDailyDose !== undefined && dosesPerDay !== undefined) {
    const cap = parseDecimal(request.maxDailyDose, 'The maximum daily dose');
    if (!cap.ok) return cap;
    const perDose = multiply(cap.value, { n: 1n, d: BigInt(dosesPerDay) });
    if (compare(dose, perDose) > 0) {
      dose = perDose;
      /* The daily ceiling bound harder than the single one, so it is the answer
       * — reporting `SINGLE` here would cite a limit that was not the operative
       * one and send a clinician to the wrong line of the label. */
      cappedBy = 'DAILY';
    }
  }

  const single = toDecimal(dose);
  if (dosesPerDay === undefined) {
    return {
      ok: true,
      value: { singleDose: single.text, dailyDose: null, cappedBy, exact: single.exact },
    };
  }

  /*
   * ⚠️ THE DAILY TOTAL IS THE *REPORTED* SINGLE DOSE TIMES THE FREQUENCY, SO THE
   *   PAIR ALWAYS MULTIPLIES (PI-11 review). It used to be derived from the
   *   exact, un-truncated value, which produced exactly the contradiction the
   *   header of this file argues against: `166.666` three times a day beside a
   *   daily total of `500.000`, when giving the printed dose three times delivers
   *   499.998. A clinician reading two figures that do not agree has been handed
   *   two instructions.
   *
   * ⚠️ THE COST IS REAL AND IS THE RIGHT TRADE. A dose that truncates to `0.000`
   *   now reports `0.000` a day rather than `0.001` — which is honest, because
   *   giving nothing three times is nothing. The old behaviour dressed an
   *   unrepresentable dose up as a representable daily total; `exact: false` is
   *   how the caller learns precision was lost, and a dose that small is a unit
   *   problem (mcg, not mg) rather than a rounding one.
   */
  const perDose = parseDecimal(single.text, 'The dose');
  /* Unreachable: `toDecimal` always emits a well-formed unsigned decimal. */
  if (!perDose.ok) return perDose;
  const daily = toDecimal(multiply(perDose.value, { n: BigInt(dosesPerDay), d: 1n }));

  return {
    ok: true,
    value: {
      singleDose: single.text,
      dailyDose: daily.text,
      cappedBy,
      /* `daily` cannot lose anything the single dose has not already lost. */
      exact: single.exact,
    },
  };
}
