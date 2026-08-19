/**
 * Reading a rule's JSONB `parameters` document, safely.
 *
 * ⚠️ THE DOCUMENT IS `unknown` AND MUST STAY `unknown` UNTIL IT IS CHECKED. It
 *   comes out of a JSONB column, so the type system knows nothing about it and a
 *   half-written rule — `{"maxPerDispense": "ten"}`, `{"required": "yes"}` —
 *   typechecks perfectly, casts perfectly, and then compares against `NaN`.
 *   `NaN > limit` is `false`, so the malformed rule PERMITS, which is the exact
 *   direction this domain is not allowed to fail in.
 *
 *   So every reader below returns a problem instead of a value, the engine turns
 *   a problem into `UNDETERMINED`, and `UNDETERMINED` refuses. A rule nobody can
 *   read is a rule nobody may rely on.
 *
 * The parameter shapes are indicative rather than mandated — REGULATORY_RULE_PACKS.md
 * lists them per type, and a jurisdiction that needs another key adds one. What
 * is NOT negotiable is that a key this engine acts on is validated before it is
 * acted on.
 *
 * ⚠️ NO FOREIGN KEYS IN HERE, EVER (ADR-0006). Which product a rule applies to
 *   is typed columns on the row. An id inside this document is invisible to
 *   every constraint, join and cascade in the database.
 */
import { isDecimal } from './decimal.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

function fail<T>(problem: string): Parsed<T> {
  return { ok: false, problem };
}

function asRecord(parameters: unknown): Parsed<Record<string, unknown>> {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return fail('its parameters are not an object');
  }
  return { ok: true, value: parameters as Record<string, unknown> };
}

// --- readers ----------------------------------------------------------------
// Each one distinguishes ABSENT from MALFORMED. Absent is usually legitimate —
// most parameters are optional — while malformed is a broken rule, and treating
// the two alike is how `{"required": "yes"}` becomes "not required".

function readBoolean(source: Record<string, unknown>, key: string): Parsed<boolean | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return fail(`"${key}" is not true or false`);
  return { ok: true, value: raw };
}

function readInteger(source: Record<string, unknown>, key: string): Parsed<number | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return fail(`"${key}" is not a whole number of zero or more`);
  }
  return { ok: true, value: raw };
}

/** A quantity, kept as a STRING so it never touches a float. */
function readDecimal(source: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  /*
   * ⚠️ A NUMBER IS REFUSED HERE RATHER THAN CONVERTED. JSON has one numeric
   *   type and it is a double, so `0.1` in the document is already not `0.1` by
   *   the time it reaches us, and `String(0.30000000000000004)` is what we would
   *   be comparing against. A quantity limit is written as a string or it is not
   *   written.
   */
  if (typeof raw !== 'string' || !isDecimal(raw)) {
    return fail(`"${key}" is not a decimal quantity written as a string, e.g. "30.000000"`);
  }
  return { ok: true, value: raw };
}

function readStringArray(
  source: Record<string, unknown>,
  key: string
): Parsed<readonly string[] | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    return fail(`"${key}" is not a list of strings`);
  }
  return { ok: true, value: raw as string[] };
}

function readString(source: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return fail(`"${key}" is not text`);
  return { ok: true, value: raw };
}

/** Collects the first problem across several readers, or hands back the values. */
function all<T extends Record<string, Parsed<unknown>>>(
  readers: T
): Parsed<{ [K in keyof T]: T[K] extends Parsed<infer V> ? V : never }> {
  for (const parsed of Object.values(readers)) {
    if (!parsed.ok) return fail(parsed.problem);
  }
  const value = Object.fromEntries(
    Object.entries(readers).map(([key, parsed]) => [key, (parsed as { value: unknown }).value])
  );
  return { ok: true, value: value as never };
}

// --- the typed parameter shapes ---------------------------------------------

export interface PrescriptionRequiredParameters {
  required: boolean | undefined;
  validityDays: number | undefined;
  prescriberClasses: readonly string[] | undefined;
}

export interface QuantityLimitParameters {
  maxPerTransactionBase: string | undefined;
  maxPerPeriodBase: string | undefined;
  periodDays: number | undefined;
}

