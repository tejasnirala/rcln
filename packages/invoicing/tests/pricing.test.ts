/**
 * What an invoice comes to.
 *
 * ⚠️ THE ASSERTIONS THAT MATTER MOST HERE DO NOT CHECK A TOTAL. Phase 2b's
 *   lesson was that an India-shaped engine produced correct arithmetic on a
 *   non-compliant document, and every total-based assertion passed throughout.
 *   The same shape of failure lives in this file: subtracting the invoice-level
 *   discount AFTER tax instead of apportioning it before, and rounding tax per
 *   invoice instead of per line, both produce a grand total that is arguably
 *   right and a tax figure that is remitted wrongly. So the discount tests
 *   assert the TAX, not the total, and say out loud what the wrong answer is.
 */
import { fromMajor, money, type Money } from '@rcln/payments';
import { resolveTax, taxOn, type IssuerRegistration, type TaxRule } from '@rcln/tax';

import {
  apportion,
  formatQuantity,
  InvoicePricingError,
  parseQuantity,
  priceInvoice,
  type InvoicePricingInput,
} from '../src/index.js';

const SUPPLIED_AT = new Date('2026-08-10T09:00:00Z');

// ---------------------------------------------------------------------------
// Two ways to supply tax: a stub, and the real engine.
// ---------------------------------------------------------------------------

/**
 * A flat rate, so an arithmetic test is not also a test of `@rcln/tax`.
 *
 * The order of operations and the apportionment are what these cases are about;
 * whether Karnataka splits into halves is settled in `packages/tax`.
 */
function flatTax(rateBps: number): InvoicePricingInput['quoteTax'] {
  return (net) => {
    const amount = taxOn(net, rateBps);
    return {
      treatment: 'STANDARD',
      lines: [{ name: 'GST', rateBps, amount, jurisdiction: 'IN' }],
      total: amount,
      placeOfSupply: 'IN-KA',
      supplierTaxId: '29AAAAA0000A1Z5',
      customerTaxId: null,
      reason: 'GST.',
    };
  };
}

const KARNATAKA: IssuerRegistration = {
  countryCode: 'IN',
  regionCode: 'KA',
  scheme: 'GST',
  registrationNumber: '29AAAAA0000A1Z5',
  standardRateBps: null,
};

function rule(overrides: Partial<TaxRule> & Pick<TaxRule, 'taxCategory'>): TaxRule {
  return {
    id: 'rule-tenant',
    countryCode: 'IN',
    regionCode: null,
    scheme: 'GST',
    rateBps: 1200,
    treatment: 'STANDARD',
    lineName: 'GST',
    regionalLineName: null,
    split: 'INTRA_STATE_HALVES',
    stacks: false,
    source: 'TENANT',
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    effectiveTo: null,
    ...overrides,
  };
}

/** The real engine, wired the way `taxForItem` wires it: place of supply is the branch. */
function realTax(rules: TaxRule[]): InvoicePricingInput['quoteTax'] {
  return (net, taxCategory) =>
    resolveTax({
      net,
      customer: { countryCode: 'IN', regionCode: 'KA', taxId: null, taxIdStatus: 'NOT_PROVIDED' },
      placeOfSupply: { countryCode: 'IN', regionCode: 'KA' },
      registrations: [KARNATAKA],
      taxCategory,
      rules,
      suppliedAt: SUPPLIED_AT,
    });
}

/** ₹ as a string, so a test reads like the invoice it is describing. */
const inr = (major: string): Money => fromMajor(major, 'INR');

