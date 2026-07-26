import type { Metadata } from 'next';
import { Section, SectionHead } from '@/components/marketing/section';
import { SignupForm } from '@/components/marketing/signup-form';

export const metadata: Metadata = {
  title: 'Start a clinic',
  description:
    'Register your clinic on rcln. Your own address, your first location, and a 14-day trial.',
  alternates: { canonical: '/signup' },
};

/**
 * rcln.com/signup — the apex, deliberately.
 *
 * `signup` is in the reserved-subdomain list (apps/web/src/proxy.ts), so it can
 * never be a tenant, and registration is pre-tenant anyway: the organization it
 * creates is the tenant. It ends by handing the browser to the new subdomain,
 * because a session cookie is host-only and the apex cannot sign anyone in.
 */
export default function SignupPage() {
  return (
    <Section>
      <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHead
            eyebrow="Start a clinic"
            title="Set up your clinic in four steps."
            lead="Name it, pick its address, add your first location, and create your account. You will be signed in on your own subdomain a minute from now."
          />

          <dl className="border-rule mt-10 grid gap-5 border-t pt-8">
            <div>
              <dt className="text-ink text-[0.9375rem] font-medium">14 days, no card</dt>
              <dd className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
                Nothing renews on its own. Add billing when you decide to stay.
              </dd>
            </div>
            <div>
              <dt className="text-ink text-[0.9375rem] font-medium">Your own address</dt>
              <dd className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
                Your clinic gets its own subdomain and its own sign-in, separate from every other
                clinic on rcln.
              </dd>
            </div>
            <div>
              <dt className="text-ink text-[0.9375rem] font-medium">One location to start</dt>
              <dd className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
                Add more locations, staff and roles once you are in.
              </dd>
            </div>
          </dl>
        </div>

        <div className="max-w-2xl">
          <SignupForm />
        </div>
      </div>
    </Section>
  );
}
