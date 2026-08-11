/**
 * Render an issued invoice and record the document.
 *
 * ⚠️ THE JOB CARRIES IDS AND READS EVERYTHING ELSE ITSELF, UNDER RLS. The
 *   payload is JSON in Redis, echoed into the log line of every failure and kept
 *   in the dead-letter queue for seven days — so a customer name in it would be
 *   a customer name in all three. The worker builds the document data with the
 *   same `loadInvoiceDocumentData` the API uses, inside `withTenant`, and gets
 *   exactly the tenant isolation a request would have got.
 *
 * ⚠️ AND IT MUST BE IDEMPOTENT, BECAUSE BULLMQ RETRIES. Five attempts with
 *   exponential backoff is the queue default. A job that had already stored its
 *   bytes and then failed while writing the row would, on retry, store them
 *   again under a new key and leave the first set orphaned — so the FIRST thing
 *   this does is ask whether a current document already exists, and the storage
 *   key carries the attempt number so a retry can never collide with the write
 *   it is retrying.
 *
 * THE ORDER, AND WHAT EACH FAILURE LEAVES BEHIND
 *
 *     already has a current document → return. Nothing rendered, nothing stored.
 *     render throws                  → nothing written anywhere. BullMQ retries.
 *     storeDocument throws           → a FAILED `files` row with a reason, no
 *                                      `invoice_documents` row. Retryable, and
 *                                      the failure is visible on screen.
 *     the row write throws           → a READY `files` row nothing points at.
 *                                      Costs bytes, discloses nothing, and the
 *                                      retry supersedes rather than collides.
 *
 *   None of these leaves an invoice that claims a document it cannot serve,
 *   which is the one outcome that reaches a patient at the front desk.
 */

import { randomUUID } from 'node:crypto';

import { withTenant, type TenantContext } from '@rcln/db';
import {
  renderInvoiceHtml,
  unsupportedCodepoints,
  INVOICE_TEMPLATE_KEY,
  INVOICE_TEMPLATE_VERSION,
} from '@rcln/documents';
import { storeDocument } from '@rcln/documents/store';
import type { InvoicePdfJob } from '@rcln/queue';

import { loadInvoiceDocumentData } from '@rcln/documents/data';
import { renderPdf } from './pdf.renderer.js';

interface JobLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
}

