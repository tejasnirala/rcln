import { ADMIN_HOST, api } from '@/lib/api';
import { getAccessToken, getPlatformSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DemoRequestList, type DemoRequest } from '@/components/platform/demo-request-list';

/**
 * The demo pipeline — who has asked for an account and not got one yet.
 *
 * The gate and the chrome are in `layout.tsx`, which has already refused
 * anybody without the platform flag. This page renders content only.
 *
 * `resolveTenant` skips this host by name, so nothing here carries an
 * organization. Access is `users.is_platform_admin` and nothing else, enforced
 * by the API — the layout's check decides what to render, not what is allowed.
 */
export default async function PlatformHome() {
  // Already refused by the layout; the guard is for the type, not the security.
  if (!(await getPlatformSession())) return null;

  const accessToken = await getAccessToken();
  const result = await api<DemoRequest[]>('/api/v1/platform/demo-requests', {
    host: ADMIN_HOST,
    accessToken,
  });

  const requests = result.data ?? [];
  const open = requests.filter((r) => r.status !== 'CONVERTED' && r.status !== 'SPAM').length;

  return (
    <>
      <p className="eyebrow text-drape">Demo requests</p>
      <h1 className="font-display mt-2 text-3xl tracking-tight">
        {open === 0
          ? 'Nothing waiting.'
          : `${open} clinic${open === 1 ? '' : 's'} waiting to hear back.`}
      </h1>
      <p className="text-muted mt-3 max-w-2xl text-[0.9375rem] leading-relaxed">
        Provisioning creates the clinic exactly as self-serve signup would — organization,
        subdomain, first location, owner and trial, in one transaction. The audit trail records that
        you did it rather than them.
      </p>

      {!result.ok ? (
        <Alert tone="error" className="mt-8">
          {result.message ?? 'We could not load the demo requests.'}
        </Alert>
      ) : (
        <div className="mt-8">
          <DemoRequestList requests={requests} />
        </div>
      )}
    </>
  );
}