export interface RefillRuleParameters {
  refillsAllowed: number | undefined;
  validityDays: number | undefined;
  /**
   * Does an endorsement BY THE PRESCRIBER lift `refillsAllowed`? (PI-7.)
   *
   * ⚠️ OPT-IN, AND ABSENT MEANS NO. A jurisdiction that says "not more than
   *   once, full stop" and one that says "not more than once unless the
   *   prescriber endorses it" are different laws, and defaulting to the second
   *   would rewrite the first at every clinic in it.
   */
  endorsedRepeatsPermitted: boolean | undefined;
  /** The jurisdiction's own ceiling on an endorsed repeat, where it states one. */
  maxEndorsedRepeats: number | undefined;
}

export interface AgeRestrictionParameters {
  minimumAgeYears: number | undefined;
  verificationRequired: boolean | undefined;
}

/**
 * WHO the product may be supplied FOR (PI-11).
 *
 * ⚠️ THE TWO LISTS ARE NOT SYMMETRIC AND THE ASYMMETRY IS THE DESIGN.
 *   `prohibitedSubjectTypes` is a closed vocabulary of two — a jurisdiction
 *   saying "not for human use" or "not for animals" — and it is checkable
 *   against every request, because every request either has a subject or does
 *   not name one at all.
 *
 *   `permittedSpecies` and `prohibitedSpecies` are FREE TEXT compared
 *   case-insensitively, matching `animal_profiles.species`, which is free text
 *   for the reason `patients.national_id_type` is. A pack that names species is
 *   accepting that it has to spell them the way the clinic's charts do, and
 *   `evaluateSpeciesRestriction` answers UNDETERMINED rather than PERMITTED when
 *   it cannot tell — which refuses.
 */
export interface SpeciesRestrictionParameters {
  /**
   * `HUMAN`, `ANIMAL`, or both. Compared exactly, and NOT case-folded.
   *
   * ⚠️ THE COMMENT USED TO SAY "upper-cased", WHICH NOTHING DID (PI-11 review).
   *   A pack author trusting it would write `"human"` and get a parse failure —
   *   `UNDETERMINED`, which refuses — rather than the coercion promised. The
   *   strict behaviour is the right one for a closed two-member vocabulary; it
   *   is the sentence that was wrong.
   */
  prohibitedSubjectTypes: readonly string[] | undefined;
  /** An allow-list. Anything not on it is refused. */
  permittedSpecies: readonly string[] | undefined;
  /** A deny-list. Everything else is permitted. */
  prohibitedSpecies: readonly string[] | undefined;
}

export interface ControlledScheduleParameters {
  scheduleName: string | undefined;
  registerRequired: boolean | undefined;
  witnessRequired: boolean | undefined;
  storageLocationKinds: readonly string[] | undefined;
}

export interface SubstitutionParameters {
  permitted: boolean | undefined;
  requiresPrescriberConsent: boolean | undefined;
  requiresPatientConsent: boolean | undefined;
  excludedClassifications: readonly string[] | undefined;
}

export interface OnlineDispensingParameters {
  permitted: boolean | undefined;
  excludedClassifications: readonly string[] | undefined;
  destinationCountryCodes: readonly string[] | undefined;
}

export interface AuthorityParameters {
  permittedRoleCodes: readonly string[] | undefined;
  permittedLicenceTypes: readonly string[] | undefined;
  permittedPrescriberClasses: readonly string[] | undefined;
  /**
   * Does this authority rule stand aside when the person dispensing IS the
   * prescriber? (PI-7, and only `PHARMACIST_AUTHORITY` reads it.)
   *
   * ⚠️ OPT-IN PER RULE, BECAUSE IT IS A PROVISO IN SOMEBODY'S STATUTE RATHER
   *   THAN A GENERAL PRINCIPLE. India's Pharmacy Act s. 42(1) excludes "the
   *   dispensing by a medical practitioner of medicine for his own patients";
   *   a jurisdiction without such a proviso must keep refusing, so absent is no.
   */
  exemptWhenActorIsPrescriber: boolean | undefined;
}

export interface StorageRequirementParameters {
  locationKinds: readonly string[] | undefined;
  controlledAccessRequired: boolean | undefined;
  detail: string | undefined;
}

