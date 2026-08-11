/**
 * The same engine, billing a clinic in each country rcln supports.
 *
 * ⚠️ THE FILE THAT STOPS THIS BECOMING AN INDIAN TAX ENGINE AGAIN. It was one
 *   once: `GST` meant India, so an Australian clinic's invoice printed a line
 *   called `IGST` for an "inter-state supply" — a concept that does not exist in
 *   Australia — at an arithmetically correct rate. The number was right and the
 *   document was not compliant, which is the hardest class of bug to notice,
 *   because nothing fails and the total reconciles.
 *
 * Every case below asserts the LINE NAMES and the JURISDICTION each line is owed
 * to, not only the total. A total-only assertion would have passed throughout
 * the entire period the bug existed.
 */
import { money } from '@rcln/payments';
import {
  resolveTax,
  type IssuerRegistration,
  type TaxRule,
  type TaxableSupply,
} from '../src/index.js';

const AT = new Date('2026-08-09T00:00:00Z');
const NET = 100_000; // 1000.00 in any currency with two decimals

const registration = (over: Partial<IssuerRegistration> = {}): IssuerRegistration => ({
  countryCode: 'IN',
  regionCode: null,
  scheme: 'GST',
  registrationNumber: 'REG',
  // A clinic prices per item, so there is never a registration-level rate.
  standardRateBps: null,
  ...over,
});

const rule = (over: Partial<TaxRule> = {}): TaxRule => ({
  countryCode: 'IN',
  regionCode: null,
  scheme: 'GST',
  taxCategory: 'MEDICINE',
  rateBps: 0,
  treatment: 'STANDARD',
  lineName: 'GST',
  regionalLineName: null,
  split: 'NONE',
  stacks: false,
  source: 'TENANT',
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});

/** A patient at the clinic's own branch — the ordinary case in every country. */
const atBranch = (
  reg: IssuerRegistration,
  rules: TaxRule[],
  currency: string,
  over: Partial<TaxableSupply> = {}
): TaxableSupply => {
  const place = { countryCode: reg.countryCode, regionCode: reg.regionCode };
  return {
    net: money(NET, currency),
    customer: { ...place, taxId: null, taxIdStatus: 'NOT_PROVIDED' },
    placeOfSupply: place,
    registrations: [reg],
    taxCategory: 'MEDICINE',
    rules,
    suppliedAt: AT,
    ...over,
  };
};

/** `[name, rateBps, minorAmount, jurisdiction]` for each printed line. */
const shape = (supply: TaxableSupply) =>
  resolveTax(supply).lines.map((l) => [l.name, l.rateBps, l.amount.amountMinor, l.jurisdiction]);

describe('India — the only country with a constitutional split', () => {
  const KA = registration({ countryCode: 'IN', regionCode: 'KA' });
  const gst12 = rule({ rateBps: 1200, split: 'INTRA_STATE_HALVES' });

  it('halves GST between the centre and the state within the state', () => {
    expect(shape(atBranch(KA, [gst12], 'INR'))).toEqual([
      // ⚠️ CGST is the CENTRE's half, so it is owed to IN and not to IN-KA.
      ['CGST', 600, 6_000, 'IN'],
      ['SGST', 600, 6_000, 'IN-KA'],
    ]);
  });

  /*
   * A union territory without a legislature charges UTGST rather than SGST. Same
   * split, same halves, different name and a different authority — which is why
   * the name is overridable on the rule rather than derived unconditionally.
   */
  it('charges UTGST instead of SGST in a union territory', () => {
    const chandigarh = registration({ countryCode: 'IN', regionCode: 'CH' });
    const utRule = rule({ rateBps: 1200, split: 'INTRA_STATE_HALVES', regionalLineName: 'UTGST' });

    expect(shape(atBranch(chandigarh, [utRule], 'INR'))).toEqual([
      ['CGST', 600, 6_000, 'IN'],
      ['UTGST', 600, 6_000, 'IN-CH'],
    ]);
  });

  it('charges one IGST line across a state border', () => {
    const supply = atBranch(KA, [gst12], 'INR', {
      placeOfSupply: { countryCode: 'IN', regionCode: 'KL' },
    });
    // Not intra-state, so the whole amount goes to the centre as one line.
    expect(shape(supply)).toEqual([['IGST', 1200, 12_000, 'IN']]);
  });

  /*
   * An odd number of paise must not round twice. 12% of 1000.05 is 120.006 ->
   * 120.01, whose halves are 60.00 and 60.01 — and they must sum to 120.01
   * exactly or the invoice does not add up.
   */
  it('splits an odd amount so the halves still sum to the total', () => {
    const supply = atBranch(KA, [gst12], 'INR', { net: money(100_005, 'INR') });
    const quote = resolveTax(supply);

    const summed = quote.lines.reduce((n, l) => n + l.amount.amountMinor, 0);
    expect(summed).toBe(quote.total.amountMinor);
    expect(quote.lines.map((l) => l.amount.amountMinor)).toEqual([6_000, 6_001]);
  });
});

