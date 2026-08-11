/**
 * The tax seam.
 *
 * ⚠️ THE FIRST QUESTION IS NEVER "WHAT RATE?" — IT IS "MAY WE CHARGE AT ALL?"
 *   Tax is only collectable in a jurisdiction the issuer holds a registration
 *   for. Charging it anywhere else is collecting money there is no authority to
 *   collect and no way to remit, because there is nobody to remit it to. It is a
 *   legal problem rather than an arithmetic one, and refunding it afterwards
 *   does not undo it.
 *
 *   So `resolveTax` starts from the registrations and returns `NOT_REGISTERED` —
 *   zero tax, with the reason recorded on the invoice — whenever nothing covers
 *   the place of supply. An empty registration set means nothing is ever taxed,
 *   which is the correct behaviour for a business that has not registered
 *   anywhere yet, and it is the state this ships in.
 *
 * ⚠️ THE SECOND QUESTION IS NOT "WHAT RATE?" EITHER — IT IS "WHOSE RATE?"
 *   `standardRateBps` on a registration is one rate for one product, which is
 *   honest for a SaaS subscription and wrong for a clinic: in India a
 *   consultation is exempt, medicines are 5% or 12% and consumables are 12% or
 *   18%, all keyed by HSN/SAC. A supply that names a `taxCategory` therefore
 *   resolves its rate from `rules` and never falls back to `standardRateBps` —
 *   a category with no rule comes back `UNRATED` rather than plausibly wrong.
 *   See `rateFor`.
 *
 * WHERE A SUPPLY HAPPENS IS NOT ALWAYS THE CUSTOMER'S LOCATION
 *   For digital and electronically-supplied services it is — India's OIDAR
 *   rules, the EU's 2015 place-of-supply change, the UK's — and that is the
 *   default here. A service physically performed at a place is supplied at that
 *   place, so a patient invoice passes the issuing branch's jurisdiction as
 *   `placeOfSupply` instead. Either way it is snapshotted onto the invoice: an
 *   issuer that later moves must not retrospectively change the tax on invoices
 *   already issued.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not carry a rate table for the world. That is a subscription to a
 *   tax provider (Stripe Tax, Avalara), not a column: US sales tax alone is
 *   ~11,000 jurisdictions with economic-nexus thresholds, and EU VAT is 27 rates
 *   plus VIES validation plus ten-year evidence retention. `tax_rules` is a rate
 *   table for the handful of categories ONE issuer sells in the jurisdictions it
 *   is actually registered in, which is a different and much smaller problem. A
 *   `ProviderTaxEngine` slots in behind this same interface when there are more.
 *
 * EVERYTHING IS INTEGER MINOR UNITS, AS EVERYWHERE ELSE IN BILLING
 *   Rates are basis points — 18% is 1800 — so a rate never becomes a float and
 *   `scaleMoney` keeps the multiplication exact.
 */

import { money, scaleMoney } from '@rcln/payments';

import { taxOn, formatRate } from './arithmetic.js';
import {
  formatJurisdiction,
  placeOfSupplyFor,
  rateFor,
  registrationFor,
  type ResolvedRate,
} from './selection.js';
import type {
  IssuerRegistration,
  Jurisdiction,
  TaxLine,
  TaxQuote,
  TaxTreatment,
  TaxableSupply,
} from './types.js';

/**
 * What tax is due on a supply, and why.
 *
 * Pure: it reads no database and no clock beyond `suppliedAt`. The caller loads
 * the registrations and the rules and passes them in, which is what makes every
 * rule below testable without a tenant.
 */
export function resolveTax(supply: TaxableSupply): TaxQuote {
  // Stamped once, at the single exit, so no branch below can forget it.
  return { ...resolve(supply), customerTaxId: supply.customer.taxId };
}

type Quote = Omit<TaxQuote, 'customerTaxId'>;

/** A quote that charges nothing. Every zero-tax exit in this file goes through it. */
function untaxedWith(supply: TaxableSupply, place: Jurisdiction) {
  return (treatment: TaxTreatment, reason: string, supplierTaxId: string | null = null): Quote => ({
    treatment,
    lines: [],
    total: money(0, supply.net.currency),
    placeOfSupply: formatJurisdiction(place),
    supplierTaxId,
    reason,
  });
}

/**
 * The item-level treatments that charge nothing, turned into a quote.
 *
 * Returns null when the item is genuinely rateable and the scheme should carry
 * on. Shared by GST and VAT because "this item is exempt" means the same thing
 * under both, and duplicating it is how the two drift.
 */
