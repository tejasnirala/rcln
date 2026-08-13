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

import type { InvoiceDocumentData, InvoiceDocumentLine } from './types.js';

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

/**
 * A realistic pharmacy bill: real medicine names, real pack sizes, and prices
 * that differ line to line.
 *
 * ⚠️ THE PRICES AND QUANTITIES VARY ON PURPOSE, AND A UNIFORM SAMPLE HID A BUG.
 *   The older long sample charged 100.00 for every line, so every Taxable, every
 *   CGST and every SGST cell held the same string — a column that was
 *   mis-aligned, truncated or rendering the wrong field looked perfectly
 *   plausible. Different figures of different WIDTHS are what make a money
 *   column's alignment checkable by eye.
 *
 * ⚠️ THE MEDICINES ARE ORDINARY GENERICS AND THE RATES ARE THE TWO THIS DOCUMENT
 *   NEEDS TO SHOW. Nothing here is a clinical or a tax recommendation — it is a
 *   fixture for a layout. The 5% band is where most formulations sit and the 12%
 *   band is where the rest do, which is what makes a two-rate tax summary worth
 *   printing at all.
 */
const MEDICINES: readonly {
  name: string;
  pack: string;
  hsn: string;
  qty: string;
  unitMinor: number;
  rateBps: number;
}[] = [
  {
    name: 'Paracetamol 650mg tablets',
    pack: 'strip of 15',
    hsn: '30049099',
    qty: '2.000',
    unitMinor: 3150,
    rateBps: 1200,
  },
  {
    name: 'Amoxicillin 500mg capsules',
    pack: 'strip of 10',
    hsn: '30041020',
    qty: '1.000',
    unitMinor: 11840,
    rateBps: 1200,
  },
  {
    name: 'Azithromycin 500mg tablets',
    pack: 'strip of 3',
    hsn: '30042039',
    qty: '1.000',
    unitMinor: 8975,
    rateBps: 1200,
  },
  {
    name: 'Pantoprazole 40mg tablets',
    pack: 'strip of 15',
    hsn: '30049069',
    qty: '3.000',
    unitMinor: 6420,
    rateBps: 1200,
  },
  {
    name: 'Metformin 500mg SR tablets',
    pack: 'strip of 20',
    hsn: '30049079',
    qty: '2.000',
    unitMinor: 4780,
    rateBps: 1200,
  },
  {
    name: 'Cetirizine 10mg tablets',
    pack: 'strip of 10',
    hsn: '30049099',
    qty: '1.000',
    unitMinor: 2145,
    rateBps: 500,
  },
  {
    name: 'Ascoril LS cough syrup 100ml',
    pack: 'bottle of 100ml',
    hsn: '30049011',
    qty: '1.000',
    unitMinor: 12650,
    rateBps: 1200,
  },
  {
    name: 'Insulin glargine 100IU/ml',
    pack: '3ml cartridge',
    hsn: '30043110',
    qty: '1.000',
    unitMinor: 89500,
    rateBps: 500,
  },
  {
    name: 'Salbutamol inhaler 100mcg',
    pack: '200 doses',
    hsn: '30049062',
    qty: '1.000',
    unitMinor: 21875,
    rateBps: 500,
  },
  {
    name: 'ORS sachets, orange',
    pack: 'box of 10',
    hsn: '30049099',
    qty: '4.000',
    unitMinor: 1950,
    rateBps: 500,
  },
  {
    name: 'Povidone-iodine 5% solution 100ml',
    pack: 'bottle of 100ml',
    hsn: '30049087',
    qty: '1.000',
    unitMinor: 8340,
    rateBps: 1200,
  },
  {
    name: 'Sterile gauze swabs 10x10cm',
    pack: 'pack of 50',
    hsn: '30059040',
    qty: '2.000',
    unitMinor: 15600,
    rateBps: 1200,
  },
  {
    name: 'Disposable syringes 5ml',
    pack: 'box of 100',
    hsn: '90183100',
    qty: '1.000',
    unitMinor: 42500,
    rateBps: 1200,
  },
  {
    name: 'Vitamin D3 60000IU sachets',
    pack: 'pack of 4',
    hsn: '30045020',
    qty: '2.000',
    unitMinor: 9960,
    rateBps: 1200,
  },
  {
    name: 'Digital thermometer, flexible tip',
    pack: 'single unit',
    hsn: '90251110',
    qty: '1.000',
    unitMinor: 24900,
    rateBps: 1800,
  },
];

/**
 * One pharmacy line, with its CGST/SGST split worked out from the rate.
 *
 * ⚠️ THE HALVES ARE COMPUTED AND THEN THE SECOND IS TAKEN AS THE REMAINDER, NOT
 *   HALVED AGAIN. An odd number of paise cannot be split evenly, and rounding
 *   both halves independently makes them sum to one paisa more or less than the
 *   line's tax — which is exactly the kind of discrepancy this document exists
 *   to not have. `@rcln/tax` splits a real one the same way.
 */
