/**
 * `@rcln/invoicing` — what a patient invoice comes to, and in what order.
 *
 * ⚠️ THIS IS NOT `@rcln/billing`, AND THE TWO MUST NOT BE MERGED. That package
 *   is rcln billing a clinic for its subscription: one product, one rate, one
 *   issuer, a gateway-driven lifecycle. This one is a CLINIC billing a PATIENT —
 *   many items at many rates under the clinic's own registration, supplied at
 *   the branch, numbered gaplessly per branch, and issued by a cashier. §0.1 of
 *   the implementation log sets out why they cannot share a table; they do not
 *   share a package for the same reasons, and `@rcln/tax` was split out of
 *   `@rcln/billing` ahead of this for the third.
 *
 * Pure arithmetic, in integer minor units. No Prisma, no HTTP, no clock: the
 * caller does its one context read, binds `quoteTax`, and passes values in. That
 * is what lets a hundred-line invoice be priced in a unit test with no tenant
 * and no transaction — and it is why this is the only code allowed to decide
 * what goes in `invoices.grand_total`.
 */

export * from './errors.js';
export * from './quantity.js';
export * from './types.js';
export * from './discount.js';
export * from './pricing.js';
