/**
 * DUBAI — sub-national rule pack `AE-DU` 1.0.0, read from the Dubai Health
 * Authority's Pharmacy Guidelines.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from HRS/HPSD/PG/01/2021 as DHA
 *   publishes it, cited clause by clause, and reviewed by nobody qualified. The
 *   pack's maturity says so.
 *
 * ── THE DOCUMENT MOSTLY RECOMMENDS, AND THIS PACK IS BUILT FROM THE PART THAT
 *    DOES NOT ───────────────────────────────────────────────────────────────
 * ⚠️ THE SINGLE MOST IMPORTANT FACT ABOUT THIS FILE: the DHA Pharmacy Guidelines
 *   are 100 pages and most of them say "should", "may" or "it is recommended".
 *   Guideline Eight tells a pharmacy it "is recommended to establish and
 *   implement a process for safe dispensing"; Guideline Nine's dispensing label
 *   is "recommended to be identified clearly with the following information".
 *   Those are not obligations and this pack does not turn them into any.
 *
 *   **Guideline Fourteen is different, and it is where almost every rule below
 *   comes from.** Narcotics, Controlled Drugs and Semi Controlled Drugs are
 *   written in "shall", "must" and "is prohibited" throughout — "the validity of
 *   the Narcotic drug prescription SHALL not be more than three (3) days",
 *   "Refill prescriptions for Narcotics IS PROHIBITED", "Narcotics CANNOT be
 *   transferred between health facilities". A rule is written here only where
 *   the clause is in that register.
 *
 * ⚠️ WHICH MEANS THIS PACK IS DELIBERATELY THIN ON ORDINARY MEDICINES AND DENSE
 *   ON CONTROLLED ONES, AND THE ASYMMETRY IS THE DOCUMENT'S RATHER THAN A GAP IN
 *   THE READING. Australia's pack faced the same problem from a different angle
 *   — the Poisons Standard recommends and takes effect only through state law —
 *   and the answer there was to say so in every statement. The answer here is to
 *   leave the recommendations out.
 *
 * ── NO FEDERAL PACK SITS UNDER THIS ONE ─────────────────────────────────────
 * ⚠️ There is no `AE` pack. `uaelegislation.gov.ae` returns `403` and
 *   `mohap.gov.ae` resets the connection, so Ministerial Decree 888 of 2016 —
 *   which this document names as the authority for the whole of its narcotic
 *   prescribing regime — was read only as DHA restates it. Every rule below is
 *   cited to the DHA guidelines, never to the decree. The same discipline
 *   `regulatory-in.ts` applies to G.S.R. 588(E), and the reason
 *   `regulatory-ae-az.ts` carries the long version of this paragraph.
 *
 * ⚠️ SHARJAH, AJMAN, FUJAIRAH, RAS AL-KHAIMAH AND UMM AL-QUWAIN HAVE NOTHING.
 *   No emirate pack and no national floor, so every evaluation there is
 *   `UNDETERMINED`, which refuses.
 *
 * ── THE VOCABULARY IS SHARED WITH ABU DHABI AND IS DEFINED THERE ────────────
 * `AE_CLASSIFICATIONS` lives in `regulatory-ae-az.ts` and both packs import it,
 * because MOHAP sets a medicine's dispensing mode when it registers it — this
 * document says so itself at 18.1, listing OTC, Pharmacist only, Prescription
 * only, Semi Controlled, Controlled and Narcotic. ⚠️ Dubai calls the middle tier
 * a CONTROLLED DRUG and Abu Dhabi calls it a PSYCHOTROPIC medicinal product;
 * `CONTROLLED_DRUG` is the string both packs match and each pack's statements use
 * its own regulator's word.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * ⚠️ NO DISPENSING LABEL, THOUGH THE DOCUMENT HAS AN ELEVEN-FIELD ONE. Clause
 *   13.3.2 lists patient name, fill date, facility, prescriber, drug, strength,
 *   quantity, route, directions, expiry and the dispensing pharmacist — and
 *   opens "medication prepared by the pharmacy for immediate dispensing to a
 *   patient IS RECOMMENDED TO BE identified clearly with the following". A
 *   `LABELLING_REQUIREMENT` rule raises a `LABEL_FIELDS` condition, and a
 *   condition is an obligation rather than advice — see `RegulatoryCondition`.
 *   Turning a recommendation into one would misrepresent the guideline to every
 *   pharmacist in Dubai. The matrix cell stays `RESEARCH_REQUIRED`.
 *
 * ⚠️ NO DAYS'-SUPPLY LIMITS. Clauses 18.7.4 and 18.7.5 set the same
 *   prescriber-grade ladder Abu Dhabi does — a GP may prescribe a controlled
 *   drug for 3 days and only once for the same diagnosis, a specialist 15, a
 *   consultant 30 — and it is inexpressible for the two reasons set out at
 *   length in `regulatory-ae-az.ts`: the ladder turns on the prescriber's grade,
 *   which is not a property of a rule, and nothing in this programme populates
 *   `daysSupply`, so a rule using `maxDaysSupply` refuses every supply. The
 *   ladder is in the statements, where a pharmacist reads it.
 *
 * ⚠️ NO PRICE RULES. Clauses 12.1.5 and 12.1.6 forbid selling above the MOHAP
 *   price and forbid discounting below it. They are real and mandatory and they
 *   are not a regulatory decision about a supply — they belong to pricing, which
 *   is `@rcln/billing`'s domain, and a `regulatory_rule` that refused a dispense
 *   because of a price would be the wrong control in the wrong place.
 *
 * ⚠️ NO RULE FROM 12.1.9, "the pharmacy staff should not accept any returned
 *   medications previously dispensed to patients". It is in the recommending
 *   register, and `dispense_returns` is a PI-7 concept this pack must not
 *   quietly disable for one emirate on the strength of a "should".
 *
 * ── HOW TO CHANGE A RULE ────────────────────────────────────────────────────
 * You do not edit one. A change is a NEW row with a new `version` and a new
 * `effectiveFrom` (PI-ADR-008).
 */
