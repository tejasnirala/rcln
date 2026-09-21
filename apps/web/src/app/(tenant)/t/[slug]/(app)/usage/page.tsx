import type { Metadata } from 'next';
import type { ConsumptionListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsumptionRecordList } from '@/components/tenant/consumption-record-list';
import { usageAccess } from './guard';

export const metadata: Metadata = { title: 'What procedures used' };

/**
 * <slug>.rcln.com/usage — everything that came off a trolley, newest first.
 *
 * ⚠️ PHI: every row names a patient and the products used on them. The API
 *   writes one `data_access_logs` row for the list, with a count and no name.
 *
 * ⚠️ THE VARIANCE FILTER IS THE POINT OF THE SCREEN AND IS NOT THE DEFAULT. A
 *   clinic reconciling a store wants everything; a clinic asking "where are our
 *   templates wrong" wants the departures. Defaulting to variances would hide
 *   the ordinary record from the person looking for one specific procedure, so
 *   the filter is offered and the list starts complete.
 *
 * ⚠️ RECORDING IS NOT DONE FROM HERE, AND THAT IS DELIBERATE. What was used is
 *   recorded against the consultation it happened at, on the consultation's own
 *   page, because the anchor is what makes the record traceable — a form here
 *   would have to ask which patient and which procedure, which is a question the
 *   clinician standing in the room has already answered.
 */
export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await usageAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to what procedures used here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = new URLSearchParams();
  for (const key of [
    'branchId',
    'kind',
    'patientId',
    'productId',
    'varianceOnly',
    'from',
    'to',
    'page',
  ]) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, records, timeZone] = await Promise.all([
    branchesInScope(slug),
    api<ConsumptionListResponse>(`/api/v1/consumption/records?${search.toString()}`, {
      slug,
      accessToken,
    }),
    timezoneOf(slug),
  ]);

  if (!records.ok || !records.data) {
    return (
      <Alert tone="error">
        {records.message ?? 'This could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ConsumptionRecordList
      records={records.data.items}
      meta={records.data}
      branches={branches}
      timeZone={timeZone}
    />
  );
}
