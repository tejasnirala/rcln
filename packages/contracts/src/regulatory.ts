/**
 * Regulatory: what a jurisdiction says may be done with a product.
 *
 * `products.ts` says what a thing IS, `inventory.ts` says where it is,
 * `procurement.ts` says how it got there — and this says what the law allows to
 * happen to it, here, today.
 *
 * ── TWO SURFACES, AND THEY ARE NOT THE SAME SHAPE ────────────────────────────
 *   PLATFORM   jurisdictions · authorities · sources · packs · rules
 *              rcln's console. A clinic reads them and never writes one; the
 *              database refuses a write from a tenant transaction outright.
 *   TENANT     product regulatory profiles, and the evaluation endpoint
 *              What a clinic asserts about its own products, and asking the
 *              engine a question.
 *
 * ⚠️ NOTHING ON THIS SURFACE CLAIMS LEGAL COMPLIANCE FOR ANY JURISDICTION. A
 *   decision is what the configured rules say. `maturity` on every pack, and
 *   `lowestPackMaturity` on every decision, is how the screens say so out loud
 *   rather than implying compliance by silence (PI-ADR-009).
 *
 * ⚠️ `UNDETERMINED` IS A REFUSAL, AND EVERY CONSUMER OF `regulatoryDecision`
 *   MUST TREAT IT AS ONE. It means no rule covers this, or a rule could not be
 *   read, or a fact the rule needed was never supplied. Rendering it as a
 *   warning beside a green button is the failure the whole domain is shaped to
 *   avoid.
 *
 * NO PHI. The evaluation request carries an AGE and a subject type, never a
 * name, an identifier or a patient id — a rule needs to know whether somebody is
 * sixteen, never who they are.
 */
import { z } from 'zod';
import { uuid } from './common.js';
import {
  catalogueCode,
  countryCode,
  decimalString,
  effectiveDate,
  productType,
} from './products.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in regulatory.prisma
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE LAST TWO ARE NOT SETTABLE THROUGH `updateRulePackRequest`, AND THAT IS
 *   ENFORCED IN THREE PLACES: this enum is split below, the service refuses
 *   them, and `regulatory_rule_packs_review_recorded` refuses either without a
 *   reviewer's name. PI-ADR-009.
 */
export const rulePackMaturity = z.enum([
  'ARCHITECTURE_SUPPORTED',
  'RULES_CONFIGURED',
  'RULES_IMPLEMENTED',
  'AUTOMATED_TESTED',
  'SOURCE_VERIFIED',
  'REGULATORY_REVIEW_PENDING',
  'REGULATORY_REVIEWED',
  'PRODUCTION_ENABLED',
]);

/** The maturities a request may set. The other two need a human and a name. */
export const codeSettableMaturity = z.enum([
  'ARCHITECTURE_SUPPORTED',
  'RULES_CONFIGURED',
  'RULES_IMPLEMENTED',
  'AUTOMATED_TESTED',
  'SOURCE_VERIFIED',
  'REGULATORY_REVIEW_PENDING',
]);

/** What a human's sign-off may set it to, and nothing else. */
export const approvedMaturity = z.enum(['REGULATORY_REVIEWED', 'PRODUCTION_ENABLED']);

export const regulatoryRuleType = z.enum([
  'PRESCRIPTION_REQUIRED',
  'PRESCRIBER_AUTHORITY',
  'PHARMACIST_AUTHORITY',
  'CONTROLLED_SCHEDULE',
  'QUANTITY_LIMIT',
  'REFILL_RULE',
  'AGE_RESTRICTION',
  /** WHO it may be supplied FOR — a person, or an animal of a named species (PI-11). */
  'SPECIES_RESTRICTION',
  'SUBSTITUTION',
  'ONLINE_DISPENSING',
  'STORAGE_REQUIREMENT',
  'RECORD_RETENTION',
  'TRACEABILITY_REQUIREMENT',
  'LABELLING_REQUIREMENT',
  'REPORTING_REQUIREMENT',
  'DISPOSAL_REQUIREMENT',
  'IMPORT_RESTRICTION',
]);

export const regulatoryTransactionType = z.enum([
  'DISPENSE',
  'COUNTER_SALE',
  'ONLINE_DISPENSE',
  'CONSUME',
  'STOCK',
  'TRANSFER',
  'DISPOSE',
]);

