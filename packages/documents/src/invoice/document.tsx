/**
 * The invoice, as markup.
 *
 * ⚠️ THIS COMPONENT IS RENDERED WITH `renderToStaticMarkup` AND NEVER MOUNTED.
 *   There is no state, no effect, no event handler and no `useId` anywhere in
 *   it, and there must not be: the output is a string that goes into an
 *   `srcdoc` iframe and into Chromium's `setContent`. React is here as a typed
 *   templating language — the thing that makes a nine-column table with three
 *   optional blocks readable — and not as a runtime.
 *
 * ⚠️ IT READS ONLY ITS PROPS. No fetch, no import of a service, no clock. The
 *   whole argument for this design is that the preview and the print are the
 *   same function of the same value; a component that reached for anything not
 *   in `InvoiceDocumentData` would break that on the axis nobody checks, because
 *   both renderings would still look right in development where the two
 *   environments happen to agree.
 *
 * ⚠️ AND IT NEVER DECIDES A NUMBER. Every amount is printed from the snapshot.
 *   The temptation on a document like this is to compute the balance, or sum the
 *   tax column "so the page is always consistent" — and that would be a second
 *   implementation of `@rcln/invoicing`, in a template, disagreeing with the
 *   database by a paisa in the cases that matter. If a total looks wrong, the
 *   row is wrong, and that is the correct place to find it.
 */

import type { JSX } from 'react';

import {
  ChromeTemplates,
  PageFooter,
  PageHeader,
  type DocumentChrome,
  type DocumentChromeMetaRow,
} from '../chrome/index.js';

import { createFormatter, type InvoiceFormatter } from './format.js';
import { itemTableFor } from './items.js';
import type { InvoiceDocumentData, InvoiceTaxTreatment } from './types.js';

/**
 * What the document calls itself.
 *
 * ⚠️ THIS IS NOT DECORATION AND IT IS NOT ONE STRING. Under GST a registered
 *   clinic supplying an exempt service issues a **Bill of Supply**, not a Tax
 *   Invoice, and the two are different documents with different obligations —
 *   a Tax Invoice heading over a line charging no tax is a self-contradicting
 *   document. "TAX INVOICE" is also the correct heading in Australia, Singapore,
 *   New Zealand and the UAE, and is NOT how the UK or Ireland head one.
 *
 *   Phase 2b's lesson, in the title bar: the arithmetic was right on a
 *   non-compliant document, and every total-based assertion passed.
 */
export function documentTitle(countryCode: string, treatment: InvoiceTaxTreatment): string {
  const country = countryCode.toUpperCase();

  /*
   * Nothing was charged because nothing could be. A clinic below the
   * registration threshold issues an ordinary invoice everywhere — calling it a
   * tax invoice would assert a registration it does not hold.
   */
  if (treatment === 'NOT_REGISTERED') return 'Invoice';

  if (country === 'IN') {
    return treatment === 'EXEMPT' ? 'Bill of Supply' : 'Tax Invoice';
  }

  const taxInvoiceCountries = new Set(['AU', 'NZ', 'SG', 'AE', 'ZA', 'MY']);
  return taxInvoiceCountries.has(country) ? 'Tax Invoice' : 'Invoice';
}

