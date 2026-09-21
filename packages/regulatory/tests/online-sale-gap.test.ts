/**
 * The remote-supply gate (PI-12), tested the way `profile-gap.test.ts` is.
 *
 * ⚠️ THE FAIL-OPEN THIS CLOSES IS INVISIBLE IN EVERY OTHER TEST IN THIS PACKAGE,
 *   WHICH IS WHY IT SURVIVED PI-5 THROUGH PI-11. A real pack lists
 *   `ONLINE_DISPENSE` alongside `DISPENSE` on its prescription rules — it has to,
 *   or the prescription requirement stops applying the moment a medicine goes in
 *   a parcel — and the consequence is that a pack which says NOTHING about remote
 *   supply PERMITS it, on the strength of rules written about a counter. No rule
 *   refused; no rule was asked.
 *
 *   So the profile's own `online_sale_position` becomes decisive for exactly one
 *   transaction. It has existed since PI-5 and been read by nothing — the
 *   "configured, visible and inert" state this programme keeps finding.
 *
 * ⚠️ AND THE GATE MUST TOUCH NOTHING ELSE. Half the cases below exist to prove
 *   that a `DISPENSE`, a `COUNTER_SALE` and a `STOCK` movement are decided
 *   exactly as they were before — a gate that quietly refused counter supplies
 *   for want of an online position would be a worse bug than the one it closes.
 *
 * No country's rules appear here. `TESTLAND` again.
 */
import { evaluate, type RegulatoryRequest, type RegulatoryRule } from '../src/index.js';

const TODAY = new Date('2026-08-13T09:00:00Z');

/** A rule that applies to EVERY transaction and permits — the fail-open's engine. */
const permissive = (over: Partial<RegulatoryRule> = {}): RegulatoryRule => ({
  id: 'rule-retention',
  packId: 'pack-1',
  packVersion: '1.0.0',
  packMaturity: 'AUTOMATED_TESTED',
  jurisdiction: { countryCode: 'TL', regionCode: null },
  ruleType: 'RECORD_RETENTION',
  code: 'TL_RETAIN',
  statement: 'Supply records are kept for two years.',
  status: 'ACTIVE',
  appliesToProductType: null,
  appliesToCategoryId: null,
  appliesToClassification: null,
  appliesToTransactions: [],
  parameters: { detail: 'Keep the record for two years.' },
  sourceId: 'source-1',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});

const profile = (onlineSalePosition: string): RegulatoryRequest['profile'] => ({
  id: 'profile-1',
  jurisdiction: { countryCode: 'TL', regionCode: null },
  classification: 'POM',
  controlledSchedule: null,
  prescriptionRequirement: 'PRESCRIPTION_REQUIRED',
  registrationNumber: 'REG-1',
  registrationStatus: 'REGISTERED',
  onlineSalePosition,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
});

const request = (over: Partial<RegulatoryRequest> = {}): RegulatoryRequest => ({
  jurisdiction: { countryCode: 'TL', regionCode: null },
  transaction: 'ONLINE_DISPENSE',
  product: {
    id: 'product-1',
    type: 'MEDICINE',
    categoryPath: ['category-root'],
    compositionId: 'composition-1',
  },
  profile: profile('PERMITTED'),
  rules: [permissive()],
  actor: { roleCodes: ['pharmacy.dispense.create'], licenceTypes: ['PHARMACIST_REGISTRATION'] },
  quantityBase: '10',
  occurredAt: TODAY,
  prescription: {
    presented: true,
    signedByQualifiedPrescriber: true,
    issuedOn: new Date('2026-08-10T00:00:00Z'),
    refillsUsed: 0,
  },
  ...over,
});

describe('no product is onlineable by default', () => {
  it('refuses to decide a remote supply when the position is unstated', () => {
    const decision = evaluate(request({ profile: profile('UNKNOWN') }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]?.message).toContain('remotely');
    /* The engine raised it, so no rule is cited — the profile-gap shape. */
    expect(decision.reasons[0]?.ruleCode).toBeNull();
  });

  it('refuses to decide a remote supply for a product with no profile at all', () => {
    const decision = evaluate(request({ profile: null }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('no regulatory profile');
  });

  /**
   * ⚠️ `REFUSED` AND NOT `UNDETERMINED`, AND THE DIFFERENCE IS NOT COSMETIC.
   *   A refusal says somebody looked and the answer is no; `UNDETERMINED` says
   *   nobody has looked. Both stop the supply, and they send the clinic to two
   *   different places — one to their regulator, the other to the profile screen.
   */
  it('refuses outright when the position is PROHIBITED', () => {
    const decision = evaluate(request({ profile: profile('PROHIBITED') }));

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.message).toContain('may not be sent out');
  });

  /** An enum member nobody wired here fails CLOSED, which is why the field is a string. */
  it('treats an unrecognised position as unstated', () => {
    expect(evaluate(request({ profile: profile('SOMETHING_NEW') })).outcome).toBe('UNDETERMINED');
  });

  it('lets the rules decide once the position is PERMITTED', () => {
    const decision = evaluate(request({ profile: profile('PERMITTED') }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(decision.reasons[0]?.ruleCode).toBe('TL_RETAIN');
  });

  /**
   * ⚠️ `RESTRICTED` IS NOT A SECOND-CLASS PERMISSION. It means "permitted with
   *   conditions the rules state" — a tele-consult, an e-prescription — and those
   *   conditions are RULES. Excluding it here would refuse the case the member
   *   exists to describe and leave the rules expressing it inert, which is this
   *   programme's recurring failure shape.
   */
  it('lets the rules decide when the position is RESTRICTED', () => {
    expect(evaluate(request({ profile: profile('RESTRICTED') })).outcome).toBe(
      'PERMITTED_WITH_CONDITIONS'
    );
  });

  /**
   * ⚠️ THE FAIL-OPEN ITSELF, WRITTEN DOWN. Without the gate this exact request
   *   came back permitted: a rule that applies to every transaction, an
   *   `ONLINE_DISPENSE`, and nothing anywhere saying the product may be sent out.
   */
  it('does not permit a remote supply on the strength of a rule about the counter', () => {
    const counterRule = permissive({
      ruleType: 'PRESCRIPTION_REQUIRED',
      code: 'TL_POM',
      statement: 'This medicine may only be supplied against a prescription.',
      parameters: { required: true },
      appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    });

    const decision = evaluate(request({ profile: profile('UNKNOWN'), rules: [counterRule] }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

describe('the gate speaks to remote supply and to nothing else', () => {
  it.each(['DISPENSE', 'COUNTER_SALE', 'STOCK', 'TRANSFER', 'CONSUME', 'DISPOSE'] as const)(
    'leaves a %s decided by the rules, whatever the online position says',
    (transaction) => {
      for (const position of ['UNKNOWN', 'PROHIBITED', 'PERMITTED', 'RESTRICTED']) {
        const decision = evaluate(request({ transaction, profile: profile(position) }));
        expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
      }
    }
  );

  /**
   * ⚠️ AND IT DOES NOT RESCUE AN UNCONFIGURED JURISDICTION EITHER. A PERMITTED
   *   position with no applicable rule is still `UNDETERMINED` — the gate opens
   *   the question, it never answers it.
   */
  it('still refuses a remote supply where no rule applies', () => {
    const decision = evaluate(request({ profile: profile('PERMITTED'), rules: [] }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('No regulatory rule covers');
  });
});
