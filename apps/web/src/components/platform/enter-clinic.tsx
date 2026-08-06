'use client';

import { useEffect, useRef } from 'react';
import type { ImpersonationGrant } from '@rcln/contracts';
import { Button } from '@/components/ui/button';

/**
 * The handoff, and the only part of this feature that is genuinely unusual.
 *
 * The ticket has to reach the CLINIC's host, because that is the only host that
 * can be given a session cookie for the clinic — cookies here are host-only by
 * design (lib/session.ts). So the browser posts it there itself.
 *
 * A real form POST, not `fetch`: the response is a redirect that must land in the
 * address bar, and the Set-Cookie on it must stick to that host. It is a Route
 * Handler on the other end rather than a Server Action, because Next blocks
 * cross-origin Server Action requests and is right to.
 *
 * The target host is derived from the one in the address bar rather than rebuilt
 * from an environment variable, so the dev port comes along for free and the two
 * can never disagree about which domain this deployment is on.
 *
 * SHARED BY BOTH WAYS IN. The clinic list and the header's clinic selector both
 * end here. There is exactly one implementation of the host boundary crossing,
 * which is how it should be: it is the security-critical step, and two copies
 * would be two things to get right.
 */
export function EnterClinic({ grant }: { grant: ImpersonationGrant }) {
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const element = form.current;
    if (!element) return;

    /*
     * The DOM is the external system here, which is what an effect is for — and
     * why the target is written onto the form rather than held in state. Reading
     * `window.location` during a render would be impure, and a `setState` in an
     * effect body is a cascading render (react-hooks/set-state-in-effect).
     *
     * `admin.lvh.me:3000` -> `northwind.lvh.me:3000`.
     */
    const host = window.location.host.replace(/^[^.]+\./, `${grant.organizationSlug}.`);
    element.action = `${window.location.protocol}//${host}/impersonate`;
    element.submit();
  }, [grant.organizationSlug]);

  return (
    <form ref={form} method="POST" className="grid gap-3">
      <input type="hidden" name="handoffToken" value={grant.handoffToken} />
      <p role="status" aria-live="polite" className="text-ink text-[0.8125rem]">
        Opening {grant.organizationName}…
      </p>
      {/* Visible and usable if the automatic submit is blocked or JavaScript is
          slow. Not a fallback nobody can reach: it is the same submit. */}
      <div>
        <Button type="submit" size="sm" variant="secondary">
          Continue to {grant.organizationSlug}
        </Button>
      </div>
    </form>
  );
}
