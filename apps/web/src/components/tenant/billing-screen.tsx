'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import type {
  BillingOverviewResponse,
  PlanSummary,
  SubscriptionSummary,
  UpgradeQuoteResponse,
} from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { PeriodStrip } from '@/components/tenant/period-strip';
import { ProviderCheckout } from '@/components/tenant/checkout/provider-checkout';
import { cn } from '@/lib/cn';
import { formatCount, formatDate, formatLongDate } from '@/lib/format';
import {
  applyUpgrade,
  cancelSubscription,
  previewUpgrade,
  resumeSubscription,
  revokeMandate,
  setAutoRenew,
  startCheckout,
  startMandateSetup,
  type BillingFormState,
} from '@/app/(tenant)/t/[slug]/(app)/billing/actions';

const IDLE: BillingFormState = { status: 'idle' };

function amount(minor: number, currency: string): string {
  return formatMoney(money(minor, currency));
}

/**
 * What the clinic's state actually means, in a sentence.
 *
 * Six statuses, and only two of them are self-explanatory. A badge reading
 * "PAST_DUE" tells an administrator nothing about whether their clinic is about
 * to stop working, which is the only thing they want to know — so the state is
 * always paired with its consequence and its deadline.
 */
function statusNote(subscription: SubscriptionSummary): {
  tone: 'ok' | 'warn' | 'stop';
  text: string;
} {
  // formatLongDate, never toLocaleDateString(undefined, …) — see lib/format.ts.
  const date = formatLongDate;

  switch (subscription.status) {
    case 'TRIALING':
      return {
        tone: 'warn',
        text: subscription.trialEndsAt
          ? `Free trial. It ends on ${date(subscription.trialEndsAt)} — choose a plan before then to keep working.`
          : 'Free trial.',
      };
    case 'INCOMPLETE':
      return {
        tone: 'warn',
        text: 'A payment was started and has not completed. Nothing has been charged.',
      };
    case 'PAST_DUE':
      return {
        tone: 'warn',
        text: subscription.gracePeriodEnd
          ? `A renewal payment failed. Your clinic keeps working until ${date(subscription.gracePeriodEnd)} — pay the open invoice below before then.`
          : 'A renewal payment failed. Pay the open invoice below.',
      };
    case 'CANCELED':
      return { tone: 'stop', text: 'This subscription has ended. Choose a plan to start again.' };
    case 'EXPIRED':
      return {
        tone: 'stop',
        text: 'This subscription has lapsed. Your data is safe — choose a plan to start again.',
      };
    case 'ACTIVE':
      return subscription.cancelAtPeriodEnd && subscription.cancelAt
        ? {
            tone: 'warn',
            text: `Set to end on ${date(subscription.cancelAt)}. You keep everything until then.`,
          }
        : { tone: 'ok', text: 'Active.' };
  }
}

