'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import type { SupplierListResponse } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/**
 * Who the clinic buys from.
 *
 * ⚠️ THE STATUS IS A WORD AND NEVER ONLY A COLOUR (WCAG 1.4.1), and the three of
 *   them mean three different next actions: an active supplier can be ordered from,
 *   one on hold is a conversation somebody is having, and a blacklisted one is a
 *   refusal the API enforces. Tinting them and leaving it there would make the last
 *   two look like a shade of the first.
 *
 * ⚠️ THE FILTERS DRIVE THE URL AND THE URL DRIVES THE FETCH. Nothing here filters an
 *   in-memory array — the rows are one server-rendered page of a query the API ran
 *   in SQL. Same shape as the lots and catalogue screens, for the same reason.
 *
 * NO PHI. A supplier is a business.
 */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On hold' },
  { value: 'BLACKLISTED', label: 'Blacklisted' },
];

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  BLACKLISTED: 'Blacklisted',
};

interface Props {
  suppliers: SupplierListResponse['suppliers'];
  meta: SupplierListResponse['meta'];
  canManage: boolean;
}

export function SupplierList({ suppliers, meta, canManage }: Props) {
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
      // Changing a filter while on page 7 lands on page 7 of a shorter set, and the
      // screen shows an empty table for a filter that matched plenty.
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
            Suppliers
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Everyone the clinic buys from, across every branch.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/procurement/suppliers/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Add a supplier
          </Link>
        ) : null}
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
            placeholder="Name, code or contact"
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
            ? 'No suppliers match these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {suppliers.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">
              {searchParams.size === 0
                ? 'No suppliers have been added.'
                : 'Nothing matches these filters.'}
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {searchParams.size === 0
                ? 'Add the distributor or manufacturer you order from. You need one before you can raise an order or record a delivery.'
                : 'Try a broader search, or clear a filter.'}
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {suppliers.map((supplier) => (
              <li key={supplier.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/procurement/suppliers/${supplier.id}`}
                    className="text-ink hover:text-drape text-[0.9375rem] font-medium"
                  >
                    {supplier.name}
                  </Link>
                  <span className="text-muted font-mono text-[0.75rem]">{supplier.code}</span>

                  {supplier.status !== 'ACTIVE' ? (
                    <span className="text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      {STATUS_LABEL[supplier.status] ?? supplier.status}
                    </span>
                  ) : null}
                  {supplier.isDeleted ? (
                    <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      Removed
                    </span>
                  ) : null}

                  <span className="text-muted ml-auto text-[0.75rem]">
                    {supplier.productCount === 0
                      ? 'nothing priced yet'
                      : `${supplier.productCount} priced`}
                  </span>
                </div>

                <p className="text-muted mt-1 text-[0.8125rem]">
                  {[
                    supplier.contactPerson,
                    supplier.phone,
                    supplier.city,
                    supplier.defaultCurrency,
                    supplier.leadTimeDays === null
                      ? null
                      : `${supplier.leadTimeDays} day lead time`,
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ') || 'No contact details recorded.'}
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