describe('GST countries that are not India', () => {
  /*
   * ⚠️ THE REGRESSION THIS FILE EXISTS FOR. Australia has one GST at 10%, no
   *   states in the tax sense and no such thing as an inter-state supply. It
   *   previously printed `IGST` at the right rate.
   */
  it('Australia charges one line called GST', () => {
    const au = registration({ countryCode: 'AU', scheme: 'GST' });
    const gst = rule({ countryCode: 'AU', rateBps: 1000 });

    expect(shape(atBranch(au, [gst], 'AUD'))).toEqual([['GST', 1000, 10_000, 'AU']]);
  });

  it('Singapore charges one line called GST', () => {
    const sg = registration({ countryCode: 'SG', scheme: 'GST' });
    const gst = rule({ countryCode: 'SG', rateBps: 900 });

    expect(shape(atBranch(sg, [gst], 'SGD'))).toEqual([['GST', 900, 9_000, 'SG']]);
  });

  it('New Zealand charges one line called GST', () => {
    const nz = registration({ countryCode: 'NZ', scheme: 'GST' });
    const gst = rule({ countryCode: 'NZ', rateBps: 1500 });

    expect(shape(atBranch(nz, [gst], 'NZD'))).toEqual([['GST', 1500, 15_000, 'NZ']]);
  });

  it('describes an export out of its own country, not out of India', () => {
    const au = registration({ countryCode: 'AU', scheme: 'GST' });
    const supply = atBranch(au, [rule({ countryCode: 'AU', rateBps: 1000 })], 'AUD', {
      placeOfSupply: { countryCode: 'NZ', regionCode: null },
    });

    const quote = resolveTax(supply);
    expect(quote.treatment).toBe('ZERO_RATED');
    expect(quote.reason).toContain('outside AU');
    expect(quote.reason).not.toContain('India');
  });
});

describe('Canada — two taxes on one invoice', () => {
  /*
   * ⚠️ THE CASE AN ENGINE THAT PICKS ONE RULE CANNOT BILL AT ALL. British
   *   Columbia charges federal GST at 5% AND provincial PST at 7%, as two lines
   *   owed to two governments and filed on two returns. Picking only the
   *   province's rule undercharges by 5%; picking only the federal one
   *   undercharges by 7%. Either way the clinic, not the patient, owes the
   *   difference.
   */
  const bc = registration({ countryCode: 'CA', regionCode: 'BC', scheme: 'GST' });
  const federalGst = rule({ countryCode: 'CA', rateBps: 500, lineName: 'GST' });
  const bcPst = rule({
    countryCode: 'CA',
    regionCode: 'BC',
    rateBps: 700,
    lineName: 'PST',
    stacks: true,
  });

  it('stacks provincial PST on top of federal GST', () => {
    expect(shape(atBranch(bc, [federalGst, bcPst], 'CAD'))).toEqual([
      ['GST', 500, 5_000, 'CA'],
      ['PST', 700, 7_000, 'CA-BC'],
    ]);
  });

  /*
   * Both are charged on the NET, not one on the other. PST on (net + GST) would
   * be a tax on a tax, which British Columbia does not levy — and it would
   * overcharge the patient by 0.35% of the net.
   */
  it('charges both on the net rather than one on the other', () => {
    const quote = resolveTax(atBranch(bc, [federalGst, bcPst], 'CAD'));

    expect(quote.total.amountMinor).toBe(12_000); // 12% of the net, not 12.35%
    expect(quote.reason).toContain('GST');
    expect(quote.reason).toContain('PST');
  });

  /*
   * Quebec's provincial tax is called QST and is 9.975% — a rate with a
   * fractional percent, which is exactly why rates are basis points.
   */
  it('handles Quebec s QST at a fractional percentage', () => {
    const qc = registration({ countryCode: 'CA', regionCode: 'QC', scheme: 'GST' });
    const qst = rule({
      countryCode: 'CA',
      regionCode: 'QC',
      rateBps: 998, // 9.975% rounds to 998bps; the authority publishes 9.975
      lineName: 'QST',
      stacks: true,
    });

    expect(shape(atBranch(qc, [federalGst, qst], 'CAD'))).toEqual([
      ['GST', 500, 5_000, 'CA'],
      ['QST', 998, 9_980, 'CA-QC'],
    ]);
  });

  /*
   * An HST province is the opposite shape: ONE harmonised line that replaces
   * both, not two stacked. Expressed as a regional overriding rule, which is the
   * default behaviour — so Canada needs both mechanisms and this proves they
   * coexist under one country.
   */
  it('charges a single harmonised HST line in Ontario', () => {
    const on = registration({ countryCode: 'CA', regionCode: 'ON', scheme: 'GST' });
    const hst = rule({
      countryCode: 'CA',
      regionCode: 'ON',
      rateBps: 1300,
      lineName: 'HST',
      stacks: false,
    });

    // The federal rule is present and must be OVERRIDDEN, not added to.
    expect(shape(atBranch(on, [federalGst, hst], 'CAD'))).toEqual([['HST', 1300, 13_000, 'CA-ON']]);
  });

  /*
   * A province that configured its PST but not the federal GST underneath it is
   * misconfigured. Charging the PST alone would be wrong in the undercharging
   * direction, and silently.
   */
  it('refuses to charge a stacked tax with no base rule beneath it', () => {
    const quote = resolveTax(atBranch(bc, [bcPst], 'CAD'));

    expect(quote.treatment).toBe('UNRATED');
    expect(quote.total.amountMinor).toBe(0);
  });
});

