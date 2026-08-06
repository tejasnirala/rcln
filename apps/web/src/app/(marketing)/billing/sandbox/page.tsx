import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SandboxCheckout } from '@/components/tenant/sandbox-checkout';

export const metadata: Metadata = {
  title: 'Sandbox payment',
  robots: { index: false, follow: false },
};

/**
 * The mock provider's hosted checkout page.
 *
 * ⚠️ DEVELOPMENT ONLY. It cannot exist in production — `PAYMENT_PROVIDER=mock`
 *   aborts the API's boot there (apps/api/src/config/index.ts), the simulate
 *   endpoint 404s, and this page 404s too. Three independent guards, because
 *   what it does is mark a payment succeeded without any money.
 *
 * WHY IT IS A REAL SCREEN AND NOT AN AUTO-REDIRECT
 *   The point of the mock provider is that the seams a stub removes are exactly
 *   where the bugs live: the customer leaving and coming back before the webhook
 *   lands, the webhook arriving first, the page abandoned mid-flow. A page an
 *   operator has to actually click makes all three reproducible on demand — and
 *   "Decline" and "Leave without paying" are one click each, which is the only
 *   way anyone ever tests those paths.
 *
 * It lives on the apex rather than on a tenant subdomain because that is where
 * a real provider's page would be: somewhere else entirely. Coming back to the
 * clinic's own host is part of what is being exercised.
 */
export default function SandboxPage() {
  // Belt and braces. The API refuses the simulate call in production anyway, so
  // this page would be inert — but a page that renders payment buttons in
  // production is a support ticket regardless of whether they work.
  if (process.env.NODE_ENV === 'production') notFound();

  return <SandboxCheckout />;
}
