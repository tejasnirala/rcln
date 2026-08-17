'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useActionState, useCallback, useTransition } from 'react';
import type { BranchSummary, ProductPriceListResponse } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ChargesNav } from '@/components/tenant/charges-nav';
import {
  deleteProductPriceAction,
  IDLE_CHARGE_FORM,
  type ChargeFormState,
} from '@/app/(tenant)/t/[slug]/(app)/charges/actions';

/**
 * What this clinic sells things for.
 *
 * ⚠️ THE BRANCH COLUMN IS THE WHOLE POINT OF THIS TABLE AND IS NOT A FILTER
 *   ARTEFACT. A row with no branch is the organization's default that every site
 *   inherits; a row with one is an override that beats it. Rendering both in one
 *   list, with the default explicitly labelled rather than shown as an empty
 *   cell, is what makes "why is this branch charging 45?" answerable by looking.
 *
 * ⚠️ NOT PHI. A price is a fact about a catalogue row, so this screen writes no
 *   `data_access_logs` row and its filters may name a product freely.
 *
 * ⚠️ NO CREATE FORM HERE, DELIBERATELY. A price is set from the PRODUCT — that is
 *   where somebody already has the item, its base unit and its packaging in front
 *   of them, and where the unit a price is "per" is a choice they can make
 *   sensibly. A create form on this screen would need its own product picker and
 *   its own unit picker, and would let somebody price a strip of something
 *   measured in millilitres. This list is the ledger of what has been set.
 */
interface Props {
  slug: string;
  prices: ProductPriceListResponse;
  branches: BranchSummary[];
  canManage: boolean;
}

export function ProductPriceList({ slug, prices, branches, canManage }: Props) {
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

  const from = prices.total === 0 ? 0 : (prices.page - 1) * prices.limit + 1;
  const to = Math.min(prices.page * prices.limit, prices.total);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Prices
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          What this clinic charges for the things it supplies. Set a price on the product itself;
          this is the list of what has been set.
        </p>
      </header>

      <ChargesNav />

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <Select
          label="Branch"
          name="branchId"
          value={searchParams.get('branchId') ?? ''}
          options={[
            { value: '', label: 'Every branch, and the clinic default' },
            ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
          ]}
          onChange={(event) => setFilter({ branchId: event.target.value })}
        />
      </div>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {prices.total === 0
            ? 'Nothing is priced yet.'
            : `Showing ${from}–${to} of ${prices.total}`}
        </p>

        {prices.items.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing has a price yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Open a product in the catalogue and set what it sells for. Until then, anything
              dispensed reaches the charge queue with no price and cannot be billed.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {prices.items.map((price) => (
              <PriceRow key={price.id} slug={slug} price={price} canManage={canManage} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PriceRow({
  slug,
  price,
  canManage,
}: {
  slug: string;
  price: ProductPriceListResponse['items'][number];
  canManage: boolean;
}) {
  const [state, remove, removing] = useActionState<ChargeFormState, FormData>(async () => {
    await deleteProductPriceAction(slug, price.id);
    return IDLE_CHARGE_FORM;
  }, IDLE_CHARGE_FORM);

  return (
    <li className="border-rule bg-card flex flex-wrap items-center gap-4 rounded-md border p-4">
      <span className="min-w-48 flex-1">
        <span className="text-ink block text-[0.9375rem]">{price.productName}</span>
        <span className="text-muted block text-[0.8125rem]">
          {/*
            ⚠️ THE DEFAULT SAYS SO IN WORDS. An empty cell here would read as
            missing data rather than as "this applies everywhere", which is the
            one thing somebody scanning this column needs to know.
          */}
          {price.branchName ?? 'Clinic default — every branch'} · per {price.unitSymbol}
        </span>
      </span>

      <span className="text-ink text-[0.9375rem] tabular-nums">
        {formatMoney(money(price.amountMinor, price.currency))}
      </span>

      {canManage ? (
        <form action={remove}>
          <button
            type="submit"
            disabled={removing}
            className="text-muted hover:text-danger text-[0.875rem] disabled:opacity-40"
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </form>
      ) : null}

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
    </li>
  );
}
