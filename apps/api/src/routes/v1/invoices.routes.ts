import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  cancelInvoiceRequest,
  createCreditNoteRequest,
  createInvoiceFromChargesRequest,
  createInvoiceRequest,
  issueInvoiceRequest,
  listInvoicesQuery,
  updateInvoiceRequest,
  voidInvoiceRequest,
  type CancelInvoiceRequest,
  type CreateCreditNoteRequest,
  type CreateInvoiceFromChargesRequest,
  type CreateInvoiceRequest,
  type DiscountInputRequest,
  type InvoiceLineRequest,
  type IssueInvoiceRequest,
  type ListInvoicesQuery,
  type UpdateInvoiceRequest,
  type VoidInvoiceRequest,
} from '@rcln/contracts';
import { withTenant } from '@rcln/db';
import { renderInvoiceHtml } from '@rcln/documents';
import { DocumentError, readDocument } from '@rcln/documents/store';
import { money, type Money } from '@rcln/payments';
import { PERMISSIONS, type PermissionCode } from '@rcln/permissions';

import {
  authenticate,
  authorize,
  callerHasPermission,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  cancelInvoice,
  createInvoice,
  getInvoice,
  invoiceCurrency,
  getInvoiceDocumentData,
  issueInvoiceById,
  listInvoices,
  recordInvoicePrint,
  updateInvoice,
  voidIssuedInvoice,
  type InvoiceActionOptions,
} from '../../services/invoicing/invoice.service.js';
import type { DraftLineInput } from '../../services/invoicing/invoice-lifecycle.service.js';
import { createInvoiceFromCharges } from '../../services/invoicing/charge-billing.service.js';
import { createCreditNote } from '../../services/invoicing/credit-note.service.js';
import {
  practitionerProfileFor,
  resolveInvoiceVisibility,
  type InvoiceVisibility,
} from '../../services/invoicing/invoice-visibility.js';
import { AppError } from '../../utils/errors.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/response.js';

/**
 * Patient invoices — the first surface on the engine Phases 1–6 built.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ⚠️ `billing.invoice.read` GETS YOU THE SURFACE; WHAT YOU SEE ON IT IS DERIVED.
 *   Every read here resolves the caller's visible SOURCES first — a pharmacist
 *   sees pharmacy invoices, the accountant sees all of them — and hands that set
 *   to the service, which applies it in the QUERY. Never as a default for a
 *   `?sourceType=` the caller passed: a filter the client controls is not a
 *   boundary. The rule lives in `invoice-visibility.ts` and is consulted by the
 *   list, the detail, the document and the PDF alike, because three copies of it
 *   is how a download link outlives the list it was hidden from.
 *
 * ⚠️ THIS IS A PHI SURFACE. An invoice carries a customer name and, in every
 *   line description, what the patient was treated for. The reads write
 *   `data_access_logs` rows and `meta()` passes the route PATTERN, never
 *   `req.originalUrl` — and the list contract deliberately has no free-text
 *   search parameter, because a name in a query string is a name in the proxy
 *   log, the browser history and the referrer of the next request.
 *
 * ⚠️ ISSUING IS `billing.invoice.create`, NOT `.update`. Raising the bill and
 *   handing it over are one act at a counter; a receptionist who could open a
 *   draft and never issue it would have half a job. `.update` is the separate
 *   power to change a bill somebody else opened, and `.cancel` covers both
 *   abandoning a draft and voiding an issued document — the second being much
 *   the heavier act, which is why it demands a reason and keeps the number.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const invoiceParams = z.object({ invoiceId: z.uuid() });

/**
 * Request metadata for the disclosure trail.
 *
 * `route` is the PATTERN composed with the mount point — `/v1/invoices/:invoiceId`,
 * never the resolved URL.
 */
const meta = (req: Request, pattern: string): InvoiceActionOptions => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') } : {}),
  route: `${req.method} /v1/invoices${pattern === '/' ? '' : pattern}`,
});

/**
 * What this caller may see. One resolution per request, passed down.
 *
 * ⚠️ TWO QUESTIONS, ASKED TOGETHER: which SOURCES are this caller's business,
 *   and — when they are a clinician without the whole ledger — which invoices
 *   are theirs. The doctor-profile lookup is a single indexed read under
 *   `withTenant`, and it is skipped entirely for a caller holding
 *   `billing.invoice.read_all`, which is every administrative role.
 */
