import type { Metadata } from 'next';
import type { BackwardTraceResponse, ForwardTraceResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timeFormatOf, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { TraceabilityView } from '@/components/tenant/traceability-view';
import { recallAccess } from '../guard';

export const metadata: Metadata = { title: 'Trace a lot' };

/**
 * <slug>.rcln.com/product-recalls/trace — both directions of the same question.
 *
 * ⚠️ NOT PHI. The forward panel answers in counts; the backward panel is
 *   paperwork. Nobody is named on this screen, which is why it needs only the
 *   recall read code.
 */
export default async function TracePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await recallAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to traceability here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const raw = query['batchId'];
  const batchId = (Array.isArray(raw) ? raw[0] : raw) ?? '';

  const [timeZone, timeFormat] = await Promise.all([timezoneOf(slug), timeFormatOf(slug)]);

  if (batchId === '') {
    return (
      <TraceabilityView
        slug={slug}
        forward={null}
        backward={null}
        batchId=""
        message="Paste a lot id to see where it came from and where it went."
        timeZone={timeZone}
        timeFormat={timeFormat}
      />
    );
  }

  const accessToken = await getAccessToken();
  const [forward, backward] = await Promise.all([
    api<ForwardTraceResponse>(`/api/v1/traceability/forward?batchId=${batchId}`, {
      slug,
      accessToken,
    }),
    api<BackwardTraceResponse>(`/api/v1/traceability/backward?batchId=${batchId}`, {
      slug,
      accessToken,
    }),
  ]);

  return (
    <TraceabilityView
      slug={slug}
      forward={forward.ok && forward.data ? forward.data : null}
      backward={backward.ok && backward.data ? backward.data : null}
      batchId={batchId}
      message={
        forward.ok
          ? null
          : (forward.message ?? 'That lot could not be found. Check the id and try again.')
      }
      timeZone={timeZone}
      timeFormat={timeFormat}
    />
  );
}
