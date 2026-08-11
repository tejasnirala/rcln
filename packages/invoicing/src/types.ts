/**
 * The vocabulary of a priced invoice.
 *
 * Every field on the way out corresponds to a column Phase 3 created, and the
 * correspondence is the point: `priceInvoice` is the only thing that may decide
 * what goes in `invoices.grand_total` or `invoice_items.taxable_amount`. Phase 3
 * shipped those columns defaulting to 0, which is honest for a fresh draft and
 * wrong for anything else, and every caller writing them by hand would be seven
 * opinions about the calculation order.
 *
 * Nothing here is a Prisma type. This package holds no client and reads no
 * database, which is what lets a hundred-line invoice be priced in a unit test
 * with no tenant, no transaction and no clock.
 */
import type { Money } from '@rcln/payments';
import type { TaxQuote, TaxTreatment } from '@rcln/tax';

/**
 * A discount as ENTERED, which is not the same thing as the amount it came to.
 *
 * ⚠️ "10% off" AND "₹150 off" ARE DIFFERENT INSTRUCTIONS THAT CAN PRODUCE THE
 *   SAME AMOUNT, and the invoice prints which was given. This mirrors the three
 *   columns and the CHECK on both `invoices` and `invoice_items` — a single
 *   `value` column whose meaning depends on a `type` column is a column that
 *   reads differently depending on another column, and a partial update that
 *   changes one and not the other is the ordinary way to get there. A union
 *   makes that state unrepresentable rather than merely refused.
 */
export type DiscountInput =
  | {
      type: 'PERCENTAGE';
      /** Basis points. 10% is 1000. Bounded at 10000 — see `InvoicePricingError`. */
      bps: number;
    }
  | { type: 'FIXED'; amount: Money };

export interface InvoiceLineInput {
  description: string;
  /**
   * ⚠️ THE KEY INTO `tax_rules`, MATCHED EXACTLY. Not `itemCode`, which is the
   *   HSN/SAC string printed on the line: the two are separate so a clinic can
   *   print a code without that string silently becoming a lookup key. A
   *   category no rule covers prices as UNRATED, never at a guessed rate.
   */
  taxCategory: string;
  /** Integer thousandths — see `quantity.ts` for why this is not a number of items. */
  quantityMilli: number;
  unitPrice: Money;
  /** This line's own discount. The invoice-level one is apportioned separately. */
  discount?: DiscountInput;
}

export interface InvoicePricingInput {
  /** ISO 4217. Every `Money` in and out is denominated in it; a mismatch throws. */
  currency: string;
  lines: readonly InvoiceLineInput[];
  /**
   * The whole-bill discount.
   *
   * ⚠️ APPORTIONED ONTO THE LINES BEFORE TAX, NOT SUBTRACTED AFTER IT. See
   *   `apportion` — this is the deliberate deviation from the original brief's
   *   §7 sketch, and reversing it over-collects tax on money nobody received.
   */
  discount?: DiscountInput;
  /**
   * Cash rounding, in minor units: `100` rounds an INR total to the nearest
   * rupee, `1` (the default) rounds to nothing.
   *
   * A clinic taking cash cannot hand back 40 paise. The difference lands in its
   * own column so `grand_total` never has to be explained, and it is applied to
   * the TOTAL rather than to any line — rounding a line would change the taxable
   * value of a supply after the tax on it was computed.
   */
  cashRoundingMinor?: number;
  /**
   * What tax is due on one line's taxable amount.
   *
   * ⚠️ A CALLBACK RATHER THAN A TAX CONTEXT, SO THE PLACE OF SUPPLY STAYS
   *   DEFINED IN ONE PLACE. `taxForItem` in `apps/api/src/services/invoicing/`
   *   is the only code that decides a patient invoice is supplied at the BRANCH
   *   and not at the patient's address; taking the registrations and rules here
   *   instead would make this package a second place that could get that
   *   backwards. It stays pure either way — the caller has already done its one
   *   read by the time this is invoked.
   */
  quoteTax: (net: Money, taxCategory: string) => TaxQuote;
}

/** One row of `invoice_taxes`: one PRINTED tax line, owed to one authority. */
export interface PricedTaxLine {
  /** `CGST`, `SGST`, `IGST`, `VAT`, `HST`, `PST`. Printed verbatim. */
  name: string;
  /** `IN` for CGST, `IN-KA` for SGST. Without it the two halves are indistinguishable. */
  jurisdiction: string;
  /** Basis points, snapshotted. 6% is 600. */
  rateBps: number;
  /** What the rate was applied to — this line's taxable amount, after both discounts. */
  taxableAmount: Money;
  taxAmount: Money;
  treatment: TaxTreatment;
  /** `invoice_taxes.tax_rule_id` — set iff the rate came from the clinic's own rules. */
  taxRuleId: string | null;
  /** `invoice_taxes.tax_rule_default_id` — set iff it was inherited from rcln's catalogue. */
  taxRuleDefaultId: string | null;
}

export interface PricedInvoiceLine {
  /** 1-based print order. Positions are assigned here, so they cannot collide. */
  lineNumber: number;
  description: string;
  taxCategory: string;
  quantityMilli: number;
  unitPrice: Money;
  /** round(unitPrice × quantity). Every later figure is computed from the ROUNDED value. */
  grossAmount: Money;
  /** The line's own discount as entered, carried through so the row can store it. */
  discount?: DiscountInput;
  /** What that discount came to. */
  discountAmount: Money;
  /** This line's share of the invoice-level discount. Kept apart so the print can show both. */
  apportionedDiscount: Money;
  /** gross − discount − apportioned. What tax was computed on. */
  taxableAmount: Money;
  /** Σ this line's tax rows. */
  taxAmount: Money;
  lineTotal: Money;
  taxTreatment: TaxTreatment;
  /** The engine's own sentence, printed where a jurisdiction requires one. Reaches a patient. */
  taxReason: string;
  taxes: PricedTaxLine[];
}

export interface PricedInvoice {
  currency: string;
  lines: PricedInvoiceLine[];

  /** Σ line gross, before any discount. */
  subtotal: Money;
  /** Σ per-line discounts. */
  lineDiscountTotal: Money;
  /** The invoice-level discount, once apportioned. Equals Σ line apportioned exactly. */
  invoiceDiscountTotal: Money;
  /** Σ line taxable. */
  taxableAmount: Money;
  /** Σ every tax line. Rounded PER LINE — see `priceInvoice`. */
  taxTotal: Money;
  /** Signed. `grandTotal − (subtotal − discounts + tax)`. */
  roundingAdjustment: Money;
  grandTotal: Money;

  /**
   * The document-level position: the worst of its lines.
   *
   * ⚠️ ONE UNRATED LINE MAKES THE WHOLE INVOICE UNISSUABLE, and `isIssuable()`
   *   in `@rcln/tax` is the single definition of which treatments those are, so
   *   this and Phase 5's finalisation guard cannot drift.
   */
  taxTreatment: TaxTreatment;
  /** False when any line is UNRATED or PROVIDER_REQUIRED. Phase 5 refuses to ISSUE. */
  issuable: boolean;
  /** Why not, one sentence per offending line, for the cashier looking at the draft. */
  unissuableReasons: string[];

  /** `IN-KA`, `AE`. The branch's jurisdiction, snapshotted onto `invoices`. */
  placeOfSupply: string | null;
  /** The registration this was issued under, as it must be printed. */
  issuerTaxId: string | null;
}
