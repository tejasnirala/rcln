import {
  assertExactConversion,
  assertValidPackaging,
  buildUnitGraph,
  convert,
  conversionFactor,
  convertPackagingToBase,
  formatQuantity,
  multiply,
  packagingFactorToBase,
  parseQuantity,
  rational,
  type ConversionRow,
  type UnitRow,
} from '../../src/services/product/units.js';

/**
 * The conversion algebra every quantity in the pharmacy programme rests on.
 *
 * ⚠️ THESE ARE THE TESTS THAT JUSTIFY NOT USING `number`. Each one below has a
 *   floating-point counterexample: `0.1 * 3` is 0.30000000000000004,
 *   `1000 * 1000 * 0.001` drifts, and a three-level packaging hierarchy
 *   multiplies three factors before anything rounds. The failures those produce
 *   are fractions of a tablet — small enough to read as a data-entry mistake,
 *   large enough to fail a controlled-substance reconciliation, and impossible
 *   to reproduce from a ledger that recorded the rounded number.
 *
 * Pure: no database, no tenant, no clock. That is the whole reason the algebra
 * lives in its own module.
 */

// A miniature catalogue, shaped like the real seed.
const UNITS: UnitRow[] = [
  { id: 'u-mg', code: 'MG', unitClass: 'MASS' },
  { id: 'u-g', code: 'G', unitClass: 'MASS' },
  { id: 'u-kg', code: 'KG', unitClass: 'MASS' },
  { id: 'u-mcg', code: 'MCG', unitClass: 'MASS' },
  { id: 'u-ml', code: 'ML', unitClass: 'VOLUME' },
  { id: 'u-l', code: 'L', unitClass: 'VOLUME' },
  { id: 'u-tab', code: 'TAB', unitClass: 'COUNT' },
  { id: 'u-strip', code: 'STRIP', unitClass: 'COUNT' },
  // Deliberately unreachable: no conversion row names it.
  { id: 'u-iu', code: 'IU', unitClass: 'MASS' },
];

const CONVERSIONS: ConversionRow[] = [
  { fromUnitId: 'u-g', toUnitId: 'u-mg', numerator: 1000n, denominator: 1n },
  { fromUnitId: 'u-kg', toUnitId: 'u-g', numerator: 1000n, denominator: 1n },
  { fromUnitId: 'u-mg', toUnitId: 'u-mcg', numerator: 1000n, denominator: 1n },
  { fromUnitId: 'u-l', toUnitId: 'u-ml', numerator: 1000n, denominator: 1n },
];

const graph = buildUnitGraph(UNITS, CONVERSIONS);

describe('building the graph', () => {
  it('skips an unusable row instead of throwing on it', () => {
    /*
     * A zero numerator cannot be inverted, and every edge is added in BOTH
     * directions — so before this was handled, ONE bad row threw out of
     * `buildUnitGraph` and took every conversion in the clinic with it. The
     * module's own comment says a row naming an unavailable unit is skipped
     * "rather than thrown on"; this makes the zero case agree with it.
     */
    const withBadRow = buildUnitGraph(UNITS, [
      ...CONVERSIONS,
      { fromUnitId: 'u-tab', toUnitId: 'u-strip', numerator: 0n, denominator: 1n },
    ]);

    expect(convert(withBadRow, '1', 'u-kg', 'u-mg')).toEqual({
      quantity: '1000000.000000',
      exact: true,
    });
    expect(() => conversionFactor(withBadRow, 'u-tab', 'u-strip')).toThrow();
  });

  it('lets a one-hop edge WIN over a longer path, which is why writes are guarded', () => {
    /*
     * ⚠️ THIS IS NOT A BUG IN THE SEARCH, IT IS THE REASON `createUnitConversion`
     *   CHECKS THE GRAPH BEFORE INSERTING. `conversionFactor` is breadth-first,
     *   so the shortest path wins — which is correct and desirable when the data
     *   is consistent, and silently destructive when it is not.
     *
     *   Here KG→MG is 1,000,000 through G. Add a direct KG→MG edge of 900,000
     *   and the direct edge is found first: the clinic's answer changes, every
     *   product denominated in MG is affected, and nothing anywhere errors. The
     *   graph cannot defend itself against this, so the WRITE path has to —
     *   which is what the contradiction check in `unit.service.ts` does.
     */
    const contradicted = buildUnitGraph(UNITS, [
      ...CONVERSIONS,
      { fromUnitId: 'u-kg', toUnitId: 'u-mg', numerator: 900_000n, denominator: 1n },
    ]);

    expect(conversionFactor(graph, 'u-kg', 'u-mg')).toEqual({ n: 1_000_000n, d: 1n });
    expect(conversionFactor(contradicted, 'u-kg', 'u-mg')).toEqual({ n: 900_000n, d: 1n });
  });
});

