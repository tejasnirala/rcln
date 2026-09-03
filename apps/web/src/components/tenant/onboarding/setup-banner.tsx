import Link from 'next/link';
import type { AuthSession } from '@rcln/contracts';
import { PERMISSIONS as P } from '@rcln/permissions';

/**
 * "Setup is not finished" — for everyone who is not the person who can finish it.
 *
 * ⚠️ IT LIVES IN THE LAYOUT, NOT ON A PAGE, for the reason `VerifyPrompt` and the
 *   impersonation strip do: a banner that can be missing from one screen is a
 *   banner nobody trusts.
 *
 * ⚠️ AND IT RENDERS ONLY FOR PEOPLE WHO CANNOT ACT ON IT. Whoever holds
 *   `organization.onboarding.write` has already been redirected to the wizard by
 *   the layout, so showing them a banner too would be telling somebody standing
 *   in a room that they should go to it. This is for the receptionist who logged
 *   in first, so that a half-configured app is explained rather than confusing.
 *
 * A server component: it reads the session the layout already resolved and holds
 * no state.
 */
export function SetupBanner({ session }: { session: AuthSession }) {
  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );

  if (!membership || membership.setupComplete) return null;
  // The wizard is one redirect away for them; they do not need telling twice.
  if (session.permissions.includes(P.ORG_ONBOARDING_WRITE)) return null;

  return (
    <div className="border-rule bg-drape-tint/50 border-b">
      <p className="px-gutter text-drape-deep mx-auto max-w-7xl py-2 text-[0.875rem]">
        This clinic is still being set up, so some things are not switched on yet. Whoever manages
        the clinic can finish it in{' '}
        <Link href="/settings" className="underline underline-offset-2">
          Clinic settings
        </Link>
        .
      </p>
    </div>
  );
}
