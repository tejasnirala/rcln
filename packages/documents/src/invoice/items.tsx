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

import { CONTENT_WIDTH_MM } from '../chrome/index.js';

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
 * The description.
 *
 * ⚠️ THE PER-LINE TAX BREAKDOWN USED TO LIVE HERE, UNDER THE DESCRIPTION, AND IT
 *   IS NOW A COLUMN PER TAX. "CGST 6% · SGST 6%" beneath the item name told a
 *   reader the RATES but never the amounts, so the only way to see what the tax
 *   on a line actually was, component by component, was to do the arithmetic.
 *   `taxColumnsFor` builds one column per component instead, carrying both.
 */
function DescriptionCell({
  line,
  className,
}: {
  line: InvoiceDocumentLine;
  className: string;
}): JSX.Element {
  return (
    <td className={className}>
      <div className="item-desc">{line.description}</div>
      {line.packaging === null || line.packaging === undefined ? null : (
        <div className="item-pack">{line.packaging}</div>
      )}
    </td>
  );
}

/**
 * Which tax components this document charges, in the order they first appear.
 *
 * ⚠️ DERIVED FROM THE DATA, NEVER A LIST OF NAMES THIS FILE KNOWS. An intra-state
 *   Indian supply is CGST + SGST, an inter-state one is IGST alone, and a VAT
 *   country is one column called something else entirely — hard-coding "CGST"
 *   and "SGST" here would print two empty columns on every invoice outside one
 *   tax regime, and would be the first country name in a package that has none.
 *
 * ⚠️ ORDER OF FIRST APPEARANCE, NOT ALPHABETICAL. CGST before SGST is the order
 *   the law names them in and the order every Indian invoice prints them in;
 *   sorting would silently reverse it.
 */
export function taxColumnsFor(data: InvoiceDocumentData): string[] {
  const names: string[] = [];
  for (const line of data.lines) {
    for (const tax of line.taxes) {
      if (!names.includes(tax.name)) names.push(tax.name);
    }
  }
  return names;
}

/**
 * One cell per tax component: the amount, with the rate that produced it.
 *
 * ⚠️ A LINE THAT DOES NOT CARRY ONE OF THE DOCUMENT'S COMPONENTS PRINTS AN EM
 *   DASH, NOT A ZERO. An exempt item on a bill that also has taxable ones is
 *   charged NO CGST — which is a different statement from "CGST of 0.00", and on
 *   a document somebody files a return from the difference matters.
 */
function TaxCells({
  line,
  fmt,
  columns,
}: {
  line: InvoiceDocumentLine;
  fmt: InvoiceFormatter;
  columns: readonly string[];
}): JSX.Element {
  return (
    <>
      {columns.map((name) => {
        const tax = line.taxes.find((entry) => entry.name === name);
        return (
          <td key={name} className="col-taxcomp num">
            {tax === undefined ? (
              '—'
            ) : (
              <>
                {fmt.amount(tax.taxAmountMinor)}
                <span className="item-tax-rate">{fmt.rate(tax.rateBps)}</span>
              </>
            )}
          </td>
        );
      })}
    </>
  );
}

/**
 * The audited tail: discount, taxable, the tax components, amount.
 *
 * ⚠️ THE LINE'S OWN DISCOUNT AND ITS SHARE OF THE WHOLE-BILL ONE ARE ONE PRINTED
 *   FIGURE. They are two columns in the database because they are two different
 *   instructions — the second is apportioned across lines before tax — but a
 *   patient reading the row wants to know what came off this line, and a second
 *   discount column would invite the question of whether they add up.
 *
 * ⚠️ THERE IS NO SINGLE "Tax" COLUMN ANY MORE, AND ITS REMOVAL IS DELIBERATE
 *   RATHER THAN AN OVERSIGHT. It held the sum of the components now printed
 *   beside it, so keeping both would put the same money on the page twice and
 *   invite a reader to add the components and check them against it — an
 *   arithmetic identity that is only ever interesting when it fails. `Taxable`
 *   plus the components plus `Amount` is the whole story of the line.
 */
function MoneyCells({
  line,
  fmt,
  taxColumns,
}: {
  line: InvoiceDocumentLine;
  fmt: InvoiceFormatter;
  taxColumns: readonly string[];
}): JSX.Element {
  const discount = line.discountAmountMinor + line.apportionedDiscountMinor;

  return (
    <>
      <td className="col-disc num">{fmt.deduction(discount)}</td>
      <td className="col-taxable num">{fmt.amount(line.taxableAmountMinor)}</td>
      <TaxCells line={line} fmt={fmt} columns={taxColumns} />
      <td className="col-amount num strong">{fmt.amount(line.lineTotalMinor)}</td>
    </>
  );
}

/** The money headers, in the order `MoneyCells` prints them. */
function MoneyHeaders({ taxColumns }: { taxColumns: readonly string[] }): JSX.Element {
  return (
    <>
      <th className="col-disc num">Discount</th>
      <th className="col-taxable num">Taxable</th>
      {taxColumns.map((name) => (
        <th key={name} className="col-taxcomp num">
          {name}
        </th>
      ))}
      <th className="col-amount num">Amount</th>
    </>
  );
}

/**
 * The column widths, in millimetres, as a `<colgroup>`.
 *
 * ⚠️ COMPUTED RATHER THAN DECLARED IN CSS, BECAUSE THE COLUMN COUNT IS NOW DATA.
 *   A document may carry one tax component, two, or none, and the widths have to
 *   still add up to the content width — `table-layout: fixed` with widths that
 *   do not sum is how a table starts overflowing the page margin. The
 *   description column absorbs the difference, which is what it is for.
 *
 * ⚠️ THE STYLESHEET CANNOT DO THIS. It has no way to know how many components a
 *   given invoice charges, and a per-count rule set (`[data-taxcols="2"] …`)
 *   would be three copies of the same arithmetic maintained by hand.
 */
