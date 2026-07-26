import type { Metadata } from 'next';
import { getSession } from '@/lib/session';
import { ContactVerification } from '@/components/tenant/contact-verification';

export const metadata: Metadata = {
  title: 'Contact details',
};

/**
 * <slug>.rcln.com/verify
 *
 * No permission gate and no fetch of its own: this screen shows the caller their
 * own email address and phone number, both of which are already on the session
 * the `(app)` layout resolved. `getSession` is memoised per request, so reading
 * it again here is free.
 *
 * The layout has already redirected an unauthenticated visitor, but the type
 * does not know that — hence the guard below, which is unreachable in practice.
 */
export default async function VerifyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);

  if (!session) return null;

  /**
   * The development master code, surfaced so nobody has to grep the API log.
   *
   * Read on the SERVER and passed down as a plain prop, so the variable itself
   * never reaches the browser bundle — it has no NEXT_PUBLIC_ prefix, which is
   * what makes that guarantee (see lib/api.ts). In production the API refuses to
   * boot with it set, compose only defines it on the dev anchor, and the
   * `NODE_ENV` guard means this renders nothing regardless.
   */
  const masterCode =
    process.env.NODE_ENV === 'production'
      ? null
      : (process.env['DEV_MASTER_VERIFICATION_CODE'] ?? null);

  return (
    <ContactVerification
      slug={slug}
      masterCode={masterCode}
      channels={[
        {
          channel: 'email',
          label: 'Email address',
          destination: session.user.email,
          verified: session.user.emailVerified,
        },
        {
          channel: 'phone',
          label: 'Phone number',
          destination: session.user.phone,
          verified: session.user.phoneVerified,
        },
      ]}
    />
  );
}
