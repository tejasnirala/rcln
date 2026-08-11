/**
 * `@rcln/billing` — what a subscription is, and what happens to it.
 *
 * The rules here are the same whoever is charging the card: when a period ends,
 * what an upgrade costs mid-period, how long a failed payment buys, what a plan
 * entitles a clinic to. Talking to an acquirer is `@rcln/payments`' job, behind
 * an interface this package holds but never inspects.
 *
 * It lives in `packages/` rather than in `apps/api` because the worker needs the
 * same engine — the billing clock runs there, and a renewal is the same set of
 * writes whether a scheduler or an administrator triggered it. Two copies of
 * that would be two subtly different opinions about when a clinic gets suspended.
 */

export * from './errors.js';
export * from './periods.js';
export * from './proration.js';
export * from './entitlements.js';
export * from './policy.js';
export * from './numbering.js';

/*
 * The tax seam moved to `@rcln/tax` — a clinic billing a patient needs the same
 * rules with a different issuer, and a second copy of them would be a second
 * opinion about a legal position. It is NOT re-exported here: one symbol, one
 * home, so nothing ends up importing `TaxQuote` from two places.
 */

export * from './engine/shared.js';
export * from './engine/checkout.js';
export * from './engine/lifecycle.js';
export * from './engine/renewal.js';
export * from './engine/read.js';
