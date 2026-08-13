/**
 * The vocabulary the regulatory seam is written in.
 *
 * Every one of these mirrors an enum or a table in the schema, and the mirror is
 * deliberate: this package holds no Prisma client and reads no database, so the
 * caller loads the rows and maps them across. That is what lets every rule be
 * tested without a tenant, a transaction or a clock — and it is what makes a
 * country's rules a fixture rather than a migration.
 *
 * ⚠️ NOTHING IN THIS PACKAGE CLAIMS LEGAL COMPLIANCE FOR ANY JURISDICTION. It
 *   evaluates the rules it is handed. Whether those rules are right, current and
 *   complete is `regulatory_sources`, `RulePackMaturity` and a named human.
 */

/** Mirrors `RegulatoryRuleType`. */
export type RegulatoryRuleType =
  | 'PRESCRIPTION_REQUIRED'
  | 'PRESCRIBER_AUTHORITY'
  | 'PHARMACIST_AUTHORITY'
  | 'CONTROLLED_SCHEDULE'
  | 'QUANTITY_LIMIT'
  | 'REFILL_RULE'
  | 'AGE_RESTRICTION'
  | 'SUBSTITUTION'
  | 'ONLINE_DISPENSING'
  | 'STORAGE_REQUIREMENT'
  | 'RECORD_RETENTION'
  | 'TRACEABILITY_REQUIREMENT'
  | 'LABELLING_REQUIREMENT'
  | 'REPORTING_REQUIREMENT'
  | 'DISPOSAL_REQUIREMENT'
  | 'IMPORT_RESTRICTION';

/** Mirrors `RegulatoryTransactionType`. What the caller is about to do. */
export type RegulatoryTransaction =
  'DISPENSE' | 'COUNTER_SALE' | 'ONLINE_DISPENSE' | 'CONSUME' | 'STOCK' | 'TRANSFER' | 'DISPOSE';

/** Mirrors `RegulatoryRuleStatus`. Only `ACTIVE` rules are evaluated. */
export type RegulatoryRuleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN';

/** Mirrors `RulePackMaturity`. */
export type RulePackMaturity =
  | 'ARCHITECTURE_SUPPORTED'
  | 'RULES_CONFIGURED'
  | 'RULES_IMPLEMENTED'
  | 'AUTOMATED_TESTED'
  | 'SOURCE_VERIFIED'
  | 'REGULATORY_REVIEW_PENDING'
  | 'REGULATORY_REVIEWED'
  | 'PRODUCTION_ENABLED';

/**
 * The maturities a code path may set (PI-ADR-009).
 *
 * ⚠️ EXPORTED SO THE SERVICE AND THIS PACKAGE CANNOT DRIFT. A ninth maturity
 *   added to the schema without a decision about who may set it is a maturity
 *   that silently becomes settable by an agent, which is the one failure this
 *   whole ladder exists to prevent.
 */
export const CODE_SETTABLE_MATURITIES = [
  'ARCHITECTURE_SUPPORTED',
  'RULES_CONFIGURED',
  'RULES_IMPLEMENTED',
  'AUTOMATED_TESTED',
  'SOURCE_VERIFIED',
  'REGULATORY_REVIEW_PENDING',
] as const;

/** The two states only a named human may set. */
export const HUMAN_ONLY_MATURITIES = ['REGULATORY_REVIEWED', 'PRODUCTION_ENABLED'] as const;

export function isCodeSettableMaturity(maturity: RulePackMaturity): boolean {
  return (CODE_SETTABLE_MATURITIES as readonly string[]).includes(maturity);
}

/** Mirrors `ProductType`. Metadata — never an authorization (see products.prisma). */
export type ProductType =
  | 'MEDICINE'
  | 'VACCINE'
  | 'CONSUMABLE'
  | 'SURGICAL_SUPPLY'
  | 'MEDICAL_DEVICE'
  | 'IMPLANT'
  | 'DENTAL_MATERIAL'
  | 'LAB_REAGENT'
  | 'DIAGNOSTIC_KIT'
  | 'VETERINARY_MEDICINE'
  | 'VETERINARY_CONSUMABLE'
  | 'GENERAL_CLINICAL_SUPPLY';

/** Mirrors `PrescriptionRequirement`. An assertion, never an authorization. */
export type PrescriptionRequirement =
  'UNKNOWN' | 'NOT_REQUIRED' | 'PHARMACIST_ONLY' | 'PRESCRIPTION_REQUIRED' | 'CONTROLLED';

/** Mirrors `LocationKind` in inventory.prisma, as far as this package needs it. */
export type LocationKind = string;