describe('rational arithmetic', () => {
  it('parses a decimal exactly, without going through a float', () => {
    // ⚠️ `Number('0.1')` is ALREADY not 0.1. Parsing through a float would
    //   reintroduce at the door the error this module exists to keep out.
    expect(parseQuantity('0.1')).toEqual({ n: 1n, d: 10n });
    expect(parseQuantity('12.5')).toEqual({ n: 25n, d: 2n });
    expect(parseQuantity('0.000001')).toEqual({ n: 1n, d: 1_000_000n });
    expect(parseQuantity('1000000')).toEqual({ n: 1_000_000n, d: 1n });
  });

  it('refuses anything that is not a plain decimal', () => {
    // Exponent notation is rejected on purpose: nobody types `1e3` into a stock
    // form, and accepting it means also accepting `1e-400`.
    for (const bad of ['1e3', 'abc', '', '1.2.3', '--1', '1,000']) {
      expect(() => parseQuantity(bad)).toThrow();
    }
  });

  it('keeps a third exact through arbitrarily many multiplications', () => {
    const third = rational(1n, 3n);
    let value = third;
    for (let i = 0; i < 20; i++) value = multiply(value, rational(3n, 1n));
    // 1/3 x 3 twenty times is 3^19, exactly. A float would have drifted by now.
    expect(multiply(value, rational(1n, 3n ** 19n))).toEqual({ n: 1n, d: 1n });
  });

  it('reduces, so a long chain does not grow unbounded bigints', () => {
    let value = rational(1n, 1n);
    for (let i = 0; i < 50; i++) value = multiply(value, rational(1000n, 1000n));
    expect(value).toEqual({ n: 1n, d: 1n });
  });
});

describe('formatting a quantity', () => {
  it('renders at the ledger scale and reports exactness', () => {
    expect(formatQuantity(rational(1n, 2n))).toEqual({ quantity: '0.500000', exact: true });
    expect(formatQuantity(rational(100n, 1n))).toEqual({ quantity: '100.000000', exact: true });
  });

  it('flags a value that did not fit, rather than rounding silently', () => {
    // ⚠️ THE FLAG IS THE POINT. A third of a gram cannot be written in six
    //   decimal places, and a caller writing to the ledger has to know that
    //   before it stores a number that disagrees with the shelf.
    const third = formatQuantity(rational(1n, 3n));
    expect(third.quantity).toBe('0.333333');
    expect(third.exact).toBe(false);
  });

  it('rounds half up, away from zero', () => {
    // 0.0000005 -> 0.000001, not the banker's 0.000000.
    expect(formatQuantity(rational(5n, 10_000_000n)).quantity).toBe('0.000001');
  });
});

