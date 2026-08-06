/**
 * Which currency a clinic is billed in, and how many decimal places it has.
 *
 * TWO SEPARATE QUESTIONS, DELIBERATELY NOT ONE
 *   1. What currency does this country pay in? — a *default*, offered at
 *      registration and changeable, not a rule. A clinic in Dubai may well want
 *      to be invoiced in USD, and a UK group with an Indian back office may want
 *      INR. `organizations.currency` is the authority; this only seeds it.
 *   2. Do we have a price in that currency? — a catalogue question, answered by
 *      `plan_prices`, not here. A currency with no price is not purchasable, and
 *      the caller falls back rather than inventing an exchange rate.
 *
 * THERE IS NO FX IN THIS PACKAGE, ON PURPOSE
 *   Nothing here converts between currencies. A price is either published in a
 *   currency or it is not. Converting at charge time would mean the amount on
 *   the invoice depends on the day it was rendered, which is not something a
 *   finance team can reconcile and not something a customer should discover.
 *
 * SETTLEMENT IS A DIFFERENT QUESTION AGAIN
 *   Cashfree is an India-domiciled acquirer: a foreign cardholder may be charged
 *   in their own currency, but the merchant settles in INR at Cashfree's rate.
 *   That is a commercial fact about the provider, not a property of the domain,
 *   which is why it lives in the Cashfree adapter's capability declaration and
 *   not in this file.
 */

/**
 * ISO 4217 minor-unit exponents that are not 2.
 *
 * The overwhelming majority of currencies have two decimal places, so only the
 * exceptions are listed. Getting one of these wrong is a factor-of-100 error in
 * a live charge: sending "1500.00" for ¥1500 to a provider that reads minor
 * units bills the customer ¥150,000.
 */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  // Zero-decimal
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export function minorUnitExponent(currency: string): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

/**
 * The currencies rcln publishes prices in.
 *
 * Kept short on purpose. Every entry here is a column of numbers a human has to
 * decide and maintain in `plan_prices` — an unpriced currency is a broken
 * checkout, and a badly priced one is worse. Grow this list when there is a
 * customer in the region, not in anticipation of one.
 */
export const BILLING_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;

export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];

/** The currency used when the country is unknown or has no published price. */
export const FALLBACK_CURRENCY: BillingCurrency = 'USD';

export function isBillingCurrency(value: string): value is BillingCurrency {
  return (BILLING_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

/**
 * Country -> the currency that country's clinics expect to see.
 *
 * Written currency-first because that is how it is maintained: adding a market
 * means adding its countries to one line, and the eurozone is one entry rather
 * than twenty scattered ones. Only countries we publish a price for appear —
 * everywhere else falls back, which is the honest answer rather than a guess at
 * a local currency we cannot actually charge.
 */
const COUNTRIES_BY_CURRENCY: Readonly<Record<BillingCurrency, readonly string[]>> = {
  INR: ['IN'],
  AED: ['AE'],
  SGD: ['SG'],
  AUD: ['AU'],
  GBP: ['GB', 'IM', 'JE', 'GG'],
  EUR: [
    'AT',
    'BE',
    'CY',
    'DE',
    'EE',
    'ES',
    'FI',
    'FR',
    'GR',
    'HR',
    'IE',
    'IT',
    'LT',
    'LU',
    'LV',
    'MT',
    'NL',
    'PT',
    'SI',
    'SK',
  ],
  USD: ['US', 'EC', 'PA', 'SV', 'PR', 'TL', 'ZW'],
};

/** Built once from the table above, so the two can never disagree. */
const CURRENCY_BY_COUNTRY: ReadonlyMap<string, BillingCurrency> = new Map(
  Object.entries(COUNTRIES_BY_CURRENCY).flatMap(([currency, countries]) =>
    countries.map((country) => [country, currency as BillingCurrency] as const)
  )
);

/**
 * The currency to bill a clinic in this country, given what we can actually
 * charge.
 *
 * `available` is the set of currencies the plan has a published price in. Passing
 * it is what stops a clinic in Dublin being offered a price in EUR that does not
 * exist and failing at checkout instead of at plan selection.
 */
export function currencyForCountry(
  countryCode: string | null | undefined,
  available: readonly string[] = BILLING_CURRENCIES
): string {
  const supported = new Set(available.map((c) => c.toUpperCase()));
  const preferred = countryCode ? CURRENCY_BY_COUNTRY.get(countryCode.toUpperCase()) : undefined;

  if (preferred && supported.has(preferred)) return preferred;
  if (supported.has(FALLBACK_CURRENCY)) return FALLBACK_CURRENCY;

  // Nothing preferred and no fallback price: take whatever the plan does have,
  // in the catalogue's own order, so checkout is possible rather than blocked.
  return [...supported][0] ?? FALLBACK_CURRENCY;
}
