/**
 * An invoice row → the value the template renders.
 *
 * ⚠️ THIS IS THE ONLY PLACE AN INVOICE BECOMES A DOCUMENT, AND A SECOND ONE
 *   WOULD UNDO THE PHASE. The preview in `apps/web` and the PDF in the worker
 *   are the same document because they render the same `InvoiceDocumentData`;
 *   what makes that true is that both get it from HERE — the worker calls this
 *   function, and Phase 7's `GET /invoices/:id/document` returns exactly what it
 *   returns. A screen that assembled its own object from the same columns would
 *   look identical on the day it was written and drift on the first column that
 *   changed meaning.
 *
 * ⚠️ IT PREFERS THE SNAPSHOT AND FALLS BACK TO THE LIVE ROW, IN THAT ORDER, AND
 *   THE ORDER IS THE WHOLE POINT. `invoices.issuer_legal_name`,
 *   `.issuer_tax_id`, `.customer_name` and the rest were written at
 *   finalisation precisely so that a clinic re-registering under a new name, or
 *   a patient marrying, does not silently restate a document somebody is
 *   holding a copy of. The live row is consulted only where there is no
 *   snapshot column to consult.
 *
 *   ⚠️ THREE VALUES ARE STILL READ LIVE, AND EACH IS A DELIBERATE, NAMED
 *     EXCEPTION: the branch's address and phone, the organization's legal name
 *     when the invoice charged no tax and so recorded no issuer, and the
 *     patient's UHID. An address correction SHOULD reach a reprint — that is a
 *     typo being fixed, not a fact changing — and a UHID is issued once and
 *     never reissued. A clinic that MOVES is the case this gets wrong, and the
 *     fix when it matters is a snapshot column, not a rule in a reviewer's head.
 */

import { taxIdFormatFor } from '@rcln/contracts';
import type { Prisma, TenantContext, TxClient } from '@rcln/db';
/*
 * `@rcln/payments/money`, not the package root — the root drags two gateway
 * adapters and `node:crypto` along for a currency scale. `fromMajor` is asked
 * for the scale rather than two decimal places being assumed, which is what
 * makes ¥5,500 come out as 5500 minor units instead of 550000.
 */
import { fromMajor } from '@rcln/payments/money';

import type {
  InvoiceDocumentData,
  InvoiceDocumentLine,
  InvoiceDocumentTaxSummaryRow,
  InvoiceDocumentStatus,
  InvoiceTaxTreatment,
} from '../invoice/types.js';
import { DocumentError } from '../store/document.service.js';

/**
 * Build the document for one invoice.
 *
 * Works for a DRAFT as well as an issued invoice — the preview screen needs it
 * before the number exists, which is why `invoiceNumber` and `issuedAt` are
 * nullable on the way out. Under RLS another tenant's id is indistinguishable
 * from one that does not exist, and both answers are 404.
 */
