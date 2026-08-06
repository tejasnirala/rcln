'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney, money } from '@rcln/payments/money';
import type { EmbeddedCheckout, PurchaseSummary } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatLongDate } from '@/lib/format';
import { MockCheckout } from './mock-checkout';
import { RazorpayCheckout } from './razorpay-checkout';

/**
 * Paying without leaving the clinic's own page.
 *
 * ⚠️ THIS DIRECTORY IS THE ENTIRE PLACE `apps/web` IS ALLOWED TO KNOW WHICH
 *    ACQUIRER IS CONFIGURED. It is the frontend mirror of
 *    `packages/payments/src/providers/`, and it exists for the same reason: a
 *    widget cannot be rendered without loading that provider's script, so the
 *    name has to reach the browser — but it reaches exactly one directory. A
 *    provider name anywhere else under `src/` is the bug this arrangement is
 *    meant to make obvious.
 *
 * ⚠️ NOTHING HERE DECIDES THAT A PAYMENT SUCCEEDED, INCLUDING THE WIDGET'S OWN
 *    SUCCESS CALLBACK.
 *   Razorpay hands its handler a payment id and a signature, and it is tempting
 *   to treat that as proof. It is not: it arrives from the customer's browser,
 *   which is the one participant in this flow with a motive. The callback is
 *   used for one thing — knowing when to navigate — and the outcome is settled
 *   by the signature-verified webhook, with `/billing/return` reconciling
 *   directly against the provider for anything the webhook has not landed yet.
 *
 *   Which means the client-side signature verification Razorpay documents is
 *   deliberately absent. Verifying it and then trusting it would be strictly
 *   weaker than not trusting it at all.
 *
 * WHAT A CUSTOMER TYPES, AND WHERE
 *   Card number, expiry and CVV are entered inside the provider's overlay and
 *   travel from the browser straight to them. They never touch this markup, this
 *   JS or our servers — which is what keeps rcln at PCI DSS SAQ-A, and is worth
 *   saying on screen because it is the one thing somebody hesitating at a
 *   payment form actually wants to know.
 */

export interface CheckoutHandoff {
  embedded: EmbeddedCheckout;
  /** Our id for this attempt. The return page reconciles against it. */
  intentId: string;
  amountMinor: number;
  currency: string;
  /**
   * What the invoice says this buys. Server-supplied, never derived here — see
   * `PurchaseSummary` in `@rcln/contracts` for why a screen must not compute its
   * own service period.
   */
  purchase?: PurchaseSummary | undefined;
  /**
   * The billing contact, for the widget's prefill.
   *
   * The signed-in user's own details, returned to their own browser. Razorpay
   * shows fewer UPI options to a checkout with no contact, which is what keeps
   * the "UPI ID" field hidden behind the QR.
   */
  customer?: { name: string; email: string; phone?: string } | undefined;
}

/** What each adapter reports back. Success is "navigate now", nothing more. */
export interface CheckoutCallbacks {
  onDone: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

type Phase =
  | { state: 'open' }
  | { state: 'cancelled' }
  | { state: 'error'; message: string }
  | { state: 'done' };

export function ProviderCheckout({ handoff }: { handoff: CheckoutHandoff }) {
  const [phase, setPhase] = useState<Phase>({ state: 'open' });
  /*
   * Bumped to re-mount the adapter, which is how "try again" re-opens a widget
   * the customer dismissed. Re-running an effect would need the adapter to track
   * whether it had already opened; a new key just gives it a fresh mount.
   */
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null);

  const onDone = useCallback(() => {
    setPhase({ state: 'done' });
    /*
     * The return page does the actual work: it asks the provider directly, then
     * polls, because a UPI collect request legitimately sits pending for minutes.
     * A full assignment rather than a router push so the back button lands on
     * billing rather than back inside a completed checkout.
     */
    window.location.assign(
      `/billing/return?intent=${encodeURIComponent(handoff.intentId)}&kind=charge`
    );
  }, [handoff.intentId]);

  const onCancel = useCallback(() => {
    setPhase({ state: 'cancelled' });
    // Focus follows the state change, or a keyboard user is left where the
    // dismissed overlay used to be with nothing focused.
    requestAnimationFrame(() => retryRef.current?.focus());
  }, []);

  const onError = useCallback((message: string) => {
    setPhase({ state: 'error', message });
    requestAnimationFrame(() => retryRef.current?.focus());
  }, []);

  const amount = format(handoff.amountMinor, handoff.currency);
  const live = phase.state === 'open' || phase.state === 'done';

