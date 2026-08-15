'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { BranchSummary, InvoiceListItem } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import type { ApiPagination } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatClinicDate, formatCount } from '@/lib/format';
import {
  INVOICE_SOURCE_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONE,
  type InvoiceFilters,
} from '@/lib/invoice-filters';

/**
 * The clinic's ledger.
 *
 * ⚠️ THE FILTERS NAVIGATE RATHER THAN SETTING STATE, WHICH IS WHY THIS SCREEN
 *   HAS NO LOADING SPINNER OF ITS OWN. Every filter is an id, an enum or a date,
 *   so putting them in the URL costs no disclosure and buys a ledger that is
 *   linkable, refreshable and back-buttonable — "show me last Tuesday's drafts
 *   at the Whitefield branch" is a link somebody can send. The rows are then
 *   fetched by the Server Component, which is also what keeps the whole
 *   `InvoiceListItem[]` off the client bundle's data path.
 *
 * ⚠️ AND THE ONE FILTER THAT IS NOT HERE IS THE CUSTOMER'S NAME. See
 *   `lib/invoice-filters.ts`: a name in a query string is a name in
 *   `data_access_logs.route`, in the browser's history and in every proxy log in
 *   between. Find a person's bills from their record, where the lookup is a POST.
 *
 * Quiet and conventional on purpose (apps/web/AGENTS.md): this is a table
 * somebody reconciles a till from, not a place to spend boldness.
 */
