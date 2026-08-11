/**
 * The half of the engine a CLINIC needs, which a subscription never did.
 *
 * Every case here is one that puts a wrong number on a document a patient may
 * hand to an insurer: GST charged on an exempt consultation, a Karnataka
 * clinic's supply split to Kerala because the patient lives there, or a rate
 * quietly borrowed from the registration for an item nobody configured.
 */
import { money } from '@rcln/payments';
import {
  resolveTax,
  ruleFor,
  type IssuerRegistration,
  type TaxRule,
  type TaxableCustomer,
} from '../src/index.js';

/**
 * A clinic's registration, not rcln's — note the null standard rate. A clinic
 * sells several things at several rates and none of them belongs here.
 */
const CLINIC_KA: IssuerRegistration = {
  countryCode: 'IN',
  regionCode: 'KA',
  scheme: 'GST',
  registrationNumber: '29AAACR1234K1ZP',
  standardRateBps: null,
};

const rule = (over: Partial<TaxRule> = {}): TaxRule => ({
  countryCode: 'IN',
  regionCode: null,
  scheme: 'GST',
  taxCategory: 'CONSULTATION',
  rateBps: 0,
  treatment: 'EXEMPT',
  lineName: 'GST',
  regionalLineName: null,
  // India's constitutional split. Every other country's rules leave this NONE.
  split: 'INTRA_STATE_HALVES',
  stacks: false,
  // Most cases here are the clinic's own card; inheritance has its own block.
  source: 'TENANT',
  effectiveFrom: new Date('2025-04-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});

const MEDICINE = rule({ taxCategory: 'MEDICINE', rateBps: 500, treatment: 'STANDARD' });
const CONSUMABLE = rule({ taxCategory: 'CONSUMABLE', rateBps: 1200, treatment: 'STANDARD' });

/** A walk-in patient: no GSTIN, and their address is not the place of supply. */
const patient = (over: Partial<TaxableCustomer> = {}): TaxableCustomer => ({
  countryCode: 'IN',
  regionCode: 'KA',
  taxId: null,
  taxIdStatus: 'NOT_PROVIDED',
  ...over,
});

/** How a patient invoice line calls the engine: place of supply is the BRANCH. */
const line = (
  taxCategory: string,
  rules: TaxRule[],
  over: { customer?: Partial<TaxableCustomer>; netMinor?: number; at?: Date } = {}
) => ({
  net: money(over.netMinor ?? 100_000, 'INR'),
  customer: patient(over.customer),
  registrations: [CLINIC_KA],
  placeOfSupply: { countryCode: 'IN', regionCode: 'KA' },
  taxCategory,
  rules,
  suppliedAt: over.at ?? new Date('2026-08-09T00:00:00Z'),
});

describe('the rate is a property of the item, not of the registration', () => {
  /*
   * The single most common line on an Indian clinic's invoice, and the one that
   * costs the clinic real money if it is wrong: healthcare services are exempt,
   * so GST charged on a consultation is GST the clinic then owes the government
   * on money it should never have taken from the patient.
   */
  it('charges nothing on an exempt consultation', () => {
    const quote = resolveTax(line('CONSULTATION', [rule(), MEDICINE, CONSUMABLE]));

    expect(quote.treatment).toBe('EXEMPT');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.lines).toHaveLength(0);
    // Still the clinic's invoice, so it still carries the clinic's GSTIN.
    expect(quote.supplierTaxId).toBe('29AAACR1234K1ZP');
  });

  /*
   * EXEMPT and ZERO_RATED both charge nothing and are not interchangeable: a
   * zero-rated supply appears on a return and carries input credit, an exempt
   * one does not. The engine must keep them apart all the way to the document.
   */
  it('keeps exempt and zero-rated apart even though both charge nothing', () => {
    const zero = rule({ taxCategory: 'EXPORT_KIT', treatment: 'ZERO_RATED' });
    const quote = resolveTax(line('EXPORT_KIT', [zero]));

    expect(quote.treatment).toBe('ZERO_RATED');
    expect(quote.total.amountMinor).toBe(0);
  });

  it('charges each item at its own rate under one registration', () => {
    const rules = [rule(), MEDICINE, CONSUMABLE];

    const medicine = resolveTax(line('MEDICINE', rules));
    const consumable = resolveTax(line('CONSUMABLE', rules));

    // 5% of 1000.00 = 50.00, split CGST 25.00 / SGST 25.00.
    expect(medicine.total.amountMinor).toBe(5_000);
    expect(medicine.lines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
    // 12% of 1000.00 = 120.00 — same registration, same invoice, different rate.
    expect(consumable.total.amountMinor).toBe(12_000);
  });
});

describe('an item nobody configured', () => {
  /*
   * ⚠️ The decision this package exists to make. There IS a registration and
   *   there IS a rate on the registration in the subscription case, so falling
   *   back to it would be the easy answer — and it would print a rate nobody
   *   chose on a document a patient claims against insurance.
   */
  it('is UNRATED, not silently charged at some other rate', () => {
    const quote = resolveTax(line('PHYSIOTHERAPY', [rule(), MEDICINE]));

    expect(quote.treatment).toBe('UNRATED');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.reason).toContain('PHYSIOTHERAPY');
  });

  /*
   * UNRATED is distinct from NOT_REGISTERED, and the difference is what a
   * cashier is told to do about it. NOT_REGISTERED is a legal position and the
   * invoice is fine; UNRATED is a configuration gap and the invoice is not fit
   * to issue.
   */
  it('is not confused with holding no registration at all', () => {
    const unregistered = resolveTax({ ...line('MEDICINE', [MEDICINE]), registrations: [] });

    expect(unregistered.treatment).toBe('NOT_REGISTERED');
    expect(resolveTax(line('MEDICINE', [MEDICINE])).treatment).toBe('STANDARD');
  });

  /*
   * A clinic registration carries no standard rate at all, so a caller that
   * forgets to pass a category cannot accidentally land on one.
   */
  it('covers a supply that names no category against a per-item issuer', () => {
    const quote = resolveTax({
      net: money(100_000, 'INR'),
      customer: patient(),
      registrations: [CLINIC_KA],
      placeOfSupply: { countryCode: 'IN', regionCode: 'KA' },
      suppliedAt: new Date('2026-08-09T00:00:00Z'),
    });

    expect(quote.treatment).toBe('UNRATED');
    expect(quote.total.amountMinor).toBe(0);
  });
});

describe('where a clinical service is supplied', () => {
  /*
   * ⚠️ The deviation from the subscription engine, and the one most likely to be
   *   "fixed" back into being wrong. A consultation is performed at the branch,
   *   so a Karnataka clinic treating a patient from Kerala makes an INTRA-state
   *   supply — CGST + SGST. Reading the patient's address as the place of supply
   *   would produce IGST, deny the split to Karnataka, and misstate both returns.
   */
  it('is the branch, not the patient s home state', () => {
    const quote = resolveTax(line('MEDICINE', [MEDICINE], { customer: { regionCode: 'KL' } }));

    expect(quote.placeOfSupply).toBe('IN-KA');
    expect(quote.lines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
  });

  /*
   * And the subscription path, which passes no place of supply, must keep
   * reading the customer — that is the digital-services rule. This is the case
   * that proves the new field defaults to the old behaviour.
   */
  it('falls back to the customer when no place is given', () => {
    const rcln: IssuerRegistration = { ...CLINIC_KA, standardRateBps: 1800 };
    const quote = resolveTax({
      net: money(100_000, 'INR'),
      customer: patient({ regionCode: 'KL' }),
      registrations: [rcln],
      suppliedAt: new Date('2026-08-09T00:00:00Z'),
    });

    expect(quote.placeOfSupply).toBe('IN-KL');
    expect(quote.lines.map((l) => l.name)).toEqual(['IGST']);
  });
});

describe('rates change, and old invoices must still explain themselves', () => {
  const OLD = rule({ taxCategory: 'MEDICINE', rateBps: 1200, treatment: 'STANDARD' });
  const NEW = rule({
    taxCategory: 'MEDICINE',
    rateBps: 500,
    treatment: 'STANDARD',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  });

  it('prices a supply at the rate in force on the day it was made', () => {
    const closed = { ...OLD, effectiveTo: new Date('2025-12-31T00:00:00Z') };

    const before = resolveTax(
      line('MEDICINE', [closed, NEW], { at: new Date('2025-06-01T00:00:00Z') })
    );
    const after = resolveTax(
      line('MEDICINE', [closed, NEW], { at: new Date('2026-06-01T00:00:00Z') })
    );

    expect(before.total.amountMinor).toBe(12_000);
    expect(after.total.amountMinor).toBe(5_000);
  });

  /*
   * ⚠️ The ordinary mistake: adding the new rate and forgetting to close the old
   *   row. Both then match, and without a deterministic tie-break the answer
   *   depends on the order Postgres returned — so the same item is taxed at 12%
   *   on Monday and 5% on Tuesday with nothing in the data having changed.
   */
  it('takes the latest rule when an unclosed old one still overlaps', () => {
    expect(ruleFor([OLD, NEW], CLINIC_KA, 'MEDICINE', new Date('2026-06-01T00:00:00Z'))).toBe(NEW);
    expect(ruleFor([NEW, OLD], CLINIC_KA, 'MEDICINE', new Date('2026-06-01T00:00:00Z'))).toBe(NEW);
  });

  it('treats both ends of the effective range as inclusive', () => {
    const closed = { ...OLD, effectiveTo: new Date('2025-12-31T00:00:00Z') };
    const at = (iso: string) => ruleFor([closed], CLINIC_KA, 'MEDICINE', new Date(iso));

    expect(at('2025-04-01T00:00:00Z')).toBe(closed);
    expect(at('2025-12-31T00:00:00Z')).toBe(closed);
    expect(at('2025-03-31T00:00:00Z')).toBeNull();
    expect(at('2026-01-01T00:00:00Z')).toBeNull();
  });

  /*
   * A rate is usually national even though the registration is per state, so a
   * country-wide rule is the common row. A state-specific one, where it exists,
   * must win — the same tie-break `registrationFor` uses, for the same reason.
   */
  it('prefers a state-specific rule over the country-wide one', () => {
    const national = rule({ taxCategory: 'MEDICINE', rateBps: 500, treatment: 'STANDARD' });
    const karnataka = { ...national, regionCode: 'KA', rateBps: 1200 };

    expect(ruleFor([national, karnataka], CLINIC_KA, 'MEDICINE', new Date('2026-06-01Z'))).toBe(
      karnataka
    );
  });

  /*
   * Exact match only. An HSN prefix tree that silently resolved `30049099` to
   * the broader `3004` heading would apply a confident, unreviewed rate.
   */
  it('does not match a category by prefix', () => {
    const heading = rule({ taxCategory: '3004', rateBps: 500, treatment: 'STANDARD' });

    expect(ruleFor([heading], CLINIC_KA, '30049099', new Date('2026-06-01Z'))).toBeNull();
  });
});

describe('inheriting rcln s maintained rate card', () => {
  /*
   * ⚠️ THE PRECEDENCE THIS WHOLE DESIGN TURNS ON. `tax_rule_defaults` is the
   *   card rcln maintains per country; `tax_rules` is what the clinic overrode.
   *   Resolution happens at READ time so a published rate change reaches every
   *   clinic that has not overridden it with one INSERT — rather than a
   *   migration across every tenant, which is what copying defaults into each
   *   clinic at signup would require.
   */
  const platformMedicine = rule({
    taxCategory: 'MEDICINE',
    rateBps: 500,
    treatment: 'STANDARD',
    source: 'PLATFORM',
  });

  it('uses the platform default when the clinic has said nothing', () => {
    const quote = resolveTax(line('MEDICINE', [platformMedicine]));

    expect(quote.treatment).toBe('STANDARD');
    expect(quote.total.amountMinor).toBe(5_000);
  });

  /*
   * ⚠️ A TENANT RULE WINS BEFORE SPECIFICITY IS EVEN CONSIDERED. The clinic's
   *   row is an explicit act by the party who signs the return and carries the
   *   liability; rcln silently overruling it would make us the author of
   *   somebody else's tax position.
   */
  it('lets the clinic s own rule win over the default', () => {
    const clinicMedicine = rule({
      taxCategory: 'MEDICINE',
      rateBps: 1200,
      treatment: 'STANDARD',
      source: 'TENANT',
    });

    const quote = resolveTax(line('MEDICINE', [platformMedicine, clinicMedicine]));
    expect(quote.total.amountMinor).toBe(12_000);
  });

  /* Including when the clinic's is country-wide and ours is state-specific. */
  it('lets a country-wide clinic rule beat a state-specific default', () => {
    const platformKarnataka = { ...platformMedicine, regionCode: 'KA', rateBps: 1800 };
    const clinicNational = {
      ...platformMedicine,
      source: 'TENANT' as const,
      rateBps: 1200,
      regionCode: null,
    };

    const quote = resolveTax(line('MEDICINE', [platformKarnataka, clinicNational]));
    expect(quote.total.amountMinor).toBe(12_000);
  });

  /*
   * ⚠️ ALL-OR-NOTHING PER CATEGORY. A clinic that overrode the federal rate must
   *   not silently keep inheriting our stacked provincial one — the invoice
   *   would carry one rate it chose and one it has never seen, and nobody could
   *   say who decided the total.
   */
  it('ignores a stacked default once the clinic owns the category', () => {
    const federal = rule({
      countryCode: 'CA',
      taxCategory: 'MEDICINE',
      rateBps: 500,
      treatment: 'STANDARD',
      lineName: 'GST',
      split: 'NONE',
      source: 'PLATFORM',
    });
    const provincial = {
      ...federal,
      regionCode: 'BC',
      rateBps: 700,
      lineName: 'PST',
      stacks: true,
    };
    const clinicOwn = { ...federal, source: 'TENANT' as const, rateBps: 900 };

    const bc: IssuerRegistration = {
      countryCode: 'CA',
      regionCode: 'BC',
      scheme: 'GST',
      registrationNumber: '123456789RT0001',
      standardRateBps: null,
    };

    const quote = resolveTax({
      net: money(100_000, 'CAD'),
      customer: { countryCode: 'CA', regionCode: 'BC', taxId: null, taxIdStatus: 'NOT_PROVIDED' },
      placeOfSupply: { countryCode: 'CA', regionCode: 'BC' },
      registrations: [bc],
      taxCategory: 'MEDICINE',
      rules: [federal, provincial, clinicOwn],
      suppliedAt: new Date('2026-08-09T00:00:00Z'),
    });

    // Only the clinic's own 9%, not 9% + our inherited 7%.
    expect(quote.lines.map((l) => l.name)).toEqual(['GST']);
    expect(quote.total.amountMinor).toBe(9_000);
  });

  /* And both of ours apply together while the clinic has said nothing. */
  it('applies a full inherited stack when the clinic has not overridden', () => {
    const federal = rule({
      countryCode: 'CA',
      taxCategory: 'MEDICINE',
      rateBps: 500,
      treatment: 'STANDARD',
      lineName: 'GST',
      split: 'NONE',
      source: 'PLATFORM',
    });
    const provincial = {
      ...federal,
      regionCode: 'BC',
      rateBps: 700,
      lineName: 'PST',
      stacks: true,
    };

    const bc: IssuerRegistration = {
      countryCode: 'CA',
      regionCode: 'BC',
      scheme: 'GST',
      registrationNumber: '123456789RT0001',
      standardRateBps: null,
    };

    const quote = resolveTax({
      net: money(100_000, 'CAD'),
      customer: { countryCode: 'CA', regionCode: 'BC', taxId: null, taxIdStatus: 'NOT_PROVIDED' },
      placeOfSupply: { countryCode: 'CA', regionCode: 'BC' },
      registrations: [bc],
      taxCategory: 'MEDICINE',
      rules: [federal, provincial],
      suppliedAt: new Date('2026-08-09T00:00:00Z'),
    });

    expect(quote.lines.map((l) => l.name)).toEqual(['GST', 'PST']);
    expect(quote.total.amountMinor).toBe(12_000);
  });

  /* A retired default stops applying on the day after it ends, like any rule. */
  it('stops using a default once it has been retired', () => {
    const retired = { ...platformMedicine, effectiveTo: new Date('2026-01-31T00:00:00Z') };
    const quote = resolveTax(line('MEDICINE', [retired]));

    expect(quote.treatment).toBe('UNRATED');
  });
});
