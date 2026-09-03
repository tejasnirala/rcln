import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReportCurrencyTotal } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timeFormatOf, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ReportView } from '@/components/tenant/report-view';
import { REPORT_PATHS, REPORT_SPECS } from '@/lib/report-specs';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ reportKey: string }>;
}): Promise<Metadata> {
  const { reportKey } = await params;
  return { title: REPORT_SPECS[reportKey]?.title ?? 'Report' };
}

/**
 * Every query parameter the API will honour, and nothing else.
 *
 * ⚠️ AN ALLOW-LIST RATHER THAN A PASS-THROUGH OF `searchParams`. Forwarding the
 *   whole query would forward `format` too — and `format=csv` from the address
 *   bar would make this Server Component render a CSV body into a React tree
 *   while ALSO skipping the export permission, because a JSON page never asks
 *   for it. The CSV has its own route, and it forces `format` itself.
 */
const FORWARDED = [
  'branchId',
  'page',
  'sortBy',
  'sortOrder',
  'from',
  'to',
  'basis',
  'clock',
  'groupBy',
  'hold',
  'kind',
  'idleDays',
  'minValueMinor',
  'includeInTransit',
  'includeNonSellable',
  'productId',
  'categoryId',
  'supplierId',
  'procedureItemId',
] as const;

/**
 * The last full calendar month, in UTC, for a dated report opened cold.
 *
 * ⚠️ IT USED TO SAY THIS AND COMPUTE THE CURRENT MONTH. `getUTCMonth()` for the
 *   start and `getUTCMonth() + 1, 0` for the end is 1–30 September on the 2nd of
 *   September: one day of data and twenty-eight days of future, with nothing on
 *   the screen to say the window was not the one the sentence promised. An
 *   accountant opening "what did last month cost" read a near-empty table as an
 *   answer. The comment was the intent; the code now matches it. (PI-24 review.)
 */
function defaultWindow(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  /* Day 0 of this month is the last day of the previous one, and it handles
   * January correctly because `Date.UTC` normalises the month. */
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

interface ReportResponse {
  reportKey: string;
  generatedAt: string;
  window: { from: string; to: string } | null;
  page: number;
  limit: number;
  total: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
  totals?: ReportCurrencyTotal[];
  procedureFeeIncluded?: boolean;
}

/**
 * <slug>.rcln.com/reports/<key>
 *
 * ⚠️ THE PERMISSION IS RE-CHECKED HERE ONLY TO PRODUCE A SENTENCE. The API
 *   settles it; this saves a round trip and turns a bare 403 into something
 *   naming the code to ask for. It is deliberately the SAME code the catalogue
 *   reported, read from one place — `report-specs.ts` does not carry
 *   permissions for exactly that reason.
 *
 * NO PHI.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; reportKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug, reportKey }, query] = await Promise.all([params, searchParams]);

  const spec = REPORT_SPECS[reportKey];
  const path = REPORT_PATHS[reportKey];
  if (!spec || !path) notFound();

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  /* The clinic's zone and clock for every `datetime` column — see ReportView's
   * `timeZone` prop for why these are not optional. */
  const [timeZone, timeFormat] = await Promise.all([timezoneOf(slug), timeFormatOf(slug)]);

  const search = new URLSearchParams();
  for (const key of FORWARDED) {
    const value = query[key];
    // A repeated parameter arrives as an array. Take the first rather than
    // joining, which would send `BATCH,MOVING_AVERAGE` to an enum and 400.
    const single = Array.isArray(value) ? value[0] : value;
    if (single) search.set(key, single);
  }

  if (spec.dated && (!search.get('from') || !search.get('to'))) {
    const fallback = defaultWindow();
    if (!search.get('from')) search.set('from', fallback.from);
    if (!search.get('to')) search.set('to', fallback.to);
  }

  const report = await api<ReportResponse>(`/api/v1${path}?${search.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!report.ok || !report.data) {
    return (
      <Alert tone="error">
        {report.message ?? 'This report could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  const data = report.data;
  const exportSearch = new URLSearchParams(search);
  exportSearch.delete('page');

  return (
    <Suspense fallback={null}>
      {/*
      ⚠️ SUSPENSE BECAUSE THE CHILD CALLS `useSearchParams`. Next's docs are
         explicit that a STATIC page reading it without a boundary fails the
         production BUILD. This route is dynamic today — its page reads cookies
         through `getSession` — so nothing breaks, but CLAUDE.md forbids
         `pnpm build` as a verification step, which means that trap would be
         sprung by a deploy rather than by anything we run. The boundary costs
         nothing and removes it. (PI-24 review.)
    */}
      <ReportView
        reportKey={reportKey}
        spec={spec}
        rows={data.rows}
        totals={data.totals ?? []}
        page={data.page}
        limit={data.limit}
        total={data.total}
        generatedAt={data.generatedAt}
        window={data.window}
        canExport={permissions.includes(PERMISSIONS.REPORT_EXPORT)}
        exportHref={`/reports/${reportKey}/export?${exportSearch.toString()}`}
        timeZone={timeZone}
        timeFormat={timeFormat}
        /*
         * ⚠️ THE ONE REPORT THAT SAYS WHAT IT IS NOT, ON THE SCREEN. The response
         *   carries `procedureFeeIncluded: false` as a hard fact rather than as
         *   documentation, and this is where a reader meets it — above the table,
         *   before they read a contribution figure as profit.
         */
        extraNote={
          data.procedureFeeIncluded === false
            ? 'Materials only. The procedure’s own fee is not in these figures — nothing in this product prices one procedure differently from another.'
            : undefined
        }
      />
    </Suspense>
  );
}
