'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Standing in for a payment provider's hosted page.
 *
 * Deliberately plain, and deliberately not wearing rcln's clothes: it is meant
 * to look like somewhere else, because that is what it is standing in for and
 * because nobody should ever mistake it for the product.
 *
 * Each button produces a genuinely signed webhook on the API, which goes through
 * the same signature check, the same deduplication ledger and the same handler a
 * real delivery would. Nothing here shortcuts any of that — see the header of
 * apps/api/src/services/billing/webhook.service.ts.
 */

type Outcome = 'SUCCEED' | 'DECLINE' | 'ABANDON' | 'STALL';

const CHOICES: {
  outcome: Outcome;
  label: string;
  note: string;
  variant: 'primary' | 'secondary' | 'ghost';
}[] = [
  {
    outcome: 'SUCCEED',
    label: 'Pay',
    note: 'The money clears. The subscription activates when the webhook lands.',
    variant: 'primary',
  },
  {
    outcome: 'DECLINE',
    label: 'Decline the card',
    note: 'The issuer says no. Nothing is granted; a renewal would start dunning.',
    variant: 'secondary',
  },
  {
    outcome: 'STALL',
    label: 'Leave it pending',
    note: 'What a UPI collect request does while somebody finds their phone. The return page waits.',
    variant: 'secondary',
  },
  {
    outcome: 'ABANDON',
    label: 'Walk away',
    note: 'The page is closed without paying. The intent expires.',
    variant: 'ghost',
  },
];

export function SandboxCheckout() {
  const params = useSearchParams();
  const kind = params.get('kind') === 'mandate' ? 'mandate' : 'charge';
  const id = params.get('id');
  const returnUrl = params.get('return');

  const [sending, setSending] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replayed, setReplayed] = useState(false);

  if (!id) {
    return (
      <Shell>
        <Alert tone="error">This sandbox link is missing its payment reference.</Alert>
      </Shell>
    );
  }

  // Captured after the guard above, so the closures below have a `string` rather
  // than re-narrowing `id` on every use.
  const reference = id;

  async function send(outcome: Outcome, eventId?: string): Promise<void> {
    setSending(outcome);
    setError(null);

    try {
      const response = await fetch(
        `${process.env['NEXT_PUBLIC_API_URL'] ?? ''}/api/v1/webhooks/payments/mock/simulate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, id: reference, outcome, ...(eventId ? { eventId } : {}) }),
        }
      );

      if (!response.ok) {
        setError('The sandbox endpoint refused that. Is PAYMENT_PROVIDER=mock?');
        setSending(null);
        return;
      }

      if (eventId) {
        // A replay: stay here so the operator can see it was deduplicated.
        setReplayed(true);
        setSending(null);
        return;
      }

      // Back to the clinic, exactly as a real provider would send them.
      if (returnUrl) {
        const target = new URL(returnUrl);
        target.searchParams.set('intent', reference);
        window.location.assign(target.toString());
      }
    } catch {
      setError('The sandbox endpoint could not be reached.');
      setSending(null);
    }
  }

  return (
    <Shell>
      <p className="text-muted text-sm">Sandbox payment provider</p>
      <h1 className="text-ink mt-1 text-2xl font-semibold">
        {kind === 'mandate' ? 'Authorise automatic payments' : 'Confirm your payment'}
      </h1>
      <p className="text-muted mt-2 font-mono text-xs break-all">{id}</p>

      <Alert tone="warning" className="mt-6">
        No money moves here. This page stands in for a real gateway so the whole subscription flow
        can be exercised — including the parts that fail.
      </Alert>

      {error ? (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {replayed ? (
        <div className="mt-4">
          <Alert tone="info">
            Sent again with the same event id. The API answered <code>duplicate</code> — the ledger
            refused to apply it twice.
          </Alert>
        </div>
      ) : null}

      <ul className="mt-6 space-y-3">
        {CHOICES.map((choice) => (
          <li key={choice.outcome} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ink text-sm font-medium">{choice.label}</p>
              <p className="text-muted mt-0.5 text-[0.8125rem]">{choice.note}</p>
            </div>
            <Button
              size="sm"
              variant={choice.variant}
              className="shrink-0"
              disabled={sending !== null}
              onClick={() => void send(choice.outcome)}
            >
              {sending === choice.outcome ? 'Sending…' : choice.label}
            </Button>
          </li>
        ))}
      </ul>

      <div className="border-rule mt-8 border-t pt-6">
        <p className="text-ink text-sm font-medium">Deliver the same event twice</p>
        <p className="text-muted mt-0.5 text-[0.8125rem]">
          At-least-once is the only guarantee a real provider offers. This sends one
          <code> charge.succeeded</code> with a fixed event id, twice — the second must be refused
          by the deduplication ledger rather than granting another period.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          disabled={sending !== null}
          onClick={() => {
            void (async () => {
              await send('SUCCEED', `replay-${reference}`);
              await send('SUCCEED', `replay-${reference}`);
            })();
          }}
        >
          Send it twice
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-16">
      <div className="border-rule bg-card rounded-lg border p-8 shadow-sm">{children}</div>
    </main>
  );
}
