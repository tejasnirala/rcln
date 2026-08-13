/**
 * The gate that decides whether a regulatory decision may stop a document.
 *
 * ⚠️ THE CASE THIS FILE EXISTS FOR IS THE ONE WHERE THE ANSWER IS "NO". Exactly
 *   one country has a rule pack, so almost every evaluation on the platform is
 *   `UNDETERMINED` — which refuses. A gate that let those through to the receipt
 *   path would stop every clinic outside that country from receiving stock, and
 *   it would look like a regulatory feature working correctly.
 *
 * ⚠️ AND THE SECOND CASE IS THAT LOOSENING THE THRESHOLD MUST BREAK A TEST.
 *   `PRODUCTION_ENABLED` is the only maturity no code path may set — it is a
 *   named human deciding the platform may act on a jurisdiction. Enforcement
 *   turning on one rung earlier would mean seeding a pack also switched on
 *   refusals for every clinic in that country, silently.
 */
import type { RegulatoryDecisionResponse } from '@rcln/contracts';
import {
  ENFORCING_MATURITY,
  blocks,
  isBlockingOutcome,
  isEnforceable,
  summarise,
} from '../../src/services/regulatory/enforcement.js';

const decision = (over: Partial<RegulatoryDecisionResponse> = {}): RegulatoryDecisionResponse =>
  ({
    outcome: 'REFUSED',
    conditions: [],
    reasons: [
      {
        ruleId: 'rule-1',
        ruleCode: 'XX-RULE',
        ruleType: 'PRESCRIPTION_REQUIRED',
        packId: 'pack-1',
        packVersion: '1.0.0',
        outcome: 'REFUSED',
        message: 'Obtain a prescription before supplying this.',
      },
    ],
    packVersionIds: ['pack-1'],
    lowestPackMaturity: 'RULES_IMPLEMENTED',
    jurisdiction: 'XX',
    hasProfile: true,
    evaluatedAt: '2026-08-13T00:00:00.000Z',
    ...over,
  }) as RegulatoryDecisionResponse;

describe('which outcomes would stop a document', () => {
  it.each(['REFUSED', 'UNDETERMINED'] as const)('treats %s as blocking', (outcome) => {
    expect(isBlockingOutcome(outcome)).toBe(true);
  });

  it.each(['PERMITTED', 'PERMITTED_WITH_CONDITIONS'] as const)('lets %s through', (outcome) => {
    expect(isBlockingOutcome(outcome)).toBe(false);
  });
});

describe('a pack nobody has signed off cannot refuse anything', () => {
  it.each([
    'ARCHITECTURE_SUPPORTED',
    'RULES_CONFIGURED',
    'RULES_IMPLEMENTED',
    'AUTOMATED_TESTED',
    'SOURCE_VERIFIED',
    'REGULATORY_REVIEW_PENDING',
    'REGULATORY_REVIEWED',
  ] as const)('does not enforce at %s, even on a REFUSED decision', (maturity) => {
    expect(blocks(decision({ lowestPackMaturity: maturity }))).toBe(false);
  });

  it('does not enforce when no pack contributed at all', () => {
    // The unconfigured-jurisdiction case: UNDETERMINED with nothing behind it.
    expect(
      blocks(
        decision({
          outcome: 'UNDETERMINED',
          lowestPackMaturity: null,
          packVersionIds: [],
        })
      )
    ).toBe(false);
  });

  it('enforces once a human has signed the pack off', () => {
    expect(blocks(decision({ lowestPackMaturity: ENFORCING_MATURITY }))).toBe(true);
  });

  it('still does not block a permitted decision from a signed-off pack', () => {
    expect(blocks(decision({ outcome: 'PERMITTED', lowestPackMaturity: ENFORCING_MATURITY }))).toBe(
      false
    );
  });

  it('reads the WEAKEST contributing pack, so an unreviewed rule cannot ride along', () => {
    /*
     * A national pack somebody signed off plus a state pack nobody has read is
     * only as trustworthy as the state one. `lowestPackMaturity` is what the
     * engine reports for exactly this reason.
     */
    expect(isEnforceable(decision({ lowestPackMaturity: 'RULES_CONFIGURED' }))).toBe(false);
  });
});

describe('what gets logged about a decision', () => {
  it('carries the rule codes that did not permit, and no product name', () => {
    const summary = summarise(decision(), 'product-1');

    expect(summary.ruleCodes).toEqual(['XX-RULE']);
    expect(summary.productId).toBe('product-1');
    expect(summary.enforced).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('prescription');
  });

  it('leaves out the rules that permitted, so the line names what objected', () => {
    const summary = summarise(
      decision({
        outcome: 'UNDETERMINED',
        reasons: [
          {
            ruleId: 'r1',
            ruleCode: 'XX-OK',
            ruleType: 'RECORD_RETENTION',
            packId: 'pack-1',
            packVersion: '1.0.0',
            outcome: 'PERMITTED',
            message: 'fine',
          },
          {
            ruleId: 'r2',
            ruleCode: 'XX-NO',
            ruleType: 'STORAGE_REQUIREMENT',
            packId: 'pack-1',
            packVersion: '1.0.0',
            outcome: 'REFUSED',
            message: 'no',
          },
        ] as never,
      }),
      'product-1'
    );

    expect(summary.ruleCodes).toEqual(['XX-NO']);
  });
});
