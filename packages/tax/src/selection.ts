/**
 * Which registration covers this supply, and which rule sets its rate.
 *
 * Both selections answer the same shape of question — *of the rows we hold, which
 * one applies HERE?* — and both resolve it the same way: an exact regional match
 * beats a country-wide one. That tie-break is not a convenience. India issues a
 * GSTIN per state, so a country-wide row and a Karnataka row mean genuinely
 * different things, and picking the wrong one puts the wrong number on the
 * invoice and the tax in the wrong return.
 */
import type { IssuerRegistration, Jurisdiction, TaxRule, TaxableSupply } from './types.js';

/** `IN-KA` where a region is known, otherwise `IN`. */
export function formatJurisdiction(place: Jurisdiction): string {
  const country = place.countryCode.toUpperCase();
  const region = place.regionCode?.toUpperCase();
  return region ? `${country}-${region}` : country;
}

/**
 * Where this supply is deemed to happen.
 *
 * The customer's location unless the caller says otherwise — see the warning on
 * `TaxableSupply.placeOfSupply` for why that default is the right one for a
 * digital service and the wrong one for a consultation.
 */
export function placeOfSupplyFor(supply: {
  customer: Jurisdiction;
  placeOfSupply?: Jurisdiction;
}): Jurisdiction {
  return supply.placeOfSupply ?? supply.customer;
}

/**
 * The registration that covers a place, or null.
 *
 * A region-specific registration wins over a country-wide one, because that is
 * what having both means: a supply into a state we are registered in is domestic
 * to that state.
 *
 * ⚠️ THE CALLER MAY HAVE ALREADY DECIDED, AND USUALLY HAS. A clinic states which
 *   branches each registration covers, and the invoicing caller passes only the
 *   registrations covering this branch — so what arrives here is often a single
 *   row and this function's job is to confirm it applies to the country at all.
 *   This is the FALLBACK rule, for a branch nobody has stated coverage for, and
 *   it must stay identical to the one the coverage screen shows or the screen
 *   starts describing a selection the engine does not make.
 *
 * ⚠️ AND TIES BREAK ON THE LATEST `effectiveFrom`, WHICH IS LOAD-BEARING RATHER
 *   THAN TIDY. Several registrations may now cover one place — a jurisdiction
 *   that permits a second one, or a successor recorded beside the registration it
 *   replaced. Without an ordering the answer is whichever row the planner
 *   returned first, so the same invoice prints a different GSTIN on two different
 *   days and nobody can say which return it belongs on. Rows without a date sort
 *   last, since a synthesised registration is never in competition with a real one.
 */
export function registrationFor(
  registrations: readonly IssuerRegistration[],
  place: Jurisdiction
): IssuerRegistration | null {
  const country = place.countryCode.toUpperCase();
  const region = place.regionCode?.toUpperCase() ?? null;

  const inCountry = registrations
    .filter((r) => r.countryCode.toUpperCase() === country)
    .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0));
  if (inCountry.length === 0) return null;

  const exact = region
    ? inCountry.find((r) => (r.regionCode?.toUpperCase() ?? null) === region)
    : undefined;

  return exact ?? inCountry.find((r) => r.regionCode === null) ?? inCountry[0] ?? null;
}

/**
 * The rate and treatment for an item, or null when nothing covers it.
 *
 * ⚠️ NULL IS AN ANSWER, AND IT MUST NOT BE TURNED INTO `standardRateBps`.
 *   A category with no rule is a clinic that has not told us what a thing is
 *   taxed at. Applying the registration's standard rate to it produces a
 *   plausible invoice at a rate nobody chose — the exact failure mode this
 *   package refuses everywhere else. `resolveTax` turns null into the `UNRATED`
 *   treatment instead: zero charged, the reason on the document, and a
 *   finalisation step that can refuse to issue it.
 *
 * Effective-dating is inclusive at both ends: a rule that took effect today
 * applies today, and one that lapsed today applied today. A rate change is
 * therefore expressed as `effectiveTo` on the old row being the day BEFORE
 * `effectiveFrom` on the new one, which is how a rate notification reads.
 *
 * ⚠️ Ties break on the LATEST `effectiveFrom`, and that is load-bearing rather
 *   than tidy. The unique key stops two rules for one category starting on the
 *   same day; it cannot stop overlapping RANGES, because an open-ended old rule
 *   whose `effectiveTo` was never set still matches when the new one starts —
 *   which is the ordinary result of adding a rate change and forgetting to
 *   close the previous row. Without this the answer depends on the order
 *   Postgres happened to return, so the same invoice could be taxed twice at
 *   two rates on two different days.
 */
