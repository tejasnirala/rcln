import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type {
  AffectedPartyResponse,
  ForwardTraceResponse,
  RecallCandidatesResponse,
  RecallDetail as RecallDetailShape,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timeFormatOf, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductRecallDetail } from '@/components/tenant/product-recall-detail';
import { recallAccess } from '../guard';

export const metadata: Metadata = { title: 'Recall notice' };

/**
 * One notice: what it covers, what has been pulled, and who already has it.
 *
 * ⚠️ THE AFFECTED-PARTY LIST IS FETCHED ONLY IF THE CALLER HOLDS
 *   `recall.trace.patients`, AND NOT MERELY HIDDEN AFTERWARDS. Fetching it and
 *   rendering nothing would file a `data_access_logs` row for a disclosure that
 *   never happened, which corrupts the one table a disclosure review reads.
 *
 * ⚠️ THE COUNT COMES FROM THE FORWARD TRACE INSTEAD, which names nobody and is
 *   served under the ordinary read code. That is what lets somebody without the
 *   patient permission see that 29 people are affected — and therefore know to
 *   ask a colleague — without seeing one of them.
 */
export default async function RecallDetailPage({
  params,
}: {
  params: Promise<{ slug: string; recallId: string }>;
}) {
  const { slug, recallId } = await params;
  const access = await recallAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to recall notices here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const recall = await api<RecallDetailShape>(`/api/v1/recalls/${recallId}`, { slug, accessToken });

  if (recall.status === 404) notFound();
  if (!recall.ok || !recall.data) {
    return (
      <Alert tone="error">
        {recall.message ?? 'This could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  const detail = recall.data;

  const [candidates, affected, traces, timeZone, timeFormat] = await Promise.all([
    access.canCreate
      ? api<RecallCandidatesResponse>(`/api/v1/recalls/${recallId}/candidates`, {
          slug,
          accessToken,
        })
      : Promise.resolve({ ok: false, status: 200, data: undefined }),
    access.canSeePatients
      ? api<AffectedPartyResponse>(`/api/v1/traceability/affected?recallId=${recallId}&limit=100`, {
          slug,
          accessToken,
        })
      : Promise.resolve({ ok: false, status: 200, data: undefined }),
    /*
     * One forward trace per lot, purely for the head count. ⚠️ THE COUNTS ARE
     *   SUMMED RATHER THAN UNIONED, so a person who received two of the recalled
     *   lots is counted twice here — the figure is an upper bound and the screen
     *   says "people received one of these lots" rather than claiming a distinct
     *   headcount. The exact figure is the affected list's own total, which is
     *   only available to somebody who may see it.
     */
    Promise.all(
      detail.batches.map((lot) =>
        api<ForwardTraceResponse>(`/api/v1/traceability/forward?batchId=${lot.batchId}`, {
          slug,
          accessToken,
        })
      )
    ),
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  const patientCount = traces.reduce((total, trace) => total + (trace.data?.patientCount ?? 0), 0);

  return (
    <ProductRecallDetail
      slug={slug}
      recall={detail}
      candidates={candidates.ok && candidates.data ? candidates.data : null}
      affected={affected.ok && affected.data ? affected.data : null}
      patientCount={patientCount}
      timeZone={timeZone}
      timeFormat={timeFormat}
      canCreate={access.canCreate}
      canExecute={access.canExecute}
      canSeePatients={access.canSeePatients}
    />
  );
}
