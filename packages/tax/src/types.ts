/**
 * The vocabulary the tax seam is written in.
 *
 * Every one of these mirrors an enum or a table in the schema, and the mirror is
 * deliberate: this package holds no Prisma client and reads no database, so the
 * caller loads the rows and maps them across. That is what lets every rule below
 * be tested without a tenant, a transaction or a clock.
 */
import type { Money } from '@rcln/payments';

/** Mirrors the `TaxScheme` enum in the schema. */
export type TaxScheme = 'GST' | 'VAT' | 'SALES_TAX';

/** Mirrors `TaxTreatment`. See the schema for what each one means. */
export type TaxTreatment =
  | 'STANDARD'
  | 'REVERSE_CHARGE'
  | 'ZERO_RATED'
  | 'EXEMPT'
  | 'NOT_REGISTERED'
  | 'UNRATED'
  | 'PROVIDER_REQUIRED';

/**
 * The treatments that mean *this document must not be issued*.
 *
 * ⚠️ Both are configuration failures rather than legal positions, and they are
 *   the reason a DRAFT and an ISSUED invoice are different things. Phase 5's
 *   finalisation refuses either. Exported so that guard and this engine cannot
 *   drift — a seventh treatment added here without a decision about issuing is
 *   a treatment that silently becomes issuable.
 */
export const UNISSUABLE_TREATMENTS = ['UNRATED', 'PROVIDER_REQUIRED'] as const;

export function isIssuable(treatment: TaxTreatment): boolean {
  return !(UNISSUABLE_TREATMENTS as readonly string[]).includes(treatment);
}

/** Mirrors the `TaxSplit` enum. How one rate becomes printed lines. */
export type TaxSplit = 'NONE' | 'INTRA_STATE_HALVES';

/**
 * The treatments an ITEM's own nature can produce.
 *
 * A narrower set than `TaxTreatment` on purpose. `REVERSE_CHARGE` is a fact
 * about the two parties and `NOT_REGISTERED` is a fact about the issuer —
 * neither is something a consultation or a box of paracetamol can be. Letting a
 * `tax_rules` row assert either would let a catalogue entry override a legal
 * position it knows nothing about.
 */
export type ItemTaxTreatment = 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';

/** Mirrors `TaxIdStatus`. */
export type TaxIdStatus = 'NOT_PROVIDED' | 'UNVALIDATED' | 'VALID' | 'INVALID';

/**
 * A country, optionally narrowed to a sub-national jurisdiction.
 *
 * `regionCode` is ISO 3166-2 WITHOUT the country prefix — `KA`, not `IN-KA` —
 * because that is how the schema stores it on both sides of the comparison.
 * NULL means country-wide.
 */
export interface Jurisdiction {
  countryCode: string;
  regionCode: string | null;
}

/**
 * One registration the ISSUER holds, as read from `tax_registrations` (rcln
 * billing a clinic) or `issuer_tax_registrations` (a clinic billing a patient).
 *
 * ⚠️ "Issuer", not "supplier", and the rename is the whole point of this
 *    package existing separately. The two tables answer the same question —
 *    *may whoever is raising this document collect tax here?* — for two
 *    different businesses, and the engine must not know which one it is looking
 *    at. Anything in here that reads as "rcln" is a bug.
 */
