/**
 * The movement engine's pure parts: the direction table, and the comparison the
 * sufficiency check runs on.
 *
 * ⚠️ THE DIRECTION TABLE AND THE `stock_ledger_direction` CHECK CONSTRAINT ARE
 *   THE SAME RULE WRITTEN TWICE, IN TWO LANGUAGES. The constraint is the one
 *   that holds; the table exists so a caller gets a sentence instead of a
 *   constraint name, and so the defaults have somewhere to live. Nothing in the
 *   type system stops the two drifting, and the way they drift is that a later
 *   phase adds a movement type to the Prisma enum and to the CHECK and forgets
 *   this table — at which point `DIRECTION[type]` is `undefined`, the engine
 *   falls into its ADJUSTMENT branch, and a transfer starts demanding a reason
 *   code. So the coverage assertion below is the point of this file.
 */
import { DIRECTION } from '../../src/services/inventory/movement.service.js';
import { compareQuantities, parseQuantity, formatQuantity } from '@rcln/inventory';
import { readableQuantity, stockMovementType } from '@rcln/contracts';

describe('the direction table', () => {
  it('covers every movement type the ledger can hold', () => {
    /*
     * The contract's enum mirrors the Prisma one, and `pnpm validate` fails if
     * those two disagree — so asserting against it asserts against the database.
     */
    const declared = Object.keys(DIRECTION).sort();
    const inLedger = [...stockMovementType.options].sort();
    expect(declared).toEqual(inLedger);
  });

  it('pairs each type with exactly the direction the CHECK constraint allows', () => {
    /*
     * Written out rather than derived, because a derivation would be the same
     * mistake as the table it is checking. These are the four groups named in
     * the `stock_ledger_direction` constraint, transcribed from the migration.
     */
    expect(DIRECTION.PURCHASE_RECEIPT).toBe('ADD');
    expect(DIRECTION.TRANSFER_IN).toBe('ADD');
    expect(DIRECTION.RETURN).toBe('ADD');

    expect(DIRECTION.DISPENSING).toBe('REMOVE');
    expect(DIRECTION.CLINICAL_CONSUMPTION).toBe('REMOVE');
    expect(DIRECTION.TRANSFER_OUT).toBe('REMOVE');
    expect(DIRECTION.DISPOSAL).toBe('REMOVE');

    expect(DIRECTION.RESERVATION).toBe('MOVE');
    expect(DIRECTION.RELEASE).toBe('MOVE');
    expect(DIRECTION.EXPIRY).toBe('MOVE');
    expect(DIRECTION.RECALL).toBe('MOVE');
    expect(DIRECTION.QUARANTINE).toBe('MOVE');
    expect(DIRECTION.QUARANTINE_RELEASE).toBe('MOVE');
    expect(DIRECTION.DAMAGE).toBe('MOVE');

    expect(DIRECTION.ADJUSTMENT).toBe('EITHER');
  });

  /**
   * ⚠️ THE ONE THAT WOULD BE QUIETLY WRONG. `EXPIRY`, `DAMAGE` and `RECALL` are
   *   MOVES rather than REMOVALS, which is a deliberate refinement of the
   *   architecture doc's sign table. Expired stock has not left the building: it
   *   is on the shelf, undispensable, waiting to be destroyed, and it has to be
   *   counted and valued until it is. Writing it as a `−` would make it vanish
   *   from every count on the day it expired and leave the clinic unable to say
   *   what it is about to dispose of. `DISPOSAL` is the `−` that records the
   *   physical departure.
   */
  it('treats expiry, damage and recall as transfers between buckets, not removals', () => {
    for (const type of ['EXPIRY', 'DAMAGE', 'RECALL'] as const) {
      expect(DIRECTION[type]).toBe('MOVE');
    }
    expect(DIRECTION.DISPOSAL).toBe('REMOVE');
  });
});