function line(major: string, overrides: Partial<InvoicePricingInput['lines'][number]> = {}) {
  return {
    description: 'Consultation',
    taxCategory: 'MEDICINE',
    quantityMilli: 1000,
    unitPrice: inr(major),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('quantity', () => {
  it('parses the three decimal places the column declares', () => {
    expect(parseQuantity('1.5')).toBe(1500);
    expect(parseQuantity('0.001')).toBe(1);
    expect(parseQuantity(2)).toBe(2000);
    expect(formatQuantity(1500)).toBe('1.500');
  });

  it('refuses a fourth decimal place rather than truncating it', () => {
    // A silently dropped digit is a discrepancy between what was dispensed and
    // what was charged, discovered by neither side.
    expect(() => parseQuantity('1.0005')).toThrow(InvoicePricingError);
  });
});

describe('gross', () => {
  it('rounds unit price × quantity once, at the currency scale', () => {
    // 1.5 × 199.99 = 299.985, and 299.985 is chargeable by nobody.
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('199.99', { quantityMilli: 1500 })],
      quoteTax: flatTax(0),
    });

    expect(priced.lines[0]?.grossAmount).toEqual(inr('299.99'));
    expect(priced.subtotal).toEqual(inr('299.99'));
  });

  it('refuses a line priced in another currency', () => {
    expect(() =>
      priceInvoice({
        currency: 'INR',
        lines: [line('100.00', { unitPrice: money(10_000, 'AED') })],
        quoteTax: flatTax(0),
      })
    ).toThrow(/AED/);
  });

  it('refuses a zero quantity, which is a line that bills nothing', () => {
    expect(() =>
      priceInvoice({
        currency: 'INR',
        lines: [line('100.00', { quantityMilli: 0 })],
        quoteTax: flatTax(0),
      })
    ).toThrow(InvoicePricingError);
  });
});

describe('line discount', () => {
  it('takes a percentage off the gross, before tax', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('1000.00', { discount: { type: 'PERCENTAGE', bps: 1000 } })],
      quoteTax: flatTax(1800),
    });

    expect(priced.lines[0]?.discountAmount).toEqual(inr('100.00'));
    expect(priced.lines[0]?.taxableAmount).toEqual(inr('900.00'));
    expect(priced.taxTotal).toEqual(inr('162.00')); // 18% of 900, not of 1000
    expect(priced.grandTotal).toEqual(inr('1062.00'));
  });

  it('takes a fixed amount off', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('500.00', { discount: { type: 'FIXED', amount: inr('50.00') } })],
      quoteTax: flatTax(0),
    });

    expect(priced.lines[0]?.taxableAmount).toEqual(inr('450.00'));
    expect(priced.lineDiscountTotal).toEqual(inr('50.00'));
  });

  it('REFUSES a discount larger than the line rather than clamping it', () => {
    // Clamping prints a bill the cashier did not intend; a negative charge is a
    // credit note and goes through a different door.
    expect(() =>
      priceInvoice({
        currency: 'INR',
        lines: [line('300.00', { discount: { type: 'FIXED', amount: inr('500.00') } })],
        quoteTax: flatTax(0),
      })
    ).toThrow(/credit note/);
  });

  it('refuses a percentage above 100%', () => {
    expect(() =>
      priceInvoice({
        currency: 'INR',
        lines: [line('300.00', { discount: { type: 'PERCENTAGE', bps: 10_001 } })],
        quoteTax: flatTax(0),
      })
    ).toThrow(InvoicePricingError);
  });
});

