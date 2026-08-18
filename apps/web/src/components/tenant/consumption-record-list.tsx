'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { BranchSummary, ConsumptionSummary } from '@rcln/contracts';
import { formatClinicDateTime } from '@/lib/format';
import { UsageNav } from '@/components/tenant/usage-nav';

/**
 * What procedures used, newest first.
 *
 * ⚠️ THE VARIANCE IS THE COLUMN THIS SCREEN EXISTS FOR. A list of what was
 *   consumed is a stock report and lives in PI-22; what somebody opens THIS to
 *   answer is "where is what we expected not what happened" — so the departure
 *   is a badge on the row rather than a number three clicks in, and the filter
 *   for it is the first control.
 *
 * ⚠️ A CORRECTION IS SHOWN AS ITS OWN ROW, NOT FOLDED INTO THE ORIGINAL. It is
 *   its own record with its own author, its own reason and its own ledger legs —
 *   folding it in would present a corrected total as though somebody had written
 *   it once, which is the thing the compensating-entry discipline exists to stop
 *   anyone doing.
 *
 * ⚠️ PHI: every row names a patient. Nothing here is written to a URL, a cookie
 *   or `localStorage` — the filters carry ids, which is why there is a patient
 *   id filter and no patient name one.
 */
const KIND_LABEL: Record<ConsumptionSummary['kind'], string> = {
  CONSUMPTION: 'Used',
  ADDITIONAL_CONSUMPTION: 'More was used',
  CONSUMPTION_REVERSAL: 'Put back',
};

interface Props {
  records: ConsumptionSummary[];
  meta: { total: number; page: number; limit: number };
  branches: BranchSummary[];
  timeZone: string;
}

export function ConsumptionRecordList({ records, meta, branches, timeZone }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /* One filter changes, the page resets: page 4 of a narrower list is not page 4. */
  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          What procedures used
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Every material that came off a trolley, and how it compared with what the template
          expected.
        </p>
      </header>

      <UsageNav />

      <div className="flex flex-wrap items-end gap-3">
        {branches.length > 1 ? (
          <label className="text-[0.8125rem]">
            <span className="text-muted block pb-1">Branch</span>
            <select
              className="border-rule bg-card text-ink rounded-md border px-3 py-2 text-[0.875rem]"
              value={params.get('branchId') ?? ''}
              onChange={(event) => {
                setFilter('branchId', event.target.value);
              }}
            >
              <option value="">Everywhere I work</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex items-center gap-2 text-[0.875rem]">
          <input
            type="checkbox"
            checked={params.get('varianceOnly') === 'true'}
            onChange={(event) => {
              setFilter('varianceOnly', event.target.checked ? 'true' : '');
            }}
          />
          <span className="text-ink">Only where it differed from the template</span>
        </label>
      </div>

      {records.length === 0 ? (
        <p className="border-rule text-muted rounded-md border border-dashed p-6 text-[0.875rem]">
          Nothing has been recorded yet. What a procedure used is recorded on the consultation it
          happened at.
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((record) => (
            <li key={record.id} className="border-rule bg-card rounded-md border p-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <Link
                  href={`/consultations/${record.encounterId}`}
                  className="text-ink text-[0.9375rem] underline-offset-2 hover:underline"
                >
                  {record.procedureName ?? 'The consultation itself'}
                </Link>
                <span className="text-muted text-[0.8125rem]">{record.patientName}</span>
                <span className="text-muted ml-auto text-[0.8125rem]">
                  {formatClinicDateTime(record.occurredAt, timeZone)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
                  {KIND_LABEL[record.kind]}
                </span>
                <span className="text-muted text-[0.8125rem]">
                  {record.lineCount === 1 ? '1 item' : `${String(record.lineCount)} items`}
                </span>
                {record.hasVariance ? (
                  <span className="border-drape text-drape rounded-full border px-3 py-1 text-[0.8125rem]">
                    Differed from the template
                  </span>
                ) : null}
                {record.amendedAt === null ? null : (
                  <span className="text-muted text-[0.8125rem]">Restated</span>
                )}
                <span className="text-muted ml-auto text-[0.8125rem]">
                  {record.locationName} · {record.recordedByName}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-3 text-[0.875rem]">
          <PageLink label="Previous" page={meta.page - 1} disabled={meta.page <= 1} />
          <span className="text-muted">
            Page {meta.page} of {totalPages}
          </span>
          <PageLink label="Next" page={meta.page + 1} disabled={meta.page >= totalPages} />
        </nav>
      ) : null}
    </div>
  );

  function PageLink({ label, page, disabled }: { label: string; page: number; disabled: boolean }) {
    if (disabled) return <span className="text-muted opacity-50">{label}</span>;
    const next = new URLSearchParams(params.toString());
    next.set('page', String(page));
    return (
      <Link href={`${pathname}?${next.toString()}`} className="text-ink hover:underline">
        {label}
      </Link>
    );
  }
}
