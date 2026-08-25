'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import { formatMoney, money } from '@rcln/payments';
import type { ReportCurrencyTotal } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import type { ReportColumn, ReportSpec } from '@/lib/report-specs';

/**
 * One report: its filters, its totals, and its rows.
 *
 * ⚠️ THE FILTERS DRIVE THE URL AND THE URL DRIVES THE FETCH. Nothing here
 *   filters an in-memory array — the rows are one server-rendered page of a
 *   query the API ran in SQL, the same shape as every other list in this
 *   application. It is also what makes a report LINKABLE: a URL is the only
 *   thing somebody can paste into a message to a colleague.
 *
 * ⚠️ THE TOTALS STRIP IS ONE FIGURE PER CURRENCY, AND THE UNVALUED QUANTITY SITS
 *   IN IT RATHER THAN UNDER IT. This is the piece of this screen worth
 *   defending. Every reporting tool prints one big number; this domain cannot
 *   honestly produce one — a product can carry two cost averages in two
 *   currencies, and stock nobody has costed is quantity the clinic HOLDS and
 *   cannot value. Folding either into a single total would produce a number in
 *   no currency, or a number that quietly counted uncosted stock as free. So the
 *   strip carries a cell per currency, and the unvalued quantity is right there
 *   beside the money in `signal` — because it is a thing to go and fix, not a
 *   footnote.
 *
 * ⚠️ AND MONEY IS RENDERED THROUGH `formatMoney`, NEVER `/ 100`. The API sends
 *   integer minor units; dividing by a hundred is correct in India and wrong in
 *   Japan, and this programme has already shipped rule packs for six countries.
 *
 * NO PHI. No field on any of the nine reports names a patient.
 */
interface Props {
  reportKey: string;
  spec: ReportSpec;
  rows: Record<string, unknown>[];
  totals: ReportCurrencyTotal[];
  page: number;
  limit: number;
  total: number;
  generatedAt: string;
  /** Non-null on a dated report; the window it was actually run over. */
  window: { from: string; to: string } | null;
  canExport: boolean;
  /** The `?format=csv` URL, already carrying the current filters. */
  exportHref: string;
  extraNote?: string | undefined;
}

function cellText(column: ReportColumn, row: Record<string, unknown>): string {
  const value = row[column.field];
  if (value === null || value === undefined || value === '') return '—';

  switch (column.kind) {
    case 'money': {
      const currency = typeof row['currency'] === 'string' ? row['currency'] : null;
      /*
       * ⚠️ A FIGURE WITH NO CURRENCY IS NOT RENDERED AS A BARE NUMBER. The row
       *   reached the screen without one because nothing has costed the stock;
       *   printing `240000` beside `₹2,400.00` on the row above would be read as
       *   a much larger amount.
       */
      if (currency === null) return 'not valued';
      return formatMoney(money(Number(value), currency));
    }
    case 'ratio': {
      const asNumber = Number(value);
      return Number.isFinite(asNumber) ? `${(asNumber * 100).toFixed(1)}%` : '—';
    }
    case 'datetime':
      return new Date(String(value)).toISOString().slice(0, 10);
    case 'tag':
      return String(value).toLowerCase().replaceAll('_', ' ');
    case 'qty':
    case 'int':
    case 'date':
    case 'mono':
    case 'text':
    default:
      return String(value);
  }
}

const NUMERIC = new Set<ReportColumn['kind']>(['money', 'qty', 'int', 'ratio']);

function cellClass(column: ReportColumn): string {
  if (NUMERIC.has(column.kind)) return 'px-3 py-2.5 text-right font-mono text-[0.8125rem]';
  if (column.kind === 'mono' || column.kind === 'date' || column.kind === 'datetime') {
    return 'text-muted px-3 py-2.5 font-mono text-[0.75rem] whitespace-nowrap';
  }
  if (column.kind === 'tag') {
    return 'text-muted px-3 py-2.5 text-[0.75rem] whitespace-nowrap';
  }
  return 'text-ink px-3 py-2.5 text-[0.8125rem]';
}

