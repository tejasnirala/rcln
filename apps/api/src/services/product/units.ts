/**
 * The unit conversion algebra. Pure — no Prisma, no tenant, no clock.
 *
 * Every quantity in this programme is denominated by something in here, so this
 * lands before anything that has a quantity. Getting it wrong later is a second
 * migration under live stock.
 *
 * ── WHY EXACT RATIONALS AND NOT `number` ─────────────────────────────────────
 * The obvious implementation is a `factor: number` on each conversion and a
 * multiply. It is wrong for a reason that never shows up in a demo:
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *
 * A three-level packaging hierarchy multiplies three factors, a transfer
 * converts up and back down, and each step compounds. The error surfaces as a
 * stock count off by a fraction of a tablet — small enough to look like a
 * data-entry mistake, large enough to fail a controlled-substance
 * reconciliation, and impossible to reproduce from the ledger because the
 * ledger recorded the rounded number.
 *
 * So a conversion is an integer numerator over an integer denominator, held in
 * `bigint`, reduced by gcd at every step. `1/3` stays `1/3` through arbitrarily
 * many multiplications and is rounded exactly once, at the edge, where the
 * caller can see it happen.
 *
 * ── ROUNDING IS AN EVENT, NOT A DEFAULT ──────────────────────────────────────
 * `convert` returns `{ quantity, exact }`. When `exact` is false the value did
 * not fit in the ledger's six decimal places and was rounded half-up. Callers
 * that must not lose a fraction — a dispense, a controlled-drug movement — call
 * `assertExactConversion`. Callers that legitimately may — a display estimate —
 * ignore the flag deliberately, in writing.
 *
 * ⚠️ NOTHING HERE READS THE DATABASE. The caller loads the units and the
 *   conversions and passes them in, exactly as `@rcln/tax` is fed its rules.
 *   That is what makes every rule below testable without a tenant, a transaction
 *   or a fixture, and it is why the tests for this file are unit tests.
 */
import { ValidationError } from '../../utils/errors.js';

/** Mirrors the `UnitClass` enum. Duplicated rather than imported so this module
 *  stays free of the generated Prisma client — see the header. */
export type UnitClass = 'COUNT' | 'VOLUME' | 'MASS' | 'LENGTH' | 'AREA';

/** The ledger's precision. `Decimal(18,6)` in Postgres (PI-ADR-010). */
export const BASE_SCALE = 6;

export interface UnitRow {
  id: string;
  code: string;
  unitClass: UnitClass;
}

export interface ConversionRow {
  fromUnitId: string;
  toUnitId: string;
  /** `from` x numerator / denominator = `to`. Both > 0, CHECKed in the database. */
  numerator: bigint;
  denominator: bigint;
}

/** An exact non-negative rational. Always reduced, denominator always positive. */
export interface Rational {
  n: bigint;
  d: bigint;
}

export interface ConversionResult {
  /** A decimal string at `BASE_SCALE` places. A string, not a number — see the
   *  header, and note `Decimal(18,6)` does not survive a JSON number either. */
  quantity: string;
  /** False when the exact value needed more than `BASE_SCALE` decimal places
   *  and was rounded half-up. */
  exact: boolean;
}

// ---------------------------------------------------------------------------
// Rational arithmetic
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Reduce, and normalise the sign onto the numerator.
 *
 * Reduction is not cosmetic: without it a ten-level hierarchy multiplies ten
 * numerators and ten denominators, and the bigints grow without bound. With it
 * they stay in the range the inputs were in.
 */
export function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) {
    // Unreachable through the database, which CHECKs `denominator > 0`. Kept
    // because this module is pure and a test or an import may reach it directly.
    throw new ValidationError('A unit conversion cannot have a zero denominator.');
  }
  const sign = d < 0n ? -1n : 1n;
  const nn = n * sign;
  const dd = d * sign;
  const g = gcd(nn, dd);
  return g === 0n ? { n: 0n, d: 1n } : { n: nn / g, d: dd / g };
}

export function multiply(a: Rational, b: Rational): Rational {
  /*
   * Cross-reduce BEFORE multiplying, not after.
   *
   * `rational(a.n * b.n, a.d * b.d)` gives the same answer and builds both
   * products at full width first — which is how a long chain of conversions
   * ends up doing arithmetic on numbers with hundreds of digits before
   * collapsing them back to something small.
   */
  const g1 = gcd(a.n, b.d);
  const g2 = gcd(b.n, a.d);
  return rational((a.n / g1) * (b.n / g2), (a.d / g2) * (b.d / g1));
}

