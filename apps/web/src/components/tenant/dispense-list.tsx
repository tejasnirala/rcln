'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, DispenseListResponse } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';

/**
 * What has gone over the counter.
 *
 * ⚠️ NEWEST FIRST, UNLIKE THE QUEUE. This is a record of what happened, and the
 *   most recent supply is the one somebody is asking about.
 *
 * ⚠️ PHI ON EVERY ROW, AND OPENING ONE WRITES A `data_access_logs` ROW. The list
 *   itself writes one too, with a count and no patient — which is why there is no
 *   name search here and why the filters are ids and dates.
 */
const KINDS = [
  { value: '', label: 'Prescriptions and sales' },
  { value: 'PRESCRIPTION', label: 'Against a prescription' },
  { value: 'COUNTER_SALE', label: 'Counter sales' },
];

const STATUSES = [
  { value: '', label: 'Any state' },
  { value: 'DISPENSED', label: 'Handed over' },
  { value: 'PARTIALLY_RETURNED', label: 'Part returned' },
  { value: 'RETURNED', label: 'Returned' },
];

const STATUS_LABEL: Record<string, string> = {
  DISPENSED: 'Handed over',
  PARTIALLY_RETURNED: 'Part returned',
  RETURNED: 'Returned',
};

interface Props {
  dispenses: DispenseListResponse['dispenses'];
  meta: DispenseListResponse['meta'];
  branches: BranchSummary[];
}

export function DispenseList({ dispenses, meta, branches }: Props) {
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
          Dispensed
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Everything this dispensary has handed over, and what came back.
        </p>
      </header>

      <PharmacyNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Branch"
          name="branchId"
          value={searchParams.get('branchId') ?? ''}
          options={[
            { value: '', label: 'Every branch I work at' },
            ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
          ]}
          onChange={(event) => setFilter({ branchId: event.target.value })}
        />
        <Select
          label="Kind"
          name="kind"
          value={searchParams.get('kind') ?? ''}
          options={KINDS}
          onChange={(event) => setFilter({ kind: event.target.value })}
        />
        <Select
          label="State"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Input
          label="Handed over on or after"
          name="from"
          type="date"
          value={searchParams.get('from') ?? ''}
          onChange={(event) => setFilter({ from: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {dispenses.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing has been dispensed here yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Supplies appear here as they are handed over, with the lot each one came out of.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {dispenses.map((dispense) => (
              <li key={dispense.id}>
                <Link
                  href={`/pharmacy/dispenses/${dispense.id}`}
                  className="border-rule bg-card hover:border-drape flex flex-wrap items-center gap-4 rounded-md border p-4 transition-colors"
                >
                  <span className="text-ink w-32 shrink-0 text-[0.875rem] font-medium tabular-nums">
                    {dispense.dispenseNumber}
                  </span>
                  <span className="min-w-48 flex-1">
                    <span className="text-ink block text-[0.9375rem]">
                      {dispense.patientName ?? 'Counter sale'}
                    </span>
                    <span className="text-muted block text-[0.8125rem]">
                      {dispense.patientUhid ?? 'No patient recorded'} · {dispense.locationName} ·{' '}
                      {dispense.dispensedByName}
                    </span>
                  </span>
                  <span className="text-muted text-[0.875rem] tabular-nums">
                    {dispense.lineCount} {dispense.lineCount === 1 ? 'item' : 'items'}
                  </span>
                  {dispense.hasConditions ? (
                    <span className="border-warning/40 text-warning rounded-full border px-3 py-1 text-[0.8125rem]">
                      Has obligations
                    </span>
                  ) : null}
                  <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
                    {STATUS_LABEL[dispense.status] ?? dispense.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {meta.totalPages > 1 ? (
          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={() => goToPage(meta.page - 1)}
              disabled={meta.page <= 1}
              className="text-muted hover:text-ink text-[0.875rem] disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-muted text-[0.8125rem]">
              Page {meta.page} of {meta.totalPages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(meta.page + 1)}
              disabled={meta.page >= meta.totalPages}
              className="text-muted hover:text-ink text-[0.875rem] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
