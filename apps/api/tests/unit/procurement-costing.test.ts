/**
 * `@rcln/inventory`'s costing arithmetic (PI-4.8).
 *
 * ⚠️ THESE ARE UNIT TESTS BECAUSE COSTING IS WRONG IN A WAY NO INTEGRATION TEST
 *   NOTICES. A receipt that posts, writes its ledger rows and lands stock on the
 *   right shelf at a unit cost one paisa out looks entirely correct from every angle
 *   a route test can see. It surfaces a year later as a valuation that does not
 *   reconcile, by an amount each individual rounding could justify. Same reasoning
 *   PI-3 used for FEFO ordering — where the unit suite immediately found a scale
 *   inconsistency that was invisible on screen.
 */
import {
  apportionByValue,
  averageCostBase,
  removeFromAverage,
  rollIntoAverage,
  unitCostFromPack,
  valueOf,
} from '@rcln/inventory';

describe('apportionByValue', () => {
  it('splits pro-rata by value', () => {
    expect(apportionByValue(300, [100, 200])).toEqual([100, 200]);
  });

  /**
   * ⚠️ THE SHARES MUST SUM TO THE TOTAL EXACTLY. A document whose lines do not add up
   *   to its header is the one thing a person checking it notices immediately, and
   *   plain rounding of each share does not guarantee it.
   */
  it('gives every leftover minor unit to the largest fractional claims', () => {
    const shares = apportionByValue(10, [1, 1, 1]);
    expect(shares.reduce((sum, s) => sum + s, 0)).toBe(10);
    expect(shares).toEqual([4, 3, 3]);
  });

  /**
   * ⚠️ TIES BREAK ON THE LOWER INDEX, WHICH IS WHAT MAKES IT REPRODUCIBLE. The
   *   apportionment is STORED on the line rather than recomputed on read, and a
   *   tie-break that fell out of iteration order would make the same receipt,
   *   re-derived, apportion differently.
   */
  it('is stable for equal weights', () => {
    expect(apportionByValue(7, [50, 50, 50])).toEqual(apportionByValue(7, [50, 50, 50]));
    expect(apportionByValue(7, [50, 50, 50])).toEqual([3, 2, 2]);
  });

  /**
   * ⚠️ FREIGHT LARGER THAN THE GOODS IS ORDINARY AND IS THE REASON THIS IS NOT
   *   `@rcln/invoicing`'s `apportion`. That one refuses `total > totalWeight`, because
   *   a discount larger than the bill is a credit note; a single vial couriered
   *   overnight is a real receipt.
   */
  it('allows a charge larger than the goods it is shared across', () => {
    expect(apportionByValue(5000, [100])).toEqual([5000]);
  });

  /**
   * ⚠️ AN EVEN SPLIT IS THE ONLY HONEST FALLBACK FOR A ZERO-VALUE DELIVERY. Free
   *   samples with a courier charge: the charge was genuinely incurred and refusing to
   *   record it would be worse than spreading it.
   */
  it('splits evenly when nothing has any value', () => {
    expect(apportionByValue(9, [0, 0, 0])).toEqual([3, 3, 3]);
  });

  it('gives nothing away when there is nothing to share', () => {
    expect(apportionByValue(0, [100, 200])).toEqual([0, 0]);
  });

  /**
   * ⚠️ THE OVERFLOW CASE, WHICH IS WHY THE ARITHMETIC IS IN `bigint`. A ₹50,000
   *   freight charge over a ₹90,00,000 delivery makes `total * weight` 4.5e17 — past
   *   `Number.MAX_SAFE_INTEGER` — and the float it becomes is out by whole paisa.
   *   `apportion()` in @rcln/invoicing throws on it instead, which is safe for one
   *   invoice and would refuse an ordinary wholesale receipt.
   */
  it('stays exact on a wholesale-sized delivery', () => {
    const total = 50_00_000;
    const weights = [9_00_00_000, 1_00_00_000];
    const shares = apportionByValue(total, weights);
    expect(shares.reduce((sum, s) => sum + s, 0)).toBe(total);
    expect(shares).toEqual([45_00_000, 5_00_000]);
  });
});

describe('unitCostFromPack', () => {
  it('divides a pack price by the units in the pack', () => {
    // ₹412 for 100 capsules is ₹4.12 each, exactly.
    expect(unitCostFromPack(41_200, '100')).toBe(412);
  });

  /**
   * ⚠️ HALF-UP, AND THE SAME CONVENTION AS `divideRounded` IN `@rcln/payments`. Two
   *   rounding conventions in one system is how a reconciliation report ends up
   *   disagreeing with itself.
   */
  it('rounds half-up when a pack does not divide evenly', () => {
    // 41200 / 90 = 457.77…
    expect(unitCostFromPack(41_200, '90')).toBe(458);
    // 5 / 2 = 2.5 -> 3
    expect(unitCostFromPack(5, '2')).toBe(3);
  });

  it('handles a fractional pack size exactly', () => {
    // A 2.5 mL vial at ₹10.00 is 400 per mL.
    expect(unitCostFromPack(1_000, '2.5')).toBe(400);
  });

  /**
   * ⚠️ A PACK OF NOTHING HAS NO UNIT COST, AND IT IS REFUSED RATHER THAN RETURNING
   *   ZERO. It is the divisor that turns a pack price into the figure that lands on a
   *   shelf; a zero here would value everything at nothing.
   */
  it('refuses a pack size of zero or below', () => {
    expect(() => unitCostFromPack(100, '0')).toThrow(/above zero/i);
    expect(() => unitCostFromPack(100, '-1')).toThrow(/above zero/i);
  });

  it('refuses a negative price', () => {
    expect(() => unitCostFromPack(-1, '10')).toThrow(/cannot be negative/i);
  });
});