  return (
    <section
      aria-labelledby="checkout-heading"
      className="border-rule bg-card mt-4 rounded-lg border p-6"
    >
      <p
        id="checkout-heading"
        className="text-muted text-[0.8125rem] font-medium tracking-wide uppercase"
      >
        Payment
      </p>

      {/*
        What is being bought, in the invoice's own words.

        The same dt/dd shape as the upgrade quote above it, so a customer who has
        seen one recognises the other — and so the tax line, when there is one,
        has an obvious place to sit between the subtotal and the total.
      */}
      {handoff.purchase ? (
        <>
          <h3 className="font-display text-ink mt-1 text-lg">{handoff.purchase.description}</h3>
          <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
            Covers {formatLongDate(handoff.purchase.periodStart)} to{' '}
            {formatLongDate(handoff.purchase.periodEnd)}.
          </p>

          <dl className="mt-4 space-y-2 text-[0.875rem]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{handoff.purchase.description}</dt>
              <dd className="text-ink font-mono">
                {format(handoff.purchase.subtotalMinor, handoff.currency)}
              </dd>
            </div>

            {/*
              One line per tax, named as the jurisdiction names it. CGST and SGST
              are two lines because they are two taxes to two authorities — a
              single "Tax" row is not a compliant Indian invoice, and this screen
              shows what the invoice will say.
            */}
            {handoff.purchase.taxLines.map((line) => (
              <div key={line.name} className="flex justify-between gap-4">
                <dt className="text-muted">
                  {line.name} <span className="font-mono">{rate(line.rateBps)}</span>
                </dt>
                <dd className="text-ink font-mono">{format(line.amountMinor, handoff.currency)}</dd>
              </div>
            ))}

            <div className="border-rule flex justify-between gap-4 border-t pt-2">
              <dt className="text-ink font-medium">Due now</dt>
              <dd className="text-ink font-mono font-medium">
                {format(handoff.purchase.totalMinor, handoff.currency)}
              </dd>
            </div>
          </dl>

          {/*
            Why there is no tax, when there is none. A zero-tax total with no
            explanation reads as a bug to whoever is looking at it, and support
            will otherwise be answering it from a screenshot.
          */}
          {handoff.purchase.taxLines.length === 0 ? (
            <p className="text-muted mt-2 text-[0.8125rem] leading-relaxed">
              {handoff.purchase.taxNote}
            </p>
          ) : null}

          <p className="text-muted mt-2 font-mono text-[0.75rem]">
            <span className="sr-only">Invoice number </span>
            {handoff.purchase.invoiceNumber}
          </p>
        </>
      ) : (
        <p className="text-ink mt-1 font-mono text-lg">{amount}</p>
      )}

      {/*
        The one reassurance worth the space, and it is a fact rather than a
        flourish: it is true precisely because we use the provider's overlay
        instead of building our own card fields.
      */}
      <p className="text-muted mt-2 text-[0.8125rem] leading-relaxed">
        Your card details are entered on {label(handoff.embedded.provider)}&rsquo;s secure form and
        never reach rcln.
      </p>

      {/* Announced, not just shown — the widget is an overlay a screen reader
          user may have dismissed without seeing what replaced it. */}
      <div aria-live="polite" className="mt-4">
        {live && (
          <p className="text-muted text-[0.8125rem] leading-relaxed">
            The payment window is open.{' '}
            <span className="text-ink">Not seeing it? Use Open payment below.</span>
          </p>
        )}

        {phase.state === 'cancelled' && (
          <Alert tone="info">Payment cancelled. Nothing has been charged.</Alert>
        )}

        {phase.state === 'error' && <Alert tone="error">{phase.message}</Alert>}
      </div>

      <div className="mt-4">
        <Button
          ref={retryRef}
          type="button"
          variant={phase.state === 'open' ? 'secondary' : 'primary'}
          onClick={() => {
            setPhase({ state: 'open' });
            setAttempt((n) => n + 1);
          }}
        >
          {phase.state === 'open' ? 'Open payment' : `Pay ${amount}`}
        </Button>
      </div>

      <Adapter key={attempt} handoff={handoff} callbacks={{ onDone, onCancel, onError }} />
    </section>
  );
}

/**
 * The switch, and the only one.
 *
 * A provider with no case here renders nothing and reports the error rather than
 * failing silently — which is the state a deployment reaches by setting
 * `PAYMENTS_CHECKOUT_PRESENTATION=embedded` for an acquirer whose adapter
 * declares `embeddedCheckout` on the server but has no component here. The
 * server's capability flag and this switch have to be changed together; saying
 * so on screen beats an empty card.
 */
function Adapter({
  handoff,
  callbacks,
}: {
  handoff: CheckoutHandoff;
  callbacks: CheckoutCallbacks;
}) {
  switch (handoff.embedded.provider) {
    case 'razorpay':
      return <RazorpayCheckout handoff={handoff} callbacks={callbacks} />;
    case 'mock':
      return <MockCheckout handoff={handoff} callbacks={callbacks} />;
    default:
      return <UnsupportedProvider name={handoff.embedded.provider} onError={callbacks.onError} />;
  }
}

function UnsupportedProvider({ name, onError }: { name: string; onError: (m: string) => void }) {
  // In an effect, not in render: setting parent state during render is an
  // update-during-render, and reading or writing a ref there is what the React
  // Compiler's lint refuses outright.
  useEffect(() => {
    onError(
      `This deployment is set to show payments in the page, but there is no checkout for ${name}. Set PAYMENTS_CHECKOUT_PRESENTATION=redirect.`
    );
  }, [name, onError]);

  return null;
}

function format(minor: number, currency: string): string {
  return formatMoney(money(minor, currency));
}

/** `1800` -> `18%`. Display only; the arithmetic is all server-side. */
function rate(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(2)}%`;
}

/** How a provider is named to a customer, who has never read our config. */
function label(provider: string): string {
  switch (provider) {
    case 'razorpay':
      return 'Razorpay';
    case 'cashfree':
      return 'Cashfree';
    case 'mock':
      return 'the sandbox provider';
    default:
      return 'our payment provider';
  }
}