export async function renderInvoicePdf(job: InvoicePdfJob, logger: JobLogger): Promise<void> {
  /*
   * ⚠️ THE CONTEXT IS BUILT FROM THE JOB, WHICH MAKES THE JOB PAYLOAD A TRUST
   *   BOUNDARY. Only the API enqueues onto this queue and only this worker
   *   consumes it, so the ids came from a request that had already passed
   *   tenant resolution — but the reason this is safe is that the ids were
   *   authorised, not that they came from Redis. Nothing here may take an
   *   organization id from anywhere else.
   *
   *   `branchIds` is the ONE branch this invoice belongs to, not every branch
   *   the issuing user can see. The render needs to read exactly one invoice,
   *   so the narrowest scope that can do the job is the right one — and it means
   *   a job carrying a mismatched branch reads nothing rather than reading a
   *   sibling branch's document.
   *
   *   `userId` is the person who issued the invoice. It grants nothing — the RLS
   *   policies key on the organization and the branch — but `withTenant` sets
   *   `app.current_user` from it, which is what the audit triggers read.
   */
  const ctx: TenantContext = {
    organizationId: job.organizationId,
    branchIds: [job.branchId],
    userId: job.requestedBy,
  };

  const prepared = await withTenant(ctx, async (tx) => {
    /*
     * Already done. The ordinary cause is a retry of a job whose row write
     * succeeded and whose acknowledgement did not, and the correct response is
     * to do nothing — an issued invoice's PDF is generated once. A FAILED
     * predecessor is superseded rather than counted, which is what
     * `invoice_documents_current_per_type_key` is partial for.
     */
    const existing = await tx.invoiceDocument.findFirst({
      where: {
        organizationId: job.organizationId,
        invoiceId: job.invoiceId,
        documentType: 'INVOICE_PDF',
        supersededAt: null,
      },
      select: { id: true },
    });
    if (existing) return null;

    const data = await loadInvoiceDocumentData(tx, ctx, job.invoiceId);

    /*
     * ⚠️ A DRAFT HAS NO DOCUMENT. Rendering one would store a PDF of a bill
     *   whose totals are still moving and whose number does not exist — and the
     *   storage key is built from the number. This is reachable: a job enqueued
     *   at issue, a transaction that rolled back afterwards, and a worker that
     *   picks the job up regardless.
     */
    if (data.invoiceNumber === null) {
      logger.warn(
        { invoiceId: job.invoiceId, status: data.status, code: 'INVOICE_PDF_NOT_ISSUED' },
        'skipping the render of an invoice that was never issued'
      );
      return null;
    }

    return data;
  });

  if (prepared === null) return;

  const html = renderInvoiceHtml(prepared);

  /*
   * ⚠️ LOGGED, NEVER REFUSED. The vendored subsets are Latin, so a patient whose
   *   name is written in Devanagari, Tamil or Kannada gets missing-glyph boxes
   *   where their name should be. Refusing to bill them would be a far worse
   *   failure than the one it prevents — but a silent gap is worse than a known
   *   one, and this is the line that turns the first into the second. The fix is
   *   another `@font-face`: CSS falls back natively, and globals.css already
   *   notes that IBM Plex has a metrically matched Devanagari sibling.
   *
   *   ⚠️ THE COUNT AND THE SCRIPT, NEVER THE CHARACTERS. The characters ARE the
   *     patient's name.
   */
  const missing = unsupportedCodepoints(
    [
      prepared.customer.name,
      prepared.issuer.legalName,
      ...prepared.lines.map((l) => l.description),
    ].join(' ')
  );
  if (missing.length > 0) {
    logger.warn(
      {
        invoiceId: job.invoiceId,
        code: 'DOCUMENT_FONT_COVERAGE',
        missingCount: missing.length,
        scripts: [...new Set(missing.map(scriptOf))],
      },
      'the document contains glyphs the embedded fonts do not carry'
    );
  }

  const pdf = await renderPdf(html);

  /*
   * ⚠️ THE KEY CARRIES A RANDOM SUFFIX, AND A COUNTER HERE WOULD BE A BUG. The
   *   problem it solves is real: `files.storage_key` is UNIQUE and
   *   `storeDocument` claims the row BEFORE writing the bytes, so a retry at the
   *   same key comes back ALREADY_EXISTS — pointing at the FAILED row that is
   *   exactly what needed replacing.
   *
   *   The obvious fix is to number the attempts by counting the documents
   *   already recorded for this invoice, and it FAILS ON THE CASE THAT MATTERS
   *   MOST. The crash window this retry exists for is between `storeDocument`
   *   returning and the `invoice_documents` write below committing — and in that
   *   window there is a `files` row and NO `invoice_documents` row, so the count
   *   is unchanged, the retry builds the identical key, and it is refused. The
   *   counter would be correct for every failure except the one it was written
   *   for.
   *
   *   A random suffix cannot collide with a predecessor whether that predecessor
   *   was recorded or not. Nothing needs to guess the key: `files.storage_key`
   *   is where it is written down, and the invoice number still leads it so the
   *   folder stays readable to a human.
   */
  const stored = await storeDocument(ctx, {
    documentType: 'INVOICE_PDF',
    branchId: job.branchId,
    /*
     * Keyed by invoice ID, not by number: an id is stable and opaque, and a
     * number is a string somebody reads. Both are safe here — neither names a
     * patient — but the id is the one that cannot collide across a series reset.
     */
    keyParts: [
      'invoices',
      job.invoiceId,
      `${prepared.invoiceNumber}-${randomUUID().slice(0, 8)}.pdf`,
    ],
    // ⚠️ Never a patient's name — it becomes a filename in someone's downloads.
    fileName: `${prepared.invoiceNumber}.pdf`,
    mimeType: 'application/pdf',
    body: pdf,
  });

  await withTenant(ctx, async (tx) => {
    /*
     * Supersede any FAILED predecessor in the same statement that replaces it.
     * The partial unique index permits many superseded rows and exactly one
     * live one, so this and the create below cannot both be true for a moment
     * that another session could observe — they are one transaction.
     */
    await tx.invoiceDocument.updateMany({
      where: {
        organizationId: job.organizationId,
        invoiceId: job.invoiceId,
        documentType: 'INVOICE_PDF',
        supersededAt: null,
      },
      data: { supersededAt: new Date() },
    });

    await tx.invoiceDocument.create({
      data: {
        organizationId: job.organizationId,
        branchId: job.branchId,
        invoiceId: job.invoiceId,
        fileId: stored.id,
        documentType: 'INVOICE_PDF',
        // Provenance. Nothing reads these back — see the schema comment.
        templateKey: INVOICE_TEMPLATE_KEY,
        templateVersion: INVOICE_TEMPLATE_VERSION,
        generatedBy: job.requestedBy,
      },
    });
  });

  logger.info(
    {
      invoiceId: job.invoiceId,
      fileId: stored.id,
      sizeBytes: stored.sizeBytes,
      templateVersion: INVOICE_TEMPLATE_VERSION,
    },
    'invoice pdf rendered'
  );
}

/**
 * A coarse script name for a codepoint, for the coverage warning above.
 *
 * Coarse on purpose: the log needs to say "Devanagari" so somebody knows which
 * font to add, and must not say which characters were missing, because those
 * characters are a patient's name.
 */
function scriptOf(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  if (point >= 0x0900 && point <= 0x097f) return 'Devanagari';
  if (point >= 0x0980 && point <= 0x09ff) return 'Bengali';
  if (point >= 0x0a00 && point <= 0x0a7f) return 'Gurmukhi';
  if (point >= 0x0a80 && point <= 0x0aff) return 'Gujarati';
  if (point >= 0x0b00 && point <= 0x0b7f) return 'Oriya';
  if (point >= 0x0b80 && point <= 0x0bff) return 'Tamil';
  if (point >= 0x0c00 && point <= 0x0c7f) return 'Telugu';
  if (point >= 0x0c80 && point <= 0x0cff) return 'Kannada';
  if (point >= 0x0d00 && point <= 0x0d7f) return 'Malayalam';
  if (point >= 0x0600 && point <= 0x06ff) return 'Arabic';
  if (point >= 0x4e00 && point <= 0x9fff) return 'Han';
  return 'other';
}
