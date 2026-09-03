/**
 * The permitting paths, and the ways each of them used to permit by accident.
 *
 * ⚠️ EVERY CASE HERE IS A REGRESSION GUARD FOR A DEFECT THAT WAS LIVE, AND
 *   EVERY ONE OF THEM FAILED OPEN. That asymmetry is the point: a rule that
 *   refuses too much is found the same afternoon by whoever cannot dispense, and
 *   a rule that permits too much is found by an inspector. The PI-24 review
 *   found these by RUNNING the engine against the shipped packs rather than by
 *   reading the rules, which is why none of them had a test — each one produced
 *   a well-formed, plausible, fully-reasoned decision that happened to be wrong.
 *
 * `TESTLAND` throughout, as in `engine.test.ts` — nothing here is a legal
 * position on anywhere real.
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
    compositionId: 'composition-1',
  },
  profile: {
    id: 'profile-1',
    jurisdiction: { countryCode: 'TL', regionCode: null },
    classification: 'POM',
    controlledSchedule: null,
    prescriptionRequirement: 'PRESCRIPTION_REQUIRED',
    registrationNumber: 'REG-1',
    registrationStatus: 'REGISTERED',
    onlineSalePosition: 'UNKNOWN',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
  },
  rules: [],
  actor: { roleCodes: ['PHARMACIST'], licenceTypes: ['PHARMACIST_REGISTRATION'] },
  quantityBase: '10',
  occurredAt: TODAY,
  ...over,
});

const validPrescription = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date('2026-08-10T00:00:00Z'),
  refillsUsed: 0,
};

/* ------------------------------------------------------------------ *
 * A classification nobody here recognises
 * ------------------------------------------------------------------ */

