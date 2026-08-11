/**
 * The only arithmetic in the package, kept apart from the rules that use it.
 *
 * Rates are basis points — 18% is 1800 — so a rate never becomes a float and
 * `scaleMoney` keeps the multiplication exact.
 */
import { scaleMoney, type Money } from '@rcln/payments';

/**
 * Tax on a net amount, rounded half-up at the currency's own scale.
 *
 * `scaleMoney` multiplies before dividing, so the intermediate never becomes a
 * float — the same reason proration uses it.
 */
export function taxOn(net: Money, rateBps: number): Money {
  return scaleMoney(net, rateBps, 10_000, 'half-up');
}

/**
 * The net inside a tax-inclusive price.
 *
 * `gross = net * (1 + rate)`, so `net = gross * 10000 / (10000 + rateBps)`.
 * Rounded DOWN, so that `net + taxOn(net) <= gross` and an inclusive price never
 * comes out a paisa above the figure the customer was shown. The tax line then
 * takes the remainder, which keeps the invoice adding up exactly.
 */
export function netOf(gross: Money, rateBps: number): Money {
  if (rateBps === 0) return gross;
  return scaleMoney(gross, 10_000, 10_000 + rateBps, 'down');
}

/** `1800` -> `18%`, `1750` -> `17.5%`. For copy, never for arithmetic. */
export function formatRate(rateBps: number): string {
  const percent = rateBps / 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0$/, '')}%`;
}