/**
 * A country, optionally narrowed to a sub-national jurisdiction.
 *
 * ⚠️ `regionCode` IS ISO 3166-2 WITHOUT THE COUNTRY PREFIX — `KA`, not `IN-KA`.
 *   Identical to `@rcln/tax`'s `Jurisdiction` on purpose: two spellings of the
 *   same place is how a rule that is configured, visible and correct silently
 *   never matches.
 */
export interface Jurisdiction {
  countryCode: string;
  regionCode: string | null;
}

/**
 * One rule, as read from `regulatory_rules` joined to its pack.
 *
 * ⚠️ `parameters` IS AN UNKNOWN DOCUMENT AND IS PARSED, NEVER TRUSTED. It comes
 *   out of JSONB, which means the type system knows nothing about it and a
 *   half-written rule typechecks perfectly. A parameters document this package
 *   cannot read produces `UNDETERMINED` — see `parameters.ts`.
 */
export interface RegulatoryRule {
  id: string;
  /** The pack this rule belongs to, snapshotted onto every decision it makes. */
  packId: string;
  packVersion: string;
  packMaturity: RulePackMaturity;
  /** The pack's jurisdiction. Region beats country — see `selection.ts`. */
  jurisdiction: Jurisdiction;
  ruleType: RegulatoryRuleType;
  /** Stable machine key, cited in a reason and pinned by a test. */
  code: string;
  /** One sentence, printed verbatim in a refusal. */
  statement: string;
  status: RegulatoryRuleStatus;
  appliesToProductType: ProductType | null;
  appliesToCategoryId: string | null;
  appliesToClassification: string | null;
  /** Empty means EVERY transaction. */
  appliesToTransactions: readonly RegulatoryTransaction[];
  parameters: unknown;
  sourceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** What a clinic asserts about this product here, from `product_regulatory_profiles`. */
export interface ProductRegulatoryProfile {
  id: string;
  jurisdiction: Jurisdiction;
  classification: string | null;
  controlledSchedule: string | null;
  prescriptionRequirement: PrescriptionRequirement;
  registrationNumber: string | null;
  registrationStatus: string;
  onlineSalePosition: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** The prescription being presented, where one is. */
export interface PresentedPrescription {
  presented: boolean;
  signedByQualifiedPrescriber: boolean;
  /** The day it was written, in the clinic's own reckoning. */
  issuedOn: Date;
  refillsUsed: number;
  /** What the prescriber is registered as — `DOCTOR`, `DENTIST`, `VET`. */
  prescriberClasses?: readonly string[];
}

/** Who is standing at the counter, on our side of it. */
export interface RegulatoryActor {
  /**
   * The caller's effective PERMISSION codes for the branch being acted on —
   * `pharmacy.dispense.create`, not `PHARMACIST`.
   *
   * ⚠️ THE NAME SAYS "ROLE" AND THE CONTENT IS PERMISSIONS, WHICH IS A TRAP THIS
   *   COMMENT EXISTS TO DEFUSE. A rule author writing
   *   `{"permittedRoleCodes": ["PHARMACIST"]}` against the obvious reading gets
   *   a rule that matches nobody, forever, while looking perfectly configured —
   *   the "visible and inert" failure this programme keeps finding.
   *
   *   Permission codes are the stable vocabulary: a clinic may clone
   *   `PHARMACIST` into "Dispensary Lead", and a rule naming the ROLE would then
   *   match nobody at that clinic, which reads as the rule being wrong rather
   *   than the role having been renamed. A rule that wants a professional
   *   REGISTRATION names a licence type in `permittedLicenceTypes` instead.
   *
   *   The field keeps its name because `permittedRoleCodes` is the parameter key
   *   a jurisdiction's pack is written against, and renaming a parameter after
   *   packs exist is a migration over somebody's law. Renaming both is PI-6's
   *   call, before the first pack ships.
   */
  roleCodes: readonly string[];
  /** Professional registration numbers the actor holds, by type. */
  licenceTypes?: readonly string[];
}

export interface RegulatoryPatient {
  ageYears?: number;
  subjectType: 'HUMAN' | 'ANIMAL';
}

/** What the caller can prove about the physical stock in front of it. */
export interface TraceabilityEvidence {
  gtin?: string | null;
  lotNumber?: string | null;
  expiresOn?: Date | null;
  serial?: string | null;
}

export interface RegulatoryRequest {
  /** Where the transaction happens — the BRANCH's jurisdiction, not the patient's. */
  jurisdiction: Jurisdiction;
  transaction: RegulatoryTransaction;
  product: {
    id: string;
    type: ProductType;
    /**
     * The category chain from the root down to the product's own category.
     *
     * ⚠️ THE WHOLE CHAIN, NOT THE LEAF. A rule about "controlled substances"
     *   is written against the parent category, and a product filed under a
     *   child of it is still a controlled substance. Passing only the leaf makes
     *   every category rule apply to nothing, and it looks configured.
     */
    categoryPath: readonly string[];
    compositionId: string | null;
  };
  /** For THIS jurisdiction, on THIS date. Null is a real and common state. */
  profile: ProductRegulatoryProfile | null;
  /** Every rule the caller loaded. Selection happens here, not in SQL. */
  rules: readonly RegulatoryRule[];
  prescription?: PresentedPrescription;
  actor: RegulatoryActor;
  patient?: RegulatoryPatient;
  /** The quantity being moved, in the product's BASE unit. A decimal string. */
  quantityBase: string;
  /**
   * What the same patient has already had of this product inside the rule's
   * period, in base units. Absent where the caller cannot answer — and a
   * `QUANTITY_LIMIT` with a period then resolves `UNDETERMINED` rather than
   * permitting, because "we did not check" is not "they have had none".
   */
  priorQuantityInPeriodBase?: string;
  /** Set when this dispense substitutes something else for what was prescribed. */
  substitution?: {
    isSubstitution: boolean;
    prescriberConsented?: boolean;
    patientConsented?: boolean;
  };
  location?: { kind: LocationKind; hasControlledAccess?: boolean };
  /** Where an online order is going, when that is not where we are. */
  destination?: Jurisdiction;
  traceability?: TraceabilityEvidence;
  /** The instant the caller is asking about. Rules are dated in calendar days. */
  occurredAt: Date;
}

export type RegulatoryOutcome =
  'PERMITTED' | 'PERMITTED_WITH_CONDITIONS' | 'REFUSED' | 'UNDETERMINED';

/**
 * Something the caller MUST do for the transaction to be lawful.
 *
 * ⚠️ A CONDITION IS AN OBLIGATION, NOT A WARNING. `PERMITTED_WITH_CONDITIONS`
 *   with a `RECORD_IN_CONTROLLED_REGISTER` condition means the dispense may
 *   proceed **and** the register entry must exist. A caller that renders these
 *   as advisory text and moves on has produced an unlawful dispense with a
 *   perfectly clean audit trail.
 */
export interface RegulatoryCondition {
  kind:
    | 'RECORD_IN_CONTROLLED_REGISTER'
    | 'WITNESS_REQUIRED'
    | 'VERIFY_PATIENT_AGE'
    | 'VERIFY_PRESCRIBER_REGISTRATION'
    | 'LABEL_FIELDS'
    | 'RETAIN_RECORD'
    | 'REPORT_TO_AUTHORITY'
    | 'STORE_UNDER_CONDITIONS'
    | 'DISPOSE_BY_METHOD'
    | 'REQUIRES_CONSENT';
  /** The rule that imposed it, so a screen can cite the law beside the task. */
  ruleId: string;
  ruleCode: string;
  /** What to do, in one sentence. */
  detail: string;
  /** The condition's own typed payload — label fields, a retention period. */
  parameters?: Record<string, unknown>;
}

/** Why the engine answered the way it did. One per rule that had something to say. */
export interface RegulatoryReason {
  /** Null only for the reasons the engine itself raises — see `NO_RULES_REASON`. */
  ruleId: string | null;
  ruleCode: string | null;
  ruleType: RegulatoryRuleType | null;
  packId: string | null;
  packVersion: string | null;
  outcome: RegulatoryOutcome;
  /** A sentence a human can read. Printed verbatim to whoever was refused. */
  message: string;
}

export interface RegulatoryDecision {
  outcome: RegulatoryOutcome;
  conditions: RegulatoryCondition[];
  reasons: RegulatoryReason[];
  /**
   * Every pack that contributed, snapshotted onto the transaction (PI-ADR-008).
   *
   * ⚠️ THE TRANSACTION STORES THIS AND NEVER RE-EVALUATES. Re-running the engine
   *   over a historical dispense must never be necessary and must never change
   *   what that dispense says — the same discipline the invoice engine applies to
   *   tax, for the same reason: a record somebody has already answered to an
   *   inspector for must not silently restate itself.
   */
  packVersionIds: readonly string[];
  /**
   * The LOWEST maturity of any pack that contributed, or null when none did.
   *
   * ⚠️ THIS IS WHAT THE BANNER READS. A decision produced by a pack nobody has
   *   reviewed is still a decision, and the screen has to say so rather than
   *   implying compliance by silence (PI-ADR-009).
   */
  lowestPackMaturity: RulePackMaturity | null;
}
