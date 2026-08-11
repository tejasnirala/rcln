import type { Metadata } from 'next';
import type {
  OrganizationProfile,
  RolePairingListResponse,
  SettingListResponse,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { loadFeeSchedule } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';
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

  const [organization, settings, pairings, session, fees, branches] = await Promise.all([
    api<OrganizationProfile>('/api/v1/organization', { slug, accessToken }),
    api<SettingListResponse>('/api/v1/organization/settings', { slug, accessToken }),
    // 403 for anyone without iam.designation.manage, which simply removes the
    // section — a third permission this page renders around rather than errors on.
    api<RolePairingListResponse>('/api/v1/designations/pairings', { slug, accessToken }),
    // React-cached, and the layout already called it for this render — free.
    getSession(slug),
    /*
     * The org-wide sheet, so the fee grid paints with prices rather than
     * fetching them a beat later. Null for anyone without
     * `billing.fee_schedule.read`, which removes the section rather than
     * erroring the page — the same treatment the titles section gets.
     */
    loadFeeSchedule(slug, {}),
    branchesInScope(slug),
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
      rolePairings={pairings.ok ? (pairings.data?.roles ?? null) : null}
      fees={fees}
      branches={branches}
      canEditOrganization={permissions.includes('organization.update')}
      canEditSettings={permissions.includes('settings.organization.write')}
      canEditFees={permissions.includes(PERMISSIONS.FEE_SCHEDULE_MANAGE)}
      canReadHistory={permissions.includes(PERMISSIONS.AUDIT_READ)}
    />
  );
}
