import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PERMISSIONS } from '@rcln/permissions';
import { branchesInScope, getSession, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { InvoiceDocumentFrame } from '@/components/tenant/invoice-document-frame';
import { InvoiceDetailScreen } from '@/components/tenant/invoice-detail';
import { loadInvoice } from '../actions';

export const metadata: Metadata = {
  /**
   * ⚠️ NOT THE INVOICE NUMBER AND CERTAINLY NOT THE PATIENT. `generateMetadata`
   *   could put the number in the tab, and a number is not PHI on its own — but
   *   it is one lookup away from being, it lands in browser history, and it
   *   would cost a second read of the invoice to produce. The document itself
   *   titles its own iframe with the number, which is where a reader needs it.
   */
  title: 'Invoice',
};

/**
 * <slug>.rcln.com/invoices/<id>
 *
 * ⚠️ THIS READ IS A DISCLOSURE AND IT IS LOGGED. Unlike the ledger, one invoice
 *   is the bill itself — every line, the patient's name, their address — so
 *   `getInvoice` writes a `data_access_logs` row for it. Opening this screen is
 *   an act that appears in the trail, which is the correct behaviour and worth
 *   knowing before adding any polling to it.
 *
 * ⚠️ AND THE DOCUMENT IS NOT READ HERE. The detail is what the SCREEN needs —
 *   states, ids, what may still be edited. What the DOCUMENT says is a second
 *   read, made by the `preview` Route Handler the frame loads, from the same
 *   loader the worker renders the stored PDF from. That shared loader is the whole
 *   reason the preview and the patient's copy cannot drift, so the preview is
 *   never derived from the detail response — and it is fetched by the frame rather
 *   than by this page because `renderInvoiceHtml` cannot run in a Server
 *   Component. See `invoice-document-frame.tsx`.
 */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ slug: string; invoiceId: string }>;
}) {
  const { slug, invoiceId } = await params;

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.INVOICE_READ)) {
    return (
      <Alert tone="error">
        You do not have access to invoices here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const [invoice, branches] = await Promise.all([
    loadInvoice(slug, invoiceId),
    branchesInScope(slug),
  ]);

  /*
   * ⚠️ 404, WHATEVER THE REASON, WHICH IS WHAT THE API ALREADY ANSWERS. An
   *   invoice this caller may not see comes back as a 404 rather than a 403,
   *   because a 403 on an invoice id confirms the invoice exists and confirms
   *   what kind it is — "you may not read pharmacy invoices" plus a 403 tells
   *   the reader this id is a pharmacy invoice. There is one shape of "no" on
   *   this surface and this page must not invent a second.
   */
  if (invoice === null) notFound();

  const branch = branches.find((b) => b.id === invoice.branchId);
  /*
   * The BRANCH's zone, not the organization's — this screen is one invoice at
   * one place, and the date on it is the date that branch supplied on. The
   * ledger, which can span zones, states the clinic's default instead. A branch
   * outside the caller's scope (an org-wide accountant reading another site's
   * bill) falls back to the clinic default rather than to the container's UTC.
   */
  const timezone = branch?.timezone ?? (await timezoneOf(slug));

  return (
    <InvoiceDetailScreen
      slug={slug}
      invoice={invoice}
      branchName={branch?.name ?? null}
      timezone={timezone}
      /*
       * ⚠️ THE FRAME IS PASSED IN AS AN ELEMENT, NOT BUILT BY THE CLIENT SCREEN.
       *   It is a Server Component and the screen around it is a Client one, so
       *   it has to arrive as a child. The frame loads its own content from the
       *   `preview` handler beside this page — see `invoice-document-frame.tsx`
       *   for why the rendering moved out of the React tree entirely.
       *
       * The URL is tenant-relative: `proxy.ts` puts the `/t/<slug>` segment in on
       * the way through, and writing it here would have it written twice.
       */
      document={
        <InvoiceDocumentFrame
          src={`/invoices/${invoiceId}/preview`}
          invoiceNumber={invoice.invoiceNumber}
        />
      }
      canEdit={permissions.includes(PERMISSIONS.INVOICE_UPDATE)}
      /*
       * ⚠️ ISSUING IS `billing.invoice.create` AND NOT A CODE OF ITS OWN.
       *   Raising the bill and handing it over are one act at a counter — a
       *   receptionist who could open a draft and never issue it would have half
       *   a job. The API decided this; the screen reads the same code so the two
       *   cannot drift.
       */
      canIssue={permissions.includes(PERMISSIONS.INVOICE_CREATE)}
      canCancel={permissions.includes(PERMISSIONS.INVOICE_CANCEL)}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
      /*
       * ⚠️ ITS OWN CODE, NOT `INVOICE_CANCEL`. Voiding reverses a document in
       *   full and keeps its number; a credit note reverses part of one and
       *   issues a new document with its own statutory serial. A clinic that
       *   separates the two is exactly the clinic where assuming one implies the
       *   other offers the wrong control.
       */
      canCredit={permissions.includes(PERMISSIONS.CREDIT_NOTE_ISSUE)}
    />
  );
}
