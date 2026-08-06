/**
 * `@rcln/payments/money` — the money and currency helpers, and nothing else.
 *
 * WHY THIS ENTRY POINT EXISTS
 *   The package root re-exports the provider adapters, which import
 *   `node:crypto` for signature verification. Importing the root from a Client
 *   Component therefore drags Node built-ins and two HTTP adapters into the
 *   browser bundle — for the sake of a currency formatter.
 *
 *   The alternative was a second copy of `formatMoney` in `apps/web`, which is
 *   exactly the duplication `pnpm kb:find` exists to prevent: two functions that
 *   round money, drifting.
 *
 * Everything here is pure arithmetic and Intl. Safe in a browser, safe in a
 * worker, safe in a test with no gateway.
 */

export * from './money.js';
export * from './currency.js';
