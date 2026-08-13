/**
 * What stock COST — landed cost apportionment and the moving average (PI-4.8).
 *
 * ── WHY THESE ARE PURE FUNCTIONS IN THE PACKAGE, LIKE `allocate.ts` ──────────
 *
 * ⚠️ COSTING ARITHMETIC IS WRONG IN A WAY NO INTEGRATION TEST NOTICES. A receipt
 *   that posts, writes its ledger rows and lands stock on the right shelf at a
 *   unit cost that is one paisa out looks entirely correct from every angle a
 *   route test can see. It shows up a year later, as a valuation that does not
 *   reconcile, by an amount each individual rounding could justify. That is the
 *   same argument PI-3 made for putting FEFO ordering here, and it was
 *   immediately vindicated: the unit suite found a scale inconsistency that was
 *   invisible on screen.
 *
 * ⚠️ `apportion()` IN `@rcln/invoicing` IS THE NEAREST EXISTING FUNCTION AND IS
 *   DELIBERATELY NOT REUSED. It is a DISCOUNT apportioner and two of its rules
 *   are load-bearing for that and wrong for this:
 *
 *     · it refuses `total > totalWeight`, because a discount larger than the bill
 *       is a credit note. Freight larger than the goods is ORDINARY — a single
 *       vial couriered overnight — and refusing it would make the commonest
 *       small emergency order unrecordable;
 *     · it raises `InvoicePricingError` with sentences about discounts, from a
 *       package that prices patient invoices.
 *
 *   Loosening the first would remove a guard that matters where it lives, and
 *   `pnpm kb:find apportion` is how the overlap was found rather than
 *   rediscovered. The largest-remainder algorithm below is the same well-known
 *   one, with the same lower-index tie-break and for the same reason.
 *
 * ── MONEY IS INTEGER MINOR UNITS, QUANTITY IS A DECIMAL STRING ───────────────
 * PI-ADR-010. Nothing here touches a float: every division is done as an exact
 * rational over `bigint` and rounded once, explicitly, at the end.
 */
import { invalid } from './errors.js';
import { compareQuantities, parseQuantity, rational, type Rational } from './units.js';

/**
 * Split `total` minor units across `weights` pro-rata, exactly.
 *
 * Largest remainder: every share is the floor of its exact claim, and the
 * leftover paisa go to the largest fractional claims. The shares therefore sum to
 * `total` exactly — an apportionment that does not is a document whose lines do
 * not add up to its header, which is the one thing a person checking it will
 * notice immediately.
 *
 * ⚠️ TIES BREAK ON THE LOWER INDEX, AND THAT IS WHAT MAKES IT REPRODUCIBLE. Two
 *   lines of equal value split the odd paisa the same way every time; a tie-break
 *   that fell out of iteration order would make the same receipt, re-derived,
 *   apportion differently — which is exactly why the result is STORED on the line
 *   rather than recomputed on read.
 *
 * ⚠️ ZERO WEIGHTS ARE THE ONE CASE WITH NO PRO-RATA ANSWER, and it is a real
 *   receipt: a delivery of free samples with a ₹200 courier charge. Splitting
 *   EVENLY is the only honest fallback — the alternative is refusing to record
 *   what the clinic actually paid — so that is what it does, and it says so here
 *   because it is the branch a reader will not expect.
 */
