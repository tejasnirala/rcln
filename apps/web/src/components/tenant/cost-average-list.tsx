'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import type { BranchSummary, ProductCostAverageListResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/**
 * What each product has cost, on average.
 *
 * ⚠️ THE QUANTITY COLUMN IS NOT STOCK ON HAND, AND THE SCREEN SAYS SO IN WORDS RATHER
 *   THAN LEAVING IT TO BE INFERRED. `valuedQuantityBase` is the denominator of an
 *   average — the quantity the running value was accumulated over — and it diverges
 *   from the shelf the moment anything is dispensed, expired or transferred.
 *   `stock_balances` is what the branch holds and the Stock screens are where that is
 *   answered. Labelling this "on hand" would be the single most likely misreading in
 *   the phase, so it is labelled "valued over" and explained above the table.
 *
 * ⚠️ ONE PRODUCT CAN APPEAR TWICE, ONCE PER CURRENCY, and that is the honest answer
 *   when a clinic bought the same item in two. Nothing here applies an exchange rate,
 *   because averaging across currencies would invent one nobody chose.
 */
interface Props {
  costAverages: ProductCostAverageListResponse['costAverages'];
  meta: ProductCostAverageListResponse['meta'];
  branches: BranchSummary[];
}

export function CostAverageList({ costAverages, meta, branches }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setFilter = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
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
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          What things cost
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          The average paid per unit, built up from every delivery received.
        </p>
      </header>

      <ProcurementNav />

      <Alert tone="info">
        These are costs, not stock levels. The quantity shown is what the average was worked out
        over — not what is on the shelf today. Stock shows what is actually held.
      </Alert>

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <Select
          label="Branch"
          name="branchId"
          value={searchParams.get('branchId') ?? ''}
          options={[
            { value: '', label: 'Every branch I work at' },
            ...branches.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(event) => setFilter({ branchId: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0 ? 'Nothing valued yet.' : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {costAverages.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing has been costed yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              A product gets an average cost the first time a delivery of it is posted, including
              its share of freight and duty.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {costAverages.map((row) => (
              <li key={`${row.branchId}-${row.productId}-${row.currency}`} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">{row.productName}</span>
                  <span className="text-muted font-mono text-[0.75rem]">{row.productCode}</span>
                  <span className="text-muted text-[0.8125rem]">{row.branchName}</span>
                  <span className="text-ink ml-auto font-mono text-[0.875rem]">
                    {row.currency} {(row.averageCostBase / 100).toFixed(2)} per {row.baseUnitSymbol}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  Valued over {row.valuedQuantityBase} {row.baseUnitSymbol} costing {row.currency}{' '}
                  {(row.valuedCostMinor / 100).toFixed(2)} across {row.receiptCount}{' '}
                  {row.receiptCount === 1 ? 'delivery' : 'deliveries'}
                  {row.lastReceiptAt ? ` · last on ${row.lastReceiptAt.slice(0, 10)}` : ''}
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
