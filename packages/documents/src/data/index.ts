/**
 * `@rcln/documents/data` — a database row assembled into a document.
 *
 * ⚠️ A THIRD ENTRY POINT, AND THE SPLIT IS NOT ARBITRARY. Each of the three
 *   answers a different question and has a different dependency footprint:
 *
 *     `@rcln/documents`        how a document LOOKS.  Pure. Safe in a browser.
 *     `@rcln/documents/store`  how a document is KEPT. Prisma + storage, and
 *                              deliberately knows nothing about invoices (§31).
 *     `@rcln/documents/data`   what a document SAYS.  Prisma, and it is entirely
 *                              about invoices.
 *
 *   The last two both need a database client and could have shared an entry
 *   point, and that would have quietly repealed the rule in the middle one —
 *   `DocumentService` must stay generic because lab reports, prescriptions and
 *   consent forms all land in it, and a sibling module named `invoice` inside
 *   the same barrel is how "generic" stops being true.
 */

export { loadInvoiceDocumentData } from './invoice-document.data.js';