describe('VAT countries', () => {
  const cases: ReadonlyArray<[string, string, string, number, number]> = [
    ['Ireland', 'IE', 'EUR', 2300, 23_000],
    ['United Kingdom', 'GB', 'GBP', 2000, 20_000],
    ['United Arab Emirates', 'AE', 'AED', 500, 5_000],
    ['Nepal', 'NP', 'NPR', 1300, 13_000],
    ['Sri Lanka', 'LK', 'LKR', 1800, 18_000],
    ['Bangladesh', 'BD', 'BDT', 1500, 15_000],
  ];

  it.each(cases)('%s charges one VAT line at its own rate', (_name, code, currency, bps, due) => {
    const reg = registration({ countryCode: code, scheme: 'VAT' });
    const vat = rule({ countryCode: code, scheme: 'VAT', rateBps: bps, lineName: 'VAT' });

    expect(shape(atBranch(reg, [vat], currency))).toEqual([['VAT', bps, due, code]]);
  });

  /*
   * A country whose tax is not called "VAT" prints what it is called. Bahrain
   * and Oman both say VAT; Japan says "Consumption Tax". The engine never
   * supplies the word.
   */
  it('prints whatever the authority calls the tax', () => {
    const jp = registration({ countryCode: 'JP', scheme: 'VAT' });
    const ct = rule({
      countryCode: 'JP',
      scheme: 'VAT',
      rateBps: 1000,
      lineName: 'Consumption Tax',
    });

    expect(shape(atBranch(jp, [ct], 'JPY'))).toEqual([['Consumption Tax', 1000, 10_000, 'JP']]);
  });
});

describe('the United States', () => {
  const ca = registration({ countryCode: 'US', regionCode: 'CA', scheme: 'SALES_TAX' });

  /*
   * ⚠️ NOT A GAP TO BE FILLED WITH A RATE TABLE. Sales tax combines state,
   *   county, city and special-district rates and turns on economic nexus over
   *   trailing revenue. Any table small enough to hand-maintain is wrong often
   *   enough to matter, and it is wrong on a document the customer files.
   */
  it('refuses to compute sales tax without a provider', () => {
    const quote = resolveTax(atBranch(ca, [], 'USD'));

    expect(quote.treatment).toBe('PROVIDER_REQUIRED');
    expect(quote.total.amountMinor).toBe(0);
    // The registration is still real and still goes on the document.
    expect(quote.supplierTaxId).toBe('REG');
  });

  it('prices from the provider s own lines when one is configured', () => {
    const quote = resolveTax({
      ...atBranch(ca, [], 'USD'),
      providerQuote: {
        treatment: 'STANDARD',
        lines: [
          { name: 'CA State', rateBps: 600, amount: money(6_000, 'USD'), jurisdiction: 'US-CA' },
          {
            name: 'San Francisco District',
            rateBps: 125,
            amount: money(1_250, 'USD'),
            jurisdiction: 'US-CA-SF',
          },
        ],
        total: money(7_250, 'USD'),
        reason: 'Combined 7.25% for 94103.',
      },
    });

    expect(quote.treatment).toBe('STANDARD');
    expect(quote.total.amountMinor).toBe(7_250);
    expect(quote.lines).toHaveLength(2);
  });
});

describe('a currency whose minor unit is not two decimals', () => {
  /*
   * ⚠️ Japan has no minor unit and Kuwait has three. A tax engine that assumed
   *   two would overcharge a Kuwaiti patient by a factor of ten and undercharge
   *   a Japanese one, and the assertion that catches it has to be about the
   *   minor-unit integer rather than the displayed figure.
   */
  it('computes in whole yen', () => {
    const jp = registration({ countryCode: 'JP', scheme: 'VAT' });
    const ct = rule({ countryCode: 'JP', scheme: 'VAT', rateBps: 1000, lineName: 'CT' });

    // ¥10,000 is 10000 minor units, because JPY has no subdivision.
    const quote = resolveTax(atBranch(jp, [ct], 'JPY', { net: money(10_000, 'JPY') }));
    expect(quote.total.amountMinor).toBe(1_000);
  });

  it('computes in thousandths of a dinar', () => {
    const kw = registration({ countryCode: 'KW', scheme: 'VAT' });
    const vat = rule({ countryCode: 'KW', scheme: 'VAT', rateBps: 500, lineName: 'VAT' });

    // KD 100.000 is 100000 fils.
    const quote = resolveTax(atBranch(kw, [vat], 'KWD', { net: money(100_000, 'KWD') }));
    expect(quote.total.amountMinor).toBe(5_000);
  });
});
