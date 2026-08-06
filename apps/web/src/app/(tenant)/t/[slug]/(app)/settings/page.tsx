import type { Metadata } from 'next';
import type { OrganizationProfile, SettingListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ClinicSettings } from '@/components/tenant/clinic-settings';

export const metadata: Metadata = {
  title: 'Clinic',
};

/**
 * <slug>.rcln.com/settings
 *
 * The auth guard, header and branch switcher come from the `(app)` layout.
 *
 * TWO REQUESTS, AND EITHER MAY BE REFUSED ON ITS OWN. Reading the clinic's
 * particulars and reading its configuration are separate permissions, so the
 * page asks for both, renders whichever came back, and says plainly when one is
 * missing. Fetched in parallel — one after the other would be a waterfall for no
 * reason, since neither depends on the other.
 *
 * The two write permissions are checked here as well, and passed down: a form
 * whose Save is going to be refused should not offer Save. The session's
 * permission list is resolved fresh per request by the API, never read from the
 * JWT, so this reflects a role change on the next page load.
 */
export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const accessToken = await getAccessToken();

  const [organization, settings, session] = await Promise.all([
    api<OrganizationProfile>('/api/v1/organization', { slug, accessToken }),
    api<SettingListResponse>('/api/v1/organization/settings', { slug, accessToken }),
    // React-cached, and the layout already called it for this render — free.
    getSession(slug),
  ]);

  if (!organization.ok && !settings.ok) {
    return (
      <Alert tone="error">
        {organization.status === 403
          ? 'You do not have access to this clinic’s settings. Ask an administrator here.'
          : (organization.message ?? 'Settings could not be loaded.')}
      </Alert>
    );
  }

  const permissions = session?.permissions ?? [];

  return (
    <ClinicSettings
      slug={slug}
      organization={organization.data ?? null}
      settings={settings.data?.settings ?? null}
      canEditOrganization={permissions.includes('organization.update')}
      canEditSettings={permissions.includes('settings.organization.write')}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
