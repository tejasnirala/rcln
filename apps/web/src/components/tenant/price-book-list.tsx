'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import type { SupplierProductListResponse, SupplierSummary } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/**
 * The whole price book, across every supplier.
 *
 * ⚠️ A SEPARATE SCREEN FROM THE SUPPLIER'S OWN PRICE LIST BECAUSE IT ANSWERS THE
 *   OPPOSITE QUESTION. "What does MediDist sell us" belongs on their page; "who sells
 *   amoxicillin, and for how much" is asked from the PRODUCT, and answering it from
 *   the supplier pages would mean opening one per supplier and comparing by eye.
 *   Rows are added on a supplier's page, because a price belongs to a relationship.
 */
interface Props {
  supplierProducts: SupplierProductListResponse['supplierProducts'];
  meta: SupplierProductListResponse['meta'];
  suppliers: SupplierSummary[];
}

export function PriceBookList({ supplierProducts, meta, suppliers }: Props) {
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
          Price book
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Who sells what, in whose packs, at what price. Add a row on the supplier’s page.
        </p>
      </header>

      <ProcurementNav />

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
            placeholder="Product or their code"
          />
        </div>
        <Select
          label="Supplier"
          name="supplierId"
          value={searchParams.get('supplierId') ?? ''}
          options={[
            { value: '', label: 'Any supplier' },
            ...suppliers.map((s) => ({ value: s.id, label: s.name })),
          ]}
          onChange={(event) => setFilter({ supplierId: event.target.value })}
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
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {supplierProducts.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing priced yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Open a supplier and record what they charge per pack. Order lines then price
              themselves instead of somebody converting boxes to capsules by hand.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {supplierProducts.map((row) => (
              <li key={row.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">{row.productName}</span>
                  <Link
                    href={`/procurement/suppliers/${row.supplierId}`}
                    className="text-muted hover:text-drape text-[0.8125rem]"
                  >
                    {row.supplierName}
                  </Link>
                  <span className="text-muted font-mono text-[0.75rem]">{row.supplierSku}</span>
                  {row.isPreferred ? (
                    <span className="text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      Preferred
                    </span>
                  ) : null}
                  <span className="text-ink ml-auto font-mono text-[0.875rem]">
                    {row.currency} {(row.unitCostBase / 100).toFixed(2)} per {row.baseUnitSymbol}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {row.currency} {(row.pricePerPackMinor / 100).toFixed(2)} per {row.packUnitSymbol}{' '}
                  of {row.quantityPerPack} {row.baseUnitSymbol}
                  {row.leadTimeDays === null ? '' : ` · ${row.leadTimeDays} day lead time`}
                  {' · priced from '}
                  {row.priceEffectiveFrom}
                  {row.priceEffectiveTo ? ` to ${row.priceEffectiveTo}` : ''}
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
