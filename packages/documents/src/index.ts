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

/**
 * The chrome every document type shares — a running header naming the clinic, a
 * running footer, and "Page 1 of 5". A new template renders these two and
 * includes the two stylesheet fragments; it does not restate the geometry.
 */
export {
  PageHeader,
  PageFooter,
  ChromeTemplates,
  /** The two ids `apps/worker`'s renderer looks for. Changing one changes both. */
  HEADER_TEMPLATE_ID,
  FOOTER_TEMPLATE_ID,
  PAGE,
  HEADER_BAND,
  FOOTER_BAND,
  pageRule,
  chromeStylesheet,
  type DocumentChrome,
  type DocumentChromeIssuer,
  type DocumentChromeMetaRow,
} from './chrome/index.js';

export { unsupportedCodepoints } from './fonts.js';

/** Sample documents, for previews and design work. See `invoice/samples.ts`. */
export {
  indianInvoice,
  unregisteredInvoice,
  yenInvoice,
  longInvoice,
  longAddressInvoice,
  pharmacyInvoice,
} from './invoice/samples.js';
