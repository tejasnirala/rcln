/**
 * `evaluate(request) -> decision`. The one function every caller calls.
 *
 * ── THE RULE THAT GOVERNS EVERY LINE BELOW ───────────────────────────────────
 * **Silence never permits.** No applicable rule, an unreadable parameters
 * document, a rule type this engine does not handle, a fact the caller could not
 * supply — every one of those is `UNDETERMINED`, and every caller treats
 * `UNDETERMINED` as *refuse and say so*.
 *
 * That mirrors `UNRATED` in `@rcln/tax`, whose comment says it best: guessing
 * produces "a plausible invoice at the wrong rate, which is the failure this
 * whole package is shaped to avoid." Guessing a dispensing rule is worse — the
 * artefact is a medicine handed to a person rather than a number on a document.
 *
 * ⚠️ `REFUSED` AND `UNDETERMINED` ARE DIFFERENT ANSWERS AND THE SCREENS SAY
 *   WHICH. `REFUSED` means a rule says no — a clinical fact, and the pharmacist
 *   is done. `UNDETERMINED` means nobody has configured this jurisdiction — a
 *   to-do for the platform, and somebody can fix it. Collapsing them into "no"
 *   hides every configuration gap behind a wall of apparently-lawful refusals.
 *
 * ── WHAT THIS PACKAGE IS NOT ─────────────────────────────────────────────────
 * It is not compliance, it holds no country's rules, and it contains no country
 * code. There is no `if (country === 'IN')` here or anywhere downstream of here;
 * a behaviour that cannot be expressed as a rule row is a gap in this framework
 * and gets fixed here rather than worked around at a call site.
 */
import { addDecimals, compareDecimals } from './decimal.js';
import {
  parseAgeRestriction,
  parseAuthority,
  parseControlledSchedule,
  parseImportRestriction,
  parseObligation,
  parseOnlineDispensing,
  parsePrescriptionRequired,
  parseQuantityLimit,
  parseRefillRule,
  parseStorageRequirement,
  parseSpeciesRestriction,
  parseSubstitution,
  parseTraceability,
  type Parsed,
  type QuantityLimitParameters,
} from './parameters.js';
import {
  formatJurisdiction,
  needsClassificationButHasNone,
  onlineSaleGap,
  onlineSaleGapMessage,
  selectApplicableRules,
  startOfCalendarDay,
} from './selection.js';
import type {
  RegulatoryCondition,
  RegulatoryDecision,
  RegulatoryReason,
  RegulatoryRequest,
  RegulatoryRule,
  RulePackMaturity,
} from './types.js';

/** The ladder, lowest first. Used only to report the weakest contributing pack. */
const MATURITY_ORDER: readonly RulePackMaturity[] = [
  'ARCHITECTURE_SUPPORTED',
  'RULES_CONFIGURED',
  'RULES_IMPLEMENTED',
  'AUTOMATED_TESTED',
  'SOURCE_VERIFIED',
  'REGULATORY_REVIEW_PENDING',
  'REGULATORY_REVIEWED',
  'PRODUCTION_ENABLED',
];

/** One rule's answer. Exactly one per applicable rule, so the snapshot is total. */
interface RuleVerdict {
  outcome: 'PERMITTED' | 'REFUSED' | 'UNDETERMINED';
  message: string;
  conditions: RegulatoryCondition[];
}

const permitted = (message: string, conditions: RegulatoryCondition[] = []): RuleVerdict => ({
  outcome: 'PERMITTED',
  message,
  conditions,
});

const refused = (message: string): RuleVerdict => ({
  outcome: 'REFUSED',
  message,
  conditions: [],
});

const undetermined = (message: string): RuleVerdict => ({
  outcome: 'UNDETERMINED',
  message,
  conditions: [],
});

/** A parameters document nobody can read is a rule nobody may rely on. */
function unreadable(rule: RegulatoryRule, parsed: Parsed<unknown>): RuleVerdict {
  const problem = parsed.ok ? 'it could not be read' : parsed.problem;
  return undetermined(
    `Rule ${rule.code} could not be applied because ${problem}. ` +
      'Nothing is permitted on the strength of a rule the platform cannot read.'
  );
}

function condition(
  rule: RegulatoryRule,
  kind: RegulatoryCondition['kind'],
  detail: string,
  parameters?: Record<string, unknown>
): RegulatoryCondition {
  return {
    kind,
    ruleId: rule.id,
    ruleCode: rule.code,
    detail,
    ...(parameters ? { parameters } : {}),
  };
}

/** Whole days between two calendar days. Negative when `to` precedes `from`. */
function daysBetween(from: Date, to: Date): number {
  const millis = startOfCalendarDay(to).getTime() - startOfCalendarDay(from).getTime();
  return Math.round(millis / 86_400_000);
}

