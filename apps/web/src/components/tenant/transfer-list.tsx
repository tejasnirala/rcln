'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, StockTransferListResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { StockNav } from '@/components/tenant/stock-nav';
import { TransferProgress } from '@/components/tenant/stock-status';

/**
 * Stock on its way somewhere.
 *
 * ⚠️ THE DEFAULT VIEW IS "STILL OUTSTANDING", NOT "EVERYTHING". Nobody opens
 *   this screen to browse completed deliveries; they open it because a box has
 *   not turned up, or because they are about to unpack one. A list of every
 *   transfer ever made buries the four that need doing under four hundred that
 *   do not.
 *
 * ⚠️ AND "SENT" AND "ARRIVING" ARE ONE LIST WITH A FILTER, NOT TWO SCREENS. A
 *   transfer belongs to both branches — that is the whole reason its RLS policy
 *   is the bespoke two-ended one — and a person who works at both sites would
 *   otherwise have to check two inboxes for one movement of stock.
 *
 * NO PHI.
 */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'DISPATCHED', label: 'Sent' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partly received' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** The words a storekeeper uses, not the column's. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  DISPATCHED: 'Sent',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

interface Props {
  transfers: StockTransferListResponse['transfers'];
  meta: StockTransferListResponse['meta'];
  branches: BranchSummary[];
  canTransfer: boolean;
}

export function TransferList({ transfers, meta, branches, canTransfer }: Props) {
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
      // Changing a filter while on page 7 lands on page 7 of a shorter set.
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

  const branchOptions = [
    { value: '', label: 'Any branch' },
    ...branches.map((b) => ({ value: b.id, label: b.name })),
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Transfers
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Stock moving between shelves and between sites.
          </p>
        </div>
        {canTransfer ? (
          <Link
            href="/stock/transfers/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Move stock
          </Link>
        ) : null}
      </header>

      <StockNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Sent from"
          name="fromBranchId"
          value={searchParams.get('fromBranchId') ?? ''}
          options={branchOptions}
          onChange={(event) => setFilter({ fromBranchId: event.target.value })}
        />
        <Select
          label="Going to"
          name="toBranchId"
          value={searchParams.get('toBranchId') ?? ''}
          options={branchOptions}
          onChange={(event) => setFilter({ toBranchId: event.target.value })}
        />
        <Select
          label="Status"
          name="status"
          value={searchParams.get('status') ?? ''}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Select
          label="Show"
          name="outstandingOnly"
          value={searchParams.get('outstandingOnly') ?? 'true'}
          options={[
            { value: 'true', label: 'Still outstanding' },
            { value: 'false', label: 'Everything' },
          ]}
          onChange={(event) => setFilter({ outstandingOnly: event.target.value })}
          hint="Outstanding means sent and not yet fully signed for."
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'No transfers match these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {transfers.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing is on the move.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Move stock when a shelf runs low and another has spare, or when a site sends a
              delivery on to a branch. Every transfer leaves a record of who sent it and who signed
              for it.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {transfers.map((transfer) => {
              const sent = transfer.lineCount;
              const outstanding = transfer.outstandingLineCount;

              return (
                <li key={transfer.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Link
                      href={`/stock/transfers/${transfer.id}`}
                      className="text-ink text-[0.9375rem] font-medium"
                    >
                      {transfer.fromLocationName} → {transfer.toLocationName ?? 'not yet decided'}
                    </Link>

                    {/* The document number, once it has one. A draft has none —
                        it has not burned a serial in a series somebody reads as
                        a sequence. */}
                    {transfer.transferNumber ? (
                      <span className="font-mono text-muted text-[0.75rem]">
                        {transfer.transferNumber}
                      </span>
                    ) : null}

                    {/* Status as a WORD. Colour alone would fail WCAG 1.4.1, and
                        "sent" and "partly received" have two different next
                        actions that no tint distinguishes. */}
                    <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      {STATUS_LABEL[transfer.status] ?? transfer.status}
                    </span>

                    {transfer.isIntraBranch ? null : (
                      <span className="text-muted ml-auto text-[0.75rem]">
                        {transfer.fromBranchName} → {transfer.toBranchName}
                      </span>
                    )}
                  </div>

                  {/*
                    ⚠️ THE PROGRESS RULE COUNTS LINES, NOT QUANTITY, AND THE LABEL
                       SAYS SO. The list endpoint returns how many lines are still
                       outstanding, not how much of each — summing quantities
                       across products would add tablets to millilitres. The
                       per-line quantities are the detail question and the detail
                       screen answers them.
                  */}
                  {transfer.status === 'DRAFT' || transfer.status === 'CANCELLED' ? (
                    <p className="text-muted mt-1.5 text-[0.75rem]">
                      {sent} {sent === 1 ? 'line' : 'lines'}
                    </p>
                  ) : (
                    <div className="mt-2 max-w-md">
                      <TransferProgress
                        sent={String(sent)}
                        received={String(sent - outstanding)}
                        unit="lines"
                        label={`Transfer ${transfer.transferNumber ?? ''}`}
                      />
                    </div>
                  )}

                  <p className="text-muted mt-1.5 text-[0.75rem]">
                    {transfer.dispatchedByName
                      ? `Sent by ${transfer.dispatchedByName}`
                      : `Drafted by ${transfer.createdByName ?? 'someone'}`}
                    {transfer.receivedByName ? ` · signed for by ${transfer.receivedByName}` : ''}
                  </p>
                </li>
              );
            })}
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