export interface TraceabilityParameters {
  /** `GTIN` · `LOT` · `EXPIRY` · `SERIAL`. Compared exactly. */
  requiredIdentifiers: readonly string[] | undefined;
}

export interface ObligationParameters {
  /** Whatever the obligation needs said — fields, a period, a recipient. */
  detail: string | undefined;
  fields: readonly string[] | undefined;
  years: number | undefined;
  cadence: string | undefined;
  recipient: string | undefined;
  method: string | undefined;
  witnessRequired: boolean | undefined;
}

export interface ImportRestrictionParameters {
  permitted: boolean | undefined;
  licenceRequired: boolean | undefined;
  licenceType: string | undefined;
}

// --- the parsers ------------------------------------------------------------
//
// ⚠️ EVERY PARSER BELOW WHOSE RULE HAS AN ESSENTIAL KEY REFUSES A DOCUMENT THAT
//   OMITS IT, AND THIS PARAGRAPH IS THE FIX FOR THE WORST DEFECT IN THE PHASE.
//   `readBoolean` cannot tell "absent" from "misspelled" — nothing can — and the
//   HANDLERS read an absent `required` as "no prescription is required here". So
//   `{"require": true}` (one typo) came back PERMITTED for a prescription-only
//   medicine with no prescription presented, and, because a regional rule
//   SUPERSEDES the national one of its type, it took the rule that would have
//   refused out of the candidate set on its way past.
//
//   The rule now is: if a rule type's whole meaning rests on one key, that key
//   is REQUIRED, and its absence is `UNDETERMINED` — which refuses. Optional
//   keys stay optional. A rule that says nothing checkable is not a permissive
//   rule; it is a broken one, and the two must never resolve alike.

/** The essential key is missing. The rule says nothing, so it permits nothing. */
function sayNothing<T>(key: string, what: string): Parsed<T> {
  return fail(`it does not say ${what} — "${key}" is missing or misspelled`);
}

export function parsePrescriptionRequired(
  parameters: unknown
): Parsed<PrescriptionRequiredParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    required: readBoolean(source.value, 'required'),
    validityDays: readInteger(source.value, 'validityDays'),
    prescriberClasses: readStringArray(source.value, 'prescriberClasses'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.required === undefined) {
    return sayNothing('required', 'whether a prescription is required');
  }
  return parsed;
}

export function parseQuantityLimit(parameters: unknown): Parsed<QuantityLimitParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    maxPerTransactionBase: readDecimal(source.value, 'maxPerTransactionBase'),
    maxPerPeriodBase: readDecimal(source.value, 'maxPerPeriodBase'),
    periodDays: readInteger(source.value, 'periodDays'),
  });
  if (!parsed.ok) return parsed;

  /*
   * ⚠️ A PERIOD LIMIT WITH NO PERIOD IS NOT A LIMIT, AND IT MUST NOT READ AS
   *   ONE. "60 tablets" over an unstated window is unenforceable, and an engine
   *   that quietly treated it as per-transaction would enforce something nobody
   *   wrote.
   */
  if (parsed.value.maxPerPeriodBase !== undefined && parsed.value.periodDays === undefined) {
    return fail('it sets a quantity per period without saying how long the period is');
  }
  if (
    parsed.value.maxPerTransactionBase === undefined &&
    parsed.value.maxPerPeriodBase === undefined
  ) {
    return fail('it is a quantity limit that sets no quantity');
  }
  return parsed;
}

export function parseRefillRule(parameters: unknown): Parsed<RefillRuleParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    refillsAllowed: readInteger(source.value, 'refillsAllowed'),
    validityDays: readInteger(source.value, 'validityDays'),
    endorsedRepeatsPermitted: readBoolean(source.value, 'endorsedRepeatsPermitted'),
    maxEndorsedRepeats: readInteger(source.value, 'maxEndorsedRepeats'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.refillsAllowed === undefined && parsed.value.validityDays === undefined) {
    return fail('it is a refill rule that states neither a number of repeats nor a validity');
  }
  return parsed;
}

export function parseAgeRestriction(parameters: unknown): Parsed<AgeRestrictionParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    minimumAgeYears: readInteger(source.value, 'minimumAgeYears'),
    verificationRequired: readBoolean(source.value, 'verificationRequired'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.minimumAgeYears === undefined) {
    return fail('it is an age restriction that states no age');
  }
  return parsed;
}