export function InvoiceDocument({
  data,
  fontFaces,
}: {
  data: InvoiceDocumentData;
  /**
   * The `@font-face` blocks, passed down so the PRINT chrome can carry its own
   * copy — Chromium's header and footer templates are a separate document and
   * inherit nothing from this one, typefaces included. Empty in tests.
   */
  fontFaces: string;
}): JSX.Element {
  const fmt = createFormatter(data);
  const voided = data.status === 'VOID';

  /*
   * ⚠️ THE ONLY PART OF THIS DOCUMENT THAT VARIES BY WHAT WAS SOLD. Everything
   *   around it — the masthead, the registration number, the tax summary, the
   *   totals, the heading — is identical on a consultation, a dispense and a lab
   *   bill, and is deliberately rendered once so it cannot drift between them.
   *   See the header of `items.tsx`.
   */
  const Items = itemTableFor(data.sourceType);

  const chrome = invoiceChrome(data, fmt);

  return (
    <div className="sheet">
      {voided ? <div className="void-mark">VOID</div> : null}

      {/*
       * The preview's header, and the printer's chrome as two inert
       * `<template>` elements — one set of components, one value.
       *
       * ⚠️ THE PREVIEW'S FOOTER IS AT THE BOTTOM OF THIS SHEET, NOT HERE BESIDE
       *   THE HEADER, AND THAT ORDER IS NOW LOAD-BEARING. While the chrome was
       *   `position: fixed` the source position did not matter, so both sat
       *   together; once print switched to Chromium's templates and these became
       *   ordinary flow elements, a footer declared here rendered directly under
       *   the header — above the invoice — in every on-screen preview. The PDF
       *   was correct throughout, which is why it survived a round of review.
       */}
      <PageHeader chrome={chrome} />
      <ChromeTemplates chrome={chrome} fontFaces={fontFaces} />

      <Parties data={data} fmt={fmt} />
      <Items data={data} fmt={fmt} />

      <div className="foot">
        <TaxSummary data={data} fmt={fmt} />
        <Totals data={data} fmt={fmt} />
      </div>

      <Closing data={data} />

      {/* The preview's footer. Hidden in print — the printer uses the template. */}
      <PageFooter chrome={chrome} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The chrome
// ---------------------------------------------------------------------------

/**
 * `InvoiceDocumentData` → the repeating header and footer.
 *
 * ⚠️ THIS REPLACED A `Masthead` THAT PRINTED ONCE, AT THE TOP OF PAGE ONE. On a
 *   two-page invoice the second sheet carried no clinic name, no registration
 *   number and no invoice number — a page that, detached from the first, named
 *   nobody. Everything below is the same content the masthead held; what changed
 *   is that it now sits in a fixed band Chromium repeats on every page.
 *
 * ⚠️ THE DATES GO THROUGH `fmt`, NEVER THROUGH A CLOCK. `createFormatter` takes
 *   its zone and locale from the document data, so the header prints the same
 *   string in the preview, in the worker's UTC container, and in Kolkata.
 */
function invoiceChrome(data: InvoiceDocumentData, fmt: InvoiceFormatter): DocumentChrome {
  const { issuer } = data;

  const meta: DocumentChromeMetaRow[] = [
    {
      label: 'Document No.',
      /*
       * A draft has no number, and saying so is better than an empty value: an
       * invoice number is issued at the moment of issue and never before, so a
       * blank here would read as a rendering fault rather than as a draft.
       */
      value: data.invoiceNumber ?? 'Not yet issued',
      mono: data.invoiceNumber !== null,
    },
  ];

  if (data.issuedAt !== null) meta.push({ label: 'Issued', value: fmt.date(data.issuedAt) });
  meta.push({ label: 'Supplied', value: fmt.date(data.suppliedAt) });
  if (data.dueDate !== null) meta.push({ label: 'Due', value: fmt.date(data.dueDate) });

  return {
    issuer: {
      legalName: issuer.legalName,
      tradeName: issuer.tradeName,
      branchName: issuer.branchName,
      branchCode: issuer.branchCode,
      addressLines: issuer.addressLines,
      phone: issuer.phone,
      email: issuer.email,
      taxId: issuer.taxId,
      taxIdLabel: issuer.taxIdLabel,
    },
    title: documentTitle(data.countryCode, data.taxTreatment),
    meta,
    /*
     * ⚠️ A CLAIM, NOT BOILERPLATE. Indian practice accepts an unsigned invoice
     *   precisely when it says it is computer generated; one that does not say
     *   so is one a recipient can reasonably reject. It appears on every page
     *   rather than only on the last, which is what a reader of a detached sheet
     *   needs.
     *
     * ⚠️ THE DOCUMENT NUMBER IS DELIBERATELY NOT REPEATED HERE. It is already in
     *   the running header, on every page, in mono beside its own label —
     *   printing it again at the foot of the same sheet is the same string twice
     *   and reads as though the two might differ.
     */
    footerNote: 'This is a computer-generated document and does not require a signature.',
  };
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

function Parties({ data, fmt }: { data: InvoiceDocumentData; fmt: InvoiceFormatter }): JSX.Element {
  const { customer } = data;
  const contact = [customer.phone, customer.email].filter(Boolean).join('  ·  ');

  return (
    <section className="parties">
      <div>
        <span className="label">Billed to</span>
        <div className="party-name">{customer.name}</div>
        {customer.address === null ? null : <div className="party-detail">{customer.address}</div>}
        {contact === '' ? null : <div className="party-detail">{contact}</div>}
        {customer.taxId === null ? null : (
          <div className="party-detail">
            <span className="label">Tax ID</span> <span className="mono">{customer.taxId}</span>
          </div>
        )}
      </div>

      <div className="party-right">
        <dl className="supply-grid">
          {customer.patientNumber === null ? null : (
            <>
              <dt className="label">Patient</dt>
              <dd className="mono">{customer.patientNumber}</dd>
            </>
          )}
          {/*
            ⚠️ WHO PROVIDED THE CARE, WITHOUT WHICH THIS IS A RECEIPT FOR AN
              UNATTRIBUTED SERVICE — not claimable by the patient and not
              acceptable to an insurer. Read from the invoice's own snapshot, so
              a doctor who has since left or re-registered does not restate a
              document already handed over.

              Beside the patient rather than in the "Billed to" block on
              purpose: the clinician is not a party to the transaction. The
              clinic bills, the patient pays, and the doctor is what was
              supplied.
          */}
          {data.practitioner === null ? null : (
            <>
              <dt className="label">Attended by</dt>
              <dd>{data.practitioner.name}</dd>

              {/*
               * ⚠️ ITS OWN LABELLED ROW, NOT A SECOND LINE UNDER THE NAME. The
               *   registration number is what makes the attribution checkable —
               *   an insurer verifies the clinician against a register by it —
               *   so it reads as a field somebody can look up rather than as a
               *   qualifier trailing the name. It also lines up with the other
               *   identifiers in this block, all of which are labelled and set
               *   in mono.
               */}
              {data.practitioner.registrationNumber === null ? null : (
                <>
                  <dt className="label">Registration No.</dt>
                  <dd className="mono">{data.practitioner.registrationNumber}</dd>
                </>
              )}
            </>
          )}
          {data.placeOfSupply === null ? null : (
            <>
              <dt className="label">Place of supply</dt>
              <dd className="mono">{data.placeOfSupply}</dd>
            </>
          )}
          <dt className="label">Currency</dt>
          <dd className="mono">
            {data.currency} {fmt.currencySymbol}
          </dd>
        </dl>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tax summary
// ---------------------------------------------------------------------------

function TaxSummary({
  data,
  fmt,
}: {
  data: InvoiceDocumentData;
  fmt: InvoiceFormatter;
}): JSX.Element {
  if (data.taxSummary.length === 0) {
    /*
     * No tax was charged, and WHY matters. `NOT_REGISTERED` is a legal position
     * a clinic below the threshold is entitled to and an auditor needs stated;
     * `EXEMPT` is a property of the supply. Printing nothing at all would leave
     * a document that simply appears to have forgotten.
     */
    return (
      <div>
        <span className="label">Tax</span>
        <div className="party-detail">{noTaxExplanation(data.taxTreatment)}</div>
      </div>
    );
  }

  return (
    <div>
      <span className="label">Tax summary</span>
      <table className="tax-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>Jurisdiction</th>
            <th className="num">Rate</th>
            <th className="num">Taxable</th>
            <th className="num">Tax</th>
          </tr>
        </thead>
        <tbody>
          {data.taxSummary.map((row) => (
            <tr key={`${row.name}-${String(row.rateBps)}-${row.jurisdiction ?? ''}`}>
              <td className="strong">{row.name}</td>
              <td className="mono muted">{row.jurisdiction ?? '—'}</td>
              <td className="num">{fmt.rate(row.rateBps)}</td>
              <td className="num">{fmt.amount(row.taxableAmountMinor)}</td>
              <td className="num">{fmt.amount(row.taxAmountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function noTaxExplanation(treatment: InvoiceTaxTreatment): string {
  switch (treatment) {
    case 'NOT_REGISTERED':
      return 'No tax charged — the supplier is not registered for tax in the place of supply.';
    case 'EXEMPT':
      return 'No tax charged — this supply is exempt.';
    case 'ZERO_RATED':
      return 'No tax charged — this supply is zero-rated.';
    case 'REVERSE_CHARGE':
      return 'No tax charged — tax is payable by the recipient under the reverse charge.';
    default:
      return 'No tax charged.';
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function Totals({ data, fmt }: { data: InvoiceDocumentData; fmt: InvoiceFormatter }): JSX.Element {
  const { totals } = data;
  const discount = totals.lineDiscountTotalMinor + totals.invoiceDiscountTotalMinor;

  return (
    <table className="totals">
      <tbody>
        <TotalRow label="Subtotal" value={fmt.amount(totals.subtotalMinor)} />
        {discount === 0 ? null : <TotalRow label="Discount" value={fmt.deduction(discount)} />}
        <TotalRow label="Taxable value" value={fmt.amount(totals.taxableAmountMinor)} />
        {totals.taxTotalMinor === 0 ? null : (
          <TotalRow label="Tax" value={fmt.amount(totals.taxTotalMinor)} />
        )}
        {/*
         * Cash rounding gets its own line rather than being folded into the
         * total. Phase 4 gave it its own column for the same reason: the grand
         * total should never need explaining, and a figure that is one paisa off
         * the sum of the lines above it needs explaining unless the difference
         * is named.
         */}
        {totals.roundingAdjustmentMinor === 0 ? null : (
          <TotalRow
            label="Rounding"
            value={
              totals.roundingAdjustmentMinor < 0
                ? fmt.deduction(totals.roundingAdjustmentMinor)
                : `+${fmt.amount(totals.roundingAdjustmentMinor)}`
            }
          />
        )}

        <tr className="grand">
          <td>Total</td>
          <td className="num">
            {fmt.currencySymbol} {fmt.amount(totals.grandTotalMinor)}
          </td>
        </tr>

        {totals.amountPaidMinor === 0 ? null : (
          <>
            <tr className="settlement">
              <td className="totals-label">Paid</td>
              <td className="num">{fmt.amount(totals.amountPaidMinor)}</td>
            </tr>
            <tr className="settlement balance">
              <td>Balance due</td>
              <td className="num">{fmt.amount(totals.balanceDueMinor)}</td>
            </tr>
          </>
        )}
      </tbody>
    </table>
  );
}

function TotalRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <tr>
      <td className="totals-label">{label}</td>
      <td className="num">{value}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

function Closing({ data }: { data: InvoiceDocumentData }): JSX.Element {
  return (
    <>
      <section className="closing">
        <div>
          {data.notes === null ? null : (
            <>
              <span className="label">Notes</span>
              <div className="notes">{data.notes}</div>
            </>
          )}
        </div>

        <div className="signature">
          <div className="signature-rule">For {data.issuer.tradeName ?? data.issuer.legalName}</div>
        </div>
      </section>

      {/*
       * ⚠️ THE COLOPHON THAT WAS HERE IS NOW THE RUNNING FOOTER, AND DELETING IT
       *   RATHER THAN LEAVING BOTH WAS THE POINT. "Computer-generated" is a
       *   claim about this document — Indian practice accepts an unsigned
       *   invoice precisely when it says so — and it now appears on every page
       *   instead of only the last, which is what a reader of a detached second
       *   sheet needs. Keeping this block as well would print it twice on the
       *   final page. See `invoiceChrome`.
       */}
    </>
  );
}
