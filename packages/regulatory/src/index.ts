/**
 * `@rcln/regulatory` — may this be done with this product, here, today?
 *
 * Modelled directly on `@rcln/tax`, and for the same reason: it holds no Prisma
 * client, reads no database and knows no clock. The caller loads the rows and
 * passes them in; the package returns a decision. That is what makes every rule
 * testable without a tenant, a transaction or a date — and what makes a
 * country's law a fixture rather than a migration (PI-ADR-007).
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE FOR ANY JURISDICTION, AND NOTHING HERE
 *   CONTAINS A COUNTRY. This package ships the FRAMEWORK; the rules are data,
 *   each one cited to a source somebody checked, matured through
 *   `RulePackMaturity` and signed off — or not — by a named human. There is no
 *   `if (country === 'IN')` in this package, and a country-specific behaviour
 *   that cannot be expressed as a rule row is a gap to fix HERE rather than to
 *   work around at a call site.
 *
 * ⚠️ AND THE ONE INVARIANT EVERY CALLER MUST HONOUR: **`UNDETERMINED` REFUSES.**
 *   It is not "we could not check, carry on". It is the answer when no rule
 *   covers the case, when a rule cannot be read, or when a fact the rule needs
 *   was never supplied — every one of which is a reason to stop.
 */

export * from './types.js';
export * from './decimal.js';
export * from './parameters.js';
export * from './selection.js';
export * from './engine.js';