/**
 * ⚠️ A SPECIES RULE THAT NAMES NOBODY IS A BROKEN RULE, NOT A PERMISSIVE ONE —
 *   the discipline the header paragraph above sets out, applied here. `{}` would
 *   otherwise be a rule that permits every supply to every subject while sitting
 *   in the pack looking perfectly configured, which is the "visible and inert"
 *   failure this programme keeps finding.
 *
 * ⚠️ AND AN ALLOW-LIST AND A DENY-LIST TOGETHER ARE REFUSED. They can be made to
 *   contradict each other — `permittedSpecies: ["Dog"]` beside
 *   `prohibitedSpecies: ["Dog"]` — and there is no reading of that pair that is
 *   obviously right. A jurisdiction states one or the other.
 */
export function parseSpeciesRestriction(parameters: unknown): Parsed<SpeciesRestrictionParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    prohibitedSubjectTypes: readStringArray(source.value, 'prohibitedSubjectTypes'),
    permittedSpecies: readStringArray(source.value, 'permittedSpecies'),
    prohibitedSpecies: readStringArray(source.value, 'prohibitedSpecies'),
  });
  if (!parsed.ok) return parsed;

  const { prohibitedSubjectTypes, permittedSpecies, prohibitedSpecies } = parsed.value;
  if (
    prohibitedSubjectTypes === undefined &&
    permittedSpecies === undefined &&
    prohibitedSpecies === undefined
  ) {
    return sayNothing('prohibitedSubjectTypes', 'who the product may not be supplied for');
  }
  if (permittedSpecies !== undefined && prohibitedSpecies !== undefined) {
    return fail(
      'it states both a permitted and a prohibited species list, and the two can contradict each other'
    );
  }
  if (prohibitedSubjectTypes?.some((entry) => entry !== 'HUMAN' && entry !== 'ANIMAL')) {
    return fail('"prohibitedSubjectTypes" may only contain "HUMAN" and "ANIMAL"');
  }
  if (permittedSpecies?.length === 0 || prohibitedSpecies?.length === 0) {
    /* An empty allow-list refuses every animal alive and an empty deny-list
     * refuses none — both are far more likely to be a truncated edit than an
     * intention, and neither is worth guessing at. */
    return fail('it states an empty species list');
  }
  return parsed;
}

export function parseControlledSchedule(parameters: unknown): Parsed<ControlledScheduleParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    scheduleName: readString(source.value, 'scheduleName'),
    registerRequired: readBoolean(source.value, 'registerRequired'),
    witnessRequired: readBoolean(source.value, 'witnessRequired'),
    storageLocationKinds: readStringArray(source.value, 'storageLocationKinds'),
  });
  if (!parsed.ok) return parsed;

  /*
   * ⚠️ A CONTROLLED-SCHEDULE RULE THAT IMPOSES NOTHING IS A BROKEN RULE, NOT A
   *   PERMISSIVE ONE. `{}` previously returned PERMITTED with no register entry
   *   and no witness — the exact obligations the rule type exists to carry.
   */
  if (
    parsed.value.registerRequired === undefined &&
    parsed.value.witnessRequired === undefined &&
    parsed.value.storageLocationKinds === undefined
  ) {
    return fail('it is a controlled-schedule rule that imposes no obligation');
  }
  return parsed;
}

export function parseSubstitution(parameters: unknown): Parsed<SubstitutionParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    permitted: readBoolean(source.value, 'permitted'),
    requiresPrescriberConsent: readBoolean(source.value, 'requiresPrescriberConsent'),
    requiresPatientConsent: readBoolean(source.value, 'requiresPatientConsent'),
    excludedClassifications: readStringArray(source.value, 'excludedClassifications'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.permitted === undefined) {
    return sayNothing('permitted', 'whether substitution is allowed');
  }
  return parsed;
}

