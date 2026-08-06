'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CheckoutCallbacks, CheckoutHandoff } from './provider-checkout';

/**
 * The sandbox provider's "widget" — the same choices as its hosted page, inline.
 *
 * WHY THIS EXISTS RATHER THAN FALLING BACK TO THE REDIRECT IN DEVELOPMENT
 *   If the mock had no embedded mode, `PAYMENT_PROVIDER=mock` would quietly take
 *   the redirect path and the widget branch would only ever run against a real
 *   gateway. That is the arrangement that lets a broken checkout reach
 *   production: the flow everyone develops against is not the flow that ships.
 *
 * IT TAKES NO SHORTCUT. Each button asks the API to emit a genuinely signed
 * webhook, which goes through the same signature check, the same deduplication
 * ledger and the same handler a real delivery would — see the header of
 * `apps/api/src/services/billing/webhook.service.ts`. Nothing here marks
 * anything paid, and this component is dead code in production because the API
 * refuses to boot with the mock provider.
 */

type Outcome = 'SUCCEED' | 'DECLINE' | 'STALL';

const CHOICES: { outcome: Outcome; label: string; note: string }[] = [
  {
    outcome: 'SUCCEED',
    label: 'Pay',
    note: 'The money clears and the subscription activates when the webhook lands.',
  },
  {
    outcome: 'DECLINE',
    label: 'Decline the card',
    note: 'The issuer says no. Nothing is granted.',
  },
  {
    outcome: 'STALL',
    label: 'Leave it pending',
    note: 'What a UPI collect request does while somebody finds their phone.',
  },
];

export function MockCheckout({
  handoff,
  callbacks,
}: {
  handoff: CheckoutHandoff;
  callbacks: CheckoutCallbacks;
}) {
  const [sending, setSending] = useState<Outcome | null>(null);

  async function send(outcome: Outcome): Promise<void> {
    setSending(outcome);

    try {
      const response = await fetch(
        `${process.env['NEXT_PUBLIC_API_URL'] ?? ''}/api/v1/webhooks/payments/mock/simulate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'charge', id: handoff.embedded.token, outcome }),
        }
      );

      if (!response.ok) {
        setSending(null);
        callbacks.onError('The sandbox endpoint refused that. Is PAYMENT_PROVIDER=mock?');
        return;
      }

      // Every outcome goes to the return page, including the ones that did not
      // succeed — reconciling and then reporting the truth is exactly what a
      // real provider's return would do.
      callbacks.onDone();
    } catch {
      setSending(null);
      callbacks.onError('The sandbox endpoint could not be reached.');
    }
  }

  return (
    <div className="border-rule bg-paper mt-4 rounded-md border p-4">
      <p className="text-muted text-[0.8125rem] font-medium tracking-wide uppercase">
        Sandbox provider
      </p>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        Standing in for a real payment window. Pick what the bank does next.
      </p>

      <div className="mt-3 space-y-2">
        {CHOICES.map((choice) => (
          <div key={choice.outcome} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              type="button"
              variant={choice.outcome === 'SUCCEED' ? 'primary' : 'secondary'}
              disabled={sending !== null}
              onClick={() => void send(choice.outcome)}
            >
              {sending === choice.outcome ? 'Working…' : choice.label}
            </Button>
            <span className="text-muted text-[0.8125rem]">{choice.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
