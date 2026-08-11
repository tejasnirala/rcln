/**
 * A draft invoice, priced against a real tenant.
 *
 * The seam between the pure engine and the database, and deliberately the ONLY
 * thing on either side of it that knows about both: `@rcln/invoicing` does the
 * arithmetic and reads nothing, `loadTaxContext` does the reading and computes
 * nothing, and this file binds them.
 *
 * ⚠️ IT PERSISTS NOTHING, AND THAT IS THE PHASE BOUNDARY, NOT AN OVERSIGHT. An
 *   invoice becomes a document at finalisation, which is Phase 5: taking the
 *   number, freezing the financials, refusing to issue an UNRATED line. Writing
 *   rows here would put half of that decision in the wrong file. What this
 *   returns is exactly the set of column values those writes will use.
 *
 * ⚠️ ONE DATABASE READ PER INVOICE, NOT PER LINE. `loadTaxContext` reads the
 *   registrations and the rules once; every line then prices as pure arithmetic
 *   against the same rows. A per-line read would also make a hundred-line bill
 *   a hundred round trips inside one transaction, and — worse — could see two
 *   different rate cards if one were edited mid-invoice.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import {
  priceInvoice,
  type DiscountInput,
  type InvoiceLineInput,
  type PricedInvoice,
} from '@rcln/invoicing';
import { registrationFor } from '@rcln/tax';

import { asPositiveInt, resolveSettings } from '../settings/resolver.service.js';
import { loadTaxContext, taxForItem } from './tax.service.js';

export interface DraftInvoiceInput {
  /** The place of supply, the number series and the RLS boundary. */
  branchId: string;
  /**
   * ⚠️ THE DATE OF SUPPLY, NOT `now()`. It selects the effective-dated rule and
   *   the registration, so an invoice raised in April for a consultation given
   *   in March is taxed as March was.
   */
  suppliedAt: Date;
  currency: string;
  lines: readonly InvoiceLineInput[];
  discount?: DiscountInput;
  /** A patient's own GSTIN, on the rare invoice raised to a business. */
  customerTaxId?: string | null;
}

/**
 * How coarsely the grand total is rounded, in minor units. `1` rounds nothing.
 *
 * ⚠️ A SETTING AND NO LONGER A REQUEST PARAMETER, AND THE OLD SHAPE WAS SILENTLY
 *   BROKEN. `cashRoundingMinor` used to arrive on the create and update bodies
 *   and was never stored — so `finalizeInvoice`, which re-prices from the stored
 *   inputs, re-priced WITHOUT it. A clinic rounding to the rupee saw a rounded
 *   total on the draft and got an unrounded one on the document it handed the
 *   patient, with nothing on either screen saying they disagreed. A per-request
 *   value cannot survive a re-price it is not stored for; a setting can be read
 *   again at finalisation, which is why this is one.
 *
 * ⚠️ RESOLVED AT THE BRANCH, WHICH IS WHY IT IS READ HERE AND NOT AT THE ROUTE.
 *   This is the one function every pricing path goes through — create, edit,
 *   re-price, finalise — so reading it here is what makes all four agree. A route
 *   would have to pass it down four call chains and would be one new caller away
 *   from not doing so.
 */
const CASH_ROUNDING_KEY = 'billing.cash_rounding_minor';

/** Everything a Phase 5 finalisation needs to write, and nothing it has written. */
export interface PricedDraftInvoice extends PricedInvoice {
  /** `invoices.issuer_tax_registration_id`. Null when the clinic holds none here. */
  issuerTaxRegistrationId: string | null;
  /** `invoices.issuer_legal_name` — the name the registration is held in. */
  issuerLegalName: string | null;
}

export async function priceDraftInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: DraftInvoiceInput
): Promise<PricedDraftInvoice> {
  const [context, settings] = await Promise.all([
    loadTaxContext(tx, ctx, input.branchId, input.suppliedAt),
    /*
     * ⚠️ THE BRANCH IS IN SCOPE HERE AND IT MUST BE. Cash rounding is a
     *   counter's habit, not a company policy — a hospital's cash desk rounding
     *   to the rupee while its insurance-billing branch does not is the ordinary
     *   case, and the setting's `allowedScopes` says BRANCH for that reason.
     *
     * ⚠️ AND THE BRANCH ID CAME FROM A ROW READ UNDER RLS, NEVER FROM A REQUEST
     *   BODY. `setting_values` is RLS-EXEMPT — it has no `organization_id` — so
     *   the (scopeType, scopeId) pair IS the isolation. See the resolver's
     *   header. Every caller of this function has already loaded or scoped the
     *   invoice, so `input.branchId` is a checked id by the time it arrives.
     */
    resolveSettings(tx, [CASH_ROUNDING_KEY], {
      organizationId: ctx.organizationId,
      branchId: input.branchId,
    }),
  ]);

  const priced = priceInvoice({
    currency: input.currency,
    lines: input.lines,
    ...(input.discount ? { discount: input.discount } : {}),
    /*
     * `1` — round nothing — is the fallback for a mistyped or missing key as
     * well as the definition's default, because the alternative to rounding is
     * not rounding, and no other value is safe to guess at.
     */
    cashRoundingMinor: asPositiveInt(settings.get(CASH_ROUNDING_KEY) ?? null, 1),
    quoteTax: (net, taxCategory) =>
      taxForItem(context, {
        net,
        taxCategory,
        customerTaxId: input.customerTaxId ?? null,
        suppliedAt: input.suppliedAt,
      }),
  });

  /*
   * The SAME selection rule the engine priced against, asked again for the id
   * rather than restated. `TaxQuote` carries the registration NUMBER because
   * that is what the invoice prints; the id is a foreign key and the two are
   * kept apart on purpose — the row can be corrected without the string on an
   * issued document changing.
   */
  const registration = registrationFor(context.registrations, context.placeOfSupply);

  return {
    ...priced,
    /*
     * Null unless the engine actually charged under it. A NOT_REGISTERED
     * document must not cite a registration it did not use — the id is the
     * clinic's claim about which return this invoice belongs on.
     */
    issuerTaxRegistrationId: priced.issuerTaxId === null ? null : (registration?.id ?? null),
    issuerLegalName: priced.issuerTaxId === null ? null : (registration?.legalName ?? null),
  };
}
