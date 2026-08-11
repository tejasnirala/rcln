/**
 * `numeric(14,2)` <-> integer minor units, for patient invoices.
 *
 * ⚠️ THE ONE PLACE THE CONVERSION HAPPENS, WHICH IS §0.4 OF THE IMPLEMENTATION
 *   LOG MADE REAL. `@rcln/invoicing` speaks `Money` because both discounts and
 *   percentage tax divide, and `4999.995` is representable in `numeric` and
 *   chargeable by nobody. The columns are `Decimal` because that is the right
 *   shape for a ledger. Two representations need exactly one boundary between
 *   them; a second one is how a rounding rule gets applied twice, or once in
 *   each direction, on money a patient has already been shown.
 *
 * ⚠️ VIA THE STRING FORM, NEVER `.toNumber()`. `Decimal` exists precisely
 *   because binary floating point cannot hold 0.1. Routing through a float to
 *   reach an integer throws that away at the last possible moment, which is the
 *   moment nobody looks at.
 *
 * ⚠️ THIS IS NOT `toDecimal` IN `@rcln/billing/engine/shared.ts`, AND THE
 *   DUPLICATION IS THE POINT. That one is the subscription engine's boundary —
 *   rcln billing a clinic. This one is the clinic billing a patient. §0.1 keeps
 *   the two engines apart down to the package, and importing across would make
 *   `apps/api`'s invoicing services depend on the subscription package for a
 *   four-line function. The shared thing is `@rcln/payments`, and both use it.
 */
import { Prisma } from '@rcln/db';
import { fromMajor, toMajorString, type Money } from '@rcln/payments';

/** Minor units -> the column. */
export function toDecimal(value: Money): Prisma.Decimal {
  return new Prisma.Decimal(toMajorString(value));
}

/**
 * The column -> minor units.
 *
 * `currency` is passed rather than inferred because a `numeric` column does not
 * carry one: the scale of `1500` is a different number of rupees than it is of
 * yen, and `fromMajor` needs to know which.
 */
export function toMoney(value: Prisma.Decimal, currency: string): Money {
  return fromMajor(value.toString(), currency);
}
