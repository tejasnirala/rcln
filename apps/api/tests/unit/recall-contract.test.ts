/**
 * PI-10 contracts: what the recall and traceability surface refuses to accept.
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE ONES ABOUT WHAT IS **ABSENT**. A recall
 *   request states no quantity and no batch status, and the trace queries demand
 *   exactly one subject. Each of those is a control that a well-meaning
 *   "convenience" field would silently remove — and none of them would fail any
 *   other test in this repository.
 *
 * No database, no HTTP.
 */
import {
  addRecallBatchesRequest,
  affectedPartyQuery,
  backwardTraceQuery,
  closeRecallRequest,
  createRecallRequest,
  forwardTraceQuery,
  resolveRecallBatchRequest,
} from '@rcln/contracts';

const BATCH = '11111111-1111-4111-8111-111111111111';
const SERIAL = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

describe('the notice', () => {
  const valid = {
    productId: PRODUCT,
    title: 'Contamination in this run',
    source: 'MANUFACTURER' as const,
    reason: 'Sterility failure reported.',
  };

  it('accepts a notice with no lots yet', () => {
    /*
     * ⚠️ AN EMPTY SCOPE IS VALID AND THAT IS DELIBERATE. A notice arrives before
     *   anybody has walked the shelves; refusing to record it until the scope is
     *   complete is how a notice ends up on a sticky note.
     */
    const parsed = createRecallRequest.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.classification).toBe('UNCLASSIFIED');
  });

  it('demands a reason that is not whitespace', () => {
    expect(createRecallRequest.safeParse({ ...valid, reason: '   ' }).success).toBe(false);
  });

  /**
   * ⚠️ THE FIELD THAT MUST NEVER EXIST. Executing a recall moves whatever is in
   *   the AVAILABLE bucket at the moment the transaction runs, read inside it. A
   *   caller-supplied figure would be a number from a screen somebody opened ten
   *   minutes ago, and PI-ADR-004 says the ledger is the only source of quantity
   *   truth. Zod strips unknown keys, so this asserts the field is DROPPED rather
   *   than honoured — the case that fails the day somebody adds it back.
   */
  it('drops a quantity if a client sends one', () => {
    const parsed = createRecallRequest.safeParse({ ...valid, quantityToHold: '85' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('quantityToHold');
  });

  /** And the same for a lot status, which is the RESULT of a movement. */
  it('drops a batch status if a client sends one', () => {
    const parsed = createRecallRequest.safeParse({ ...valid, batchStatus: 'RECALLED' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('batchStatus');
  });

  it('wants at least one lot when lots are named at all', () => {
    expect(addRecallBatchesRequest.safeParse({ batchIds: [] }).success).toBe(false);
    expect(addRecallBatchesRequest.safeParse({ batchIds: [BATCH] }).success).toBe(true);
  });
});

describe('resolving and closing', () => {
  it('demands a reason for a lot leaving a recall', () => {
    expect(resolveRecallBatchRequest.safeParse({ resolution: 'RELEASE' }).success).toBe(false);
    expect(resolveRecallBatchRequest.safeParse({ resolution: 'RELEASE', note: '  ' }).success).toBe(
      false
    );
    expect(
      resolveRecallBatchRequest.safeParse({ resolution: 'DISPOSE', note: 'Destroyed.' }).success
    ).toBe(true);
  });

  /**
   * ⚠️ "CLOSED" IS NOT AN OUTCOME, AND THIS IS THE FIELD A CLINIC WILL WANT TO
   *   SKIP. What was found, and who was contacted, is what a regulator asks for.
   */
  it('demands an outcome when a notice ends', () => {
    expect(closeRecallRequest.safeParse({ outcomeNote: '' }).success).toBe(false);
    expect(closeRecallRequest.safeParse({ outcomeNote: 'Seventeen contacted.' }).success).toBe(
      true
    );
  });
});

describe('the trace queries', () => {
  /**
   * ⚠️ EXACTLY ONE SUBJECT. Neither would make the service invent a default;
   *   both would make it silently prefer one, and "why does tracing serial 7742
   *   return the whole lot's history" is a question nobody would think to ask —
   *   a lot-wide answer names people who received a different unit.
   */
  it.each([forwardTraceQuery, backwardTraceQuery])(
    'wants one subject, not two or none',
    (schema) => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ batchId: BATCH, serialId: SERIAL }).success).toBe(false);
      expect(schema.safeParse({ batchId: BATCH }).success).toBe(true);
      expect(schema.safeParse({ serialId: SERIAL }).success).toBe(true);
    }
  );

  /**
   * ⚠️ AND THE PHI ONE REFUSES AN UNFILTERED READ OUTRIGHT. Without a subject
   *   this would be "every patient who has ever received anything traceable",
   *   which is not a recall question and is the single largest disclosure this
   *   platform could serve.
   */
  it('refuses an affected-party read with no subject', () => {
    expect(affectedPartyQuery.safeParse({}).success).toBe(false);
    expect(affectedPartyQuery.safeParse({ batchId: BATCH, serialId: SERIAL }).success).toBe(false);
    expect(affectedPartyQuery.safeParse({ batchId: BATCH }).success).toBe(true);
  });
});
