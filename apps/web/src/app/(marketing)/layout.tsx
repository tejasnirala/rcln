import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';

/**
 * The apex domain (rcln.com). Tenants never reach this layout — src/proxy.ts
 * rewrites `<slug>.rcln.com` into the (tenant) group before rendering.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* First thing in the tab order, so the nav can be skipped. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
