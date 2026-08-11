/**
 * The clinic's own tax configuration — its registrations, and its rate card.
 *
 * ⚠️ THESE ARE NOT `billing.ts`'s TAX SHAPES, AND THE TWO PAIRS ARE ALMOST
 *   IDENTICAL ON PURPOSE. `createTaxRegistrationRequest` there is a jurisdiction
 *   RCLN collects tax in, and `createTaxRuleDefaultRequest` is the catalogue rcln
 *   publishes per country; both are the platform console's and both are
 *   maintained by whoever is on shift when a rate notification lands. Everything
 *   in this file is one CLINIC's: `issuer_tax_registrations` is the GSTIN the
 *   clinic holds and prints on its invoices, and `tax_rules` is what the clinic
 *   decided to charge where it disagrees with the catalogue. Four tables, two
 *   audiences, one shape — which is exactly why they must not share a type.
 *
 * ⚠️ A ROW HERE IS A LEGAL POSITION, NOT A PREFERENCE. A registration says this
 *   clinic is registered with that authority, and from the moment it takes effect
 *   every invoice whose place of supply it covers carries tax. A rule decides what
 *   each kind of item is charged. An EXEMPT consultation rated at 18% collects
 *   money nobody owed; a 12% medicine rated at 0% leaves the clinic owing tax it
 *   never took. Hence `billing.tax.manage` rather than a settings code.
 *
 * ⚠️ AND NOTHING HERE IS RETROACTIVE. Rates are effective-dated and a change is a
 *   NEW ROW rather than an edit: `effectiveTo` on the old one is the day before
 *   `effectiveFrom` on the new one, which is how a rate notification reads and
 *   what keeps last year's invoices explicable. Editing a live row rewrites what
 *   an already-issued invoice was priced under — the invoice's own totals are
 *   frozen, so the document stays right and the explanation of it stops matching.
 */
import { z } from 'zod';

import { calendarDate, uuid } from './common.js';

/**
 * Which kind of tax regime. The same three the platform tables carry.
 *
 * Not an open string: the engine's selection matches the registration's scheme
 * against the rule's, so a fourth value nobody taught `resolveTax` about would
 * produce rules that silently never apply.
 */
export const taxScheme = z.enum(['GST', 'VAT', 'SALES_TAX']);
export type TaxSchemeValue = z.infer<typeof taxScheme>;

/**
 * What an ITEM can be, and only that.
 *
 * ⚠️ THREE VALUES, NOT THE WHOLE ENUM, AND A CHECK CONSTRAINT SAYS SO TOO.
 *   `REVERSE_CHARGE` is a fact about the two parties to a supply, and
 *   `NOT_REGISTERED`, `UNRATED` and `PROVIDER_REQUIRED` are facts about the
 *   issuer — none is something a consultation can be. A rate card row asserting
 *   one would be claiming a legal position it knows nothing about.
 */
export const itemTaxTreatment = z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']);
export type ItemTaxTreatmentValue = z.infer<typeof itemTaxTreatment>;

/** India's constitutional CGST/SGST halving, and nothing else. */
export const taxSplit = z.enum(['NONE', 'INTRA_STATE_HALVES']);
export type TaxSplitValue = z.infer<typeof taxSplit>;

const countryCode = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'two letters, like IN or IE')
  .transform((value) => value.toUpperCase());

/**
 * ISO 3166-2 subdivision WITHOUT the country prefix — `KA`, not `IN-KA`.
 *
 * An empty string normalises to null, because an untouched optional text input
 * submits `''` and "the whole country" is the common case rather than the
 * exceptional one. Almost every GST RATE is country-wide even though every GSTIN
 * is per state.
 */
const regionCode = z
  .string()
  .max(10)
  .regex(/^[A-Za-z0-9-]*$/, 'letters, digits and hyphens only')
  .transform((value) => value.toUpperCase())
  .optional()
  .transform((value) => (value ? value : null))
  .nullable();

// ---------------------------------------------------------------------------
// The clinic's registrations
// ---------------------------------------------------------------------------

