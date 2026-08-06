/**
 * The tax seam.
 *
 * ⚠️ THE FIRST QUESTION IS NEVER "WHAT RATE?" — IT IS "MAY WE CHARGE AT ALL?"
 *   Tax is only collectable in a jurisdiction we hold a registration for.
 *   Charging it anywhere else is collecting money we have no authority to
 *   collect and cannot remit, because there is nobody to remit it to. It is a
 *   legal problem rather than an arithmetic one, and refunding it afterwards
 *   does not undo it.
 *
 *   So `resolveTax` starts from `tax_registrations` and returns
 *   `NOT_REGISTERED` — zero tax, with the reason recorded on the invoice —
 *   whenever nothing covers the place of supply. An empty registration table
 *   means nothing is ever taxed, which is the correct behaviour for a business
 *   that has not registered anywhere yet, and it is the state this ships in.
 *
 * WHERE A SUPPLY HAPPENS IS THE CUSTOMER'S LOCATION, NOT OURS
 *   For digital and electronically-supplied services that is the rule in every
 *   regime that matters — India's OIDAR rules, the EU's 2015 place-of-supply
 *   change, the UK's. It is why `placeOfSupply` is derived from the ORGANIZATION
 *   and snapshotted onto the invoice: a clinic that later moves must not
 *   retrospectively change the tax on invoices already issued.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not carry a rate table for the world. That is a subscription to a
 *   tax provider (Stripe Tax, Avalara), not a column: US sales tax alone is
 *   ~11,000 jurisdictions with economic-nexus thresholds, and EU VAT is 27 rates
 *   plus VIES validation plus ten-year evidence retention. What is here is one
 *   rate per registration, which is honest for the handful of jurisdictions a
 *   business registers in early, and a `ProviderTaxEngine` slots in behind this
 *   same interface when there are more. When that happens this directory becomes
 *   `@rcln/tax`, mirroring `@rcln/payments` — it is kept inside `@rcln/billing`
 *   only while it remains pure arithmetic with no HTTP in it.
 *
 * EVERYTHING IS INTEGER MINOR UNITS, AS EVERYWHERE ELSE IN BILLING
 *   Rates are basis points — 18% is 1800 — so a rate never becomes a float and
 *   `scaleMoney` keeps the multiplication exact.
 */

import { money, scaleMoney, type Money } from '@rcln/payments';

/** Mirrors the `TaxScheme` enum in the schema. */
export type TaxScheme = 'GST' | 'VAT' | 'SALES_TAX';

/** Mirrors `TaxTreatment`. See the schema for what each one means. */
export type TaxTreatment =
  'STANDARD' | 'REVERSE_CHARGE' | 'ZERO_RATED' | 'EXEMPT' | 'NOT_REGISTERED';

/** Mirrors `TaxIdStatus`. */
export type TaxIdStatus = 'NOT_PROVIDED' | 'UNVALIDATED' | 'VALID' | 'INVALID';

/** One of our own registrations, as read from `tax_registrations`. */
export interface SupplierRegistration {
  countryCode: string;
  /** ISO 3166-2 subdivision without the country prefix. Null = country-wide. */
  regionCode: string | null;
  scheme: TaxScheme;
  registrationNumber: string;
  standardRateBps: number;
}

/** Who is being supplied, and what we know about them. */
export interface TaxableCustomer {
  countryCode: string;
  regionCode: string | null;
  /** Their GSTIN / VAT number, as given. */
  taxId: string | null;
  taxIdStatus: TaxIdStatus;
}

export interface TaxableSupply {
  /** The amount before tax. Always net — see `netOf` for inclusive prices. */
  net: Money;
  customer: TaxableCustomer;
  /**
   * Every registration we hold. `resolveTax` picks the one covering the place of
   * supply; passing them all keeps the selection rule in one place instead of in
   * every caller.
   */
  registrations: readonly SupplierRegistration[];
  suppliedAt: Date;
}

export interface TaxLine {
  /** What the jurisdiction calls it. Printed verbatim — "Tax" is not compliant. */
  name: string;
  rateBps: number;
  amount: Money;
  /** `IN-KA`, `IE`. Which authority the line is owed to. */
  jurisdiction: string;
}

