/**
 * What an invoice comes to.
 *
 * THE ORDER, FIXED ONCE AND IMPLEMENTED HERE ONLY (§0.5 of the implementation
 * log). Each step is rounded to the currency's minor unit before the next reads
 * it, so what is stored is what was added up:
 *
 *     line.gross     = round(unitPrice × quantity)
 *     line.discount  = round(percentage ? gross × pct : fixed)
 *     line.taxable   = gross − discount − apportioned invoice discount
 *     line.tax[]     = per applicable rule: round(taxable × rateBps / 10000)
 *     line.total     = taxable + Σ tax
 *
 *     subtotal       = Σ line.gross
 *     taxTotal       = Σ Σ line.tax
 *     rounding       = grandTotalRounded − grandTotalRaw
 *     grandTotal     = subtotal − discounts + tax + rounding
 *
 * ⚠️ TAX IS ROUNDED PER LINE, NOT PER INVOICE. The two differ by up to (n−1)
 *   minor units and both are defensible; per-line is what an Indian GST invoice
 *   does and what makes each printed line internally consistent. A patient who
 *   adds a column of figures on the page must get the number at the bottom.
 *
 * ⚠️ THE INVOICE-LEVEL DISCOUNT IS APPORTIONED BEFORE TAX, which is why it
 *   appears in the taxable line above and not in the total. See `discount.ts`.
 *
 * ⚠️ EVERY MONEY FIGURE HERE IS INTEGER MINOR UNITS, and the `numeric(14,2)`
 *   columns are a persistence concern the caller converts at. `4999.995` is
 *   representable in `numeric` and chargeable by nobody, and both discounts and
 *   percentage tax divide.
 *
 * Pure: no Prisma, no clock, no I/O. `quoteTax` is a function the caller has
 * already bound to the one context read it did.
 */
import {
  addMoney,
  divideRounded,
  money,
  scaleMoney,
  subtractMoney,
  zero,
  type Money,
} from '@rcln/payments';
import { isIssuable, type TaxQuote, type TaxTreatment } from '@rcln/tax';

import { apportion, discountAmount } from './discount.js';
import { InvoicePricingError } from './errors.js';
import { QUANTITY_SCALE } from './quantity.js';
import type {
  InvoicePricingInput,
  PricedInvoice,
  PricedInvoiceLine,
  PricedTaxLine,
} from './types.js';

/**
 * How a document summarises lines that disagree, once none of them is
 * unissuable.
 *
 * A bill carrying an 18% medicine and an exempt consultation is a STANDARD-rated
 * document that happens to contain an exempt supply, not an exempt one — the
 * summary is what the document DID, and it charged tax. The unissuable
 * treatments are deliberately absent: `isIssuable()` decides those, so a seventh
 * treatment added to `@rcln/tax` without a decision about issuing cannot
 * silently become issuable here by being missing from a list.
 */
const TREATMENT_PRECEDENCE: readonly TaxTreatment[] = [
  'STANDARD',
  'REVERSE_CHARGE',
  'ZERO_RATED',
  'EXEMPT',
  'NOT_REGISTERED',
];

