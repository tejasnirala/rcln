'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useActionState, useCallback, useTransition } from 'react';
import type { BranchSummary, StockReservationListResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { StockNav } from '@/components/tenant/stock-nav';
import { readable } from '@/components/tenant/stock-status';
import { formatClinicDateTime } from '@/lib/format';
import {
  IDLE_FORM,
  releaseReservationAction,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Stock that is spoken for.
 *
 * ⚠️ THIS SCREEN EXISTS TO ANSWER ONE QUESTION: "WHY CAN I NOT DISPENSE
 *   SOMETHING I CAN SEE ON THE SHELF." A reservation moves quantity out of the
 *   available pool, so the boxes are there and the number is not — and without
 *   this list the only way to find out who is holding it is to read the ledger.
 *   So each row leads with the product and the quantity and says who holds it
 *   and until when.
 *
 * ⚠️ AND IT SHOWS ACTIVE HOLDS BY DEFAULT. A released reservation is history;
 *   the useful list is what is being held right now.
 *
 * ⚠️ "OVERDUE" IS A REAL STATE AND IS SHOWN AS ONE. The sweep runs hourly, so a
 *   reservation can sit past its time for up to an hour with the stock still
 *   held. Showing it as merely "active" leaves a pharmacist waiting for stock
 *   that is already theirs; releasing it by hand is one click and works
 *   immediately.
 *
 * NO PHI. A reservation cites what it is being held for, never who for.
 */
const STATUSES = [
  { value: 'ACTIVE', label: 'Being held' },
  { value: '', label: 'Any status' },
  { value: 'RELEASED', label: 'Released' },
  { value: 'EXPIRED', label: 'Timed out' },
  { value: 'CONSUMED', label: 'Dispensed' },
];

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Being held',
  RELEASED: 'Released',
  EXPIRED: 'Timed out',
  CONSUMED: 'Dispensed',
};

interface Props {
  slug: string;
  reservations: StockReservationListResponse['reservations'];
  meta: StockReservationListResponse['meta'];
  branches: BranchSummary[];
  timezone: string;
  timeFormat: '12H' | '24H';
  canReserve: boolean;
}

export function ReservationList({
  slug,
  reservations,
  meta,
  branches,
  timezone,
  timeFormat,
  canReserve,
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
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Reservations
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Stock held back for something, and not yet gone.
        </p>
      </header>

      <StockNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Select
          label="Branch"
          name="branchId"
          value={searchParams.get('branchId') ?? ''}
          options={[
            { value: '', label: 'Any branch' },
            ...branches.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(event) => setFilter({ branchId: event.target.value })}
        />
        <Select
          label="Status"
          name="status"
          value={searchParams.get('status') ?? 'ACTIVE'}
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

        {reservations.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">No stock is being held.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Hold stock back when it is spoken for — a procedure booked for Thursday, an order
              waiting to be collected. It stays off the dispensable count until it is released or
              runs out of time.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {reservations.map((reservation) => (
              <li key={reservation.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">
                    {reservation.productName}
                  </span>
                  {reservation.lotNumber ? (
                    <span className="font-mono text-muted text-[0.75rem]">
                      {reservation.lotNumber}
                    </span>
                  ) : null}
                  <span className="text-ink font-mono text-[0.8125rem]">
                    {readable(reservation.quantityBase)} {reservation.baseUnitSymbol}
                  </span>

                  {/* Status as a word — colour alone would fail WCAG 1.4.1, and
                      "timed out" and "released" mean different things to whoever
                      is asking why the stock came back. */}
                  <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                    {STATUS_LABEL[reservation.status] ?? reservation.status}
                  </span>

                  {reservation.isOverdue ? (
                    <span className="text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      Past its time
                    </span>
                  ) : null}
                </div>

                <p className="text-muted mt-1.5 text-[0.8125rem]">
                  On {reservation.locationName} · held by {reservation.createdByName ?? 'someone'} ·{' '}
                  {reservation.status === 'ACTIVE'
                    ? `until ${formatClinicDateTime(reservation.expiresAt, timezone, timeFormat)}`
                    : reservation.releasedAt
                      ? // ⚠️ NO NAME MEANS THE SWEEP DID IT, WHICH IS A FACT AND
                        //   NOT A MISSING VALUE. The column is deliberately NULL
                        //   in that case, and the two readings lead somewhere
                        //   different: one person changed their mind, the other
                        //   nobody came back.
                        `${reservation.releasedByName ? `released by ${reservation.releasedByName}` : 'released automatically'} on ${formatClinicDateTime(reservation.releasedAt, timezone, timeFormat)}`
                      : ''}
                </p>

                {reservation.notes ? (
                  <p className="text-muted mt-1 text-[0.8125rem]">{reservation.notes}</p>
                ) : null}

                {canReserve && reservation.status === 'ACTIVE' ? (
                  <ReleaseButton slug={slug} reservationId={reservation.id} />
                ) : null}
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

/**
 * ⚠️ THE BUTTON SAYS "GIVE IT BACK", NOT "RELEASE", AND THE ACTION IT CALLS IS
 *   NAMED release. The interface names what the person controls; the codebase
 *   names the movement type the ledger records. A pharmacist is putting stock
 *   back into the dispensable pool, which is what they would say out loud.
 */
function ReleaseButton({ slug, reservationId }: { slug: string; reservationId: string }) {
  const [state, action, pending] = useActionState<StockFormState>(
    releaseReservationAction.bind(null, slug, reservationId),
    IDLE_FORM
  );

  return (
    <form action={action} className="mt-2">
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Giving it back…' : 'Give it back'}
      </Button>
      {state.status === 'error' && state.message ? (
        <p className="text-danger mt-1.5 text-[0.8125rem]" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