export const createClinicTaxRegistrationRequest = z.object({
  countryCode,
  regionCode,
  scheme: taxScheme,
  /** The clinic's number with that authority. Printed on every invoice it covers. */
  registrationNumber: z.string().trim().min(3).max(64),
  /**
   * The name the registration is held in.
   *
   * ⚠️ NOT ALWAYS THE NAME OVER THE DOOR, WHICH IS WHY IT IS A FIELD AND NOT A
   *   JOIN TO `organizations.name`. A GST invoice must print the REGISTERED legal
   *   name — "Sharma Healthcare Private Limited" where the clinic trades as
   *   "Lotus Clinic" — and printing the trading name instead is a defective
   *   invoice. Optional because a clinic whose two names agree should not have to
   *   type it twice; the engine falls back to the organization.
   */
  legalName: z.string().trim().max(255).optional().nullable(),
  /**
   * When the registration took effect.
   *
   * ⚠️ LOAD-BEARING, NOT DECORATIVE. A supply made before this date is not
   *   taxable by the clinic even though the row exists — which is exactly the
   *   situation on the first invoices after registering, and on any invoice
   *   raised later for an earlier consultation.
   */
  effectiveFrom: calendarDate,
  /** When it lapsed, if it has. Null means still live. */
  effectiveTo: calendarDate.optional().nullable(),
});
export type CreateClinicTaxRegistrationRequest = z.infer<typeof createClinicTaxRegistrationRequest>;

/**
 * Correcting a registration.
 *
 * ⚠️ A CORRECTION AND NOT A RATE CHANGE, WHICH IS WHY THIS ONE MAY EDIT IN PLACE
 *   WHERE A RULE SHOULD NOT. A mistyped GSTIN is the thing somebody most needs to
 *   fix, and the number an invoice PRINTED is snapshotted onto the invoice at
 *   issue — so correcting the row cannot rewrite a document that has already gone
 *   out. A registration genuinely lapsing is `effectiveTo`, not an edit.
 */
export const updateClinicTaxRegistrationRequest = createClinicTaxRegistrationRequest.partial();
export type UpdateClinicTaxRegistrationRequest = z.infer<typeof updateClinicTaxRegistrationRequest>;

/**
 * Where a registration is in its life, derived from the dates and never stored.
 *
 * A stored flag would go stale at midnight with nothing writing to the row, and
 * three states is the smallest set that lets a screen separate "we registered
 * but it has not started" from "we used to hold this". Both are ordinary: a
 * clinic records a registration the week before it takes effect, and keeps the
 * one it replaced because invoices raised under it must stay explicable.
 */
export const TAX_REGISTRATION_STATUSES = ['SCHEDULED', 'ACTIVE', 'LAPSED'] as const;
export type TaxRegistrationStatus = (typeof TAX_REGISTRATION_STATUSES)[number];

/**
 * How a registration's covered branches were arrived at.
 *
 * ⚠️ THE DIFFERENCE BETWEEN A FACT AND A COINCIDENCE, AND A SCREEN MUST SAY
 *   WHICH. `EXPLICIT` means somebody stated this coverage. `JURISDICTION` means
 *   nobody has, and the branches listed are the ones whose place of supply
 *   happens to match — the historic behaviour, kept as a fallback so a clinic
 *   that never opens the coverage editor bills exactly as it did before.
 */
export const COVERAGE_MODES = ['EXPLICIT', 'JURISDICTION'] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

export interface ClinicTaxRegistrationSummary {
  id: string;
  countryCode: string;
  /** Null means the whole country. */
  regionCode: string | null;
  scheme: TaxSchemeValue;
  registrationNumber: string;
  legalName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Whether it applies today — derived from the dates, never stored. */
  isLive: boolean;
  /** SCHEDULED / ACTIVE / LAPSED, from the same dates as `isLive`. */
  status: TaxRegistrationStatus;
  /** `IN-KA` or `IN`. The jurisdiction the registration is held in. */
  placeOfSupply: string;
  /**
   * Which branches this registration covers, by name.
   *
   * ⚠️ COVERAGE IS A STATEMENT, AND `coverageMode` SAYS WHETHER ANYONE HAS MADE
   *   IT. Under `EXPLICIT` these are the branches the clinic assigned. Under
   *   `JURISDICTION` nobody has assigned any, and these are the branches whose
   *   place of supply matches — which is how selection used to work everywhere,
   *   and is also the commonest configuration mistake made visible: a Karnataka
   *   GSTIN covers nothing at all if every branch is recorded in Maharashtra, and
   *   the symptom is invoices issued with no tax and no error.
   */
  coveredBranches: { id: string; name: string }[];
  coverageMode: CoverageMode;
}

/**
 * Which branches this registration covers. The whole set, every time.
 *
 * ⚠️ A REPLACE AND NOT A PATCH, LIKE OPENING HOURS. A branch left out of the
 *   list stops being covered, which is the honest reading of "these are the
 *   branches" and the only one that lets a clinic REMOVE coverage. An empty list
 *   is a legitimate answer — it returns the registration to jurisdiction
 *   matching rather than deleting it.
 */