export function invert(a: Rational): Rational {
  if (a.n === 0n) {
    throw new ValidationError('A unit conversion cannot have a zero ratio.');
  }
  return rational(a.d, a.n);
}

/**
 * Parse a decimal string EXACTLY into a rational.
 *
 * ⚠️ NEVER VIA `Number()`. `Number('0.1')` is already not 0.1, so parsing
 *   through a float would reintroduce at the door the error this whole module
 *   exists to keep out. The digits are read as integers and the scale becomes
 *   the denominator.
 *
 * Accepts what the contracts accept: an optional sign, digits, an optional
 * fraction. Rejects exponent notation — `1e3` is not a quantity anybody types
 * into a stock form, and accepting it means accepting `1e-400`.
 */
export function parseQuantity(value: string): Rational {
  const text = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new ValidationError(
      `"${value}" is not a quantity. Expected digits with an optional decimal point, e.g. 12.5`
    );
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  const digits = `${whole}${fraction}`;
  const n = BigInt(digits) * (sign === '-' ? -1n : 1n);
  const d = 10n ** BigInt(fraction.length);
  return rational(n, d);
}

/**
 * Render a rational as a fixed-scale decimal string, half-up.
 *
 * Half-up rather than banker's rounding because this is a quantity of physical
 * things, and the convention a pharmacist checking a count expects is the one
 * they learned at school. The choice only ever applies to the digit past the
 * sixth decimal place, and `exact` tells the caller it applied at all.
 */
export function formatQuantity(value: Rational, scale = BASE_SCALE): ConversionResult {
  const factor = 10n ** BigInt(scale);
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;

  const scaled = n * factor;
  const quotient = scaled / value.d;
  const remainder = scaled % value.d;

  // Half-up: round away from zero when the remainder is at least half.
  const rounded = remainder * 2n >= value.d ? quotient + 1n : quotient;

  const digits = rounded.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';

  return {
    quantity: `${negative && rounded !== 0n ? '-' : ''}${whole}${fraction}`,
    exact: remainder === 0n,
  };
}

// ---------------------------------------------------------------------------
// The conversion graph
// ---------------------------------------------------------------------------

export interface UnitGraph {
  units: Map<string, UnitRow>;
  /** Adjacency: unit id -> [neighbour id, factor from this unit to that one]. */
  edges: Map<string, { to: string; factor: Rational }[]>;
}

/**
 * Build the graph once per request, then answer many conversions from it.
 *
 * Every conversion row becomes TWO edges — `from -> to` at `n/d` and
 * `to -> from` at `d/n`. Storing only one direction and inverting at lookup time
 * reads as a saving and means the traversal has to search both edge lists at
 * every node, which is where an asymmetric bug hides: `strip -> tablet` resolves
 * and `tablet -> strip` quietly does not.
 */
export function buildUnitGraph(units: UnitRow[], conversions: ConversionRow[]): UnitGraph {
  const byId = new Map(units.map((u) => [u.id, u]));
  const edges = new Map<string, { to: string; factor: Rational }[]>();

  const push = (from: string, to: string, factor: Rational): void => {
    const list = edges.get(from);
    if (list) list.push({ to, factor });
    else edges.set(from, [{ to, factor }]);
  };

  for (const c of conversions) {
    /*
     * A conversion naming a unit that is not in `units` is skipped rather than
     * thrown on. The two lists come from the same transaction under the same RLS
     * policy, and a unit can legitimately be filtered out of one and not the
     * other — an inactive unit, or another tenant's private unit reached through
     * a platform conversion. Throwing here would make one unusable row break
     * every conversion in the clinic.
     */
    if (!byId.has(c.fromUnitId) || !byId.has(c.toUnitId)) continue;

    /*
     * ⚠️ A ZERO NUMERATOR IS SKIPPED FOR THE SAME REASON, AND HAS TO BE SKIPPED
     *   EXPLICITLY. The reverse edge below is `invert(factor)`, which THROWS on
     *   a zero numerator — so without this line one unusable row would take out
     *   every conversion in the clinic, which is precisely what the paragraph
     *   above says must not happen. The two behaviours contradicted each other
     *   and the comment was the one telling the truth.
     *
     *   The DB CHECK (`unit_conversions_ratio_positive`) makes this unreachable
     *   through Postgres. This module is pure and is called directly from tests
     *   and, later, from import paths that build a graph in memory first.
     */
    if (c.numerator === 0n || c.denominator === 0n) continue;

    const factor = rational(c.numerator, c.denominator);
    push(c.fromUnitId, c.toUnitId, factor);
    push(c.toUnitId, c.fromUnitId, invert(factor));
  }

  return { units: byId, edges };
}