export function ReportView({
  reportKey,
  spec,
  rows,
  totals,
  page,
  limit,
  total,
  generatedAt,
  window: reportWindow,
  canExport,
  exportHref,
  extraNote,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(searchParams.get('from') ?? reportWindow?.from ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? reportWindow?.to ?? '');

  const setFilter = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      // Changing a filter while on page 7 lands on page 7 of a shorter set, and
      // the screen shows an empty table for a filter that matched plenty.
      next.delete('page');
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const goToPage = useCallback(
    (target: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (target <= 1) next.delete('page');
      else next.set('page', String(target));
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const firstRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const lastRow = Math.min(page * limit, total);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/reports" className="text-muted hover:text-ink text-[0.8125rem]">
            ← All reports
          </Link>
          <h1 className="font-display text-ink mt-1 text-[1.75rem] leading-tight tracking-tight">
            {spec.title}
          </h1>
          <p className="text-muted mt-1 max-w-2xl text-[0.875rem]">{spec.blurb}</p>
        </div>
        {canExport ? (
          /*
            ⚠️ A LINK AND NOT A BUTTON, because it is a navigation to a file the
               server produces. The server sends `Content-Disposition:
               attachment`, so the browser downloads rather than renders — and
               the same URL pasted anywhere reproduces the same file.
          */
          <a
            href={exportHref}
            className="border-rule text-ink hover:border-drape inline-flex items-center justify-center rounded-md border px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Download CSV
          </a>
        ) : null}
      </header>

      {spec.caveat ? (
        <p className="border-rule text-muted border-l-2 py-1 pl-4 text-[0.8125rem]">
          {spec.caveat}
        </p>
      ) : null}
      {extraNote ? (
        <p className="border-signal/40 text-ink border-l-2 py-1 pl-4 text-[0.8125rem]">
          {extraNote}
        </p>
      ) : null}

      {spec.dated || spec.filters.length > 0 ? (
        <form
          className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFilter({ from, to });
          }}
        >
          {spec.dated ? (
            <>
              <Input
                label="From"
                name="from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <Input
                label="To"
                name="to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </>
          ) : null}

          {spec.filters.map((filter) =>
            filter.kind === 'select' ? (
              <Select
                key={filter.name}
                label={filter.label}
                name={filter.name}
                value={searchParams.get(filter.name) ?? filter.options?.[0]?.value ?? ''}
                options={[...(filter.options ?? [])]}
                onChange={(event) => setFilter({ [filter.name]: event.target.value })}
              />
            ) : (
              <Input
                key={filter.name}
                label={filter.label}
                name={filter.name}
                type="number"
                placeholder={filter.placeholder ?? ''}
                defaultValue={searchParams.get(filter.name) ?? ''}
                onBlur={(event) => setFilter({ [filter.name]: event.target.value })}
              />
            )
          )}

          {spec.dated ? (
            <div className="flex items-end">
              <Button type="submit" variant="secondary">
                Run
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}

      {/*
        THE TOTALS STRIP. One cell per currency — see the component header for
        why this cannot honestly be one number.
      */}
      {totals.length > 0 ? (
        <section aria-label="Totals" className="border-rule bg-card rounded-md border">
          <ul className="divide-rule flex flex-wrap divide-x">
            {totals.map((entry) => (
              <li key={entry.currency} className="min-w-[14rem] flex-1 px-5 py-4">
                <p className="text-muted text-[0.75rem] tracking-wide uppercase">
                  {entry.currency === 'XXX' ? 'Not valued' : entry.currency}
                </p>
                <p className="text-ink mt-1 font-mono text-[1.25rem]">
                  {entry.currency === 'XXX'
                    ? '—'
                    : formatMoney(money(entry.valueMinor, entry.currency))}
                </p>
                <p className="text-muted mt-1 font-mono text-[0.75rem]">
                  {entry.quantityBase} across {entry.lineCount} rows
                </p>
                {Number(entry.unvaluedQuantityBase) !== 0 ? (
                  <p className="text-signal mt-1 font-mono text-[0.75rem]">
                    {entry.unvaluedQuantityBase} held with no cost recorded
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {total === 0
            ? 'Nothing to report for these filters.'
            : `Showing ${firstRow}–${lastRow} of ${total} · read at ${generatedAt.slice(11, 16)} UTC on ${generatedAt.slice(0, 10)}`}
        </p>

        {rows.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing matches these filters.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {spec.dated
                ? 'Try a wider window, or a different branch.'
                : 'Try a different branch, or clear a filter.'}
            </p>
          </div>
        ) : (
          /*
            ⚠️ THE TABLE SCROLLS INSIDE ITS OWN BOX AND THE PAGE NEVER DOES. Some
               of these reports carry a dozen numeric columns, and a page that
               scrolls sideways loses the filters and the totals off the left
               edge — which are the two things a reader needs while reading a
               wide row.
          */
          <div className="border-rule bg-card overflow-x-auto rounded-md border">
            <table className="w-full min-w-max border-collapse text-left">
              <caption className="sr-only">
                {spec.title}
                {reportWindow ? `, ${reportWindow.from} to ${reportWindow.to}` : ''}
              </caption>
              <thead>
                <tr className="border-rule border-b">
                  {spec.columns.map((column) => (
                    <th
                      key={column.field}
                      scope="col"
                      className={`text-muted px-3 py-2.5 text-[0.75rem] font-medium tracking-wide uppercase ${
                        NUMERIC.has(column.kind) ? 'text-right' : ''
                      }`}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-rule divide-y">
                {rows.map((row, index) => (
                  <tr key={`${reportKey}-${index}`}>
                    {spec.columns.map((column) => (
                      <td key={column.field} className={cellClass(column)}>
                        {cellText(column, row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <nav aria-label="Pages" className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-muted text-[0.8125rem]">
              Page {page} of {totalPages}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
