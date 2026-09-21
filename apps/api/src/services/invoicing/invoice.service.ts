/**
 * The invoice module's request-shaped half: what a screen asks for, in one call.
 *
 * The lifecycle service owns the WRITES and takes a transaction, because
 * finalisation has to be one. This file owns the READS and the orchestration —
 * it opens the transaction, converts the wire's calendar dates into instants,
 * turns `numeric(14,2)` into the minor units the contracts promise, and writes
 * the disclosure trail.
 *
 * ⚠️ EVERY READ HERE IS SOURCE-SCOPED BY A SET COMPUTED FROM THE CALLER'S OWN
 *   PERMISSIONS, NEVER BY A PARAMETER THEY SENT. See `invoice-visibility.ts`.
 *   The list applies it as a predicate; the detail and the PDF apply it as a
 *   404. A filter the client controls is not a boundary.
 *
 * ⚠️ AND EVERY READ THAT NAMES A PATIENT WRITES A `data_access_logs` ROW, inside
 *   the transaction that read it. An invoice carries a customer name and what
 *   they were treated for, in the description of every line — "Ultrasound,
 *   obstetric" is a disclosure whether or not the word patient appears. The rule
 *   this file follows is the one in `data-access.service.ts`: log a read that
 *   singles out one patient's record. A cashier's list of today's bills for
 *   their own branch is the day board, and logging it would turn the table into
 *   a per-poll firehose; the same list filtered to one `patientId` is a search
 *   of that patient's billing history and IS logged.
 */
import { randomUUID } from 'node:crypto';

import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  DiscountInputRequest,
  InvoiceDetail,
  InvoiceDocumentState,
  InvoiceItemDetail,
  InvoiceListItem,
  InvoiceTaxLine,
  ListInvoicesQuery,
} from '@rcln/contracts';
/*
 * Two entry points, and they are separate for a reason the package header
 * states: `.` is how a document LOOKS and is browser-safe, `./data` is what it
 * SAYS and reaches for Prisma. The API needs the second and the type from the
 * first.
 */
import type { InvoiceDocumentData } from '@rcln/documents';
import { loadInvoiceDocumentData } from '@rcln/documents/data';
import { isIssuable } from '@rcln/tax';

import { NotFoundError } from '../../utils/errors.js';
import { recordDataAccess } from '../audit/data-access.service.js';

import {
  cancelDraftInvoice,
  createDraftInvoice,
  updateDraftInvoice,
  voidInvoice,
  type CreateDraftInvoiceInput,
  type InvoiceAuditOptions,
  type UpdateDraftInvoiceInput,
} from './invoice-lifecycle.service.js';
import { canSeePractitioner, canSeeSource, type InvoiceVisibility } from './invoice-visibility.js';
import { issueInvoice } from './issue-invoice.js';
import { toMoney } from './money.js';

/** Request metadata, carried onto the disclosure trail. */
export interface InvoiceActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/**
 * The same metadata, narrowed for `audit_logs`, which has no `route` column.
 *
 * ⚠️ IT DROPS `route` RATHER THAN LETTING IT THROUGH, AND THE TWO TABLES DIFFER
 *   ON PURPOSE. A read leaves no trace of its own shape, so `data_access_logs`
 *   records the endpoint it arrived on; a mutation is described by what it
 *   changed, and the door it came through is a property of the request. Passing
 *   the wider object would compile — `recordAudit` ignores the extra key — and
 *   would leave the next reader believing the column exists.
 */
