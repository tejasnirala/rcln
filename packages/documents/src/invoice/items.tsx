/**
 * The line-item table, which is the ONE part of an invoice that differs by what
 * is being sold.
 *
 * ⚠️ THE SEAM IS HERE AND NOWHERE ELSE, AND THAT IS THE WHOLE DESIGN. Four kinds
 *   of invoice want four different item tables — a consultation has a fee, a
 *   dispense has a batch, an expiry and a pack size, a lab test has a sample type
 *   — and every other part of the document is identical across all of them:
 *   the issuer block, the GSTIN and its country-correct label, the place of
 *   supply, the tax summary grouped by rate and jurisdiction, the totals, and
 *   whether the heading says TAX INVOICE or BILL OF SUPPLY.
 *
 *   Those shared parts are the ones an auditor reads and a return is filed from.
 *   Four whole templates would give them four homes, and the failure is quiet:
 *   somebody corrects the CGST/SGST grouping on the pharmacy document in March,
 *   nobody touches the lab one, and for eight months lab invoices file a tax that
 *   does not reconcile while every total on the page still adds up.
 *
 *   So: one shell in `document.tsx`, and a table per source registered below.
 *
 * ⚠️ A REGISTRY, NOT A CHAIN OF `showBatch` / `showQty` FLAGS. Conditional
 *   columns inside one component was the first shape of this and it does not
 *   survive the second module: the flags multiply, every table pays the cost of
 *   every other table's columns, and the widths stop adding up. A new source
 *   adds a file and one line here.
 *
 * ⚠️ THE MONEY CELLS ARE SHARED ON PURPOSE. Discount, taxable, tax and amount
 *   are the audited tail of every line and are identical in all four; they live
 *   in `MoneyCells` so a rounding or labelling fix lands once. What a table owns
 *   is the columns that DESCRIBE the thing — everything left of the money.
 */

import type { JSX } from 'react';

import type { InvoiceFormatter } from './format.js';
import type {
  InvoiceDocumentData,
  InvoiceDocumentLine,
  InvoiceDocumentSourceType,
} from './types.js';

export interface ItemTableProps {
  data: InvoiceDocumentData;
  fmt: InvoiceFormatter;
}

export type ItemTable = (props: ItemTableProps) => JSX.Element;

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

/**
 * The description, with this line's own tax breakdown beneath it.
 *
 * In Karnataka a 12% line is CGST 6% + SGST 6% — two facts that do not fit one
 * cell and that a reader needs beside the item rather than only in the summary.
 */
function DescriptionCell({
  line,
  fmt,
  className,
}: {
  line: InvoiceDocumentLine;
  fmt: InvoiceFormatter;
  className: string;
}): JSX.Element {
  return (
    <td className={className}>
      <div className="item-desc">{line.description}</div>
      {line.taxes.length === 0 ? null : (
        <div className="item-taxes">
          {line.taxes.map((tax) => `${tax.name} ${fmt.rate(tax.rateBps)}`).join('  ·  ')}
        </div>
      )}
    </td>
  );
}

/**
 * The audited tail: discount, taxable, tax, amount. Identical on every source.
 *
 * ⚠️ THE LINE'S OWN DISCOUNT AND ITS SHARE OF THE WHOLE-BILL ONE ARE ONE PRINTED
 *   FIGURE. They are two columns in the database because they are two different
 *   instructions — the second is apportioned across lines before tax — but a
 *   patient reading the row wants to know what came off this line, and a second
 *   discount column would invite the question of whether they add up.
 */
function MoneyCells({
  line,
  fmt,
}: {
  line: InvoiceDocumentLine;
  fmt: InvoiceFormatter;
}): JSX.Element {
  const discount = line.discountAmountMinor + line.apportionedDiscountMinor;

  return (
    <>
      <td className="col-disc num">{fmt.deduction(discount)}</td>
      <td className="col-taxable num">{fmt.amount(line.taxableAmountMinor)}</td>
      <td className="col-tax num">
        {line.taxAmountMinor === 0 ? '—' : fmt.amount(line.taxAmountMinor)}
      </td>
      <td className="col-amount num strong">{fmt.amount(line.lineTotalMinor)}</td>
    </>
  );
}

/** The four money headers, in the order `MoneyCells` prints them. */
function MoneyHeaders(): JSX.Element {
  return (
    <>
      <th className="col-disc num">Discount</th>
      <th className="col-taxable num">Taxable</th>
      <th className="col-tax num">Tax</th>
      <th className="col-amount num">Amount</th>
    </>
  );
}