function itemLevelExit(
  registration: IssuerRegistration,
  rate: ResolvedRate,
  untaxed: ReturnType<typeof untaxedWith>
): Quote | null {
  switch (rate.treatment) {
    case 'UNRATED':
      /*
       * ⚠️ Not an error thrown, and not a rate guessed. The document is allowed
       *   to exist saying exactly what is wrong with it, and Phase 5's
       *   finalisation refuses to ISSUE an invoice carrying this treatment. A
       *   draft a cashier can see and fix beats an exception at the counter, and
       *   both beat an invoice at a rate nobody configured.
       */
      return untaxed(
        'UNRATED',
        rate.taxCategory === null
          ? `No tax charged — this supply names no tax category, and the registration in ${formatJurisdiction(registration)} carries no standard rate.`
          : `No tax charged — no tax rule covers "${rate.taxCategory}" in ${formatJurisdiction(registration)} on this date.`,
        registration.registrationNumber
      );
    case 'EXEMPT':
      /*
       * Exempt is not zero-rated and the difference is not cosmetic: an exempt
       * supply carries no input credit and is reported differently. Healthcare
       * services in India are exempt, which makes this the single most common
       * line on a clinic's invoice.
       */
      return untaxed(
        'EXEMPT',
        `Exempt — "${rate.taxCategory ?? ''}" is not taxable in ${formatJurisdiction(registration)}.`,
        registration.registrationNumber
      );
    case 'ZERO_RATED':
      return untaxed(
        'ZERO_RATED',
        `Zero-rated — "${rate.taxCategory ?? ''}" is taxable at 0% in ${formatJurisdiction(registration)}.`,
        registration.registrationNumber
      );
    case 'STANDARD':
      return null;
  }
}

function resolve(supply: TaxableSupply): Quote {
  const place = placeOfSupplyFor(supply);
  const placeLabel = formatJurisdiction(place);
  const untaxed = untaxedWith(supply, place);

  /*
   * A DOMESTIC supply first: a registration in the country the supply happens in.
   *
   * That is the only situation in which we can charge at the rate we hold,
   * because the rate we hold is the rate of the place we registered. Everything
   * else is cross-border and is decided below by the regime rather than by
   * arithmetic.
   */
  const domestic = registrationFor(supply.registrations, place);

  if (domestic) {
    switch (domestic.scheme) {
      case 'GST':
        return resolveGst(supply, domestic, place);
      case 'VAT':
        return resolveVat(supply, domestic, place);
      case 'SALES_TAX':
        return resolveViaProvider(
          supply,
          domestic,
          place,
          `No tax charged — sales tax in ${placeLabel} is computed per state, county, city and special district and cannot come from a rate table. Configure a tax provider.`
        );
    }
  }

  /*
   * Cross-border. We hold no registration where the supply happens, so the
   * question is whether anything we DO hold makes this supply reportable.
   */

  /*
   * An export out of a GST country we are registered in is ZERO-RATED, not
   * untaxed — it still appears on our return, and the invoice still carries our
   * GSTIN. Getting this wrong understates the export figures we have to file.
   */
  const gst = supply.registrations.find((r) => r.scheme === 'GST');
  if (gst && gst.countryCode.toUpperCase() !== place.countryCode.toUpperCase()) {
    return untaxed(
      'ZERO_RATED',
      `Zero-rated — export of services outside ${gst.countryCode.toUpperCase()}.`,
      gst.registrationNumber
    );
  }

  const vat = supply.registrations.find((r) => r.scheme === 'VAT');
  if (vat) {
    /*
     * A business elsewhere with a VALIDATED number accounts for the VAT itself.
     * No registration in their country is needed for that, which is the whole
     * point of reverse charge.
     */
    if (supply.customer.taxIdStatus === 'VALID') {
      return untaxed(
        'REVERSE_CHARGE',
        'Reverse charge — VAT is accounted for by the customer.',
        vat.registrationNumber
      );
    }

    /*
     * ⚠️ AND HERE IS WHERE A HAND-ROLLED ENGINE STOPS BEING HONEST.
     *
     *   A consumer — or a business whose number we have not validated — buying a
     *   digital service across an EU border is charged the rate of THEIR country,
     *   declared through One Stop Shop. That needs all 27 rates, kept current by
     *   statute, plus VIES validation to know which branch you are even on.
     *
     *   Charging OUR rate here would be the easy wrong answer: it produces a
     *   plausible invoice at the wrong rate, remitted to the wrong authority.
     *   Nothing charged, with the reason on the invoice, is the honest failure
     *   until a tax provider is configured.
     */
    return resolveViaProvider(
      supply,
      vat,
      place,
      `No tax charged — a supply to ${placeLabel} needs destination VAT via One Stop Shop, which requires a tax provider.`
    );
  }

  /*
   * The default, and the state this ships in. NOT a rate of zero — an absence of
   * authority to charge, which is why it is a distinct treatment from
   * ZERO_RATED. A zero-rated supply appears on a return; this one does not exist
   * as far as any tax authority is concerned.
   */
  return untaxed(
    'NOT_REGISTERED',
    `No tax charged — the issuer is not registered to collect tax in ${placeLabel}.`
  );
}