function ColGroup({
  fixed,
  taxColumns,
}: {
  /** Every column except the description, which flexes. */
  fixed: readonly number[];
  taxColumns: readonly string[];
}): JSX.Element {
  const taxWidth = TAX_WIDTH_MM;
  /*
   * ⚠️ THE AMOUNT COLUMN COUNTS TOWARDS THE BUDGET, AND LEAVING IT OUT PUT THE
   *   TABLE 24mm OVER THE CONTENT WIDTH — off the right margin. It is emitted
   *   separately at the end rather than being part of `fixed`, which is exactly
   *   what made it easy to forget here. A test sums the rendered colgroup.
   */
  const used =
    fixed.reduce((sum, mm) => sum + mm, 0) + taxWidth * taxColumns.length + AMOUNT_WIDTH_MM;
  /*
   * A floor, so a pathological number of components narrows the description
   * rather than making it negative and collapsing the table.
   */
  const description = Math.max(CONTENT_WIDTH_MM - used, 24);

  return (
    <colgroup>
      <col style={{ width: `${String(fixed[0] ?? 6)}mm` }} />
      <col style={{ width: `${String(description)}mm` }} />
      {/*
       * Keyed by position, which is correct here and almost nowhere else: these
       * are column WIDTHS, not entities, and there is no reconciliation at all
       * under `renderToStaticMarkup`.
       */}
      {fixed.slice(1).map((mm, index) => (
        <col key={`fixed-${String(index)}-${String(mm)}`} style={{ width: `${String(mm)}mm` }} />
      ))}
      {taxColumns.map((name) => (
        <col key={name} style={{ width: `${String(taxWidth)}mm` }} />
      ))}
      <col style={{ width: `${String(AMOUNT_WIDTH_MM)}mm` }} />
    </colgroup>
  );
}

/**
 * The widths that are NOT the description, in millimetres.
 *
 * ⚠️ THESE ARE THE INK WIDTHS PLUS THE CELL PADDING, WHICH IS 2.6mm A SIDE. A
 *   column sized to just fit its widest figure looks congested, because this
 *   table has no vertical rules and no striping — the padding IS the separator.
 *   Widening them is paid for by the description, which now carries the pack
 *   size on its own second line and needs less.
 */
const AMOUNT_WIDTH_MM = 24;

/*
 * ⚠️ THE HSN/SAC COLUMN IS 19mm AND WAS 14mm, WHICH IS THE ONE WIDTH HERE THAT
 *   WAS SIMPLY TOO SMALL FOR ITS CONTENT. An Indian HSN code is eight digits set
 *   in MONO — wider per character than the body face — so it needs about 13.5mm
 *   of ink plus 5.2mm of padding. In 14mm it filled the cell edge to edge and
 *   read as though it were touching the Qty column beside it. The millimetres
 *   come from the two tax columns, which had more room than their figures need.
 */
const TAX_WIDTH_MM = 17;

/**
 * `<thead>` rather than a styled first row: Chromium repeats a real table header
 * on every printed page. A three-page pharmacy bill whose columns are only
 * labelled on page one is unreadable, and this is one tag rather than a
 * pagination routine of our own.
 */
function ItemsTable({
  head,
  rows,
  colgroup,
}: {
  head: JSX.Element;
  rows: JSX.Element[];
  colgroup: JSX.Element;
}): JSX.Element {
  return (
    <table className="items">
      {colgroup}
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
  const taxColumns = taxColumnsFor(data);

  return (
    <ItemsTable
      colgroup={<ColGroup fixed={[6, 20, 17, 21]} taxColumns={taxColumns} />}
      head={
        <>
          <th className="col-n">#</th>
          {/* Absorbs the width the two dropped columns would have taken. */}
          <th className="col-desc-wide">Description</th>
          <th className="col-rate num">Fee</th>
          <MoneyHeaders taxColumns={taxColumns} />
        </>
      }
      rows={data.lines.map((line) => (
        <tr key={line.lineNumber}>
          <td className="col-n muted">{line.lineNumber}</td>
          <DescriptionCell line={line} className="col-desc-wide" />
          <td className="col-rate num">{fmt.amount(line.unitPriceMinor)}</td>
          <MoneyCells line={line} fmt={fmt} taxColumns={taxColumns} />
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
  const taxColumns = taxColumnsFor(data);

  return (
    <ItemsTable
      colgroup={<ColGroup fixed={[6, 19, 12, 17, 15, 19]} taxColumns={taxColumns} />}
      head={
        <>
          <th className="col-n">#</th>
          <th className="col-desc">Description</th>
          <th className="col-code">HSN/SAC</th>
          <th className="col-qty num">Qty</th>
          <th className="col-rate num">Rate</th>
          <MoneyHeaders taxColumns={taxColumns} />
        </>
      }
      rows={data.lines.map((line) => (
        <tr key={line.lineNumber}>
          <td className="col-n muted">{line.lineNumber}</td>
          <DescriptionCell line={line} className="col-desc" />
          <td className="col-code mono muted">{line.itemCode ?? '—'}</td>
          <td className="col-qty num">{fmt.quantity(line.quantity)}</td>
          <td className="col-rate num">{fmt.amount(line.unitPriceMinor)}</td>
          <MoneyCells line={line} fmt={fmt} taxColumns={taxColumns} />
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
