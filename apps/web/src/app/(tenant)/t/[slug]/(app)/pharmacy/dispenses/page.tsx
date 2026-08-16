import type { Metadata } from 'next';
import type { DispenseListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DispenseList } from '@/components/tenant/dispense-list';
import { pharmacyAccess } from '../guard';

export const metadata: Metadata = { title: 'Dispensed' };

/** ⚠️ PHI: every row names a patient, except a counter sale. */
export default async function DispensesPage({
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
  for (const key of ['branchId', 'kind', 'status', 'patientId', 'from', 'to', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [branches, dispenses] = await Promise.all([
    branchesInScope(slug),
    api<DispenseListResponse>(`/api/v1/pharmacy/dispenses?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!dispenses.ok) {
    return (
      <Alert tone="error">
        {dispenses.message ?? 'Dispensing records could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <DispenseList
      dispenses={dispenses.data?.dispenses ?? []}
      meta={dispenses.data?.meta ?? { page: 1, limit: 20, total: 0, totalPages: 1 }}
      branches={branches}
    />
  );
}