export function priceInvoice(input: InvoicePricingInput): PricedInvoice {
  const currency = input.currency.toUpperCase();
  const none = zero(currency);

  // ------------------------------------------------------------------
  // 1. Gross and the line's own discount.
  // ------------------------------------------------------------------

  const staged = input.lines.map((line, index) => {
    if (line.unitPrice.currency.toUpperCase() !== currency) {
      throw new InvoicePricingError(
        `line ${String(index + 1)} is priced in ${line.unitPrice.currency} on a ${currency} invoice`
      );
    }
    if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli <= 0) {
      throw new InvoicePricingError(
        `line ${String(index + 1)} has a quantity of ${String(line.quantityMilli)}; a line bills at least some of something`
      );
    }
    if (line.unitPrice.amountMinor < 0) {
      throw new InvoicePricingError(
        `line ${String(index + 1)} has a negative unit price; a negative charge is a credit note`
      );
    }

    /*
     * One `scaleMoney`, not a multiply and then a divide: quantity is an integer
     * count of thousandths, so `price × milli / 1000` is exact all the way to the
     * single rounding at the end. Rounded HERE, and every figure below is
     * computed from the rounded value — re-deriving gross in a query later would
     * reintroduce the fraction this removed, which is why the column is stored.
     */
    const grossAmount = scaleMoney(line.unitPrice, line.quantityMilli, QUANTITY_SCALE, 'half-up');
    const discount = discountAmount(grossAmount, line.discount);

    return { line, grossAmount, discountAmount: discount };
  });

  const subtotal = staged.reduce((sum, item) => addMoney(sum, item.grossAmount), none);
  const lineDiscountTotal = staged.reduce((sum, item) => addMoney(sum, item.discountAmount), none);

  // ------------------------------------------------------------------
  // 2. The invoice-level discount, apportioned back onto the lines.
  // ------------------------------------------------------------------

  /*
   * Apportioned by what each line contributes AFTER its own discount, because
   * that is what the whole-bill discount is actually reducing. Weighting by
   * gross instead would give a heavily-discounted line a share of the second
   * discount out of proportion to what is left of it, and on a line already at
   * zero it would push the taxable amount negative.
   */
  const preInvoiceTaxable = staged.map((item) =>
    subtractMoney(item.grossAmount, item.discountAmount)
  );
  const discountableBase = preInvoiceTaxable.reduce((sum, amount) => addMoney(sum, amount), none);

  const invoiceDiscountTotal = discountAmount(discountableBase, input.discount);
  const apportioned = apportion(
    invoiceDiscountTotal.amountMinor,
    preInvoiceTaxable.map((amount) => amount.amountMinor)
  );

  // ------------------------------------------------------------------
  // 3. Tax, per line, on what is left.
  // ------------------------------------------------------------------

  const quotes: TaxQuote[] = [];

  const lines: PricedInvoiceLine[] = staged.map((item, index) => {
    const apportionedDiscount = money(apportioned[index] ?? 0, currency);
    const taxableAmount = subtractMoney(preInvoiceTaxable[index] ?? none, apportionedDiscount);

    const quote: TaxQuote = input.quoteTax(taxableAmount, item.line.taxCategory);
    quotes.push(quote);

    if (quote.total.currency.toUpperCase() !== currency) {
      throw new InvoicePricingError(
        `the tax quote for line ${String(index + 1)} came back in ${quote.total.currency} on a ${currency} invoice`
      );
    }

    const taxes: PricedTaxLine[] = quote.lines.map((taxLine) => ({
      name: taxLine.name,
      jurisdiction: taxLine.jurisdiction,
      rateBps: taxLine.rateBps,
      /*
       * NOT redundant with the line's own `taxableAmount`, even though it is
       * equal for every rule this engine computes: a stacked tax elsewhere may
       * be levied on a different base, and an external provider supplies its
       * own. The column records what THIS line was actually charged on.
       */
      taxableAmount,
      taxAmount: taxLine.amount,
      treatment: quote.treatment,
      /*
       * Two columns and a CHECK rather than one id and a source enum: the two
       * rules live in two tables, so one id cannot reference both, and "the
       * clinic chose this rate" versus "the clinic accepted our published
       * default" is the question the rate-card screen and an auditor both ask.
       */
      taxRuleId: taxLine.ruleSource === 'TENANT' ? (taxLine.ruleId ?? null) : null,
      taxRuleDefaultId: taxLine.ruleSource === 'PLATFORM' ? (taxLine.ruleId ?? null) : null,
    }));

    /*
     * Summed from the LINES rather than taken from `quote.total`, so this and
     * the rows written to `invoice_taxes` cannot disagree. They are the same
     * number today; if a provider quote ever returns a total that is not the sum
     * of its parts, the printed lines are what the patient can check.
     */
    const taxAmount = taxes.reduce((sum, tax) => addMoney(sum, tax.taxAmount), none);

    return {
      lineNumber: index + 1,
      description: item.line.description,
      taxCategory: item.line.taxCategory,
      quantityMilli: item.line.quantityMilli,
      unitPrice: item.line.unitPrice,
      grossAmount: item.grossAmount,
      ...(item.line.discount ? { discount: item.line.discount } : {}),
      discountAmount: item.discountAmount,
      apportionedDiscount,
      taxableAmount,
      taxAmount,
      lineTotal: addMoney(taxableAmount, taxAmount),
      taxTreatment: quote.treatment,
      taxReason: quote.reason,
      taxes,
    };
  });

  // ------------------------------------------------------------------
  // 4. The document.
  // ------------------------------------------------------------------

  const taxableAmount = lines.reduce((sum, line) => addMoney(sum, line.taxableAmount), none);
  const taxTotal = lines.reduce((sum, line) => addMoney(sum, line.taxAmount), none);

  const rawTotal = addMoney(taxableAmount, taxTotal);
  const roundedTotal = applyCashRounding(rawTotal, input.cashRoundingMinor ?? 1);

  const unissuable = lines.filter((line) => !isIssuable(line.taxTreatment));

  return {
    currency,
    lines,
    subtotal,
    lineDiscountTotal,
    invoiceDiscountTotal,
    taxableAmount,
    taxTotal,
    roundingAdjustment: subtractMoney(roundedTotal, rawTotal),
    grandTotal: roundedTotal,
    taxTreatment: summariseTreatment(lines.map((line) => line.taxTreatment)),
    issuable: unissuable.length === 0,
    unissuableReasons: unissuable.map(
      (line) => `Line ${String(line.lineNumber)} (${line.description}): ${line.taxReason}`
    ),
    /*
     * Every line resolved against the same registrations and the same place of
     * supply, so these are one value per document rather than per line. The tax
     * id is the first NON-NULL: a NOT_REGISTERED line carries none while an
     * exempt line under the same registration still does, and taking line 1's
     * blindly would drop the clinic's GSTIN off a bill whose first line happened
     * to be untaxed. An invoice that charged nothing anywhere has none to print.
     */
    placeOfSupply: quotes[0]?.placeOfSupply ?? null,
    issuerTaxId: quotes.find((quote) => quote.supplierTaxId !== null)?.supplierTaxId ?? null,
  } satisfies PricedInvoice;
}