/** Is this transaction one where a prescription is even a coherent question? */
function isSupplyToPatient(request: RegulatoryRequest): boolean {
  return (
    request.transaction === 'DISPENSE' ||
    request.transaction === 'COUNTER_SALE' ||
    request.transaction === 'ONLINE_DISPENSE'
  );
}

// ---------------------------------------------------------------------------
// The handlers. One per rule type, and the switch below is EXHAUSTIVE.
//
// ⚠️ A RULE TYPE WITH NO HANDLER MUST NOT FALL THROUGH TO "PERMITTED". The
//   switch has no `default:` returning a permission for exactly that reason: add
//   a member to `RegulatoryRuleType` and the compiler stops here, rather than the
//   engine silently ignoring every rule of the new type at every clinic.
// ---------------------------------------------------------------------------

function evaluatePrescriptionRequired(
  rule: RegulatoryRule,
  request: RegulatoryRequest
): RuleVerdict {
  const parsed = parsePrescriptionRequired(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  if (!isSupplyToPatient(request)) {
    return permitted(`${rule.code} does not speak to a ${request.transaction}.`);
  }

  if (parsed.value.required !== true) {
    return permitted(`${rule.code}: no prescription is required here.`);
  }

  const prescription = request.prescription;
  if (!prescription || !prescription.presented) {
    return refused(rule.statement);
  }
  if (!prescription.signedByQualifiedPrescriber) {
    return refused(
      `${rule.statement} The prescription presented is not signed by a qualified prescriber.`
    );
  }

  const validityDays = parsed.value.validityDays;
  if (validityDays !== undefined) {
    const age = daysBetween(prescription.issuedOn, request.occurredAt);
    if (age < 0) {
      /*
       * ⚠️ A PRESCRIPTION DATED IN THE FUTURE IS REFUSED, NOT TREATED AS FRESH.
       *   `Math.abs` here would make a mistyped year the most valid prescription
       *   in the system.
       */
      return refused(
        `${rule.statement} The prescription is dated after the day it is being dispensed.`
      );
    }
    if (age > validityDays) {
      return refused(
        `${rule.statement} This prescription is ${String(age)} days old and expires after ` +
          `${String(validityDays)}.`
      );
    }
  }

  return permitted(`${rule.code}: a valid prescription was presented.`);
}

function evaluatePrescriberAuthority(
  rule: RegulatoryRule,
  request: RegulatoryRequest
): RuleVerdict {
  const parsed = parseAuthority(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const permittedClasses = parsed.value.permittedPrescriberClasses;
  if (permittedClasses === undefined || permittedClasses.length === 0) {
    return unreadable(rule, {
      ok: false,
      problem: 'it names no prescriber classes, so it says nothing that can be checked',
    });
  }

  const prescription = request.prescription;
  if (!prescription?.presented) {
    /*
     * Not engaged. Whether a prescription was needed AT ALL is
     * `PRESCRIPTION_REQUIRED`'s question, and answering it here too would give
     * one question two answers that can disagree.
     */
    return permitted(`${rule.code} applies to a prescription, and none was presented.`);
  }

  const classes = prescription.prescriberClasses;
  if (classes === undefined) {
    return undetermined(
      `${rule.code} restricts who may prescribe this, and the prescriber's registration ` +
        'class was not supplied.'
    );
  }

  const authorised = classes.some((held) => permittedClasses.includes(held));
  return authorised
    ? permitted(`${rule.code}: the prescriber is authorised.`)
    : refused(rule.statement);
}

function evaluatePharmacistAuthority(
  rule: RegulatoryRule,
  request: RegulatoryRequest
): RuleVerdict {
  const parsed = parseAuthority(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const roles = parsed.value.permittedRoleCodes;
  const licences = parsed.value.permittedLicenceTypes;
  if (
    (roles === undefined || roles.length === 0) &&
    (licences === undefined || licences.length === 0)
  ) {
    return unreadable(rule, {
      ok: false,
      problem: 'it names neither a role nor a licence type, so it says nothing checkable',
    });
  }

  /*
   * ⚠️ THE PROVISO IS TESTED BEFORE THE AUTHORITY, BECAUSE IT SAYS THE
   *   PROHIBITION DOES NOT APPLY — not that this person satisfies it. India's
   *   Pharmacy Act s. 42(1) excludes "the dispensing by a medical practitioner
   *   of medicine for his own patients" from the section outright, and a clinic
   *   where the doctor dispenses is the common shape in exactly the countries
   *   that write such a proviso. Both halves must be true: the RULE has to opt
   *   in, and the ACTOR has to actually be the prescriber of this prescription —
   *   which the service derives from the encounter, never the client.
   */
  if (parsed.value.exemptWhenActorIsPrescriber === true && request.actor.isPrescriber === true) {
    return permitted(
      `${rule.code} does not apply to a prescriber dispensing to their own patient.`
    );
  }

  const roleOk = roles !== undefined && request.actor.roleCodes.some((r) => roles.includes(r));
  const licenceOk =
    licences !== undefined && (request.actor.licenceTypes ?? []).some((l) => licences.includes(l));

  /*
   * ⚠️ EITHER IS ENOUGH, AND THAT IS DELIBERATE. A jurisdiction that says "a
   *   registered pharmacist" is describing a LICENCE; one that says "the
   *   dispensary supervisor" is describing a ROLE in our system. A rule that
   *   names both means either satisfies it — requiring both would refuse a
   *   registered pharmacist for not holding an rcln role code, which is a
   *   statement about our software rather than about the law.
   */
  return roleOk || licenceOk
    ? permitted(`${rule.code}: the person dispensing is authorised.`)
    : refused(rule.statement);
}

function evaluateControlledSchedule(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseControlledSchedule(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const conditions: RegulatoryCondition[] = [];
  if (parsed.value.registerRequired === true) {
    conditions.push(
      condition(
        rule,
        'RECORD_IN_CONTROLLED_REGISTER',
        `Record this in the ${parsed.value.scheduleName ?? 'controlled drugs'} register.`,
        parsed.value.scheduleName !== undefined
          ? { schedule: parsed.value.scheduleName }
          : undefined
      )
    );
  }
  if (parsed.value.witnessRequired === true) {
    conditions.push(
      condition(rule, 'WITNESS_REQUIRED', 'A second registered person must witness this.')
    );
  }

  const kinds = parsed.value.storageLocationKinds;
  if (kinds !== undefined && kinds.length > 0 && request.transaction === 'STOCK') {
    const kind = request.location?.kind;
    if (kind === undefined) {
      return undetermined(
        `${rule.code} restricts where this may be kept, and no location was supplied.`
      );
    }
    if (!kinds.includes(kind)) {
      return refused(`${rule.statement} It may only be kept in: ${kinds.join(', ')}.`);
    }
  }

  return permitted(`${rule.code}: controlled-substance obligations apply.`, conditions);
}

function evaluateQuantityLimit(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseQuantityLimit(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  /*
   * ⚠️ THE QUANTITIES COME FROM THE CALLER, NOT FROM THE RULE, SO THEY ARE
   *   VALIDATED HERE TOO. `compareDecimals` throws on anything that is not a
   *   decimal, and an exception escaping the engine is a 500 on a dispensing
   *   screen — where the correct answer is "we could not decide", which refuses.
   */
  try {
    return applyQuantityLimit(rule, request, parsed.value);
  } catch {
    return undetermined(
      `${rule.code} could not be applied: the quantities supplied are not decimal values.`
    );
  }
}

function applyQuantityLimit(
  rule: RegulatoryRule,
  request: RegulatoryRequest,
  limits: QuantityLimitParameters
): RuleVerdict {
  const parsed = { value: limits };
  const perTransaction = parsed.value.maxPerTransactionBase;
  if (perTransaction !== undefined && compareDecimals(request.quantityBase, perTransaction) > 0) {
    return refused(
      `${rule.statement} This transaction is for ${request.quantityBase} and the limit is ` +
        `${perTransaction}.`
    );
  }

  const perPeriod = parsed.value.maxPerPeriodBase;
  if (perPeriod !== undefined) {
    const prior = request.priorQuantityInPeriodBase;
    if (prior === undefined) {
      /*
       * ⚠️ "WE DID NOT CHECK" IS NOT "THEY HAVE HAD NONE". Defaulting the prior
       *   quantity to zero would turn every period limit into a per-transaction
       *   limit, at every clinic, invisibly — and the caller that cannot answer
       *   is precisely the one whose patient history is incomplete.
       */
      return undetermined(
        `${rule.code} limits how much may be supplied over ${String(parsed.value.periodDays ?? 0)} ` +
          'days, and what has already been supplied in that window was not supplied to the engine.'
      );
    }

    const total = addDecimals(prior, request.quantityBase);

    if (compareDecimals(total, perPeriod) > 0) {
      return refused(
        `${rule.statement} That would make ${total} over ${String(parsed.value.periodDays ?? 0)} ` +
          `days, and the limit is ${perPeriod}.`
      );
    }
  }

  return permitted(`${rule.code}: within the permitted quantity.`);
}

function evaluateRefillRule(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseRefillRule(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const prescription = request.prescription;
  if (!prescription?.presented) {
    return permitted(`${rule.code} applies to a prescription, and none was presented.`);
  }

  /*
   * ⚠️ A PRESCRIPTION DATED IN THE FUTURE IS REFUSED HERE TOO. Without this,
   *   `age` is negative, every `age > validityDays` test is false, and a
   *   mistyped year becomes the most valid prescription in the system — the
   *   same trap `evaluatePrescriptionRequired` already guards, and it was
   *   missing here where a repeat is exactly what somebody would try it on.
   */
  if (daysBetween(prescription.issuedOn, request.occurredAt) < 0) {
    return refused(
      `${rule.statement} The prescription is dated after the day it is being dispensed.`
    );
  }

  const allowed = parsed.value.refillsAllowed;
  if (allowed !== undefined && prescription.refillsUsed > allowed) {
    /*
     * ⚠️ THE ENDORSEMENT IS AN EXCEPTION THE LAW ITSELF WRITES, AND IT IS READ
     *   ONLY WHERE THE RULE OPTS IN (PI-7, KNOWN_ISSUES defect 3). India's rule
     *   65(11) forbids a repeat "unless the prescriber has stated thereon that
     *   it may be dispensed more than once", and then permits it as endorsed —
     *   so `refillsAllowed: 0` was a correct reading that also refused the
     *   legitimate case, because the framework could not carry the endorsement.
     *
     *   `repeatsAuthorised` is read off the PRESCRIPTION, not asserted by the
     *   person dispensing. See `PresentedPrescription`.
     */
    const endorsed =
      parsed.value.endorsedRepeatsPermitted === true && prescription.repeatsAuthorised === true;

    if (!endorsed) {
      return refused(
        `${rule.statement} This prescription has already been dispensed ` +
          `${String(prescription.refillsUsed)} times and allows ${String(allowed)} repeats.`
      );
    }

    /*
     * ⚠️ AN ENDORSEMENT WITH NO NUMBER, UNDER A RULE WITH NO CEILING, IS
     *   `UNDETERMINED` AND THEREFORE REFUSES. "The prescriber allowed repeats"
     *   without saying how many is a reason to ring the prescriber, not a
     *   licence to dispense indefinitely — and treating silence as unlimited is
     *   precisely the permissive default this engine is shaped against.
     */
    const limits = [prescription.repeatsAuthorisedLimit, parsed.value.maxEndorsedRepeats].filter(
      (value): value is number => value !== undefined
    );
    if (limits.length === 0) {
      return undetermined(
        `${rule.code}: the prescriber endorsed a repeat but did not state how many, and the ` +
          'rules here set no limit of their own. Confirm the number of repeats with the prescriber.'
      );
    }

    const endorsedLimit = Math.min(...limits);
    if (prescription.refillsUsed > endorsedLimit) {
      return refused(
        `${rule.statement} This prescription has already been dispensed ` +
          `${String(prescription.refillsUsed)} times and the prescriber endorsed ` +
          `${String(endorsedLimit)} repeats.`
      );
    }
  }

  const validityDays = parsed.value.validityDays;
  if (validityDays !== undefined) {
    const age = daysBetween(prescription.issuedOn, request.occurredAt);
    if (age > validityDays) {
      return refused(
        `${rule.statement} A repeat may not be dispensed more than ${String(validityDays)} days ` +
          'after the prescription was written.'
      );
    }
  }

  return permitted(`${rule.code}: repeats remain available.`);
}

function evaluateAgeRestriction(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseAgeRestriction(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const minimum = parsed.value.minimumAgeYears;
  if (minimum === undefined) return unreadable(rule, { ok: false, problem: 'it states no age' });

  if (request.patient?.subjectType === 'ANIMAL') {
    /*
     * A human age limit is not a statement about a dog. Veterinary dosing is
     * PI-11's domain and gets its own rules rather than borrowing these.
     */
    return permitted(`${rule.code} is an age restriction, and the subject is not a person.`);
  }

  const age = request.patient?.ageYears;
  if (age === undefined) {
    return undetermined(
      `${rule.code} sets a minimum age of ${String(minimum)}, and the patient's age is not known.`
    );
  }
  if (age < minimum) return refused(rule.statement);

  const conditions =
    parsed.value.verificationRequired === true
      ? [
          condition(
            rule,
            'VERIFY_PATIENT_AGE',
            `Check identification: minimum age ${String(minimum)}.`
          ),
        ]
      : [];

  return permitted(`${rule.code}: the patient meets the minimum age.`, conditions);
}

/**
 * WHO the product may be supplied FOR (PI-11).
 *
 * ⚠️ ITS OWN RULE TYPE, NOT A PARAMETER ON `AGE_RESTRICTION`, AND THE HANDLER
 *   DIRECTLY ABOVE IS THE ARGUMENT. `evaluateAgeRestriction` stands aside
 *   entirely when the subject is an animal — "a human age limit is not a
 *   statement about a dog" — so a veterinary prohibition expressed as an age
 *   parameter would sit behind a handler that exempts every animal from itself,
 *   and would be inert in exactly the case it was written for.
 *
 * ⚠️ NO SUBJECT AT ALL IS `UNDETERMINED`, NOT `PERMITTED`, AND THIS IS THE ONE
 *   DECISION IN THIS FUNCTION WORTH ARGUING WITH. A counter sale names nobody,
 *   so a jurisdiction that prohibits supplying a veterinary medicine for human
 *   use cannot be checked at a counter — and answering PERMITTED there would let
 *   the anonymous path be the way around the rule, which is precisely the path
 *   somebody buying it for themselves would take. Silence never permits.
 *
 *   The cost is bounded and visible: a pack whose species rule applies to
 *   `COUNTER_SALE` makes every anonymous counter sale of that product
 *   UNDETERMINED. That is a decision for the pack author to take deliberately by
 *   listing the transaction, not one this engine takes on their behalf, and it
 *   is why `appliesToTransactions` on a species rule is worth being explicit
 *   about.
 */
function evaluateSpeciesRestriction(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseSpeciesRestriction(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const patient = request.patient;
  if (patient === undefined) {
    return undetermined(
      `${rule.code} restricts who ${rule.appliesToProductType === null ? 'this' : 'this product'} ` +
        'may be supplied for, and this transaction names no subject.'
    );
  }

  const { prohibitedSubjectTypes, permittedSpecies, prohibitedSpecies } = parsed.value;

  if (prohibitedSubjectTypes?.includes(patient.subjectType) === true) {
    return refused(rule.statement);
  }

  /*
   * The species lists speak about animals only. A human subject that survived
   * the check above is not made unlawful by a rule listing which animals may
   * have the product — and reading a human as "an animal not on the list" is how
   * an allow-list of three species refuses every person in the country.
   */
  if (patient.subjectType !== 'ANIMAL') {
    return permitted(`${rule.code}: the subject is not one this rule restricts.`);
  }
  if (permittedSpecies === undefined && prohibitedSpecies === undefined) {
    return permitted(`${rule.code}: the subject is not one this rule restricts.`);
  }

  const species = patient.species?.trim();
  if (species === undefined || species === '') {
    return undetermined(
      `${rule.code} restricts which species this may be supplied for, and no species is ` +
        "recorded on the patient's record."
    );
  }

  /*
   * ⚠️ CASE-INSENSITIVE, AND THAT IS THE ONLY NORMALISATION APPLIED. `"dog"` and
   *   `"Dog"` are one species; `"Canine"` and `"Dog"` are two, and this engine
   *   deliberately does not own a synonym table — a species vocabulary
   *   maintained in TypeScript is a clinical dictionary nobody signed off. See
   *   the comment on `RegulatoryPatient.species`.
   */
  const folded = species.toLowerCase();
  const matches = (list: readonly string[]): boolean =>
    list.some((entry) => entry.trim().toLowerCase() === folded);

  if (prohibitedSpecies !== undefined && matches(prohibitedSpecies)) {
    return refused(rule.statement);
  }
  if (permittedSpecies !== undefined && !matches(permittedSpecies)) {
    return refused(rule.statement);
  }

  return permitted(`${rule.code}: this may be supplied for a ${species}.`);
}

function evaluateSubstitution(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseSubstitution(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  if (request.substitution?.isSubstitution !== true) {
    return permitted(`${rule.code} applies to a substitution, and nothing is being substituted.`);
  }

  if (parsed.value.permitted !== true) return refused(rule.statement);

  const excluded = parsed.value.excludedClassifications ?? [];
  const classification = request.profile?.classification;
  if (
    classification !== null &&
    classification !== undefined &&
    excluded.includes(classification)
  ) {
    return refused(`${rule.statement} ${classification} products are excluded from substitution.`);
  }

  const conditions: RegulatoryCondition[] = [];
  if (parsed.value.requiresPrescriberConsent === true) {
    if (request.substitution.prescriberConsented !== true) {
      return refused(`${rule.statement} The prescriber has not agreed to this substitution.`);
    }
    conditions.push(
      condition(rule, 'REQUIRES_CONSENT', "Record the prescriber's agreement to the substitution.")
    );
  }
  if (parsed.value.requiresPatientConsent === true) {
    if (request.substitution.patientConsented !== true) {
      return refused(`${rule.statement} The patient has not agreed to this substitution.`);
    }
    conditions.push(
      condition(rule, 'REQUIRES_CONSENT', "Record the patient's agreement to the substitution.")
    );
  }

  return permitted(`${rule.code}: substitution is permitted here.`, conditions);
}

function evaluateOnlineDispensing(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseOnlineDispensing(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  if (request.transaction !== 'ONLINE_DISPENSE') {
    return permitted(`${rule.code} applies to remote supply, and this is not one.`);
  }

  if (parsed.value.permitted !== true) return refused(rule.statement);

  const classification = request.profile?.classification;
  const excluded = parsed.value.excludedClassifications ?? [];
  if (
    classification !== null &&
    classification !== undefined &&
    excluded.includes(classification)
  ) {
    return refused(`${rule.statement} ${classification} products may not be supplied remotely.`);
  }

  const destinations = parsed.value.destinationCountryCodes;
  if (destinations !== undefined && destinations.length > 0) {
    const destination = request.destination;
    if (destination === undefined) {
      return undetermined(
        `${rule.code} restricts where this may be sent, and no destination was supplied.`
      );
    }
    if (!destinations.includes(destination.countryCode.toUpperCase())) {
      return refused(
        `${rule.statement} It may not be supplied to ${formatJurisdiction(destination)}.`
      );
    }
  }

  return permitted(`${rule.code}: remote supply is permitted.`);
}

function evaluateStorageRequirement(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseStorageRequirement(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const conditions = [
    condition(
      rule,
      'STORE_UNDER_CONDITIONS',
      parsed.value.detail ?? rule.statement,
      parsed.value.locationKinds !== undefined
        ? { locationKinds: [...parsed.value.locationKinds] }
        : undefined
    ),
  ];

  if (request.transaction !== 'STOCK' && request.transaction !== 'TRANSFER') {
    return permitted(`${rule.code}: storage obligations apply.`, conditions);
  }

  const kinds = parsed.value.locationKinds;
  if (kinds !== undefined && kinds.length > 0) {
    const kind = request.location?.kind;
    if (kind === undefined) {
      return undetermined(
        `${rule.code} restricts where this may be kept, and no location was supplied.`
      );
    }
    if (!kinds.includes(kind)) {
      return refused(`${rule.statement} It may only be kept in: ${kinds.join(', ')}.`);
    }
  }

  if (
    parsed.value.controlledAccessRequired === true &&
    request.location?.hasControlledAccess !== true
  ) {
    return refused(`${rule.statement} This location has no controlled access.`);
  }

  return permitted(`${rule.code}: the location satisfies the storage requirement.`, conditions);
}

function evaluateTraceability(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseTraceability(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  const required = parsed.value.requiredIdentifiers ?? [];
  if (required.length === 0) return permitted(`${rule.code}: no identifiers are required.`);

  const evidence = request.traceability;
  const held: Record<string, boolean> = {
    GTIN: Boolean(evidence?.gtin),
    LOT: Boolean(evidence?.lotNumber),
    EXPIRY: Boolean(evidence?.expiresOn),
    SERIAL: Boolean(evidence?.serial),
  };

  const missing = required.filter((identifier) => held[identifier] !== true);
  if (missing.length > 0) {
    /*
     * ⚠️ REFUSED RATHER THAN UNDETERMINED, AND THE DIFFERENCE IS REAL. A missing
     *   lot number is not a configuration gap somebody at rcln can fix; it is a
     *   pack in front of the person, without the marking the jurisdiction
     *   requires. The remedy is at the counter, so the answer is a refusal.
     */
    return refused(`${rule.statement} Missing: ${missing.join(', ')}.`);
  }

  return permitted(`${rule.code}: every required identifier was captured.`);
}

function evaluateObligation(
  rule: RegulatoryRule,
  request: RegulatoryRequest,
  kind: RegulatoryCondition['kind']
): RuleVerdict {
  const parsed = parseObligation(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  if (kind === 'DISPOSE_BY_METHOD' && request.transaction !== 'DISPOSE') {
    return permitted(`${rule.code} applies to disposal, and this is not one.`);
  }

  const parameters: Record<string, unknown> = {};
  if (parsed.value.fields !== undefined) parameters['fields'] = [...parsed.value.fields];
  if (parsed.value.years !== undefined) parameters['years'] = parsed.value.years;
  if (parsed.value.cadence !== undefined) parameters['cadence'] = parsed.value.cadence;
  if (parsed.value.recipient !== undefined) parameters['recipient'] = parsed.value.recipient;
  if (parsed.value.method !== undefined) parameters['method'] = parsed.value.method;

  const conditions = [
    condition(
      rule,
      kind,
      parsed.value.detail ?? rule.statement,
      Object.keys(parameters).length > 0 ? parameters : undefined
    ),
  ];

  if (parsed.value.witnessRequired === true) {
    conditions.push(
      condition(rule, 'WITNESS_REQUIRED', 'A second registered person must witness this.')
    );
  }

  return permitted(`${rule.code}: an obligation applies.`, conditions);
}

function evaluateImportRestriction(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  const parsed = parseImportRestriction(rule.parameters);
  if (!parsed.ok) return unreadable(rule, parsed);

  if (request.transaction !== 'STOCK' && request.transaction !== 'TRANSFER') {
    return permitted(`${rule.code} applies to bringing stock in, and this is not that.`);
  }

  /*
   * ⚠️ `!== true`, MATCHING `evaluateOnlineDispensing`. These two read the same
   *   key and disagreed: an unstated `permitted` refused for remote supply and
   *   PERMITTED for import. `parseImportRestriction` now requires the key, so
   *   this is belt on top of brace — but the two handlers must not read one
   *   parameter two ways, because a rule author will assume they do not.
   */
  if (parsed.value.permitted !== true) return refused(rule.statement);

  if (parsed.value.licenceRequired === true) {
    const licenceType = parsed.value.licenceType;
    const held = request.actor.licenceTypes ?? [];
    const satisfied = licenceType === undefined ? held.length > 0 : held.includes(licenceType);
    if (!satisfied) {
      return refused(
        `${rule.statement} A ${licenceType ?? 'licence'} is required and none was presented.`
      );
    }
  }

  return permitted(`${rule.code}: import is permitted.`);
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

function evaluateRule(rule: RegulatoryRule, request: RegulatoryRequest): RuleVerdict {
  switch (rule.ruleType) {
    case 'PRESCRIPTION_REQUIRED':
      return evaluatePrescriptionRequired(rule, request);
    case 'PRESCRIBER_AUTHORITY':
      return evaluatePrescriberAuthority(rule, request);
    case 'PHARMACIST_AUTHORITY':
      return evaluatePharmacistAuthority(rule, request);
    case 'CONTROLLED_SCHEDULE':
      return evaluateControlledSchedule(rule, request);
    case 'QUANTITY_LIMIT':
      return evaluateQuantityLimit(rule, request);
    case 'REFILL_RULE':
      return evaluateRefillRule(rule, request);
    case 'AGE_RESTRICTION':
      return evaluateAgeRestriction(rule, request);
    case 'SPECIES_RESTRICTION':
      return evaluateSpeciesRestriction(rule, request);
    case 'SUBSTITUTION':
      return evaluateSubstitution(rule, request);
    case 'ONLINE_DISPENSING':
      return evaluateOnlineDispensing(rule, request);
    case 'STORAGE_REQUIREMENT':
      return evaluateStorageRequirement(rule, request);
    case 'RECORD_RETENTION':
      return evaluateObligation(rule, request, 'RETAIN_RECORD');
    case 'TRACEABILITY_REQUIREMENT':
      return evaluateTraceability(rule, request);
    case 'LABELLING_REQUIREMENT':
      return evaluateObligation(rule, request, 'LABEL_FIELDS');
    case 'REPORTING_REQUIREMENT':
      return evaluateObligation(rule, request, 'REPORT_TO_AUTHORITY');
    case 'DISPOSAL_REQUIREMENT':
      return evaluateObligation(rule, request, 'DISPOSE_BY_METHOD');
    case 'IMPORT_RESTRICTION':
      return evaluateImportRestriction(rule, request);
  }
}

function toReason(rule: RegulatoryRule, verdict: RuleVerdict): RegulatoryReason {
  return {
    ruleId: rule.id,
    ruleCode: rule.code,
    ruleType: rule.ruleType,
    packId: rule.packId,
    packVersion: rule.packVersion,
    outcome: verdict.outcome,
    message: verdict.message,
  };
}

/**
 * The whole decision.
 *
 * ⚠️ EVERY APPLICABLE RULE IS EVALUATED AND EVERY VERDICT IS RECORDED, INCLUDING
 *   THE PERMISSIONS. The decision is snapshotted onto the transaction
 *   (PI-ADR-008), and "which rules were considered and said yes" is exactly what
 *   an inspection asks about a dispense that went ahead. Short-circuiting on the
 *   first refusal would make the record of a refused dispense depend on rule
 *   ordering.
 *
 * ⚠️ RULES FROM AN IMMATURE PACK ARE STILL EVALUATED. The pack's maturity is
 *   reported on the decision rather than used to filter it, because the
 *   alternative is that a jurisdiction nobody has signed off yet silently
 *   permits everything — which is the worst of both states. What maturity
 *   governs is what the SCREEN says (PI-ADR-009), and PI-6 onwards decides which
 *   packs are enforced at which call sites.
 */
export function evaluate(request: RegulatoryRequest): RegulatoryDecision {
  const applicable = selectApplicableRules(request);

  const packVersionIds = [...new Set(applicable.map((rule) => rule.packId))];
  const lowestPackMaturity = applicable.reduce<RulePackMaturity | null>((lowest, rule) => {
    if (lowest === null) return rule.packMaturity;
    return MATURITY_ORDER.indexOf(rule.packMaturity) < MATURITY_ORDER.indexOf(lowest)
      ? rule.packMaturity
      : lowest;
  }, null);

  /*
   * ⚠️ THE REMOTE-SUPPLY GATE, CHECKED BEFORE EVERYTHING INCLUDING THE "NO RULES"
   *   BRANCH (PI-12). A remote supply is the one transaction in this package that
   *   fails OPEN when a pack says nothing about it: a jurisdiction whose rules
   *   list `ONLINE_DISPENSE` alongside `DISPENSE` — which every honest pack does,
   *   so the prescription rules follow the medicine home — permits a remote
   *   supply on the strength of rules written about a counter. No rule refused;
   *   no rule was asked.
   *
   *   So a product is not onlineable until somebody has said so, per jurisdiction,
   *   on its regulatory profile. See `onlineSaleGap` for why that field and not a
   *   rule type.
   *
   * ⚠️ IT IS FIRST BECAUSE IT IS THE MOST ACTIONABLE ANSWER, not because it is the
   *   most important. In an unconfigured country every one of these branches is
   *   true at once, and the reasons list is what somebody reads to find out what
   *   to do next — "record this product's position on remote supply" is a task,
   *   "no rule covers this" is a project.
   */
  const remoteGap = onlineSaleGap(request.transaction, request.profile);
  if (remoteGap !== null) {
    const place = formatJurisdiction(request.jurisdiction);
    return {
      /*
       * ⚠️ ONLY `PROHIBITED` IS A REFUSAL, AND THE DISTINCTION IS NOT COSMETIC.
       *   A refusal says somebody looked and the answer is no; `UNDETERMINED`
       *   says nobody has looked. Both stop the supply — `UNDETERMINED` refuses
       *   everywhere in this package — and they send the clinic to two different
       *   places: one to their regulator, the other to their own profile screen.
       */
      outcome: remoteGap === 'PROHIBITED' ? 'REFUSED' : 'UNDETERMINED',
      conditions: [],
      reasons: [
        {
          ruleId: null,
          ruleCode: null,
          ruleType: null,
          packId: null,
          packVersion: null,
          outcome: remoteGap === 'PROHIBITED' ? 'REFUSED' : 'UNDETERMINED',
          message: onlineSaleGapMessage(remoteGap, place),
        },
      ],
      packVersionIds,
      lowestPackMaturity,
    };
  }

  if (applicable.length === 0) {
    return {
      outcome: 'UNDETERMINED',
      conditions: [],
      reasons: [
        {
          ruleId: null,
          ruleCode: null,
          ruleType: null,
          packId: null,
          packVersion: null,
          outcome: 'UNDETERMINED',
          message:
            `No regulatory rule covers a ${request.transaction} of this product in ` +
            `${formatJurisdiction(request.jurisdiction)}. Nothing is permitted on the strength ` +
            "of an absence — configure the jurisdiction, or record this product's regulatory " +
            'profile, before dispensing it.',
        },
      ],
      packVersionIds,
      lowestPackMaturity,
    };
  }

  /*
   * ⚠️ THE PROFILE GAP, CHECKED BEFORE ANY RULE IS EVALUATED AND NOT AFTER.
   *   Running the rules first and adding this to the result would work, but it
   *   would put a permission and an unknown about the SAME product in one
   *   decision, and the reasons list is what an inspection reads. A product
   *   whose regulatory nature nobody has recorded has one honest answer, and it
   *   is this one. See `needsClassificationButHasNone`.
   */
  if (needsClassificationButHasNone(request)) {
    return {
      outcome: 'UNDETERMINED',
      conditions: [],
      reasons: [
        {
          ruleId: null,
          ruleCode: null,
          ruleType: null,
          packId: null,
          packVersion: null,
          outcome: 'UNDETERMINED',
          message:
            `${formatJurisdiction(request.jurisdiction)} decides what may be done with this ` +
            'kind of product by its regulatory classification, and this product has none ' +
            'recorded for this jurisdiction. Record its regulatory profile before supplying it — ' +
            'nothing is permitted on the strength of an absence.',
        },
      ],
      packVersionIds,
      lowestPackMaturity,
    };
  }

  const reasons: RegulatoryReason[] = [];
  const conditions: RegulatoryCondition[] = [];
  let anyRefusal = false;
  let anyUndetermined = false;

  for (const rule of applicable) {
    const verdict = evaluateRule(rule, request);
    reasons.push(toReason(rule, verdict));
    if (verdict.outcome === 'REFUSED') anyRefusal = true;
    if (verdict.outcome === 'UNDETERMINED') anyUndetermined = true;
    /*
     * ⚠️ CONDITIONS FROM A RULE THAT REFUSED ARE DROPPED, AND ONLY BECAUSE A
     *   REFUSED TRANSACTION HAS NO OBLIGATIONS TO CARRY OUT. `refused()` never
     *   returns any; this is the belt on top of that brace.
     */
    if (verdict.outcome === 'PERMITTED') conditions.push(...verdict.conditions);
  }

  /*
   * The precedence, and each step of it is load-bearing:
   *   a refusal beats everything      — one rule saying no is the answer
   *   an unknown beats a permission   — silence never permits
   *   a condition beats a bare yes    — an obligation must reach the caller
   */
  const outcome = anyRefusal
    ? 'REFUSED'
    : anyUndetermined
      ? 'UNDETERMINED'
      : conditions.length > 0
        ? 'PERMITTED_WITH_CONDITIONS'
        : 'PERMITTED';

  return {
    outcome,
    conditions: anyRefusal || anyUndetermined ? [] : conditions,
    reasons,
    packVersionIds,
    lowestPackMaturity,
  };
}
