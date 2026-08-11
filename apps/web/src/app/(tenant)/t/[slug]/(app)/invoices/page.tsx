import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import { branchesInScope, getSession, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { InvoiceList } from '@/components/tenant/invoice-list';
import { INVOICE_FILTER_KEYS, type InvoiceFilters } from '@/lib/invoice-filters';
import { loadInvoices } from './actions';

export const metadata: Metadata = {
  /**
   * ⚠️ NEVER A CUSTOMER'S NAME. An invoice list is a PHI surface — every row
   *   carries the name of the person billed — and a tab title is read over a
   *   shoulder and saved into browser history. Same rule as the patient chart.
   */
  title: 'Invoices',
};

/**
 * <slug>.rcln.com/invoices?status=DRAFT&from=2026-08-01
 *
 * ⚠️ THIS PAGE DOES LOAD ITS ROWS, UNLIKE /patients, AND THE API AGREES THAT IT
 *   SHOULD. A patient list is a lookup: rendering twenty records on navigation
 *   discloses twenty people to answer a question nobody asked, and every one of
 *   those reads writes a `data_access_logs` row. An invoice list is a LEDGER —
 *   it is the screen a cashier reconciles the day from — and `listInvoices`
 *   writes a disclosure row only when the caller asked about ONE patient. The
 *   two screens differ because the two reads differ.
 *
 * The filters live in the URL so the ledger is linkable and refreshable. Every
 * one of them is an id, an enum or a date; there is no name among them, which is
 * what makes that safe. See `listInvoicesQuery` for the same rule at the API.
 */
export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const raw = await searchParams;

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.INVOICE_READ)) {
    return (
      <Alert tone="error">
        You do not have access to invoices here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  /*
   * Only the parameters the API knows about, and only when they are a single
   * string. `?status=DRAFT&status=ISSUED` arrives as an array and would
   * stringify to `DRAFT,ISSUED`, which the enum refuses — a 400 on a URL
   * somebody hand-edited helps nobody, so an unusable value is dropped and the
   * filter reads as "any", exactly as the day board treats a bad `?date=`.
   */
  const filters: InvoiceFilters = {};
  for (const key of INVOICE_FILTER_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value !== '') filters[key] = value;
  }

  /*
   * ⚠️ FROM THE SESSION, NOT `GET /branches`. That endpoint is behind
   *   `branch.read`, which a cashier does not hold — calling it here would 403
   *   and leave the branch filter empty on the screen whose whole job is
   *   reconciling one branch's till. `branchesInScope` is the authoritative
   *   statement of what a caller may work in and needs no permission.
   */
  const [branches, page] = await Promise.all([
    branchesInScope(slug),
    loadInvoices(slug, { ...filters, limit: '20' }),
  ]);

  if (page === null) {
    return (
      <Alert tone="error">
        The invoice list could not be loaded. Refresh the page, and tell an administrator if it
        keeps happening.
      </Alert>
    );
  }

  /*
   * ⚠️ ONE ZONE FOR THE WHOLE LEDGER, AND IT IS THE ORGANIZATION'S DEFAULT
   *   RATHER THAN A ROW'S. A list can span branches in two zones and there is no
   *   single local midnight across them — the API says the same thing about its
   *   own date filter. What a date column here means is therefore "the clinic's
   *   day", stated once at the top of the table rather than implied per row. The
   *   detail screen, which is about one invoice at one branch, uses that
   *   branch's zone.
   */
  const timezone = await timezoneOf(slug);

  return (
    <InvoiceList
      slug={slug}
      branches={branches}
      timezone={timezone}
      filters={filters}
      invoices={page.invoices}
      pagination={page.pagination}
    />
  );
}