describe('invoice-level discount', () => {
  it('IS APPORTIONED BEFORE TAX, NOT SUBTRACTED AFTER IT', () => {
    /*
     * ⚠️ THE CENTRAL ASSERTION OF THIS PHASE. The brief's §7 sketch subtracts the
     *   invoice discount after tax, which taxes the pre-discount amount: ₹180 of
     *   GST on ₹1000, then ₹100 off, for a total of ₹1080. That total is
     *   arguably defensible and the ₹180 is not — it is tax remitted to a state
     *   government on ₹100 the patient never paid, which the clinic cannot
     *   recover and the patient was charged.
     */
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('1000.00')],
      discount: { type: 'PERCENTAGE', bps: 1000 },
      quoteTax: flatTax(1800),
    });

    expect(priced.lines[0]?.apportionedDiscount).toEqual(inr('100.00'));
    expect(priced.lines[0]?.taxableAmount).toEqual(inr('900.00'));
    expect(priced.taxTotal).toEqual(inr('162.00'));
    expect(priced.taxTotal).not.toEqual(inr('180.00')); // the wrong answer, named
    expect(priced.grandTotal).toEqual(inr('1062.00'));
    expect(priced.grandTotal).not.toEqual(inr('1080.00'));
  });

  it('splits across lines so the parts sum to the whole exactly', () => {
    // ₹100 across three equal lines is 33.33 three times, which is ₹99.99.
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00'), line('100.00'), line('100.00')],
      discount: { type: 'FIXED', amount: inr('100.00') },
      quoteTax: flatTax(0),
    });

    const parts = priced.lines.map((l) => l.apportionedDiscount.amountMinor);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(priced.invoiceDiscountTotal.amountMinor);
    expect(priced.invoiceDiscountTotal).toEqual(inr('100.00'));
  });

  it('gives the odd minor unit to the larger line, pro-rata by taxable amount', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00'), line('300.00')],
      discount: { type: 'FIXED', amount: inr('10.01') },
      quoteTax: flatTax(0),
    });

    // 1001 across weights 10000:30000 is 250.25 and 750.75.
    expect(priced.lines.map((l) => l.apportionedDiscount.amountMinor)).toEqual([250, 751]);
  });

  it('is weighted by what is LEFT of a line, not by its gross', () => {
    /*
     * A line already discounted to zero must absorb none of the second discount.
     * Weighting by gross would push its taxable amount negative — a charge the
     * invoice would then have to explain.
     */
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00', { discount: { type: 'PERCENTAGE', bps: 10_000 } }), line('100.00')],
      discount: { type: 'FIXED', amount: inr('10.00') },
      quoteTax: flatTax(0),
    });

    expect(priced.lines[0]?.apportionedDiscount).toEqual(inr('0.00'));
    expect(priced.lines[1]?.apportionedDiscount).toEqual(inr('10.00'));
    expect(priced.lines[0]?.taxableAmount).toEqual(inr('0.00'));
  });

  it('cannot be applied to an invoice with nothing to discount', () => {
    expect(() =>
      priceInvoice({
        currency: 'INR',
        lines: [line('0.00')],
        discount: { type: 'FIXED', amount: inr('10.00') },
        quoteTax: flatTax(0),
      })
    ).toThrow(InvoicePricingError);
  });

  it('prices the same invoice identically twice, so a reprint matches the original', () => {
    const input = (): InvoicePricingInput => ({
      currency: 'INR',
      lines: [line('33.33'), line('33.33'), line('33.34')],
      discount: { type: 'FIXED', amount: inr('10.00') },
      quoteTax: flatTax(1800),
    });

    expect(priceInvoice(input())).toEqual(priceInvoice(input()));
  });
});

