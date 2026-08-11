/**
 * Sample documents — the shapes that break a template.
 *
 * The everyday Indian bill with a CGST/SGST split and an apportioned discount;
 * the unregistered clinic whose document must NOT call itself a tax invoice; a
 * currency with no minor unit; and a bill long enough to break across pages.
 *
 * ⚠️ THEY ARE IN `src/` AND NOT IN `tests/`, DELIBERATELY, BECAUSE THEY HAVE
 *   THREE CONSUMERS AND ONLY ONE OF THEM IS A TEST. `scripts/preview.mjs`
 *   renders them so the document can be looked at without constructing an
 *   invoice through the API first, and a design screen can do the same. Keeping
 *   a second copy beside the tests is how the version somebody looks at stops
 *   being the version somebody asserts on.
 *
 * ⚠️ EVERY NAME, NUMBER AND ADDRESS HERE IS INVENTED. No real clinic, no real
 *   patient, no real GSTIN — this file is committed, and a plausible-looking
 *   registration number in a public repository is somebody's.
 */

import type { InvoiceDocumentData } from './types.js';

/**
 * A Karnataka clinic billing a patient: one exempt consultation, one 12%
 * medicine, a whole-bill discount and cash rounding. The everyday case, and the
 * one that exercises the split, the apportionment and the mixed treatment at
 * once.
 */
export const indianInvoice: InvoiceDocumentData = {
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  countryCode: 'IN',

  invoiceNumber: 'INV-2026-APP-MAIN-000042',
  status: 'ISSUED',
  issuedAt: '2026-08-09T11:20:00.000Z',
  suppliedAt: '2026-08-09T11:00:00.000Z',
  dueDate: '2026-08-16T11:00:00.000Z',
  placeOfSupply: 'IN-KA',
  taxTreatment: 'STANDARD',
  notes: 'Please bring this invoice to your follow-up on 23 August.',
  sourceType: 'APPOINTMENT',

  issuer: {
    legalName: 'Anandi Healthcare Services Private Limited',
    tradeName: 'Anandi Clinic',
    branchName: 'Indiranagar',
    branchCode: 'MAIN',
    addressLines: ['418, 12th Main Road, HAL 2nd Stage', 'Bengaluru 560008, Karnataka'],
    phone: '+91 80 4123 8890',
    email: 'billing@anandiclinic.in',
    taxId: '29AABCA1234M1ZP',
    taxIdLabel: 'GSTIN',
  },

  customer: {
    name: 'Rohit Venkataraman',
    phone: '+91 98450 11223',
    email: null,
    address: '22 Cambridge Layout, Ulsoor\nBengaluru 560008',
    taxId: null,
    patientNumber: 'MRN-000185',
  },

  /* Named on the bill, so the patient can claim it and an insurer can accept it. */
  practitioner: { name: 'Dr Anjali Rao', registrationNumber: 'KMC/2011/45231' },

  lines: [
    {
      lineNumber: 1,
      description: 'Consultation — general medicine, follow-up',
      itemCode: '999312',
      quantity: '1.000',
      unitPriceMinor: 60000,
      grossAmountMinor: 60000,
      discountAmountMinor: 0,
      apportionedDiscountMinor: 3243,
      taxableAmountMinor: 56757,
      taxAmountMinor: 0,
      lineTotalMinor: 56757,
      taxes: [],
    },
    {
      lineNumber: 2,
      description: 'Paracetamol IP 650mg tablets',
      itemCode: '30049099',
      quantity: '10.000',
      unitPriceMinor: 250,
      grossAmountMinor: 2500,
      discountAmountMinor: 0,
      apportionedDiscountMinor: 135,
      taxableAmountMinor: 2365,
      taxAmountMinor: 284,
      lineTotalMinor: 2649,
      taxes: [
        { name: 'CGST', rateBps: 600, taxAmountMinor: 142 },
        { name: 'SGST', rateBps: 600, taxAmountMinor: 142 },
      ],
    },
    {
      lineNumber: 3,
      description: 'Sterile dressing pack',
      itemCode: '30051090',
      quantity: '2.500',
      unitPriceMinor: 4800,
      grossAmountMinor: 12000,
      discountAmountMinor: 1200,
      apportionedDiscountMinor: 583,
      taxableAmountMinor: 10217,
      taxAmountMinor: 1839,
      lineTotalMinor: 12056,
      taxes: [
        { name: 'CGST', rateBps: 900, taxAmountMinor: 920 },
        { name: 'SGST', rateBps: 900, taxAmountMinor: 919 },
      ],
    },
  ],

  taxSummary: [
    {
      name: 'CGST',
      jurisdiction: 'IN',
      rateBps: 600,
      taxableAmountMinor: 2365,
      taxAmountMinor: 142,
    },
    {
      name: 'SGST',
      jurisdiction: 'IN-KA',
      rateBps: 600,
      taxableAmountMinor: 2365,
      taxAmountMinor: 142,
    },
    {
      name: 'CGST',
      jurisdiction: 'IN',
      rateBps: 900,
      taxableAmountMinor: 10217,
      taxAmountMinor: 920,
    },
    {
      name: 'SGST',
      jurisdiction: 'IN-KA',
      rateBps: 900,
      taxableAmountMinor: 10217,
      taxAmountMinor: 919,
    },
  ],

  totals: {
    subtotalMinor: 74500,
    lineDiscountTotalMinor: 1200,
    invoiceDiscountTotalMinor: 3961,
    taxableAmountMinor: 69339,
    taxTotalMinor: 2123,
    roundingAdjustmentMinor: 38,
    grandTotalMinor: 71500,
    amountPaidMinor: 50000,
    balanceDueMinor: 21500,
  },
};

