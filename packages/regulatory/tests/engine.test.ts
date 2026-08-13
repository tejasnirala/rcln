/**
 * The engine, tested the way REGULATORY_RULE_PACKS.md says a pack must be:
 * never `expect(country).toBe('IN')`, always the DECISION.
 *
 *   given  a product's classification + jurisdiction + transaction + the
 *          prescription state + the actor + a quantity + a date
 *   then   the outcome, the conditions and the reasons are exactly these
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE ONES WHERE NOTHING IS CONFIGURED. A
 *   permissive default is invisible in every other test: everything works, every
 *   dispense goes through, and the failure is a controlled drug handed over in a
 *   jurisdiction nobody set up. Those cases are first.
 *
 * No country's rules appear here. The fixtures are deliberately fictional —
 * `TESTLAND` — so that nothing in this file can be mistaken for a legal position
 * on anywhere real.
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
    categoryPath: ['category-root', 'category-leaf'],
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

describe('an absence never permits', () => {
  it('returns UNDETERMINED when the jurisdiction has no rules at all', () => {
    const decision = evaluate(request({ rules: [] }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.conditions).toEqual([]);
    expect(decision.reasons[0]?.message).toContain('No regulatory rule covers');
    expect(decision.packVersionIds).toEqual([]);
  });

  it('returns UNDETERMINED when rules exist for a different country', () => {
    const elsewhere = rule({ jurisdiction: { countryCode: 'ZZ', regionCode: null } });

    expect(evaluate(request({ rules: [elsewhere] })).outcome).toBe('UNDETERMINED');
  });

  it('returns UNDETERMINED for a product with no regulatory profile, when the rule names a classification', () => {
    const classified = rule({ appliesToClassification: 'POM' });

    // The product exists, the rule exists, and they have never been connected.
    const decision = evaluate(request({ profile: null, rules: [classified] }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('does not permit merely because the rule is unreadable', () => {
    const broken = rule({ parameters: { required: 'yes' } });

    const decision = evaluate(request({ rules: [broken], prescription: validPrescription }));

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('not true or false');
  });

  it('does not permit a quantity limit it cannot measure against', () => {
    const limit = rule({
      ruleType: 'QUANTITY_LIMIT',
      code: 'TL_QTY',
      statement: 'No more than 60 units may be supplied in 30 days.',
      parameters: { maxPerPeriodBase: '60', periodDays: 30 },
    });

    // The caller could not say what the patient has already had, so the key is
    // ABSENT — which is not the same as zero and must not read as it.
    const decision = evaluate(request({ rules: [limit], prescription: validPrescription }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

describe('effective dating', () => {
  const dated = (from: string, to: string | null, parameters: unknown): RegulatoryRule =>
    rule({
      parameters,
      effectiveFrom: new Date(`${from}T00:00:00Z`),
      effectiveTo: to === null ? null : new Date(`${to}T00:00:00Z`),
    });

  it('gives two different answers for the same request on two dates', () => {
    const rules = [
      dated('2026-01-01', '2026-06-30', { required: false }),
      dated('2026-07-01', null, { required: true }),
    ];

    const before = evaluate(request({ rules, occurredAt: new Date('2026-05-01T09:00:00Z') }));
    const after = evaluate(request({ rules, occurredAt: new Date('2026-08-01T09:00:00Z') }));

    expect(before.outcome).toBe('PERMITTED');
    expect(after.outcome).toBe('REFUSED');
  });

  it('keeps a rule live THROUGH its last day, not until the morning of it', () => {
    // The bug this pins: comparing a `@db.Date` at UTC midnight against an
    // instant retires the row a full day early, silently, every day.
    const rules = [dated('2026-01-01', '2026-08-13', { required: true })];

    expect(evaluate(request({ rules, occurredAt: TODAY })).outcome).toBe('REFUSED');
  });

  it('ignores a rule that is not ACTIVE', () => {
    const draft = rule({ status: 'DRAFT' });

    expect(evaluate(request({ rules: [draft] })).outcome).toBe('UNDETERMINED');
  });
});

describe('specificity', () => {
  it('lets a regional rule supersede the national one of the same type', () => {
    const national = rule({ code: 'TL_NATIONAL', parameters: { required: true } });
    const regional = rule({
      code: 'TL_KA_LOCAL',
      jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
      parameters: { required: false },
    });

    const decision = evaluate(
      request({
        jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
        rules: [national, regional],
      })
    );

    expect(decision.outcome).toBe('PERMITTED');
    expect(decision.reasons.map((r) => r.ruleCode)).toEqual(['TL_KA_LOCAL']);
  });

  it('does not let a regional rule supersede a DIFFERENT rule type', () => {
    const nationalLabelling = rule({
      ruleType: 'LABELLING_REQUIREMENT',
      code: 'TL_LABEL',
      parameters: { fields: ['patientName', 'dose'] },
    });
    const regionalPrescription = rule({
      code: 'TL_KA_POM',
      jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
      parameters: { required: false },
    });

    const decision = evaluate(
      request({
        jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
        rules: [nationalLabelling, regionalPrescription],
      })
    );

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(decision.conditions.map((c) => c.kind)).toEqual(['LABEL_FIELDS']);
  });

  it('prefers the rule aimed at the classification over the catch-all', () => {
    const catchAll = rule({ code: 'TL_ALL', parameters: { required: false } });
    const classified = rule({
      code: 'TL_POM_ONLY',
      appliesToClassification: 'POM',
      parameters: { required: true },
    });

    const decision = evaluate(request({ rules: [catchAll, classified] }));

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons.map((r) => r.ruleCode)).toEqual(['TL_POM_ONLY']);
  });

  it('matches a rule written against a PARENT category', () => {
    const parentCategory = rule({
      code: 'TL_CATEGORY',
      appliesToCategoryId: 'category-root',
      parameters: { required: true },
    });

    expect(evaluate(request({ rules: [parentCategory] })).outcome).toBe('REFUSED');
  });

  it('evaluates both of two equally specific rules rather than picking one', () => {
    const permissive = rule({ code: 'TL_A', parameters: { required: false } });
    const strict = rule({ code: 'TL_B', parameters: { required: true } });

    const decision = evaluate(request({ rules: [permissive, strict] }));

    // A refusal beats a permission. Silently picking either would make the
    // answer depend on the order the rows came back in.
    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons).toHaveLength(2);
  });
});

describe('prescription rules', () => {
  it('permits a dispense against a valid prescription', () => {
    const decision = evaluate(
      request({
        rules: [rule({ parameters: { required: true, validityDays: 30 } })],
        prescription: validPrescription,
      })
    );

    expect(decision.outcome).toBe('PERMITTED');
  });

  it('refuses when the prescription is older than the validity period', () => {
    const decision = evaluate(
      request({
        rules: [rule({ parameters: { required: true, validityDays: 2 } })],
        prescription: { ...validPrescription, issuedOn: new Date('2026-07-01T00:00:00Z') },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.message).toContain('43 days old');
  });

  it('refuses a prescription dated in the future rather than treating it as fresh', () => {
    const decision = evaluate(
      request({
        rules: [rule({ parameters: { required: true, validityDays: 30 } })],
        prescription: { ...validPrescription, issuedOn: new Date('2027-01-01T00:00:00Z') },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('refuses when the prescriber class is not one the rule permits', () => {
    const authority = rule({
      ruleType: 'PRESCRIBER_AUTHORITY',
      code: 'TL_PRESCRIBER',
      statement: 'Only a registered medical practitioner may prescribe this.',
      parameters: { permittedPrescriberClasses: ['DOCTOR'] },
    });

    const decision = evaluate(
      request({
        rules: [authority],
        prescription: { ...validPrescription, prescriberClasses: ['DENTIST'] },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('is UNDETERMINED when the prescriber class was never supplied', () => {
    const authority = rule({
      ruleType: 'PRESCRIBER_AUTHORITY',
      code: 'TL_PRESCRIBER',
      parameters: { permittedPrescriberClasses: ['DOCTOR'] },
    });

    const decision = evaluate(request({ rules: [authority], prescription: validPrescription }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

describe('quantity limits', () => {
  const limit = (parameters: unknown): RegulatoryRule =>
    rule({
      ruleType: 'QUANTITY_LIMIT',
      code: 'TL_QTY',
      statement: 'No more than 30 units may be supplied at once.',
      parameters,
    });

  it('refuses a transaction over the per-transaction limit', () => {
    const decision = evaluate(
      request({ rules: [limit({ maxPerTransactionBase: '30' })], quantityBase: '30.000001' })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('permits exactly the limit, in either scale', () => {
    // The ledger writes `30.000000` and a rule is written `30`. Comparing them
    // as strings, or through a float, gets this wrong in opposite directions.
    const decision = evaluate(
      request({ rules: [limit({ maxPerTransactionBase: '30' })], quantityBase: '30.000000' })
    );

    expect(decision.outcome).toBe('PERMITTED');
  });

  it('counts what the patient has already had inside the period', () => {
    const decision = evaluate(
      request({
        rules: [limit({ maxPerPeriodBase: '60', periodDays: 30 })],
        quantityBase: '30',
        priorQuantityInPeriodBase: '40',
      })
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.message).toContain('70');
  });

  it('is UNDETERMINED for a period limit that states no period', () => {
    /*
     * ⚠️ `priorQuantityInPeriodBase` IS SUPPLIED ON PURPOSE. Without it the
     *   request is already UNDETERMINED for a different reason — "we did not
     *   check what they have had" — so the test passed whether or not
     *   `parseQuantityLimit` refused a period with no window. It was green
     *   against a version with that guard deleted, which is not a test.
     */
    const decision = evaluate(
      request({
        rules: [limit({ maxPerPeriodBase: '60' })],
        priorQuantityInPeriodBase: '0',
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('how long the period is');
  });

  it('refuses to read a limit written as a JSON number', () => {
    // JSON has one numeric type and it is a double. A limit is a string.
    const decision = evaluate(request({ rules: [limit({ maxPerTransactionBase: 30 })] }));

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

describe('conditions are obligations, and they reach the caller', () => {
  it('returns PERMITTED_WITH_CONDITIONS for a controlled schedule', () => {
    const controlled = rule({
      ruleType: 'CONTROLLED_SCHEDULE',
      code: 'TL_CD',
      statement: 'Schedule 2 obligations apply.',
      parameters: { scheduleName: 'SCHEDULE_2', registerRequired: true, witnessRequired: true },
    });

    const decision = evaluate(request({ rules: [controlled] }));

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(decision.conditions.map((c) => c.kind)).toEqual([
      'RECORD_IN_CONTROLLED_REGISTER',
      'WITNESS_REQUIRED',
    ]);
    expect(decision.conditions[0]?.ruleCode).toBe('TL_CD');
  });

  it('drops the conditions when anything refused — a refused transaction has no obligations', () => {
    const controlled = rule({
      ruleType: 'CONTROLLED_SCHEDULE',
      code: 'TL_CD',
      parameters: { registerRequired: true },
    });
    const refusing = rule({ code: 'TL_POM', parameters: { required: true } });

    const decision = evaluate(request({ rules: [controlled, refusing] }));

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.conditions).toEqual([]);
  });
});

describe('the other rule types', () => {
  it('refuses a traceability requirement the pack in hand cannot satisfy', () => {
    const traceability = rule({
      ruleType: 'TRACEABILITY_REQUIREMENT',
      code: 'TL_TRACE',
      statement: 'Lot and expiry must be recorded at every step.',
      parameters: { requiredIdentifiers: ['LOT', 'EXPIRY'] },
    });

    const decision = evaluate(
      request({
        transaction: 'STOCK',
        rules: [traceability],
        traceability: { lotNumber: 'AB-1', expiresOn: null },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.message).toContain('EXPIRY');
  });

  it('is UNDETERMINED for an identifier the engine cannot check', () => {
    const traceability = rule({
      ruleType: 'TRACEABILITY_REQUIREMENT',
      code: 'TL_TRACE',
      parameters: { requiredIdentifiers: ['RFID'] },
    });

    expect(evaluate(request({ transaction: 'STOCK', rules: [traceability] })).outcome).toBe(
      'UNDETERMINED'
    );
  });

  it('refuses an age-restricted supply and is UNDETERMINED when the age is unknown', () => {
    const age = rule({
      ruleType: 'AGE_RESTRICTION',
      code: 'TL_AGE',
      statement: 'This may not be supplied to anyone under 18.',
      parameters: { minimumAgeYears: 18, verificationRequired: true },
    });

    expect(
      evaluate(request({ rules: [age], patient: { subjectType: 'HUMAN', ageYears: 16 } })).outcome
    ).toBe('REFUSED');

    expect(evaluate(request({ rules: [age], patient: { subjectType: 'HUMAN' } })).outcome).toBe(
      'UNDETERMINED'
    );

    const permitted = evaluate(
      request({ rules: [age], patient: { subjectType: 'HUMAN', ageYears: 40 } })
    );
    expect(permitted.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(permitted.conditions[0]?.kind).toBe('VERIFY_PATIENT_AGE');
  });

  it('refuses a substitution the prescriber has not agreed to', () => {
    const substitution = rule({
      ruleType: 'SUBSTITUTION',
      code: 'TL_SUB',
      statement: 'Generic substitution requires the prescriber to agree.',
      parameters: { permitted: true, requiresPrescriberConsent: true },
    });

    expect(
      evaluate(request({ rules: [substitution], substitution: { isSubstitution: true } })).outcome
    ).toBe('REFUSED');

    expect(
      evaluate(
        request({
          rules: [substitution],
          substitution: { isSubstitution: true, prescriberConsented: true },
        })
      ).outcome
    ).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('refuses remote supply to a destination the rule does not list', () => {
    const online = rule({
      ruleType: 'ONLINE_DISPENSING',
      code: 'TL_ONLINE',
      statement: 'Remote supply is permitted within the country only.',
      parameters: { permitted: true, destinationCountryCodes: ['TL'] },
    });

    const decision = evaluate(
      request({
        transaction: 'ONLINE_DISPENSE',
        rules: [online],
        destination: { countryCode: 'ZZ', regionCode: null },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });

  it('refuses stock held somewhere the storage rule does not allow', () => {
    const storage = rule({
      ruleType: 'STORAGE_REQUIREMENT',
      code: 'TL_STORE',
      statement: 'This must be kept in a controlled cabinet.',
      parameters: { locationKinds: ['CONTROLLED_CABINET'], controlledAccessRequired: true },
    });

    expect(
      evaluate(request({ transaction: 'STOCK', rules: [storage], location: { kind: 'SHELF' } }))
        .outcome
    ).toBe('REFUSED');

    expect(
      evaluate(
        request({
          transaction: 'STOCK',
          rules: [storage],
          location: { kind: 'CONTROLLED_CABINET', hasControlledAccess: true },
        })
      ).outcome
    ).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('refuses an import that requires a licence nobody holds', () => {
    const importRule = rule({
      ruleType: 'IMPORT_RESTRICTION',
      code: 'TL_IMPORT',
      statement: 'An import licence is required for this product.',
      parameters: { permitted: true, licenceRequired: true, licenceType: 'IMPORT_LICENCE' },
    });

    expect(
      evaluate(request({ transaction: 'STOCK', rules: [importRule], actor: { roleCodes: [] } }))
        .outcome
    ).toBe('REFUSED');
  });

  it('only engages the disposal rule on a disposal', () => {
    const disposal = rule({
      ruleType: 'DISPOSAL_REQUIREMENT',
      code: 'TL_DISPOSE',
      statement: 'Controlled stock must be destroyed in the presence of a witness.',
      parameters: { method: 'DENATURE', witnessRequired: true },
    });

    expect(evaluate(request({ transaction: 'DISPENSE', rules: [disposal] })).outcome).toBe(
      'PERMITTED'
    );

    const onDisposal = evaluate(request({ transaction: 'DISPOSE', rules: [disposal] }));
    expect(onDisposal.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(onDisposal.conditions.map((c) => c.kind)).toEqual([
      'DISPOSE_BY_METHOD',
      'WITNESS_REQUIRED',
    ]);
  });

  it('applies a rule only to the transactions it names', () => {
    const stockOnly = rule({
      code: 'TL_STOCK_ONLY',
      appliesToTransactions: ['STOCK'],
      parameters: { required: true },
    });

    expect(evaluate(request({ transaction: 'DISPENSE', rules: [stockOnly] })).outcome).toBe(
      'UNDETERMINED'
    );
  });
});

describe('the snapshot the transaction keeps', () => {
  it('cites every pack that contributed and the weakest maturity among them', () => {
    const mature = rule({ code: 'TL_A', packId: 'pack-mature', parameters: { required: false } });
    const immature = rule({
      code: 'TL_LABEL',
      ruleType: 'LABELLING_REQUIREMENT',
      packId: 'pack-draft',
      packVersion: '0.1.0',
      packMaturity: 'RULES_CONFIGURED',
      parameters: { fields: ['dose'] },
    });

    const decision = evaluate(request({ rules: [mature, immature] }));

    expect([...decision.packVersionIds].sort()).toEqual(['pack-draft', 'pack-mature']);
    expect(decision.lowestPackMaturity).toBe('RULES_CONFIGURED');
  });

  it('records a verdict for every applicable rule, including the ones that permitted', () => {
    const decision = evaluate(
      request({
        rules: [
          rule({ code: 'TL_A', parameters: { required: false } }),
          rule({
            code: 'TL_RETAIN',
            ruleType: 'RECORD_RETENTION',
            parameters: { years: 5, detail: 'Keep the record for five years.' },
          }),
        ],
      })
    );

    expect(decision.reasons.map((r) => r.outcome)).toEqual(['PERMITTED', 'PERMITTED']);
    expect(decision.reasons.every((r) => r.packVersion === '1.0.0')).toBe(true);
  });

  it('is stable across runs — the reasons come back in the same order', () => {
    const rules = [
      rule({ code: 'TL_Z', ruleType: 'RECORD_RETENTION', parameters: { years: 5 } }),
      rule({ code: 'TL_A', parameters: { required: false } }),
    ];

    const first = evaluate(request({ rules }));
    const second = evaluate(request({ rules: [...rules].reverse() }));

    expect(first.reasons.map((r) => r.ruleCode)).toEqual(second.reasons.map((r) => r.ruleCode));
  });
});

describe('a rule that says nothing checkable', () => {
  /*
   * ⚠️ THE CLASS OF DEFECT THE FIRST VERSION OF THIS ENGINE SHIPPED WITH, AND
   *   THE ONE THE REST OF THIS FILE COULD NOT SEE. Every other "nothing is
   *   configured" case here tests an absent RULE; these test a rule that EXISTS
   *   with an empty or misspelled parameters document. `readBoolean` cannot tell
   *   absent from misspelled — nothing can — and the handlers read an absent
   *   `required` as "no prescription is required here", so one typo turned a
   *   prescription-only medicine into a general-sale one.
   */
  const broken = (over: Partial<RegulatoryRule>): RegulatoryRule => rule(over);

  it.each([
    ['PRESCRIPTION_REQUIRED', { require: true }],
    ['PRESCRIPTION_REQUIRED', {}],
    ['CONTROLLED_SCHEDULE', {}],
    ['TRACEABILITY_REQUIREMENT', { requiredIdentifers: ['LOT'] }],
    ['IMPORT_RESTRICTION', {}],
    ['SUBSTITUTION', {}],
    ['ONLINE_DISPENSING', {}],
    ['STORAGE_REQUIREMENT', {}],
    ['REFILL_RULE', {}],
    ['LABELLING_REQUIREMENT', {}],
    ['PRESCRIBER_AUTHORITY', {}],
    ['PHARMACIST_AUTHORITY', {}],
  ] as const)('refuses to act on a %s whose parameters say nothing', (ruleType, parameters) => {
    const decision = evaluate(
      request({
        transaction: ruleType === 'IMPORT_RESTRICTION' ? 'STOCK' : 'DISPENSE',
        rules: [broken({ ruleType, parameters })],
        substitution: { isSubstitution: true },
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('does not let a broken REGIONAL rule discard the national one that refuses', () => {
    /*
     * ⚠️ THE AMPLIFIER, AND THE REASON THE TYPO WAS A CRITICAL RATHER THAN A
     *   NUISANCE. A regional rule SUPERSEDES the national one of its type, so a
     *   misspelled regional rule did not merely permit itself — it took the rule
     *   that would have refused out of the candidate set on its way past.
     */
    const national = rule({ code: 'TL_NATIONAL', parameters: { required: true } });
    const regionalTypo = rule({
      code: 'TL_KA_TYPO',
      jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
      parameters: { requird: true },
    });

    const decision = evaluate(
      request({
        jurisdiction: { countryCode: 'TL', regionCode: 'KA' },
        rules: [national, regionalTypo],
      })
    );

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.outcome).not.toBe('PERMITTED');
  });

  it('refuses a repeat on a prescription dated in the future', () => {
    const refill = rule({
      ruleType: 'REFILL_RULE',
      code: 'TL_REPEAT',
      statement: 'A repeat may not be dispensed more than 30 days after it was written.',
      parameters: { refillsAllowed: 3, validityDays: 30 },
    });

    const decision = evaluate(
      request({
        rules: [refill],
        prescription: { ...validPrescription, issuedOn: new Date('2030-01-01T00:00:00Z') },
      })
    );

    expect(decision.outcome).toBe('REFUSED');
  });
});