export function InvoiceList({
  slug: _slug,
  branches,
  timezone,
  filters,
  invoices,
  pagination,
}: {
  slug: string;
  branches: BranchSummary[];
  /** The clinic's zone. One for the whole table — see the page for why. */
  timezone: string;
  filters: InvoiceFilters;
  invoices: InvoiceListItem[];
  pagination: ApiPagination;
}) {
  const router = useRouter();

  /*
   * The number box is the only filter that is typed rather than chosen, so it is
   * the only one held in state — the rest navigate the moment they change.
   *
   * It matches a FRAGMENT of the number, anywhere in it: `787` finds
   * `INV-2026-APP-MAIN-000787`, which is what somebody reading a number off a
   * printed bill types. It was an exact match until it turned out that answering
   * "no invoices" to a partial number is indistinguishable, on screen, from a
   * clinic that has billed nothing.
   */
  const [invoiceNumber, setInvoiceNumber] = useState(filters.invoiceNumber ?? '');

  /**
   * Navigate with one filter changed.
   *
   * ⚠️ CHANGING ANY FILTER RETURNS TO PAGE ONE. Page 3 of "all invoices" is not
   *   page 3 of "drafts at Whitefield", and keeping the number would land the
   *   cashier on an empty page that looks like an empty ledger.
   */
  function apply(changes: InvoiceFilters): void {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...filters, page: undefined, ...changes })) {
      if (typeof value === 'string' && value !== '') next.set(key, value);
    }
    const query = next.toString();
    router.push(query === '' ? '/invoices' : `/invoices?${query}`);
  }

  function goToPage(page: number): void {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (typeof value === 'string' && value !== '') next.set(key, value);
    }
    next.set('page', String(page));
    router.push(`/invoices?${next.toString()}`);
  }

  const filtered =
    Object.entries(filters).filter(([key, value]) => key !== 'page' && value).length > 0;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Invoices
          </h1>
          <p className="text-muted mt-1 text-sm">
            What this clinic has billed. Dates are the clinic&rsquo;s own.
          </p>
        </div>
        <p className="text-muted text-sm">
          {/* formatCount, never toLocaleString() — see lib/format.ts. */}
          {formatCount(pagination.total)} {pagination.total === 1 ? 'invoice' : 'invoices'}
        </p>
      </header>

      {/*
        ⚠️ A CONTROL STRIP, NOT A FORM CARD, AND THE DIFFERENCE IS WHAT THE
          SCREEN IS FOR. This is a ledger somebody reads; filtering it is an
          occasional act. The card of seven labelled fields took a fifth of the
          page before a single invoice appeared, which put the weight on the tool
          rather than on the thing being looked at.

          Two things bought the space back, and a third gave the strip its shape:

          - NO STACKED LABELS. Each select names itself through its empty option
            — "Status", "Branch" — which is a label doing its job from inside the
            control instead of from a line above it. `Field` omits the label
            element entirely when none is passed, so the accessible name comes
            from `aria-label`; the component was built for this.
          - NO CARD. A border and 16mm of padding around controls that sit
            directly above a bordered table drew a box inside a box.
          - TWO ROWS, DELIBERATELY. What is being filtered BY goes on the first
            line; the date range and the actions go on the second. See the row
            below for why that beats letting seven controls wrap wherever they
            land.
      */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ invoiceNumber });
        }}
      >
        <Input
          name="invoiceNumber"
          aria-label="Invoice number"
          /*
           * The hint became the placeholder. A permanent line of text under the
           * field said what the empty field can say itself — and now says less,
           * because a partial number works and there is no rule left to warn
           * about.
           */
          placeholder="Invoice number"
          value={invoiceNumber}
          onChange={(event) => setInvoiceNumber(event.target.value)}
          onBlur={() => {
            if ((filters.invoiceNumber ?? '') !== invoiceNumber) apply({ invoiceNumber });
          }}
          /*
           * ⚠️ THE SIZE GOES ON THE CONTROL, NOT ON `fieldClassName`, BECAUSE
           *   THERE IS NO FIELD. `withShell` returns the bare control when a
           *   caller passes no label, hint or error — deliberately, so an empty
           *   `flex flex-col` wrapper cannot break the layout it sits in — and
           *   `fieldClassName` goes with the wrapper it would have styled.
           *
           *   Which matters here more than it looks: `inputClass` and
           *   `selectClass` both begin `w-full`, so as direct flex items these
           *   controls each claimed the whole row and the strip stacked. `cn` is
           *   tailwind-merge, so a width passed here wins over that one.
           */
          className="font-mono w-auto min-w-[13rem] flex-1"
        />
        {/*
          ⚠️ THE EMPTY OPTION IS NAMED FOR THE FIELD AND STAYS SELECTABLE, WHICH
            IS WHY THIS IS NOT `Select`'s `placeholder` PROP. That renders
            `<option value="" disabled>` — correct for "choose one, no sensible
            default", and wrong for a filter: once a status was picked there
            would be no way back to all of them except the Clear button.

            So the empty row carries the field's name. Unfiltered, the closed
            control reads "Status" and works as the label these lost when the
            strip went horizontal; filtered, it reads the value; and choosing
            "Status" again is how you widen the list back out.
        */}
        <Select
          name="status"
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(event) => apply({ status: event.target.value })}
          /*
           * Muted while nothing is chosen, so a field naming itself looks like a
           * placeholder rather than a value somebody selected. `--color-muted`
           * is 4.6:1 on card, so it clears 4.5:1 as real text must.
           */
          className={cn('w-[10.5rem]', filters.status ? undefined : 'text-muted')}
          options={[
            { value: '', label: 'Status' },
            ...Object.entries(INVOICE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Select
          name="sourceType"
          aria-label="Billed for"
          value={filters.sourceType ?? ''}
          onChange={(event) => apply({ sourceType: event.target.value })}
          className={cn('w-[10.5rem]', filters.sourceType ? undefined : 'text-muted')}
          options={[
            { value: '', label: 'Billed for' },
            ...Object.entries(INVOICE_SOURCE_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Select
          name="branchId"
          aria-label="Branch"
          value={filters.branchId ?? ''}
          onChange={(event) => apply({ branchId: event.target.value })}
          className={cn('w-[12rem]', filters.branchId ? undefined : 'text-muted')}
          options={[
            { value: '', label: 'Branch' },
            ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
          ]}
        />

        {/*
          ⚠️ THE DATE RANGE IS A ROW OF ITS OWN, NOT A WRAPPED TAIL OF THE FIRST.
            `w-full` on a flex item cannot share a line, so this breaks cleanly
            below the filters at every width instead of riding up beside the
            branch select on a wide monitor and dropping down on a narrow one.

            It replaced a disclosure. A toggle saved a row while collapsed and
            cost a click every time somebody wanted a range — and it could hide a
            filter that was in force, which is how a person concludes the ledger
            is empty. Two honest rows beat one row and a secret.
        */}
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="text-muted text-sm" id="invoice-dates-label">
            Supplied
          </span>
          <Input
            name="from"
            aria-label="Supplied from"
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => apply({ from: event.target.value })}
            className="w-[10.5rem]"
          />
          <span className="text-muted text-sm" aria-hidden="true">
            to
          </span>
          <Input
            name="to"
            aria-label="Supplied to"
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => apply({ to: event.target.value })}
            className="w-[10.5rem]"
          />

          {/* The actions sit with the dates and push to the end of the row, so
              the first line stays nothing but the things being filtered by. */}
          <span className="ml-auto flex items-center gap-2">
            {/* Appears only when there is something to submit — the selects have
                already navigated, and the typed number applies on blur and on
                Enter. A button that is a no-op nine times out of ten teaches
                people to ignore it. */}
            {invoiceNumber !== (filters.invoiceNumber ?? '') ? (
              <Button type="submit" size="sm">
                Search
              </Button>
            ) : null}

            {filtered ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setInvoiceNumber('');
                  router.push('/invoices');
                }}
              >
                Clear
              </Button>
            ) : null}
          </span>
        </div>
      </form>

      {invoices.length === 0 ? (
        <EmptyLedger filtered={filtered} />
      ) : (
        <>
          {/*
           * The table scrolls sideways rather than the page doing it. Eight
           * columns do not fit a phone and dropping some of them would hide the
           * money on the device the cashier is most likely holding.
           */}
          <div className="border-rule bg-card overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <caption className="sr-only">
                Invoices, newest first. Each row links to the invoice.
              </caption>
              <thead>
                <tr className="border-rule text-muted border-b text-left text-xs tracking-wide uppercase">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Number
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Billed to
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    For
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Supplied
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Total
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Outstanding
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <InvoiceRow
                    key={invoice.id}
                    invoice={invoice}
                    branchName={branches.find((b) => b.id === invoice.branchId)?.name ?? '—'}
                    timezone={timezone}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <Pager pagination={pagination} onGo={goToPage} />
        </>
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  branchName,
  timezone,
}: {
  invoice: InvoiceListItem;
  branchName: string;
  timezone: string;
}) {
  const settled = invoice.balanceDueMinor === 0;

  /*
   * ⚠️ THE WHOLE ROW OPENS THE INVOICE, AND IT IS STILL ONE REAL LINK.
   *   `relative` on the row plus the stretched pseudo-element on the anchor
   *   below is what widens the hit area. The alternative — an `onClick` on the
   *   `<tr>` — would give a cashier a row that cannot be tabbed to, cannot be
   *   opened in a new tab, shows no URL on hover, and is invisible to a screen
   *   reader as anything but text. This way there is exactly one link, announced
   *   once, with the invoice number as its name.
   *
   *   `isolate` keeps the stretched layer in this row's own stacking context, so
   *   it cannot reach over the row above or below.
   *
   *   It degrades safely: if a browser ever declines to position a table row,
   *   the pseudo-element collapses onto the anchor and the number stays
   *   clickable, which is exactly the behaviour this replaced.
   */
  return (
    <tr className="border-rule hover:bg-drape-tint/30 relative isolate border-b last:border-b-0">
      <td className="px-4 py-3">
        {/*
         * The link sits on the cell that identifies the invoice. A draft has no
         * number by construction, so it needs a word of its own rather than an
         * empty target — and "Draft" here is the id, not the status, which is
         * why the status column still says it too.
         */}
        <Link
          href={`/invoices/${invoice.id}`}
          className="text-drape font-mono text-[0.8125rem] hover:underline focus-visible:underline
                     after:absolute after:inset-0 after:content-['']"
        >
          {invoice.invoiceNumber ?? 'Draft'}
        </Link>
      </td>
      <td className="text-ink px-4 py-3">{invoice.customerName}</td>
      <td className="text-muted px-4 py-3">{INVOICE_SOURCE_LABELS[invoice.sourceType]}</td>
      <td className="text-muted px-4 py-3">{branchName}</td>
      <td className="text-muted px-4 py-3">
        {/* formatClinicDate, never toLocaleDateString — see lib/format.ts. */}
        {formatClinicDate(invoice.suppliedAt, timezone)}
      </td>
      <td className="px-4 py-3">
        <StatusPill status={invoice.status} />
      </td>
      {/*
       * ⚠️ MONO IS STEPPED DOWN A NOTCH FROM THE TABLE'S OWN `text-sm`, and
       *   `tabular-nums` is not free. Plex Mono advances 0.6em against Plex
       *   Sans's ~0.5, so a figure set at the same nominal size as the prose
       *   beside it READS a size larger — which is why every other mono
       *   identifier in the app (the UHID on the day board, the appointment
       *   number, the ledger's references) is a step smaller than its
       *   neighbours. And `.font-mono` does NOT carry tabular figures: globals.css
       *   sets `font-variant-numeric` on `code`/`kbd`/`samp`/`pre` only, so a
       *   money column has to ask for it or the decimal points drift.
       */}
      <td className="text-ink px-4 py-3 text-right font-mono text-[0.8125rem] tabular-nums">
        {formatMoney(money(invoice.grandTotalMinor, invoice.currency))}
      </td>
      <td
        className={cn(
          'px-4 py-3 text-right font-mono text-[0.8125rem] tabular-nums',
          settled ? 'text-muted' : 'text-ink'
        )}
      >
        {/*
         * ⚠️ A SETTLED BILL SAYS "Settled", NOT A ZERO, AND THE TWO ARE NOT THE
         *   SAME CLAIM. There are no payments yet, so `amountPaid` is always
         *   zero and this column is always the grand total — which makes the
         *   day the first payment lands the day this cell has to be honest
         *   about the difference between "nothing left to pay" and "nothing was
         *   ever charged". A cancelled draft is the second, and it prints a
         *   dash.
         */}
        {invoice.status === 'CANCELLED' || invoice.status === 'VOID' ? (
          <span className="text-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Nothing owed; this invoice was reversed</span>
          </span>
        ) : settled ? (
          <span className="text-muted">Settled</span>
        ) : (
          formatMoney(money(invoice.balanceDueMinor, invoice.currency))
        )}
      </td>
    </tr>
  );
}

export function StatusPill({ status }: { status: InvoiceListItem['status'] }) {
  return (
    <span
      className={cn(
        'inline-block rounded-sm border px-2 py-0.5 text-xs font-medium',
        INVOICE_STATUS_TONE[status]
      )}
    >
      {INVOICE_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Nothing to show, and the two reasons are different screens.
 *
 * An empty ledger is an invitation to act; an empty FILTER is a dead end with a
 * way out. Collapsing them would tell a clinic with nine hundred invoices that
 * it has never billed anybody.
 */
function EmptyLedger({ filtered }: { filtered: boolean }) {
  return (
    <div className="border-rule bg-card rounded-lg border border-dashed p-10 text-center">
      <p className="text-ink font-medium">
        {filtered ? 'No invoice matches these filters.' : 'Nothing has been billed yet.'}
      </p>
      <p className="text-muted mx-auto mt-2 max-w-prose text-sm">
        {filtered
          ? 'Widen the dates, or clear the filters to see the whole ledger.'
          : 'Bills raised from a consultation appear here. Open a visit on the day board and raise the invoice from there.'}
      </p>
      <div className="mt-6">
        {filtered ? null : (
          <Link
            href="/appointments"
            className="text-drape text-sm font-medium hover:underline focus-visible:underline"
          >
            Go to the day board
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * ⚠️ OFFSET PAGES, WHICH IS WHAT THE API OFFERS AND IS FINE AT A CLINIC'S
 *   VOLUME. It is wrong at the depth a year of invoices reaches, and the
 *   `(createdAt, id)` ordering the API already uses is the keyset a cursor would
 *   need. Recorded as a known issue rather than worked around here, because a
 *   client-side workaround for a server-side pagination shape is two problems.
 */
function Pager({ pagination, onGo }: { pagination: ApiPagination; onGo: (page: number) => void }) {
  const { page, totalPages } = pagination;
  if (totalPages <= 1) return null;

  return (
    <nav className="flex items-center justify-between gap-4" aria-label="Invoice pages">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onGo(page - 1)}>
        Previous
      </Button>
      <p className="text-muted text-sm" aria-live="polite">
        Page {formatCount(page)} of {formatCount(totalPages)}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}