export function apportionByValue(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw invalid(`Landed cost of ${String(total)} cannot be shared across the lines.`);
  }
  if (weights.length === 0) return [];
  if (total === 0) return weights.map(() => 0);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw invalid('A line value used to share out landed cost is not a whole amount of money.');
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  /*
   * Every line free. See the model comment: an even split, because the charge was
   * genuinely incurred and has to land somewhere.
   */
  const effective = totalWeight > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = totalWeight > 0 ? totalWeight : weights.length;

  const shares = effective.map((weight, index) => {
    /*
     * ⚠️ MULTIPLY BEFORE THE DIVIDE, IN `bigint`. `total * weight` on a large
     *   order overflows `Number.MAX_SAFE_INTEGER` — a ₹50,000 freight charge over
     *   a ₹90,00,000 delivery is 4.5e17, past 9.007e15 — and the float it becomes
     *   is off by whole paisa. `apportion()` in @rcln/invoicing throws on the
     *   overflow instead, which is safe for a discount on one invoice and would
     *   refuse an ordinary wholesale receipt here.
     */
    const product = BigInt(total) * BigInt(weight);
    const denominator = BigInt(effectiveTotal);
    return {
      index,
      floor: product / denominator,
      remainder: product % denominator,
    };
  });

  const distributed = shares.reduce((sum, share) => sum + share.floor, 0n);
  let leftover = BigInt(total) - distributed;

  const byClaim = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  const result = shares.map((share) => share.floor);
  for (const share of byClaim) {
    if (leftover === 0n) break;
    result[share.index] = (result[share.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return result.map((share) => Number(share));
}

/**
 * Cost per BASE UNIT from a price per PACK.
 *
 * `pricePerPackMinor / quantityPerPack`, rounded HALF-UP to the minor unit, once.
 *
 * ⚠️ THIS IS THE ONE ROUNDING IN THE PHASE THAT LANDS ON A SHELF, because its
 *   result becomes `batches.unit_cost_base` and every valuation multiplies it by
 *   a quantity. A ₹412 box of 100 capsules is 4.12 per capsule exactly; a ₹412
 *   box of 90 is 4.5777…, and rounding to 458 over-values a full box by 8 paisa
 *   while rounding to 457 under-values it by 82. Neither is avoidable — a cost
 *   per unit of an indivisible pack has no exact answer — so the choice is made
 *   here, once, and the LINE TOTAL is recorded separately and never re-derived
 *   from this figure.
 *
 * ⚠️ HALF-UP AND NOT BANKER'S ROUNDING. Consistency with `divideRounded` in
 *   `@rcln/payments`, which is what every other money division in the repository
 *   uses; two rounding conventions in one system is how a reconciliation report
 *   ends up disagreeing with itself.
 */
export function unitCostFromPack(pricePerPackMinor: number, quantityPerPack: string): number {
  if (!Number.isSafeInteger(pricePerPackMinor) || pricePerPackMinor < 0) {
    throw invalid('A pack price must be a whole amount of money and cannot be negative.');
  }
  if (compareQuantities(quantityPerPack, '0') <= 0) {
    throw invalid(
      'The number of base units in a pack must be above zero. It is the divisor that turns a pack price into a unit cost, and a pack of nothing has no unit cost.'
    );
  }

  const pack = parseQuantity(quantityPerPack);
  // price / (n/d) === price * d / n
  return divideRationalHalfUp(rational(BigInt(pricePerPackMinor) * pack.d, pack.n));
}

/**
 * The average cost a stored roll-up implies: `valuedCostMinor / valuedQuantityBase`,
 * rounded HALF-UP.
 *
 * ⚠️ THE TOTAL IS WHAT IS STORED AND THE AVERAGE IS WHAT IS DERIVED, NEVER THE
 *   OTHER WAY ROUND. Storing the average would round at every receipt and
 *   compound: after twenty deliveries the figure drifts from the arithmetic, and
 *   each individual rounding is defensible. See the `ProductCostAverage` model.
 */
export function averageCostBase(valuedCostMinor: bigint, valuedQuantityBase: string): number {
  if (compareQuantities(valuedQuantityBase, '0') <= 0) return 0;
  const quantity = parseQuantity(valuedQuantityBase);
  return divideRationalHalfUp(rational(valuedCostMinor * quantity.d, quantity.n));
}

/**
 * One receipt rolled into a running average.
 *
 * ⚠️ IT ADDS TO THE NUMERATOR AND THE DENOMINATOR AND DIVIDES NOTHING. The whole
 *   correctness argument of this module is that the division happens once, at
 *   read. A `newAverage = (oldQty*oldAvg + qty*cost) / (oldQty + qty)` written
 *   here would be the compounding version — it is the formula every textbook
 *   gives, and it is the one that drifts.
 *
 * ⚠️ THE VALUE ADDED IS THE LINE'S GOODS VALUE **PLUS ITS LANDED COST**, and that
 *   is the point of tracking landed cost at all. A vial that cost ₹100 and ₹40 to
 *   fly in cost the clinic ₹140; valuing it at ₹100 makes every margin
 *   calculation flatter that it is.
 *
 * Quantities are added as exact rationals, so `0.1 + 0.2` is `0.3` here and is
 * not in a double.
 */
export function rollIntoAverage(
  current: { valuedQuantityBase: string; valuedCostMinor: bigint },
  receipt: { quantityBase: string; valueMinor: bigint }
): { valuedQuantityBase: string; valuedCostMinor: bigint } {
  if (compareQuantities(receipt.quantityBase, '0') <= 0) {
    throw invalid('A receipt of zero adds nothing to value. Enter a quantity above zero.');
  }
  if (receipt.valueMinor < 0n) {
    throw invalid('A received line cannot have a negative value. A credit is a purchase return.');
  }

  return {
    valuedQuantityBase: addQuantities(current.valuedQuantityBase, receipt.quantityBase),
    valuedCostMinor: current.valuedCostMinor + receipt.valueMinor,
  };
}

/**
 * Take quantity and its share of value OUT of a running average.
 *
 * ⚠️ IT REMOVES VALUE AT THE **CURRENT AVERAGE**, NOT AT WHAT THAT STOCK COST WHEN
 *   IT ARRIVED, AND THAT IS WHAT A MOVING AVERAGE MEANS. Once two deliveries at
 *   two prices are pooled, "what did THIS box cost" has no answer the pool can
 *   give — that is the trade-off of averaging rather than layering, and the reason
 *   `batches.unit_cost_base` still records what each lot actually cost. A purchase
 *   return therefore leaves the average where it was and only shrinks the pool,
 *   which is the behaviour a valuation report needs.
 *
 * ⚠️ IT CANNOT GO BELOW ZERO. Returning more than the pool holds is not a costing
 *   question — the shelf is authoritative about quantity (PI-ADR-004) and the
 *   ledger will have refused it long before this runs — so the floor is a
 *   defensive clamp rather than a rule, and it clears the value with the quantity
 *   so `product_cost_averages_value_implies_quantity` cannot be violated.
 */
export function removeFromAverage(
  current: { valuedQuantityBase: string; valuedCostMinor: bigint },
  quantityBase: string
): { valuedQuantityBase: string; valuedCostMinor: bigint } {
  if (compareQuantities(quantityBase, '0') <= 0) {
    throw invalid('A removal of zero changes nothing.');
  }
  if (compareQuantities(current.valuedQuantityBase, quantityBase) <= 0) {
    return { valuedQuantityBase: '0', valuedCostMinor: 0n };
  }

  const average = averageCostBase(current.valuedCostMinor, current.valuedQuantityBase);
  const removedValue = valueOf(average, quantityBase);
  const remainingValue = current.valuedCostMinor - removedValue;

  return {
    valuedQuantityBase: subtractQuantities(current.valuedQuantityBase, quantityBase),
    // The clamp guards the CHECK constraint, not the arithmetic: a rounded
    // average removed from an unrounded pool can undershoot by a paisa.
    valuedCostMinor: remainingValue > 0n ? remainingValue : 0n,
  };
}

/**
 * `unitCostBase * quantityBase`, rounded HALF-UP — what a quantity of stock is
 * worth at a given unit cost.
 */
export function valueOf(unitCostBase: number | bigint, quantityBase: string): bigint {
  const quantity = parseQuantity(quantityBase);
  const product = rational(BigInt(unitCostBase) * quantity.n, quantity.d);
  return BigInt(divideRationalHalfUp(product));
}

// ---------------------------------------------------------------------------
// Exact decimal helpers
//
// `units.ts` owns the rational algebra; these are the three operations costing
// needs that it does not already export, expressed through it rather than beside
// it.
// ---------------------------------------------------------------------------

function divideRationalHalfUp(value: Rational): number {
  const negative = value.n < 0n !== value.d < 0n;
  const n = value.n < 0n ? -value.n : value.n;
  const d = value.d < 0n ? -value.d : value.d;

  const quotient = n / d;
  const remainder = n % d;
  // Away from zero at the midpoint, so a credit and its reversal agree — the
  // same convention and the same reason as `divideRounded` in @rcln/payments.
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  const signed = negative ? -rounded : rounded;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw invalid('This cost is larger than the system can record as a whole amount of money.');
  }
  return Number(signed);
}

function addQuantities(a: string, b: string): string {
  return formatRationalQuantity(sumRationals(parseQuantity(a), parseQuantity(b)));
}

function subtractQuantities(a: string, b: string): string {
  const right = parseQuantity(b);
  return formatRationalQuantity(sumRationals(parseQuantity(a), rational(-right.n, right.d)));
}

function sumRationals(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/**
 * A rational as the six-decimal string the database column holds.
 *
 * ⚠️ EXACT BY CONSTRUCTION RATHER THAN BY ASSERTION, WHICH IS WHY IT DOES NOT USE
 *   `assertExactConversion`. Every input is already a `Decimal(18,6)` value read
 *   out of a column, so a sum or difference of two of them has at most six
 *   decimal places and cannot lose anything. `assertExactConversion` is for
 *   converting BETWEEN units, where an inexact result means the caller asked for
 *   something the pack sizes cannot express.
 */
function formatRationalQuantity(value: Rational): string {
  const scale = 1000000n;
  const negative = value.n < 0n !== value.d < 0n;
  const n = value.n < 0n ? -value.n : value.n;
  const d = value.d < 0n ? -value.d : value.d;

  const scaled = (n * scale) / d;
  const whole = scaled / scale;
  const fraction = scaled % scale;

  const body =
    fraction === 0n
      ? whole.toString()
      : `${whole.toString()}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;

  return negative && scaled !== 0n ? `-${body}` : body;
}
