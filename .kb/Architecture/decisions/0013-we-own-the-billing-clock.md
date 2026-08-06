# ADR-0013 — We own the billing clock; the provider only moves money

**Status:** Accepted.

## Context

rcln bills clinics on a subscription. Somebody has to decide when a period ends,
what a mid-period plan change costs, how long a failed payment buys, and when
access stops. Every payment gateway offers to make those decisions for you:
Cashfree has Subscriptions, Stripe has Billing, Razorpay has Plans and
Subscriptions. Adopting one is the fast path.

We are also a global product on an Indian acquirer. Cashfree is India-domiciled:
it will charge a foreign cardholder in their own currency and settle to us in
INR, and its recurring rails — UPI Autopay, eNACH, card mandates — are Indian.
A clinic in Dublin can pay us; it cannot be put on auto-debit through Cashfree.
Sooner or later there is a second acquirer.

## Decision

**`subscriptions.current_period_end` is the authority on when a clinic is
billed, and `@rcln/billing` is the authority on what it is billed.** The
provider is asked to move an amount we computed, at a moment we picked, and is
told nothing else.

Concretely:

- The provider's subscription object is used **only as a mandate holder**. The
  Cashfree adapter creates an `ON_DEMAND` subscription with an authorisation
  ceiling and no cycle, no plan and no schedule; the Razorpay adapter creates an
  auth link with `frequency: as_presented`, which is the same idea spelled
  differently — and pointedly not Razorpay Subscriptions, which carry their own
  plan and their own cycle. Neither acquirer learns what a clinic pays or when.
- Renewals are a **worker sweep** over `current_period_end`, fanned out to one
  job per subscription, each of which asks the provider for a single debit.
- Proration, dunning, grace, entitlements and cancellation live in
  `@rcln/billing`, which imports `PaymentProvider` and never inspects it.
- The plan catalogue lives in Postgres and is **not mirrored** into any provider.

## Why not delegate

**The abstraction leaks immediately.** Every provider models subscriptions
differently — anchors, proration modes, trial semantics, what "past due" means,
whether an upgrade resets the period. A `PaymentProvider` interface that carries
a subscription is an interface shaped like whichever provider was implemented
first, and the second adapter either lies about its semantics or forces a
rewrite of everything above it.

**Two sources of truth for the plan catalogue.** Delegating means pushing plans
and prices into the provider and keeping them in step. The first price change
that succeeds in one place and fails in the other is a customer charged an
amount that appears nowhere in our database.

**The rules are ours, and some of them are unusual.** A fourteen-day grace
period because the thing behind the paywall is a waiting room with patients in
it. Upgrades only, because a downgrade can strip a branch a clinic is running
out of. Neither is expressible as provider configuration, and both are the kind
of decision that should be a commit with a reviewer on it.

**The multi-provider case is not hypothetical.** It is the reason the currency
strategy exists at all.

## What this costs

We carry code that a gateway would otherwise run: a scheduler, a dunning
schedule, invoice numbering, proration arithmetic, and reconciliation. That is
roughly the whole of `@rcln/billing`, and it is tested (`packages/billing/tests`)
precisely because nobody else is testing it for us.

We also carry the failure modes: a sweep that does not run is revenue that does
not arrive, silently. Two guards exist because of that — the sweep is idempotent
and re-entrant, and its cross-tenant read goes through a `SECURITY DEFINER`
function rather than a query that RLS would silently return nothing from. That
second one is not theoretical: it was written as a plain `SELECT` first, matched
zero rows forever, and produced no error.

## Consequences

- Swapping acquirer is a file under `packages/payments/src/providers/`, a line
  in the registry, and `PAYMENT_PROVIDER`. No migration, no contract change, no
  screen, and **not one renewal date moves**.
- A provider that cannot hold a mandate in a currency degrades to manual
  invoices rather than failing — `ProviderCapabilities` is declared, and the
  billing screen reads it.
- Anything in the codebase that branches on a provider's name outside
  `packages/payments/src/providers/` is a bug in this seam, not a feature.

### Validated, once, by an actual second adapter

Razorpay was added after this ADR was written, and the claim above held: one file
under `providers/`, one entry in the registry, one branch of the config type, and
the environment variables. No migration, no contract, no screen, no billing rule.

Two things it did surface, both worth knowing before a third:

- **The seam was right; the diagnostics were not.** `webhooks.routes.ts` logged
  `config.payments.cashfree.environment` on a signature failure. It was a log
  line rather than behaviour, so nothing broke — but it is exactly the shape of
  leak this ADR warns about, and it is now a `switch` that is honest about being
  the one provider-aware place outside the package.
- **An embedded checkout is the one thing the seam cannot fully hide.** A widget
  cannot be rendered without loading that provider's script and identifying the
  merchant to it, so `EmbeddedCheckout` carries a provider name into the browser.
  The properties that matter survive — the client still cannot _choose_ an
  acquirer, still never sends an amount, and the outcome is still settled by a
  signed webhook rather than by the widget's own success callback — and the leak
  is confined to `apps/web/src/components/tenant/checkout/`, the frontend mirror
  of `providers/`. A provider name anywhere else under `apps/web/src` is a bug.
- **Providers disagree about what protects a webhook from replay.** Cashfree
  signs a timestamp, so a captured delivery expires. Razorpay signs the body
  alone and retries for 24 hours, so a time window would refuse legitimate
  retries — its replay protection is the unique index on
  `(provider, provider_event_id)` instead. The ledger is therefore load-bearing
  in a way it was not before; see the comment on `RazorpayProvider.parseWebhook`.

## See also

- [ADR-0014](0014-upgrades-only-no-self-serve-downgrade.md) — the plan-change rule
- `packages/payments/src/types.ts` — the seam itself
- `packages/billing/src/policy.ts` — the commercial numbers, as data
