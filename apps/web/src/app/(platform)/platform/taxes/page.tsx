import type { Metadata } from 'next';
import { getPlatformSession } from '@/lib/session';
import { listTaxRegistrations } from '@/lib/platform';
import { Alert } from '@/components/ui/alert';
import { TaxRegistrationList } from '@/components/platform/tax-registration-list';

export const metadata: Metadata = {
  title: 'Tax',
};

/**
 * Where rcln collects tax.
 *
 * The gate is in `layout.tsx`; this page renders content only, matching the
 * other console pages.
 *
 * It is deliberately blunt about consequence. Every other screen in the console
 * reports state; this one changes what customers are charged, with no publish
 * step between the save and the next invoice.
 */
export default async function PlatformTaxes() {
  if (!(await getPlatformSession())) return null;

  const result = await listTaxRegistrations();
  const registrations = result.data?.registrations ?? [];
  const live = registrations.filter((registration) => registration.isLive).length;

  return (
    <>
      <p className="eyebrow text-drape">Tax</p>
      <h1 className="font-display mt-2 text-3xl tracking-tight">
        {live === 0
          ? 'rcln collects tax nowhere.'
          : `rcln collects tax in ${String(live)} ${live === 1 ? 'place' : 'places'}.`}
      </h1>
      <p className="text-muted mt-3 max-w-2xl text-[0.9375rem] leading-relaxed">
        A registration here says rcln holds one with that authority. From the moment it is saved,
        every clinic whose place of supply it covers is charged — and tax collected where we are not
        registered cannot be remitted to anybody. Where there is no registration, invoices are
        issued untaxed and record why.
      </p>
      <p className="text-muted mt-3 max-w-2xl text-[0.9375rem] leading-relaxed">
        A registration can cover a whole country, or one state or province within it. Both are
        normal: most VAT regimes issue one national number, while India issues a GSTIN per state.
        Where both exist, the narrower one wins for clinics inside it.
      </p>

      {!result.ok ? (
        <Alert tone="error" className="mt-8">
          {result.message ?? 'We could not load the tax registrations.'}
        </Alert>
      ) : (
        <div className="mt-8">
          <TaxRegistrationList registrations={registrations} />
        </div>
      )}
    </>
  );
}
