import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { OnboardingState } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { OnboardingWizard } from '@/components/tenant/onboarding/onboarding-wizard';

export const metadata: Metadata = { title: 'Set up your clinic' };

/**
 * The setup wizard's server half: fetch the state once, hand it down.
 *
 * The wizard is a client component because it holds which step you are on and
 * seven forms' worth of interaction. Everything it needs arrives in this one
 * response, so it fetches nothing itself.
 */
export default async function SetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await api<OnboardingState>('/api/v1/onboarding', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    /*
     * A 403 here means the caller lost the permission between the layout's check
     * and this fetch, which is a real race when somebody's roles change
     * mid-session. Sending them to the app is better than an error page for a
     * screen they are no longer meant to see.
     */
    if (result.status === 403) redirect('/');

    return (
      <Alert tone="error">
        {result.message ?? 'Setup could not be loaded. Refresh, or try again in a moment.'}
      </Alert>
    );
  }

  return <OnboardingWizard slug={slug} initialState={result.data} />;
}