describe('valueOf', () => {
  it('multiplies a unit cost by a quantity', () => {
    expect(valueOf(412, '100')).toBe(41_200n);
  });

  it('rounds half-up on a fractional quantity', () => {
    // 412 * 0.5 = 206 exactly
    expect(valueOf(412, '0.5')).toBe(206n);
    // 413 * 0.5 = 206.5 -> 207
    expect(valueOf(413, '0.5')).toBe(207n);
  });
});

describe('the moving average', () => {
  /**
   * ⚠️ THE HEADLINE CASE, AND THE ONE PI-4.10 ASKS FOR BY NAME: right after three
   *   receipts at three prices. It is right because the running TOTAL is stored and
   *   the average is derived, not the other way round.
   */
  it('is right after three receipts at three prices', () => {
    let pool = { valuedQuantityBase: '0', valuedCostMinor: 0n };

    pool = rollIntoAverage(pool, { quantityBase: '100', valueMinor: 10_000n }); // 100 @ 1.00
    pool = rollIntoAverage(pool, { quantityBase: '100', valueMinor: 20_000n }); // 100 @ 2.00
    pool = rollIntoAverage(pool, { quantityBase: '200', valueMinor: 60_000n }); // 200 @ 3.00

    expect(pool.valuedQuantityBase).toBe('400');
    expect(pool.valuedCostMinor).toBe(90_000n);
    // 90000 / 400 = 225 minor units per unit — ₹2.25
    expect(averageCostBase(pool.valuedCostMinor, pool.valuedQuantityBase)).toBe(225);
  });

  /**
   * ⚠️ THIS IS THE PROPERTY THE WHOLE DESIGN EXISTS FOR. Storing the AVERAGE instead
   *   of the total would round at every receipt and compound; twenty deliveries of an
   *   awkwardly-priced item would drift from the arithmetic by an amount each
   *   individual rounding could justify. Rolled through twenty times, the derived
   *   average is still the exact division of the totals.
   */
  it('does not drift over twenty awkwardly-priced receipts', () => {
    let pool = { valuedQuantityBase: '0', valuedCostMinor: 0n };
    for (let i = 0; i < 20; i += 1) {
      pool = rollIntoAverage(pool, { quantityBase: '3', valueMinor: 100n });
    }

    expect(pool.valuedQuantityBase).toBe('60');
    expect(pool.valuedCostMinor).toBe(2_000n);
    // 2000 / 60 = 33.33… -> 33, computed ONCE from the totals rather than 20 times.
    expect(averageCostBase(pool.valuedCostMinor, pool.valuedQuantityBase)).toBe(33);
  });

  it('adds fractional quantities exactly', () => {
    let pool = { valuedQuantityBase: '0', valuedCostMinor: 0n };
    pool = rollIntoAverage(pool, { quantityBase: '0.1', valueMinor: 10n });
    pool = rollIntoAverage(pool, { quantityBase: '0.2', valueMinor: 20n });
    // The case a double gets wrong: 0.1 + 0.2 is 0.30000000000000004 there.
    expect(pool.valuedQuantityBase).toBe('0.3');
  });

  it('refuses a receipt of nothing', () => {
    expect(() =>
      rollIntoAverage(
        { valuedQuantityBase: '0', valuedCostMinor: 0n },
        {
          quantityBase: '0',
          valueMinor: 100n,
        }
      )
    ).toThrow(/above zero/i);
  });

  /**
   * ⚠️ A RETURN SHRINKS THE POOL AND LEAVES THE AVERAGE WHERE IT WAS, WHICH IS WHAT A
   *   MOVING AVERAGE MEANS. Once two deliveries at two prices are pooled, "what did
   *   THIS box cost" has no answer the pool can give — `batches.unit_cost_base` is
   *   where that question is answered.
   */
  it('removes returned stock at the current average', () => {
    let pool = { valuedQuantityBase: '0', valuedCostMinor: 0n };
    pool = rollIntoAverage(pool, { quantityBase: '100', valueMinor: 10_000n });
    pool = rollIntoAverage(pool, { quantityBase: '100', valueMinor: 30_000n });
    // 40000 / 200 = 200 per unit
    expect(averageCostBase(pool.valuedCostMinor, pool.valuedQuantityBase)).toBe(200);

    const after = removeFromAverage(pool, '50');
    expect(after.valuedQuantityBase).toBe('150');
    expect(after.valuedCostMinor).toBe(30_000n);
    // Unchanged: the pool is smaller and worth proportionally less.
    expect(averageCostBase(after.valuedCostMinor, after.valuedQuantityBase)).toBe(200);
  });

  /**
   * ⚠️ IT CANNOT GO BELOW ZERO, AND IT CLEARS THE VALUE WITH THE QUANTITY. The ledger
   *   is authoritative about quantity and will have refused an over-return long
   *   before this runs, so this is a defensive clamp — and it has to clear both,
   *   because `product_cost_averages_value_implies_quantity` refuses value with a zero
   *   denominator.
   */
  it('empties rather than going negative', () => {
    const after = removeFromAverage({ valuedQuantityBase: '10', valuedCostMinor: 1_000n }, '20');
    expect(after).toEqual({ valuedQuantityBase: '0', valuedCostMinor: 0n });
  });

  it('reports no average for an empty pool rather than dividing by zero', () => {
    expect(averageCostBase(0n, '0')).toBe(0);
  });
});