export async function loadInvoiceDocumentData(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<InvoiceDocumentData> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId, deletedAt: null },
    select: {
      id: true,
      branchId: true,
      invoiceNumber: true,
      status: true,
      issuedAt: true,
      suppliedAt: true,
      dueDate: true,
      currency: true,
      notes: true,
      placeOfSupply: true,
      taxTreatment: true,
      issuerTaxId: true,
      issuerLegalName: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      customerAddress: true,
      customerTaxId: true,
      sourceType: true,
      practitionerName: true,
      practitionerRegistrationNumber: true,
      subtotal: true,
      lineDiscountTotal: true,
      invoiceDiscountTotal: true,
      taxableAmount: true,
      taxTotal: true,
      roundingAdjustment: true,
      grandTotal: true,
      amountPaid: true,
      patient: { select: { uhid: true } },
      branch: {
        select: {
          name: true,
          code: true,
          timezone: true,
          countryCode: true,
          phone: true,
          email: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          pincode: true,
        },
      },
      organization: { select: { legalName: true, displayName: true } },
      items: {
        orderBy: { lineNumber: 'asc' },
        select: {
          lineNumber: true,
          description: true,
          itemCode: true,
          quantity: true,
          unitPrice: true,
          grossAmount: true,
          discountAmount: true,
          apportionedDiscount: true,
          taxableAmount: true,
          taxAmount: true,
          lineTotal: true,
          taxes: {
            select: { name: true, rateBps: true, taxAmount: true },
          },
        },
      },
      /*
       * Read from the invoice rather than through the items, because
       * `invoice_taxes` carries `invoice_id` denormalised for exactly this: the
       * summary is one indexed read instead of a join through every line.
       */
      taxes: {
        select: {
          name: true,
          jurisdiction: true,
          rateBps: true,
          taxableAmount: true,
          taxAmount: true,
        },
      },
    },
  });

  if (!invoice) throw new DocumentError('NOT_FOUND', 'The invoice could not be found');

  const { branch } = invoice;
  const currency = invoice.currency;
  const minor = (value: Prisma.Decimal): number =>
    fromMajor(value.toString(), currency).amountMinor;

  const addressLines = [
    invoice.branch.addressLine1,
    invoice.branch.addressLine2,
    [branch.city, branch.state, branch.pincode].filter(Boolean).join(' '),
  ].filter((line): line is string => typeof line === 'string' && line.trim() !== '');

  return {
    currency,
    timezone: branch.timezone,
    countryCode: branch.countryCode,

    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status as InvoiceDocumentStatus,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    suppliedAt: invoice.suppliedAt.toISOString(),
    /*
     * `due_date` is a DATE, not a timestamp — Prisma hands it back as midnight
     * UTC. Rendering it in the branch's zone would move it to the previous day
     * anywhere west of Greenwich, so it is sent as the date it is and the
     * formatter is given a value whose time component means nothing.
     */
    dueDate: invoice.dueDate?.toISOString() ?? null,
    placeOfSupply: invoice.placeOfSupply,
    taxTreatment: invoice.taxTreatment as InvoiceTaxTreatment,
    // Only so the template can name its own money column — see the type.
    sourceType: invoice.sourceType as InvoiceDocumentData['sourceType'],
    notes: invoice.notes,

    issuer: {
      /*
       * The registration's legal name if the invoice charged under one. A
       * clinic that holds no registration recorded none, and the organization's
       * own legal name is then the honest answer rather than a blank masthead.
       */
      legalName: invoice.issuerLegalName ?? invoice.organization.legalName,
      tradeName:
        invoice.organization.displayName === invoice.organization.legalName
          ? null
          : invoice.organization.displayName,
      branchName: branch.name,
      branchCode: branch.code,
      addressLines,
      phone: branch.phone,
      email: branch.email,
      taxId: invoice.issuerTaxId,
      /*
       * What the country calls that number, from the same catalogue the clinic
       * settings screen labels its field with. Hard-coding "GSTIN" over an Irish
       * clinic's VAT number is the exact mistake Phase 2b removed from
       * `clinic-settings.tsx`; putting it back on the printed document would be
       * the same error somewhere harder to notice.
       */
      taxIdLabel: taxIdFormatFor(branch.countryCode)?.label ?? 'Tax ID',
    },

    customer: {
      name: invoice.customerName,
      phone: invoice.customerPhone,
      email: invoice.customerEmail,
      address: invoice.customerAddress,
      taxId: invoice.customerTaxId,
      patientNumber: invoice.patient?.uhid ?? null,
    },

    /*
     * Read straight off the invoice, never through `appointment_id`. The whole
     * reason these are columns is that the document must keep naming whoever it
     * named — a doctor who has since left, changed their name or re-registered
     * does not restate a bill already handed to a patient.
     */
    practitioner:
      invoice.practitionerName === null
        ? null
        : {
            name: invoice.practitionerName,
            registrationNumber: invoice.practitionerRegistrationNumber,
          },

    lines: invoice.items.map((item): InvoiceDocumentLine => ({
      lineNumber: item.lineNumber,
      description: item.description,
      itemCode: item.itemCode,
      quantity: item.quantity.toString(),
      unitPriceMinor: minor(item.unitPrice),
      grossAmountMinor: minor(item.grossAmount),
      discountAmountMinor: minor(item.discountAmount),
      apportionedDiscountMinor: minor(item.apportionedDiscount),
      taxableAmountMinor: minor(item.taxableAmount),
      taxAmountMinor: minor(item.taxAmount),
      lineTotalMinor: minor(item.lineTotal),
      taxes: item.taxes.map((tax) => ({
        name: tax.name,
        rateBps: tax.rateBps,
        taxAmountMinor: minor(tax.taxAmount),
      })),
    })),

    taxSummary: summariseTaxes(invoice.taxes, minor),

    totals: {
      subtotalMinor: minor(invoice.subtotal),
      lineDiscountTotalMinor: minor(invoice.lineDiscountTotal),
      invoiceDiscountTotalMinor: minor(invoice.invoiceDiscountTotal),
      taxableAmountMinor: minor(invoice.taxableAmount),
      taxTotalMinor: minor(invoice.taxTotal),
      roundingAdjustmentMinor: minor(invoice.roundingAdjustment),
      grandTotalMinor: minor(invoice.grandTotal),
      amountPaidMinor: minor(invoice.amountPaid),
      /*
       * Derived, and it is the ONE figure on the document that is. It has no
       * column — `amount_paid` and `grand_total` are what the database holds —
       * so deriving it here is reading the row, not forming a second opinion
       * about it. Everything else the template prints comes straight off a
       * column, because a template that recomputes is a second implementation of
       * `@rcln/invoicing` that disagrees by a paisa in exactly the cases that
       * matter.
       */
      balanceDueMinor: minor(invoice.grandTotal) - minor(invoice.amountPaid),
    },
  };
}

