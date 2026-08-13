'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, PurchaseOrderListResponse, SupplierSummary } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/**
 * What the clinic has committed to buy.
 *
 * ⚠️ "STILL WAITING" DEFAULTS ON, AND THE API DEFAULTS IT OFF. This screen is opened
 *   by somebody asking "what has not arrived yet", so its default is the answer to
 *   that question; the endpoint's default is right for a general-purpose caller.
 *   Same split `/stock/transfers` makes.
 */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'PARTIALLY_RECEIVED', label: 'Part delivered' },
  { value: 'RECEIVED', label: 'Delivered in full' },
  { value: 'CLOSED', label: 'Closed short' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  PARTIALLY_RECEIVED: 'Part delivered',
  RECEIVED: 'Delivered in full',
  CLOSED: 'Closed short',
  CANCELLED: 'Cancelled',
};

interface Props {
  purchaseOrders: PurchaseOrderListResponse['purchaseOrders'];
  meta: PurchaseOrderListResponse['meta'];
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
  canManage: boolean;
}

export function PurchaseOrderList({ purchaseOrders, meta, branches, suppliers, canManage }: Props) {
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

  const outstanding = (searchParams.get('outstandingOnly') ?? 'true') === 'true';
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Purchase orders
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            What has been ordered, and what has not turned up yet.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/procurement/purchase-orders/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Raise an order
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <Select
          label="Status"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value, outstandingOnly: 'false' })}
        />
        <div className="flex items-end">
          <Button
            type="button"
            variant={outstanding ? 'primary' : 'secondary'}
            onClick={() =>
              setFilter({ outstandingOnly: outstanding ? 'false' : 'true', status: '' })
            }
          >
            {outstanding ? 'Showing what is due' : 'Still waiting'}
          </Button>
        </div>
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {purchaseOrders.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">
              {outstanding ? 'Nothing is outstanding.' : 'No orders yet.'}
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {outstanding
                ? 'Every order has either arrived in full or been closed.'
                : 'Raise one from an approved requisition, or directly for a standing order.'}
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {purchaseOrders.map((order) => (
              <li key={order.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/procurement/purchase-orders/${order.id}`}
                    className="text-ink hover:text-drape text-[0.9375rem] font-medium"
                  >
                    {order.orderNumber ?? 'Draft'}
                  </Link>
                  <span className="text-muted text-[0.8125rem]">{order.supplierName}</span>
                  <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                    {STATUS_LABEL[order.status] ?? order.status}
                  </span>
                  <span className="text-ink ml-auto font-mono text-[0.875rem]">
                    {order.currency} {(order.totalMinor / 100).toFixed(2)}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {order.branchName}
                  {order.expectedDate ? ` · expected ${order.expectedDate}` : ''}
                  {order.outstandingLineCount > 0
                    ? ` · ${order.outstandingLineCount} of ${order.lineCount} still due`
                    : ` · ${order.lineCount} ${order.lineCount === 1 ? 'line' : 'lines'}`}
                  {order.requisitionNumber ? ` · from ${order.requisitionNumber}` : ''}
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
