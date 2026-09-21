/**
 * What tax is due, and — more importantly — when none is.
 *
 * Every case here is one that costs real money or real credibility if it is
 * wrong: charging where we are not registered, splitting CGST/SGST to the wrong
 * state so the customer loses their input credit, or charging VAT to a business
 * that should have been reverse-charged.
 */
import { money } from '@rcln/payments';
import {
  netOf,
  formatJurisdiction,
  placeOfSupplyFor,
  registrationFor,
  resolveTax,
  taxOn,
  type IssuerRegistration,
  type TaxableCustomer,
} from '../src/index.js';

const KARNATAKA: IssuerRegistration = {
  countryCode: 'IN',
  regionCode: 'KA',
  scheme: 'GST',
  registrationNumber: '29AABCU9603R1ZM',
  standardRateBps: 1800,
};

const IRELAND: IssuerRegistration = {
  countryCode: 'IE',
  regionCode: null,
  scheme: 'VAT',
  registrationNumber: 'IE1234567AB',
  standardRateBps: 2300,
};

const customer = (over: Partial<TaxableCustomer> = {}): TaxableCustomer => ({
  countryCode: 'IN',
  regionCode: 'KA',
  taxId: null,
  taxIdStatus: 'NOT_PROVIDED',
  ...over,
});

const supply = (
  registrations: IssuerRegistration[],
  over: Partial<TaxableCustomer> = {},
  netMinor = 499_900
) => ({
  net: money(netMinor, 'INR'),
  customer: customer(over),
  registrations,
  suppliedAt: new Date('2026-08-06T00:00:00Z'),
});

describe('whether we may charge at all', () => {
  /*
   * The default the product ships in, and the one that must never be got wrong
   * in the permissive direction. Tax charged without a registration cannot be
   * remitted, because there is nobody to remit it to.
   */
  it('charges nothing with no registrations at all', () => {
    const quote = resolveTax(supply([]));

    expect(quote.treatment).toBe('NOT_REGISTERED');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.lines).toHaveLength(0);
    expect(quote.supplierTaxId).toBeNull();
    // A zero-tax invoice with no explanation is indistinguishable from a bug.
    expect(quote.reason).toContain('not registered');
  });

  it('never charges OUR rate in a country we are not registered in', () => {
    /*
     * Registered in India, supplying a clinic in Germany. The trap is charging
     * 18% GST because that is the rate we hold — a plausible invoice, at an
     * Indian rate, for a supply India has no claim on. It is an export instead.
     */
    const quote = resolveTax(supply([KARNATAKA], { countryCode: 'DE', regionCode: null }));

    expect(quote.total.amountMinor).toBe(0);
    expect(quote.lines).toHaveLength(0);
    expect(quote.treatment).toBe('ZERO_RATED');
  });

  it('distinguishes NOT_REGISTERED from ZERO_RATED', () => {
    /*
     * Both collect nothing and they are not the same thing: a zero-rated supply
     * appears on a return, an unregistered one does not exist to any authority.
     * Collapsing them would understate the export figures we do have to file.
     */
    const unregistered = resolveTax(supply([], { countryCode: 'DE', regionCode: null }));
    const exported = resolveTax(supply([KARNATAKA], { countryCode: 'AE', regionCode: null }));

    expect(unregistered.treatment).toBe('NOT_REGISTERED');
    expect(exported.treatment).toBe('ZERO_RATED');
    expect(exported.reason).toContain('export');
  });

  it('refuses to guess at US sales tax', () => {
    const us: IssuerRegistration = {
      countryCode: 'US',
      regionCode: 'CA',
      scheme: 'SALES_TAX',
      registrationNumber: 'CA-123',
      standardRateBps: 725,
    };

    /*
     * A single rate would produce numbers that look right and are wrong, on
     * documents a customer files. Nothing charged, and the invoice says why.
     *
     * ⚠️ `PROVIDER_REQUIRED`, NOT `NOT_REGISTERED` — the distinction matters and
     *   it is why this treatment was added. We ARE registered in California; the
     *   rate simply cannot come from a table. Reporting "not registered" was a
     *   false statement about a legal position, and it pointed whoever read it at
     *   the wrong fix.
     */
    const quote = resolveTax(supply([us], { countryCode: 'US', regionCode: 'CA' }));
    expect(quote.treatment).toBe('PROVIDER_REQUIRED');
    expect(quote.reason).toContain('tax provider');
  });

  /*
   * And with a provider wired in, the same supply is priced from what the
   * provider returned — the engine never invents the number, it only refuses to
   * proceed without one.
   */
  it('uses a provider quote where one is supplied', () => {
    const us: IssuerRegistration = {
      countryCode: 'US',
      regionCode: 'CA',
      scheme: 'SALES_TAX',
      registrationNumber: 'CA-123',
      standardRateBps: null,
    };

    const quote = resolveTax({
      ...supply([us], { countryCode: 'US', regionCode: 'CA' }),
      providerQuote: {
        treatment: 'STANDARD',
        lines: [
          {
            name: 'CA State Tax',
            rateBps: 725,
            amount: money(36_243, 'INR'),
            jurisdiction: 'US-CA',
          },
        ],
        total: money(36_243, 'INR'),
        reason: 'Sales tax for 94103 via provider.',
      },
    });

    expect(quote.treatment).toBe('STANDARD');
    expect(quote.total.amountMinor).toBe(36_243);
    expect(quote.lines[0]?.name).toBe('CA State Tax');
  });
});

