'use server';

import { revalidatePath } from 'next/cache';
import {
  createCreditNoteRequest,
  updateInvoiceRequest,
  type InvoiceDetail,
  type InvoiceListItem,
  type UpdateInvoiceRequest,
} from '@rcln/contracts';
import { api, fieldErrorsFrom, type ApiPagination } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The clinic's own ledger — the patient-facing invoice, not the subscription.
 *
 * ⚠️ THE FILTERS ARE URL PARAMETERS AND THERE IS NO SEARCH BOX, WHICH IS THE
 *   SAME RULE THE API STATES AND FOR THE SAME REASON. A number, a status, a
 *   source, a branch and a date range are all ids, enums and dates: none of
 *   them names anybody, so the list is linkable, refreshable and safe to land
 *   in a proxy log. The obvious missing filter is the customer's name, and
 *   `listInvoicesQuery` deliberately has no `?q=` — a name in a query string is
 *   a name in `data_access_logs.route` and in the browser's history. An invoice
 *   is found by its number or by its patient's record, and the patient's record
 *   is reached through the lookup on /patients, which is a POST for exactly
 *   this reason.
 *
 * `slug` is bound on the server before any of these reach the browser, so a
 * client cannot re-point one at another clinic.
 */

/** The outcome of anything that changes an invoice. One shape for every write. */
export type InvoiceFormState = {
  status: 'idle' | 'error' | 'done';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** The number the document was given, once issuing has given it one. */
  invoiceNumber?: string;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface InvoicePage {
  invoices: InvoiceListItem[];
  pagination: ApiPagination;
}

/**
 * One page of the ledger.
 *
 * ⚠️ THE COUNTS COME BACK IN `meta`, NOT IN `data`. `GET /v1/invoices` answers
 *   through `sendPaginated`, which is a different envelope from the list
 *   endpoints this app already consumes — see `ApiPagination` in lib/api.ts. A
 *   caller that reads only `data` gets the rows and a pager that always says
 *   page 1 of 1.
 *
 * A refused or unreachable read returns null and the page renders that as a
 * sentence, exactly as the day board does. The list is not a disclosure event —
 * the API writes no `data_access_logs` row for it unless it was asked about one
 * patient — so there is nothing here that a failed load leaves half-written.
 */
export async function loadInvoices(
  slug: string,
  query: Record<string, string>
): Promise<InvoicePage | null> {
  const search = new URLSearchParams(query).toString();
  const result = await api<InvoiceListItem[]>(`/api/v1/invoices${search ? `?${search}` : ''}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) return null;

  return {
    invoices: result.data,
    pagination: result.meta ?? {
      page: 1,
      limit: result.data.length,
      total: result.data.length,
      totalPages: 1,
    },
  };
}

/** One invoice, with its lines, its tax summary and the state of its PDF. */
export async function loadInvoice(slug: string, invoiceId: string): Promise<InvoiceDetail | null> {
  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

/*
 * ⚠️ THERE IS NO `loadInvoiceDocument` HERE, AND THERE WAS ONE. The document data
 *   is fetched by the `preview` Route Handler beside the invoice page, which is
 *   also where it is rendered — `renderInvoiceHtml` reaches `react-dom/server`,
 *   which Next refuses in a Server Component's module graph, so the render (and
 *   with it the fetch) cannot live in the React tree at all. A second server
 *   action returning the same data would be a read nobody makes.
 */

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Replace a draft.
 *
 * ⚠️ A WHOLE-DOCUMENT PUT, BECAUSE PRICING IS A PROPERTY OF THE INVOICE AND NOT
 *   OF A LINE. A whole-bill discount is apportioned across every line, so adding
 *   one line re-prices all of them — an endpoint that edited a single line would
 *   have to re-price the document anyway. The editor holds the whole thing and
 *   sends the whole thing, and the priced answer that comes back is what the
 *   screen then shows.
 *
 * The branch, the source and the appointment cannot move: they are in the number
 * series the invoice will draw from. `updateInvoiceRequest` omits them, so a
 * caller cannot send them even by mistake.
 */
export async function saveDraft(
  slug: string,
  invoiceId: string,
  input: UpdateInvoiceRequest
): Promise<InvoiceFormState> {
  const parsed = updateInvoiceRequest.safeParse(input);

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`, {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      /*
       * The API's own sentence. A 409 here is an invoice that stopped being a
       * draft between this screen being drawn and Save being pressed — somebody
       * else issued it — and saying so is more use than anything this layer
       * could invent.
       */
      message: result.message ?? 'The invoice could not be saved.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/invoices/${invoiceId}`);
  revalidatePath(`/t/${slug}/invoices`);
  return { status: 'done' };
}

/**
 * Issue it.
 *
 * ⚠️ THIS IS THE IRREVERSIBLE ONE, AND IT IS WHERE THE NUMBER COMES FROM. An
 *   issued invoice's financials are immutable at the DATABASE, not merely in the
 *   service, so there is no editing it afterwards and no un-issuing it — the
 *   only way back is a void, which leaves both documents standing. The screen
 *   asks before calling this.
 *
 * `issuedOn` is left to the server, which reads today in the branch's zone. A
 * clinic entering yesterday's till can date the document through the API; there
 * is no control for it here yet, because getting it wrong silently files an
 * invoice into the wrong return period.
 */
export async function issueInvoice(slug: string, invoiceId: string): Promise<InvoiceFormState> {
  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}/issue`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: {},
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      /*
       * The API's sentence again. The interesting refusal here is an unrated
       * line — the clinic never gave that tax category a rate, so the engine
       * charged nothing rather than guessing, and a bill that charges no tax
       * because nobody configured one must not be handed to a patient.
       */
      message: result.message ?? 'The invoice could not be issued.',
    };
  }

  revalidatePath(`/t/${slug}/invoices/${invoiceId}`);
  revalidatePath(`/t/${slug}/invoices`);
  revalidatePath(`/t/${slug}/appointments`);
  return {
    status: 'done',
    ...(result.data.invoiceNumber ? { invoiceNumber: result.data.invoiceNumber } : {}),
  };
}

/**
 * Abandon a draft.
 *
 * The reason is optional here and required on a void, and that difference is the
 * whole difference between the two: a cancelled draft explains itself, because
 * nobody outside the clinic ever saw it.
 */
export async function cancelInvoice(
  slug: string,
  invoiceId: string,
  reason: string
): Promise<InvoiceFormState> {
  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}/cancel`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: reason.trim() === '' ? {} : { reason: reason.trim() },
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The draft could not be cancelled.' };
  }

  revalidatePath(`/t/${slug}/invoices/${invoiceId}`);
  revalidatePath(`/t/${slug}/invoices`);
  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'done' };
}

