import { getPlatformSession } from '@/lib/session';
import { listPlatformOrganizations } from '@/lib/platform';
import { Alert } from '@/components/ui/alert';
import { OrganizationList } from '@/components/platform/organization-list';

/**
 * Every clinic on the platform.
 *
 * The only list in the product that crosses the tenant boundary, and the way in
 * to impersonation. The gate is in `layout.tsx`; this page renders content only.
 */
export default async function PlatformOrganizations() {
  if (!(await getPlatformSession())) return null;

  // Memoised per request, and the layout's clinic selector has already asked for
  // it on this same render — so this costs nothing. See lib/platform.ts.
  const result = await listPlatformOrganizations();
  const organizations = result.data?.organizations ?? [];

  return (
    <>
      <p className="eyebrow text-drape">Clinics</p>
      <h1 className="font-display mt-2 text-3xl tracking-tight">
        {organizations.length === 1 ? 'One clinic' : `${organizations.length} clinics`} on rcln.
      </h1>
      <p className="text-muted mt-3 max-w-2xl text-[0.9375rem] leading-relaxed">
        Entering a clinic signs you in there as rcln staff, with full read and write access. The
        session ends after eight hours, or after thirty minutes idle. It needs a reason, and both
        the entry and everything you change land in that clinic&rsquo;s own audit trail under your
        name.
      </p>

      {!result.ok ? (
        <Alert tone="error" className="mt-8">
          {result.message ?? 'We could not load the clinic list.'}
        </Alert>
      ) : (
        <div className="mt-8">
          <OrganizationList organizations={organizations} />
        </div>
      )}
    </>
  );
}