export interface IssuerRegistration extends Jurisdiction {
  /**
   * The row's own id, so the caller can record WHICH registration an invoice was
   * issued under — `invoices.issuer_tax_registration_id`, composite-FK'd.
   *
   * Not on `TaxQuote`, deliberately: the quote prints a NUMBER, and the number
   * is snapshotted beside the id precisely because the row can be corrected and
   * the printed string may not change. The caller re-runs `registrationFor` with
   * the same place of supply to get the id, which is the same selection rule the
   * engine used rather than a second opinion about it.
   */
  id?: string | null;
  /** The name the registration is held in, which is not always the name over the door. */
  legalName?: string | null;
  scheme: TaxScheme;
  registrationNumber: string;
  /**
   * When this registration took effect, used ONLY to break a tie deterministically.
   *
   * ⚠️ IT IS NOT A FILTER, AND THIS PACKAGE MUST NOT MAKE IT ONE. Whether a
   *   registration is in force on a given day is the caller's question — it loads
   *   the live rows — and re-deciding it here would give two answers to one
   *   question. What the engine needs it for is narrower: an issuer may now hold
   *   SEVERAL registrations covering one place (a jurisdiction where a second
   *   registration is permitted, or a successor recorded beside the one it
   *   replaced), and without an ordering `registrationFor` returns whichever the
   *   planner happened to hand it first — so the same invoice prints a different
   *   number on two different days. The most recently effective one wins.
   *
   * Optional because the subscription path synthesises registrations that have no
   * such row behind them, and because a registration under test does not need one.
   */
  effectiveFrom?: Date | null;
  /**
   * The rate for an issuer that sells ONE thing, so the rate is a property of
   * the registration. `tax_registrations.standard_rate_bps` — rcln's SaaS
   * subscription, and nothing else so far.
   *
   * NULL for an issuer that prices per item, which is every clinic:
   * `issuer_tax_registrations` has no such column, because a clinic billing a
   * consultation and a box of paracetamol against one GSTIN has two rates and
   * neither belongs to the registration. Those supplies name a `taxCategory`
   * and resolve through `rules` instead.
   *
   * ⚠️ It is NOT a fallback for a category that fails to resolve. See `ruleFor`
   *    and the `UNRATED` treatment: guessing a rate for an item nobody
   *    configured produces a plausible invoice at the wrong rate, which is the
   *    failure this whole package is shaped to avoid.
   */
  standardRateBps: number | null;
}

/**
 * One effective-dated rate, as read from `tax_rules`.
 *
 * This is the row that makes patient billing possible at all: an issuer holds
 * ONE registration per state but bills consultations (exempt in India),
 * medicines (5% or 12%) and consumables (12% or 18%) against it. The rate is a
 * property of the item, not of the registration.
 */
export interface TaxRule extends Jurisdiction {
  /**
   * The row's own id, carried onto every line it prices.
   *
   * ⚠️ THIS IS WHAT FILLS `invoice_taxes.tax_rule_id` / `.tax_rule_default_id`,
   *   and without it those columns can only ever be NULL. Optional because the
   *   subscription path synthesises a rule from the registration and there is no
   *   row behind it — and because a rule under test does not need one. Read
   *   together with `source`, which says WHICH of the two tables the id is in:
   *   one id cannot reference both, which is why the schema has two columns and
   *   a CHECK rather than an id plus an enum.
   */
  id?: string | null;
  scheme: TaxScheme;
  /** The item key. An HSN/SAC code, or a clinic's own category. Compared exactly. */
  taxCategory: string;
  rateBps: number;
  treatment: ItemTaxTreatment;
  /**
   * ⚠️ WHAT THE AUTHORITY CALLS THIS TAX. Printed verbatim — a line called
   *   "Tax" is not compliant anywhere. Per-rule and not per-country because one
   *   country needs several: Ontario prints `HST`, British Columbia prints `GST`
   *   and `PST`, and both are Canada.
   */
  lineName: string;
  /** The state half's name when splitting. NULL derives `S` + `lineName`. */
  regionalLineName: string | null;
  split: TaxSplit;
  /** Applies IN ADDITION to the country-wide rule rather than instead of it. */
  stacks: boolean;
  /**
   * Who wrote this rule: the clinic, or rcln's maintained rate card.
   *
   * ⚠️ `TENANT` BEATS `PLATFORM` BEFORE SPECIFICITY IS EVEN CONSIDERED, and
   *   that ordering is deliberate. A clinic's country-wide override outranks
   *   rcln's region-specific default, because the clinic's row is an explicit
   *   act by the party who signs the return and carries the liability. The
   *   alternative — rcln's default silently overriding what a clinic set — makes
   *   rcln the author of somebody else's tax position.
   *
   *   The cost is that a stale tenant override outlives a corrected platform
   *   default. That is a visibility problem, solved by showing the divergence on
   *   the rate-card screen, not by overruling the clinic.
   */
  source: 'TENANT' | 'PLATFORM';
  effectiveFrom: Date;
  /** NULL while the rule is current. */
  effectiveTo: Date | null;
}