/**
 * Round a total to the nearest note a clinic can actually hand over.
 *
 * ⚠️ APPLIED TO THE TOTAL AND NEVER TO A LINE. Rounding a line would change the
 *   taxable value of a supply after the tax on it had been computed, so the
 *   invoice would state a tax that is not the rate times the base — which is the
 *   one internal contradiction an auditor checks for first. Kept in its own
 *   column for the same reason: `grand_total` should never need explaining.
 */
function applyCashRounding(total: Money, unitMinor: number): Money {
  if (!Number.isSafeInteger(unitMinor) || unitMinor < 1) {
    throw new InvoicePricingError(
      `cash rounding must be a positive number of minor units, got ${String(unitMinor)}`
    );
  }
  if (unitMinor === 1) return total;

  return money(divideRounded(total.amountMinor, unitMinor, 'half-up') * unitMinor, total.currency);
}

/** The worst position among the lines. See `TREATMENT_PRECEDENCE`. */
function summariseTreatment(treatments: readonly TaxTreatment[]): TaxTreatment {
  /*
   * ⚠️ ONE UNRATED LINE MAKES THE WHOLE DOCUMENT UNISSUABLE, and `isIssuable()`
   *   is the only definition of which those are — asked here rather than
   *   restated as a list, so this and Phase 5's finalisation guard cannot drift.
   *   The first such line wins, which is the one a cashier should be sent to.
   */
  const blocked = treatments.find((treatment) => !isIssuable(treatment));
  if (blocked) return blocked;

  for (const candidate of TREATMENT_PRECEDENCE) {
    if (treatments.includes(candidate)) return candidate;
  }

  /*
   * No lines at all. A draft with nothing on it has charged no tax and asserts
   * no legal position, and NOT_REGISTERED is the column's own default.
   */
  return 'NOT_REGISTERED';
}