// ---------------------------------------------------------------------------
// Turning rates into printed lines
// ---------------------------------------------------------------------------

/**
 * The tax LINES one taxable supply produces, from the rules that apply to it.
 *
 * ⚠️ A RATE AND A LINE ARE NOT THE SAME THING, AND CONFLATING THEM IS EXACTLY
 *   WHAT MAKES A TAX ENGINE INDIA-SHAPED. 12% in Karnataka prints as two lines
 *   of 6% called CGST and SGST; the same 12% in Singapore prints as one line
 *   called GST; British Columbia prints two lines at two different rates owed to
 *   two different governments. The arithmetic is identical in all three and only
 *   the presentation differs — so the presentation is data on the rule, and this
 *   function is the only place that reads it.
 *
 * Every line is rounded independently against the same net. Stacked taxes are
 * genuinely separate taxes on the same base, not a tax on a tax: British
 * Columbia's PST is 7% of the net, not 7% of (net + GST).
 */
function priceLines(
  supply: TaxableSupply,
  registration: IssuerRegistration,
  place: Jurisdiction,
  rate: ResolvedRate
): Quote {
  const country = registration.countryCode.toUpperCase();

  /*
   * Intra-state when we know the state of supply AND it matches ours.
   *
   * An unknown state falls to the inter-state treatment on purpose. It is the
   * safe direction: IGST is fully creditable to the customer, whereas a
   * CGST/SGST split billed to the wrong state is not, and unpicking it means a
   * credit note and a reissue.
   */
  const supplierRegion = registration.regionCode?.toUpperCase() ?? null;
  const supplyRegion = place.regionCode?.toUpperCase() ?? null;
  const intraState = supplierRegion !== null && supplierRegion === supplyRegion;

  const lines: TaxLine[] = [];
  let totalMinor = 0;

  for (const rule of rate.rules) {
    const amount = taxOn(supply.net, rule.rateBps);
    totalMinor += amount.amountMinor;

    // A stacked provincial tax is owed to the province; a federal one is not.
    const ruleJurisdiction = rule.regionCode
      ? `${country}-${rule.regionCode.toUpperCase()}`
      : country;

    /*
     * Cited on every line this rule produces, including both halves of an
     * Indian split — one rate, split by statute, is still one rule.
     */
    const cite = { ruleId: rule.id ?? null, ruleSource: rule.id ? rule.source : null };

    if (rule.split !== 'INTRA_STATE_HALVES') {
      lines.push({
        name: rule.lineName,
        rateBps: rule.rateBps,
        amount,
        jurisdiction: ruleJurisdiction,
        ...cite,
      });
      continue;
    }

    if (!intraState) {
      /*
       * One line for the whole amount, to the centre. `IGST` from `GST` — the
       * prefix is how the name is constructed in law, not a string trick.
       */
      lines.push({
        name: `I${rule.lineName}`,
        rateBps: rule.rateBps,
        amount,
        jurisdiction: country,
        ...cite,
      });
      continue;
    }

    /*
     * Split so the two halves SUM to the total, rather than rounding each half
     * independently. On an odd number of paise, half-and-half rounds twice and
     * the lines no longer add up to the tax on the invoice — a one-paisa
     * discrepancy that reconciliation will find and nobody will enjoy
     * explaining.
     */
    const half = scaleMoney(amount, 1, 2, 'down');
    const remainder = money(amount.amountMinor - half.amountMinor, amount.currency);
    const centreRate = Math.floor(rule.rateBps / 2);

    lines.push({
      name: `C${rule.lineName}`,
      rateBps: centreRate,
      amount: half,
      // CGST is the centre's half, so it is owed to the country, not the state.
      jurisdiction: country,
      ...cite,
    });
    lines.push({
      // `UTGST` in a union territory without a legislature, `SGST` in a state.
      name: rule.regionalLineName ?? `S${rule.lineName}`,
      rateBps: rule.rateBps - centreRate,
      amount: remainder,
      jurisdiction: `${country}-${supplierRegion ?? ''}`,
      ...cite,
    });
  }

  const total = money(totalMinor, supply.net.currency);
  const names = lines.map((line) => line.name);
  const unique = [...new Set(names)];

  return {
    treatment: 'STANDARD',
    lines,
    total,
    placeOfSupply: formatJurisdiction(place),
    supplierTaxId: registration.registrationNumber,
    reason:
      unique.length === 1
        ? `${unique[0]} at ${formatRate(rate.rateBps)}.`
        : `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)} at ${formatRate(rate.rateBps)} combined.`,
  };
}

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

