'use client';

import { useActionState, useRef } from 'react';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { PharmacyFormState } from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';
import { IDLE_FORM } from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/**
 * One thing that can happen to an order next, as a form.
 *
 * ⚠️ THIS IS THE ONLY CLIENT COMPONENT ON THE ORDER SCREEN, AND THAT IS THE
 *   POINT OF IT BEING ITS OWN FILE. `useActionState` is the single reason any of
 *   that page needs to run in the browser; the rail, the address, the lines and
 *   the shipment are presentation over data the server already has. The first
 *   draft put `'use client'` at the top of the 460-line screen and shipped all
 *   of it to run four forms (PI-12 review).
 *
 * ⚠️ THE ACTION ARRIVES ALREADY BOUND. The server component does
 *   `confirmOnlineOrderAction.bind(null, slug, order.id)` — so the slug and the
 *   id are closed over on the server and never become form fields a client could
 *   edit into somebody else's order.
 *
 * ⚠️ AND THE ERRORS ARE RENDERED AGAINST THE FIELDS. `useOutcomeFocus` moves the
 *   user to the first invalid input on a failed submit, and `fieldErrors` is
 *   passed down so each control can carry its own — an error on screen but
 *   unlinked does not exist to a screen reader (AGENTS.md).
 */
export function OnlineOrderActionCard({
  title,
  blurb,
  submitLabel,
  variant,
  action,
  children,
}: {
  title: string;
  blurb: string;
  submitLabel: string;
  variant?: 'secondary';
  action: (previous: PharmacyFormState, form: FormData) => Promise<PharmacyFormState>;
  children: (errors: Record<string, string[]> | undefined) => React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<PharmacyFormState, FormData>(
    action,
    IDLE_FORM
  );

  useOutcomeFocus(state.status, formRef);

  return (
    <section className="border-rule bg-card space-y-3 rounded-md border p-4">
      <h2 className="text-ink text-[0.9375rem] font-medium">{title}</h2>
      <p className="text-muted max-w-prose text-[0.875rem]">{blurb}</p>

      {state.status === 'error' ? (
        <Alert tone="error">
          <p>{state.message}</p>
          {state.ruleMessages?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {state.ruleMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <form ref={formRef} action={formAction} className="space-y-3">
        {children(state.fieldErrors)}
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? 'Working…' : submitLabel}
        </Button>
      </form>
    </section>
  );
}
