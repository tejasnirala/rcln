import type { Metadata } from 'next';
import type { PharmacyDashboardResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PharmacyDashboard } from '@/components/tenant/pharmacy-dashboard';
import { pharmacyAccess } from './guard';

export const metadata: Metadata = { title: 'Dispensary' };

/**
 * The counter's front page.
 *
 * ⚠️ COUNTS ONLY — no patient, no medicine. See the component header: this is the
 *   screen a waiting room can see.
 */
export default async function PharmacyPage({
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
  const branchId = Array.isArray(query.branchId) ? query.branchId[0] : query.branchId;
  const search = new URLSearchParams();
  if (branchId) search.set('branchId', branchId);

  const [branches, dashboard] = await Promise.all([
    branchesInScope(slug),
    api<PharmacyDashboardResponse>(`/api/v1/pharmacy/dashboard?${search.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!dashboard.ok || !dashboard.data) {
    return (
      <Alert tone="error">
        {dashboard.message ?? 'The dispensary summary could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return <PharmacyDashboard dashboard={dashboard.data} branches={branches} />;
}
