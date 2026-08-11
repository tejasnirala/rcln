/**
 * `@rcln/tax` — may this issuer charge tax here, and at what rate?
 *
 * Split out of `@rcln/billing` because there are now two issuers asking it. rcln
 * billing a clinic for its subscription reads `tax_registrations`, one set of
 * rows for the whole platform; a clinic billing a patient reads
 * `issuer_tax_registrations` and `tax_rules`, its own. The rules — where a
 * supply happens, whether a registration covers it, how India splits CGST and
 * SGST, when nothing may be charged at all — are identical, and two copies of
 * them would be two subtly different opinions about a legal position.
 *
 * Pure arithmetic and pure rules. No Prisma, no HTTP, no clock beyond the
 * `suppliedAt` the caller passes. The callers load the rows.
 */

export * from './types.js';
export * from './arithmetic.js';
export * from './selection.js';
export * from './engine.js';