export function auditOptions(options: InvoiceActionOptions): InvoiceAuditOptions {
  return {
    ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIST_SELECT = {
  id: true,
  invoiceNumber: true,
  /* PI-8: a charge or a reversal. ⚠️ Every money field is positive on both. */
  kind: true,
  creditedInvoiceId: true,
  status: true,
  sourceType: true,
  branchId: true,
  patientId: true,
  customerName: true,
  currency: true,
  grandTotal: true,
  amountPaid: true,
  suppliedAt: true,
  issuedAt: true,
  dueDate: true,
  createdAt: true,
} satisfies Prisma.InvoiceSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  appointmentId: true,
  /* Not printed — `loadVisible` compares it against the caller's own scope. */
  practitionerProfileId: true,
  customerPhone: true,
  customerEmail: true,
  customerAddress: true,
  customerTaxId: true,
  issuerTaxId: true,
  issuerLegalName: true,
  placeOfSupply: true,
  taxTreatment: true,
  subtotal: true,
  lineDiscountTotal: true,
  invoiceDiscountTotal: true,
  taxableAmount: true,
  taxTotal: true,
  roundingAdjustment: true,
  discountType: true,
  discountBps: true,
  discountFixed: true,
  notes: true,
  cancellationReason: true,
  cancelledAt: true,
  voidedAt: true,
  /*
   * The credit notes raised against this invoice (PI-8).
   *
   * ⚠️ ONLY THE ONES THAT STILL STAND. A cancelled draft note and a voided one
   *   both reverse nothing, so including them would show a patient a bill as
   *   credited when the credit had itself been undone — and would make the
   *   `creditedTotalMinor` the credit-note engine checks against too large,
   *   permanently blocking a clinic that voided a mistaken note from raising the
   *   right one. The same LIVE-status argument `appointment-billing.service.ts`
   *   makes about "is this visit already billed?".
   */
  creditNotes: {
    where: {
      deletedAt: null,
      status: { in: ['DRAFT', 'FINALIZING', 'ISSUED', 'PARTIALLY_PAID', 'PAID'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      currency: true,
      grandTotal: true,
      amountPaid: true,
      issuedAt: true,
    },
  },
  items: {
    orderBy: { lineNumber: 'asc' },
    select: {
      id: true,
      lineNumber: true,
      description: true,
      taxCategory: true,
      itemCode: true,
      quantity: true,
      unitPrice: true,
      grossAmount: true,
      discountAmount: true,
      apportionedDiscount: true,
      taxableAmount: true,
      taxAmount: true,
      lineTotal: true,
      taxTreatment: true,
      taxReason: true,
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
  },
} satisfies Prisma.InvoiceSelect;

/**
 * A uuid no row can carry, for the one filter that must match nothing.
 *
 * The nil uuid is a legal value the column would accept and a real row could
 * theoretically hold; this is generated per process, so it cannot collide with
 * anything a clinic ever stored.
 */
const IMPOSSIBLE_ID = randomUUID();

type ListRow = Prisma.InvoiceGetPayload<{ select: typeof LIST_SELECT }>;
type DetailRow = Prisma.InvoiceGetPayload<{ select: typeof DETAIL_SELECT }>;

export interface InvoiceListResult {
  invoices: InvoiceListItem[];
  total: number;
}

/**
 * The list.
 *
 * ⚠️ THE DATE FILTER IS ON `COALESCE(issued_at, created_at)` EXPRESSED AS TWO
 *   BRANCHES OF AN `OR`, NOT ON ONE COLUMN. A clinic looking at "the 9th" means
 *   the documents dated the 9th; a draft has no issue date and would vanish from
 *   every range, which is the one state a cashier is most likely to be hunting
 *   for. Both bounds are converted from the branch's zone when a branch is
 *   named, and from UTC when the query spans the whole organization — a range
 *   over several branches in different zones has no single local midnight, and
 *   quietly picking the first branch's would be worse than saying so here.
 */
export async function listInvoices(
  ctx: TenantContext,
  query: ListInvoicesQuery,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceListResult> {
  return withTenant(ctx, async (tx) => {
    const sourceFilter = query.sourceType
      ? /*
         * The caller's filter INTERSECTS the visible set; it never replaces it.
         * `?sourceType=LAB` from a pharmacist resolves to an empty `in`, which
         * is the same answer as "there are no lab invoices" — correct, and it
         * discloses nothing about whether any exist.
         */
        canSeeSource(visibility, query.sourceType)
        ? [query.sourceType]
        : []
      : visibility.sources;

    const range = await dateRange(tx, query);

    const where: Prisma.InvoiceWhereInput = {
      organizationId: ctx.organizationId,
      deletedAt: null,
      ...(visibility.all && query.sourceType === undefined
        ? {}
        : { sourceType: { in: sourceFilter } }),
      /*
       * ⚠️ THE CALLER'S OWN WORK, WHEN THE CALLER IS A CLINICIAN. Applied in the
       *   query and not filtered out afterwards, so the count, the pages and the
       *   totals all describe the same set. Null for anybody not scoped, which
       *   leaves the clause off entirely rather than matching null rows.
       *
       *   It ANDs with everything else, including a `?patientId=` the caller
       *   passed: a doctor filtering to one patient sees their own consultations
       *   for that patient, never the whole chart's billing. Same rule as the
       *   source filter — a value the client controls intersects the visible set
       *   and never replaces it.
       */
      ...(visibility.scopedToOwnWork
        ? {
            /*
             * ⚠️ A CLINICIAN WITH NO PROFILE MATCHES NOTHING, AND MUST NOT MATCH
             *   NULL. `practitionerProfileId: null` would return every
             *   unattributed counter sale in the clinic — the fail-open this
             *   pair of fields exists to close. An impossible id is the honest
             *   predicate: the list comes back empty, which is a visible setup
             *   gap rather than a silent disclosure.
             */
            practitionerProfileId: visibility.practitionerProfileId ?? IMPOSSIBLE_ID,
          }
        : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      /*
       * PI-8. ⚠️ OMITTED RETURNS BOTH KINDS, WHICH IS THE ONLY SAFE DEFAULT —
       *   defaulting to `INVOICE` would hide every credit note from the ledger
       *   an accountant reconciles, and a reversal nobody can find is worse than
       *   one in an unexpected list. The screens that mean one or the other say
       *   so. Both are subject to the same source and practitioner scoping
       *   above, because a credit note discloses exactly what its invoice does.
       */
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.creditedInvoiceId ? { creditedInvoiceId: query.creditedInvoiceId } : {}),
      /*
       * ⚠️ A FRAGMENT, MATCHED ANYWHERE IN THE NUMBER AND WITHOUT CASE. Typing
       *   `787` finds `INV-2026-APP-MAIN-000787`, which is what somebody reading
       *   a number off a printed bill actually types. The exact match this
       *   replaced answered "no invoices" to every one of those, and an empty
       *   ledger is indistinguishable from a clinic that has billed nothing.
       *
       *   `contains` is an unanchored ILIKE and cannot use an index. That is
       *   acceptable and not an oversight: RLS has already narrowed the scan to
       *   one organization, and a clinic's invoice table is thousands of rows,
       *   not millions. It stops being acceptable at the point a tenant's ledger
       *   is large enough to feel it — a trigram index on `invoice_number` is the
       *   answer then, not a return to exact matching.
       */
      ...(query.invoiceNumber
        ? { invoiceNumber: { contains: query.invoiceNumber, mode: 'insensitive' as const } }
        : {}),
      ...(range
        ? {
            OR: [
              { issuedAt: { gte: range[0], lt: range[1] } },
              { issuedAt: null, createdAt: { gte: range[0], lt: range[1] } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.invoice.findMany({
        where,
        select: LIST_SELECT,
        /*
         * Newest first, and `id` as the tiebreak. Two invoices created in the
         * same millisecond — one till, one script, one seed — would otherwise
         * come back in whatever order the plan produced, and a row can then
         * appear on both page 1 and page 2 or on neither.
         */
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.invoice.count({ where }),
    ]);

    /*
     * Logged only when the caller asked about one patient — see the file header
     * for why the branch's own day list is not a disclosure event.
     */
    if (query.patientId) {
      await recordDataAccess(tx, ctx, {
        accessType: 'SEARCH',
        resource: 'INVOICE',
        patientId: query.patientId,
        resultCount: rows.length,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...options,
      });
    }

    return { invoices: rows.map(toListItem), total };
  });
}

/**
 * One invoice, in full.
 *
 * Logged when it names a patient: this is the bill itself, with every line's
 * description on it.
 */
export async function getInvoice(
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  return readInvoiceDetail(ctx, invoiceId, visibility, options, true);
}

/**
 * The same read, with and without the disclosure row.
 *
 * ⚠️ THE WRITE PATHS READ BACK WITHOUT LOGGING, AND THAT IS THE SAME RULE
 *   `patient.service.ts` STATES ABOUT CREATION: a creation is a write, and
 *   `audit_logs` records it. Every write here answers with the priced document —
 *   which it must, because the engine's numbers are the point — and logging that
 *   echo would file a `data_access_logs` row against the person who just typed
 *   the bill, on the route `POST /v1/invoices`. A review of who read whose chart
 *   would then be mostly cashiers reading their own work, which is exactly the
 *   noise that makes the rows that matter hard to find.
 *
 * Exported for the appointment-billing path, which is a write in this module
 * that lives in another file and needs the same `log: false` read-back. Callers
 * that mean "show me this invoice" want `getInvoice`.
 */
export async function readInvoiceDetail(
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions,
  log: boolean
): Promise<InvoiceDetail> {
  return withTenant(ctx, async (tx) => {
    const invoice = await loadVisible(tx, ctx, invoiceId, visibility);
    const document = await currentDocument(tx, ctx, invoiceId);

    if (log) await logInvoiceRead(tx, ctx, invoice, 'VIEW', options);

    return toDetail(invoice, document);
  });
}

/**
 * The document, as data — what the preview iframe renders.
 *
 * ⚠️ THIS RETURNS `loadInvoiceDocumentData()`'s OWN OUTPUT, UNTOUCHED, AND
 *   RESHAPING IT HERE WOULD UNDO PHASE 6. The screen and the printed PDF are the
 *   same document precisely because both render the same value from the same
 *   loader — the worker calls it to render the PDF, this route calls it to feed
 *   the iframe. A field massaged on the way through is a field that differs
 *   between what the clinic approved and what the patient downloads.
 */
export async function getInvoiceDocumentData(
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDocumentData> {
  return withTenant(ctx, async (tx) => {
    const invoice = await loadVisible(tx, ctx, invoiceId, visibility);
    const data = await loadInvoiceDocumentData(tx, ctx, invoiceId);

    await logInvoiceRead(tx, ctx, invoice, 'VIEW', options);

    return data;
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateInvoiceServiceInput extends Omit<
  CreateDraftInvoiceInput,
  'suppliedAt' | 'dueDate'
> {
  /** `YYYY-MM-DD` in the BRANCH's zone. Converted here, once. */
  suppliedOn: string;
  dueOn?: string | null;
}

export async function createInvoice(
  ctx: TenantContext,
  input: CreateInvoiceServiceInput,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  const { id } = await withTenant(ctx, async (tx) => {
    const suppliedAt = await branchInstant(tx, input.branchId, input.suppliedOn);

    return createDraftInvoice(
      tx,
      ctx,
      { ...input, suppliedAt, dueDate: dateColumn(input.dueOn) },
      auditOptions(options)
    );
  });

  /*
   * Read back in its own transaction rather than assembled from the input. The
   * whole point of a draft is that the engine priced it — echoing what the
   * cashier sent would show them their own numbers and hide the tax, the
   * apportioned discount and any line the rate card could not price.
   */
  return readInvoiceDetail(ctx, id, visibility, options, false);
}

export interface UpdateInvoiceServiceInput extends Omit<
  UpdateDraftInvoiceInput,
  'suppliedAt' | 'dueDate'
> {
  suppliedOn: string;
  dueOn?: string | null;
}

export async function updateInvoice(
  ctx: TenantContext,
  input: UpdateInvoiceServiceInput,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  await withTenant(ctx, async (tx) => {
    /*
     * The visibility check comes FIRST, and it is why this is not simply a call
     * into the lifecycle service. Editing a draft you may not read is still
     * reading it — the reply is the priced document.
     */
    const invoice = await loadVisible(tx, ctx, input.invoiceId, visibility);

    await updateDraftInvoice(
      tx,
      ctx,
      {
        ...input,
        suppliedAt: await branchInstant(tx, invoice.branchId, input.suppliedOn),
        dueDate: dateColumn(input.dueOn),
      },
      auditOptions(options)
    );
  });

  return readInvoiceDetail(ctx, input.invoiceId, visibility, options, false);
}

/**
 * Issue it, and ask for the PDF.
 *
 * ⚠️ CALLS `issueInvoice()` AND NOT `finalizeInvoice()`, WHICH IS THE WHOLE
 *   REASON THAT SEAM EXISTS. Finalising alone produces a perfectly valid issued
 *   invoice with no document and nothing anywhere reporting a problem. The
 *   enqueue happens after the commit, inside that function, and a Redis outage
 *   is logged rather than thrown — by then the invoice has a number and frozen
 *   totals, so failing the request would report failure for something that
 *   succeeded.
 */
export async function issueInvoiceById(
  ctx: TenantContext,
  input: { invoiceId: string; issuedOn?: string | undefined },
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  const issuedAt = await withTenant(ctx, async (tx) => {
    const invoice = await loadVisible(tx, ctx, input.invoiceId, visibility);

    return input.issuedOn === undefined
      ? new Date()
      : branchInstant(tx, invoice.branchId, input.issuedOn);
  });

  await issueInvoice(ctx, { invoiceId: input.invoiceId, issuedAt }, auditOptions(options));

  return readInvoiceDetail(ctx, input.invoiceId, visibility, options, false);
}

export async function cancelInvoice(
  ctx: TenantContext,
  input: { invoiceId: string; reason?: string | null },
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  await withTenant(ctx, async (tx) => {
    await loadVisible(tx, ctx, input.invoiceId, visibility);
    await cancelDraftInvoice(tx, ctx, input, auditOptions(options));
  });

  return readInvoiceDetail(ctx, input.invoiceId, visibility, options, false);
}

export async function voidIssuedInvoice(
  ctx: TenantContext,
  input: { invoiceId: string; reason: string },
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  await withTenant(ctx, async (tx) => {
    await loadVisible(tx, ctx, input.invoiceId, visibility);
    await voidInvoice(tx, ctx, input, auditOptions(options));
  });

  return readInvoiceDetail(ctx, input.invoiceId, visibility, options, false);
}

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/**
 * The invoice, or a 404 — for a tenant that cannot see it, an id that does not
 * exist, and a source this caller may not read alike.
 *
 * ⚠️ THE THIRD CASE IS DELIBERATELY INDISTINGUISHABLE FROM THE FIRST TWO. A 403
 *   on "you may not read pharmacy invoices" confirms that this id IS a pharmacy
 *   invoice, which is a fact about the clinic's business disclosed to somebody
 *   who may not read it. Whether the caller's ROLE covers a source is a fact
 *   about them and belongs in the UI.
 */
async function loadVisible(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility
): Promise<DetailRow> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId, deletedAt: null },
    select: DETAIL_SELECT,
  });

  if (!invoice) throw new NotFoundError('Invoice');
  if (!canSeeSource(visibility, invoice.sourceType)) throw new NotFoundError('Invoice');
  /*
   * 404 and not 403, for the reason on `canSeeSource`: a 403 on an id confirms
   * the invoice exists. Every path that reads one invoice comes through here —
   * the detail, the document, the PDF link and the lifecycle writes — so a
   * scoped caller cannot reach another clinician's bill by knowing its id.
   */
  if (!canSeePractitioner(visibility, invoice.practitionerProfileId)) {
    throw new NotFoundError('Invoice');
  }

  return invoice;
}

/**
 * The disclosure row for a read of one invoice.
 *
 * Skipped when the invoice names no patient — a bill raised to a supplier's rep
 * or to a company is not a patient record, and a row with a null `patient_id`
 * on a review of who read whose chart is noise that makes the real rows harder
 * to find.
 */
async function logInvoiceRead(
  tx: TxClient,
  ctx: TenantContext,
  invoice: Pick<DetailRow, 'id' | 'patientId' | 'branchId'>,
  accessType: 'VIEW' | 'PRINT',
  options: InvoiceActionOptions
): Promise<void> {
  if (!invoice.patientId) return;

  await recordDataAccess(tx, ctx, {
    accessType,
    resource: 'INVOICE',
    patientId: invoice.patientId,
    resourceId: invoice.id,
    branchId: invoice.branchId,
    ...options,
  });
}

/**
 * What currency an existing invoice is denominated in.
 *
 * ⚠️ THE ORGANIZATION'S DEFAULT IS THE WRONG ANSWER FOR AN EDIT, AND THE FAILURE
 *   IS SILENT-ISH. A draft's currency is fixed when it is opened and every
 *   `Money` on it is in that currency; a PUT whose body omits `currency` would
 *   otherwise have its prices built in the ORG's, and an invoice opened in USD at
 *   an INR clinic would come back as a currency-mismatch error from deep inside
 *   the pricing engine on a request that was perfectly valid. Answered from the
 *   row, which is the only thing that knows.
 *
 * Visibility-checked, so this cannot be used to probe another caller's invoices
 * for their currency.
 */
export async function invoiceCurrency(
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility
): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const invoice = await loadVisible(tx, ctx, invoiceId, visibility);
    return invoice.currency;
  });
}

/** The public half of the above, for the PDF route, which reads bytes not rows. */
export async function recordInvoicePrint(
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<{ invoiceNumber: string | null; documentId: string | null }> {
  return withTenant(ctx, async (tx) => {
    const invoice = await loadVisible(tx, ctx, invoiceId, visibility);
    const document = await currentDocument(tx, ctx, invoiceId);

    await logInvoiceRead(tx, ctx, invoice, 'PRINT', options);

    return { invoiceNumber: invoice.invoiceNumber, documentId: document?.fileId ?? null };
  });
}

/**
 * The invoice's current PDF row, if it has one.
 *
 * ⚠️ `superseded_at IS NULL` IS THE WHOLE FILTER, and the partial unique index
 *   in the migration is what makes at most one row satisfy it. A retry after a
 *   FAILED render leaves the old row behind on purpose — it is the evidence of
 *   the failure — and picking the newest `generated_at` instead would be the
 *   same answer until the day a superseded row was written last.
 */
const DOCUMENT_SELECT = {
  fileId: true,
  generatedAt: true,
  file: { select: { status: true, originalName: true, sizeBytes: true } },
} satisfies Prisma.InvoiceDocumentSelect;

type CurrentDocument = Prisma.InvoiceDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

async function currentDocument(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<CurrentDocument | null> {
  return tx.invoiceDocument.findFirst({
    where: {
      organizationId: ctx.organizationId,
      invoiceId,
      documentType: 'INVOICE_PDF',
      supersededAt: null,
    },
    select: DOCUMENT_SELECT,
  });
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * A calendar date in the branch's zone → the instant to store.
 *
 * ⚠️ MIDDAY, AND THE TWO OBVIOUS CHOICES ARE BOTH WRONG. This instant is read
 *   twice and by two different rules:
 *
 *     - The DOCUMENT prints it in `branches.timezone`, so it has to fall on the
 *       intended day THERE. UTC midnight fails that for every zone west of
 *       Greenwich: 2026-04-01T00:00Z prints as 31 March in New York.
 *     - `loadTaxContext()` compares it against `tax_rules.effective_from`, which
 *       is a `DATE` column and comes back as UTC midnight. Local midnight fails
 *       that for every zone east of it: an IST supply on 1 April is
 *       2026-03-31T18:30Z, which is BEFORE a rule effective that day — so the
 *       new rate silently does not apply to the first day it is in force.
 *
 *   Local midday satisfies both for every zone within ±12 hours, which is every
 *   zone this product will meet. It is not a fudge but the only point of the day
 *   that is unambiguous under both readings, and it is stated here once rather
 *   than being rediscovered at each call site.
 *
 * The conversion runs in Postgres for the reason `rangeBounds` gives in the
 * appointment service: composing an offset in Node gets a DST boundary wrong.
 */
export async function branchInstant(tx: TxClient, branchId: string, day: string): Promise<Date> {
  /* ⚠️ `::timestamp` is load-bearing — see the note in availability.service.ts. */
  const rows = await tx.$queryRaw<{ at: Date }[]>`
    SELECT (${day}::date + interval '12 hours')::timestamp AT TIME ZONE b.timezone AS at
      FROM branches b
     WHERE b.id = ${branchId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Branch');
  return row.at;
}

/**
 * The list's date bounds.
 *
 * Converted in the branch's zone when the query names one; in UTC otherwise,
 * because a range across branches in different zones has no single local
 * midnight and picking one branch's would be a quiet lie about the others.
 */
async function dateRange(tx: TxClient, query: ListInvoicesQuery): Promise<[Date, Date] | null> {
  if (query.from === undefined && query.to === undefined) return null;

  /*
   * An open end is the widest bound Postgres and JavaScript agree on rather than
   * a second query shape: "everything before the 9th" and "the 9th onwards" are
   * both a range, and branching on which end is present would be three code
   * paths computing one thing.
   */
  const from = query.from ?? '1970-01-01';
  const to = query.to ?? '9999-12-30';

  if (!query.branchId) {
    /* `to` is INCLUSIVE, so the upper bound is the midnight after it. */
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return [start, end];
  }

  const rows = await tx.$queryRaw<{ day_start: Date; day_end: Date }[]>`
    SELECT (${from}::date)::timestamp                  AT TIME ZONE b.timezone AS day_start,
           (${to}::date + interval '1 day')::timestamp AT TIME ZONE b.timezone AS day_end
      FROM branches b
     WHERE b.id = ${query.branchId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Branch');
  return [row.day_start, row.day_end];
}

/** `YYYY-MM-DD` → the value a `DATE` column takes, matching every other service. */
function dateColumn(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

// ---------------------------------------------------------------------------
// Row → wire
// ---------------------------------------------------------------------------

/** The column → minor units, per row, at the row's own currency. */
const minor = (value: Prisma.Decimal, currency: string): number =>
  toMoney(value, currency).amountMinor;

function toListItem(row: ListRow): InvoiceListItem {
  const grandTotal = toMoney(row.grandTotal, row.currency);
  const amountPaid = toMoney(row.amountPaid, row.currency);

  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    kind: row.kind,
    creditedInvoiceId: row.creditedInvoiceId,
    status: row.status,
    sourceType: row.sourceType,
    branchId: row.branchId,
    patientId: row.patientId,
    customerName: row.customerName,
    currency: row.currency,
    grandTotalMinor: grandTotal.amountMinor,
    amountPaidMinor: amountPaid.amountMinor,
    /*
     * Derived and never stored, for the reason the schema comment gives: a
     * stored balance is a third number that can disagree with the two it comes
     * from. Computed in minor units so it cannot pick up a rounding error.
     */
    balanceDueMinor: grandTotal.amountMinor - amountPaid.amountMinor,
    suppliedAt: row.suppliedAt.toISOString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueDate: row.dueDate?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(
  row: DetailRow,
  document: Awaited<ReturnType<typeof currentDocument>>
): InvoiceDetail {
  const currency = row.currency;
  const unissuableReasons = row.items
    .filter((item) => !isIssuable(item.taxTreatment))
    .map(
      (item) =>
        `Line ${String(item.lineNumber)} (${item.taxCategory}) has no rate: ${item.taxReason ?? item.taxTreatment}.`
    );

  return {
    ...toListItem(row),
    appointmentId: row.appointmentId,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    customerAddress: row.customerAddress,
    customerTaxId: row.customerTaxId,
    issuerTaxId: row.issuerTaxId,
    issuerLegalName: row.issuerLegalName,
    placeOfSupply: row.placeOfSupply,
    taxTreatment: row.taxTreatment,
    subtotalMinor: minor(row.subtotal, currency),
    lineDiscountTotalMinor: minor(row.lineDiscountTotal, currency),
    invoiceDiscountTotalMinor: minor(row.invoiceDiscountTotal, currency),
    taxableAmountMinor: minor(row.taxableAmount, currency),
    taxTotalMinor: minor(row.taxTotal, currency),
    roundingAdjustmentMinor: minor(row.roundingAdjustment, currency),
    discount: discountOf(row, currency),
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    items: row.items.map((item) => toItemDetail(item, currency)),
    taxes: summariseTaxes(row.items, currency),
    document: documentState(document),
    issuable: unissuableReasons.length === 0,
    unissuableReasons,
    creditNotes: row.creditNotes.map((note) => {
      const grandTotalMinor = minor(note.grandTotal, note.currency);
      const amountPaidMinor = minor(note.amountPaid, note.currency);
      return {
        invoiceId: note.id,
        invoiceNumber: note.invoiceNumber,
        status: note.status,
        currency: note.currency,
        grandTotalMinor,
        amountPaidMinor,
        /* Derived, never stored — a third number that can disagree with two. */
        balanceDueMinor: grandTotalMinor - amountPaidMinor,
        issuedAt: note.issuedAt?.toISOString() ?? null,
      };
    }),
    /*
     * ⚠️ SUMMED IN MINOR UNITS, NOT BY ADDING `Decimal`s AND CONVERTING ONCE. The
     *   conversion rounds, and rounding a sum is not the same as summing rounded
     *   parts — the difference is up to (n−1) minor units, which is exactly the
     *   argument `invoices.tax_total` makes about per-line rounding.
     */
    creditedTotalMinor: row.creditNotes.reduce(
      (sum, note) => sum + minor(note.grandTotal, note.currency),
      0
    ),
  };
}

function toItemDetail(item: DetailRow['items'][number], currency: string): InvoiceItemDetail {
  return {
    id: item.id,
    lineNumber: item.lineNumber,
    description: item.description,
    taxCategory: item.taxCategory,
    itemCode: item.itemCode,
    quantity: item.quantity.toString(),
    unitPriceMinor: minor(item.unitPrice, currency),
    grossMinor: minor(item.grossAmount, currency),
    discountMinor: minor(item.discountAmount, currency),
    apportionedDiscountMinor: minor(item.apportionedDiscount, currency),
    taxableMinor: minor(item.taxableAmount, currency),
    taxMinor: minor(item.taxAmount, currency),
    lineTotalMinor: minor(item.lineTotal, currency),
    taxTreatment: item.taxTreatment,
    taxReason: item.taxReason,
    taxes: item.taxes.map((tax) => ({
      name: tax.name,
      jurisdiction: tax.jurisdiction,
      rateBps: tax.rateBps,
      taxableMinor: minor(tax.taxableAmount, currency),
      amountMinor: minor(tax.taxAmount, currency),
    })),
  };
}

/**
 * The tax summary — the table a return is filed from.
 *
 * ⚠️ GROUPED ON NAME **AND** JURISDICTION **AND** RATE, THE SAME KEY THE PRINTED
 *   DOCUMENT USES. CGST 6% and SGST 6% are the same rate on the same base owed
 *   to two different governments; merging them into one 12% row states a tax
 *   nobody levies. Two rates under one component name is the same mistake in the
 *   other direction.
 *
 * ⚠️ AND IT IS SORTED. Postgres promises no row order without an ORDER BY, and a
 *   screen whose tax table came out in a different order from the PDF beside it
 *   is a document a patient can reasonably say is not the one they were given.
 */
function summariseTaxes(items: DetailRow['items'], currency: string): InvoiceTaxLine[] {
  const groups = new Map<string, InvoiceTaxLine>();

  for (const item of items) {
    for (const tax of item.taxes) {
      /*
       * The grouping key, built with JSON rather than by joining on a
       * separator, because every separator is a character a tax component's name
       * could legitimately contain — and two rows merged by a collision is a rate
       * nobody levies on the table a return is filed from.
       */
      const key = JSON.stringify([tax.name, tax.jurisdiction, tax.rateBps]);
      const existing = groups.get(key);
      if (existing) {
        existing.taxableMinor += minor(tax.taxableAmount, currency);
        existing.amountMinor += minor(tax.taxAmount, currency);
        continue;
      }
      groups.set(key, {
        name: tax.name,
        jurisdiction: tax.jurisdiction,
        rateBps: tax.rateBps,
        taxableMinor: minor(tax.taxableAmount, currency),
        amountMinor: minor(tax.taxAmount, currency),
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.jurisdiction ?? '').localeCompare(b.jurisdiction ?? '') ||
      a.rateBps - b.rateBps
  );
}

/** The header discount, as entered — what re-opens the draft on the screen. */
function discountOf(row: DetailRow, currency: string): DiscountInputRequest | null {
  if (!row.discountType) return null;

  return row.discountType === 'PERCENTAGE'
    ? { type: 'PERCENTAGE', bps: row.discountBps ?? 0 }
    : {
        type: 'FIXED',
        amountMinor: row.discountFixed ? minor(row.discountFixed, currency) : 0,
      };
}

function documentState(document: CurrentDocument | null): InvoiceDocumentState {
  if (!document) {
    return { status: 'NONE', documentId: null, fileName: null, sizeBytes: null, generatedAt: null };
  }

  return {
    /*
     * `DocumentStatus` in the schema is exactly the four values the contract
     * names beside `NONE`, which is this function's own answer for an invoice
     * that has no document row at all.
     */
    status: document.file.status,
    documentId: document.fileId,
    fileName: document.file.originalName,
    /* BigInt on the column; a JSON number here, and a PDF is never near 2^53. */
    sizeBytes: Number(document.file.sizeBytes),
    generatedAt: document.generatedAt.toISOString(),
  };
}