/**
 * GST, in any country that has one — India, Australia, Singapore, New Zealand,
 * Canada.
 *
 * ⚠️ ONLY ONE RULE HERE IS INDIA-SPECIFIC, AND IT IS NOT IN THIS FUNCTION.
 *   India's constitutional split into CGST/SGST/IGST lives on the RULE, as
 *   `split: INTRA_STATE_HALVES`, and is applied by `priceLines`. An Australian
 *   clinic's rules carry `split: NONE` and get one line called GST. What is left
 *   here is the part every GST regime shares: a supply out of the country is an
 *   export, zero-rated rather than untaxed, because it still appears on a return
 *   and the invoice still carries the registration number.
 */
function resolveGst(
  supply: TaxableSupply,
  registration: IssuerRegistration,
  place: Jurisdiction
): Quote {
  const untaxed = untaxedWith(supply, place);
  const placeCountry = place.countryCode.toUpperCase();
  const issuerCountry = registration.countryCode.toUpperCase();

  if (placeCountry !== issuerCountry) {
    return untaxed(
      'ZERO_RATED',
      `Zero-rated — export of services outside ${issuerCountry}.`,
      registration.registrationNumber
    );
  }

  const rate = rateFor(supply, registration);
  const exit = itemLevelExit(registration, rate, untaxed);
  if (exit) return exit;

  return priceLines(supply, registration, place, rate);
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

/**
 * VAT, with the one rule that actually changes who pays: reverse charge.
 *
 * A business in another country with a VALIDATED tax number accounts for the VAT
 * itself and we charge none. The same business with an unvalidated number is
 * charged at the standard rate — because an unchecked number is a number the
 * customer typed, and if it turns out to be wrong the liability is ours. That is
 * why `taxIdStatus` is a state and not a boolean.
 *
 * ⚠️ Reverse charge is decided by the CUSTOMER's country, not by the place of
 *   supply, and that is not an oversight. It is a rule about which of the two
 *   parties accounts for the tax, so it turns on who they are and where they
 *   are — not on where the service was performed.
 */
function resolveVat(
  supply: TaxableSupply,
  registration: IssuerRegistration,
  place: Jurisdiction
): Quote {
  const untaxed = untaxedWith(supply, place);
  const customerCountry = supply.customer.countryCode.toUpperCase();
  const supplierCountry = registration.countryCode.toUpperCase();
  const crossBorder = customerCountry !== supplierCountry;

  if (crossBorder && supply.customer.taxIdStatus === 'VALID') {
    return untaxed(
      'REVERSE_CHARGE',
      'Reverse charge — VAT is accounted for by the customer.',
      registration.registrationNumber
    );
  }

  const rate = rateFor(supply, registration);
  const exit = itemLevelExit(registration, rate, untaxed);
  if (exit) return exit;

  return priceLines(supply, registration, place, rate);
}

// ---------------------------------------------------------------------------
// Regimes no rate table can compute
// ---------------------------------------------------------------------------

/**
 * A quote from an external tax provider, or an honest refusal.
 *
 * ⚠️ THE ONLY PLACE A PROVIDER'S NUMBERS ARE TRUSTED, AND THE ONLY PLACE
 *   `PROVIDER_REQUIRED` IS PRODUCED. US sales tax is not one rate per
 *   registration: taxability varies by state, rates combine state, county, city
 *   and special districts, and nexus is a threshold test over trailing revenue.
 *   EU cross-border consumer VAT needs all 27 rates kept current by statute plus
 *   VIES validation to know which branch of the rules you are even on.
 *
 *   A rate table would produce numbers that look right and are wrong, on
 *   documents a customer files with an authority. Nothing charged, with the
 *   reason on the invoice and finalisation refusing to issue it, is the only
 *   honest failure — and it is a configuration problem with a known fix rather
 *   than a silent one.
 */
function resolveViaProvider(
  supply: TaxableSupply,
  registration: IssuerRegistration,
  place: Jurisdiction,
  missing: string
): Quote {
  const provided = supply.providerQuote;

  if (!provided) {
    return untaxedWith(supply, place)(
      'PROVIDER_REQUIRED',
      missing,
      registration.registrationNumber
    );
  }

  return {
    treatment: provided.treatment,
    lines: provided.lines,
    total: provided.total,
    placeOfSupply: formatJurisdiction(place),
    supplierTaxId: registration.registrationNumber,
    reason: provided.reason,
  };
}