describe('India GST', () => {
  it('splits CGST and SGST within our own state', () => {
    const quote = resolveTax(supply([KARNATAKA], { regionCode: 'KA' }));

    expect(quote.treatment).toBe('STANDARD');
    expect(quote.lines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
    expect(quote.total.amountMinor).toBe(89_982); // 18% of 4999.00
    expect(quote.placeOfSupply).toBe('IN-KA');
    expect(quote.supplierTaxId).toBe('29AABCU9603R1ZM');
  });

  it('charges IGST to another state', () => {
    const quote = resolveTax(supply([KARNATAKA], { regionCode: 'KL' }));

    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]?.name).toBe('IGST');
    expect(quote.lines[0]?.rateBps).toBe(1800);
    expect(quote.total.amountMinor).toBe(89_982);
  });

  it('falls to IGST when the customer state is unknown', () => {
    /*
     * The safe direction, deliberately. IGST is fully creditable to the
     * customer; a CGST/SGST split billed to the wrong state is not, and unpicking
     * it needs a credit note and a reissue.
     */
    const quote = resolveTax(supply([KARNATAKA], { regionCode: null }));
    expect(quote.lines[0]?.name).toBe('IGST');
  });

  it('splits so the halves sum EXACTLY to the tax', () => {
    /*
     * The rounding bug this is written against: halving twice on an odd number
     * of paise leaves the lines not adding up to the invoice's tax, which is a
     * one-paisa discrepancy that reconciliation finds and nobody enjoys.
     */
    // 18% of 1001 paise = 180.18 -> 180, which is even; use a net that is odd
    // after the rate is applied.
    const quote = resolveTax(supply([KARNATAKA], { regionCode: 'KA' }, 1_050));
    const summed = quote.lines.reduce((n, l) => n + l.amount.amountMinor, 0);

    expect(summed).toBe(quote.total.amountMinor);
    expect(quote.total.amountMinor).toBe(189); // 18% of 10.50
  });

  it('zero-rates an export of services', () => {
    const quote = resolveTax(supply([KARNATAKA], { countryCode: 'AE', regionCode: null }));

    expect(quote.treatment).toBe('ZERO_RATED');
    expect(quote.total.amountMinor).toBe(0);
    // Our GSTIN still appears — a zero-rated export invoice must carry it.
    expect(quote.supplierTaxId).toBe('29AABCU9603R1ZM');
  });
});

describe('VAT and reverse charge', () => {
  it('reverse-charges a cross-border business with a VALIDATED number', () => {
    const quote = resolveTax(
      supply([IRELAND], {
        countryCode: 'DE',
        regionCode: null,
        taxId: 'DE123',
        taxIdStatus: 'VALID',
      })
    );

    expect(quote.treatment).toBe('REVERSE_CHARGE');
    expect(quote.total.amountMinor).toBe(0);
  });

  it('does NOT charge our own rate to an unvalidated cross-border customer', () => {
    /*
     * The rule this test was written the wrong way round for, and the reason
     * "broad from day one" means a tax provider.
     *
     * A German customer without a validated number is charged GERMAN VAT through
     * One Stop Shop — not Irish VAT because that is the registration we happen to
     * hold. Charging ours is the easy wrong answer: a plausible invoice at the
     * wrong rate, remitted to the wrong authority. Nothing charged, with the
     * reason recorded, is the honest failure until a provider is configured.
     */
    const quote = resolveTax(
      supply([IRELAND], {
        countryCode: 'DE',
        regionCode: null,
        taxId: 'DE123',
        taxIdStatus: 'UNVALIDATED',
      })
    );

    // `PROVIDER_REQUIRED` for the same reason US sales tax is: we hold an Irish
    // registration, so "not registered" was never the true statement.
    expect(quote.treatment).toBe('PROVIDER_REQUIRED');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.reason).toContain('One Stop Shop');
  });

  it('charges VAT domestically even with a valid number', () => {
    // Reverse charge is cross-border only; an Irish business buying from an
    // Irish supplier pays Irish VAT.
    const quote = resolveTax(
      supply([IRELAND], {
        countryCode: 'IE',
        regionCode: null,
        taxId: 'IE999',
        taxIdStatus: 'VALID',
      })
    );

    expect(quote.treatment).toBe('STANDARD');
    expect(quote.lines[0]?.rateBps).toBe(2300);
  });
});

