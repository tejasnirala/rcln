/**
 * The charge policy's pure half (PI-8).
 *
 * ⚠️ THESE THREE FUNCTIONS DECIDE WHETHER ANY SUPPLY ANYWHERE REACHES A BILL, AND
 *   THE DEFAULT IS THE PART THAT MATTERS MOST. Every clinic starts with an empty
 *   policy table, so `defaultChargePolicy` is what happens at every clinic on the
 *   platform until somebody configures one — and both ways of getting it wrong
 *   are invisible for a month. Too generous puts gauze on an invoice; too mean
 *   gives medicine away.
 *
 * The precedence chain itself needs a transaction and is covered by
 * `tests/integration/charging.test.ts`.
 */
import {
  defaultChargePolicy,
  isBillable,
  needsDecision,
} from '../../src/services/charging/policy.service.js';

describe('defaultChargePolicy', () => {
  /*
   * BILLING_INTEGRATION.md's own test, verbatim: "a consumed glove produces no
   * invoice line; an implant does".
   */
  it('bills an implant and does not bill a glove', () => {
    expect(defaultChargePolicy('IMPLANT')).toBe('SEPARATELY_BILLABLE');
    expect(defaultChargePolicy('CONSUMABLE')).toBe('NEVER_BILL');
  });

  it('bills what a patient takes away', () => {
    for (const type of ['MEDICINE', 'VACCINE', 'VETERINARY_MEDICINE', 'MEDICAL_DEVICE'] as const) {
      expect(defaultChargePolicy(type)).toBe('SEPARATELY_BILLABLE');
    }
  });

  it('does not bill what is consumed during care', () => {
    for (const type of [
      'SURGICAL_SUPPLY',
      'DENTAL_MATERIAL',
      'LAB_REAGENT',
      'DIAGNOSTIC_KIT',
      'VETERINARY_CONSUMABLE',
      'GENERAL_CLINICAL_SUPPLY',
    ] as const) {
      expect(defaultChargePolicy(type)).toBe('NEVER_BILL');
    }
  });
});

describe('isBillable', () => {
  it('is true for exactly one policy', () => {
    expect(isBillable('SEPARATELY_BILLABLE')).toBe(true);
    for (const policy of [
      'NEVER_BILL',
      'INCLUDED_IN_SERVICE',
      'OPTIONAL',
      'CONTRACT_DEFINED',
      'JURISDICTION_CONFIGURED',
    ] as const) {
      expect(isBillable(policy)).toBe(false);
    }
  });

  /*
   * ⚠️ `INCLUDED_IN_SERVICE` IS NOT BILLABLE AND IS NOT THE SAME AS
   *   `NEVER_BILL`, WHICH IS THE DISTINCTION THIS TEST EXISTS TO PIN. The clinic
   *   IS recovering the cost, through another line, and a costing report has to
   *   be able to tell the two apart. Collapsing them would be invisible here and
   *   would lose that.
   */
  it('keeps INCLUDED_IN_SERVICE distinct from NEVER_BILL', () => {
    expect(isBillable('INCLUDED_IN_SERVICE')).toBe(isBillable('NEVER_BILL'));
    expect('INCLUDED_IN_SERVICE').not.toBe('NEVER_BILL');
  });
});

describe('needsDecision', () => {
  /*
   * ⚠️ ALL THREE STOP AT A HUMAN TODAY. `CONTRACT_DEFINED` needs a payer-contract
   *   engine and `JURISDICTION_CONFIGURED` needs a billing-rule pack; neither
   *   exists, and the alternative to asking somebody is guessing — which either
   *   bills a patient a contract says is covered or waives a charge nobody agreed
   *   to waive. If this test ever changes, an engine must have landed.
   */
  it('stops at a human for the three policies that have no engine behind them', () => {
    expect(needsDecision('OPTIONAL')).toBe(true);
    expect(needsDecision('CONTRACT_DEFINED')).toBe(true);
    expect(needsDecision('JURISDICTION_CONFIGURED')).toBe(true);
  });

  it('does not stop for a policy that has already answered', () => {
    for (const policy of ['NEVER_BILL', 'INCLUDED_IN_SERVICE', 'SEPARATELY_BILLABLE'] as const) {
      expect(needsDecision(policy)).toBe(false);
    }
  });

  /* A policy is either decided or it is not; nothing may be both. */
  it('never both bills automatically and asks somebody', () => {
    for (const policy of [
      'NEVER_BILL',
      'INCLUDED_IN_SERVICE',
      'SEPARATELY_BILLABLE',
      'OPTIONAL',
      'CONTRACT_DEFINED',
      'JURISDICTION_CONFIGURED',
    ] as const) {
      expect(isBillable(policy) && needsDecision(policy)).toBe(false);
    }
  });
});
