'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useActionState, useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import type {
  BranchSummary,
  ChargeQueueSummary,
  ChargeRequestListResponse,
  ChargeRequestSummary,
} from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ChargesNav } from '@/components/tenant/charges-nav';
import {
  billChargesAction,
  decideChargeAction,
  IDLE_CHARGE_FORM,
  type ChargeFormState,
} from '@/app/(tenant)/t/[slug]/(app)/charges/actions';

/**
 * What has been supplied and not yet billed.
 *
 * ⚠️ THE SIGNATURE OF THIS SCREEN IS THE GAP RAIL DOWN THE LEFT OF EACH ROW, AND
 *   IT IS NOT DECORATION. A charge can be missing a price, missing a tax
 *   category, or waiting on a human, and those three are the only reasons a
 *   supply does not reach a bill on its own. The rail encodes which — one mark
 *   per reason, in a fixed position, so the shape of the list tells you at a
 *   glance whether today's problem is the price list or the accountant. A status
 *   pill would flatten three different jobs into one word.
 *
 * ⚠️ PHI ON EVERY ROW. The list itself writes a `data_access_logs` row with a
 *   count and no patient, which is why there is no name search here and why every
 *   filter is an id, a date or an enum.
 *
 * ⚠️ SELECTION IS PER PATIENT AND PER BRANCH, AND THE SCREEN ENFORCES IT BEFORE
 *   THE SERVER DOES. An invoice is addressed to one person and numbered at one
 *   branch; the server refuses a mixed set with a sentence, and a checkbox that
 *   let somebody build one would make that sentence the first they hear of it.
 */

const STATUSES = [
  { value: 'PENDING', label: 'Waiting' },
  { value: 'INVOICED', label: 'Billed' },
  { value: 'SUPPRESSED', label: 'Not charged' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: '', label: 'Any state' },
];

const POLICY_LABEL: Record<string, string> = {
  NEVER_BILL: 'Never billed',
  INCLUDED_IN_SERVICE: 'In the service fee',
  SEPARATELY_BILLABLE: 'Billed separately',
  OPTIONAL: 'Someone decides',
  CONTRACT_DEFINED: 'The payer decides',
  JURISDICTION_CONFIGURED: 'The rules decide',
};

const SCOPE_LABEL: Record<string, string> = {
  PRODUCT: 'this product',
  PRODUCT_CATEGORY: 'its category',
  PRODUCT_TYPE: 'its kind',
  DEFAULT: 'the default',
};

/** The three reasons a charge cannot go on a bill as it stands. */
function gapsOf(charge: ChargeRequestSummary): string[] {
  const gaps: string[] = [];
  if (charge.unitPriceMinor === null) gaps.push('No price');
  if (charge.taxCategory === null) gaps.push('Not classified for tax');
  if (charge.decidedAt === null && POLICY_NEEDS_DECISION.has(charge.policy)) {
    gaps.push('Waiting on a decision');
  }
  return gaps;
}

const POLICY_NEEDS_DECISION = new Set(['OPTIONAL', 'CONTRACT_DEFINED', 'JURISDICTION_CONFIGURED']);

interface Props {
  slug: string;
  charges: ChargeRequestSummary[];
  meta: ChargeRequestListResponse;
  summary: ChargeQueueSummary;
  branches: BranchSummary[];
  canDecide: boolean;
  canBill: boolean;
}

