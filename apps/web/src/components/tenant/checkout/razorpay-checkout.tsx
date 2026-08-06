'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import type { CheckoutCallbacks, CheckoutHandoff } from './provider-checkout';

/**
 * Razorpay Standard Checkout, opened over our own page.
 *
 * WHY STANDARD AND NOT CUSTOM CHECKOUT
 *   Razorpay will also sell you Custom Checkout, where the card fields are your
 *   markup. That moves cardholder data into our compliance boundary — the same
 *   boundary as PHI — and turns one audit into two, permanently, in exchange for
 *   controlling the styling of three inputs. The overlay keeps rcln at SAQ-A.
 *   See the capability comment in `providers/razorpay.ts`.
 *
 * WHAT `handler` IS AND IS NOT
 *   It fires when the customer finishes, and it carries a payment id, an order
 *   id and a signature. We use none of them. It tells us WHEN to navigate and
 *   nothing else; whether the money moved is settled by the signed webhook and
 *   by `/billing/return` asking the provider directly. A browser callback is not
 *   evidence — see the header of `provider-checkout.tsx`.
 */

interface RazorpayHandlerResponse {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  theme?: { color?: string };
  prefill?: { name?: string; email?: string; contact?: string };
  retry?: { enabled: boolean };
  handler: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void; escape?: boolean; confirm_close?: boolean };
}

interface RazorpayInstance {
  open: () => void;
  close: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

/** Razorpay truncates past this, and a cut-off summary reads as a bug. */
const DESCRIPTION_LIMIT = 255;

/** `2026-08-06` -> `6 Aug 2026`. Compact, because it shares one line. */
function shortDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/**
 * What the customer reads inside the overlay, before they commit.
 *
 * ⚠️ ONE LINE IS ALL RAZORPAY GIVES US, AND THAT IS THE CONSTRAINT HERE.
 *   Standard Checkout renders the merchant name, this `description`, and the
 *   amount. There is no itemised table in the overlay and no way to add one —
 *   `notes` is merchant metadata the payer never sees, so it cannot stand in.
 *   The page keeps the full breakdown; this is the same purchase compressed to
 *   what fits, so the two cannot disagree about what is being bought.
 *
 * It is built from the SAME `purchase` object the page renders, which came off
 * the issued invoice. Nothing is recomputed for the overlay.
 */
function overlayDescription(handoff: CheckoutHandoff): string {
  const purchase = handoff.purchase;
  if (!purchase) return 'Subscription';

  const period = `${shortDate(purchase.periodStart)} – ${shortDate(purchase.periodEnd)}`;

  /*
   * Taxes named, not just totalled. "incl. CGST 9% + SGST 9%" is the line an
   * Indian customer checks against their own expectation; "incl. tax" is not.
   * Absent entirely when there is none, rather than saying "no tax" — the page
   * carries the explanation, and this line has no room for it.
   */
  const taxes = purchase.taxLines.length
    ? ` · incl. ${purchase.taxLines
        .map((line) => `${line.name} ${String(line.rateBps / 100)}%`)
        .join(' + ')}`
    : '';

  return `${purchase.description} · ${period}${taxes} · Invoice ${purchase.invoiceNumber}`.slice(
    0,
    DESCRIPTION_LIMIT
  );
}

export function RazorpayCheckout({
  handoff,
  callbacks,
}: {
  handoff: CheckoutHandoff;
  callbacks: CheckoutCallbacks;
}) {
  const [ready, setReady] = useState(() => typeof window !== 'undefined' && !!window.Razorpay);
  const opened = useRef(false);

  /*
   * Computed in render, not inside the effect, so the effect can depend on the
   * STRING rather than on `handoff`. The parent hands down a fresh object on
   * every phase change; depending on it would re-run the effect constantly, and
   * only the `opened` guard would be stopping a second overlay from appearing.
   */
  const description = overlayDescription(handoff);

  /*
   * Callbacks through a ref, so the effect below depends only on `ready`.
   *
   * The parent re-renders on every phase change and would otherwise hand this
   * effect new function identities, re-running it and opening a second overlay
   * on top of the first.
   *
   * Updated in an effect rather than during render — writing a ref in the render
   * body is what the React Compiler's lint refuses, and it is refusing something
   * real: with the compiler memoising, a render that is thrown away would still
   * have mutated it. This effect is declared FIRST so it runs before the opening
   * effect below, and the initial value covers that effect's first run anyway.
   */
  const latest = useRef(callbacks);

  useEffect(() => {
    latest.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    if (!ready || opened.current) return;

    const Razorpay = window.Razorpay;
    if (!Razorpay) {
      latest.current.onError(
        'The payment window could not load. Check your connection, then try again.'
      );
      return;
    }

    opened.current = true;

    /*
     * The accent is read from the stylesheet rather than written here.
     * Hard-coding `#2f5d52` would be a second copy of a token that lives in
     * globals.css, and the overlay would keep the old green the first time the
     * palette moves.
     */
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-drape')
      .trim();

    const checkout = new Razorpay({
      key: handoff.embedded.publicKey,
      order_id: handoff.embedded.token,
      // Razorpay reads the authoritative figures from the order; these are for
      // the overlay's own display. They agree because both came from the intent.
      amount: handoff.amountMinor,
      currency: handoff.currency,
      name: 'rcln',
      // The summary, so the decision can be made in the overlay rather than
      // only on the page behind it. See `overlayDescription`.
      description,
      ...(accent ? { theme: { color: accent } } : {}),
      /*
       * ⚠️ NOT COSMETIC — IT CHANGES WHICH METHODS RAZORPAY OFFERS.
       *   A checkout with no contact gets a reduced set of UPI options, which is
       *   why the UPI ID field sits hidden behind the QR. Passing the billing
       *   contact surfaces the collect flow, and spares the customer retyping
       *   details we already hold.
       *
       *   These are the SIGNED-IN USER's own details going back to their own
       *   browser. Never a patient — see `CustomerDetails` in @rcln/payments.
       */
      ...(handoff.customer
        ? {
            prefill: {
              name: handoff.customer.name,
              email: handoff.customer.email,
              ...(handoff.customer.phone ? { contact: handoff.customer.phone } : {}),
            },
          }
        : {}),
      // Razorpay's own retry loop, so a declined card can be corrected inside
      // the overlay instead of restarting checkout and creating a second intent.
      retry: { enabled: true },
      handler: () => latest.current.onDone(),
      modal: {
        ondismiss: () => latest.current.onCancel(),
        escape: true,
      },
    });

    /*
     * A failed attempt is NOT a dismissal and must not read as one.
     *
     * Razorpay keeps the overlay open on a decline so the customer can retry,
     * and `ondismiss` fires later if they give up. Reporting failure here would
     * put "Payment cancelled" under a still-open payment window.
     */
    checkout.on('payment.failed', () => {
      // Deliberately quiet. The overlay is showing the issuer's reason, which is
      // better than anything we could say, and the intent is settled by webhook.
    });

    checkout.open();

    return () => {
      checkout.close();
    };
  }, [
    ready,
    description,
    handoff.customer,
    handoff.embedded.publicKey,
    handoff.embedded.token,
    handoff.amountMinor,
    handoff.currency,
  ]);

  return (
    <Script
      src={CHECKOUT_SCRIPT}
      // `afterInteractive`: the customer has already clicked to pay, so this is
      // not blocking first paint of anything, and `beforeInteractive` would load
      // a payment script on every route in the layout.
      strategy="afterInteractive"
      onReady={() => setReady(true)}
      onError={() =>
        latest.current.onError(
          'The payment window could not load. Check your connection, then try again.'
        )
      }
    />
  );
}