import { AE_CLASSIFICATIONS } from './regulatory-ae-az.js';
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/** The day this pack becomes evaluable. Not the day DHA issued the guidelines. */
export const AE_DU_PACK_EFFECTIVE_FROM = '2026-08-20';

export const AE_DU_AUTHORITIES = [
  {
    code: 'AE_DHA',
    name: 'Dubai Health Authority',
    websiteUrl: 'https://www.dha.gov.ae/',
    remit:
      'The entity responsible for regulating, licensing and monitoring health facilities and ' +
      'healthcare professionals in the Emirate of Dubai. Its Health Regulation Sector issues the ' +
      'Pharmacy Guidelines, runs the Drug Control Section, holds the CD and SCD register books and ' +
      'sends the inspectors who witness a disposal. ⚠️ IT IS NOT THE FEDERAL REGULATOR: MOHAP ' +
      'registers a medicine and sets its dispensing mode, and the Ministerial Decrees these ' +
      'guidelines cite are MOHAP’s.',
  },
] as const;

export const AE_DU_SOURCES: SourceSeed[] = [
  {
    key: 'AE_DU_PHARMACY_GUIDELINES',
    authorityCode: 'AE_DHA',
    title: 'DHA Pharmacy Guidelines',
    documentReference: 'HRS/HPSD/PG/01/2021, Version 1 — Guideline Eight and Guideline Fourteen',
    sourceUrl: 'https://dha.gov.ae/uploads/112021/f6eb62ac-f666-4cce-9a2f-47788a25f565.pdf',
    version: 'Version 1 (2021), Health Policies and Standards Department',
    publishedOn: '2021-11-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Published by the Dubai Health Authority’s Health Regulation Sector. All 100 pages were ' +
      'read. ⚠️ MOST OF THE DOCUMENT IS ADVISORY — "should", "may", "is recommended" — and rules ' +
      'are written only from clauses in the mandatory register, which is almost entirely ' +
      'Guideline Fourteen (narcotics, controlled and semi-controlled drugs) plus the prohibition ' +
      'in 12.1.4. ⚠️ IT IS A SECONDARY SOURCE FOR MINISTERIAL DECREES 888/2016 and 680/2017, ' +
      'which it names and which could not be retrieved; no rule cites them. ⚠️ The publication ' +
      'date recorded here is the month the document’s own URL path carries (112021); the document ' +
      'states only the year. UNVERIFIED means no qualified person has confirmed the READING.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/**
 * The three controlled tiers, in Dubai's own words.
 *
 * ⚠️ `platform` IS TRUE FOR TWO OF THE THREE AND THAT IS A REAL DIFFERENCE FROM
 *   ABU DHABI, NOT AN OMISSION HERE. Clause 18.7.3.c puts outpatient narcotic
 *   prescribing through the Unified Controlled Medication Platform and 18.7.4.d
 *   puts controlled drugs through it; 18.7.5, which governs semi-controlled
 *   drugs, does not mention it. Abu Dhabi's §5.5.4 does route semi-controlled
 *   refills through its platform. Two emirates, two answers, and each pack says
 *   what its own regulator wrote.
 */
const DU_TIERS = [
  {
    key: 'NARCOTIC',
    classification: AE_CLASSIFICATIONS.narcotic,
    word: 'narcotic',
    retentionYears: 5,
    reportingCadence: 'QUARTERLY',
    platform: true,
  },
  {
    key: 'CD',
    classification: AE_CLASSIFICATIONS.controlled,
    word: 'controlled drug',
    retentionYears: 5,
    reportingCadence: 'MONTHLY',
    platform: true,
  },
  {
    key: 'SCD',
    classification: AE_CLASSIFICATIONS.semiControlled,
    word: 'semi controlled drug',
    retentionYears: 2,
    reportingCadence: 'MONTHLY',
    platform: false,
  },
] as const;

const UNIFIED_PLATFORM = 'the Unified Controlled Medication Platform';

export const AE_DU_RULES: RuleSeed[] = [
  /*
   * 12.1.4.f — the one prohibition outside Guideline Fourteen.
   *
   * ⚠️ THIS CLAUSE IS MANDATORY WHERE ITS NEIGHBOURS ARE NOT, AND THAT IS WHY IT
   *   IS HERE: "The pharmacy staff ARE PROHIBITED from selling ... Prescription
   *   Only Medicines (POM) without a formal prescription that complies with the
   *   DHA rules and regulations."
   *
   * ⚠️ `validityMonths: 3` IS DRAWN FROM AN ILLUSTRATIVE CLAUSE AND IS THE
   *   WEAKEST READING IN EITHER EMIRATE PACK. Clause 12.1.3 lists what pharmacy
   *   staff "should consider" when reviewing a prescription, and its second item
   *   is "Prescription validity e.g. POM Prescriptions are valid for Three (3)
   *   month." The number is the regulator's own and it is the only statement of
   *   POM validity in the document — but it arrives inside a recommendation, as
   *   an example.
   *
   *   Writing it is the lesser error. Omitting a validity does not leave the
   *   question open: it makes a prescription of any age acceptable, which is the
   *   FAIL-OPEN direction, and this domain's whole shape is against that.
   *   Recorded in KNOWN_ISSUES so a reviewer with the DHA prescription rules in
   *   hand can confirm or replace it.
   *
   * ⚠️ MONTHS AND NOT DAYS. Three calendar months is 89, 90, 91 or 92 days
   *   depending on where in the year it starts (PI-13a, survey GAP 1), and
   *   `validityDays: 90` would refuse a lawful prescription in about half the
   *   year while citing a clause that permits it.
   */
  {
    code: 'DU-RX-POM',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A prescription only medicine may not be sold without a formal prescription complying with ' +
      'DHA rules, and such a prescription is valid for three months.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: AE_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityMonths: 3 },
    citation: 'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses 12.1.4(f), 12.1.3(b)',
  },

  /*
   * 18.8.1.h–i, 18.8.2.b, 18.8.3.b — three days, all three tiers.
   *
   * ⚠️ DUBAI AND ABU DHABI AGREE ON THIS NUMBER AND BOTH ATTRIBUTE IT TO
   *   MINISTERIAL DECREE 888 OF 2016, WHICH NEITHER PACK CITES. Two emirate
   *   regulators independently restating the same federal figure is the best
   *   evidence available that the figure is right, and it is still not a primary
   *   source — so both packs cite their own regulator's clause and the federal
   *   cell in the matrix stays unmoved.
   *
   * ⚠️ 18.8.1.i IS THE SAME RULE STATED AS AN INSTRUCTION TO THE PHARMACIST:
   *   "The pharmacist should not dispense the Narcotic prescription after three
   *   (3) days from the prescription date." It is the clause a refusal is
   *   actually about, so the statement is written in its voice.
   */
  ...DU_TIERS.map(({ key, classification, word }) => ({
    code: `DU-RX-${key}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `Do not dispense a ${word} more than three days after the date the treating physician or ` +
      'dentist issued the prescription. Review the elements and the validity of the prescription ' +
      'before supplying.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityDays: 3 },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (key === 'NARCOTIC' ? '18.8.1(g)–(i)' : key === 'CD' ? '18.8.2(a)–(b)' : '18.8.3(a)–(b)'),
  })),

  /*
   * 18.7.3.a — who may prescribe a narcotic.
   *
   * ⚠️ DUBAI ADDS A PREMISES LIMB THIS RULE CANNOT CARRY. The same clause
   *   confines narcotic prescribing to "inpatient and Emergency units in
   *   government and private hospital settings", with an outpatient exception at
   *   18.7.3.b.i for cancer patients, severe pain and post-major-surgery. What
   *   kind of unit a branch is, and why a patient is being treated, are facts
   *   rcln does not hold — the same wall Singapore's premises-conditional
   *   pharmacist gate ran into. Only the grade is checkable, so only the grade is
   *   checked, and the statement carries the rest.
   */
  {
    code: 'DU-PRESCRIBER-NARCOTIC',
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      'Only a DHA-licensed consultant or specialist, within the scope of their specialty, may ' +
      'prescribe a narcotic. Narcotic use is limited to hospital inpatient wards except for ' +
      'cancer patients, severe pain and post-major-surgery, where an outpatient supply of ' +
      'tablets, capsules or patches may run to thirty days.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: AE_CLASSIFICATIONS.narcotic,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: ['SPECIALIST', 'CONSULTANT'] },
    citation: 'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses 18.7.3(a)–(b)',
  },

  /*
   * 18.7.3.e — "Refill prescriptions for Narcotics is prohibited."
   *
   * ⚠️ NO `endorsedRepeatsPermitted`, DELIBERATELY. The key is opt-in because a
   *   flat prohibition and a prohibition-unless-endorsed are different rules, and
   *   this clause is the flat one.
   */
  {
    code: 'DU-REFILL-NARCOTIC',
    ruleType: 'REFILL_RULE',
    statement:
      'A narcotic prescription may not be refilled. Each narcotic dose is prescribed on its own ' +
      'prescription.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: AE_CLASSIFICATIONS.narcotic,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { refillsAllowed: 0, validityDays: 3 },
    citation: 'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses 18.7.3(d)–(e)',
  },

  /*
   * 18.7.4.e and 18.7.5 — the refillable tiers.
   *
   * ⚠️ THE PRESCRIBER'S GRADE DECIDES HOW MANY, AND THE PRESCRIPTION CARRIES THE
   *   ANSWER. A specialist may authorise one refill and a consultant two, so
   *   `maxEndorsedRepeats: 2` is the ceiling and `repeatsAuthorisedLimit` — read
   *   off the prescription, never asserted by the person dispensing — is what
   *   actually governs below it. `evaluateRefillRule` takes the minimum of the
   *   two. This is the one place the grade ladder is expressible without the
   *   engine knowing anybody's grade.
   *
   * ⚠️ AND AN UNENDORSED REFILL IS REFUSED, which is 18.7.5.a exactly: a GP gets
   *   thirty days and no refill.
   *
   * ⚠️ THE REFILLABLE CONTROLLED DRUGS ARE A LIST THIS PACK CANNOT SEE. Clause
   *   18.7.4.e permits refills only for the drugs in "a specific exceptional
   *   list ... as per the Ministerial Decree No (680) for the year of 2017",
   *   which could not be retrieved. So this rule is WIDER than the guideline for
   *   controlled drugs. Recorded in KNOWN_ISSUES.
   */
  ...[
    {
      key: 'CD',
      classification: AE_CLASSIFICATIONS.controlled,
      word: 'controlled drug',
      clause: '18.7.4(e)',
    },
    {
      key: 'SCD',
      classification: AE_CLASSIFICATIONS.semiControlled,
      word: 'semi controlled drug',
      clause: '18.7.5(a)–(d)',
    },
  ].map(({ key, classification, word, clause }) => ({
    code: `DU-REFILL-${key}`,
    ruleType: 'REFILL_RULE',
    statement:
      `A ${word} may be refilled only where the prescriber authorised it — a specialist may ` +
      'authorise one further thirty days and a consultant two, and a general practitioner or ' +
      'general dentist none. A refill is dispensed only at the end of the previous thirty days.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      refillsAllowed: 0,
      endorsedRepeatsPermitted: true,
      maxEndorsedRepeats: 2,
      validityDays: 3,
    },
    citation: `DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clause ${clause}`,
  })),

  /*
   * 18.9 — the register books, and 18.7.1 — the platform.
   *
   * ⚠️ TWO REGISTERS FROM TWO REGULATORS, WHICH 18.9.2 SPELLS OUT: the Narcotic
   *   Register book is MOHAP's and the CD and SCD Register book is DHA's. Both
   *   are handwritten — 18.9.4 requires indelible ink, chronological entries with
   *   no blank lines, and forbids erasing, overwriting or correction pens. The
   *   `RECORD_IN_CONTROLLED_REGISTER` condition names an artefact rcln cannot be,
   *   for the third time in this programme after Singapore's "bound book" and
   *   Abu Dhabi's PH 17/18/20.
   *
   * ⚠️ THE PLATFORM CONDITION IS RAISED FOR NARCOTICS AND CONTROLLED DRUGS AND
   *   NOT FOR SEMI-CONTROLLED ONES. See `DU_TIERS`: 18.7.3.c and 18.7.4.d name
   *   the Unified Controlled Medication Platform, 18.7.5 does not, and inventing
   *   the third would assert an obligation Dubai has not written — while Abu
   *   Dhabi HAS written it for its own semi-controlled refills. The two packs
   *   disagreeing here is the emirates disagreeing, and a test pins it.
   */
  ...DU_TIERS.map(({ key, classification, word, platform }) => ({
    code: `DU-SCHEDULE-${key}`,
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      `This is a ${word}. Enter every quantity received and every quantity dispensed in its ` +
      'register book on the day of the transaction, in clear indelible handwriting, in ' +
      'chronological order and without leaving a blank line. Never erase, overwrite or cross out ' +
      'an entry.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: {
      scheduleName: `${word} (Dubai)`,
      registerRequired: true,
      ...(platform
        ? { priorAuthorisationRequired: true, authorisationAuthority: UNIFIED_PLATFORM }
        : {}),
    },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (platform ? '18.7.1, 18.9.2, 18.9.4' : '18.9.2, 18.9.4'),
  })),

  /*
   * 18.6 — the cabinets.
   *
   * ⚠️ `controlledAccessRequired: true` AND NO `locationKinds`, THE CALL EVERY
   *   PACK IN THIS PROGRAMME HAS MADE. 18.6.5 contemplates narcotics stored
   *   "outside the pharmacy (in the inpatient units or medication room)", so an
   *   allow-list naming a cabinet kind would refuse a lawful medication room.
   *   What 18.6.3 demands of every one of them is that it be away from the
   *   general sales area and inaccessible to the public, and
   *   `requires_controlled_access` is that fact.
   *
   * ⚠️ THE DOUBLE LOCK, THE NON-DUPLICABLE KEYS AND THE ALARM ARE IN `detail`
   *   AND ARE NOT CHECKED, because no software holds them.
   */
  ...DU_TIERS.map(({ key, classification, word }) => ({
    code: `DU-STORE-${key}`,
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      `Keep ${word}s in a locked steel cabinet away from the general sales area and out of the ` +
      'public’s reach, with the key in the custody of the person in charge.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    /*
     * ⚠️ `ONLINE_DISPENSE` INCLUDED — WITHOUT IT THE COUNTER REFUSED WHAT THE
     *   PARCEL PERMITTED. A controlled medicine supplied from an open shelf was
     *   refused over the counter by `controlledAccessRequired` and not consulted
     *   at all when the same medicine went out as an online order, because the
     *   storage rules predate PI-12 making `ONLINE_DISPENSE` a live transaction.
     *   The stock is on the same shelf either way — the packing counter is the
     *   location the consult is given for. Eight rules across seven packs had
     *   this gap. (PI-24 review.)
     */
    appliesToTransactions: ['STOCK', 'TRANSFER', 'DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: {
      controlledAccessRequired: true,
      detail:
        key === 'NARCOTIC'
          ? 'A special secured lockable cabinet made of steel with internal hinges, a DOUBLE ' +
            'locking system, securely fixed to the wall or floor, with non-duplicable keys and a ' +
            'security or alarm system and/or a security camera — holding the narcotic drugs, the ' +
            'narcotic register books and the narcotic prescription books. Stored outside the ' +
            'pharmacy, a double locked steel cabinet inside a secured medication room.'
          : 'A special secured lockable cabinet made of steel with a single locking system, ' +
            'separate from the narcotic cabinet and holding the CD and SCD register book, placed ' +
            'away from the general sales area and inaccessible to the public. The cabinet is ' +
            'labelled and its keys stay with the person in charge or the authorised deputy.',
    },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (key === 'NARCOTIC' ? '18.6.3, 18.6.4, 18.6.5, 18.6.7' : '18.6.3, 18.6.6, 18.6.7'),
  })),

  /*
   * 18.8.1.j, 18.8.2.c, 18.8.3.c, 18.9.5 — five years, or two.
   *
   * ⚠️ THE SEMI-CONTROLLED PERIOD IS THE ONLY ONE THAT IS NOT FIVE, and it is
   *   two in both emirates — the one number Dubai and Abu Dhabi agree on without
   *   agreeing on the words around it. The REGISTER BOOKS are five years for all
   *   three tiers under 18.9.5; what differs is the retention of the
   *   PRESCRIPTIONS. `years` carries the prescription period, which is the one a
   *   dispense creates, and the `detail` says the register keeps its own clock.
   */
  ...DU_TIERS.map(({ key, classification, word, retentionYears }) => ({
    code: `DU-RETAIN-${key}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      `Retain the ${word} prescription in the facility for at least ` +
      `${retentionYears === 5 ? 'five' : 'two'} years, and its register book for five years ` +
      'after it is completed.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: [],
    parameters: {
      years: retentionYears,
      detail:
        (key === 'NARCOTIC'
          ? 'The pharmacist in charge signs the narcotic prescription before dispensing and ' +
            'retains it in the facility for a minimum of five years. '
          : `Electronic ${word} prescription records are retained in the health facility for a ` +
            `minimum of ${retentionYears === 5 ? 'five' : 'two'} years. `) +
        '⚠️ THE REGISTER BOOK IS SEPARATE AND IS ALWAYS FIVE YEARS after completion, whatever ' +
        'the prescription period — clause 18.9.5. Delivery notes and vouchers are also five ' +
        'years, clause 18.5.3.',
    },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (key === 'NARCOTIC'
        ? '18.8.1(j), 18.9.5'
        : key === 'CD'
          ? '18.8.2(c), 18.9.5'
          : '18.8.3(c), 18.9.5'),
  })),

  /*
   * 18.10.2 — the returns to the Health Regulation Sector.
   */
  ...DU_TIERS.map(({ key, classification, word, reportingCadence }) => ({
    code: `DU-REPORT-${key}`,
    ruleType: 'REPORTING_REQUIREMENT',
    statement:
      `Report consumption of ${word}s to the DHA Health Regulation Sector ` +
      `${reportingCadence === 'QUARTERLY' ? 'every quarter' : 'every month'}.`,
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      cadence: reportingCadence,
      recipient: 'the DHA Health Regulation Sector, by email',
      detail:
        'Consumption of everything stored, prescribed, dispensed, administered, returned and ' +
        'disposed of. Narcotic and CD stock is counted at the beginning and end of every shift ' +
        'and the count signed by the shift in-charge who performed and witnessed it; a ' +
        'discrepancy that cannot be reconciled is reported to HRS within 48 hours on the Drug ' +
        'Incident Report Form.',
    },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses 18.10.1, 18.10.2, 18.11.2, 18.14.2',
  })),

  /*
   * 18.13 — disposal.
   *
   * ⚠️ A NARCOTIC IS NOT DESTROYED IN DUBAI EITHER, AND IT GOES SOMEWHERE
   *   DIFFERENT FROM ABU DHABI'S. Clause 18.13.3 requires a DHA Narcotic
   *   Disposal request approval and then a return to the MOHAP Central Medical
   *   Stores; Abu Dhabi returns it to its own emirate's Central Purchase Store.
   *   Two emirates, two destinations, and a pack that shared one statement
   *   between them would send a Dubai pharmacist to the wrong place.
   */
  ...DU_TIERS.map(({ key, classification, word }) => ({
    code: `DU-DISPOSE-${key}`,
    ruleType: 'DISPOSAL_REQUIREMENT',
    statement:
      key === 'NARCOTIC'
        ? 'An expired or unused narcotic may not be destroyed here. Obtain a DHA Narcotic Disposal ' +
          'request approval and return it to the MOHAP Central Medical Stores.'
        : `An expired or unused ${word} is returned to the distributing drug store. If the store ` +
          'will not take it back, the DHA inspection team must approve and audit the disposal ' +
          'before it is discarded as medical waste.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: ['DISPOSE'],
    parameters: {
      witnessRequired: true,
      method:
        key === 'NARCOTIC'
          ? 'DHA Narcotic Disposal request approval, then return to the MOHAP Central Medical ' +
            'Stores. Empty narcotic ampoules go into sharps containers and their disposal is ' +
            'written by hand on the back of the narcotic prescription and signed by the person ' +
            'in charge and a second healthcare professional as witness.'
          : 'Return to the distributing drug store; failing that, a Medication Disposal Request ' +
            'Form to HRS, whose inspection team visits, audits the drugs, deducts the amounts ' +
            'from the CD and SCD registers and signs the form — after which a Dubai ' +
            'Municipality-approved medical waste company must destroy them within thirty days.',
      detail:
        'Disposal reports are kept at the facility and a copy sent to the Drug Control Section. ' +
        'Documents relating to the disposal of empty narcotic ampoules are retained five years.',
    },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (key === 'NARCOTIC' ? '18.13.3, 18.13.4' : '18.13.5, 18.13.6, 18.13.7'),
  })),

  /*
   * 18.12 — transfer between facilities.
   *
   * ⚠️ SAME SHAPE AND SAME CAVEAT AS ABU DHABI'S: an `IMPORT_RESTRICTION` row
   *   that says nothing about imports, narrowed to `TRANSFER` so that goods
   *   receipt is untouched, because `evaluateImportRestriction` is the only
   *   handler that refuses a transaction outright. The framework's missing piece
   *   is a `permitted: false` transaction rule; recorded in KNOWN_ISSUES.
   *
   * ⚠️ AND DUBAI IS EXPLICIT ABOUT THE CASE RCLN ACTUALLY CREATES. Clause
   *   18.12.2 prohibits transferring CD and SCD between facilities and then says
   *   "Exceptions MAY be granted WITHIN A GROUP OF HEALTH FACILITIES WITH THE
   *   SAME OWNER for specific reasons such as temporary or permanent closure, or
   *   emergency cases only" — which is a multi-branch organization, described. It
   *   still requires a Transfer Request Form, an HRS inspection visit and the
   *   inspectors adjusting the register books, none of which rcln can see, and
   *   18.12.5 calls anything else "illegal supply". So the rule refuses and the
   *   statement says how the exception is obtained.
   */
  ...DU_TIERS.map(({ key, classification, word }) => ({
    code: `DU-TRANSFER-${key}`,
    ruleType: 'IMPORT_RESTRICTION',
    statement:
      key === 'NARCOTIC'
        ? 'Narcotics cannot be transferred between health facilities, including between branches ' +
          'of the same owner.'
        : `Transferring a ${word} between facilities is prohibited. An exception may be granted ` +
          'within a group of facilities under the same owner — for a closure or an emergency — ' +
          'but only on a Transfer Request Form approved by HRS, whose inspectors adjust and sign ' +
          'the register books. Any other transfer is illegal supply.',
    sourceKey: 'AE_DU_PHARMACY_GUIDELINES',
    appliesToClassification: classification,
    appliesToTransactions: ['TRANSFER'],
    parameters: { permitted: false },
    citation:
      'DHA Pharmacy Guidelines HRS/HPSD/PG/01/2021, clauses ' +
      (key === 'NARCOTIC' ? '18.12.1' : '18.12.2, 18.12.3, 18.12.5'),
  })),
];