export function BillingScreen({
  slug,
  overview,
  canManage,
  renderedAt,
}: {
  slug: string;
  overview: BillingOverviewResponse;
  canManage: boolean;
  /**
   * One instant, taken on the server, used by everything below that needs to
   * know "now". Not `new Date()` in a component: this tree is server-rendered
   * and then hydrated, and a clock read twice gives two different answers, two
   * different strings, and a hydration mismatch that discards the subtree.
   */
  renderedAt: string;
}) {
  const { subscription, plans, invoices, currency } = overview;

  return (
    <div className="space-y-12">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Billing
        </h1>
        <p className="text-muted mt-2 max-w-2xl text-[0.9375rem] leading-relaxed">
          What this clinic is on, what it costs, and every invoice rcln has issued.
        </p>
      </header>

      {subscription ? (
        <CurrentPlan
          slug={slug}
          subscription={subscription}
          canManage={canManage}
          renderedAt={renderedAt}
        />
      ) : (
        <Alert tone="info">This clinic has no subscription yet.</Alert>
      )}

      <PlanPicker
        slug={slug}
        plans={plans}
        subscription={subscription}
        currency={currency}
        canManage={canManage}
      />

      <InvoiceHistory invoices={invoices} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function CurrentPlan({
  slug,
  subscription,
  canManage,
  renderedAt,
}: {
  slug: string;
  subscription: SubscriptionSummary;
  canManage: boolean;
  renderedAt: string;
}) {
  const note = statusNote(subscription);

  return (
    <section aria-labelledby="current-plan" className="border-rule bg-card rounded-lg border p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h2
            id="current-plan"
            className="text-muted text-[0.8125rem] font-medium tracking-wide uppercase"
          >
            Current plan
          </h2>
          <p className="font-display text-ink mt-1 text-2xl">{subscription.plan.name}</p>
        </div>
        <p className="text-ink font-mono text-lg">
          {amount(subscription.amountMinor, subscription.currency)}
          <span className="text-muted text-[0.8125rem]">
            {' '}
            / {subscription.interval === 'YEAR' ? 'year' : 'month'}
          </span>
        </p>
      </div>

      <p
        className={cn(
          'mt-4 text-[0.875rem] leading-relaxed',
          note.tone === 'ok' && 'text-muted',
          note.tone === 'warn' && 'text-signal',
          note.tone === 'stop' && 'text-signal'
        )}
      >
        {/* The word, not just the colour — see apps/web/AGENTS.md. */}
        <span className="sr-only">{note.tone === 'ok' ? 'Status: ' : 'Needs attention: '}</span>
        {note.text}
      </p>

      <div className="mt-6">
        <PeriodStrip
          start={subscription.currentPeriodStart}
          end={subscription.currentPeriodEnd}
          at={renderedAt}
          muted={!subscription.isActive}
        />
      </div>

      {canManage ? (
        <div className="border-rule mt-6 space-y-6 border-t pt-6">
          <AutoRenewControl slug={slug} subscription={subscription} />
          <EndingControls slug={slug} subscription={subscription} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Automatic renewal, and the authorisation behind it.
 *
 * Two separate things on purpose, because they are two separate decisions: the
 * clinic authorises rcln to take payments (once, at their bank), and separately
 * chooses whether we should. Turning renewal off leaves the authorisation in
 * place, so switching back on later does not mean going through the bank again.
 */
function AutoRenewControl({
  slug,
  subscription,
}: {
  slug: string;
  subscription: SubscriptionSummary;
}) {
  const [state, act, pending] = useActionState(
    setAutoRenew.bind(null, slug, !subscription.autoRenew),
    IDLE
  );
  const [mandateState, setUpMandate, mandatePending] = useActionState(
    startMandateSetup.bind(null, slug),
    IDLE
  );
  const [revokeState, revoke, revokePending] = useActionState(revokeMandate.bind(null, slug), IDLE);

  useRedirectOnAction(mandateState);

  const mandate = subscription.mandate;
  const authorised = mandate?.status === 'ACTIVE';

  if (!subscription.autoRenewAvailable) {
    return (
      <div>
        <h3 className="text-ink text-sm font-medium">Automatic renewal</h3>
        <p className="text-muted mt-1.5 text-[0.8125rem] leading-relaxed">
          Not available for payments in {subscription.currency} yet. We will email an invoice before
          each renewal and you can pay it here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-md">
          <h3 className="text-ink text-sm font-medium">Automatic renewal</h3>
          <p className="text-muted mt-1.5 text-[0.8125rem] leading-relaxed">
            {authorised ? (
              <>
                Authorised on {mandate.method?.toLowerCase() ?? 'card'}
                {mandate.instrumentLabel ? (
                  <>
                    {' '}
                    ending <span className="font-mono">{mandate.instrumentLabel}</span>
                  </>
                ) : null}
                , up to {amount(mandate.maxAmountMinor, mandate.currency)} per payment.{' '}
                {subscription.autoRenew
                  ? 'We will take each renewal on the day it falls due.'
                  : 'We will not take anything until you turn renewal back on.'}
              </>
            ) : (
              'Authorise a payment method once, and each renewal is taken on the day it falls due. You can remove it at any time.'
            )}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {authorised ? (
            <>
              <form action={act}>
                <Button type="submit" size="sm" variant="secondary" disabled={pending}>
                  {subscription.autoRenew ? 'Turn off' : 'Turn on'}
                </Button>
              </form>
              <form action={revoke}>
                <Button type="submit" size="sm" variant="ghost" disabled={revokePending}>
                  Remove
                </Button>
              </form>
            </>
          ) : (
            <form action={setUpMandate}>
              <Button type="submit" size="sm" variant="secondary" disabled={mandatePending}>
                Set up automatic payment
              </Button>
            </form>
          )}
        </div>
      </div>

      <Outcome state={state} />
      <Outcome state={mandateState} />
      <Outcome state={revokeState} />
    </div>
  );
}

/**
 * Ending the subscription, and changing your mind.
 *
 * Cancelling defaults to the end of the paid period and says so before it is
 * confirmed; the immediate option is a second, deliberate choice on the same
 * form. Neither is refunded, and the copy says that rather than leaving it to be
 * discovered.
 */
function EndingControls({
  slug,
  subscription,
}: {
  slug: string;
  subscription: SubscriptionSummary;
}) {
  const [open, setOpen] = useState(false);
  const [cancelState, cancel, cancelling] = useActionState(
    cancelSubscription.bind(null, slug),
    IDLE
  );
  const [resumeState, resume, resuming] = useActionState(resumeSubscription.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(cancelState.status, formRef);

  if (subscription.status === 'CANCELED' || subscription.status === 'EXPIRED') return null;

  if (subscription.cancelAtPeriodEnd) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted max-w-md text-[0.8125rem] leading-relaxed">
          This subscription is set to end. Resuming keeps it running on the same plan and the same
          renewal date.
        </p>
        <form action={resume}>
          <Button type="submit" size="sm" variant="secondary" disabled={resuming}>
            Keep the subscription
          </Button>
        </form>
        <div className="w-full">
          <Outcome state={resumeState} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {open ? (
        <form ref={formRef} action={cancel} className="border-rule bg-paper rounded-md border p-4">
          <h3 className="text-ink text-sm font-medium">End this subscription</h3>
          <p className="text-muted mt-1.5 text-[0.8125rem] leading-relaxed">
            Your clinic keeps working until {formatLongDate(subscription.currentPeriodEnd)}, the end
            of the period you have paid for. Nothing is deleted, and you can start again at any
            time. Payments already made are not refunded.
          </p>

          <Textarea
            name="reason"
            label={
              <>
                Why are you leaving? <span className="text-muted font-normal">Optional</span>
              </>
            }
            hint="It helps us fix what did not work. Do not include any patient details."
            fieldClassName="mt-4"
            rows={2}
            maxLength={500}
          />

          <label className="text-muted mt-4 flex items-start gap-2 text-[0.8125rem]">
            <input type="checkbox" name="immediate" value="true" className="mt-0.5" />
            <span>
              End it now instead, and give up the rest of the period. Access stops immediately.
            </span>
          </label>

          <div className="mt-4 flex gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={cancelling}>
              End subscription
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
          </div>

          <Outcome state={cancelState} />
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          End subscription
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The plans, and what moving to one would actually cost today.
 *
 * The quote is fetched from the server when a plan is selected — never computed
 * here. Two reasons: the arithmetic has to be the same one that produces the
 * invoice, and a figure the browser calculated is a figure the browser can be
 * made to calculate differently.
 */
function PlanPicker({
  slug,
  plans,
  subscription,
  currency,
  canManage,
}: {
  slug: string;
  plans: PlanSummary[];
  subscription: SubscriptionSummary | null;
  currency: string;
  canManage: boolean;
}) {
  const [interval, setInterval] = useState<'MONTH' | 'YEAR'>(subscription?.interval ?? 'MONTH');
  const [quote, setQuote] = useState<UpgradeQuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [quoting, startQuoting] = useTransition();

  // A trial or a lapsed subscription pays the full price; only a running one
  // prorates. Asking for a quote in the other states would answer 409.
  const prorates =
    subscription !== null &&
    (subscription.status === 'ACTIVE' || subscription.status === 'PAST_DUE');

  function choose(priceId: string): void {
    setSelected(priceId);
    setQuote(null);
    setQuoteError(null);
    if (!prorates) return;

    startQuoting(async () => {
      const result = await previewUpgrade(slug, priceId);
      if (result.quote) setQuote(result.quote);
      else setQuoteError(result.message ?? 'That plan change is not available.');
    });
  }

  return (
    <section aria-labelledby="plans" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="plans" className="font-display text-ink text-xl">
            Plans
          </h2>
          <p className="text-muted mt-1 text-[0.8125rem]">
            Priced in {currency}. You can move up at any time; to move to a smaller plan, talk to
            us.
          </p>
        </div>

        <div
          className="border-rule inline-flex rounded-md border p-0.5"
          role="group"
          aria-label="Billing period"
        >
          {(['MONTH', 'YEAR'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={interval === option}
              onClick={() => {
                setInterval(option);
                setSelected(null);
                setQuote(null);
              }}
              className={cn(
                'rounded-sm px-3 py-2 text-[0.8125rem] transition-colors',
                interval === option ? 'bg-drape text-paper' : 'text-muted hover:text-drape'
              )}
            >
              {option === 'MONTH' ? 'Monthly' : 'Yearly'}
              {option === 'YEAR' ? <span className="sr-only"> — two months free</span> : null}
            </button>
          ))}
        </div>
      </div>

      <ul className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const price = plan.prices.find((p) => p.interval === interval);
          if (!price) return null;

          const isCurrent = subscription?.planPriceId === price.id;
          const isSelected = selected === price.id;

          return (
            <li
              key={plan.id}
              className={cn(
                'border-rule bg-card flex flex-col rounded-lg border p-5 transition-colors',
                isCurrent && 'border-drape bg-drape-tint/30',
                isSelected && !isCurrent && 'border-drape'
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-ink text-lg">{plan.name}</h3>
                {isCurrent ? (
                  <span className="text-drape-deep bg-drape-tint rounded-sm px-2 py-0.5 text-[0.75rem]">
                    Current
                  </span>
                ) : null}
              </div>
              {plan.tagline ? (
                <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">{plan.tagline}</p>
              ) : null}

              <p className="text-ink mt-4 font-mono text-xl">
                {amount(price.amountMinor, price.currency)}
                <span className="text-muted text-[0.8125rem]">
                  {' '}
                  / {interval === 'YEAR' ? 'year' : 'month'}
                </span>
              </p>

              <ul className="text-muted mt-4 flex-1 space-y-1.5 text-[0.8125rem]">
                {Object.entries(plan.features).map(([key, value]) => (
                  <li key={key}>{featureLine(key, value)}</li>
                ))}
              </ul>

              {canManage && !isCurrent ? (
                <Button
                  size="sm"
                  variant={isSelected ? 'primary' : 'secondary'}
                  className="mt-5"
                  onClick={() => choose(price.id)}
                  disabled={quoting && isSelected}
                >
                  {prorates ? 'Move to this plan' : 'Choose this plan'}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {selected ? (
        <Confirmation
          slug={slug}
          planPriceId={selected}
          quote={quote}
          quoteError={quoteError}
          quoting={quoting}
          prorates={prorates}
          subscription={subscription}
          onDismiss={() => {
            setSelected(null);
            setQuote(null);
            setQuoteError(null);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * The quote, on the same strip the period is drawn on.
 *
 * Every number the customer will be charged is here, with the days it was
 * derived from. Nothing is rounded for display: what is shown is what the
 * invoice will say.
 */
function Confirmation({
  slug,
  planPriceId,
  quote,
  quoteError,
  quoting,
  prorates,
  subscription,
  onDismiss,
}: {
  slug: string;
  planPriceId: string;
  quote: UpgradeQuoteResponse | null;
  quoteError: string | null;
  quoting: boolean;
  prorates: boolean;
  subscription: SubscriptionSummary | null;
  onDismiss: () => void;
}) {
  const [upgradeState, upgrade, upgrading] = useActionState(
    applyUpgrade.bind(null, slug, planPriceId),
    IDLE
  );
  const [checkoutState, checkout, checkingOut] = useActionState(
    startCheckout.bind(null, slug, planPriceId),
    IDLE
  );

  useRedirectOnAction(upgradeState);
  useRedirectOnAction(checkoutState);

  if (quoteError) {
    return (
      <div className="space-y-3">
        <Alert tone="error">{quoteError}</Alert>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Choose another plan
        </Button>
      </div>
    );
  }

  if (prorates && (quoting || !quote)) {
    return (
      <p role="status" className="text-muted text-[0.8125rem]">
        Working out what that costs…
      </p>
    );
  }

  return (
    <div className="border-drape bg-card rounded-lg border p-6">
      {quote ? (
        <>
          <h3 className="font-display text-ink text-lg">
            {quote.fromPlan.name} → {quote.toPlan.name}
          </h3>

          <div className="mt-5">
            {/* `proration` drives the bar here, so `at` only satisfies the
                signature — the day counts came from the server with the quote. */}
            <PeriodStrip
              start={subscription?.currentPeriodStart ?? quote.effectiveAt}
              end={quote.nextRenewalAt}
              at={quote.effectiveAt}
              proration={quote.proration}
            />
          </div>

          <dl className="mt-5 space-y-2 text-[0.875rem]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">
                {quote.toPlan.name} for the {quote.proration.remainingDays} days remaining
              </dt>
              <dd className="text-ink font-mono">
                {amount(quote.proration.chargeMinor, quote.currency)}
              </dd>
            </div>
            {quote.proration.creditMinor > 0 ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">
                  Credit for the {quote.proration.remainingDays} days you have not used on{' '}
                  {quote.fromPlan.name}
                </dt>
                <dd className="text-ink font-mono">
                  −{amount(quote.proration.creditMinor, quote.currency)}
                </dd>
              </div>
            ) : null}
            {/*
              Tax between the prorated supply and the total, so the figure the
              customer commits to is the figure they are charged. "Due today"
              used to sit on `amountDueMinor`, which is the NET — every taxed
              upgrade was under-quoted by exactly the tax.
            */}
            {quote.taxLines.map((line) => (
              <div key={line.name} className="flex justify-between gap-4">
                <dt className="text-muted">
                  {line.name} <span className="font-mono">{String(line.rateBps / 100)}%</span>
                </dt>
                <dd className="text-ink font-mono">{amount(line.amountMinor, quote.currency)}</dd>
              </div>
            ))}

            <div className="border-rule flex justify-between gap-4 border-t pt-2">
              <dt className="text-ink font-medium">Due today</dt>
              <dd className="text-ink font-mono font-medium">
                {amount(quote.totalDueMinor, quote.currency)}
              </dd>
            </div>
          </dl>

          {quote.taxLines.length === 0 ? (
            <p className="text-muted mt-2 text-[0.8125rem] leading-relaxed">{quote.taxNote}</p>
          ) : null}

          <p className="text-muted mt-4 text-[0.8125rem] leading-relaxed">
            Your renewal date does not move — the next full charge is still on{' '}
            {formatLongDate(quote.nextRenewalAt)}, at{' '}
            {amount(quote.fullAmountMinor, quote.currency)}.
          </p>

          <div className="mt-5 flex gap-2">
            <form action={upgrade}>
              <Button type="submit" size="sm" disabled={upgrading}>
                {quote.proration.isFree
                  ? 'Move to this plan'
                  : `Pay ${amount(quote.totalDueMinor, quote.currency)} and move to this plan`}
              </Button>
            </form>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Not now
            </Button>
          </div>

          <Outcome state={upgradeState} />
          <Handoff state={upgradeState} />
        </>
      ) : (
        <>
          <h3 className="font-display text-ink text-lg">Start this plan</h3>
          {/*
            Deliberately silent about WHERE the payment happens.
            `PAYMENTS_CHECKOUT_PRESENTATION` decides whether the next step is a
            window on this page or the provider's own, and the previous copy
            promised the second unconditionally — which became wrong the day the
            embedded flow shipped. The checkout card says what it is when it
            appears; this only has to say what is true either way.
          */}
          <p className="text-muted mt-1.5 text-[0.8125rem] leading-relaxed">
            You will pay for the first period next. Nothing changes here until the payment
            completes.
          </p>
          <div className="mt-5 flex gap-2">
            <form action={checkout}>
              <Button type="submit" size="sm" disabled={checkingOut}>
                Continue to payment
              </Button>
            </form>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Not now
            </Button>
          </div>
          <Outcome state={checkoutState} />
          <Handoff state={checkoutState} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InvoiceHistory({ invoices }: { invoices: BillingOverviewResponse['invoices'] }) {
  if (invoices.length === 0) {
    return (
      <section aria-labelledby="invoices">
        <h2 id="invoices" className="font-display text-ink text-xl">
          Invoices
        </h2>
        <p className="text-muted mt-2 text-[0.8125rem]">
          Nothing has been invoiced yet. Your first invoice appears here when you choose a plan.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="invoices">
      <h2 id="invoices" className="font-display text-ink text-xl">
        Invoices
      </h2>

      <div className="border-rule mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[38rem] text-left text-[0.875rem]">
          <thead className="border-rule bg-paper border-b">
            <tr className="text-muted text-[0.75rem] tracking-wide uppercase">
              <th scope="col" className="px-4 py-3 font-medium">
                Invoice
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Period
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="border-rule bg-card border-b last:border-b-0">
                <td className="text-ink px-4 py-3 font-mono text-[0.8125rem]">
                  {invoice.invoiceNumber}
                  {invoice.lines.some((l) => l.kind.startsWith('PRORATION')) ? (
                    <span className="text-muted block text-[0.75rem]">Plan change</span>
                  ) : null}
                </td>
                <td className="text-muted px-4 py-3 text-[0.8125rem]">
                  {formatDate(invoice.periodStart)} → {formatDate(invoice.periodEnd)}
                </td>
                <td className="px-4 py-3">
                  <InvoiceStatus status={invoice.status} />
                </td>
                <td className="text-ink px-4 py-3 text-right font-mono">
                  {amount(invoice.totalMinor, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Colour AND a word, always — the colour alone carries no meaning (WCAG 1.4.1). */
function InvoiceStatus({ status }: { status: string }) {
  const label: Record<string, string> = {
    PAID: 'Paid',
    OPEN: 'Due',
    DRAFT: 'Draft',
    VOID: 'Cancelled',
    UNCOLLECTIBLE: 'Written off',
  };

  return (
    <span
      className={cn(
        'rounded-sm px-2 py-0.5 text-[0.75rem]',
        status === 'PAID' && 'bg-drape-tint text-drape-deep',
        status === 'OPEN' && 'bg-signal-tint text-signal',
        status !== 'PAID' && status !== 'OPEN' && 'bg-paper text-muted'
      )}
    >
      {label[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * Feature keys, written for the person reading them.
 *
 * `max_branches: -1` is a database convention; "Unlimited branches" is what it
 * means. A screen that shows the stored form makes the reader do the
 * translation the catalogue already did.
 */
function featureLine(key: string, value: number | boolean): string {
  const noun: Record<string, string> = {
    max_branches: 'branches',
    max_users: 'staff logins',
    max_patients: 'patient records',
    pharmacy_module: 'Pharmacy',
    lab_module: 'Lab',
    whatsapp_notifications: 'WhatsApp reminders',
    custom_domain: 'Your own domain',
  };

  const name = noun[key] ?? key.replace(/_/g, ' ');

  if (typeof value === 'boolean') return value ? `${name} included` : `${name} not included`;
  if (value < 0) return `Unlimited ${name}`;
  return `${formatCount(value)} ${name}`;
}

function Outcome({ state }: { state: BillingFormState }) {
  // `checkout` joins `redirect` here: both are handoffs with their own surface,
  // and an Alert above the payment window would be saying nothing useful twice.
  if (state.status === 'idle' || state.status === 'redirect' || state.status === 'checkout') {
    return null;
  }
  return (
    <div className="mt-3">
      <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
    </div>
  );
}

/**
 * Pay without leaving the page, when the server hands back a widget instead of a
 * URL. The sibling of `useRedirectOnAction` — one of the two fires, never both.
 */
function Handoff({ state }: { state: BillingFormState }) {
  if (state.status !== 'checkout' || !state.checkout) return null;
  return <ProviderCheckout handoff={state.checkout} />;
}

/**
 * Leave for the payment provider when an action says to.
 *
 * A full navigation, not a router push: the destination is a different origin
 * and Next's client router cannot go there. `window.location.assign` is also
 * what makes the browser's back button behave — the customer returns to this
 * page, not to a half-submitted form.
 */
function useRedirectOnAction(state: BillingFormState): void {
  const sent = useRef(false);

  // In an effect, not in render: navigating during render is a side effect React
  // may run twice, and twice here means two hits on the provider's hosted page.
  useEffect(() => {
    if (state.status !== 'redirect' || !state.redirectUrl || sent.current) return;
    sent.current = true;
    window.location.assign(state.redirectUrl);
  }, [state]);
}