describe('apportion', () => {
  it('is exact for any weights', () => {
    const weights = [1, 7, 13, 29, 31, 1000];
    for (const total of [0, 1, 2, 99, 100, 1001]) {
      const parts = apportion(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });

  it('never gives a line more than its own weight', () => {
    const weights = [1, 1, 998];
    const parts = apportion(1000, weights);
    expect(parts.every((part, index) => part <= (weights[index] ?? 0))).toBe(true);
  });
});

describe('tax', () => {
  it('is rounded PER LINE, and the invoice total is the sum of the printed lines', () => {
    /*
     * ⚠️ Per line and per invoice differ by up to (n−1) minor units. A patient
     *   who adds the column of figures on the page must get the number at the
     *   bottom, so the total is summed from the lines rather than recomputed.
     */
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('33.33'), line('33.33'), line('33.33')],
      quoteTax: flatTax(1800),
    });

    // 18% of 3333 is 599.94 -> 600 each, three times.
    expect(priced.lines.map((l) => l.taxAmount.amountMinor)).toEqual([600, 600, 600]);
    expect(priced.taxTotal.amountMinor).toBe(1800);
    expect(priced.taxTotal.amountMinor).toBe(
      priced.lines.reduce((sum, l) => sum + l.taxAmount.amountMinor, 0)
    );
  });

  it('sums the PRINTED lines, not the quote’s own total, when the two disagree', () => {
    /*
     * ⚠️ THE CASE THAT MAKES THE ASSERTION ABOVE MEAN ANYTHING. Every quote this
     *   engine produces has a total equal to the sum of its lines, so taking
     *   `quote.total` instead would be indistinguishable — measured, by making
     *   that substitution and watching the whole suite stay green.
     *
     *   An EXTERNAL provider's quote is where they can differ, and there the
     *   printed lines have to win: they are what the patient can add up on the
     *   page and what a return is filed from. A total nobody can derive from the
     *   document is a discrepancy with no explanation on it.
     */
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00')],
      quoteTax: (net) => ({
        treatment: 'STANDARD',
        lines: [
          {
            name: 'State Tax',
            rateBps: 600,
            amount: money(600, net.currency),
            jurisdiction: 'US-CA',
          },
          {
            name: 'County Tax',
            rateBps: 250,
            amount: money(250, net.currency),
            jurisdiction: 'US-CA',
          },
        ],
        // Not 850. A provider that disagrees with itself must not set the total.
        total: money(999, net.currency),
        placeOfSupply: 'US-CA',
        supplierTaxId: 'CA-0000',
        customerTaxId: null,
        reason: 'Sales tax.',
      }),
    });

    expect(priced.lines[0]?.taxAmount.amountMinor).toBe(850);
    expect(priced.taxTotal.amountMinor).toBe(850);
    expect(priced.grandTotal).toEqual(inr('108.50'));
  });

  it('splits India intra-state into halves that sum to the tax on the line', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('83.75')],
      quoteTax: realTax([rule({ taxCategory: 'MEDICINE', rateBps: 1200 })]),
    });

    const taxes = priced.lines[0]?.taxes ?? [];
    expect(taxes.map((t) => t.name)).toEqual(['CGST', 'SGST']);
    // 12% of 8375 is 1005 — an odd number of paise, so the halves cannot match.
    expect(taxes.map((t) => t.taxAmount.amountMinor)).toEqual([502, 503]);
    expect(priced.lines[0]?.taxAmount.amountMinor).toBe(1005);
    // Two governments, and the return needs to tell them apart.
    expect(taxes.map((t) => t.jurisdiction)).toEqual(['IN', 'IN-KA']);
  });

  it('records the invoice-level discount in the tax base, not beside it', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('1000.00')],
      discount: { type: 'PERCENTAGE', bps: 1000 },
      quoteTax: realTax([rule({ taxCategory: 'MEDICINE', rateBps: 1200 })]),
    });

    expect(priced.lines[0]?.taxes[0]?.taxableAmount).toEqual(inr('900.00'));
  });

  it('cites the clinic’s own rule in tax_rule_id and an inherited one in the other column', () => {
    const tenant = priceInvoice({
      currency: 'INR',
      lines: [line('100.00')],
      quoteTax: realTax([rule({ taxCategory: 'MEDICINE', id: 'rule-a', source: 'TENANT' })]),
    });
    expect(tenant.lines[0]?.taxes[0]?.taxRuleId).toBe('rule-a');
    expect(tenant.lines[0]?.taxes[0]?.taxRuleDefaultId).toBeNull();

    const platform = priceInvoice({
      currency: 'INR',
      lines: [line('100.00')],
      quoteTax: realTax([rule({ taxCategory: 'MEDICINE', id: 'def-a', source: 'PLATFORM' })]),
    });
    expect(platform.lines[0]?.taxes[0]?.taxRuleId).toBeNull();
    expect(platform.lines[0]?.taxes[0]?.taxRuleDefaultId).toBe('def-a');

    // Never both — the CHECK on invoice_taxes refuses that row.
    for (const priced of [tenant, platform]) {
      const tax = priced.lines[0]?.taxes[0];
      expect([tax?.taxRuleId, tax?.taxRuleDefaultId].filter(Boolean)).toHaveLength(1);
    }
  });

  it('cites the SAME rule on both halves of an Indian split', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00')],
      quoteTax: realTax([rule({ taxCategory: 'MEDICINE', id: 'rule-a' })]),
    });

    expect(priced.lines[0]?.taxes.map((t) => t.taxRuleId)).toEqual(['rule-a', 'rule-a']);
  });
});

