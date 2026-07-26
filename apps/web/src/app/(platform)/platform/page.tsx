import type { Metadata } from 'next';
import { ADMIN_HOST, api } from '@/lib/api';
import { getAccessToken, getPlatformSession } from '@/lib/session';
import { PlatformLogin } from '@/components/platform/platform-login';
import { DemoRequestList, type DemoRequest } from '@/components/platform/demo-request-list';
import { PlatformSignOut } from '@/components/platform/platform-sign-out';

export const metadata: Metadata = {
  title: 'Platform',
  robots: { index: false, follow: false },
};

/**
 * Super-admin console, served from admin.<root-domain>.
 *
 * Deliberately a separate route tree: different auth path, different risk
 * profile, and it must never share a bundle with the tenant app.
 *
 * `resolveTenant` skips this host by name, so nothing here carries an
 * organization. Access is `users.is_platform_admin` and nothing else, enforced
 * by the API — this page's own check decides what to render, not what is
 * allowed. Every tenant entry from here is audited.
 */
export default async function PlatformHome() {
  const session = await getPlatformSession();

  if (!session) {
    return (
      <div className="px-gutter flex min-h-dvh flex-col items-center justify-center py-10">
        <div className="w-full max-w-md">
          <p className="eyebrow">rcln</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Platform console</h1>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            For rcln staff. Clinic accounts sign in at their own address.
          </p>
          <div className="mt-8">
            <PlatformLogin />
          </div>
        </div>
      </div>
    );
  }

  const accessToken = await getAccessToken();
  const result = await api<DemoRequest[]>('/api/v1/platform/demo-requests', {
    host: ADMIN_HOST,
    accessToken,
  });

  const requests = result.data ?? [];
  const open = requests.filter((r) => r.status !== 'CONVERTED' && r.status !== 'SPAM').length;

  return (
    <div className="min-h-dvh">
      <header className="border-rule bg-card border-b">
        <div className="px-gutter mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 py-4">
          <span className="text-ink font-display text-lg">rcln</span>
          <span className="bg-signal-tint text-signal rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]">
            platform
          </span>
          <div className="ml-auto flex items-center gap-4">
            <span className="text-muted text-[0.8125rem]">{session.user.fullName}</span>
            <PlatformSignOut />
          </div>
        </div>
      </header>

      <main id="main" className="px-gutter mx-auto max-w-6xl py-12">
        <p className="eyebrow text-drape">Demo requests</p>
        <h1 className="font-display mt-2 text-3xl tracking-tight">
          {open === 0
            ? 'Nothing waiting.'
            : `${open} clinic${open === 1 ? '' : 's'} waiting to hear back.`}
        </h1>
        <p className="text-muted mt-3 max-w-2xl text-[0.9375rem] leading-relaxed">
          Provisioning creates the clinic exactly as self-serve signup would — organization,
          subdomain, first location, owner and trial, in one transaction. The audit trail records
          that you did it rather than them.
        </p>

        {!result.ok ? (
          <p
            role="alert"
            className="ring-signal/25 bg-signal-tint text-signal mt-8 rounded-md px-4 py-3 text-[0.8125rem] ring-1"
          >
            {result.message ?? 'We could not load the demo requests.'}
          </p>
        ) : (
          <div className="mt-8">
            <DemoRequestList requests={requests} />
          </div>
        )}
      </main>
    </div>
  );
}