export interface TaxQuote {
  treatment: TaxTreatment;
  lines: TaxLine[];
  total: Money;
  /** `IN-KA`, `IE`, `US-CA`. Snapshotted onto the invoice. */
  placeOfSupply: string;
  /** Our number for that place, as it must appear on the invoice. */
  supplierTaxId: string | null;
  /**
   * Their identifier as given, carried through so the invoice can print it.
   * A GST invoice and an EU reverse-charge invoice both require it.
   */
  customerTaxId: string | null;
  /**
   * Why, in one sentence a human can read.
   *
   * Shown on the checkout summary and kept for support. A zero-tax invoice with
   * no explanation is indistinguishable from a bug, and somebody will eventually
   * have to answer "why was I not charged VAT?" from a screenshot.
   */
  reason: string;
}

// ---------------------------------------------------------------------------
// Place of supply
// ---------------------------------------------------------------------------

/** `IN-KA` where a region is known, otherwise `IN`. */
export function placeOfSupplyFor(customer: TaxableCustomer): string {
  const country = customer.countryCode.toUpperCase();
  const region = customer.regionCode?.toUpperCase();
  return region ? `${country}-${region}` : country;
}

/**
 * The registration that covers this customer, or null.
 *
 * A region-specific registration wins over a country-wide one, because that is
 * what having both means: India issues a GSTIN per state, and a supply into a
 * state we are registered in is domestic to that state.
 */