/**
 * A quote computed by an EXTERNAL tax provider (Avalara, Stripe Tax, …).
 *
 * ⚠️ THE SEAM THAT MAKES US SALES TAX AND EU OSS POSSIBLE WITHOUT LYING.
 *   Some regimes cannot be computed from a rate table by anybody, at any scale:
 *   US sales tax is ~11,000 jurisdictions combining state, county, city and
 *   special districts, with economic-nexus thresholds over trailing revenue;
 *   EU cross-border consumer VAT needs all 27 rates kept current by statute plus
 *   VIES validation. Both are a subscription, not a column.
 *
 *   This engine stays PURE and SYNCHRONOUS, so it cannot call one itself. The
 *   caller — which is already async and already doing I/O — fetches the quote
 *   and passes it in. Absent where one is required, the supply comes back
 *   `PROVIDER_REQUIRED` rather than at a guessed rate.
 */
export interface TaxProviderQuote {
  lines: TaxLine[];
  total: Money;
  treatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  /** What the provider says it did, for the invoice and for support. */
  reason: string;
}

/** Who is being supplied, and what we know about them. */
export interface TaxableCustomer extends Jurisdiction {
  /** Their GSTIN / VAT number, as given. */
  taxId: string | null;
  taxIdStatus: TaxIdStatus;
}

export interface TaxableSupply {
  /** The amount before tax. Always net — see `netOf` for inclusive prices. */
  net: Money;
  customer: TaxableCustomer;
  /**
   * Every registration the issuer holds. `resolveTax` picks the one covering the
   * place of supply; passing them all keeps the selection rule in one place
   * instead of in every caller.
   */
  registrations: readonly IssuerRegistration[];
  suppliedAt: Date;
  /**
   * Where the supply is DEEMED to happen, when that is not the customer's own
   * location.
   *
   * ⚠️ OMITTING THIS IS A DECISION, NOT A DEFAULT. Omitted, the place of supply
   *    is the customer — the rule for digital and electronically-supplied
   *    services in every regime that matters (India's OIDAR rules, the EU's 2015
   *    change, the UK's), and therefore what a subscription invoice wants.
   *    A service physically performed somewhere is the other case entirely, and
   *    a patient invoice passes the ISSUING BRANCH's jurisdiction here. Getting
   *    this backwards bills a Karnataka clinic's consultation as an inter-state
   *    supply because the patient happens to live in Kerala.
   */
  placeOfSupply?: Jurisdiction;
  /**
   * The item's tax category, when the rate is a property of what was sold
   * rather than of the registration.
   *
   * Given, `rules` decides the rate and `standardRateBps` is never consulted.
   * Omitted, `standardRateBps` applies — the one-product case.
   */
  taxCategory?: string;
  /** Every rule the issuer holds. Only read when `taxCategory` is given. */
  rules?: readonly TaxRule[];
  /**
   * A quote from an external tax provider, where the regime needs one.
   *
   * Consulted for US sales tax and for EU cross-border consumer VAT, and
   * ignored everywhere else — a rate table is the better answer wherever one can
   * be honest. Absent where required, the result is `PROVIDER_REQUIRED`.
   */
  providerQuote?: TaxProviderQuote;
}

export interface TaxLine {
  /** What the jurisdiction calls it. Printed verbatim — "Tax" is not compliant. */
  name: string;
  rateBps: number;
  amount: Money;
  /** `IN-KA`, `IE`. Which authority the line is owed to. */
  jurisdiction: string;
  /**
   * The rule that priced this line, for the auditor who asks why.
   *
   * NULL where no row was involved: a synthesised one-product rate, or a line
   * from an external provider's quote. India's two halves cite the SAME rule —
   * CGST and SGST are one rate split by statute, not two rules.
   */
  ruleId?: string | null;
  /** Which table `ruleId` is in. `tax_rules` if TENANT, `tax_rule_defaults` if PLATFORM. */
  ruleSource?: 'TENANT' | 'PLATFORM' | null;
}

export interface TaxQuote {
  treatment: TaxTreatment;
  lines: TaxLine[];
  total: Money;
  /** `IN-KA`, `IE`, `US-CA`. Snapshotted onto the invoice. */
  placeOfSupply: string;
  /** The issuer's number for that place, as it must appear on the invoice. */
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