export const setClinicTaxRegistrationBranchesRequest = z.object({
  branchIds: z.array(uuid).max(200),
});
export type SetClinicTaxRegistrationBranchesRequest = z.infer<
  typeof setClinicTaxRegistrationBranchesRequest
>;

// ---------------------------------------------------------------------------
// The clinic's rate card
// ---------------------------------------------------------------------------

export const createClinicTaxRuleRequest = z.object({
  countryCode,
  regionCode,
  scheme: taxScheme,
  /**
   * The item key: an HSN/SAC code (`999312`, `3004`) or the clinic's own
   * category (`CONSULTATION`).
   *
   * ⚠️ MATCHED EXACTLY, WITH NO PREFIX TREE, AND THAT IS DELIBERATE. An HSN
   *   prefix match that silently finds a broader heading is how a confident
   *   wrong rate gets applied. A line whose category matches nothing is UNRATED,
   *   which refuses to issue rather than charging nothing.
   */
  taxCategory: z.string().trim().min(1).max(64),
  /** What a human calls it on this screen. Never printed on an invoice. */
  description: z.string().trim().max(255).optional().nullable(),
  /** Basis points. 5% is 500. Must be 0 unless the treatment is STANDARD. */
  rateBps: z.number().int().min(0).max(10_000),
  treatment: itemTaxTreatment.default('STANDARD'),
  /**
   * ⚠️ WHAT THE AUTHORITY CALLS THIS TAX, PRINTED VERBATIM ON THE INVOICE. `GST`,
   *   `VAT`, `HST`, `PST`. Per-rule rather than per-country because one country
   *   needs several: an Ontario clinic charges one 13% `HST` line, a British
   *   Columbia one charges 5% `GST` plus 7% `PST`, and both are Canada. A generic
   *   "Tax" is compliant nowhere.
   */
  lineName: z.string().trim().min(1).max(32),
  /**
   * The state half's name when splitting. Null derives it from `lineName` —
   * `GST` becomes `SGST` — which is right for a state and wrong for a union
   * territory, where it is `UTGST`.
   */
  regionalLineName: z.string().trim().max(32).optional().nullable(),
  split: taxSplit.default('NONE'),
  /**
   * Whether this rule applies IN ADDITION to the country-wide rule for the same
   * category rather than instead of it.
   *
   * ⚠️ THE DIFFERENCE BETWEEN CANADA AND EVERYWHERE ELSE. A regional rule
   *   normally OVERRIDES the country-wide one — an Indian state rate replaces the
   *   national rate. In Canada it STACKS: federal GST as well as provincial PST,
   *   two lines owed to two authorities. A country-wide rule cannot stack; it
   *   would stack on itself, and a CHECK constraint refuses it.
   */
  stacks: z.boolean().default(false),
  effectiveFrom: calendarDate,
  effectiveTo: calendarDate.optional().nullable(),
});
export type CreateClinicTaxRuleRequest = z.infer<typeof createClinicTaxRuleRequest>;

/**
 * Editing a rule.
 *
 * ⚠️ FOR FIXING A ROW THAT WAS WRONG, NOT FOR CHANGING A RATE. A rate change is a
 *   new row with a later `effectiveFrom`, and the API says so when an edit would
 *   move the rate on a rule that has already priced an issued invoice. Both
 *   paths exist because both happen: a typo in a `lineName` on a rule nobody has
 *   billed under is a correction, and 12% becoming 18% next April is history.
 */
export const updateClinicTaxRuleRequest = createClinicTaxRuleRequest.partial().extend({
  /*
   * ⚠️ THE THREE DEFAULTED FIELDS ARE RE-DECLARED WITHOUT THEIR DEFAULTS, AND
   *   `.partial()` ALONE IS A SILENT DATA LOSS. Zod's `.partial()` makes a key
   *   optional and leaves any `.default()` on it in place, so `{ description }`
   *   parses to `{ description, treatment: 'STANDARD', split: 'NONE', stacks:
   *   false }` — and a PATCH that only renamed a rule would reset an Indian
   *   split rule to unsplit and an exempt rule to standard-rated. The service
   *   writes exactly the keys it receives, so the defaults would have been
   *   written. Measured: it turned a description edit into a 409 in the tax
   *   suite, which is how it was found.
   */
  treatment: itemTaxTreatment.optional(),
  split: taxSplit.optional(),
  stacks: z.boolean().optional(),
});
export type UpdateClinicTaxRuleRequest = z.infer<typeof updateClinicTaxRuleRequest>;

