'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import type { BatchListResponse } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { StockNav } from '@/components/tenant/stock-nav';
import { BATCH_STATUS_LABEL, BucketBar, readable } from '@/components/tenant/stock-status';

/**
 * Every lot, and what is left of each.
 *
 * ⚠️ SORTED BY EXPIRY, SOONEST FIRST, AND THAT IS THE DEFAULT ON PURPOSE. FEFO
 *   is how this stock should leave the building, so the order the screen shows
 *   is the order the shelf should be worked. A list sorted by name would be
 *   alphabetical and useless.
 *
 * ⚠️ THE FILTERS DRIVE THE URL AND THE URL DRIVES THE FETCH. Nothing here
 *   filters an in-memory array — the rows are one server-rendered page of a
 *   query the API ran in SQL. Same shape as the catalogue, for the same reason.
 *
 * NO PHI.
 */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'QUARANTINED', label: 'On hold' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'RECALLED', label: 'Recalled' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'DISPOSED', label: 'Disposed' },
];

interface Props {
  batches: BatchListResponse['batches'];
  meta: BatchListResponse['meta'];
  canManage: boolean;
}

export function LotList({ batches, meta, canManage }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [term, setTerm] = useState(searchParams.get('q') ?? '');

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
    (page: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (page <= 1) next.delete('page');
      else next.set('page', String(page));
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Lots
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Every batch received, soonest to expire first.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/stock/lots/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Record a lot
          </Link>
        ) : null}
      </header>

      <StockNav />

      <form
        className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ q: term.trim() });
        }}
      >
        <div className="sm:col-span-2">
          <Input
            label="Search"
            name="q"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Lot number or product"
          />
        </div>
        <Select
          label="Status"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <div className="flex items-end">
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'No lots match these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {batches.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">
              {searchParams.size === 0
                ? 'No lots have been recorded.'
                : 'Nothing matches these filters.'}
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {searchParams.size === 0
                ? 'Record one when a delivery of a batch-tracked product arrives.'
                : 'Try a broader search, or clear a filter.'}
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {batches.map((batch) => (
              <li key={batch.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">{batch.productName}</span>
                  <span className="font-mono text-muted text-[0.75rem]">{batch.lotNumber}</span>

                  {/* Status as a word. Colour alone would fail WCAG 1.4.1 and
                      would not distinguish "on hold" from "recalled", which have
                      two different next actions. */}
                  {batch.status !== 'ACTIVE' ? (
                    <span className="text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      {BATCH_STATUS_LABEL[batch.status]}
                    </span>
                  ) : null}

                  <span className="text-muted ml-auto font-mono text-[0.75rem]">
                    {batch.expiresOn ?? 'no expiry'}
                  </span>
                </div>

                {batch.quarantineReason ? (
                  <p className="text-muted mt-1 text-[0.8125rem]">
                    On hold: {batch.quarantineReason}
                  </p>
                ) : null}
                {batch.recallReference ? (
                  <p className="text-signal mt-1 text-[0.8125rem]">
                    Recalled under {batch.recallReference}
                  </p>
                ) : null}

                <div className="mt-2 max-w-md">
                  {/*
                    ⚠️ THE LIST GIVES TOTALS, NOT PER-SHELF BUCKETS — the list
                       endpoint returns a lot's on-hand and available sums, which
                       is what a list is for. Where a lot actually sits is the
                       detail question, and it is answered per location by the
                       overview.
                  */}
                  <BucketBar
                    buckets={[
                      { status: 'AVAILABLE', quantity: batch.quantityAvailable },
                      {
                        status: heldStatusFor(batch.status),
                        quantity: String(
                          Number(batch.quantityOnHand) - Number(batch.quantityAvailable)
                        ),
                      },
                    ]}
                    unit={batch.baseUnitSymbol}
                    label={`${batch.productName} lot ${batch.lotNumber}`}
                  />
                </div>

                <p className="text-muted mt-1.5 text-[0.75rem]">
                  {readable(batch.quantityOnHand)} {batch.baseUnitSymbol} on hand
                  {batch.unitCostBase !== null && batch.currency
                    ? ` · ${batch.currency} ${(batch.unitCostBase / 100).toFixed(2)} per ${batch.baseUnitSymbol}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        )}

        {meta.totalPages > 1 ? (
          <nav aria-label="Pages" className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={meta.page <= 1}
              onClick={() => goToPage(meta.page - 1)}
            >
              Previous
            </Button>
            <span className="text-muted text-[0.8125rem]">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={meta.page >= meta.totalPages}
              onClick={() => goToPage(meta.page + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Which held-back condition to draw the non-available remainder as.
 *
 * ⚠️ A DRAWING DECISION, NOT A FACT ABOUT THE STOCK. The list endpoint returns
 *   two sums — on hand and available — and the difference could be quarantined,
 *   expired or damaged, or a mix. The batch's own status is the closest honest
 *   label for it, and it falls back to "on hold" for an ACTIVE lot whose
 *   remainder is held for some other reason. The overview shows the real
 *   per-condition split.
 */
function heldStatusFor(status: BatchListResponse['batches'][number]['status']) {
  switch (status) {
    case 'EXPIRED':
      return 'EXPIRED' as const;
    case 'RECALLED':
      return 'RECALLED' as const;
    case 'DAMAGED':
      return 'DAMAGED' as const;
    case 'DISPOSED':
      return 'DISPOSED' as const;
    default:
      return 'QUARANTINED' as const;
  }
}
