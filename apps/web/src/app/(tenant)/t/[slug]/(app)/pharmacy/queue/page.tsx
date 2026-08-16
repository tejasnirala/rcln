import type { Metadata } from 'next';
import type { PrescriptionQueueResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PrescriptionQueue } from '@/components/tenant/prescription-queue';
import { pharmacyAccess } from '../guard';

export const metadata: Metadata = { title: 'Waiting' };

/** ⚠️ PHI: every row names a patient. The API logs one data-access row per request. */
export default async function PharmacyQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await pharmacyAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to the dispensary here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const search = new URLSearchParams();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of ['branchId', 'status', 'from', 'to', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, queue] = await Promise.all([
    branchesInScope(slug),
    api<PrescriptionQueueResponse>(`/api/v1/pharmacy/queue?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!queue.ok) {
    return (
      <Alert tone="error">
        {queue.message ?? 'The queue could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <PrescriptionQueue
      items={queue.data?.items ?? []}
      meta={queue.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
    />
  );
}