/**
 * The exact factor to multiply a quantity in `fromUnitId` by to express it in
 * `toUnitId`.
 *
 * Breadth-first, so the answer goes through the FEWEST conversions available.
 * That matters even though the arithmetic is exact: a shorter path is a smaller
 * bigint and, more usefully, a shorter explanation when somebody asks why a
 * number came out the way it did.
 *
 * ⚠️ CROSS-CLASS IS REFUSED BEFORE THE SEARCH, NOT BY FAILING TO FIND A PATH.
 *   Both would return an error today. They stop agreeing the moment somebody
 *   inserts a `TAB -> ML` row: the search would find it and answer confidently.
 *   There is no true general answer to "how many millilitres in a tablet" — the
 *   honest one is a property of a PRODUCT, and it belongs in `product_packagings`
 *   where it is stated per product. The database refuses such a row too, with a
 *   trigger; this is the second layer.
 */
export function conversionFactor(graph: UnitGraph, fromUnitId: string, toUnitId: string): Rational {
  const from = graph.units.get(fromUnitId);
  const to = graph.units.get(toUnitId);

  if (!from) throw new ValidationError('The source unit is not available to this clinic.');
  if (!to) throw new ValidationError('The target unit is not available to this clinic.');

  if (from.unitClass !== to.unitClass) {
    throw new ValidationError(
      `${from.code} measures ${from.unitClass.toLowerCase()} and ${to.code} measures ` +
        `${to.unitClass.toLowerCase()}, so one cannot be converted into the other. ` +
        `If this product's ${from.code} genuinely holds a fixed ${to.code}, record it as ` +
        `packaging on the product rather than as a unit conversion.`
    );
  }

  if (fromUnitId === toUnitId) return { n: 1n, d: 1n };

  const seen = new Set<string>([fromUnitId]);
  let frontier: { id: string; factor: Rational }[] = [{ id: fromUnitId, factor: { n: 1n, d: 1n } }];

  while (frontier.length > 0) {
    const next: { id: string; factor: Rational }[] = [];

    for (const node of frontier) {
      for (const edge of graph.edges.get(node.id) ?? []) {
        if (seen.has(edge.to)) continue;
        const factor = multiply(node.factor, edge.factor);
        if (edge.to === toUnitId) return factor;
        seen.add(edge.to);
        next.push({ id: edge.to, factor });
      }
    }

    frontier = next;
  }

  throw new ValidationError(
    `No conversion is recorded between ${from.code} and ${to.code}. Add one before using both ` +
      `units for the same product.`
  );
}

/** Convert a quantity between two units. See `ConversionResult.exact`. */
export function convert(
  graph: UnitGraph,
  quantity: string,
  fromUnitId: string,
  toUnitId: string
): ConversionResult {
  const factor = conversionFactor(graph, fromUnitId, toUnitId);
  return formatQuantity(multiply(parseQuantity(quantity), factor));
}

/** Express a quantity in the product's base unit. The ledger's denomination. */
export function convertToBase(
  graph: UnitGraph,
  quantity: string,
  fromUnitId: string,
  baseUnitId: string
): ConversionResult {
  return convert(graph, quantity, fromUnitId, baseUnitId);
}

/** Express a base-unit quantity in something a human reads. Display only. */
export function convertFromBase(
  graph: UnitGraph,
  baseQuantity: string,
  baseUnitId: string,
  toUnitId: string
): ConversionResult {
  return convert(graph, baseQuantity, baseUnitId, toUnitId);
}

/**
 * Refuse a conversion that lost a fraction.
 *
 * ⚠️ CALL THIS FROM EVERY LEDGER WRITE (PI-2 onwards). Rounding a display
 *   estimate is fine; rounding a movement means the ledger and the shelf
 *   disagree by design, and the disagreement compounds silently because each
 *   individual rounding is defensible.
 */
export function assertExactConversion(
  result: ConversionResult,
  context: { from: string; to: string }
): string {
  if (!result.exact) {
    throw new ValidationError(
      `Converting from ${context.from} to ${context.to} does not come out to a whole number of ` +
        `${context.to}. Enter the quantity in ${context.to} instead, or correct the packaging.`
    );
  }
  return result.quantity;
}

// ---------------------------------------------------------------------------
// Packaging hierarchies
// ---------------------------------------------------------------------------

export interface PackagingLevelRow {
  /** 0 is the base unit itself. */
  level: number;
  unitId: string;
  /** How many of the level below one of these contains. Always 1 at level 0. */
  quantityOfChild: string;
}

