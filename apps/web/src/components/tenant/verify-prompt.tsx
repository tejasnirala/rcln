import Link from 'next/link';
import type { AuthSession } from '@rcln/contracts';

/**
 * One line in the shell when a contact detail is still unconfirmed.
 *
 * DELIBERATELY NOT AN ALARM
 *   An unverified address is not a fault — the account works, the clinic runs.
 *   So this is `drape-tint`, the informational surface, and not `signal`, which
 *   the palette reserves for the thing happening right now. Spending the warm
 *   colour on a standing notice is what makes it stop meaning anything.
 *
 * NOT DISMISSIBLE, BECAUSE IT DOES NOT NEED TO BE
 *   Dismissal would need somewhere to remember the dismissal, and the thing that
 *   makes this go away is thirty seconds of work that the strip links straight
 *   to. It disappears when both channels are confirmed.
 *
 * A channel the account does not have is not asked for: a user with no phone
 * number is not nagged to confirm one that does not exist.
 */
export function VerifyPrompt({ session }: { session: AuthSession }) {
  const outstanding = [
    session.user.email && !session.user.emailVerified ? 'email address' : null,
    session.user.phone && !session.user.phoneVerified ? 'phone number' : null,
  ].filter((value): value is string => value !== null);

  if (outstanding.length === 0) return null;

  return (
    <div className="border-rule bg-drape-tint/60 border-b">
      <p className="px-gutter text-ink mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[0.8125rem]">
        <span>
          Confirm your {outstanding.join(' and your ')} so we can reach you and you can get back in
          if you are locked out.
        </span>
        {/* An ordinary in-app link: the proxy runs for the RSC request this
            makes, so `hardNavigate` is not needed here. py-1 keeps the target
            above the 24px minimum (apps/web/AGENTS.md). */}
        <Link
          href="/verify"
          className="text-drape-deep hover:text-ink py-1 font-medium underline underline-offset-2"
        >
          Confirm now
        </Link>
      </p>
    </div>
  );
}
