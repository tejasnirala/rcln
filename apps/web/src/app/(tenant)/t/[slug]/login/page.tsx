import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/marketing/wordmark';
import { LoginForm } from '@/components/tenant/login-form';

export const metadata: Metadata = {
  title: 'Log in',
  // A tenant's sign-in page must never be indexed — it would publish the
  // customer list one search result at a time.
  robots: { index: false, follow: false },
};

/**
 * <slug>.rcln.com/login — reached only via the proxy rewrite in src/proxy.ts.
 *
 * The slug is shown but deliberately not checked against the database here. The
 * page renders identically for a clinic that exists and one that does not, so it
 * cannot be used to ask "is this clinic an rcln customer?" — the same reason
 * CONVENTIONS.md requires 404 rather than 403 for an unknown tenant.
 */
export default async function TenantLoginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <div className="flex min-h-dvh flex-col px-gutter py-10">
      <Link href="/" className="text-ink hover:text-drape self-start transition-colors">
        <Wordmark />
        <span className="sr-only">Go to the start of this clinic</span>
      </Link>

      <main id="main" className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-md">
          <p className="eyebrow">Signing in to</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">
            <span className="font-mono text-[0.9em]">{slug}</span>
          </h1>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            Use the email or phone number your clinic registered for you.
          </p>

          <div className="mt-8">
            <LoginForm slug={slug} />
          </div>

          <p className="text-muted mt-6 text-[0.8125rem] leading-relaxed">
            Locked out, or never received an invitation? Ask whoever manages rcln at your clinic —
            they can re-send it. Support cannot reset a password on your behalf.
          </p>
        </div>
      </main>
    </div>
  );
}