const visibilityOf = async (req: Request): Promise<InvoiceVisibility> => {
  const holds = (permission: PermissionCode): Promise<boolean> =>
    callerHasPermission(req, permission);

  if (await holds(PERMISSIONS.INVOICE_READ_ALL)) return resolveInvoiceVisibility(holds);

  /*
   * Looked up only for a clinician — nobody else's scope depends on it, and this
   * is a database read on the hot path of every invoice request.
   */
  if (!(await holds(PERMISSIONS.PRESCRIPTION_SIGN))) return resolveInvoiceVisibility(holds);

  return resolveInvoiceVisibility(holds, await practitionerProfileFor(tenantContextFrom(req)));
};

/**
 * The wire's money and quantities → the service's.
 *
 * ⚠️ ONE PLACE, AND IT IS THIS ONE. `unitPriceMinor` is an integer on the wire
 *   and a `Money` in the engine; a second conversion somewhere else is how a
 *   currency gets assumed. The currency comes from the request or, when it does
 *   not, from the organization — which the service resolves, so the `Money`
 *   built here is denominated in whatever the caller stated and the engine
 *   refuses a mismatch rather than silently re-denominating.
 */
function toLines(lines: InvoiceLineRequest[], currency: string): DraftLineInput[] {
  return lines.map((line) => ({
    description: line.description,
    taxCategory: line.taxCategory,
    itemCode: line.itemCode ?? null,
    quantity: line.quantity,
    unitPrice: money(line.unitPriceMinor, currency),
    ...(line.discount ? { discount: toDiscount(line.discount, currency) } : {}),
  }));
}

function toDiscount(
  discount: DiscountInputRequest,
  currency: string
): { type: 'PERCENTAGE'; bps: number } | { type: 'FIXED'; amount: Money } {
  return discount.type === 'PERCENTAGE'
    ? { type: 'PERCENTAGE', bps: discount.bps }
    : { type: 'FIXED', amount: money(discount.amountMinor, currency) };
}

/**
 * The customer block, with every absent field written as an explicit null.
 *
 * `nullish()` on the wire means "omitted or cleared", and the service's input
 * distinguishes the two only in that both end as NULL in the column. Collapsing
 * it here rather than at four call sites is also what `exactOptionalPropertyTypes`
 * is asking for: a key present with the value `undefined` is not the same thing
 * as an absent key, and Prisma treats it as "leave this alone".
 */
function toCustomer(customer: CreateInvoiceRequest['customer']): {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
} {
  return {
    name: customer.name,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    address: customer.address ?? null,
    taxId: customer.taxId ?? null,
  };
}

/**
 * The currency every `Money` in this request is denominated in.
 *
 * ⚠️ RESOLVED HERE BECAUSE A `Money` CANNOT BE BUILT WITHOUT ONE, AND THE
 *   REQUEST MAY NOT STATE IT. `createDraftInvoice` defaults it from the
 *   organization; by the time it does, this route has already had to turn
 *   `unitPriceMinor` into a `Money`. Reading it once, here, keeps the two in
 *   agreement — the alternative is a placeholder currency that the engine then
 *   rejects as a mismatch, on a request that was perfectly valid.
 */
async function organizationCurrencyOf(req: Request): Promise<string> {
  const ctx = tenantContextFrom(req);

  const organization = await withTenant(ctx, (tx) =>
    tx.organization.findFirst({
      where: { id: ctx.organizationId },
      select: { currency: true },
    })
  );

  if (!organization) throw new AppError('Organization not found', 404, 'NOT_FOUND');
  return organization.currency;
}

/**
 * A storage failure → the HTTP answer the client can act on.
 *
 * ⚠️ `NOT_READY` IS A 409 AND NOT A 404, AND THE DIFFERENCE IS WHAT THE CLIENT
 *   SHOULD DO NEXT. A 404 says stop; this says the render is still in flight and
 *   the same request will work shortly. `CHECKSUM_MISMATCH` is a 500 on purpose:
 *   the bytes on disk are not the bytes that were stored, which is our problem
 *   and not the caller's, and it is already logged with the document id.
 */