export interface ClinicTaxRuleSummary {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: TaxSchemeValue;
  taxCategory: string;
  description: string | null;
  rateBps: number;
  treatment: ItemTaxTreatmentValue;
  lineName: string;
  regionalLineName: string | null;
  split: TaxSplitValue;
  stacks: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Whether it applies today — derived from the dates, never stored. */
  isLive: boolean;
  /** `IN-KA` or `IN`. What it matches against a branch's place of supply. */
  jurisdiction: string;
  /**
   * Whether an issued invoice was priced under this rule.
   *
   * ⚠️ WHAT MAKES A ROW UNDELETABLE, AND THE SCREEN SHOULD SAY SO BEFORE THE API
   *   REFUSES. `invoice_taxes` cites the rule that priced each line, so a rule
   *   with invoices behind it is the explanation of documents a clinic has
   *   already handed out. It can be ENDED — `effectiveTo` — and it cannot be
   *   removed.
   */
  usedOnIssuedInvoices: boolean;
}

/**
 * The whole rate card, as a clinic reads it.
 *
 * ⚠️ INHERITED AND OVERRIDDEN ROWS SIDE BY SIDE, BECAUSE "WHAT DO WE CHARGE FOR A
 *   CONSULTATION?" CANNOT BE ANSWERED FROM `tax_rules` ALONE. rcln maintains a
 *   catalogue per country and a clinic inherits it until it writes its own rule;
 *   the defaults are READ at pricing time, never copied at signup, so a clinic
 *   with an empty `tax_rules` table is fully configured rather than unconfigured.
 *   A screen showing only the clinic's own rows would show nothing and imply
 *   nothing is charged.
 *
 * ⚠️ AND THE PRECEDENCE IS ALL-OR-NOTHING PER CATEGORY, NOT ROW BY ROW. If the
 *   clinic wrote ANY applicable rule for a category, its whole set is used and
 *   the catalogue is ignored for that category — which is why `rules` is grouped
 *   by category and each group states its own source. Merging the two would
 *   produce rate cards nobody authored.
 */
export interface TaxCategoryCard {
  taxCategory: string;
  /** Where the applied rows come from. `TENANT` means the clinic overrode it. */
  source: 'TENANT' | 'PLATFORM';
  /** The rows that would price an item in this category today. */
  applied: ClinicTaxRuleSummary[];
  /**
   * The catalogue rows this clinic is overriding, when it is.
   *
   * Present only for a `TENANT` category, and the reason it is here is that
   * "we charge 5% where rcln says 12%" is the single most useful sentence this
   * screen can produce — either the clinic is right and the catalogue is stale,
   * or somebody typed a rate they should not have.
   */
  overriding: ClinicTaxRuleSummary[];
}

export interface TaxRateCardResponse {
  /**
   * The country this card was resolved for.
   *
   * A clinic's rate card is per country because a tax rule is, and the country
   * comes from the branches — not from a parameter, which would let a caller ask
   * about a country they do not operate in and get a plausible answer.
   */
  countryCode: string;
  registrations: ClinicTaxRegistrationSummary[];
  /**
   * Every branch, so coverage can be stated on this screen.
   *
   * ⚠️ CARRIED HERE RATHER THAN FETCHED FROM `/branches`, BECAUSE THE PERMISSIONS
   *   ARE DIFFERENT. Someone with `billing.tax.manage` and no `branch.read` is an
   *   ordinary shape — a bookkeeper, not an administrator — and they would get a
   *   403 for the list and no way to say which places bill under which number.
   *   Three fields, no address, no contact details: enough to choose from.
   */
  branches: { id: string; name: string; placeOfSupply: string }[];
  /** Every category either the clinic or the catalogue has a rule for. */
  categories: TaxCategoryCard[];
  /**
   * Categories that appear on this clinic's invoices and have no rule anywhere.
   *
   * ⚠️ THE ONLY PART OF THIS RESPONSE THAT IS ABOUT A PROBLEM. An UNRATED line
   *   refuses to issue, so a category in this list is a bill somebody cannot hand
   *   over — and the clinic finds out at the counter unless the rate-card screen
   *   tells them first. Derived from the DRAFT invoices that exist, so it is
   *   specific rather than a warning about everything that could go wrong.
   */
  unratedCategories: string[];
}

/** Which registration and which rules a caller wants. Ids and dates only. */
export const listClinicTaxRulesQuery = z.object({
  /** Include rows whose dates have lapsed. Default is the live card. */
  includeExpired: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  taxCategory: z.string().trim().max(64).optional(),
});
export type ListClinicTaxRulesQuery = z.infer<typeof listClinicTaxRulesQuery>;

export const clinicTaxParams = z.object({ id: uuid });