describe('choosing the registration', () => {
  it('prefers a state registration over a country-wide one', () => {
    const countryWide: IssuerRegistration = {
      ...KARNATAKA,
      regionCode: null,
      registrationNumber: 'IN-CENTRAL',
    };

    const chosen = registrationFor([countryWide, KARNATAKA], customer({ regionCode: 'KA' }));
    expect(chosen?.registrationNumber).toBe('29AABCU9603R1ZM');
  });

  it('falls back to the country-wide one for another state', () => {
    const countryWide: IssuerRegistration = {
      ...KARNATAKA,
      regionCode: null,
      registrationNumber: 'IN-CENTRAL',
    };

    const chosen = registrationFor([countryWide, KARNATAKA], customer({ regionCode: 'KL' }));
    expect(chosen?.registrationNumber).toBe('IN-CENTRAL');
  });

  /*
   * ⚠️ THE CASE THE DATE SORT DID NOT ACTUALLY COVER. Two GSTINs for one state,
   *   both taken out on 1 April — which is when Indian registrations start, so
   *   this is the ordinary shape rather than a contrived one. `effectiveFrom`
   *   compares equal, the sort is stable, and before the second key the answer
   *   was whichever row the caller happened to pass first: the same branch
   *   printed a different number depending on the order Postgres returned.
   *   Asserted both ways round, because passing one order only would still pass
   *   against the bug.
   */
  it('breaks a same-date tie on the number, not on the order it was handed', () => {
    const first: IssuerRegistration = {
      ...KARNATAKA,
      registrationNumber: '29AAAAA0000A1Z0',
      effectiveFrom: new Date('2025-04-01T00:00:00.000Z'),
    };
    const second: IssuerRegistration = {
      ...KARNATAKA,
      registrationNumber: '29ZZZZZ9999Z1ZZ',
      effectiveFrom: new Date('2025-04-01T00:00:00.000Z'),
    };

    expect(
      registrationFor([first, second], customer({ regionCode: 'KA' }))?.registrationNumber
    ).toBe('29AAAAA0000A1Z0');
    expect(
      registrationFor([second, first], customer({ regionCode: 'KA' }))?.registrationNumber
    ).toBe('29AAAAA0000A1Z0');
  });

  it('still prefers the later registration when the dates differ', () => {
    const older: IssuerRegistration = {
      ...KARNATAKA,
      registrationNumber: '29AAAAA0000A1Z0',
      effectiveFrom: new Date('2024-04-01T00:00:00.000Z'),
    };
    const newer: IssuerRegistration = {
      ...KARNATAKA,
      registrationNumber: '29ZZZZZ9999Z1ZZ',
      effectiveFrom: new Date('2025-04-01T00:00:00.000Z'),
    };

    expect(
      registrationFor([older, newer], customer({ regionCode: 'KA' }))?.registrationNumber
    ).toBe('29ZZZZZ9999Z1ZZ');
  });

  it('builds the place of supply from country and region', () => {
    expect(formatJurisdiction(customer({ regionCode: 'KA' }))).toBe('IN-KA');
    expect(formatJurisdiction(customer({ countryCode: 'IE', regionCode: null }))).toBe('IE');
  });

  /*
   * The default that keeps every subscription invoice above behaving exactly as
   * it did before the engine learnt about places. Omitting `placeOfSupply` is
   * the digital-services rule; see the warning on `TaxableSupply`.
   */
  it('deems the supply to happen where the customer is, unless told otherwise', () => {
    const patient = customer({ regionCode: 'KL' });

    expect(placeOfSupplyFor({ customer: patient })).toEqual(patient);
    expect(
      placeOfSupplyFor({
        customer: patient,
        placeOfSupply: { countryCode: 'IN', regionCode: 'KA' },
      })
    ).toEqual({ countryCode: 'IN', regionCode: 'KA' });
  });
});

describe('inclusive and exclusive prices', () => {
  it('adds tax on top of an exclusive price', () => {
    expect(taxOn(money(499_900, 'INR'), 1800).amountMinor).toBe(89_982);
  });

  it('backs the net out of an inclusive price without exceeding it', () => {
    /*
     * The property that matters: net + tax must never come out ABOVE the figure
     * the customer was shown. Rounded down for exactly that reason, with the tax
     * line taking the remainder so the invoice still adds up.
     */
    const gross = money(499_900, 'INR');
    const net = netOf(gross, 1800);
    const tax = money(gross.amountMinor - net.amountMinor, 'INR');

    expect(net.amountMinor + tax.amountMinor).toBe(gross.amountMinor);
    expect(net.amountMinor).toBeLessThan(gross.amountMinor);
  });

  it('leaves a price alone at a zero rate', () => {
    expect(netOf(money(499_900, 'INR'), 0).amountMinor).toBe(499_900);
  });
});