export function parseOnlineDispensing(parameters: unknown): Parsed<OnlineDispensingParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    permitted: readBoolean(source.value, 'permitted'),
    excludedClassifications: readStringArray(source.value, 'excludedClassifications'),
    destinationCountryCodes: readStringArray(source.value, 'destinationCountryCodes'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.permitted === undefined) {
    return sayNothing('permitted', 'whether remote supply is allowed');
  }
  return parsed;
}

export function parseAuthority(parameters: unknown): Parsed<AuthorityParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    permittedRoleCodes: readStringArray(source.value, 'permittedRoleCodes'),
    permittedLicenceTypes: readStringArray(source.value, 'permittedLicenceTypes'),
    permittedPrescriberClasses: readStringArray(source.value, 'permittedPrescriberClasses'),
    exemptWhenActorIsPrescriber: readBoolean(source.value, 'exemptWhenActorIsPrescriber'),
  });
  if (!parsed.ok) return parsed;
  if (
    parsed.value.permittedRoleCodes === undefined &&
    parsed.value.permittedLicenceTypes === undefined &&
    parsed.value.permittedPrescriberClasses === undefined
  ) {
    return fail('it is an authority rule that names nobody');
  }
  return parsed;
}

export function parseStorageRequirement(parameters: unknown): Parsed<StorageRequirementParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    locationKinds: readStringArray(source.value, 'locationKinds'),
    controlledAccessRequired: readBoolean(source.value, 'controlledAccessRequired'),
    detail: readString(source.value, 'detail'),
  });
  if (!parsed.ok) return parsed;
  if (
    parsed.value.locationKinds === undefined &&
    parsed.value.controlledAccessRequired === undefined &&
    parsed.value.detail === undefined
  ) {
    return fail('it is a storage requirement that states no requirement');
  }
  return parsed;
}

export function parseTraceability(parameters: unknown): Parsed<TraceabilityParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    requiredIdentifiers: readStringArray(source.value, 'requiredIdentifiers'),
  });
  if (!parsed.ok) return parsed;

  if (parsed.value.requiredIdentifiers === undefined) {
    return sayNothing('requiredIdentifiers', 'which identifiers must be captured');
  }

  const known = ['GTIN', 'LOT', 'EXPIRY', 'SERIAL'];
  const unknownIdentifier = parsed.value.requiredIdentifiers?.find(
    (identifier) => !known.includes(identifier)
  );
  /*
   * ⚠️ AN IDENTIFIER THIS ENGINE CANNOT CHECK IS A REFUSAL, NOT A SKIP. A
   *   jurisdiction that requires something we do not carry is a gap in the
   *   framework, and the honest answer is UNDETERMINED — which sends somebody to
   *   fix it — rather than a green tick for the three identifiers we happened to
   *   recognise.
   */
  if (unknownIdentifier !== undefined) {
    return fail(
      `it requires the identifier "${unknownIdentifier}", which this engine cannot check`
    );
  }
  return parsed;
}

export function parseObligation(parameters: unknown): Parsed<ObligationParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    detail: readString(source.value, 'detail'),
    fields: readStringArray(source.value, 'fields'),
    years: readInteger(source.value, 'years'),
    cadence: readString(source.value, 'cadence'),
    recipient: readString(source.value, 'recipient'),
    method: readString(source.value, 'method'),
    witnessRequired: readBoolean(source.value, 'witnessRequired'),
  });
  if (!parsed.ok) return parsed;

  /*
   * An obligation carries a CONDITION rather than a refusal, so an empty
   * document here produces a condition with no content — a task nobody can
   * carry out, attached to a transaction that is otherwise permitted. Refuse it
   * for the same reason as the rest: a rule that says nothing checkable is
   * broken, not permissive.
   */
  if (Object.values(parsed.value).every((value) => value === undefined)) {
    return fail('it is an obligation that states nothing to do');
  }
  return parsed;
}

export function parseImportRestriction(parameters: unknown): Parsed<ImportRestrictionParameters> {
  const source = asRecord(parameters);
  if (!source.ok) return fail(source.problem);
  const parsed = all({
    permitted: readBoolean(source.value, 'permitted'),
    licenceRequired: readBoolean(source.value, 'licenceRequired'),
    licenceType: readString(source.value, 'licenceType'),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.permitted === undefined) {
    return sayNothing('permitted', 'whether import is allowed');
  }
  return parsed;
}
