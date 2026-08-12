/**
 * `@rcln/inventory` — the ledger writer and the conversion algebra it depends on.
 *
 * ⚠️ WHY THIS IS A PACKAGE AND NOT A SERVICE IN `apps/api`. PI-ADR-004 says
 *   `recordMovement()` is the ONLY thing that inserts into `stock_ledger`, and
 *   PI-2.8's expiry sweep is a WORKER processor. The worker cannot import from
 *   the API — they are two applications, and an app-to-app dependency would pull
 *   express and argon2 into a queue consumer — so a sweep living in the worker
 *   would have had to write its own insert, and "the only writer" would have
 *   stopped being true in the same phase that declared it.
 *
 *   PI-3's transfers, PI-4's goods receipts, PI-7's dispensing and PI-9's
 *   consumption all write movements too, and at least two of those will run in
 *   the worker.
 *
 * Everything it cannot do for itself — writing an audit row, loading the tenant's
 * unit graph, opening a transaction — is injected. Same shape as `@rcln/billing`.
 *
 * NO PHI. A movement names ids, quantities and places.
 */

export * from './errors.js';
export * from './units.js';
export * from './movement.js';
export * from './expiry.js';