export const regulatoryRuleStatus = z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'WITHDRAWN']);

export const regulatorySourceStatus = z.enum([
  'UNVERIFIED',
  'VERIFIED',
  'UNAVAILABLE',
  'SUPERSEDED',
]);

export const productRegistrationStatus = z.enum([
  'UNKNOWN',
  'NOT_REGISTERED',
  'PENDING',
  'REGISTERED',
  'SUSPENDED',
  'CANCELLED',
  'WITHDRAWN',
]);

export const prescriptionRequirement = z.enum([
  'UNKNOWN',
  'NOT_REQUIRED',
  'PHARMACIST_ONLY',
  'PRESCRIPTION_REQUIRED',
  'CONTROLLED',
]);

export const onlineSalePosition = z.enum(['UNKNOWN', 'PERMITTED', 'RESTRICTED', 'PROHIBITED']);

export const regulatoryOutcome = z.enum([
  'PERMITTED',
  'PERMITTED_WITH_CONDITIONS',
  'REFUSED',
  'UNDETERMINED',
]);

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/*
 * ⚠️ `countryCode` IS IMPORTED FROM `products.ts` RATHER THAN REDEFINED. A second
 *   copy is a second opinion about whether `in` is a country, and the two sides
 *   of a jurisdiction comparison must agree on the answer down to the case.
 */

/**
 * ISO 3166-2 WITHOUT the country prefix — `KA`, not `IN-KA`.
 *
 * ⚠️ THE PREFIXED FORM IS THE MOST LIKELY DATA-ENTRY MISTAKE IN THIS DOMAIN AND
 *   IT FAILS SILENTLY: `IN-KA` never equals the `KA` on the branch, so the
 *   jurisdiction simply never matches and every rule in it is inert while
 *   looking perfectly configured. Refused here rather than discovered later.
 */
export const regionCode = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9]+$/, 'the subdivision only, without the country prefix — KA, not IN-KA')
  .toUpperCase();

const listMeta = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const documentPage = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// ===========================================================================
// Jurisdictions (PI-5.1)
// ===========================================================================

export const createJurisdictionRequest = z.object({
  countryCode,
  /** NULL = the whole country, which is what most rows are. */
  regionCode: regionCode.nullish(),
  name: z.string().trim().min(2).max(255),
  isActive: z.boolean().default(true),
});

export const updateJurisdictionRequest = createJurisdictionRequest.partial();

export const jurisdictionQuery = z.object({
  ...documentPage,
  countryCode: countryCode.optional(),
  includeInactive: z.stringbool().default(false),
});

export const jurisdictionSummary = z.object({
  id: uuid,
  countryCode: z.string(),
  regionCode: z.string().nullable(),
  /** `IN-KA` or `IN`. Formatted once, here, so no screen has to. */
  label: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  authorityCount: z.number().int(),
  rulePackCount: z.number().int(),
});

export const jurisdictionListResponse = z.object({
  jurisdictions: z.array(jurisdictionSummary),
  meta: listMeta,
});

// ===========================================================================
// Authorities (PI-5.1)
// ===========================================================================

export const createRegulatoryAuthorityRequest = z.object({
  jurisdictionId: uuid,
  code: catalogueCode,
  name: z.string().trim().min(2).max(255),
  websiteUrl: z.string().trim().max(500).nullish(),
  remit: z.string().trim().max(4000).nullish(),
  isActive: z.boolean().default(true),
});

export const updateRegulatoryAuthorityRequest = createRegulatoryAuthorityRequest
  .omit({ code: true })
  .partial();

export const regulatoryAuthorityQuery = z.object({
  ...documentPage,
  jurisdictionId: uuid.optional(),
  includeInactive: z.stringbool().default(false),
});

export const regulatoryAuthoritySummary = z.object({
  id: uuid,
  jurisdictionId: uuid,
  jurisdictionLabel: z.string(),
  code: z.string(),
  name: z.string(),
  websiteUrl: z.string().nullable(),
  remit: z.string().nullable(),
  isActive: z.boolean(),
});

export const regulatoryAuthorityListResponse = z.object({
  authorities: z.array(regulatoryAuthoritySummary),
  meta: listMeta,
});

// ===========================================================================
// Sources (PI-5.3)
// ===========================================================================

