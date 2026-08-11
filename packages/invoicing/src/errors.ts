/**
 * The one error this package throws, and the short list of things that raise it.
 *
 * ⚠️ EVERY CASE BELOW IS AN INPUT THE DATABASE WOULD ALSO REFUSE. The CHECK
 *   constraints Phase 3 wrote — `invoices_discount_input_matches_type`,
 *   `invoice_items_line_number_positive`, the 10000 bound on a percentage —
 *   are the boundary; this class is the same rules stated where a cashier can
 *   still be told which line is wrong, rather than as a 23514 at COMMIT.
 *
 *   It is deliberately NOT how an unpriceable line is reported. A category with
 *   no rule, or a jurisdiction needing a tax provider, comes back as an UNRATED
 *   or PROVIDER_REQUIRED treatment on the priced line — a document that says
 *   what is wrong with it and that Phase 5 refuses to issue. Throwing there
 *   would turn a fixable draft into an exception at the counter.
 */
export class InvoicePricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoicePricingError';
  }
}