describe('converting between units', () => {
  it('converts along a single edge', () => {
    expect(convert(graph, '2', 'u-g', 'u-mg')).toEqual({ quantity: '2000.000000', exact: true });
  });

  it('converts backwards along the same edge', () => {
    // Storing only one direction and inverting at lookup time is the shape that
    // produces an asymmetric bug: G -> MG resolves and MG -> G quietly does not.
    expect(convert(graph, '2000', 'u-mg', 'u-g')).toEqual({ quantity: '2.000000', exact: true });
  });

  it('walks multiple hops', () => {
    // KG -> G -> MG. One million, exactly.
    expect(convert(graph, '1', 'u-kg', 'u-mg')).toEqual({
      quantity: '1000000.000000',
      exact: true,
    });
    // And three hops in the other direction.
    expect(convert(graph, '1', 'u-mcg', 'u-kg').quantity).toBe('0.000000');
  });

  it('survives a round trip that a float would not', () => {
    // 0.1 L -> mL -> L. With a float factor this is where 0.1 stops being 0.1.
    const toMl = convert(graph, '0.1', 'u-l', 'u-ml');
    expect(toMl).toEqual({ quantity: '100.000000', exact: true });
    expect(convert(graph, toMl.quantity, 'u-ml', 'u-l')).toEqual({
      quantity: '0.100000',
      exact: true,
    });
  });

  it('is the identity for a unit and itself', () => {
    expect(conversionFactor(graph, 'u-mg', 'u-mg')).toEqual({ n: 1n, d: 1n });
  });

  it('refuses to cross unit classes', () => {
    /*
     * ⚠️ REFUSED BEFORE THE SEARCH, NOT BY FAILING TO FIND A PATH. The two stop
     *   agreeing the moment somebody inserts a TAB -> ML row: the search would
     *   find it and answer confidently. There is no true general answer to "how
     *   many millilitres in a tablet".
     */
    expect(() => conversionFactor(graph, 'u-tab', 'u-ml')).toThrow(/cannot be converted/i);
  });

  it('refuses when no conversion is recorded, rather than guessing', () => {
    // IU is in the MASS class and has no edge, because the milligram equivalent
    // of one International Unit differs per substance. The absence is the point.
    expect(() => conversionFactor(graph, 'u-iu', 'u-mg')).toThrow(/No conversion is recorded/i);
    // Same class, no path: TAB and STRIP are both COUNT and unrelated globally.
    expect(() => conversionFactor(graph, 'u-strip', 'u-tab')).toThrow(/No conversion is recorded/i);
  });

  it('refuses a unit this clinic cannot see', () => {
    expect(() => conversionFactor(graph, 'u-nope', 'u-mg')).toThrow(/not available/i);
  });

  it('ignores a conversion naming a unit that was filtered out', () => {
    // A unit can legitimately be missing from the unit list while a conversion
    // still names it — an inactive unit, or another tenant's private one reached
    // through a platform conversion. One unusable row must not break every
    // conversion in the clinic.
    const partial = buildUnitGraph(
      [
        { id: 'u-g', code: 'G', unitClass: 'MASS' },
        { id: 'u-mg', code: 'MG', unitClass: 'MASS' },
      ],
      [...CONVERSIONS, { fromUnitId: 'u-ghost', toUnitId: 'u-mg', numerator: 5n, denominator: 1n }]
    );
    expect(convert(partial, '1', 'u-g', 'u-mg').quantity).toBe('1000.000000');
  });
});

describe('assertExactConversion', () => {
  it('passes an exact result through', () => {
    const result = convert(graph, '1', 'u-g', 'u-mg');
    expect(assertExactConversion(result, { from: 'G', to: 'MG' })).toBe('1000.000000');
  });

  it('refuses one that lost a fraction', () => {
    expect(() =>
      assertExactConversion({ quantity: '0.333333', exact: false }, { from: 'G', to: 'MG' })
    ).toThrow(/does not come out to a whole number/i);
  });
});