describe('the document position', () => {
  const rules = [
    rule({ taxCategory: 'MEDICINE', rateBps: 1200 }),
    rule({ taxCategory: 'CONSULTATION', rateBps: 0, treatment: 'EXEMPT', id: 'rule-exempt' }),
  ];

  it('is STANDARD when a bill mixes a taxed line with an exempt one', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [
        line('500.00', { taxCategory: 'CONSULTATION', description: 'Consultation' }),
        line('100.00', { taxCategory: 'MEDICINE', description: 'Paracetamol' }),
      ],
      quoteTax: realTax(rules),
    });

    expect(priced.lines[0]?.taxTreatment).toBe('EXEMPT');
    expect(priced.lines[1]?.taxTreatment).toBe('STANDARD');
    // The summary is what the document DID, and it charged tax.
    expect(priced.taxTreatment).toBe('STANDARD');
    expect(priced.issuable).toBe(true);
    expect(priced.taxTotal).toEqual(inr('12.00'));
  });

  it('IS UNISSUABLE WHEN ONE LINE IS UNRATED, however many are fine', () => {
    /*
     * ⚠️ A category nobody configured must not be priced at a plausible rate.
     *   The draft exists saying exactly what is wrong with it, and Phase 5's
     *   finalisation refuses to ISSUE it.
     */
    const priced = priceInvoice({
      currency: 'INR',
      lines: [
        line('100.00', { taxCategory: 'MEDICINE' }),
        line('250.00', { taxCategory: 'SPLINT', description: 'Wrist splint' }),
      ],
      quoteTax: realTax(rules),
    });

    expect(priced.lines[1]?.taxTreatment).toBe('UNRATED');
    expect(priced.taxTreatment).toBe('UNRATED');
    expect(priced.issuable).toBe(false);
    expect(priced.unissuableReasons).toHaveLength(1);
    expect(priced.unissuableReasons[0]).toContain('Line 2 (Wrist splint)');
    // Nothing is charged on the unrated line, and the rest still prices.
    expect(priced.lines[1]?.taxAmount).toEqual(inr('0.00'));
    expect(priced.taxTotal).toEqual(inr('12.00'));
  });

  it('carries the place of supply and the registration onto the document', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00', { taxCategory: 'MEDICINE' })],
      quoteTax: realTax(rules),
    });

    expect(priced.placeOfSupply).toBe('IN-KA');
    expect(priced.issuerTaxId).toBe('29AAAAA0000A1Z5');
  });

  it('takes the registration from the first line that HAS one', () => {
    /*
     * An unregistered-in-that-place line carries no number while an exempt line
     * under the same registration still does. Taking line 1's blindly drops the
     * clinic's GSTIN off a bill whose first line happened to be untaxed.
     */
    let call = 0;
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.00'), line('100.00')],
      quoteTax: (net) => {
        call += 1;
        return {
          treatment: call === 1 ? 'NOT_REGISTERED' : 'EXEMPT',
          lines: [],
          total: money(0, net.currency),
          placeOfSupply: 'IN-KA',
          supplierTaxId: call === 1 ? null : '29AAAAA0000A1Z5',
          customerTaxId: null,
          reason: 'test',
        };
      },
    });

    expect(priced.issuerTaxId).toBe('29AAAAA0000A1Z5');
  });

  it('prices an empty draft as zero rather than throwing', () => {
    const priced = priceInvoice({ currency: 'INR', lines: [], quoteTax: flatTax(1800) });

    expect(priced.grandTotal).toEqual(inr('0.00'));
    expect(priced.taxTreatment).toBe('NOT_REGISTERED');
    expect(priced.issuable).toBe(true);
    expect(priced.placeOfSupply).toBeNull();
  });
});

describe('cash rounding', () => {
  it('rounds the TOTAL to the nearest rupee and records the difference', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('900.00')],
      cashRoundingMinor: 100,
      quoteTax: flatTax(1800), // 162.00 -> 1062.00 exactly
    });
    expect(priced.roundingAdjustment).toEqual(inr('0.00'));

    const odd = priceInvoice({
      currency: 'INR',
      lines: [line('901.40')],
      cashRoundingMinor: 100,
      quoteTax: flatTax(1800), // 162.25 -> 1063.65
    });
    expect(odd.roundingAdjustment).toEqual(inr('0.35'));
    expect(odd.grandTotal).toEqual(inr('1064.00'));
    expect(odd.grandTotal.amountMinor % 100).toBe(0);
  });

  it('rounds down and records a negative adjustment', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.20')],
      cashRoundingMinor: 100,
      quoteTax: flatTax(0),
    });

    expect(priced.roundingAdjustment).toEqual(inr('-0.20'));
    expect(priced.grandTotal).toEqual(inr('100.00'));
  });

  it('does not touch a line — the tax stated must stay the rate times the base', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.20')],
      cashRoundingMinor: 100,
      quoteTax: flatTax(1800),
    });

    expect(priced.lines[0]?.taxableAmount).toEqual(inr('100.20'));
    expect(priced.lines[0]?.taxAmount).toEqual(inr('18.04'));
    expect(priced.taxTotal).toEqual(inr('18.04'));
  });

  it('defaults to no rounding at all', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [line('100.20')],
      quoteTax: flatTax(0),
    });

    expect(priced.roundingAdjustment).toEqual(inr('0.00'));
    expect(priced.grandTotal).toEqual(inr('100.20'));
  });
});

