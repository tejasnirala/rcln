/**
 * The fail-open that a configured jurisdiction opens, and the guard that closes
 * it.
 *
 * ⚠️ EVERY CASE HERE PASSED — WRONGLY — BEFORE THE GUARD EXISTED, AND THAT IS
 *   WHY THE FILE IS SEPARATE. `coversProduct` drops a classification-keyed rule
 *   when the product has no profile, which the schema comment correctly calls
 *   "not a permission" — while nothing else applies. A real pack always has
 *   rules that apply to EVERY product (a retention obligation, a "who may
 *   dispense" rule), those rules permit, and an unclassified prescription-only
 *   medicine came back `PERMITTED_WITH_CONDITIONS` with no prescription rule
 *   anywhere in its reasons. The decision looked fully reasoned, which is
 *   exactly why nobody would have caught it in review.
 *
 * PI-5 could not see this: with no pack configured anywhere, every request took
 * the "no applicable rules" path and answered `UNDETERMINED` regardless. PI-6 is
 * the first phase where a jurisdiction has rules of both kinds at once.
 *
 * No country appears here. `TL` is fictional, as in `engine.test.ts`.
 */
import { evaluate, type RegulatoryRequest, type RegulatoryRule } from '../src/index.js';

const TODAY = new Date('2026-08-13T09:00:00Z');

const rule = (over: Partial<RegulatoryRule> = {}): RegulatoryRule => ({
  id: `rule-${Math.random().toString(36).slice(2)}`,
  packId: 'pack-1',
  packVersion: '1.0.0',
  packMaturity: 'AUTOMATED_TESTED',
  jurisdiction: { countryCode: 'TL', regionCode: null },
  ruleType: 'PRESCRIPTION_REQUIRED',
  code: 'TL_POM',
  statement: 'This medicine may only be supplied against a prescription.',
  status: 'ACTIVE',
  appliesToProductType: null,
  appliesToCategoryId: null,
  appliesToClassification: null,
  appliesToTransactions: [],
  parameters: { required: true },
  sourceId: 'source-1',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});

const request = (over: Partial<RegulatoryRequest> = {}): RegulatoryRequest => ({
  jurisdiction: { countryCode: 'TL', regionCode: null },
  transaction: 'DISPENSE',
  product: {
    id: 'product-1',
    type: 'MEDICINE',
    categoryPath: ['category-root'],
    compositionId: null,
  },
  profile: null,
  rules: [],
  actor: { roleCodes: ['PHARMACIST'], licenceTypes: ['PHARMACIST_REGISTRATION'] },
  quantityBase: '10',
  occurredAt: TODAY,
  ...over,
});

/** A rule that speaks about a schedule — the kind that needs a profile to match. */
const scheduleRule = rule({
  code: 'TL_SCHEDULED_RX',
  appliesToClassification: 'SCHEDULE_A',
  appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
  parameters: { required: true },
});

/** A rule that applies to everything — the kind every real pack carries. */
const retentionRule = rule({
  code: 'TL_RETENTION',
  ruleType: 'RECORD_RETENTION',
  statement: 'Keep the register for two years.',
  appliesToTransactions: [],
  parameters: { years: 2, detail: 'Keep the register for two years.' },
});

describe('a medicine nobody has classified is not a medicine anybody may supply', () => {
  it('is UNDETERMINED even though an unrelated rule applies and permits', () => {
    const decision = evaluate(request({ rules: [scheduleRule, retentionRule] }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.conditions).toEqual([]);
    expect(decision.reasons[0]?.message).toContain('has none recorded');
  });

  it('names the remedy, because a gap somebody can close is not the same as a refusal', () => {
    const decision = evaluate(request({ rules: [scheduleRule, retentionRule] }));

    expect(decision.reasons[0]?.message).toContain('Record its regulatory profile');
  });

  it('is UNDETERMINED for a counter sale too, not only a dispense', () => {
    const decision = evaluate(
      request({ transaction: 'COUNTER_SALE', rules: [scheduleRule, retentionRule] })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('is UNDETERMINED when a profile exists but records no classification', () => {
    const decision = evaluate(
      request({
        rules: [scheduleRule, retentionRule],
        profile: {
          id: 'profile-1',
          jurisdiction: { countryCode: 'TL', regionCode: null },
          classification: null,
          controlledSchedule: null,
          prescriptionRequirement: 'UNKNOWN',
          registrationNumber: null,
          registrationStatus: 'UNKNOWN',
          onlineSalePosition: 'UNKNOWN',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
        },
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

describe('the guard is narrow, so it does not make ordinary supply undecidable', () => {
  it('leaves a classified product alone', () => {
    const decision = evaluate(
      request({
        rules: [scheduleRule, retentionRule],
        profile: {
          id: 'profile-1',
          jurisdiction: { countryCode: 'TL', regionCode: null },
          classification: 'SCHEDULE_A',
          controlledSchedule: null,
          prescriptionRequirement: 'PRESCRIPTION_REQUIRED',
          registrationNumber: null,
          registrationStatus: 'REGISTERED',
          onlineSalePosition: 'UNKNOWN',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
        },
      })
    );

    // The schedule rule now matches and refuses for want of a prescription —
    // a REFUSAL, not an unknown. The distinction is the whole point.
    expect(decision.outcome).toBe('REFUSED');
  });

  it('does not touch a product type nobody classifies, like a consumable', () => {
    const decision = evaluate(
      request({
        product: {
          id: 'product-2',
          type: 'CONSUMABLE',
          categoryPath: ['category-root'],
          compositionId: null,
        },
        rules: [scheduleRule, retentionRule],
      })
    );

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('does not fire when the jurisdiction has no classification-keyed rule at all', () => {
    const decision = evaluate(request({ rules: [retentionRule] }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('does not fire on a classification rule aimed at another product type', () => {
    const vetOnly = rule({
      code: 'TL_VET_SCHEDULED',
      appliesToClassification: 'SCHEDULE_A',
      appliesToProductType: 'VETERINARY_MEDICINE',
      appliesToTransactions: ['DISPENSE'],
    });

    const decision = evaluate(request({ rules: [vetOnly, retentionRule] }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('does not fire on a classification rule that is not in force today', () => {
    const expired = rule({
      code: 'TL_OLD_SCHEDULED',
      appliesToClassification: 'SCHEDULE_A',
      appliesToTransactions: ['DISPENSE'],
      effectiveTo: new Date('2026-01-31T00:00:00Z'),
    });

    const decision = evaluate(request({ rules: [expired, retentionRule] }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('does not fire on a classification rule that speaks to another transaction', () => {
    const stockOnly = rule({
      code: 'TL_STOCK_ONLY',
      ruleType: 'LABELLING_REQUIREMENT',
      appliesToClassification: 'SCHEDULE_A',
      appliesToTransactions: ['STOCK'],
      parameters: { detail: 'Check the label.' },
    });

    const decision = evaluate(request({ rules: [stockOnly, retentionRule] }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('still answers when nothing at all is configured, unchanged from before', () => {
    const decision = evaluate(request({ rules: [] }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('No regulatory rule covers');
  });
});