/**
 * A clinic below the registration threshold, billing one exempt consultation.
 *
 * ⚠️ THIS ONE MUST NOT SAY "TAX INVOICE". It charges no tax and holds no
 *   registration, and a heading that claims otherwise is a claim about a legal
 *   status the clinic does not have.
 */
export const unregisteredInvoice: InvoiceDocumentData = {
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  countryCode: 'IN',

  invoiceNumber: 'INV-2026-APP-KORA-000007',
  status: 'ISSUED',
  issuedAt: '2026-08-09T04:05:00.000Z',
  suppliedAt: '2026-08-09T04:00:00.000Z',
  dueDate: null,
  placeOfSupply: 'IN-KA',
  taxTreatment: 'NOT_REGISTERED',
  notes: null,
  sourceType: 'APPOINTMENT',

  issuer: {
    legalName: 'Dr Meera Iyer',
    tradeName: null,
    branchName: 'Koramangala',
    branchCode: 'KORA',
    addressLines: ['7th Block, Koramangala', 'Bengaluru 560095, Karnataka'],
    phone: '+91 80 2550 1188',
    email: null,
    taxId: null,
    taxIdLabel: 'GSTIN',
  },

  customer: {
    name: 'Walk-in customer',
    phone: null,
    email: null,
    address: null,
    taxId: null,
    patientNumber: null,
  },

  /*
   * Null on purpose, and the second thing this sample exists to show. A
   * sole practitioner IS the issuer — repeating the name under "Attended by"
   * would print it twice on one small receipt.
   */
  practitioner: null,

  lines: [
    {
      lineNumber: 1,
      description: 'Consultation — first visit',
      itemCode: '999312',
      quantity: '1.000',
      unitPriceMinor: 40000,
      grossAmountMinor: 40000,
      discountAmountMinor: 0,
      apportionedDiscountMinor: 0,
      taxableAmountMinor: 40000,
      taxAmountMinor: 0,
      lineTotalMinor: 40000,
      taxes: [],
    },
  ],

  taxSummary: [],

  totals: {
    subtotalMinor: 40000,
    lineDiscountTotalMinor: 0,
    invoiceDiscountTotalMinor: 0,
    taxableAmountMinor: 40000,
    taxTotalMinor: 0,
    roundingAdjustmentMinor: 0,
    grandTotalMinor: 40000,
    amountPaidMinor: 40000,
    balanceDueMinor: 0,
  },
};