describe('a classification this jurisdiction does not recognise', () => {
  /**
   * ⚠️ THE DEFECT THIS PINS WAS ONE TYPO WIDE AND FOUR PACKS DEEP. The guard
   *   asked whether the product had A classification, never whether it had one
   *   that means anything here. So `Schedule H` instead of `SCHEDULE_H` dropped
   *   every classification-keyed rule on `coversProduct`'s exact match, while
   *   the pack's UNCLASSIFIED rules — retention, labelling, who may dispense,
   *   which every real pack carries — still applied and still permitted. The
   *   supply came back PERMITTED_WITH_CONDITIONS with no prescription rule in
   *   its reasons, and looked completely reasoned.
   */
  const prescriptionRule = rule({
    code: 'TL_RX_SCHEDULE_H',
    appliesToClassification: 'SCHEDULE_H',
    parameters: { required: true },
  });
  const retention = rule({
    code: 'TL_RETAIN',
    ruleType: 'RECORD_RETENTION',
    appliesToClassification: null,
    statement: 'Keep the record for two years.',
    parameters: { detail: 'Keep the record for two years.', retentionYears: 2 },
  });

  it('refuses rather than falling through to the pack’s unclassified rules', () => {
    const decision = evaluate(
      request({
        profile: { ...request().profile!, classification: 'Schedule H' },
        rules: [prescriptionRule, retention],
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons.map((r) => r.ruleCode)).not.toContain('TL_RETAIN');
  });

  it('says the classification is unreadable, not that it is missing', () => {
    const decision = evaluate(
      request({
        profile: { ...request().profile!, classification: 'Schedule H' },
        rules: [prescriptionRule, retention],
      })
    );

    expect(decision.reasons[0]?.message).toContain('Schedule H');
    expect(decision.reasons[0]?.message).toContain('does not recognise');
  });

  it('still permits a classification the pack does name', () => {
    const decision = evaluate(
      request({
        profile: { ...request().profile!, classification: 'SCHEDULE_H' },
        rules: [prescriptionRule, retention],
        prescription: validPrescription,
      })
    );

    expect(decision.outcome).not.toBe('UNDETERMINED');
    expect(decision.reasons.map((r) => r.ruleCode)).toContain('TL_RX_SCHEDULE_H');
  });

  it('leaves a pack with no classified rules alone', () => {
    /* Nothing here is keyed on a classification, so there is no vocabulary to
     * be outside of and the obligation applies as written. */
    const decision = evaluate(
      request({
        profile: { ...request().profile!, classification: 'ANYTHING_AT_ALL' },
        rules: [retention],
      })
    );

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });
});

/* ------------------------------------------------------------------ *
 * An empty list is not "no opinion"
 * ------------------------------------------------------------------ */

describe('an empty parameter list is refused rather than obeyed', () => {
  /**
   * Each of these used to parse, and each then disabled the limb it belongs to
   * — the guards all test `=== undefined`, which `[]` walks straight past.
   */
  const cases: [string, Partial<RegulatoryRule>][] = [
    [
      'traceability with no identifiers',
      {
        ruleType: 'TRACEABILITY_REQUIREMENT',
        parameters: { requiredIdentifiers: [] },
      },
    ],
    [
      'a controlled schedule that may be kept nowhere in particular',
      {
        ruleType: 'CONTROLLED_SCHEDULE',
        parameters: { scheduleName: 'Schedule 8', storageLocationKinds: [] },
      },
    ],
    [
      'a species restriction prohibiting nobody',
      {
        ruleType: 'SPECIES_RESTRICTION',
        parameters: { prohibitedSubjectTypes: [] },
      },
    ],
    [
      'an online rule with no destinations',
      {
        ruleType: 'ONLINE_DISPENSING',
        parameters: { permitted: true, destinationCountryCodes: [] },
      },
    ],
    [
      'a substitution rule excluding nothing',
      {
        ruleType: 'SUBSTITUTION',
        parameters: { permitted: true, excludedClassifications: [] },
      },
    ],
    [
      'a label with no particulars',
      {
        ruleType: 'LABELLING_REQUIREMENT',
        parameters: { detail: 'Label it.', fields: [] },
      },
    ],
    [
      'a storage rule checking no location',
      {
        ruleType: 'STORAGE_REQUIREMENT',
        parameters: { locationKinds: [] },
      },
    ],
  ];

  it.each(cases)('refuses to read %s', (_name, over) => {
    const decision = evaluate(request({ rules: [rule({ code: 'TL_EMPTY', ...over })] }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('empty list');
  });

  it('and the controlled-schedule case cannot sneak past the informational guard', () => {
    /*
     * ⚠️ THE SIDE DOOR. `imposesNothing` is computed from
     * `storageLocationKinds === undefined`, so `[]` read as "imposes an
     * obligation", skipped the informational branch, and then imposed nothing —
     * `AU-SCHEDULE-S8` reopened by a different route.
     */
    const decision = evaluate(
      request({
        transaction: 'STOCK',
        rules: [
          rule({
            code: 'TL_S8',
            ruleType: 'CONTROLLED_SCHEDULE',
            parameters: { scheduleName: 'Schedule 8', storageLocationKinds: [] },
          }),
        ],
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * informationalOnly
 * ------------------------------------------------------------------ */

describe('an informational controlled-schedule rule', () => {
  const informational = (parameters: Record<string, unknown>): RegulatoryRule =>
    rule({ code: 'TL_SCHEDULE', ruleType: 'CONTROLLED_SCHEDULE', parameters });

  it('permits, imposes nothing, and names the schedule', () => {
    const decision = evaluate(
      request({
        rules: [informational({ scheduleName: 'Schedule 8', informationalOnly: true })],
      })
    );

    expect(decision.outcome).toBe('PERMITTED');
    expect(decision.conditions).toHaveLength(0);
    expect(decision.reasons[0]?.message).toContain('Schedule 8');
  });

  it('refuses to be informational AND impose an obligation', () => {
    const decision = evaluate(
      request({
        rules: [
          informational({
            scheduleName: 'Schedule 8',
            informationalOnly: true,
            registerRequired: true,
          }),
        ],
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('refuses to be informational with no schedule to name', () => {
    const decision = evaluate(request({ rules: [informational({ informationalOnly: true })] }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('still refuses an obligation-free rule that does NOT say it is informational', () => {
    /* The regression guard for the whole mechanism: the flag is an explicit
     * opt-out, and a mistyped `registerRequired` must keep failing closed. */
    const decision = evaluate(request({ rules: [informational({ scheduleName: 'Schedule 8' })] }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Where a controlled drug may be kept
 * ------------------------------------------------------------------ */

describe('a controlled schedule that names where it may be kept', () => {
  const locked = rule({
    code: 'TL_S8_STORE',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement: 'A Schedule 8 drug is kept in a locked cabinet.',
    parameters: { scheduleName: 'Schedule 8', storageLocationKinds: ['CONTROLLED_CABINET'] },
  });

  it('refuses a receipt onto an ordinary shelf', () => {
    const decision = evaluate(
      request({
        transaction: 'STOCK',
        rules: [locked],
        location: { kind: 'SHELF', hasControlledAccess: false },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('refuses a TRANSFER onto one too, which it used not to check at all', () => {
    /*
     * ⚠️ `evaluateStorageRequirement` checked STOCK and TRANSFER; this handler
     *   checked only STOCK. So a pack carrying the controlled-schedule form and
     *   not the storage form let a controlled drug be moved onto an open shelf.
     */
    const decision = evaluate(
      request({
        transaction: 'TRANSFER',
        rules: [locked],
        location: { kind: 'SHELF', hasControlledAccess: false },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('permits the cabinet', () => {
    const decision = evaluate(
      request({
        transaction: 'TRANSFER',
        rules: [locked],
        location: { kind: 'CONTROLLED_CABINET', hasControlledAccess: true },
      })
    );

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * A prescription written tomorrow
 * ------------------------------------------------------------------ */

describe('a prescription dated after the day it is dispensed', () => {
  /**
   * ⚠️ THE GUARD USED TO SIT INSIDE THE VALIDITY CONDITIONAL, so a rule with no
   *   `validityDays`/`validityMonths` never ran it — and both the Indian and the
   *   Bangladeshi packs deliberately carry no validity, because neither body of
   *   law states one. A mistyped year was the most valid prescription in the
   *   system in two countries.
   */
  it('is refused even when the rule configures no validity at all', () => {
    const decision = evaluate(
      request({
        rules: [rule({ code: 'TL_RX', parameters: { required: true } })],
        prescription: { ...validPrescription, issuedOn: new Date('2099-01-01T00:00:00Z') },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.message).toContain('dated after');
  });

  it('still permits one written today', () => {
    const decision = evaluate(
      request({
        rules: [rule({ code: 'TL_RX', parameters: { required: true } })],
        prescription: { ...validPrescription, issuedOn: TODAY },
      })
    );

    expect(decision.outcome).toBe('PERMITTED');
  });
});

/* ------------------------------------------------------------------ *
 * A licence requirement that names no licence
 * ------------------------------------------------------------------ */

describe('an import rule requiring "a licence" without saying which', () => {
  it('is unreadable rather than satisfied by any licence at all', () => {
    /* It used to fall back to `held.length > 0`, so a pharmacist's dispensing
     * registration satisfied an import-licence requirement. */
    const decision = evaluate(
      request({
        transaction: 'STOCK',
        rules: [
          rule({
            code: 'TL_IMPORT',
            ruleType: 'IMPORT_RESTRICTION',
            parameters: { permitted: true, licenceRequired: true },
          }),
        ],
        actor: { roleCodes: [], licenceTypes: ['SOMETHING_UNRELATED'] },
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('refuses when the named licence is not held', () => {
    const decision = evaluate(
      request({
        transaction: 'STOCK',
        rules: [
          rule({
            code: 'TL_IMPORT',
            ruleType: 'IMPORT_RESTRICTION',
            statement: 'An import licence is required.',
            parameters: { permitted: true, licenceRequired: true, licenceType: 'IMPORT_LICENCE' },
          }),
        ],
        actor: { roleCodes: [], licenceTypes: ['SOMETHING_UNRELATED'] },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });
});
