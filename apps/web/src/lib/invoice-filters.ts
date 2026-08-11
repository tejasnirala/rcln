import type { InvoiceSourceTypeValue, InvoiceStatusValue } from '@rcln/contracts';

/**
 * What the invoice ledger can be narrowed by, and what those values are called
 * on screen.
 *
 * ⚠️ NOT A `'use server'` MODULE, AND IT CANNOT BE. Both the page (a Server
 *   Component, which reads the URL) and the list (a Client Component, which
 *   writes it) need the same key list and the same labels; every export from a
 *   `'use server'` file must be an async function, so a shared constant has to
 *   live outside one. The same reason `EMPTY_LOOKUP` is not exported from the
 *   appointments actions.
 *
 * ⚠️ AND THERE IS NO `q` IN THIS LIST. The obvious missing filter is the
 *   customer's name, and its absence is the design: a name in a query string is
 *   a name in `data_access_logs.route`, in the proxy's access log, in browser
 *   history and in the next request's referrer. `listInvoicesQuery` refuses one
 *   at the API for the same reason. An invoice is found by its number, its
 *   patient, its branch, its status or its date.
 */
export const INVOICE_FILTER_KEYS = [
  'status',
  'sourceType',
  'branchId',
  'patientId',
  'invoiceNumber',
  'from',
  'to',
  'page',
] as const;

export type InvoiceFilterKey = (typeof INVOICE_FILTER_KEYS)[number];
export type InvoiceFilters = Partial<Record<InvoiceFilterKey, string>>;

/**
 * A status, in the words a cashier uses.
 *
 * ⚠️ A SENTENCE-CASE WORD AND NOT THE ENUM. `PARTIALLY_PAID` on screen is a
 *   database column leaking into an interface; "Part paid" is what the person
 *   reconciling the till would say. The value still travels as the enum in the
 *   URL and on the wire — this is display only.
 */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  DRAFT: 'Draft',
  // The window between the number being taken and the document committing. It
  // is measured in milliseconds and a screen should almost never show it, but a
  // blank cell on the one occasion it does would be worse than a word.
  FINALIZING: 'Issuing',
  ISSUED: 'Issued',
  PARTIALLY_PAID: 'Part paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  VOID: 'Voided',
};

/**
 * What the invoice bills for. The three modules that do not exist yet are here
 * too, because the column and the source registry already carry them — a clinic
 * can filter for Lab today and correctly get nothing back.
 */
export const INVOICE_SOURCE_LABELS: Record<InvoiceSourceTypeValue, string> = {
  APPOINTMENT: 'Consultation',
  PROCEDURE: 'Procedure',
  SERVICE: 'Service',
  LAB: 'Lab',
  PHARMACY: 'Pharmacy',
  INVENTORY: 'Supplies',
  OTHER: 'Other',
};

/**
 * How a status is drawn.
 *
 * ⚠️ COLOUR IS NEVER THE ONLY CARRIER (WCAG 1.4.1), WHICH IS WHY EVERY ONE OF
 *   THESE IS RENDERED WITH ITS WORD. The tint distinguishes a settled invoice
 *   from a reversed one at a glance; the word is what makes the distinction
 *   exist for somebody who cannot see the tint. `signal` is spent only on the
 *   states that are live and unfinished, because the palette reserves it for
 *   exactly that.
 */
export const INVOICE_STATUS_TONE: Record<InvoiceStatusValue, string> = {
  DRAFT: 'border-rule bg-paper text-muted',
  FINALIZING: 'border-signal/30 bg-signal-tint text-signal',
  ISSUED: 'border-drape/30 bg-drape-tint text-drape',
  PARTIALLY_PAID: 'border-signal/30 bg-signal-tint text-signal',
  PAID: 'border-drape/30 bg-drape-tint text-drape',
  CANCELLED: 'border-rule bg-paper text-muted',
  VOID: 'border-rule bg-paper text-muted line-through',
};