export function ChargeQueue({ slug, charges, meta, summary, branches, canDecide, canBill }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [billState, bill, billing] = useActionState<ChargeFormState, FormData>(
    billChargesAction.bind(null, slug),
    IDLE_CHARGE_FORM
  );

  const setFilter = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      next.delete('page');
      /* Changing the filter changes what is on screen, so a stale tick would
         bill something the person can no longer see. */
      setSelected(new Set());
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  const goToPage = useCallback(
    (page: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (page <= 1) next.delete('page');
      else next.set('page', String(page));
      setSelected(new Set());
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  /**
   * ⚠️ ONE PATIENT AND ONE BRANCH PER BILL, DECIDED BY THE FIRST TICK. Everything
   *   that cannot join the current selection is disabled rather than hidden — a
   *   row that vanished when you ticked its neighbour would read as a bug, and
   *   the disabled state is what teaches the rule.
   */
  const anchor = useMemo(
    () => charges.find((charge) => selected.has(charge.id)) ?? null,
    [charges, selected]
  );

  const canJoin = useCallback(
    (charge: ChargeRequestSummary): boolean => {
      if (charge.status !== 'PENDING' || charge.kind === 'REVERSAL') return false;
      if (charge.unitPriceMinor === null) return false;
      if (charge.decidedAt === null && POLICY_NEEDS_DECISION.has(charge.policy)) return false;
      if (!anchor) return true;
      return (
        charge.patientId === anchor.patientId &&
        charge.branchId === anchor.branchId &&
        charge.currency === anchor.currency
      );
    },
    [anchor]
  );

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedTotal = charges
    .filter((charge) => selected.has(charge.id))
    .reduce((sum, charge) => sum + (charge.estimatedTotalMinor ?? 0), 0);

  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);
  /*
   * Derived rather than sent. The list contracts elsewhere carry a `meta` with a
   * `totalPages`; this one returns the four fields the other charging lists do,
   * and a fifth field that is `ceil(total / limit)` is a number that can
   * disagree with the two it comes from — the same argument `balanceDueMinor`
   * makes on an invoice.
   */
  const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Waiting to be billed
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          What has been handed over and has not reached a bill yet.
        </p>
      </header>

      <ChargesNav />

      {/*
        The header counts, in the order somebody triages them: what is waiting,
        what cannot proceed, and what it is worth. `Not charged` is deliberately
        shown beside them rather than hidden — a suppressed charge and a missed
        one look identical in a revenue figure and are entirely different
        problems.
      */}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Waiting" value={String(summary.pending)} />
        <Stat
          label="Cannot proceed"
          value={String(summary.needsAttention)}
          tone={summary.needsAttention > 0 ? 'warning' : 'plain'}
        />
        <Stat label="Not charged" value={String(summary.suppressed)} />
        <Stat
          label="Waiting value"
          value={formatMoney(money(summary.estimatedValueMinor, summary.currency))}
        />
      </dl>

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
          value={searchParams.get('status') ?? 'PENDING'}
          options={STATUSES}
          onChange={(event) => setFilter({ status: event.target.value })}
        />
        <Select
          label="Show"
          name="needsAttention"
          value={searchParams.get('needsAttention') ?? ''}
          options={[
            { value: '', label: 'Everything' },
            { value: 'true', label: 'Only what cannot proceed' },
          ]}
          onChange={(event) => setFilter({ needsAttention: event.target.value })}
        />
        <Input
          label="Supplied on or after"
          name="from"
          type="date"
          value={searchParams.get('from') ?? ''}
          onChange={(event) => setFilter({ from: event.target.value })}
        />
      </div>

      {billState.status === 'error' ? (
        <Alert tone="error">{billState.message}</Alert>
      ) : billState.status === 'saved' && billState.createdId ? (
        <Alert tone="success">
          Invoice raised.{' '}
          <Link className="underline" href={`/invoices/${billState.createdId}`}>
            Open it
          </Link>
        </Alert>
      ) : null}

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        <p className="text-muted mb-3 text-[0.8125rem]" role="status">
          {meta.total === 0
            ? 'Nothing matches these filters.'
            : `Showing ${from}–${to} of ${meta.total}`}
        </p>

        {charges.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-10 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing is waiting to be billed.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Charges appear here as the dispensary hands things over. Anything the clinic never
              bills for — gloves, dressings — is recorded and settled without reaching this list.
            </p>
          </div>
        ) : (
          <form action={bill}>
            <ul className="space-y-2">
              {charges.map((charge) => (
                <ChargeRow
                  key={charge.id}
                  slug={slug}
                  charge={charge}
                  checked={selected.has(charge.id)}
                  selectable={canBill && canJoin(charge)}
                  onToggle={() => toggle(charge.id)}
                  canDecide={canDecide}
                />
              ))}
            </ul>

            {canBill && selected.size > 0 ? (
              /*
                ⚠️ STICKY, BECAUSE THE DECISION IS MADE AT THE BOTTOM OF A LONG
                  LIST AND ACTED ON AT THE TOP. The count and the total are
                  repeated in the button's own label so the confirmation and the
                  action are the same sentence.
              */
              <div className="border-rule bg-card sticky bottom-4 mt-6 flex flex-wrap items-center justify-between gap-4 rounded-md border p-4 shadow-sm">
                <div>
                  <p className="text-ink text-[0.9375rem]">
                    {selected.size} {selected.size === 1 ? 'charge' : 'charges'} for{' '}
                    {anchor?.patientName ?? 'a counter sale'}
                  </p>
                  <p className="text-muted text-[0.8125rem]">
                    About {formatMoney(money(selectedTotal, summary.currency))} before tax and any
                    discount
                  </p>
                </div>
                {[...selected].map((id) => (
                  <input key={id} type="hidden" name="chargeRequestId" value={id} />
                ))}
                <button
                  type="submit"
                  disabled={billing}
                  className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
                >
                  {billing ? 'Raising…' : 'Raise one invoice'}
                </button>
              </div>
            ) : null}
          </form>
        )}

        {totalPages > 1 ? (
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
              Page {meta.page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(meta.page + 1)}
              disabled={meta.page >= totalPages}
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

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'warning';
}) {
  return (
    <div className="border-rule bg-card rounded-md border p-4">
      <dt className="text-muted text-[0.8125rem]">{label}</dt>
      <dd
        className={
          tone === 'warning'
            ? 'text-warning mt-1 text-[1.375rem] tabular-nums'
            : 'text-ink mt-1 text-[1.375rem] tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function ChargeRow({
  slug,
  charge,
  checked,
  selectable,
  onToggle,
  canDecide,
}: {
  slug: string;
  charge: ChargeRequestSummary;
  checked: boolean;
  selectable: boolean;
  onToggle: () => void;
  canDecide: boolean;
}) {
  const gaps = gapsOf(charge);
  const [decideState, decide, deciding] = useActionState<ChargeFormState, FormData>(
    decideChargeAction.bind(null, slug, charge.id),
    IDLE_CHARGE_FORM
  );

  const awaitingDecision =
    charge.status === 'PENDING' &&
    charge.decidedAt === null &&
    POLICY_NEEDS_DECISION.has(charge.policy);

  return (
    <li className="border-rule bg-card rounded-md border">
      <div className="flex flex-wrap items-start gap-4 p-4">
        {/*
          The gap rail. One mark per unmet requirement, in a fixed position, so a
          column of them down the page says what today's problem is. Absent
          entirely when the charge is ready — an empty rail is the quiet state.
        */}
        <span aria-hidden className="flex w-1 shrink-0 flex-col gap-1 self-stretch">
          {gaps.map((gap) => (
            <span key={gap} className="bg-warning flex-1 rounded-full" />
          ))}
        </span>

        <input
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          onChange={onToggle}
          aria-label={`Bill ${charge.description} for ${charge.patientName ?? 'this counter sale'}`}
          className="mt-1 shrink-0 disabled:opacity-30"
        />

        <span className="min-w-48 flex-1">
          <span className="text-ink block text-[0.9375rem]">
            {charge.description}
            {charge.kind === 'REVERSAL' ? <span className="text-muted"> · returned</span> : null}
          </span>
          <span className="text-muted block text-[0.8125rem]">
            {charge.patientName ?? 'Counter sale'} · {charge.quantity} {charge.unitSymbol}
            {charge.dispenseNumber ? ` · ${charge.dispenseNumber}` : ''}
          </span>
          <span className="text-muted mt-1 block text-[0.8125rem]">
            {POLICY_LABEL[charge.policy] ?? charge.policy}, from {SCOPE_LABEL[charge.policyScope]}
          </span>
        </span>

        <span className="text-right">
          <span className="text-ink block text-[0.9375rem] tabular-nums">
            {charge.estimatedTotalMinor === null
              ? '—'
              : formatMoney(money(charge.estimatedTotalMinor, charge.currency))}
          </span>
          {gaps.length > 0 ? (
            <span className="text-warning block text-[0.8125rem]">{gaps.join(' · ')}</span>
          ) : charge.invoiceNumber ? (
            <span className="text-muted block text-[0.8125rem]">{charge.invoiceNumber}</span>
          ) : charge.suppressedReason ? (
            <span className="text-muted block text-[0.8125rem]">{charge.suppressedReason}</span>
          ) : null}
        </span>
      </div>

      {canDecide && awaitingDecision ? (
        <form action={decide} className="border-rule flex flex-wrap items-end gap-3 border-t p-4">
          <p className="text-muted flex-1 text-[0.8125rem]">
            The policy leaves this one to a person. Approving it puts it on the next bill; it is not
            billed until somebody raises one.
          </p>
          <input type="hidden" name="decision" value="BILL" />
          <button
            type="submit"
            disabled={deciding}
            className="border-rule text-ink hover:border-drape rounded-md border px-3 py-2 text-[0.875rem] disabled:opacity-50"
          >
            {deciding ? 'Saving…' : 'Approve'}
          </button>
        </form>
      ) : null}

      {decideState.status === 'error' ? (
        <p className="text-danger border-rule border-t px-4 py-2 text-[0.8125rem]">
          {decideState.message}
        </p>
      ) : null}
    </li>
  );
}