export function ruleFor(
  rules: readonly TaxRule[],
  registration: IssuerRegistration,
  taxCategory: string,
  at: Date
): TaxRule | null {
  return rulesFor(rules, registration, taxCategory, at)[0] ?? null;
}

/**
 * EVERY rule that applies, in the order the lines should print.
 *
 * ⚠️ THE REASON THIS RETURNS A LIST AND NOT ONE RULE.
 *   A region-specific rule normally REPLACES the country-wide one: an Indian
 *   state rate is instead of the national rate, and a VAT country has one rate
 *   full stop. Canada is not like that. A British Columbia clinic charges
 *   federal GST at 5% AND provincial PST at 7% — two lines, two authorities, two
 *   returns, on one invoice. An engine that can only pick one rule cannot bill
 *   Canada at all, and would silently undercharge by 7% rather than fail.
 *
 *   So a rule declares which it is. `stacks: false` (the default) overrides;
 *   `stacks: true` adds. US state + county + city would stack three deep by the
 *   same mechanism, if this engine computed them — it does not, deliberately;
 *   see `PROVIDER_REQUIRED`.
 *
 * The base rule comes first, so `lines[0]` is the principal tax and stacked
 * regional taxes follow in effective-date order. That is the order these appear
 * on a real Canadian invoice.
 *
 * Effective-dating is inclusive at both ends: a rule that took effect today
 * applies today, and one that lapsed today applied today. A rate change is
 * therefore expressed as `effectiveTo` on the old row being the day BEFORE
 * `effectiveFrom` on the new one, which is how a rate notification reads.
 *
 * ⚠️ Ties break on the LATEST `effectiveFrom`, and that is load-bearing rather
 *   than tidy. The unique key stops two rules for one category starting on the
 *   same day; it cannot stop overlapping RANGES, because an open-ended old rule
 *   whose `effectiveTo` was never set still matches when the new one starts —
 *   which is the ordinary result of adding a rate change and forgetting to
 *   close the previous row. Without this the answer depends on the order
 *   Postgres happened to return, so the same invoice could be taxed twice at
 *   two rates on two different days.
 */
export function rulesFor(
  rules: readonly TaxRule[],
  registration: IssuerRegistration,
  taxCategory: string,
  at: Date
): TaxRule[] {
  const country = registration.countryCode.toUpperCase();
  const region = registration.regionCode?.toUpperCase() ?? null;

  const applicable = rules
    .filter(
      (rule) =>
        rule.taxCategory === taxCategory &&
        rule.scheme === registration.scheme &&
        rule.countryCode.toUpperCase() === country &&
        rule.effectiveFrom <= at &&
        (rule.effectiveTo === null || rule.effectiveTo >= at) &&
        // A regional rule for another region is simply not applicable here.
        (rule.regionCode === null || rule.regionCode.toUpperCase() === region)
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());

  /*
   * ⚠️ ALL-OR-NOTHING PER CATEGORY, AND NOT ROW BY ROW.
   *   If the clinic wrote ANY applicable rule for this category, its whole set
   *   is used and rcln's maintained defaults are ignored for that category.
   *
   *   Merging the two would look helpful and produce rate cards nobody authored:
   *   a clinic that overrode British Columbia's federal GST would silently keep
   *   inheriting our provincial PST, so the invoice would carry one rate the
   *   clinic chose and one it has never seen, and neither the clinic nor we
   *   could say who decided the total. A category is a small enough unit to own
   *   outright.
   */
  const tenant = applicable.filter((rule) => rule.source === 'TENANT');
  const candidates = tenant.length > 0 ? tenant : applicable;

  const overriding = candidates.filter((rule) => !rule.stacks);
  const stacked = candidates.filter((rule) => rule.stacks);

  const regional = region
    ? overriding.find((rule) => (rule.regionCode?.toUpperCase() ?? null) === region)
    : undefined;
  const base = regional ?? overriding.find((rule) => rule.regionCode === null) ?? overriding[0];

  /*
   * No base rule means nothing to stack ON. A province that has configured its
   * PST but not the federal GST underneath it is misconfigured, and charging the
   * PST alone would produce an invoice that is wrong in the undercharging
   * direction — which the clinic, not the patient, ends up owing.
   */
  if (!base) return [];

  return [base, ...stacked];
}

