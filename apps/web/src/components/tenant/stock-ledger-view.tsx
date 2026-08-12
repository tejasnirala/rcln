'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import type { StockLedgerListResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { StockNav } from '@/components/tenant/stock-nav';
import { STOCK_STATUS_LABEL, readable } from '@/components/tenant/stock-status';
import { formatClinicDateTime } from '@/lib/format';

/**
 * Everything that ever moved, newest first.
 *
 * ⚠️ THIS IS THE FORENSIC SCREEN, AND IT IS APPEND-ONLY ALL THE WAY DOWN. There
 *   is no edit control anywhere on it and there cannot be one: `stock_ledger` is
 *   append-only in Postgres by two independent layers, and a correction is a
 *   compensating movement with a reason (PI-ADR-004). A row here is what
 *   happened, not what somebody currently believes happened.
 *
 * ⚠️ PAGINATED SERVER-SIDE, ALWAYS. This table only grows, and it grows fastest
 *   at the clinics with the most stock — the ones whose ledger screen matters.
 *   There is no "load all" and no client-side filter.
 *
 * ⚠️ EVERY TIMESTAMP IS RENDERED IN THE BRANCH'S ZONE AND THE CLINIC'S FORMAT
 *   (invariant 6). `formatClinicDateTime`, never a bare `toLocaleString()` —
 *   the browser's zone is the user's laptop, which is not the clinic's.
 */
const MOVEMENT_LABEL: Record<string, string> = {
  PURCHASE_RECEIPT: 'Received',
  TRANSFER_IN: 'Transferred in',
  TRANSFER_OUT: 'Transferred out',
  DISPENSING: 'Dispensed',
  CLINICAL_CONSUMPTION: 'Used in care',
  ADJUSTMENT: 'Adjusted',
  DAMAGE: 'Damaged',
  EXPIRY: 'Expired',
  RECALL: 'Recalled',
  RETURN: 'Returned',
  DISPOSAL: 'Disposed',
  RESERVATION: 'Reserved',
  RELEASE: 'Released',
  QUARANTINE: 'Put on hold',
  QUARANTINE_RELEASE: 'Taken off hold',
};

const TYPES = [
  { value: '', label: 'Any movement' },
  ...Object.entries(MOVEMENT_LABEL).map(([value, label]) => ({ value, label })),
];

interface Props {
  movements: StockLedgerListResponse['movements'];
  meta: StockLedgerListResponse['meta'];
  timezone: string;
  timeFormat: '12H' | '24H';
}

export function StockLedgerView({ movements, meta, timezone, timeFormat }: Props) {
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
          Movements
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Every change to every quantity, in the order it happened. Nothing here can be edited.
        </p>
      </header>

      <StockNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Movement"
          name="movementType"
          value={searchParams.get('movementType') ?? ''}
          options={TYPES}
          onChange={(event) => setFilter({ movementType: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0 ? 'Nothing has moved yet.' : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {movements.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">No movements to show.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              A row appears here every time stock is received, issued, held or corrected.
            </p>
          </div>
        ) : (
          <div className="border-rule bg-card overflow-x-auto rounded-md border">
            <table className="w-full min-w-[52rem] text-left text-[0.875rem]">
              <thead className="border-rule text-muted border-b text-[0.75rem]">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    What
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Product
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Where
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Who
                  </th>
                </tr>
              </thead>
              <tbody className="divide-rule divide-y">
                {movements.map((row) => (
                  <tr key={row.id}>
                    <td className="text-muted px-4 py-2.5 align-top whitespace-nowrap text-[0.8125rem]">
                      {formatClinicDateTime(row.occurredAt, timezone, timeFormat)}
                    </td>
                    <td className="text-ink px-4 py-2.5 align-top">
                      {MOVEMENT_LABEL[row.movementType] ?? row.movementType}
                      {row.reasonCode ? (
                        <span className="text-muted block text-[0.75rem]">{row.reasonCode}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className="text-ink">{row.productName}</span>
                      {row.lotNumber ? (
                        <span className="text-muted block font-mono text-[0.75rem]">
                          lot {row.lotNumber}
                        </span>
                      ) : null}
                      {row.serialNumber ? (
                        <span className="text-muted block font-mono text-[0.75rem]">
                          serial {row.serialNumber}
                        </span>
                      ) : null}
                    </td>
                    {/*
                      ⚠️ THE SIGN IS THE INFORMATION. A movement is signed in the
                         ledger and the sign is derived from the type, never
                         chosen — so it is shown, not stripped, and the base unit
                         goes with it because a bare number means nothing.
                    */}
                    <td className="text-ink px-4 py-2.5 text-right align-top font-mono whitespace-nowrap">
                      {readable(row.quantityBase)} {row.baseUnitSymbol}
                      {row.unitSymbol !== row.baseUnitSymbol ? (
                        <span className="text-muted block text-[0.75rem]">
                          entered as {readable(row.quantityEntered)} {row.unitSymbol}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-muted px-4 py-2.5 align-top text-[0.8125rem]">
                      {row.fromLocationName && row.toLocationName
                        ? `${row.fromLocationName} → ${row.toLocationName}`
                        : (row.fromLocationName ?? row.toLocationName ?? '—')}
                      {row.statusFrom && row.statusTo ? (
                        <span className="block text-[0.75rem]">
                          {STOCK_STATUS_LABEL[row.statusFrom]} → {STOCK_STATUS_LABEL[row.statusTo]}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-muted px-4 py-2.5 align-top text-[0.8125rem]">
                      {row.actorName ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