export function registrationFor(
  registrations: readonly SupplierRegistration[],
  customer: TaxableCustomer
): SupplierRegistration | null {
  const country = customer.countryCode.toUpperCase();
  const region = customer.regionCode?.toUpperCase() ?? null;

  const inCountry = registrations.filter((r) => r.countryCode.toUpperCase() === country);
  if (inCountry.length === 0) return null;

  const exact = region
    ? inCountry.find((r) => (r.regionCode?.toUpperCase() ?? null) === region)
    : undefined;

  return exact ?? inCountry.find((r) => r.regionCode === null) ?? inCountry[0] ?? null;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * What tax is due on a supply, and why.
 *
 * Pure: it reads no database and no clock beyond `suppliedAt`. The caller loads
 * the registrations and passes them in, which is what makes every rule below
 * testable without a tenant.
 */
export function resolveTax(supply: TaxableSupply): TaxQuote {
  // Stamped once, at the single exit, so no branch below can forget it.
  return { ...resolve(supply), customerTaxId: supply.customer.taxId };
}

type Quote = Omit<TaxQuote, 'customerTaxId'>;

function resolve(supply: TaxableSupply): Quote {
  const placeOfSupply = placeOfSupplyFor(supply.customer);

  const untaxed = (
    treatment: TaxTreatment,
    reason: string,
    supplierTaxId: string | null = null
  ): Quote => ({
    treatment,
    lines: [],
    total: money(0, supply.net.currency),
    placeOfSupply,
    supplierTaxId,
    reason,
  });

  /*
   * A DOMESTIC supply first: a registration in the customer's own country.
   *
   * That is the only situation in which we can charge at the rate we hold,
   * because the rate we hold is the rate of the place we registered. Everything
   * else is cross-border and is decided below by the regime rather than by
   * arithmetic.
   */
  const domestic = registrationFor(supply.registrations, supply.customer);

  if (domestic) {
    switch (domestic.scheme) {
      case 'GST':
        return resolveGst(supply, domestic, placeOfSupply);
      case 'VAT':
        return resolveVat(supply, domestic, placeOfSupply);
      case 'SALES_TAX':
        /*
         * Deliberately unimplemented, and saying so rather than guessing.
         *
         * US sales tax is not one rate per registration: taxability of SaaS
         * varies by state, rates combine state/county/city/special districts,
         * and nexus is a threshold test over trailing revenue. A single
         * `standardRateBps` would produce numbers that look right and are wrong,
         * on documents a customer files. Nothing charged is the safe failure,
         * and it is visible on the invoice.
         */
        return untaxed(
          'NOT_REGISTERED',
          'No tax charged — US sales tax needs a tax provider, which is not configured.',
          domestic.registrationNumber
        );
    }
  }

  /*
   * Cross-border. We hold no registration where the customer is, so the question
   * is whether anything we DO hold makes this supply reportable.
   */

  /*
   * An export out of a GST country we are registered in is ZERO-RATED, not
   * untaxed — it still appears on our return, and the invoice still carries our
   * GSTIN. Getting this wrong understates the export figures we have to file.
   */
  const gst = supply.registrations.find((r) => r.scheme === 'GST');
  if (gst && gst.countryCode.toUpperCase() !== supply.customer.countryCode.toUpperCase()) {
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
    return untaxed(
      'NOT_REGISTERED',
      `No tax charged — a supply to ${placeOfSupply} needs destination VAT via One Stop Shop, which requires a tax provider.`,
      vat.registrationNumber
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
    `No tax charged — rcln is not registered to collect tax in ${placeOfSupply}.`
  );
}

// ---------------------------------------------------------------------------
// GST (India)
// ---------------------------------------------------------------------------

/**
 * India's split, which is the reason `regionCode` exists at all.
 *
 * A supply INSIDE the state we are registered in is CGST + SGST, half each to
 * the centre and the state. A supply to any other state is IGST, the whole
 * amount to the centre. Same total, two different sets of returns, and an
 * invoice that gets it wrong denies the customer their input credit — which is
 * a real cost to them, not a cosmetic error.
 *
 * A customer outside India is an export of services: zero-rated, not untaxed.
 */
function resolveGst(
  supply: TaxableSupply,
  registration: SupplierRegistration,
  placeOfSupply: string
): Quote {
  const customerCountry = supply.customer.countryCode.toUpperCase();

  if (customerCountry !== registration.countryCode.toUpperCase()) {
    return {
      treatment: 'ZERO_RATED',
      lines: [],
      total: money(0, supply.net.currency),
      placeOfSupply,
      supplierTaxId: registration.registrationNumber,
      reason: 'Zero-rated — export of services outside India.',
    };
  }

  const rateBps = registration.standardRateBps;
  const total = taxOn(supply.net, rateBps);

  /*
   * Intra-state when we know the customer's state AND it matches ours.
   *
   * An unknown state falls to IGST on purpose. It is the safe direction: IGST is
   * fully creditable to the customer, whereas a CGST/SGST split billed to the
   * wrong state is not, and unpicking it means a credit note and a reissue.
   */
  const supplierRegion = registration.regionCode?.toUpperCase() ?? null;
  const customerRegion = supply.customer.regionCode?.toUpperCase() ?? null;
  const intraState = supplierRegion !== null && supplierRegion === customerRegion;

  if (!intraState) {
    return {
      treatment: 'STANDARD',
      lines: [
        {
          name: 'IGST',
          rateBps,
          amount: total,
          jurisdiction: `${registration.countryCode.toUpperCase()}`,
        },
      ],
      total,
      placeOfSupply,
      supplierTaxId: registration.registrationNumber,
      reason: `IGST at ${formatRate(rateBps)} on an inter-state supply.`,
    };
  }

  /*
   * Split so the two halves SUM to the total, rather than rounding each half
   * independently. On an odd number of paise, half-and-half rounds twice and the
   * lines no longer add up to the tax on the invoice — a one-paisa discrepancy
   * that reconciliation will find and nobody will enjoy explaining.
   */
  const half = scaleMoney(total, 1, 2, 'down');
  const remainder = money(total.amountMinor - half.amountMinor, total.currency);
  const jurisdiction = `${registration.countryCode.toUpperCase()}-${supplierRegion ?? ''}`;

  return {
    treatment: 'STANDARD',
    lines: [
      { name: 'CGST', rateBps: Math.floor(rateBps / 2), amount: half, jurisdiction },
      { name: 'SGST', rateBps: rateBps - Math.floor(rateBps / 2), amount: remainder, jurisdiction },
    ],
    total,
    placeOfSupply,
    supplierTaxId: registration.registrationNumber,
    reason: `CGST and SGST at ${formatRate(rateBps)} combined, on a supply within ${jurisdiction}.`,
  };
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
 */
function resolveVat(
  supply: TaxableSupply,
  registration: SupplierRegistration,
  placeOfSupply: string
): Quote {
  const customerCountry = supply.customer.countryCode.toUpperCase();
  const supplierCountry = registration.countryCode.toUpperCase();
  const crossBorder = customerCountry !== supplierCountry;

  if (crossBorder && supply.customer.taxIdStatus === 'VALID') {
    return {
      treatment: 'REVERSE_CHARGE',
      lines: [],
      total: money(0, supply.net.currency),
      placeOfSupply,
      supplierTaxId: registration.registrationNumber,
      reason: 'Reverse charge — VAT is accounted for by the customer.',
    };
  }

  const rateBps = registration.standardRateBps;
  const total = taxOn(supply.net, rateBps);

  return {
    treatment: 'STANDARD',
    lines: [{ name: 'VAT', rateBps, amount: total, jurisdiction: supplierCountry }],
    total,
    placeOfSupply,
    supplierTaxId: registration.registrationNumber,
    reason: `VAT at ${formatRate(rateBps)}.`,
  };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

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