/**
 * `<thead>` rather than a styled first row: Chromium repeats a real table header
 * on every printed page. A three-page pharmacy bill whose columns are only
 * labelled on page one is unreadable, and this is one tag rather than a
 * pagination routine of our own.
 */
function ItemsTable({ head, rows }: { head: JSX.Element; rows: JSX.Element[] }): JSX.Element {
  return (
    <table className="items">
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// A consultation
// ---------------------------------------------------------------------------

/**
 * What a doctor charged, and nothing a doctor does not have.
 *
 * ⚠️ NO QUANTITY AND NO HSN/SAC COLUMN. A consultation is one of one, so a
 *   column reading `1.000` on every row is noise on the one document a patient
 *   actually reads; and nothing on this path classifies a service yet, so an
 *   HSN/SAC column would print a row of dashes and look like a form somebody
 *   failed to fill in. Both come back the moment there is something to put in
 *   them — a clinic classifying its services adds the column here, not a flag.
 *
 * The money column is **Fee**, because that is what a consultation is charged.
 * `Rate` belongs over a unit price.
 */
function AppointmentItems({ data, fmt }: ItemTableProps): JSX.Element {
  return (
    <ItemsTable
      head={
        <>
          <th className="col-n">#</th>
          {/* Absorbs the width the two dropped columns would have taken. */}
          <th className="col-desc-wide">Description</th>
          <th className="col-rate num">Fee</th>
          <MoneyHeaders />
        </>
      }
      rows={data.lines.map((line) => (
        <tr key={line.lineNumber}>
          <td className="col-n muted">{line.lineNumber}</td>
          <DescriptionCell line={line} fmt={fmt} className="col-desc-wide" />
          <td className="col-rate num">{fmt.amount(line.unitPriceMinor)}</td>
          <MoneyCells line={line} fmt={fmt} />
        </tr>
      ))}
    />
  );
}

// ---------------------------------------------------------------------------
// Everything else, for now
// ---------------------------------------------------------------------------

/**
 * The generic table: quantity and a printed classification code.
 *
 * Used by every source that has not yet earned its own. ⚠️ It is a starting
 * point and not the destination for pharmacy or lab:
 *
 *   - **Pharmacy** needs batch and expiry per line. Those are part of the sale
 *     record for prescription medicines and are what a recall or a return is
 *     traced through — not a formatting preference. `invoice_items` has no
 *     column for either yet, so that is a schema change as well as a table here.
 *   - **Lab** wants the test code and the sample type.
 *
 * Add `PharmacyItems` / `LabItems` beside this one and register them below; do
 * not grow this table with columns only one source uses.
 */
function DefaultItems({ data, fmt }: ItemTableProps): JSX.Element {
  return (
    <ItemsTable
      head={
        <>
          <th className="col-n">#</th>
          <th className="col-desc">Description</th>
          <th className="col-code">HSN/SAC</th>
          <th className="col-qty num">Qty</th>
          <th className="col-rate num">Rate</th>
          <MoneyHeaders />
        </>
      }
      rows={data.lines.map((line) => (
        <tr key={line.lineNumber}>
          <td className="col-n muted">{line.lineNumber}</td>
          <DescriptionCell line={line} fmt={fmt} className="col-desc" />
          <td className="col-code mono muted">{line.itemCode ?? '—'}</td>
          <td className="col-qty num">{fmt.quantity(line.quantity)}</td>
          <td className="col-rate num">{fmt.amount(line.unitPriceMinor)}</td>
          <MoneyCells line={line} fmt={fmt} />
        </tr>
      ))}
    />
  );
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Which table renders which kind of invoice.
 *
 * ⚠️ EXHAUSTIVE OVER `InvoiceDocumentSourceType` ON PURPOSE — the `Record` makes
 *   a new source a compile error here rather than a silent fall-through to the
 *   generic table. Pointing a new source at `DefaultItems` is a fine answer; not
 *   noticing it needed one is not.
 */
export const ITEM_TABLES: Record<InvoiceDocumentSourceType, ItemTable> = {
  APPOINTMENT: AppointmentItems,
  PROCEDURE: DefaultItems,
  SERVICE: DefaultItems,
  LAB: DefaultItems,
  PHARMACY: DefaultItems,
  INVENTORY: DefaultItems,
  OTHER: DefaultItems,
};

export function itemTableFor(sourceType: InvoiceDocumentSourceType): ItemTable {
  /*
   * The `??` is unreachable through the type system and is here for a document
   * that arrives from an older API carrying a source this build does not know.
   * A generic table is a worse invoice; a crashed render is no invoice at all.
   */
  return ITEM_TABLES[sourceType] ?? DefaultItems;
}