/**
 * ⚠️ NO SOURCE, NO RULE. `regulatory_rules.source_id` is NOT NULL, and this is
 *   the table it points at. Do not invent legal rules: a rule whose source
 *   cannot be found is not written at all, and the country's cell in
 *   COUNTRY_SUPPORT_MATRIX.md stays `RESEARCH_REQUIRED` — a correct, useful,
 *   honest state.
 *
 * ⚠️ A SECONDARY SOURCE IS NOT A SOURCE. A summary, a vendor blog, a law-firm
 *   note or a model's recollection may say where to look; the regulator's own
 *   publication is what goes in this row.
 */
export const createRegulatorySourceRequest = z.object({
  jurisdictionId: uuid,
  authorityId: uuid,
  title: z.string().trim().min(4).max(500),
  documentReference: z.string().trim().max(255).nullish(),
  sourceUrl: z.string().trim().max(1000).nullish(),
  version: z.string().trim().max(64).nullish(),
  publishedOn: effectiveDate.nullish(),
  effectiveFrom: effectiveDate.nullish(),
  /** When somebody last read it. An instant, because it is a thing they did. */
  retrievedAt: z.iso.datetime().nullish(),
  reviewStatus: regulatorySourceStatus.default('UNVERIFIED'),
  notes: z.string().trim().max(4000).nullish(),
});

export const updateRegulatorySourceRequest = createRegulatorySourceRequest.partial();

export const regulatorySourceQuery = z.object({
  ...documentPage,
  jurisdictionId: uuid.optional(),
  authorityId: uuid.optional(),
  reviewStatus: regulatorySourceStatus.optional(),
});

export const regulatorySourceSummary = z.object({
  id: uuid,
  jurisdictionId: uuid,
  jurisdictionLabel: z.string(),
  authorityId: uuid,
  authorityCode: z.string(),
  title: z.string(),
  documentReference: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  version: z.string().nullable(),
  publishedOn: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  reviewStatus: regulatorySourceStatus,
  notes: z.string().nullable(),
  ruleCount: z.number().int(),
});

export const regulatorySourceListResponse = z.object({
  sources: z.array(regulatorySourceSummary),
  meta: listMeta,
});

// ===========================================================================
// Rule packs (PI-5.2, PI-5.6)
// ===========================================================================

export const createRulePackRequest = z.object({
  jurisdictionId: uuid,
  authorityId: uuid,
  /** Semantic and monotonic per jurisdiction. */
  version: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+$/, 'a semantic version, e.g. 1.0.0'),
  name: z.string().trim().min(2).max(255),
  description: z.string().trim().max(4000).nullish(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullish(),
  /**
   * ⚠️ `codeSettableMaturity`, NOT `rulePackMaturity`. A pack cannot be CREATED
   *   signed off — that is the whole ladder, and creating a row already at
   *   `PRODUCTION_ENABLED` is the shortcut this type exists to make unsayable.
   */
  maturity: codeSettableMaturity.default('ARCHITECTURE_SUPPORTED'),
});

/** Same restriction on the way through. Sign-off is its own request below. */
export const updateRulePackRequest = createRulePackRequest
  .omit({ jurisdictionId: true, version: true })
  .partial();

/**
 * A named human signing a jurisdiction off (OD-5, PI-ADR-009).
 *
 * ⚠️ `reviewedBy` IS A NAME AND IS REQUIRED, AND IT IS NOT THE CALLER'S USER
 *   ACCOUNT. The qualified person who reviewed the rules — counsel, a retained
 *   consultant, a registered pharmacist — is frequently not a user of this
 *   system at all. The account that pressed the button is recorded separately,
 *   from the session, because an audit of a regulatory sign-off asks both
 *   questions and a system that can only answer one of them answers the less
 *   useful one.
 */
export const approveRulePackRequest = z.object({
  maturity: approvedMaturity,
  reviewedBy: z.string().trim().min(2).max(255),
  /**
   * What they concluded. Required, because "approved" with no reasoning is not a
   * review anybody can stand behind two years later.
   */
  reviewNotes: z.string().trim().min(10).max(4000),
});

export const rulePackQuery = z.object({
  ...documentPage,
  jurisdictionId: uuid.optional(),
  countryCode: countryCode.optional(),
  maturity: rulePackMaturity.optional(),
});

