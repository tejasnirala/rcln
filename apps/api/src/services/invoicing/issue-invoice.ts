/**
 * Issue an invoice, and ask for its PDF.
 *
 * The seam Phase 7's route calls. It exists so that "finalise" and "render"
 * cannot be done separately by accident — a route that called `finalizeInvoice`
 * alone would produce a perfectly valid issued invoice with no document, and
 * nothing anywhere would report a problem.
 *
 * ⚠️ THE RENDER IS ENQUEUED AFTER THE TRANSACTION COMMITS, NOT INSIDE IT, AND
 *   THE ORDER IS NOT NEGOTIABLE. Enqueue inside the transaction and the worker —
 *   which is a different process, already awake, and faster than a commit — can
 *   pick the job up and go looking for an invoice its own snapshot cannot yet
 *   see. That surfaces as an intermittent "invoice not found" on a document the
 *   API just created, roughly never in development and regularly under load.
 *
 * ⚠️ AND A FAILED ENQUEUE MUST NOT FAIL THE REQUEST. By the time this runs the
 *   invoice has a number, frozen totals and a row an auditor can read: it IS a
 *   document, and the PDF is a rendering of a decision already made. Throwing
 *   here would report failure for something that succeeded, and the cashier's
 *   reasonable response — press Issue again — is refused by the lifecycle guard,
 *   leaving them with an invoice they have been told does not exist. A Redis
 *   outage is logged and the render is retried later.
 */

import { withTenant, type TenantContext } from '@rcln/db';
import { DOCUMENT_JOB, QUEUE, jobId, type InvoicePdfJob } from '@rcln/queue';

import { getJobProducer } from '../../queue/producer.js';
import { logger } from '../../utils/logger.js';

import {
  finalizeInvoice,
  type FinalizedInvoice,
  type InvoiceAuditOptions,
} from './invoice-lifecycle.service.js';

export async function issueInvoice(
  ctx: TenantContext,
  input: { invoiceId: string; issuedAt: Date },
  options: InvoiceAuditOptions = {}
): Promise<FinalizedInvoice> {
  const issued = await withTenant(ctx, async (tx) => finalizeInvoice(tx, ctx, input, options));

  await requestInvoicePdf(ctx, {
    organizationId: ctx.organizationId,
    branchId: issued.branchId,
    invoiceId: issued.id,
    requestedBy: ctx.userId ?? null,
  });

  return issued;
}

/**
 * Ask the worker to render an invoice.
 *
 * Separate from `issueInvoice` because the retry path in Phase 7 needs it on its
 * own: a render that failed five times leaves an ISSUED invoice with no current
 * document, and somebody has to be able to ask again.
 *
 * ⚠️ `attempt` IS WHAT MAKES ASKING AGAIN WORK. BullMQ de-duplicates on job id
 *   while a job is queued, active or recently completed — right for a
 *   double-clicked Issue button, and silently wrong for a deliberate
 *   regeneration, which resolves against the OLD completed job and renders
 *   nothing. See `jobId.invoicePdf`.
 */
export async function requestInvoicePdf(
  ctx: TenantContext,
  job: InvoicePdfJob,
  attempt = 1
): Promise<void> {
  try {
    await getJobProducer().add(QUEUE.DOCUMENTS, DOCUMENT_JOB.INVOICE_PDF, job, {
      jobId: jobId.invoicePdf(job.invoiceId, attempt),
    });
  } catch (error) {
    /*
     * Ids only. This line is written on an error path, which is where a hurried
     * `{ job }` gets added — and the job's invoice belongs to a patient.
     */
    logger.error(
      {
        organizationId: ctx.organizationId,
        invoiceId: job.invoiceId,
        code: 'INVOICE_PDF_ENQUEUE_FAILED',
        error: error instanceof Error ? error.message : 'unknown',
      },
      'could not enqueue the invoice PDF render'
    );
  }
}
