/**
 * FEFO allocation: the ordering, the ties, and the shortfall (PI-3.5, PI-3.7).
 *
 * ⚠️ THIS IS THE FILE THE PURE FUNCTION EXISTS FOR. An ordering rule is wrong in
 *   a way no integration test notices — a tie broken the wrong way dispenses the
 *   second-oldest lot, which looks entirely normal on every screen until an audit
 *   asks why the oldest one expired on the shelf. Nothing errors, nothing looks
 *   odd, and the fixture that would have caught it is the one with two lots
 *   expiring on the same day, which nobody writes by accident.
 *
 * So every tie, every null and every shortfall is written out here.
 */
import { orderCandidates, planAllocation, resolveStrategy } from '@rcln/inventory';
import type { AllocationCandidate } from '@rcln/inventory';

/** A candidate with sensible defaults, so each test states only what it means. */
function lot(partial: Partial<AllocationCandidate> & { batchId: string }): AllocationCandidate {
  return {
    locationId: 'loc-1',
    serialId: null,
    availableQuantityBase: '100',
    expiresOn: null,
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const ids = (candidates: AllocationCandidate[]): (string | null)[] =>
  candidates.map((c) => c.batchId);

describe('FEFO ordering', () => {
  it('puts the soonest expiry first', () => {
    const ordered = orderCandidates(
      [
        lot({ batchId: 'march', expiresOn: '2027-03-01' }),
        lot({ batchId: 'january', expiresOn: '2027-01-01' }),
        lot({ batchId: 'february', expiresOn: '2027-02-01' }),
      ],
      'FEFO'
    );

    expect(ids(ordered)).toEqual(['january', 'february', 'march']);
  });

  /**
   * ⚠️ THE ONE THE ARCHITECTURE DOC NAMES, AND THE ONE A NAIVE COMPARATOR GETS
   *   RIGHT BY ACCIDENT AND THEN LOSES. Two lots expiring the same day are
   *   ordered by when they ARRIVED, oldest first — the lot that has been on the
   *   shelf longer is the one an auditor expects to have gone.
   */
  it('breaks a tie on the same expiry day by arrival, oldest first', () => {
    const ordered = orderCandidates(
      [
        lot({ batchId: 'newer', expiresOn: '2027-01-01', receivedAt: '2026-06-01T00:00:00.000Z' }),
        lot({ batchId: 'older', expiresOn: '2027-01-01', receivedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      'FEFO'
    );

    expect(ids(ordered)).toEqual(['older', 'newer']);
  });

  /**
   * ⚠️ THE BUG THIS REPOSITORY HAS ALREADY SHIPPED ONCE, IN THE OTHER DIRECTION.
   *   Postgres sorts NULLs FIRST on ASC and the naive JavaScript comparison does
   *   the same, so a lot that NEVER EXPIRES heads the list of "what expires
   *   soonest" — and the clinic empties its non-expiring stock while the
   *   expiring stock quietly expires. `listBatches` spells `nulls: 'last'` out
   *   for exactly this reason; so does the comparator.
   */
  it('sorts a lot with no expiry LAST, not first', () => {
    const ordered = orderCandidates(
      [
        lot({ batchId: 'never', expiresOn: null }),
        lot({ batchId: 'soon', expiresOn: '2027-01-01' }),
        lot({ batchId: 'later', expiresOn: '2029-01-01' }),
      ],
      'FEFO'
    );

    expect(ids(ordered)).toEqual(['soon', 'later', 'never']);
  });

  /**
   * ⚠️ TWO CANDIDATES IDENTICAL ON EVERY SORT KEY MUST STILL HAVE ONE ORDER, AND
   *   THIS IS WHY THE COMPARATOR ENDS IN AN ID. `Array.sort` is stable, so an
   *   incomplete comparator does not randomise — it preserves THE ORDER THE ROWS
   *   ARRIVED IN, which is whatever the database's plan was that day. The plan
   *   changes as the table grows, and a clinic that has been dispensing one lot
   *   first for a year silently starts dispensing the other, with no code change
   *   and no error anywhere.
   */
  it('is deterministic when two candidates agree on every sort key', () => {
    const a = lot({ batchId: 'a', locationId: 'loc-a', expiresOn: '2027-01-01' });
    const b = lot({ batchId: 'b', locationId: 'loc-b', expiresOn: '2027-01-01' });

    expect(ids(orderCandidates([a, b], 'FEFO'))).toEqual(ids(orderCandidates([b, a], 'FEFO')));
  });

  it('orders by arrival under FIFO, ignoring expiry entirely', () => {
    const ordered = orderCandidates(
      [
        lot({
          batchId: 'expires-first',
          expiresOn: '2027-01-01',
          receivedAt: '2026-06-01T00:00:00.000Z',
        }),
        lot({
          batchId: 'arrived-first',
          expiresOn: '2029-01-01',
          receivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      'FIFO'
    );

    expect(ids(ordered)).toEqual(['arrived-first', 'expires-first']);
  });

  it('reverses that under LIFO', () => {
    const ordered = orderCandidates(
      [
        lot({ batchId: 'old', receivedAt: '2026-01-01T00:00:00.000Z' }),
        lot({ batchId: 'new', receivedAt: '2026-06-01T00:00:00.000Z' }),
      ],
      'LIFO'
    );

    expect(ids(ordered)).toEqual(['new', 'old']);
  });
});

describe('the allocation plan', () => {
  it('takes everything from one bucket when it covers the demand', () => {
    const plan = planAllocation(
      [lot({ batchId: 'only', availableQuantityBase: '100' })],
      '40',
      'FEFO'
    );

    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]?.quantityBase).toBe('40.000000');
    expect(plan.shortfallQuantityBase).toBe('0.000000');
  });

  /**
   * ⚠️ EVERY QUANTITY COMES BACK ON THE LEDGER'S SCALE, INCLUDING THE ONES TAKEN
   *   WHOLE FROM A BUCKET. The first version normalised only the quantities that
   *   went through the subtraction, so one plan carried `30` and `15.000000`
   *   side by side — invisible on screen, because `readableQuantity` trims both
   *   to the same thing, and a trap for anything that compares two of them.
   */
  it('spans buckets in FEFO order, taking a partial from the last', () => {
    const plan = planAllocation(
      [
        lot({ batchId: 'later', expiresOn: '2027-06-01', availableQuantityBase: '30' }),
        lot({ batchId: 'sooner', expiresOn: '2027-01-01', availableQuantityBase: '30' }),
      ],
      '45',
      'FEFO'
    );

    expect(plan.lines.map((l) => [l.candidate.batchId, l.quantityBase])).toEqual([
      ['sooner', '30.000000'],
      ['later', '15.000000'],
    ]);
    expect(plan.allocatedQuantityBase).toBe('45.000000');
    expect(plan.shortfallQuantityBase).toBe('0.000000');
  });

  /**
   * ⚠️ A SHORTFALL IS AN ANSWER, NOT AN ERROR, AND THE PARTIAL PLAN COMES WITH
   *   IT. "The clinic holds 12 and you asked for 20" is what the dispensing
   *   screen has to show — WITH the 12 it can give out, so a pharmacist can
   *   dispense a partial supply and order the rest. Throwing would make the
   *   useful half of that answer unreachable.
   */
  it('returns what it can plus a shortfall, rather than throwing', () => {
    const plan = planAllocation(
      [lot({ batchId: 'thin', availableQuantityBase: '12' })],
      '20',
      'FEFO'
    );

    expect(plan.allocatedQuantityBase).toBe('12.000000');
    expect(plan.shortfallQuantityBase).toBe('8.000000');
    expect(plan.lines).toHaveLength(1);
  });

  /**
   * ⚠️ A ZERO BUCKET IS SKIPPED RATHER THAN EMITTED AS A ZERO LINE. A fully
   *   issued bucket leaves a `0` row behind — the trigger only ever adds — and a
   *   line of zero is a line the commit then refuses, which is a 409 on a plan
   *   the screen had already shown as fine.
   */
  it('skips buckets holding nothing', () => {
    const plan = planAllocation(
      [
        lot({ batchId: 'empty', expiresOn: '2027-01-01', availableQuantityBase: '0' }),
        lot({ batchId: 'real', expiresOn: '2027-06-01', availableQuantityBase: '10' }),
      ],
      '5',
      'FEFO'
    );

    expect(plan.lines.map((l) => l.candidate.batchId)).toEqual(['real']);
  });

  it('plans nothing at all when there is nothing to plan from', () => {
    const plan = planAllocation([], '10', 'FEFO');

    expect(plan.lines).toEqual([]);
    expect(plan.allocatedQuantityBase).toBe('0.000000');
    expect(plan.shortfallQuantityBase).toBe('10.000000');
  });

  /**
   * ⚠️ SIX DECIMAL PLACES SURVIVE THE SUBTRACTION. The remaining quantity is
   *   carried through the loop as a decimal STRING and subtracted over
   *   rationals; a float would have lost the tail by the third bucket, and the
   *   shortfall a pharmacist reads would be off by a millionth that compounds
   *   into a bucket the commit refuses.
   */
  it('subtracts exactly, without going through a float', () => {
    const plan = planAllocation(
      [
        lot({ batchId: 'a', expiresOn: '2027-01-01', availableQuantityBase: '0.1' }),
        lot({ batchId: 'b', expiresOn: '2027-02-01', availableQuantityBase: '0.2' }),
      ],
      '0.3',
      'FEFO'
    );

    expect(plan.shortfallQuantityBase).toBe('0.000000');
    expect(plan.allocatedQuantityBase).toBe('0.300000');
  });
});

describe('resolving which strategy applies', () => {
  /**
   * ⚠️ NULL ON THE PRODUCT IS NOT THE SAME AS AN EXPLICIT `FEFO`, AND THE
   *   `source` IS WHY THE DISTINCTION IS KEPT. NULL is "this clinic has never
   *   thought about it", which PI-5's rule packs may override; an explicit FEFO
   *   is a decision somebody made, which a rule pack must not quietly overturn.
   *   Collapsing them makes "why did it pick that lot" unanswerable in exactly
   *   the cases where it is asked.
   */
  it('reports where the strategy came from', () => {
    expect(resolveStrategy('LIFO', 'FIFO')).toEqual({ strategy: 'LIFO', source: 'REQUEST' });
    expect(resolveStrategy(null, 'FIFO')).toEqual({ strategy: 'FIFO', source: 'PRODUCT' });
    expect(resolveStrategy(null, null)).toEqual({ strategy: 'FEFO', source: 'DEFAULT' });
    expect(resolveStrategy(undefined, 'FEFO')).toEqual({ strategy: 'FEFO', source: 'PRODUCT' });
  });
});
