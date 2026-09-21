'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, OnlineOrderListResponse, OnlineOrderStatus } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';
import { ORDER_STATUS_LABEL } from '@/components/tenant/online-order-status';

/**
 * What has to go out in a parcel.
 *
 * ⚠️ SORTED BY WHEN THE ORDER WAS TAKEN, NEWEST FIRST, LIKE THE DISPENSING LIST
 *   AND UNLIKE THE QUEUE. This is a record as much as a worklist — somebody is
 *   usually asking about a specific order — and the state filter is how a
 *   dispensary turns it into "what do I have to make up today".
 *
 * ⚠️ PHI ON EVERY ROW, AND MORE OF IT THAN THE DISPENSING LIST CARRIES: a name
 *   and the town the medicine is going to. Reading the list writes a
 *   `data_access_logs` row with a count and no patient, which is why there is no
 *   name search here and the filters are ids, states and dates.
 *
 * ⚠️ THE TRACKING FILTER IS THE ONE THAT EARNS ITS PLACE. "The patient is on the
 *   telephone holding a consignment note" is the query this screen exists to
 *   answer in one step.
 */
/**
 * ⚠️ DERIVED FROM `ORDER_STATUS_LABEL`, NOT RETYPED (PI-12 review). The first
 *   draft listed all seven words again, nine lines below the import of the
 *   module created to be the one place they live — so renaming a state needed
 *   two edits with nothing to catch the second.
 */
const STATUSES: { value: '' | OnlineOrderStatus; label: string }[] = [
  { value: '', label: 'Any state' },
  ...(Object.entries(ORDER_STATUS_LABEL) as [OnlineOrderStatus, string][]).map(
    ([value, label]) => ({ value, label })
  ),
];

const CHANNELS = [
  { value: '', label: 'However it arrived' },
  { value: 'WEB', label: 'Web' },
  { value: 'PHONE', label: 'Telephone' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'COUNTER', label: 'Asked at the counter' },
];

interface Props {
  orders: OnlineOrderListResponse['orders'];
  meta: OnlineOrderListResponse['meta'];
  branches: BranchSummary[];
  canTakeOrders: boolean;
}

export function OnlineOrderList({ orders, meta, branches, canTakeOrders }: Props) {
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
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Deliveries
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Medicine going out in a parcel: what was asked for, what is held for it, and where it
            got to.
          </p>
        </div>
        {canTakeOrders ? (
          <Link
            href="/pharmacy/orders/new"
            className="bg-drape text-paper rounded-md px-4 py-2 text-[0.875rem] font-medium"
          >
            Take an order
          </Link>
        ) : null}
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
          label="State"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Select
          label="How it arrived"
          name="channel"
          value={searchParams.get('channel') ?? ''}
          options={CHANNELS}
          onChange={(event) => setFilter({ channel: event.target.value })}
        />
        <Input
          label="Tracking number"
          name="trackingReference"
          hint="Matched exactly, for when somebody rings up holding one."
          defaultValue={searchParams.get('trackingReference') ?? ''}
          onBlur={(event) => setFilter({ trackingReference: event.target.value.trim() })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {orders.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">No deliveries here yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Take an order when somebody asks for their medicine to be sent out. Nothing is held
              until you accept it.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/pharmacy/orders/${order.id}`}
                  className="border-rule bg-card hover:border-drape flex flex-wrap items-center gap-4 rounded-md border p-4 transition-colors"
                >
                  <span className="text-ink w-32 shrink-0 text-[0.875rem] font-medium tabular-nums">
                    {order.orderNumber ?? 'Not accepted'}
                  </span>
                  <span className="min-w-48 flex-1">
                    <span className="text-ink block text-[0.9375rem]">{order.patientName}</span>
                    <span className="text-muted block text-[0.8125rem]">
                      {order.patientUhid} · to {order.city ?? order.destination} ·{' '}
                      {order.branchName}
                    </span>
                  </span>
                  <span className="text-muted text-[0.875rem] tabular-nums">
                    {order.lineCount} {order.lineCount === 1 ? 'item' : 'items'}
                  </span>
                  {order.hasConditions ? (
                    <span className="border-warning/40 text-warning rounded-full border px-3 py-1 text-[0.8125rem]">
                      Has obligations
                    </span>
                  ) : null}
                  <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
                    {ORDER_STATUS_LABEL[order.status]}
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
              /* ⚠️ `px-3 py-2` TAKES THESE PAST 24x24 (WCAG 2.5.8). They are not
                 inline links in a nav, so `globals.css` adds nothing for them —
                 at line-height alone they land near 20px. */
              className="text-muted hover:text-ink -mx-3 px-3 py-2 text-[0.875rem] disabled:opacity-40"
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
              /* ⚠️ `px-3 py-2` TAKES THESE PAST 24x24 (WCAG 2.5.8). They are not
                 inline links in a nav, so `globals.css` adds nothing for them —
                 at line-height alone they land near 20px. */
              className="text-muted hover:text-ink -mx-3 px-3 py-2 text-[0.875rem] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