/**
 * The tax table at the foot: one row per printed component and rate.
 *
 * ⚠️ GROUPED BY NAME **AND** JURISDICTION **AND** RATE, AND DROPPING ANY OF THE
 *   THREE PRINTS A TAX NOBODY LEVIES. CGST 6% and SGST 6% are the same rate on
 *   the same base owed to two different governments; merging them into one 12%
 *   row would state a tax that does not exist and would break the return the
 *   clinic files from this table. Two lines taxed at 6% and 9% under the same
 *   component are two rows for the same reason.
 */
function summariseTaxes(
  taxes: readonly {
    name: string;
    rateBps: number;
    jurisdiction: string | null;
    taxableAmount: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
  }[],
  minor: (value: Prisma.Decimal) => number
): InvoiceDocumentTaxSummaryRow[] {
  const rows = new Map<string, InvoiceDocumentTaxSummaryRow>();

  for (const tax of taxes) {
    const key = `${tax.name}|${tax.jurisdiction}|${String(tax.rateBps)}`;
    const existing = rows.get(key);
    if (existing) {
      existing.taxableAmountMinor += minor(tax.taxableAmount);
      existing.taxAmountMinor += minor(tax.taxAmount);
      continue;
    }
    rows.set(key, {
      name: tax.name,
      jurisdiction: tax.jurisdiction,
      rateBps: tax.rateBps,
      taxableAmountMinor: minor(tax.taxableAmount),
      taxAmountMinor: minor(tax.taxAmount),
    });
  }

  /*
   * Sorted so a reprint is byte-identical to the original. Postgres does not
   * promise a row order without an ORDER BY, and a document whose tax table
   * came out in a different order on the second print is a document a patient
   * can reasonably say is not the one they were given.
   */
  return [...rows.values()].sort(
    (a, b) =>
      a.rateBps - b.rateBps ||
      a.name.localeCompare(b.name) ||
      (a.jurisdiction ?? '').localeCompare(b.jurisdiction ?? '')
  );
}