describe('comparing quantities', () => {
  /**
   * ⚠️ THIS IS THE COMPARISON THE SUFFICIENCY CHECK RUNS, AND THE FLOAT VERSION
   *   PASSES EVERY OBVIOUS TEST. `Number('0.1') + Number('0.2')` is not `0.3`,
   *   and at eighteen digits a double has already lost the tail before any
   *   arithmetic happens. Two quantities differing by a millionth of a tablet
   *   compare EQUAL under `Number`, the check passes, and the balance goes
   *   negative into a CHECK constraint instead of into a clean 409.
   */
  it('separates two quantities a double cannot', () => {
    const a = '12345678901.000001';
    const b = '12345678901.000002';

    expect(Number(a) === Number(b)).toBe(true); // the bug this exists to prevent
    expect(compareQuantities(a, b)).toBe(-1);
    expect(compareQuantities(b, a)).toBe(1);
  });

  it('is exact on the classic float case', () => {
    expect(compareQuantities('0.3', '0.1')).toBe(1);
    // 0.1 + 0.2 as a decimal string is 0.3, and must not be "greater than".
    expect(compareQuantities('0.30000', '0.3')).toBe(0);
  });

  it('treats trailing zeros as the same quantity', () => {
    expect(compareQuantities('5', '5.000000')).toBe(0);
    expect(compareQuantities('0', '0.000000')).toBe(0);
  });

  it('handles the negative side, which the ledger stores on every issue', () => {
    expect(compareQuantities('-5', '5')).toBe(-1);
    expect(compareQuantities('-5', '-10')).toBe(1);
  });

  it('refuses something that is not a quantity rather than coercing it', () => {
    // `Number('')` is 0 and `Number('1e3')` is 1000; both would be silent.
    expect(() => compareQuantities('', '1')).toThrow();
    expect(() => compareQuantities('1e3', '1')).toThrow();
  });
});

describe('the ledger scale', () => {
  /**
   * `quantity_base` is `Decimal(18,6)`. A value needing a seventh place cannot
   * be stored, and `formatQuantity` says so through `exact` rather than rounding
   * silently — which is what `assertExactConversion` is then able to refuse.
   */
  it('reports a value that does not fit in six decimal places', () => {
    const third = parseQuantity('1');
    const result = formatQuantity({ n: third.n, d: 3n });
    expect(result.exact).toBe(false);
    expect(result.quantity).toBe('0.333333');
  });

  it('reports a value that fits exactly', () => {
    const result = formatQuantity(parseQuantity('2.5'));
    expect(result.exact).toBe(true);
    expect(result.quantity).toBe('2.500000');
  });
});

describe('rendering a quantity', () => {
  /**
   * ⚠️ THE CASE THAT SHIPPED BROKEN. The first version anchored the fraction
   *   with an OPTIONAL decimal point — `/\.?0+$/` — so on an integer it ate the
   *   trailing zeros of the number itself. Every quantity on every stock screen
   *   came out an order of magnitude small, and nothing failed: `1` is a
   *   perfectly plausible number to see where `100` belongs.
   *
   *   `apps/web` has no test suite, which is why this function does not live
   *   there any more.
   */
  it('leaves an integer alone', () => {
    expect(readableQuantity('100')).toBe('100');
    expect(readableQuantity('10')).toBe('10');
    expect(readableQuantity('500')).toBe('500');
    expect(readableQuantity('1000')).toBe('1000');
    expect(readableQuantity('-30')).toBe('-30');
    expect(readableQuantity('0')).toBe('0');
  });

  it('trims the ledger scale off a decimal', () => {
    expect(readableQuantity('100.000000')).toBe('100');
    expect(readableQuantity('12.500000')).toBe('12.5');
    expect(readableQuantity('0.100000')).toBe('0.1');
    expect(readableQuantity('-0.500000')).toBe('-0.5');
  });

  it('renders a zero as a zero rather than as nothing', () => {
    // The whole string trims away here, and `''` on a stock screen reads as a
    // missing value rather than as none.
    expect(readableQuantity('0.000000')).toBe('0');
    expect(readableQuantity('-0.000000')).toBe('0');
  });

  it('keeps a fraction that does not end in a zero', () => {
    expect(readableQuantity('0.333333')).toBe('0.333333');
    expect(readableQuantity('1.005')).toBe('1.005');
  });
});