describe('non-decimal currencies', () => {
  it('prices JPY, which has no minor unit', () => {
    const priced = priceInvoice({
      currency: 'JPY',
      lines: [
        {
          description: 'Consultation',
          taxCategory: 'CONSULTATION',
          quantityMilli: 3000,
          unitPrice: money(1000, 'JPY'),
        },
      ],
      quoteTax: (net) => {
        const amount = taxOn(net, 1000);
        return {
          treatment: 'STANDARD',
          lines: [{ name: 'Consumption Tax', rateBps: 1000, amount, jurisdiction: 'JP' }],
          total: amount,
          placeOfSupply: 'JP',
          supplierTaxId: 'T1234567890123',
          customerTaxId: null,
          reason: 'Consumption Tax at 10%.',
        };
      },
    });

    expect(priced.subtotal).toEqual(money(3000, 'JPY'));
    expect(priced.taxTotal).toEqual(money(300, 'JPY'));
    expect(priced.grandTotal).toEqual(money(3300, 'JPY'));
  });

  it('prices KWD, which has three', () => {
    // An engine assuming two decimals overcharges a Kuwaiti patient tenfold.
    const priced = priceInvoice({
      currency: 'KWD',
      lines: [
        {
          description: 'Consultation',
          taxCategory: 'CONSULTATION',
          quantityMilli: 1000,
          unitPrice: fromMajor('12.345', 'KWD'),
        },
      ],
      quoteTax: () => ({
        treatment: 'NOT_REGISTERED',
        lines: [],
        total: money(0, 'KWD'),
        placeOfSupply: 'KW',
        supplierTaxId: null,
        customerTaxId: null,
        reason: 'No tax charged.',
      }),
    });

    expect(priced.grandTotal.amountMinor).toBe(12_345);
  });
});

describe('the invoice adds up', () => {
  it('grandTotal = subtotal − discounts + tax + rounding, on a realistic bill', () => {
    const priced = priceInvoice({
      currency: 'INR',
      lines: [
        line('750.00', { taxCategory: 'CONSULTATION', description: 'Consultation' }),
        line('249.50', {
          taxCategory: 'MEDICINE',
          description: 'Amoxicillin 500mg',
          quantityMilli: 21_000,
          discount: { type: 'PERCENTAGE', bps: 500 },
        }),
        line('80.00', { taxCategory: 'MEDICINE', description: 'Syringe', quantityMilli: 3000 }),
      ],
      discount: { type: 'FIXED', amount: inr('200.00') },
      cashRoundingMinor: 100,
      quoteTax: realTax([
        rule({ taxCategory: 'MEDICINE', rateBps: 1200 }),
        rule({ taxCategory: 'CONSULTATION', rateBps: 0, treatment: 'EXEMPT', id: 'rule-exempt' }),
      ]),
    });

    expect(priced.subtotal.amountMinor).toBe(
      priced.lines.reduce((sum, l) => sum + l.grossAmount.amountMinor, 0)
    );
    expect(priced.taxableAmount.amountMinor).toBe(
      priced.subtotal.amountMinor -
        priced.lineDiscountTotal.amountMinor -
        priced.invoiceDiscountTotal.amountMinor
    );
    expect(priced.grandTotal.amountMinor).toBe(
      priced.subtotal.amountMinor -
        priced.lineDiscountTotal.amountMinor -
        priced.invoiceDiscountTotal.amountMinor +
        priced.taxTotal.amountMinor +
        priced.roundingAdjustment.amountMinor
    );
    // And each line internally, which is what a patient checks on the page.
    for (const l of priced.lines) {
      expect(l.taxableAmount.amountMinor).toBe(
        l.grossAmount.amountMinor - l.discountAmount.amountMinor - l.apportionedDiscount.amountMinor
      );
      expect(l.lineTotal.amountMinor).toBe(l.taxableAmount.amountMinor + l.taxAmount.amountMinor);
      expect(l.taxAmount.amountMinor).toBe(
        l.taxes.reduce((sum, t) => sum + t.taxAmount.amountMinor, 0)
      );
    }
    expect(priced.issuable).toBe(true);
    expect(priced.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
  });
});
