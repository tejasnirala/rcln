import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { StorageProfileSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { LocationForm } from '@/components/tenant/location-form';

export const metadata: Metadata = {
  title: 'Add a location',
};

/**
 * <slug>.rcln.com/stock/locations/new
 *
 * ⚠️ THE BRANCH LIST COMES FROM THE SESSION, NOT FROM `GET /v1/branches`. It has
 *   to be the branches this caller may actually work in — the service refuses
 *   anything else with NOT FOUND — and `branchesInScope` is the one place that
 *   answers that question. Offering a branch the save will reject is a form that
 *   fails after the user has filled it in.
 */
export default async function NewLocationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.INVENTORY_LOCATION_MANAGE)) {
    return (
      <Alert tone="error">
        You cannot add locations here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();

  const [branches, storageProfiles] = await Promise.all([
    branchesInScope(slug),
    api<{ profiles: StorageProfileSummary[] }>('/api/v1/storage-profiles', { slug, accessToken }),
  ]);

  if (branches.length === 0) {
    return <Alert tone="error">You have no branches in scope at this clinic.</Alert>;
  }

  return (
    <LocationForm
      slug={slug}
      branches={branches}
      storageProfiles={storageProfiles.data?.profiles ?? []}
    />
  );
}
