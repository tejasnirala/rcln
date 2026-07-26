import type { Metadata } from 'next';
import { ClinicFinder } from '@/components/marketing/clinic-finder';
import { Section, SectionHead } from '@/components/marketing/section';

export const metadata: Metadata = {
  title: 'Log in',
  description: 'Go to your clinic’s rcln sign-in page.',
  alternates: { canonical: '/login' },
  // Nothing here is worth indexing, and the tenant pages behind it must not be.
  robots: { index: false, follow: true },
};

/**
 * rcln.com/login — the step before signing in, not the sign-in itself.
 * See the header comment in ClinicFinder for why the apex cannot log anyone in.
 */
export default function LoginPage() {
  return (
    <Section>
      <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-20">
        <SectionHead
          eyebrow="Sign in"
          title="Which clinic are you signing in to?"
          lead="Every clinic on rcln has its own address and its own sign-in. Tell us yours and we will take you to it."
        />
        <div className="max-w-md">
          <ClinicFinder />
        </div>
      </div>
    </Section>
  );
}
