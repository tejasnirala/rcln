'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { InvitationPreview } from '@rcln/contracts';
import { Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { hardNavigate } from '@/lib/hard-navigate';
import { acceptInvitation, type JoinFormState } from '@/app/(tenant)/t/[slug]/join/actions';

const IDLE: JoinFormState = { status: 'idle' };

/**
 * Two forms behind one heading.
 *
 * Which one renders is the server's answer, not a tab the visitor picks:
 * `needsAccount` comes from the API, which is the only party that can safely
 * know whether the invited address already has a login. Offering the choice
 * would let anyone holding a forwarded link decide to overwrite the password of
 * an account that has nothing to do with this clinic.
 *
 * Both paths ask for a password, and the difference in what that password means
 * is the difference in the copy — "choose" versus "confirm".
 */
export function JoinForm({
  slug,
  token,
  invitation,
}: {
  slug: string;
  token: string;
  invitation: InvitationPreview;
}) {
  const [state, action, pending] = useActionState(
    acceptInvitation.bind(null, slug, token, invitation.needsAccount),
    IDLE
  );
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  useEffect(() => {
    // A real browser navigation, never router.push: `/` on this host is the
    // clinic home only after the proxy rewrite, and a client navigation
    // resolves it against the route tree and lands on the marketing page.
    if (state.status === 'joined') hardNavigate('/');
  }, [state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      {invitation.needsAccount ? (
        <div className="grid gap-5">
          <Input
            name="fullName"
            label="Your name"
            hint="How colleagues will see you in schedules and notes."
            errors={err('fullName')}
            required
            autoComplete="name"
          />
          <Input
            name="password"
            label="Choose a password"
            hint="At least 12 characters, with an uppercase letter and a digit."
            errors={err('password')}
            type="password"
            required
            autoComplete="new-password"
          />
        </div>
      ) : (
        <div className="grid gap-5">
          <p className="text-muted text-[0.875rem] leading-relaxed">
            You already have an rcln account for this address. Confirm your password and this clinic
            is added to it — you keep one login for both.
          </p>
          <Input
            name="password"
            label="Your rcln password"
            errors={err('password')}
            type="password"
            required
            autoComplete="current-password"
          />
        </div>
      )}

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      {/* The action keeps its name from the button through to the outcome. */}
      <Button type="submit" fullWidth className="mt-6" disabled={pending}>
        {pending ? 'Joining…' : `Join ${invitation.organizationName}`}
      </Button>

      <p className="text-muted mt-5 text-[0.8125rem] leading-relaxed">
        Joining gives you access to patient records at this clinic. Everything you do here is
        recorded against your name.
      </p>
    </form>
  );
}