function asDocumentAppError(error: unknown): AppError {
  if (!(error instanceof DocumentError)) {
    return error instanceof AppError ? error : new AppError('The document could not be read', 500);
  }

  switch (error.code) {
    case 'NOT_READY':
      return new AppError(
        'The document is still being generated. Try again in a moment.',
        409,
        'DOCUMENT_NOT_READY'
      );
    case 'NOT_FOUND':
      return new AppError('The document could not be found', 404, 'NOT_FOUND');
    default:
      return new AppError('The document could not be retrieved', 500, error.code);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The list.
 *
 * Paginated because a busy clinic raises hundreds of invoices a week and an
 * unbounded reply is both a slow screen and the whole ledger in one response
 * body. The filters are ids, enums and dates — never a name.
 */
router.get(
  '/',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(listInvoicesQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListInvoicesQuery;

    const { invoices, total } = await listInvoices(
      tenantContextFrom(req),
      query,
      await visibilityOf(req),
      meta(req, '/')
    );

    sendPaginated(res, invoices, total, query.page, query.limit);
  }
);

/** One invoice, with its lines, its tax summary and the state of its PDF. */
router.get(
  '/:invoiceId',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(invoiceParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const invoice = await getInvoice(
      tenantContextFrom(req),
      req.params.invoiceId as string,
      await visibilityOf(req),
      meta(req, '/:invoiceId')
    );
    sendSuccess(res, invoice);
  }
);

/**
 * The document, as data — what the preview renders.
 *
 * ⚠️ THIS IS NOT A SECOND SHAPE OF THE DETAIL RESPONSE, AND THE DUPLICATION IS
 *   THE FEATURE. `GET /:invoiceId` is what a SCREEN needs — ids, states, what is
 *   editable. This is what the DOCUMENT says, from `loadInvoiceDocumentData()`,
 *   which is the same function the worker calls to render the PDF. That shared
 *   loader is the entire reason the invoice on screen and the invoice a patient
 *   downloads cannot drift, so this route returns its output untouched.
 *
 * Available for a DRAFT too: the clinic must be able to see the document before
 * it is issued, which is what the phase was for.
 */
router.get(
  '/:invoiceId/document',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(invoiceParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const data = await getInvoiceDocumentData(
      tenantContextFrom(req),
      req.params.invoiceId as string,
      await visibilityOf(req),
      meta(req, '/:invoiceId/document')
    );
    sendSuccess(res, data);
  }
);

/**
 * The document, rendered — what the preview frame on the invoice screen loads.
 *
 * ⚠️ THE RENDER LIVES HERE AND NOT IN THE WEB APP, AND THE BUILD IS WHAT DECIDED
 *   THAT. Phase 6 put it in a Server Component, which was never imported until the
 *   Phase 9 screen imported it — and `next build` then refused outright:
 *   `renderInvoiceHtml` reaches `react-dom/server`, which Next declines to bundle
 *   in a Server Component OR in an App Route. Serving the document from the
 *   service that owns the data is the better arrangement in any case: the web is
 *   now a conduit for both representations of this invoice, the HTML and the PDF,
 *   rather than the renderer of one and the proxy of the other.
 *
 * ⚠️ AND IT IS THE SAME FUNCTION THE WORKER PRINTS THE PDF WITH, WHICH IS THE
 *   ENTIRE REQUIREMENT OF PHASE 6. What the clinic sees and what the patient
 *   receives are the same document because both are `renderInvoiceHtml` over
 *   `loadInvoiceDocumentData()`. A React screen kept alike by hand would be two
 *   templates and one reconciliation meeting.
 *
 * ⚠️ NOT A REPLACEMENT FOR `/document`, WHICH ANSWERS WITH THE DATA. That route is
 *   what a client that wants to do something else with the document uses, and it
 *   is what the Phase 7 suite asserts the worker renders from. This one is for a
 *   browser, so it answers `text/html` with a `Content-Security-Policy` that
 *   forbids everything the document does not use — the template has no scripts, the
 *   frame is sandboxed without `allow-scripts`, and this is the third layer.
 *
 * Available for a DRAFT too, for the same reason `/document` is.
 */
router.get(
  '/:invoiceId/preview',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(invoiceParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const data = await getInvoiceDocumentData(
      tenantContextFrom(req),
      req.params.invoiceId as string,
      await visibilityOf(req),
      meta(req, '/:invoiceId/preview')
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The document names a patient. Same rule as the PDF route.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(renderInvoiceHtml(data));
  }
);

/**
 * The stored PDF.
 *
 * ⚠️ ALWAYS THE STORED BYTES, NEVER A RE-RENDER. The patient's copy and the
 *   clinic's copy are one file, whose checksum `readDocument` verifies on the
 *   way out — a document whose bytes no longer match what was recorded is either
 *   corrupt or substituted, and neither may be handed over as a tax invoice.
 *
 * ⚠️ `409 DOCUMENT_NOT_READY` IS A NORMAL ANSWER AND NOT AN ERROR. The render is
 *   queued after the invoice commits and runs in the worker, so there is a
 *   window — usually about a second — in which an issued invoice has no bytes.
 *   The screen renders the document from data throughout; only Download waits,
 *   and the client's correct response is to try again shortly.
 */
router.get(
  '/:invoiceId/pdf',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(invoiceParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    const invoiceId = req.params.invoiceId as string;

    /*
     * The visibility check, the 404 and the PRINT row all happen here, before a
     * byte is read — `readDocument` takes a file id and knows nothing about
     * invoices or about who may see one.
     */
    const { invoiceNumber, documentId } = await recordInvoicePrint(
      ctx,
      invoiceId,
      await visibilityOf(req),
      meta(req, '/:invoiceId/pdf')
    );

    if (!documentId) {
      throw new AppError(
        'This invoice has no document yet. A draft has none until it is issued.',
        409,
        'DOCUMENT_NOT_READY'
      );
    }

    let body: Buffer;
    try {
      ({ body } = await readDocument(ctx, documentId));
    } catch (error) {
      throw asDocumentAppError(error);
    }

    res.setHeader('Content-Type', 'application/pdf');
    /*
     * `inline`, so a click opens the document rather than dropping a file in the
     * Downloads folder — a cashier checking a bill wants to look at it. The name
     * is the invoice NUMBER and never the patient's: a filename survives into
     * every folder, mail attachment and screen share the file reaches.
     */
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNumber ?? 'invoice'}.pdf"`);
    /* PHI. Not a byte of it in a shared cache, ever. */
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  }
);

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Open a draft. Priced immediately, so the reply is what the cashier will bill. */
router.post(
  '/',
  authorize(PERMISSIONS.INVOICE_CREATE),
  validate(createInvoiceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateInvoiceRequest;
    const currency = body.currency ?? (await organizationCurrencyOf(req));

    const invoice = await createInvoice(
      tenantContextFrom(req),
      {
        branchId: body.branchId,
        sourceType: body.sourceType,
        appointmentId: body.appointmentId ?? null,
        patientId: body.patientId ?? null,
        customer: toCustomer(body.customer),
        suppliedOn: body.suppliedOn,
        dueOn: body.dueDate ?? null,
        currency,
        lines: toLines(body.lines, currency),
        ...(body.discount ? { discount: toDiscount(body.discount, currency) } : {}),
        notes: body.notes ?? null,
      },
      await visibilityOf(req),
      meta(req, '/')
    );

    sendCreated(res, invoice);
  }
);

/**
 * Replace a draft.
 *
 * A PUT of the whole document rather than a PATCH or a line-level CRUD: the
 * whole-bill discount is apportioned across every line, so touching one line
 * re-prices all of them. See the contract's own note.
 */
router.put(
  '/:invoiceId',
  authorize(PERMISSIONS.INVOICE_UPDATE),
  validate(invoiceParams, 'params'),
  validate(updateInvoiceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as UpdateInvoiceRequest;
    const ctx = tenantContextFrom(req);
    const visibility = await visibilityOf(req);
    const invoiceId = req.params.invoiceId as string;

    /*
     * ⚠️ THE INVOICE'S OWN CURRENCY, NOT THE ORGANIZATION'S. A draft's currency
     *   is fixed when it is opened and cannot be changed by an edit; building
     *   these prices in the org default would refuse a perfectly valid PUT
     *   against a draft opened in anything else.
     */
    const currency = body.currency ?? (await invoiceCurrency(ctx, invoiceId, visibility));

    const invoice = await updateInvoice(
      ctx,
      {
        invoiceId,
        patientId: body.patientId ?? null,
        customer: toCustomer(body.customer),
        suppliedOn: body.suppliedOn,
        dueOn: body.dueDate ?? null,
        lines: toLines(body.lines, currency),
        ...(body.discount ? { discount: toDiscount(body.discount, currency) } : {}),
        notes: body.notes ?? null,
      },
      visibility,
      meta(req, '/:invoiceId')
    );

    sendSuccess(res, invoice);
  }
);

/**
 * Issue it — the act that turns a draft into a document.
 *
 * Re-prices from the stored inputs first, refuses an invoice with an unrated
 * line, checks the branch is covered by the registration it would be issued
 * under, takes the number last, and asks the worker for the PDF once the
 * transaction has committed. All of that is `issueInvoice()`; this route's job
 * is to be the only door to it.
 */
router.post(
  '/:invoiceId/issue',
  authorize(PERMISSIONS.INVOICE_CREATE),
  validate(invoiceParams, 'params'),
  validate(issueInvoiceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as IssueInvoiceRequest;

    const invoice = await issueInvoiceById(
      tenantContextFrom(req),
      { invoiceId: req.params.invoiceId as string, issuedOn: body.issuedOn },
      await visibilityOf(req),
      meta(req, '/:invoiceId/issue')
    );

    sendSuccess(res, invoice);
  }
);

/** Abandon a draft. Reachable from DRAFT only — nothing was ever shown. */
router.post(
  '/:invoiceId/cancel',
  authorize(PERMISSIONS.INVOICE_CANCEL),
  validate(invoiceParams, 'params'),
  validate(cancelInvoiceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CancelInvoiceRequest;

    const invoice = await cancelInvoice(
      tenantContextFrom(req),
      { invoiceId: req.params.invoiceId as string, reason: body.reason ?? null },
      await visibilityOf(req),
      meta(req, '/:invoiceId/cancel')
    );

    sendSuccess(res, invoice);
  }
);

/**
 * Reverse an issued invoice, keeping its number.
 *
 * ⚠️ A SEPARATE ROUTE FROM CANCEL, NOT A STATUS PARAMETER, because they are
 *   different acts on different documents: a cancelled draft was seen by nobody,
 *   a void reverses a document the patient is holding a copy of. The reason is
 *   required here and optional there for the same reason. The number and the row
 *   stay for ever — a deleted number is a permanent hole in a series no reprint
 *   can fill.
 */
router.post(
  '/:invoiceId/void',
  authorize(PERMISSIONS.INVOICE_CANCEL),
  validate(invoiceParams, 'params'),
  validate(voidInvoiceRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as VoidInvoiceRequest;

    const invoice = await voidIssuedInvoice(
      tenantContextFrom(req),
      { invoiceId: req.params.invoiceId as string, reason: body.reason },
      await visibilityOf(req),
      meta(req, '/:invoiceId/void')
    );

    sendSuccess(res, invoice);
  }
);

/**
 * Raise one invoice from a set of pending charges (PI-8).
 *
 * ⚠️ `billing.invoice.create` AND NOT A NEW CODE, because this confers nothing
 *   the generic create does not: it assembles a document from charges somebody
 *   already approved. Deciding whether a supply is billed AT ALL is a different
 *   act and is gated by `billing.charge_request.manage` on the charging router.
 *
 * ⚠️ MOUNTED HERE RATHER THAN UNDER `/v1/charging`, because what it returns is an
 *   invoice and what it enforces is the invoice engine's rules — the branch, the
 *   patient, the currency and the source must all agree. A create endpoint that
 *   returned an invoice from a router the invoice permissions do not gate is how
 *   a second door into billing gets written.
 */
router.post(
  '/from-charges',
  authorize(PERMISSIONS.INVOICE_CREATE),
  validate(createInvoiceFromChargesRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateInvoiceFromChargesRequest;

    const invoice = await createInvoiceFromCharges(
      tenantContextFrom(req),
      body,
      await visibilityOf(req),
      meta(req, '/from-charges')
    );

    sendCreated(res, invoice);
  }
);

/**
 * Reverse an issued invoice with a credit note (PI-8).
 *
 * ⚠️ `billing.credit_note.issue`, WHICH HAS BEEN SEEDED SINCE PHASE 3 AND HAD
 *   NOTHING BEHIND IT. `voidInvoice`'s header recorded why: there was no table,
 *   no series and no `CREDIT_NOTE` kind to put one in. This is the route that
 *   makes the code reachable.
 *
 * ⚠️ NOT `billing.invoice.cancel`, AND THE SPLIT IS REAL. Voiding reverses a
 *   document in full and keeps its number; a credit note reverses part of one,
 *   several times over as stock comes back, and issues a NEW document with its
 *   own statutory serial. A clinic separating who may reverse a bill from who
 *   may void one is a control the seeded code already anticipated.
 *
 * ⚠️ AND IT MOVES NO MONEY. A credit note is the DOCUMENT saying the clinic owes
 *   the patient; the refund is a payment, and there is no patient-payments table
 *   yet. See the service header.
 */
router.post(
  '/:invoiceId/credit-notes',
  authorize(PERMISSIONS.CREDIT_NOTE_ISSUE),
  validate(invoiceParams, 'params'),
  validate(createCreditNoteRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateCreditNoteRequest;

    const note = await createCreditNote(
      tenantContextFrom(req),
      req.params.invoiceId as string,
      body,
      await visibilityOf(req),
      meta(req, '/:invoiceId/credit-notes')
    );

    sendCreated(res, note);
  }
);

export default router;
