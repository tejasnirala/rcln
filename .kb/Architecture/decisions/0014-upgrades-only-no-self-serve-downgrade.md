# ADR-0014 — Upgrades are self-serve; downgrades are not

**Status:** Accepted.

## Context

A clinic on GROWTH (5 branches, 50 staff logins, pharmacy and lab) wants to move
to STARTER (1 branch, 10 logins, neither module). Every SaaS billing screen has
that button.

Here, pressing it would mean: four branches that exist, are staffed, and have
appointments booked into them are now over the plan limit. Forty staff logins
are over the limit. A pharmacy module with dispensing records in it is switched
off. None of that is a billing state — it is a clinic that cannot open on Monday.

The alternatives are all worse than they look. Enforcing the new limits deletes
or disables real clinical configuration at a moment nobody chose. Not enforcing
them means the plan limits are decorative, and the next clinic to hit one is
told it cannot add a branch while a smaller-plan neighbour runs five.

## Decision

**A plan change is allowed only if the new plan grants everything the current
one does.** `classifyChange` in `packages/billing/src/proration.ts` compares the
two plans' resolved entitlements key by key:

- any key where the new plan grants **less** → `DOWNGRADE`, refused
- otherwise any key where it grants **more** → `UPGRADE`, allowed
- identical, and the interval goes monthly → yearly → `UPGRADE`
- identical, and the interval goes yearly → monthly → `DOWNGRADE`, refused
- otherwise → `LATERAL`, refused

A refused change answers 409 with: _"You can only move to a plan that includes
everything your current one does. To move to a smaller plan, contact us."_

Downgrades happen, through a human, who can look at what the clinic is actually
using first.

## Why entitlements and not price

Price is the obvious test and it is wrong. An annual plan costs more up front
and less per day than the monthly one, so comparing amounts calls a
monthly → yearly switch a downgrade if you compare period totals and an upgrade
if you compare daily rates. What a customer means by "upgrade" is "I get more",
and that is a question about features.

It also survives re-pricing. A promotional price that makes GROWTH temporarily
cheaper than STARTER does not turn moving between them into a downgrade.

## Consequences

- **`amountDue` floors at zero and there is never a refund.** `prorate` cannot
  produce a negative balance for a change `classifyChange` has already allowed;
  if the floor ever bites, the arithmetic upstream is wrong and it should be
  treated as a bug rather than as a free upgrade.
- **A partial gain is a downgrade.** "More staff logins but no lab module" is
  refused, because deciding for a clinic that the trade is worth it is exactly
  the thing this ADR exists to avoid.
- **A key the new plan does not mention counts as removed**, not as unchanged.
  A plan that quietly dropped `lab_module` from its features would otherwise
  pass as a lateral move.
- **Overrides follow the subscription, not the plan.** `classifyChange` compares
  the current plan _with_ its overrides against the target plan _without_ them —
  the overrides are the clinic's and travel with them. Comparing both sides with
  the same overrides applied would call every change lateral for any customer
  who has one.
- The screen never renders a "downgrade" button, and the API refuses one anyway.

## What would change this

Downgrade becomes self-serve the day the product can answer "what would I lose?"
concretely — this many branches over, these logins over, this module in use —
and let the clinic resolve each one before the change applies. That is a feature,
not a flag.

## See also

- [ADR-0013](0013-we-own-the-billing-clock.md) — why these rules are ours to make
- `packages/billing/src/proration.ts` — `classifyChange` and `prorate`
- `packages/billing/tests/billing-rules.test.ts` — every case above, tested