/**
 * What rate applies to this supply under this registration, and why.
 *
 * The one place the two worlds meet. A supply naming no category is the
 * one-product case and takes the registration's standard rate; a supply naming
 * one must find a rule or come back unrated.
 */
export interface ResolvedRate {
  /** Empty when `treatment` is not STANDARD. Ordered: principal tax first. */
  rules: TaxRule[];
  /** The combined rate, for the reason string only. Lines carry their own. */
  rateBps: number;
  treatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT' | 'UNRATED';
  /** The category asked for, when one was. Only for the reason string. */
  taxCategory: string | null;
}

/** The rule a one-product issuer implies, so every path below prices a rule. */
function syntheticRule(registration: IssuerRegistration, rateBps: number): TaxRule {
  return {
    countryCode: registration.countryCode,
    regionCode: registration.regionCode,
    scheme: registration.scheme,
    taxCategory: '',
    rateBps,
    treatment: 'STANDARD',
    /*
     * India's split is statutory and applies to a subscription invoice exactly
     * as it does to a patient invoice, so the one-product path keeps it. Every
     * other GST country and every VAT country prints one line.
     */
    split: registration.countryCode.toUpperCase() === 'IN' ? 'INTRA_STATE_HALVES' : 'NONE',
    lineName: registration.scheme === 'VAT' ? 'VAT' : 'GST',
    regionalLineName: null,
    stacks: false,
    // Synthesised from the registration itself, so nothing can override it.
    source: 'TENANT',
    effectiveFrom: new Date(0),
    effectiveTo: null,
  };
}

export function rateFor(supply: TaxableSupply, registration: IssuerRegistration): ResolvedRate {
  const none = (
    treatment: ResolvedRate['treatment'],
    taxCategory: string | null
  ): ResolvedRate => ({
    rules: [],
    rateBps: 0,
    treatment,
    taxCategory,
  });

  if (supply.taxCategory === undefined) {
    /*
     * An issuer with no standard rate is one that prices per item — every
     * clinic. A supply that names no category has nothing to resolve against,
     * so it is unrated rather than free. Charging zero silently here is how a
     * miswired caller produces a whole day of tax-free invoices that look fine.
     */
    if (registration.standardRateBps === null) return none('UNRATED', null);

    const synthetic = syntheticRule(registration, registration.standardRateBps);
    return {
      rules: [synthetic],
      rateBps: synthetic.rateBps,
      treatment: 'STANDARD',
      taxCategory: null,
    };
  }

  const applicable = rulesFor(
    supply.rules ?? [],
    registration,
    supply.taxCategory,
    supply.suppliedAt
  );

  if (applicable.length === 0) return none('UNRATED', supply.taxCategory);

  /*
   * The BASE rule decides the treatment, and an untaxed base stops everything.
   * A province cannot stack PST onto a supply the country exempts — if the
   * consultation is not taxable federally there is no taxable supply for a
   * provincial tax to attach to.
   */
  const base = applicable[0]!;
  if (base.treatment !== 'STANDARD') return none(base.treatment, supply.taxCategory);

  const standard = applicable.filter((rule) => rule.treatment === 'STANDARD');

  return {
    rules: standard,
    rateBps: standard.reduce((sum, rule) => sum + rule.rateBps, 0),
    treatment: 'STANDARD',
    taxCategory: supply.taxCategory,
  };
}
