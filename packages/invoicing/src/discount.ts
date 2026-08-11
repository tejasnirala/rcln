/**
 * Discounts: what one comes to, and how a whole-bill one is split across lines.
 *
 * ⚠️ THE INVOICE-LEVEL DISCOUNT IS APPORTIONED ONTO THE LINES **BEFORE** TAX,
 *   AND THE ORIGINAL BRIEF'S §7 SKETCH PUT IT AFTER. That is not a preference.
 *   A discount that reduces what the customer pays reduces the taxable value of
 *   the supply, in every VAT and GST regime there is. Tax computed on the
 *   pre-discount amount is over-collected tax, remitted to an authority on money
 *   nobody ever received — the clinic cannot get it back and the patient was
 *   charged it. Subtracting the discount from the total afterwards makes the
 *   arithmetic add up and leaves the tax wrong, which is why nothing catches it.
 *
 *   It also has to be apportioned rather than taken off the total, because tax
 *   is a property of a LINE: a bill carrying an exempt consultation beside an
 *   18% medicine has no single rate for a whole-bill discount to reduce.
 *
 * ⚠️ AND IT MUST SUM EXACTLY. ₹100 across three equal lines is 33.33 three
 *   times, which is ₹99.99 — a paisa the invoice would be short, discovered by
 *   reconciliation and explicable by nobody. Largest-remainder distributes the
 *   leftover minor units one at a time to the lines with the largest fractional
 *   claim, so Σ parts = whole, always, by construction rather than by luck.
 */
import { money, scaleMoney, type Money } from '@rcln/payments';

import { InvoicePricingError } from './errors.js';
import type { DiscountInput } from './types.js';

/** The maximum a percentage discount may be. 100%, in basis points. */
export const MAX_DISCOUNT_BPS = 10_000;

/**
 * What a discount comes to against a base, rounded at the currency's scale.
 *
 * ⚠️ A DISCOUNT LARGER THAN WHAT IT REDUCES IS REFUSED, NOT CLAMPED. Clamping
 *   silently turns "₹500 off" on a ₹300 line into "₹300 off" and prints a bill
 *   the cashier did not intend; the amount they typed is simply wrong and they
 *   are the only one who can say what was meant. A charge that goes negative is
 *   a credit note, which is a different document issued through a different
 *   door (Phase 5).
 */
export function discountAmount(base: Money, discount: DiscountInput | undefined): Money {
  if (!discount) return money(0, base.currency);

  if (discount.type === 'PERCENTAGE') {
    if (!Number.isInteger(discount.bps) || discount.bps < 0 || discount.bps > MAX_DISCOUNT_BPS) {
      throw new InvoicePricingError(
        `discount percentage must be 0..${String(MAX_DISCOUNT_BPS)} basis points, got ${String(discount.bps)}`
      );
    }
    // Bounded at 100% above, so this can never exceed the base.
    return scaleMoney(base, discount.bps, MAX_DISCOUNT_BPS, 'half-up');
  }

  if (discount.amount.currency !== base.currency) {
    throw new InvoicePricingError(
      `discount is in ${discount.amount.currency} but the amount it reduces is in ${base.currency}`
    );
  }
  if (discount.amount.amountMinor < 0) {
    throw new InvoicePricingError('a discount cannot be negative — that is a charge');
  }
  if (discount.amount.amountMinor > base.amountMinor) {
    throw new InvoicePricingError(
      `discount of ${String(discount.amount.amountMinor)} exceeds the ${String(base.amountMinor)} it reduces; a negative charge is a credit note`
    );
  }
  return discount.amount;
}

/**
 * Split `total` across `weights` pro-rata, largest-remainder, exactly.
 *
 * The weights are the lines' taxable amounts: a line worth twice as much of the
 * bill absorbs twice as much of the discount. Ties break on the LOWER INDEX, so
 * two identical lines always split the odd paisa the same way — the same invoice
 * priced twice must produce the same document, and a tie-break that depended on
 * iteration order would make a reprint differ from the original.
 *
 * ⚠️ A ZERO-WEIGHT BILL CANNOT ABSORB A DISCOUNT. Every line free (or an empty
 *   invoice) and a discount asked for is a caller error, not a rounding edge:
 *   there is no taxable value to reduce, and spreading it evenly would invent
 *   negative lines.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new InvoicePricingError(`cannot apportion ${String(total)}`);
  }
  if (total === 0) return weights.map(() => 0);

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    throw new InvoicePricingError(
      'cannot apportion a discount across an invoice with nothing to discount'
    );
  }
  if (total > totalWeight) {
    throw new InvoicePricingError(
      `discount of ${String(total)} exceeds the ${String(totalWeight)} it is apportioned across`
    );
  }

  /*
   * `total * weight` before the divide, so the numerator stays exact — the same
   * reason `scaleMoney` multiplies first. The remainder is that product's
   * modulus, which is the fractional claim scaled up by `totalWeight`, so the
   * comparison below never touches a float either.
   */
  const shares = weights.map((weight, index) => {
    const product = total * weight;
    if (!Number.isSafeInteger(product)) {
      throw new InvoicePricingError('apportionment overflowed the safe integer range');
    }
    return {
      index,
      floor: Math.floor(product / totalWeight),
      remainder: product % totalWeight,
    };
  });

  const distributed = shares.reduce((sum, share) => sum + share.floor, 0);
  let leftover = total - distributed;

  const byClaim = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : b.remainder - a.remainder
  );

  const result = shares.map((share) => share.floor);
  for (const share of byClaim) {
    if (leftover === 0) break;
    result[share.index] = (result[share.index] ?? 0) + 1;
    leftover -= 1;
  }

  return result;
}
