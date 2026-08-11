/**
 * `@rcln/documents` — how a document is rendered.
 *
 * ⚠️ THIS ENTRY POINT IS PURE, AND KEEPING IT THAT WAY IS THE REASON THE PACKAGE
 *   HAS TWO OF THEM. `apps/web` imports this one to draw the preview; the API
 *   and the worker import `@rcln/documents/store` as well, which reaches for
 *   Prisma and the filesystem. Nothing here may import from `./store` — one
 *   `import type` that dragged the client into the web build would be a Prisma
 *   engine in a Next.js bundle, and the symptom is a build error a long way from
 *   the line that caused it.
 *
 * WHY TEMPLATES AND STORAGE ARE ONE PACKAGE AT ALL
 *   They are the two halves of the same subsystem — produce a document, keep a
 *   document — and they have the same two consumers. `@rcln/payments` already
 *   ships this exact shape, splitting `/money` out of a root that pulls in
 *   `node:crypto` and two gateway adapters, and for the same reason: an export
 *   map is a cheaper boundary than a package that exists only to be a boundary.
 */

export {
  renderInvoiceHtml,
  documentTitle,
  INVOICE_TEMPLATE_KEY,
  INVOICE_TEMPLATE_VERSION,
  type RenderInvoiceOptions,
} from './invoice/index.js';

export type {
  InvoiceDocumentData,
  InvoiceDocumentCustomer,
  InvoiceDocumentIssuer,
  InvoiceDocumentLine,
  InvoiceDocumentStatus,
  InvoiceDocumentTaxLine,
  InvoiceDocumentTaxSummaryRow,
  InvoiceDocumentTotals,
  InvoiceTaxTreatment,
} from './invoice/types.js';

export { unsupportedCodepoints } from './fonts.js';

/** Sample documents, for previews and design work. See `invoice/samples.ts`. */
export { indianInvoice, unregisteredInvoice, yenInvoice, longInvoice } from './invoice/samples.js';