function pharmacyLine(
  index: number,
  medicine: (typeof MEDICINES)[number],
  discountMinor = 0
): InvoiceDocumentLine {
  const quantity = Number(medicine.qty);
  const gross = Math.round(medicine.unitMinor * quantity);
  const taxable = gross - discountMinor;
  const tax = Math.round((taxable * medicine.rateBps) / 10_000);
  const half = Math.floor(tax / 2);

  return {
    lineNumber: index + 1,
    description: medicine.name,
    packaging: medicine.pack,
    itemCode: medicine.hsn,
    quantity: medicine.qty,
    unitPriceMinor: medicine.unitMinor,
    grossAmountMinor: gross,
    discountAmountMinor: discountMinor,
    apportionedDiscountMinor: 0,
    taxableAmountMinor: taxable,
    taxAmountMinor: tax,
    lineTotalMinor: taxable + tax,
    taxes: [
      { name: 'CGST', rateBps: medicine.rateBps / 2, taxAmountMinor: half },
      { name: 'SGST', rateBps: medicine.rateBps / 2, taxAmountMinor: tax - half },
    ],
  };
}

/** A pharmacy bill of `lineCount` lines, cycling the medicine list. */
export function pharmacyInvoice(lineCount = 12): InvoiceDocumentData {
  const lines = Array.from({ length: lineCount }, (_, index) =>
    pharmacyLine(
      index,
      MEDICINES[index % MEDICINES.length] as (typeof MEDICINES)[number],
      // A discount on a couple of lines, so the column is not a row of dashes.
      index % 7 === 3 ? 2500 : 0
    )
  );

  const taxable = lines.reduce((sum, line) => sum + line.taxableAmountMinor, 0);
  const gross = lines.reduce((sum, line) => sum + line.grossAmountMinor, 0);
  const discount = lines.reduce((sum, line) => sum + line.discountAmountMinor, 0);

  /** Grouped by rate, the way the summary block prints it. */
  const byRate = new Map<number, number>();
  for (const line of lines) {
    for (const tax of line.taxes) {
      byRate.set(tax.rateBps, (byRate.get(tax.rateBps) ?? 0) + tax.taxAmountMinor);
    }
  }

  const taxableByRate = new Map<number, number>();
  for (const line of lines) {
    const rate = line.taxes[0]?.rateBps ?? 0;
    taxableByRate.set(rate, (taxableByRate.get(rate) ?? 0) + line.taxableAmountMinor);
  }

  const taxTotal = lines.reduce((sum, line) => sum + line.taxAmountMinor, 0);
  const summary = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([rateBps, amount]) =>
      (['CGST', 'SGST'] as const).map((name) => ({
        name,
        jurisdiction: 'IN',
        rateBps,
        taxableAmountMinor: taxableByRate.get(rateBps) ?? 0,
        taxAmountMinor: Math.round(amount / 2),
      }))
    );

  return {
    ...indianInvoice,
    sourceType: 'PHARMACY',
    invoiceNumber: `INV-2026-PHA-MAIN-${String(400 + lineCount).padStart(6, '0')}`,
    notes: 'Medicines once sold are not returnable. Keep this bill for any warranty claim.',
    lines,
    taxSummary: summary,
    totals: {
      subtotalMinor: gross,
      lineDiscountTotalMinor: discount,
      invoiceDiscountTotalMinor: 0,
      taxableAmountMinor: taxable,
      taxTotalMinor: taxTotal,
      roundingAdjustmentMinor: 0,
      grandTotalMinor: taxable + taxTotal,
      amountPaidMinor: 0,
      balanceDueMinor: taxable + taxTotal,
    },
  };
}

/**
 * A hospital whose address genuinely runs to five lines.
 *
 * ⚠️ THIS EXISTS BECAUSE A FIVE-LINE ADDRESS BROKE THE RUNNING HEADER. The block
 *   was set one-line-per-entry, so it overflowed the fixed band and its tail
 *   disappeared under the rule that closes the header — which reads as the rule
 *   striking through the text. The address now WRAPS inside a column over 100mm
 *   wide, so this fits in two or three lines. Keep this sample: it is the case
 *   that fails, and a shorter one will not catch a regression.
 */
export function longAddressInvoice(lineCount = 55): InvoiceDocumentData {
  const base = pharmacyInvoice(lineCount);

  return {
    ...base,
    issuer: {
      ...base.issuer,
      legalName: 'Sanjeevani Multi-Speciality Hospitals Private Limited',
      tradeName: 'Sanjeevani Hospital',
      branchName: 'Malviya Nagar Branch',
      addressLines: [
        'Plot 42, Sector 11, Healthcare City',
        'Opposite Central Metro Station, Malviya Nagar',
        'Jaipur, Rajasthan 302017',
        'India',
        'Landmark: Beside the District Civil Court',
      ],
      phone: '+91 141 4001 2200',
      email: 'billing@sanjeevani-hospital.example',
    },
  };
}

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