/**
 * How many base units one of `level` contains.
 *
 * `box(10 strips) -> strip(10 tablets) -> tablet` is 100, computed as the
 * product of `quantityOfChild` from `level` down to 1.
 *
 * ⚠️ COMPUTED, NEVER STORED. A stored `factorToBase` column is a second copy of
 *   a fact the levels already state, and the copy is what goes stale when
 *   somebody edits a level in the middle of the chain. The chain is short and
 *   the arithmetic is exact, so there is nothing to cache.
 *
 * ⚠️ THE CHAIN MUST BE COMPLETE. A hierarchy with level 3 and no level 2 does
 *   not describe a box of anything, and multiplying whatever levels happen to
 *   exist would answer a plausible number for a product nobody can count. The
 *   gap is refused by name.
 */
export function packagingFactorToBase(levels: PackagingLevelRow[], level: number): Rational {
  if (level === 0) return { n: 1n, d: 1n };

  const byLevel = new Map(levels.map((l) => [l.level, l]));

  /*
   * ⚠️ A DUPLICATE LEVEL IS REFUSED HERE, NOT LEFT TO THE MAP. `new Map` keeps
   *   the LAST row for a repeated key, so two level-2 rows would not error —
   *   one would simply be ignored and this would return a confident, wrong
   *   factor. Every quantity derived from it is then wrong by whatever the two
   *   rows disagreed about, with nothing to indicate it.
   *
   *   The DB unique on `(organization_id, product_id, level)` makes this
   *   unreachable through the services TODAY. This function is exported and is
   *   called directly by `listPackagings` and `toDetail` WITHOUT going through
   *   `assertValidPackaging`, and PI-2's bulk-import path is exactly the kind of
   *   caller that hands over an in-memory array the database has not seen yet.
   *   A pure function that cannot be trusted on its own arguments is not one.
   */
  if (byLevel.size !== levels.length) {
    throw new ValidationError(
      'This packaging hierarchy lists the same level more than once, so there is no single answer ' +
        'for how many base units it holds. Each level may appear only once.'
    );
  }

  let factor: Rational = { n: 1n, d: 1n };

  for (let step = level; step >= 1; step--) {
    const row = byLevel.get(step);
    if (!row) {
      throw new ValidationError(
        `This product's packaging skips level ${step}, so a quantity at level ${level} cannot be ` +
          `converted to its base unit. Add the missing level.`
      );
    }
    factor = multiply(factor, parseQuantity(row.quantityOfChild));
  }

  return factor;
}

/** A quantity entered at a packaging level, expressed in base units. */
export function convertPackagingToBase(
  levels: PackagingLevelRow[],
  quantity: string,
  level: number
): ConversionResult {
  return formatQuantity(multiply(parseQuantity(quantity), packagingFactorToBase(levels, level)));
}

/**
 * Validate a packaging chain as a whole, before it is written.
 *
 * Each rule is also a database constraint or index; these run first so the user
 * gets a sentence naming what they did rather than a constraint name.
 */
export function assertValidPackaging(levels: PackagingLevelRow[]): void {
  if (levels.length === 0) return;

  const sorted = [...levels].sort((a, b) => a.level - b.level);
  const seen = new Set<number>();

  for (const row of sorted) {
    if (row.level < 0) throw new ValidationError('A packaging level cannot be negative.');
    if (seen.has(row.level)) {
      throw new ValidationError(`This product has two packaging rows at level ${row.level}.`);
    }
    seen.add(row.level);

    const quantity = parseQuantity(row.quantityOfChild);
    if (quantity.n <= 0n) {
      throw new ValidationError(
        `Level ${row.level} contains ${row.quantityOfChild} of the level below it. It must be more than zero.`
      );
    }
    if (row.level === 0 && !(quantity.n === 1n && quantity.d === 1n)) {
      throw new ValidationError(
        'Level 0 is the base unit itself, so it must contain exactly 1. Start the pack sizes at level 1.'
      );
    }
  }

  if (sorted[0]?.level !== 0) {
    throw new ValidationError(
      'A packaging hierarchy must start at level 0, which is the product’s base unit.'
    );
  }

  // Contiguity. See the warning on `packagingFactorToBase`.
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]?.level !== i) {
      throw new ValidationError(
        `This product's packaging skips level ${i}. Levels must run 0, 1, 2 … with no gaps.`
      );
    }
  }

  const units = new Set(sorted.map((l) => l.unitId));
  if (units.size !== sorted.length) {
    throw new ValidationError('The same unit is used for two packaging levels.');
  }
}
