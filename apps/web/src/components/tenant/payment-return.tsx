'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MandateStatusResponse, PaymentStatusResponse } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  pollMandateStatus,
  pollPaymentStatus,
} from '@/app/(tenant)/t/[slug]/(app)/billing/return/actions';

/**
 * Waiting for a payment to land, honestly.
 *
 * THE THREE STATES, AND WHY PENDING IS NOT A FAILURE
 *   A UPI collect request sits pending while somebody finds their phone; a bank
 *   redirect sits pending through a 3-D Secure step. Treating that as failure is
 *   how a customer pays twice. So this waits, says what it is waiting for, and
 *   only gives up after a bounded time — at which point it says the payment is
 *   still in progress rather than that it failed, because it has not failed.
 *
 * IT POLLS OUR API, NOT THE PROVIDER. The server already reconciled once before
 * this component rendered; these are cheap reads of a row a verified webhook
 * moves. Backed off, and stopped the moment the answer is terminal.
 */

const POLL_MS = 2500;
const GIVE_UP_AFTER_MS = 90_000;

export function PaymentReturn({ slug, initial }: { slug: string; initial: PaymentStatusResponse }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [waitedOut, setWaitedOut] = useState(false);

  const settled = status.status !== 'PENDING' && status.status !== 'CREATED';

  useEffect(() => {
    if (settled) return;

    const startedAt = Date.now();
    let cancelled = false;

    const timer = setInterval(() => {
      if (cancelled) return;

      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        setWaitedOut(true);
        clearInterval(timer);
        return;
      }

      void pollPaymentStatus(slug, status.intentId).then((next) => {
        if (cancelled || !next) return;
        setStatus(next);
        if (next.status !== 'PENDING' && next.status !== 'CREATED') {
          clearInterval(timer);
          // The billing page is a Server Component; refreshing is what makes it
          // re-fetch the subscription rather than showing a cached one.
          router.refresh();
        }
      });
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [settled, slug, status.intentId, router]);

  const total = formatMoney(money(status.amountMinor, status.currency));

  if (status.status === 'SUCCEEDED') {
    return (
      <Panel title="Payment received">
        <p className="text-muted text-[0.9375rem] leading-relaxed">
          We have taken {total}. Your plan is updated and your invoice is in the billing history.
        </p>
        <Actions slug={slug} primary="Back to billing" />
      </Panel>
    );
  }

  if (status.status === 'FAILED' || status.status === 'CANCELLED' || status.status === 'EXPIRED') {
    return (
      <Panel title="Payment did not go through">
        <Alert tone="error">
          {status.failureMessage ?? 'The payment did not complete.'} Nothing has been charged.
        </Alert>
        <p className="text-muted mt-3 text-[0.9375rem] leading-relaxed">
          Your clinic is exactly where it was. You can try again with the same or a different
          payment method.
        </p>
        <Actions slug={slug} primary="Try again" />
      </Panel>
    );
  }

  if (waitedOut) {
    return (
      <Panel title="Still with your bank">
        <p className="text-muted text-[0.9375rem] leading-relaxed">
          This payment of {total} has not finished yet. That is normal for bank transfers and some
          UPI payments — we will update your plan as soon as it clears, and email you either way.
          There is nothing else for you to do, and you should not pay again.
        </p>
        <Actions slug={slug} primary="Back to billing" />
      </Panel>
    );
  }

  return (
    <Panel title="Confirming your payment">
      {/* aria-live so the outcome is announced when it arrives, not just drawn. */}
      <p role="status" aria-live="polite" className="text-muted text-[0.9375rem] leading-relaxed">
        Waiting for {total} to clear. Keep this page open — it updates on its own.
      </p>
      <div
        aria-hidden="true"
        className="bg-drape-tint mt-5 h-1 w-full overflow-hidden rounded-full"
      >
        <div className="bg-drape h-full w-1/3 motion-safe:animate-pulse" />
      </div>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-rule bg-card mx-auto max-w-xl rounded-lg border p-8">
      <h1 className="font-display text-ink text-2xl">{title}</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Actions({ slug: _slug, primary }: { slug: string; primary: string }) {
  return (
    <div className="mt-6">
      <Link href="/billing">
        <Button size="sm">{primary}</Button>
      </Link>
    </div>
  );
}

/**
 * Waiting for a payment authorisation to be confirmed.
 *
 * Sibling of `PaymentReturn`, and the same rule applies: PENDING is not a
 * failure. An eNACH or UPI Autopay mandate needs the customer's bank to confirm,
 * which is not instant and is occasionally not same-day. Telling somebody their
 * authorisation failed while their bank is still thinking about it is how they
 * end up setting up a second one.
 *
 * Unlike a charge, there may be NO webhook for this at all — Cashfree's Payment
 * Gateway catalogue has no subscription events — so the reconcile the server
 * already ran, plus this poll, is the whole mechanism.
 */
export function MandateReturn({ slug, initial }: { slug: string; initial: MandateStatusResponse }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [waitedOut, setWaitedOut] = useState(false);

  const settled = status.status !== 'PENDING';

  useEffect(() => {
    if (settled) return;

    const startedAt = Date.now();
    let cancelled = false;

    const timer = setInterval(() => {
      if (cancelled) return;

      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        setWaitedOut(true);
        clearInterval(timer);
        return;
      }

      void pollMandateStatus(slug, status.mandateId).then((next) => {
        if (cancelled || !next) return;
        setStatus(next);
        if (next.status !== 'PENDING') {
          clearInterval(timer);
          router.refresh();
        }
      });
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [settled, slug, status.mandateId, router]);

  const ceiling = formatMoney(money(status.maxAmountMinor, status.currency));

  if (status.status === 'ACTIVE') {
    return (
      <Panel title="Automatic renewal is on">
        <p className="text-muted text-[0.9375rem] leading-relaxed">
          Your {status.method?.toLowerCase() ?? 'payment method'}
          {status.instrumentLabel ? ` ending ${status.instrumentLabel}` : ''} is authorised for up
          to {ceiling} per payment. We will take each renewal on the day it falls due, and email you
          a receipt. You can turn this off or remove it at any time.
        </p>
        <Actions slug={slug} primary="Back to billing" />
      </Panel>
    );
  }

  if (status.status === 'CANCELLED' || status.status === 'FAILED') {
    return (
      <Panel title="Automatic renewal was not set up">
        <Alert tone="error">
          The authorisation did not complete. Nothing has been charged and nothing has changed.
        </Alert>
        <p className="text-muted mt-3 text-[0.9375rem] leading-relaxed">
          You can try again, or leave it off and pay each invoice when it is issued.
        </p>
        <Actions slug={slug} primary="Back to billing" />
      </Panel>
    );
  }

  if (waitedOut) {
    return (
      <Panel title="Still with your bank">
        <p className="text-muted text-[0.9375rem] leading-relaxed">
          Your bank has not confirmed the authorisation yet. That is normal for eNACH and some UPI
          mandates, which can take a few hours. We will turn automatic renewal on as soon as it
          clears — there is nothing else for you to do, and you should not set up a second one.
        </p>
        <Actions slug={slug} primary="Back to billing" />
      </Panel>
    );
  }

  return (
    <Panel title="Confirming the authorisation">
      <p role="status" aria-live="polite" className="text-muted text-[0.9375rem] leading-relaxed">
        Waiting for your bank to confirm. Keep this page open — it updates on its own.
      </p>
      <div
        aria-hidden="true"
        className="bg-drape-tint mt-5 h-1 w-full overflow-hidden rounded-full"
      >
        <div className="bg-drape h-full w-1/3 motion-safe:animate-pulse" />
      </div>
    </Panel>
  );
}