/**
 * Japan: a currency with NO minor unit.
 *
 * ¥1200 is 1200 minor units, not 12.00. A template that assumed two decimal
 * places would print ¥12.00 for a ¥1,200 consultation — off by a hundred, and
 * plausible enough on the page that nobody would question it.
 */
export const yenInvoice: InvoiceDocumentData = {
  ...unregisteredInvoice,
  currency: 'JPY',
  countryCode: 'JP',
  timezone: 'Asia/Tokyo',
  invoiceNumber: 'INV-2026-APP-TKY-000003',
  taxTreatment: 'STANDARD',
  placeOfSupply: 'JP',
  issuer: {
    ...unregisteredInvoice.issuer,
    legalName: 'Sakura Family Clinic K.K.',
    tradeName: null,
    branchName: 'Shibuya',
    branchCode: 'TKY',
    addressLines: ['2-21-1 Shibuya', 'Tokyo 150-0002'],
    taxId: 'T1234567890123',
    taxIdLabel: 'Registration No.',
  },
  lines: [
    {
      lineNumber: 1,
      description: 'Consultation',
      itemCode: null,
      quantity: '1.000',
      unitPriceMinor: 5000,
      grossAmountMinor: 5000,
      discountAmountMinor: 0,
      apportionedDiscountMinor: 0,
      taxableAmountMinor: 5000,
      taxAmountMinor: 500,
      lineTotalMinor: 5500,
      taxes: [{ name: 'Consumption Tax', rateBps: 1000, taxAmountMinor: 500 }],
    },
  ],
  taxSummary: [
    {
      name: 'Consumption Tax',
      jurisdiction: 'JP',
      rateBps: 1000,
      taxableAmountMinor: 5000,
      taxAmountMinor: 500,
    },
  ],
  totals: {
    subtotalMinor: 5000,
    lineDiscountTotalMinor: 0,
    invoiceDiscountTotalMinor: 0,
    taxableAmountMinor: 5000,
    taxTotalMinor: 500,
    roundingAdjustmentMinor: 0,
    grandTotalMinor: 5500,
    amountPaidMinor: 0,
    balanceDueMinor: 0,
  },
};

/** Long enough to break across pages — the repeated `<thead>` case. */
export function longInvoice(lineCount = 45): InvoiceDocumentData {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    lineNumber: index + 1,
    description: `Consumable item ${String(index + 1)} — sterile, single use, box of 10`,
    itemCode: '30051090',
    quantity: '1.000',
    unitPriceMinor: 10000,
    grossAmountMinor: 10000,
    discountAmountMinor: 0,
    apportionedDiscountMinor: 0,
    taxableAmountMinor: 10000,
    taxAmountMinor: 1800,
    lineTotalMinor: 11800,
    taxes: [
      { name: 'CGST', rateBps: 900, taxAmountMinor: 900 },
      { name: 'SGST', rateBps: 900, taxAmountMinor: 900 },
    ],
  }));

  const gross = 10000 * lineCount;
  const tax = 1800 * lineCount;

  return {
    ...indianInvoice,
    invoiceNumber: 'INV-2026-PHA-MAIN-000311',
    notes: null,
    lines,
    taxSummary: [
      {
        name: 'CGST',
        jurisdiction: 'IN',
        rateBps: 900,
        taxableAmountMinor: gross,
        taxAmountMinor: tax / 2,
      },
      {
        name: 'SGST',
        jurisdiction: 'IN-KA',
        rateBps: 900,
        taxableAmountMinor: gross,
        taxAmountMinor: tax / 2,
      },
    ],
    totals: {
      subtotalMinor: gross,
      lineDiscountTotalMinor: 0,
      invoiceDiscountTotalMinor: 0,
      taxableAmountMinor: gross,
      taxTotalMinor: tax,
      roundingAdjustmentMinor: 0,
      grandTotalMinor: gross + tax,
      amountPaidMinor: 0,
      balanceDueMinor: 0,
    },
  };
}
