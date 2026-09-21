'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { BranchSummary, PharmacyDashboardResponse } from '@rcln/contracts';
import { Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';

/**
 * The counter, at a glance.
 *
 * ⚠️ COUNTS ONLY, AND NOT ONE NAME. This is the screen most likely to be left
 *   open on a monitor a waiting room can see; "waiting: Mrs Rao — methadone"
 *   would be a disclosure to everybody standing behind her. Names are one click
 *   away, on a screen somebody chose to open — and that click writes a data-access
 *   row, which is the second reason the summary does not pre-empt it.
 *
 * ⚠️ THE STOCK TILES ARE WARNINGS, NOT STATISTICS, so they link to where the work
 *   is rather than to a chart. A lot expiring inside a month is an ordering
 *   decision; a quarantined or recalled lot is somebody's afternoon.
 */
interface Props {
  dashboard: PharmacyDashboardResponse;
  branches: BranchSummary[];
}

export function PharmacyDashboard({ dashboard, branches }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const tiles = [
    {
      label: 'Not looked at',
      value: dashboard.awaitingVerification,
      href: '/pharmacy/queue?status=NEW',
      hint: 'Signed prescriptions nobody has checked yet',
    },
    {
      label: 'Checked, waiting',
      value: dashboard.verifiedAwaitingSupply,
      href: '/pharmacy/queue?status=VERIFIED',
      hint: 'Ready to hand over',
    },
    {
      label: 'Part supplied',
      value: dashboard.partiallyDispensed,
      href: '/pharmacy/queue?status=PARTIALLY_DISPENSED',
      hint: 'Something is still owed',
    },
    {
      label: 'Dispensed today',
      value: dashboard.dispensedToday,
      href: '/pharmacy/dispenses',
      hint: 'Supplies made at this counter',
    },
    {
      label: 'Returns today',
      value: dashboard.returnsToday,
      href: '/pharmacy/dispenses?status=PARTIALLY_RETURNED',
      hint: 'Came back over the counter',
    },
    {
      label: 'Expiring in 30 days',
      value: dashboard.expiringSoonBatches,
      href: '/stock/lots',
      hint: 'Lots to use or order around',
    },
    {
      label: 'Quarantined lots',
      value: dashboard.quarantinedBatches,
      href: '/stock/lots',
      hint: 'Held, and not dispensable',
    },
    {
      label: 'Recalled lots',
      value: dashboard.recalledBatches,
      href: '/stock/lots',
      hint: 'Cannot be supplied from any route',
    },
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {dashboard.branchName} dispensary
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            What is waiting, what has gone out, and what on the shelf needs attention.
          </p>
        </div>
        {branches.length > 1 ? (
          <div className="w-64">
            <Select
              label="Branch"
              name="branchId"
              value={searchParams.get('branchId') ?? dashboard.branchId}
              options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams.toString());
                next.set('branchId', event.target.value);
                startTransition(() =>
                  router.replace(`${pathname}?${next.toString()}`, { scroll: false })
                );
              }}
            />
          </div>
        ) : null}
      </header>

      <PharmacyNav />

      <ul
        aria-busy={pending}
        className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${pending ? 'opacity-60 transition-opacity' : ''}`}
      >
        {tiles.map((tile) => (
          <li key={tile.label}>
            <Link
              href={tile.href}
              className="border-rule bg-card hover:border-drape block h-full rounded-md border p-4 transition-colors"
            >
              <span className="text-ink block text-[2rem] leading-none font-medium tabular-nums">
                {tile.value}
              </span>
              <span className="text-ink mt-2 block text-[0.9375rem]">{tile.label}</span>
              <span className="text-muted mt-1 block text-[0.8125rem]">{tile.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
