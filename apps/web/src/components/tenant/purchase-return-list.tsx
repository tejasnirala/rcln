'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, PurchaseReturnListResponse, SupplierSummary } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/** What has gone back to a supplier, and what is waiting to. */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Gone back' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Gone back',
  CANCELLED: 'Cancelled',
};

interface Props {
  purchaseReturns: PurchaseReturnListResponse['purchaseReturns'];
  meta: PurchaseReturnListResponse['meta'];
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
  canManage: boolean;
}

export function PurchaseReturnList({
  purchaseReturns,
  meta,
  branches,
  suppliers,
  canManage,
}: Props) {
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Returns
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            What has gone back to a supplier, and why.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/procurement/returns/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Send stock back
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-3">
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
          onChange={(event) => setFilter({ status: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {purchaseReturns.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing has been sent back.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Raise a return from the delivery it came in on, so the credit can be reconciled
              against it.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {purchaseReturns.map((ret) => (
              <li key={ret.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/procurement/returns/${ret.id}`}
                    className="text-ink hover:text-drape text-[0.9375rem] font-medium"
                  >
                    {ret.returnNumber ?? 'Draft'}
                  </Link>
                  <span className="text-muted text-[0.8125rem]">{ret.supplierName}</span>
                  <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                    {STATUS_LABEL[ret.status] ?? ret.status}
                  </span>
                  <span className="text-ink ml-auto font-mono text-[0.875rem]">
                    {ret.currency} {(ret.totalMinor / 100).toFixed(2)}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {ret.branchName}
                  {ret.goodsReceiptNumber ? ` · from ${ret.goodsReceiptNumber}` : ''}
                  {ret.supplierCreditNoteNumber
                    ? ` · credit note ${ret.supplierCreditNoteNumber}`
                    : ''}
                  {' · '}
                  {ret.reason}
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
