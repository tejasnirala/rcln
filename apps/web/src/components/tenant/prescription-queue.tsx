'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, PrescriptionQueueResponse } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';

/**
 * Who is waiting, oldest first.
 *
 * ⚠️ OLDEST FIRST, WHICH IS THE OPPOSITE OF EVERY OTHER LIST IN THIS PRODUCT. A
 *   dispensary queue is a waiting room: the person who has been standing there
 *   longest is served next. Newest-first would be a list of what happened, and
 *   this is a list of what to do.
 *
 * ⚠️ NO FREE-TEXT PATIENT SEARCH, ON PURPOSE. Looking somebody up by name is the
 *   patient screen's job, where the read is logged with a hashed term and is
 *   never deduplicated — repeatedly searching for the same person is itself the
 *   signal that table exists to catch. Here you filter by state and by day.
 *
 * ⚠️ PHI ON EVERY ROW. The counter has to call somebody's name, so the name is
 *   here — and nowhere else: not in the URL, not in `localStorage`, not in a
 *   toast.
 */
const STATUSES = [
  { value: '', label: 'Anything not finished' },
  { value: 'NEW', label: 'Not looked at' },
  { value: 'VERIFIED', label: 'Checked, not supplied' },
  { value: 'PARTIALLY_DISPENSED', label: 'Part supplied' },
  { value: 'COMPLETED', label: 'Finished' },
  { value: 'CANCELLED', label: 'Stood down' },
];

const STATUS_LABEL: Record<string, string> = {
  NEW: 'Not looked at',
  VERIFIED: 'Checked',
  PARTIALLY_DISPENSED: 'Part supplied',
  COMPLETED: 'Finished',
  CANCELLED: 'Stood down',
};

interface Props {
  items: PrescriptionQueueResponse['items'];
  meta: PrescriptionQueueResponse['meta'];
  branches: BranchSummary[];
}

export function PrescriptionQueue({ items, meta, branches }: Props) {
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
          Waiting
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Prescriptions this dispensary has not finished with. Longest wait first.
        </p>
      </header>

      <PharmacyNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Written at"
          name="branchId"
          value={searchParams.get('branchId') ?? ''}
          options={[
            { value: '', label: 'Every branch I work at' },
            ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
          ]}
          onChange={(event) => setFilter({ branchId: event.target.value })}
        />
        <Select
          label="State"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Input
          label="Written on or after"
          name="from"
          type="date"
          value={searchParams.get('from') ?? ''}
          onChange={(event) => setFilter({ from: event.target.value })}
        />
        <Input
          label="Written on or before"
          name="to"
          type="date"
          value={searchParams.get('to') ?? ''}
          onChange={(event) => setFilter({ to: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {items.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nobody is waiting.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              A prescription appears here the moment a doctor signs a consultation that prescribed
              something.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.encounterId}>
                <Link
                  href={`/pharmacy/prescriptions/${item.encounterId}`}
                  className="border-rule bg-card hover:border-drape flex flex-wrap items-center gap-4 rounded-md border p-4 transition-colors"
                >
                  <span className="min-w-48 flex-1">
                    <span className="text-ink block text-[1rem] font-medium">
                      {item.patientName}
                    </span>
                    <span className="text-muted block text-[0.8125rem]">
                      {item.patientUhid}
                      {item.prescriberName ? ` · ${item.prescriberName}` : ''}
                      {item.encounterNumber ? ` · ${item.encounterNumber}` : ''}
                    </span>
                  </span>
                  <span className="text-muted text-[0.875rem] tabular-nums">
                    {item.completedItemCount}/{item.itemCount} supplied
                  </span>
                  <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
                    {STATUS_LABEL[item.status] ?? item.status}
                  </span>
                  <span className="text-muted text-[0.8125rem]">{item.branchName}</span>
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