/**
 * Reverse an issued invoice.
 *
 * ⚠️ THE REASON IS REQUIRED, AND THE FORM ENFORCES IT BEFORE THE API DOES ONLY
 *   SO THE MESSAGE IS ABOUT THE FIELD. A void reverses a document the patient is
 *   holding a copy of; the number survives, the row survives, and the reason is
 *   the only account of why the two disagree. There is no credit note yet.
 */
export async function voidInvoice(
  slug: string,
  invoiceId: string,
  reason: string
): Promise<InvoiceFormState> {
  if (reason.trim() === '') {
    return {
      status: 'error',
      message: 'Say why this invoice is being voided.',
      fieldErrors: { reason: ['Say why this invoice is being voided.'] },
    };
  }

  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}/void`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { reason: reason.trim() },
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The invoice could not be voided.' };
  }

  revalidatePath(`/t/${slug}/invoices/${invoiceId}`);
  revalidatePath(`/t/${slug}/invoices`);
  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'done' };
}

/**
 * Raise a credit note against an issued invoice (PI-8).
 *
 * ⚠️ THE LINES COME FROM THE SCREEN AND ARE CITED BY ID, NEVER FREE-TYPED. A
 *   credit note whose lines the caller composed could reverse a description and
 *   a price that never appeared on the document it credits — which is how a
 *   correction becomes an unexplainable second document rather than a reversal
 *   of the first. The server re-checks every id against the invoice and refuses
 *   a quantity larger than the line was billed at.
 *
 * ⚠️ AN EMPTY LIST IS THE CONTRACT'S "CREDIT THE WHOLE THING", not an omission —
 *   see `createCreditNoteRequest`. The screen always sends explicit lines, so
 *   this only reaches the empty path from a caller that wants everything.
 *
 * ⚠️ AND IT EDITS NOTHING. The original invoice stands exactly as the patient
 *   received it; the note is a new document with its own number. That is the
 *   whole reason the lifecycle guard exists and the reason a credit note is not
 *   a status change.
 */
export async function creditInvoice(
  slug: string,
  invoiceId: string,
  reason: string,
  lines: { invoiceItemId: string; quantity?: string | undefined }[] = []
): Promise<InvoiceFormState> {
  if (reason.trim().length === 0) {
    return {
      status: 'error',
      message: 'Say why this invoice is being credited.',
      fieldErrors: { reason: ['Say why this invoice is being credited.'] },
    };
  }

  /*
   * Parsed against the contract here rather than trusted, because the quantity
   * arrives as whatever somebody typed into a text box. A blank one means "all
   * of this line" and is dropped rather than sent as an empty string, which the
   * decimal pattern would reject with a message about a regular expression.
   */
  const parsed = createCreditNoteRequest.safeParse({
    reason: reason.trim(),
    lines: lines.map((line) => ({
      invoiceItemId: line.invoiceItemId,
      ...(line.quantity !== undefined && line.quantity.trim() !== ''
        ? { quantity: line.quantity.trim() }
        : {}),
    })),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the quantities — each must be a positive number with at most 3 decimals.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}/credit-notes`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.message ?? 'The credit note could not be raised.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/invoices/${invoiceId}`);
  revalidatePath(`/t/${slug}/invoices`);
  revalidatePath(`/t/${slug}/charges`);
  return { status: 'done' };
}
