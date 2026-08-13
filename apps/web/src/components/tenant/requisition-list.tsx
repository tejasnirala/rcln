'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, PurchaseRequisitionListResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { ProcurementNav } from '@/components/tenant/procurement-nav';

/**
 * What each branch has asked for.
 *
 * ⚠️ "AWAITING MY APPROVAL" IS A FILTER AND NOT A SECOND SCREEN, AND THE SERVER
 *   EXCLUDES THE CALLER'S OWN ROWS FROM IT. A requisition you raised is
 *   unapprovable by you however many permissions you hold — the CHECK constraint
 *   refuses it — so listing yours on an approval queue would be a page of buttons
 *   that all fail.
 */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Waiting for approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Withdrawn' },
];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  ORDERED: 'Ordered',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
};

interface Props {
  requisitions: PurchaseRequisitionListResponse['requisitions'];
  meta: PurchaseRequisitionListResponse['meta'];
  branches: BranchSummary[];
  canCreate: boolean;
}

export function RequisitionList({ requisitions, meta, branches, canCreate }: Props) {
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

  const awaiting = searchParams.get('awaitingApproval') === 'true';
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Requisitions
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            What a branch has asked to buy, and who agreed to it.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/procurement/requisitions/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Ask for stock
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-3">
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
          label="Status"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value, awaitingApproval: '' })}
        />
        <div className="flex items-end">
          <Button
            type="button"
            variant={awaiting ? 'primary' : 'secondary'}
            onClick={() => setFilter({ awaitingApproval: awaiting ? '' : 'true', status: '' })}
          >
            {awaiting ? 'Showing what I can approve' : 'Waiting for me'}
          </Button>
        </div>
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {requisitions.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">
              {awaiting ? 'Nothing is waiting for you.' : 'No requisitions yet.'}
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              {awaiting
                ? 'A requisition appears here once somebody else submits one. You cannot approve your own.'
                : 'Ask for stock when a shelf is running low. Somebody else approves it, then it becomes an order.'}
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {requisitions.map((req) => (
              <li key={req.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/procurement/requisitions/${req.id}`}
                    className="text-ink hover:text-drape text-[0.9375rem] font-medium"
                  >
                    {req.requisitionNumber ?? 'Draft'}
                  </Link>
                  <span className="text-muted text-[0.8125rem]">{req.branchName}</span>
                  <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                    {STATUS_LABEL[req.status] ?? req.status}
                  </span>
                  {req.canApprove ? (
                    <span className="text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      You can approve this
                    </span>
                  ) : null}
                  <span className="text-muted ml-auto text-[0.75rem]">
                    {req.lineCount} {req.lineCount === 1 ? 'line' : 'lines'}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  Raised by {req.createdByName}
                  {req.requiredBy ? ` · needed by ${req.requiredBy}` : ''}
                  {req.approvedByName ? ` · approved by ${req.approvedByName}` : ''}
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