describe('packaging hierarchies', () => {
  // box(10 strips) -> strip(10 tablets) -> tablet
  const LADDER = [
    { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
    { level: 1, unitId: 'u-strip', quantityOfChild: '10' },
    { level: 2, unitId: 'u-box', quantityOfChild: '10' },
  ];

  it('multiplies the chain down to the base unit', () => {
    expect(packagingFactorToBase(LADDER, 0)).toEqual({ n: 1n, d: 1n });
    expect(packagingFactorToBase(LADDER, 1)).toEqual({ n: 10n, d: 1n });
    expect(packagingFactorToBase(LADDER, 2)).toEqual({ n: 100n, d: 1n });
  });

  it('converts a quantity entered at a level', () => {
    // Three boxes is 300 tablets.
    expect(convertPackagingToBase(LADDER, '3', 2)).toEqual({
      quantity: '300.000000',
      exact: true,
    });
  });

  it('handles a five-level ladder without drift', () => {
    const deep = [
      { level: 0, unitId: 'a', quantityOfChild: '1' },
      { level: 1, unitId: 'b', quantityOfChild: '7' },
      { level: 2, unitId: 'c', quantityOfChild: '3' },
      { level: 3, unitId: 'd', quantityOfChild: '11' },
      { level: 4, unitId: 'e', quantityOfChild: '13' },
    ];
    // 7 x 3 x 11 x 13 = 3003
    expect(convertPackagingToBase(deep, '1', 4).quantity).toBe('3003.000000');
  });

  it('refuses a ladder with a gap in the middle', () => {
    /*
     * ⚠️ A HIERARCHY WITH LEVEL 3 AND NO LEVEL 2 DOES NOT DESCRIBE A BOX OF
     *   ANYTHING. Multiplying whichever levels happen to exist would answer a
     *   plausible number for a product nobody can count.
     */
    const gapped = [
      { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
      { level: 2, unitId: 'u-box', quantityOfChild: '10' },
    ];
    expect(() => packagingFactorToBase(gapped, 2)).toThrow(/skips level 1/i);
  });
});

describe('validating a packaging ladder before it is written', () => {
  it('accepts a well-formed ladder', () => {
    expect(() =>
      assertValidPackaging([
        { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
        { level: 1, unitId: 'u-strip', quantityOfChild: '10' },
      ])
    ).not.toThrow();
  });

  it('accepts an empty ladder', () => {
    /*
     * ⚠️ THIS PERMISSIVENESS IS CORRECT HERE AND WAS A BUG ONE LAYER UP.
     *   `assertValidPackaging` validates the SHAPE of a ladder it is given; an
     *   empty one has no gaps, no duplicate levels and no wrong base unit, so
     *   there is nothing for it to object to. Whether a product is ALLOWED to
     *   have no ladder is a different question, and it is not this function's.
     *
     *   It was nobody's, which is how `PUT /packagings {"levels": []}` came to
     *   delete a product's level-0 row and leave every future stock movement
     *   throwing. That is now refused twice — `.min(1)` on
     *   `replaceProductPackagingRequest`, and an unconditional level-0 check in
     *   `packaging.service.ts` — and neither belongs in here.
     */
    expect(() => assertValidPackaging([])).not.toThrow();
  });

  it('refuses a hierarchy that lists the same level twice', () => {
    /*
     * `new Map` keeps the last row for a repeated key, so before this check two
     * level-1 rows produced a confident wrong factor rather than an error. The
     * DB unique makes it unreachable through the services; this function is
     * exported and called on in-memory arrays that the database has not seen.
     */
    const dup = [
      { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
      { level: 1, unitId: 'u-strip', quantityOfChild: '10' },
      { level: 1, unitId: 'u-strip', quantityOfChild: '15' },
    ];
    expect(() => packagingFactorToBase(dup, 1)).toThrow(/same level more than once/i);
  });

  it('insists level 0 contains exactly one', () => {
    // Level 0 IS the base unit, so one of it contains one of itself. Any other
    // value silently multiplies every quantity in the hierarchy above it.
    expect(() =>
      assertValidPackaging([{ level: 0, unitId: 'u-tab', quantityOfChild: '10' }])
    ).toThrow(/must contain exactly 1/i);
  });

  it('insists the ladder starts at level 0', () => {
    expect(() =>
      assertValidPackaging([{ level: 1, unitId: 'u-strip', quantityOfChild: '10' }])
    ).toThrow(/must start at level 0/i);
  });

  it('rejects a duplicate level', () => {
    expect(() =>
      assertValidPackaging([
        { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
        { level: 1, unitId: 'u-strip', quantityOfChild: '10' },
        { level: 1, unitId: 'u-box', quantityOfChild: '5' },
      ])
    ).toThrow(/two packaging rows at level 1/i);
  });

  it('rejects a gap', () => {
    expect(() =>
      assertValidPackaging([
        { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
        { level: 2, unitId: 'u-box', quantityOfChild: '10' },
      ])
    ).toThrow(/skips level 1/i);
  });

  it('rejects a zero pack size', () => {
    // A zero here annihilates every quantity above it, and it SUCCEEDS — which
    // is what makes it worse than a negative one.
    expect(() =>
      assertValidPackaging([
        { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
        { level: 1, unitId: 'u-strip', quantityOfChild: '0' },
      ])
    ).toThrow(/more than zero/i);
  });

  it('rejects the same unit at two levels', () => {
    expect(() =>
      assertValidPackaging([
        { level: 0, unitId: 'u-tab', quantityOfChild: '1' },
        { level: 1, unitId: 'u-tab', quantityOfChild: '10' },
      ])
    ).toThrow(/same unit is used for two/i);
  });
});