export const rulePackSummary = z.object({
  id: uuid,
  jurisdictionId: uuid,
  jurisdictionLabel: z.string(),
  authorityId: uuid,
  authorityCode: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  maturity: rulePackMaturity,
  /**
   * Derived, never stored: whether this pack has been signed off for production.
   * Everything else shows the banner.
   */
  isProductionEnabled: z.boolean(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  lastReviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewNotes: z.string().nullable(),
  ruleCount: z.number().int(),
});

export const rulePackListResponse = z.object({
  packs: z.array(rulePackSummary),
  meta: listMeta,
});

// ===========================================================================
// Rules (PI-5.2)
// ===========================================================================

/**
 * ⚠️ WHICH PRODUCTS A RULE APPLIES TO IS TYPED COLUMNS, NEVER AN ID INSIDE
 *   `parameters` (ADR-0006). The JSONB carries the rule's own parameters —
 *   a maximum quantity, a validity period, a list of prescriber classes —
 *   because their shape genuinely varies by jurisdiction. An id in there is
 *   invisible to every constraint, join and cascade in the database.
 *
 * ⚠️ ALL THREE NARROWERS ABSENT MEANS EVERY PRODUCT, and that is a real rule
 *   rather than an oversight — a record-retention obligation usually is.
 */
export const createRegulatoryRuleRequest = z.object({
  ruleType: regulatoryRuleType,
  code: catalogueCode,
  /**
   * ⚠️ PRINTED VERBATIM TO WHOEVER IS REFUSED, so it says what to DO rather than
   *   what failed. "Supply requires a prescription signed by a registered
   *   practitioner" beats "rule TL_POM violated".
   */
  statement: z.string().trim().min(10).max(2000),
  status: regulatoryRuleStatus.default('DRAFT'),
  appliesToProductType: productType.nullish(),
  /** A PLATFORM category. A tenant's own is refused by the database. */
  appliesToCategoryId: uuid.nullish(),
  appliesToClassification: z.string().trim().max(64).nullish(),
  /** Empty means every transaction. */
  appliesToTransactions: z.array(regulatoryTransactionType).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  sourceId: uuid,
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullish(),
});

/**
 * ⚠️ A RULE IS NEVER EDITED INTO A NEW MEANING. What this patch is FOR is
 *   correcting a typo, retiring a rule with an `effectiveTo`, and moving it
 *   between DRAFT and ACTIVE. A change of substance is a new VERSION — see
 *   `superseded` on the rule service — because a transaction decided last year
 *   cites the row that decided it and must stay explicable (PI-ADR-008).
 */
export const updateRegulatoryRuleRequest = createRegulatoryRuleRequest
  .omit({ code: true, ruleType: true })
  .partial();

export const regulatoryRuleQuery = z.object({
  ...documentPage,
  packId: uuid.optional(),
  ruleType: regulatoryRuleType.optional(),
  status: regulatoryRuleStatus.optional(),
});

export const regulatoryRuleDetail = z.object({
  id: uuid,
  packId: uuid,
  packVersion: z.string(),
  packMaturity: rulePackMaturity,
  jurisdictionLabel: z.string(),
  ruleType: regulatoryRuleType,
  code: z.string(),
  statement: z.string(),
  status: regulatoryRuleStatus,
  appliesToProductType: productType.nullable(),
  appliesToCategoryId: uuid.nullable(),
  appliesToClassification: z.string().nullable(),
  appliesToTransactions: z.array(regulatoryTransactionType),
  parameters: z.record(z.string(), z.unknown()),
  sourceId: uuid,
  sourceTitle: z.string(),
  sourceUrl: z.string().nullable(),
  version: z.number().int(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  /** Derived: in force today. Never stored — it would go stale at midnight. */
  isLive: z.boolean(),
});

export const regulatoryRuleListResponse = z.object({
  rules: z.array(regulatoryRuleDetail),
  meta: listMeta,
});

// ===========================================================================
// Product regulatory profiles (PI-5.4) — the TENANT's surface
// ===========================================================================

export const productRegulatoryProfileDetail = z.object({
  id: uuid,
  jurisdictionId: uuid,
  jurisdictionLabel: z.string(),
  jurisdictionName: z.string(),
  registrationNumber: z.string().nullable(),
  registrationStatus: productRegistrationStatus,
  classification: z.string().nullable(),
  controlledSchedule: z.string().nullable(),
  prescriptionRequirement,
  onlineSalePosition,
  dispensingNotes: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isLive: z.boolean(),
});

/**
 * ⚠️ `classification` IS MATCHED EXACTLY AGAINST A RULE'S
 *   `appliesToClassification`, AND IT IS NOT CASE-FOLDED. `SCHEDULE_H` and
 *   `Schedule H` are two different assertions, and guessing which one a clinic
 *   meant is the whole failure mode. The screen offers what the jurisdiction's
 *   rules already use, which is what keeps the two sides spelled alike.
 */
export const productRegulatoryProfileInput = z.object({
  jurisdictionId: uuid,
  registrationNumber: z.string().trim().max(128).nullish(),
  registrationStatus: productRegistrationStatus.default('UNKNOWN'),
  classification: z.string().trim().max(64).nullish(),
  controlledSchedule: z.string().trim().max(64).nullish(),
  prescriptionRequirement: prescriptionRequirement.default('UNKNOWN'),
  onlineSalePosition: onlineSalePosition.default('UNKNOWN'),
  dispensingNotes: z.string().trim().max(4000).nullish(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullish(),
});

/** Replace-all, in the same shape as the tax classifications beside it. */
export const replaceProductRegulatoryProfilesRequest = z.object({
  profiles: z.array(productRegulatoryProfileInput).max(50),
});

// ===========================================================================
// Evaluation (PI-5.5) — asking the engine
// ===========================================================================

/**
 * ⚠️ NO PATIENT ID, NO NAME, NO DATE OF BIRTH. A rule needs to know whether
 *   somebody is sixteen; it never needs to know who they are. Keeping the
 *   request PHI-free is what lets a decision be logged, cached in a screen and
 *   quoted in a support ticket without any of that becoming a disclosure.
 */
export const evaluateRegulatoryRequest = z.object({
  productId: uuid,
  transaction: regulatoryTransactionType,
  /**
   * Where it happens. Omitted, the branch's own country and region are used —
   * which is the right default and the reason this is optional rather than
   * required.
   */
  countryCode: countryCode.optional(),
  regionCode: regionCode.nullish(),
  /**
   * Which branch is asking, when the caller works at more than one.
   *
   * ⚠️ WITHOUT IT THE JURISDICTION WAS WHICHEVER BRANCH SORTED FIRST IN THE
   *   TENANT CONTEXT. A supply happens where the counter is, and an org-wide
   *   pharmacist covering branches in two states would otherwise be evaluated
   *   against an arbitrary one of them — silently, and differently depending on
   *   the order ids came back in.
   */
  branchId: uuid.optional(),
  /**
   * The quantity being moved, in the product's base unit.
   *
   * ⚠️ REQUIRED, AND IT USED TO DEFAULT TO `'0'`. The engine is built so a fact
   *   the caller could not supply comes back `UNDETERMINED` — and a default of
   *   zero filled that silence with a value passing every `maxPerTransactionBase`
   *   ever written. A question that genuinely has no quantity ("may this be kept
   *   here?") sends `"0"`; the point is that somebody chose to.
   */
  quantityBase: decimalString,
  priorQuantityInPeriodBase: decimalString.optional(),
  /**
   * How many days of treatment this supply covers, from the directions for use.
   *
   * ⚠️ OMITTING IT IS NOT NEUTRAL WHERE A RULE ASKS FOR IT (PI-13a). A
   *   `QUANTITY_LIMIT` carrying `maxDaysSupply` — New York's "thirty day supply"
   *   is the case — resolves `UNDETERMINED` without it, which REFUSES. That is
   *   deliberate: thirty days is 30 tablets at one a day and 120 at four a day,
   *   so the quantity alone cannot answer the rule, and guessing would enforce
   *   something nobody wrote.
   */
  daysSupply: z.number().int().min(0).max(3650).optional(),
  prescription: z
    .object({
      presented: z.boolean(),
      signedByQualifiedPrescriber: z.boolean(),
      issuedOn: effectiveDate,
      refillsUsed: z.number().int().min(0).default(0),
      prescriberClasses: z.array(z.string().trim().max(64)).max(20).optional(),
      /**
       * Did the prescriber state ON THE PRESCRIPTION that it may be dispensed
       * more than once? (PI-7.)
       *
       * ⚠️ ON THIS ENDPOINT IT IS A HYPOTHESIS, BECAUSE THIS ENDPOINT ANSWERS A
       *   QUESTION AND AUTHORISES NOTHING — "what would the rules say about an
       *   endorsed repeat" is a legitimate thing to ask. On the DISPENSING path
       *   the pharmacy service reads it off the prescription record and never
       *   from a client, which is the difference between modelling the
       *   endorsement requirement and removing it.
       */
      repeatsAuthorised: z.boolean().optional(),
      /** How many repeats the endorsement states, where it states a number. */
      repeatsAuthorisedLimit: z.number().int().min(0).max(99).optional(),
    })
    .optional(),
  patient: z
    .object({
      ageYears: z.number().int().min(0).max(150).optional(),
      subjectType: z.enum(['HUMAN', 'ANIMAL']).default('HUMAN'),
      /**
       * The animal's species, where the subject is one (PI-11).
       *
       * ⚠️ FREE TEXT, MATCHING `animal_profiles.species`, AND NOT VALIDATED
       *   AGAINST A LIST. A veterinary clinic that treats a tortoise must not
       *   need a migration, and a closed enum here would be a second vocabulary
       *   that drifts from the chart's.
       *
       * ⚠️ AND ON THE DISPENSING PATH IT IS READ OFF THE ANIMAL'S PROFILE, NEVER
       *   FROM A CLIENT. Here it is a hypothesis, for the reason
       *   `repeatsAuthorised` above is: this endpoint answers a question and
       *   authorises nothing.
       */
      species: z.string().trim().max(64).optional(),
    })
    .optional(),
  substitution: z
    .object({
      isSubstitution: z.boolean(),
      prescriberConsented: z.boolean().optional(),
      patientConsented: z.boolean().optional(),
    })
    .optional(),
  locationId: uuid.optional(),
  /**
   * Where an online order is going. The branch's own jurisdiction is where the
   * supply HAPPENS; this is where it ARRIVES, and `ONLINE_DISPENSING` rules
   * restrict exactly that.
   *
   * ⚠️ THE REGION IS ISO 3166-2 WITHOUT THE COUNTRY PREFIX — `KA`, never `IN-KA`
   *   — matching every other region column in this schema, and it is IGNORED
   *   unless a country is given too: a region with no country names no place.
   */
  destinationCountryCode: countryCode.optional(),
  destinationRegionCode: z.string().trim().max(16).optional(),
  traceability: z
    .object({
      gtin: z.string().trim().max(64).nullish(),
      lotNumber: z.string().trim().max(64).nullish(),
      expiresOn: effectiveDate.nullish(),
      serial: z.string().trim().max(128).nullish(),
    })
    .optional(),
  /** The instant asked about. Defaults to now, which is what a counter means. */
  occurredAt: z.iso.datetime().optional(),
});

export const regulatoryCondition = z.object({
  kind: z.enum([
    'RECORD_IN_CONTROLLED_REGISTER',
    'WITNESS_REQUIRED',
    'VERIFY_PATIENT_AGE',
    'VERIFY_PRESCRIBER_REGISTRATION',
    'LABEL_FIELDS',
    'RETAIN_RECORD',
    'REPORT_TO_AUTHORITY',
    'STORE_UNDER_CONDITIONS',
    'DISPOSE_BY_METHOD',
    'REQUIRES_CONSENT',
    // ⚠️ The two the person dispensing cannot discharge — see `RegulatoryCondition`
    // in @rcln/regulatory. Both name a fact established before this transaction.
    'VERIFY_PRIOR_IN_PERSON_EVALUATION',
    'VERIFY_PRIOR_AUTHORISATION',
  ]),
  ruleId: uuid,
  ruleCode: z.string(),
  detail: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const regulatoryReason = z.object({
  ruleId: uuid.nullable(),
  ruleCode: z.string().nullable(),
  ruleType: regulatoryRuleType.nullable(),
  packId: uuid.nullable(),
  packVersion: z.string().nullable(),
  outcome: regulatoryOutcome,
  message: z.string(),
});

export const regulatoryDecisionResponse = z.object({
  outcome: regulatoryOutcome,
  conditions: z.array(regulatoryCondition),
  reasons: z.array(regulatoryReason),
  /** The packs that produced it, for the snapshot a transaction keeps. */
  packVersionIds: z.array(uuid),
  /**
   * The weakest maturity among them, or null when no rule applied.
   *
   * ⚠️ THE SCREENS READ THIS AND SAY SO. Anything below `PRODUCTION_ENABLED`
   *   shows the banner; silence must never imply compliance.
   */
  lowestPackMaturity: rulePackMaturity.nullable(),
  jurisdiction: z.string(),
  /** Whether the product had a profile for this jurisdiction at all. */
  hasProfile: z.boolean(),
  evaluatedAt: z.string(),
});

// ---------------------------------------------------------------------------

export type RulePackMaturity = z.infer<typeof rulePackMaturity>;
export type CodeSettableMaturity = z.infer<typeof codeSettableMaturity>;
export type ApprovedMaturity = z.infer<typeof approvedMaturity>;
export type RegulatoryRuleType = z.infer<typeof regulatoryRuleType>;
export type RegulatoryTransactionType = z.infer<typeof regulatoryTransactionType>;
export type RegulatoryRuleStatus = z.infer<typeof regulatoryRuleStatus>;
export type RegulatorySourceStatus = z.infer<typeof regulatorySourceStatus>;
export type ProductRegistrationStatus = z.infer<typeof productRegistrationStatus>;
export type PrescriptionRequirement = z.infer<typeof prescriptionRequirement>;
export type OnlineSalePosition = z.infer<typeof onlineSalePosition>;
export type RegulatoryOutcome = z.infer<typeof regulatoryOutcome>;

export type CreateJurisdictionRequest = z.infer<typeof createJurisdictionRequest>;
export type UpdateJurisdictionRequest = z.infer<typeof updateJurisdictionRequest>;
export type JurisdictionQuery = z.infer<typeof jurisdictionQuery>;
export type JurisdictionSummary = z.infer<typeof jurisdictionSummary>;
export type JurisdictionListResponse = z.infer<typeof jurisdictionListResponse>;

export type CreateRegulatoryAuthorityRequest = z.infer<typeof createRegulatoryAuthorityRequest>;
export type UpdateRegulatoryAuthorityRequest = z.infer<typeof updateRegulatoryAuthorityRequest>;
export type RegulatoryAuthorityQuery = z.infer<typeof regulatoryAuthorityQuery>;
export type RegulatoryAuthoritySummary = z.infer<typeof regulatoryAuthoritySummary>;
export type RegulatoryAuthorityListResponse = z.infer<typeof regulatoryAuthorityListResponse>;

export type CreateRegulatorySourceRequest = z.infer<typeof createRegulatorySourceRequest>;
export type UpdateRegulatorySourceRequest = z.infer<typeof updateRegulatorySourceRequest>;
export type RegulatorySourceQuery = z.infer<typeof regulatorySourceQuery>;
export type RegulatorySourceSummary = z.infer<typeof regulatorySourceSummary>;
export type RegulatorySourceListResponse = z.infer<typeof regulatorySourceListResponse>;

export type CreateRulePackRequest = z.infer<typeof createRulePackRequest>;
export type UpdateRulePackRequest = z.infer<typeof updateRulePackRequest>;
export type ApproveRulePackRequest = z.infer<typeof approveRulePackRequest>;
export type RulePackQuery = z.infer<typeof rulePackQuery>;
export type RulePackSummary = z.infer<typeof rulePackSummary>;
export type RulePackListResponse = z.infer<typeof rulePackListResponse>;

export type CreateRegulatoryRuleRequest = z.infer<typeof createRegulatoryRuleRequest>;
export type UpdateRegulatoryRuleRequest = z.infer<typeof updateRegulatoryRuleRequest>;
export type RegulatoryRuleQuery = z.infer<typeof regulatoryRuleQuery>;
export type RegulatoryRuleDetail = z.infer<typeof regulatoryRuleDetail>;
export type RegulatoryRuleListResponse = z.infer<typeof regulatoryRuleListResponse>;

export type ProductRegulatoryProfileDetail = z.infer<typeof productRegulatoryProfileDetail>;
export type ProductRegulatoryProfileInput = z.infer<typeof productRegulatoryProfileInput>;
export type ReplaceProductRegulatoryProfilesRequest = z.infer<
  typeof replaceProductRegulatoryProfilesRequest
>;

export type EvaluateRegulatoryRequest = z.infer<typeof evaluateRegulatoryRequest>;
export type RegulatoryCondition = z.infer<typeof regulatoryCondition>;
export type RegulatoryReason = z.infer<typeof regulatoryReason>;
export type RegulatoryDecisionResponse = z.infer<typeof regulatoryDecisionResponse>;
