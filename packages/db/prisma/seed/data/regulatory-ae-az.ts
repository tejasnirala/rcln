/**
 * ABU DHABI — sub-national rule pack `AE-AZ` 1.0.0, read from the Department of
 * Health's own standard for narcotics, psychotropics and semi-controlled
 * medicinal products.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from DOH/HLME/DMP/1.0/2021 as
 *   the Department of Health Abu Dhabi publishes it, cited clause by clause, and
 *   reviewed by nobody qualified. The pack's maturity says so.
 *
 * ── THE FEDERAL PACK THAT IS NOT HERE, AND WHY THAT IS THE PHASE'S FINDING ───
 * ⚠️ THERE IS NO `AE` PACK. PI-17 set out to ship "federal plus at least one
 *   emirate" and could not reach the federal half: `uaelegislation.gov.ae`
 *   returns `403` on every path and `mohap.gov.ae` resets the connection. The
 *   federal instruments this standard rests on — Ministerial Decree 888 of 2016
 *   (the three-day validity and the prescriber ladder), Ministerial Decree 379
 *   of 2019 (the unified platform), Ministerial Decree 253 of 2020 (the
 *   refillable list), Federal Law 8 of 2019 and Federal Law 14 of 1995 — were
 *   read only AS RESTATED BY THIS DOCUMENT.
 *
 * ⚠️ SO EVERY RULE BELOW IS CITED TO THE DOH STANDARD AND NOT TO THE DECREE IT
 *   QUOTES, AND THE DIFFERENCE IS NOT PEDANTRY. `regulatory-in.ts` records what
 *   a secondary source costs: G.S.R. 588(E) is published by CDSCO only as a
 *   scanned image, so India's Schedule H1 rules cite the consolidated rules
 *   whose text was actually read, and that notification's commencement date is
 *   asserted nowhere in this programme. The same discipline applies here. This
 *   pack is a PRIMARY source for what DOH requires of a DOH-licensed facility in
 *   Abu Dhabi — which is what it says on its own cover, "Applies to: DOH Licensed
 *   healthcare providers in the Emirate of Abu Dhabi" — and it is a SECONDARY
 *   source for the federal decrees, so it is used only as the first.
 *
 * ⚠️ THE PRICE IS PAID BY THE OTHER FIVE EMIRATES. Sharjah, Ajman, Fujairah, Ras
 *   al-Khaimah and Umm al-Quwain have no pack and no national floor beneath
 *   them, so every evaluation there answers `UNDETERMINED`, which refuses. That
 *   is worse than Australia, where a Sydney branch at least gets the Poisons
 *   Standard — and it is the honest state of the sources rather than something
 *   this file can fix by inventing a federal rule.
 *
 * ── THE VOCABULARY, AND WHY IT IS NOT THIS DOCUMENT'S ────────────────────────
 * ⚠️ ABU DHABI AND DUBAI NAME THE MIDDLE TIER DIFFERENTLY AND THE PRODUCT CAN
 *   ONLY BE FILED ONCE. This standard calls it a PSYCHOTROPIC medicinal product
 *   (§3.1.1, §5.4); the DHA Pharmacy Guidelines call it a CONTROLLED DRUG (CD).
 *   They are the same tier — the one between a narcotic and a semi-controlled
 *   drug — and `product_regulatory_profiles.classification` is one string.
 *
 *   Both packs are therefore written against `CONTROLLED_DRUG`, because the
 *   dispensing mode is set federally when MOHAP registers the medicine (the DHA
 *   guidelines say so at 18.1) and a clinic should not have to re-file a product
 *   when it opens a branch in the other emirate. Each pack's STATEMENTS use its
 *   own regulator's word, so a pharmacist reading a refusal sees the term their
 *   inspector uses. See `AE_CLASSIFICATIONS`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO DAYS'-SUPPLY LIMITS, AND THIS IS THE LARGEST OMISSION IN THE PACK.
 *   Sections 5.4.1 to 5.4.3 set a ladder — a General Practitioner may prescribe
 *   3 days' supply of a psychotropic, a Specialist 15, a Consultant 30 — and
 *   §5.3.1 caps outpatient narcotics at 30 days. Neither is written, for two
 *   independent reasons, and either alone would be enough:
 *
 *   1. **The ladder is conditioned on the PRESCRIBER'S GRADE, which no rule
 *      shape carries.** `maxDaysSupply` is a property of the rule, not of the
 *      prescriber. Three rules of one type against one classification are a TIE,
 *      `mostSpecific` keeps ties, the engine evaluates both, and a refusal beats
 *      a permission everywhere in this package — so the three-day GP limit would
 *      govern every consultant's prescription in the emirate.
 *   2. **Nothing populates `daysSupply`.** It comes off the directions for use,
 *      which this programme does not parse, and `evaluateQuantityLimit` answers
 *      `UNDETERMINED` — which refuses — for every caller that omits it. A pack
 *      carrying these rules would refuse every controlled supply in Abu Dhabi
 *      while looking thorough.
 *
 *   The ladder is written into the rule STATEMENTS instead, where a pharmacist
 *   reads it and the engine does not act on it. Recorded in KNOWN_ISSUES.
 *
 * ⚠️ NO "PHYSICIANS MAY NOT PRESCRIBE FOR THEMSELVES OR THEIR RELATIVES"
 *   (§5.3.5, §5.4.5, §5.5.6). It is a real prohibition and it is about the
 *   RELATIONSHIP between the prescriber and the patient, which this platform
 *   does not hold — `RegulatoryActor.isPrescriber` says whether the person
 *   dispensing wrote the prescription, and nothing anywhere says whether the
 *   prescriber is the patient's brother. A rule that cannot be evaluated is
 *   `UNDETERMINED`, which refuses; there is no shape here that refuses only the
 *   case the section names.
 *
 * ⚠️ NO NARCOTIC FORECAST, PROCUREMENT OR CENTRAL PURCHASE STORE RULES
 *   (§9). They are obligations of a FACILITY across a year — submit a forecast
 *   before 1 June, procure only from the Central Purchase Store, exchange empty
 *   ampoules one for one — not decisions about a transaction. This engine
 *   answers "may this supply happen, and what must be done about it".
 *
 * ⚠️ NO DISPENSING LABEL. This standard is about narcotics and psychotropics and
 *   contains no labelling requirement at all. Abu Dhabi's general labelling rules
 *   are elsewhere and were not read, so there is nothing to write. The matrix
 *   cell stays `RESEARCH_REQUIRED`.
 *
 * ── HOW TO CHANGE A RULE ─────────────────────────────────────────────────────
 * You do not edit one. A change is a NEW row with a new `version` and a new
 * `effectiveFrom`, and the old one gets an `effectiveTo` and `SUPERSEDED`
 * (PI-ADR-008). See the header of `regulatory-in.ts`.
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/**
 * The day this pack becomes evaluable.
 *
 * ⚠️ NOT the day the DOH standard took effect, which is June 2021 and lives on
 *   the source row. `effective_from` answers "from when does rcln act on this?".
 */
export const AE_AZ_PACK_EFFECTIVE_FROM = '2026-08-20';

export const AE_AZ_AUTHORITIES = [
  {
    code: 'AE_DOH',
    name: 'Department of Health — Abu Dhabi',
    websiteUrl: 'https://www.doh.gov.ae/',
    remit:
      'The regulator of the healthcare sector in the Emirate of Abu Dhabi. Licenses healthcare ' +
      'providers and professionals, and issues the standards they are audited against — including ' +
      'the narcotic, psychotropic and semi-controlled register books, the demand and return ' +
      'vouchers, and the auditors who witness a destruction. ⚠️ IT IS NOT THE FEDERAL REGULATOR: ' +
      'the Ministry of Health and Prevention registers a medicine and sets its dispensing mode, ' +
      'and the Ministerial Decrees this standard quotes are MOHAP’s, not DOH’s.',
  },
] as const;

export const AE_AZ_SOURCES: SourceSeed[] = [
  {
    key: 'AE_AZ_NARCOTICS_STANDARD',
    authorityCode: 'AE_DOH',
    title:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products',
    documentReference: 'DOH/HLME/DMP/1.0/2021, sections 4 to 11',
    sourceUrl: 'https://www.doh.gov.ae/-/media/8F268D5B4B074905AF42644F6D08DC17.ashx',
    version: 'Version 1.0, effective June 2021',
    publishedOn: '2021-06-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Published by the Department of Health Abu Dhabi and applying, on its own cover, to "DOH ' +
      'Licensed healthcare providers in the Emirate of Abu Dhabi". All ten pages were read. ' +
      '⚠️ IT IS A PRIMARY SOURCE FOR WHAT DOH REQUIRES AND A SECONDARY ONE FOR EVERY FEDERAL ' +
      'DECREE IT QUOTES — Ministerial Decrees 888/2016, 379/2019, 253/2020, 68/1995 and 4192/2018, ' +
      'and Federal Laws 8/2019 and 14/1995, none of which could be retrieved: uaelegislation.gov.ae ' +
      'returned 403 and mohap.gov.ae reset the connection. No rule below cites a decree. ' +
      'UNVERIFIED means no qualified person has confirmed the READING.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The classification strings BOTH emirate packs are written against.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`, AND
 *   NOT PARSED, CASE-FOLDED OR TRIMMED — the discipline every pack in this
 *   programme is written under.
 *
 * ⚠️ SHARED BETWEEN ABU DHABI AND DUBAI ON PURPOSE, AND EXPORTED FROM THIS FILE
 *   SO THERE IS ONE COPY. The dispensing mode is decided federally when MOHAP
 *   registers the medicine — the DHA Pharmacy Guidelines say so at 18.1, listing
 *   OTC, Pharmacist only, Prescription only, Semi Controlled, Controlled and
 *   Narcotic — so a product does not change tier when a clinic opens a branch in
 *   the other emirate, and it must not have to be re-filed to be recognised
 *   there. Two copies of this object is how the two packs silently stop matching
 *   the same products.
 *
 * ⚠️ `CONTROLLED_DRUG` IS DUBAI'S WORD FOR THE TIER ABU DHABI CALLS
 *   "PSYCHOTROPIC". One of the two had to be picked; the statements in each pack
 *   use that emirate's own term so a refusal reads in the vocabulary of whoever
 *   is inspecting.
 *
 * ⚠️ `OTC` AND `PHARMACIST_ONLY_MEDICINE` ARE LISTED AND UNUSED. Neither pack
 *   carries a rule for them: DOH's standard is about controlled products only,
 *   and DHA's over-the-counter guideline is a description of FDA categories
 *   rather than an obligation. They are here because they are the other two
 *   modes MOHAP assigns, and a clinic filing one of them gets `UNDETERMINED` —
 *   which refuses — rather than a rule nobody wrote.
 */
export const AE_CLASSIFICATIONS = {
  otc: 'OTC',
  pharmacistOnly: 'PHARMACIST_ONLY_MEDICINE',
  prescriptionOnly: 'PRESCRIPTION_ONLY_MEDICINE',
  semiControlled: 'SEMI_CONTROLLED_DRUG',
  controlled: 'CONTROLLED_DRUG',
  narcotic: 'NARCOTIC',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/**
 * The three controlled tiers, with the word THIS emirate uses for each.
 *
 * ⚠️ THE RETENTION PERIODS ARE NOT UNIFORM AND THAT IS §7.4 SPEAKING, NOT AN
 *   OVERSIGHT: registers, invoices and prescription forms for narcotic and
 *   psychotropic products are kept five years from the last entry, and
 *   semi-controlled prescriptions two years from the last date of dispensing.
 */
const AZ_TIERS = [
  {
    key: 'NARCOTIC',
    classification: AE_CLASSIFICATIONS.narcotic,
    word: 'narcotic',
    retentionYears: 5,
    reportingCadence: 'QUARTERLY',
  },
  {
    key: 'CD',
    classification: AE_CLASSIFICATIONS.controlled,
    word: 'psychotropic',
    retentionYears: 5,
    reportingCadence: 'MONTHLY',
  },
  {
    key: 'SCD',
    classification: AE_CLASSIFICATIONS.semiControlled,
    word: 'semi-controlled',
    retentionYears: 2,
    reportingCadence: 'MONTHLY',
  },
] as const;

/**
 * What §5.1 requires before any of this reaches a patient.
 *
 * ⚠️ THE UNIFIED PLATFORM IS A PRECONDITION THE DISPENSER CAN ONLY VERIFY, WHICH
 *   IS EXACTLY WHAT `VERIFY_PRIOR_AUTHORISATION` WAS BUILT FOR (PI-13a, survey
 *   GAP 2 — which named "AE narcotic approval" in its own table). Section 5.1
 *   says narcotics and psychotropics "must be prescribed electronically through
 *   the unified platform system"; whether a given prescription was issued there
 *   is a fact about somebody else's system, established before this transaction
 *   existed. rcln does not talk to it. Refusing for want of a record we could
 *   never hold would block every lawful supply in the emirate; permitting
 *   silently would drop the requirement that makes the supply lawful.
 */
const UNIFIED_PLATFORM = 'the DOH unified platform system';

export const AE_AZ_RULES: RuleSeed[] = [
  /*
   * §5.2.2, §5.3.3, §5.4.4.3, §5.5.5 — three days, for all three tiers.
   *
   * ⚠️ THREE DAYS IS SHORT ENOUGH THAT IT LOOKS LIKE A TYPO, AND IT IS STATED
   *   FOUR SEPARATE TIMES IN THE STANDARD. It is the validity of the
   *   PRESCRIPTION — how long the patient has to present it — not the length of
   *   treatment it may cover, which is the ladder this pack does not carry. A
   *   thirty-day supply written on a Monday must be collected by Thursday.
   *
   * ⚠️ `validityDays` AND NOT `validityMonths`: the standard states a day count,
   *   like Great Britain's 28 and Ireland's 14. Survey GAP 1 is for the
   *   jurisdictions that state months, and converting between the two is the bug
   *   that key exists to prevent.
   *
   * ⚠️ SETTING A VALIDITY ALSO BUYS THE "NOT BEFORE THE DATE" LIMB.
   *   `evaluatePrescriptionRequired` refuses a prescription dated after the day
   *   it is being dispensed whenever any validity is stated.
   */
  ...AZ_TIERS.map(({ key, classification, word }) => ({
    code: `AZ-RX-${key}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `A ${word} medicinal product may be supplied only on a prescription, and the prescription ` +
      'is valid for no more than three days counted from the day the physician issued it. ' +
      'Obtain the prescription, and check its date, before supplying this.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityDays: 3 },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 5.2.2, 5.3.3, 5.4.4.3, 5.5.5',
  })),

  /*
   * §5.3.1 — who may prescribe an outpatient narcotic.
   *
   * ⚠️ A GRADE, NOT A LICENCE AND NOT A ROLE. "Specialist" and "Consultant" are
   *   DOH licensing grades, and they are the only two the section admits — a
   *   General Practitioner may not prescribe a narcotic at all, while §5.4.1
   *   lets one prescribe a psychotropic. That asymmetry is why this rule exists
   *   for narcotics only.
   *
   * ⚠️ AND IT IS THE ONE PLACE THE PRESCRIBER'S GRADE IS EXPRESSIBLE. The
   *   days'-supply ladder turns on the same fact and cannot be written, because
   *   `maxDaysSupply` is a property of the rule rather than of the prescriber —
   *   see the file header. A membership records `SPECIALIST` or `CONSULTANT` the
   *   way it records any other prescriber class.
   */
  {
    code: 'AZ-PRESCRIBER-NARCOTIC',
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      'Only a specialist or a consultant, within their scope of specialty, may prescribe a ' +
      'narcotic for an outpatient, and then only in tablet, capsule or patch form for a maximum ' +
      'of thirty days.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: AE_CLASSIFICATIONS.narcotic,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: ['SPECIALIST', 'CONSULTANT'] },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, § 5.3.1',
  },

  /*
   * §5.3.2 — narcotics are not refillable, full stop.
   *
   * ⚠️ NO `endorsedRepeatsPermitted`, AND ITS ABSENCE IS THE RULE. The key is
   *   opt-in precisely because "not more than once" and "not more than once
   *   unless the prescriber endorses it" are different laws. Section 5.3.2 is
   *   the first: "Refill prescriptions are NOT permitted for narcotic products."
   */
  {
    code: 'AZ-REFILL-NARCOTIC',
    ruleType: 'REFILL_RULE',
    statement:
      'A narcotic prescription may not be refilled. Each supply needs its own prescription, ' +
      'issued through the unified platform system.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: AE_CLASSIFICATIONS.narcotic,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { refillsAllowed: 0, validityDays: 3 },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 5.3.2, 5.3.3',
  },

  /*
   * §5.4.4 and §5.5.1–5.5.3 — the refillable tiers.
   *
   * ⚠️ `maxEndorsedRepeats: 2` IS THE CONSULTANT'S CEILING AND THE PRESCRIPTION'S
   *   OWN NUMBER STILL GOVERNS BELOW IT. A specialist may write one refill and a
   *   consultant two, which is the prescriber-grade ladder again — but here the
   *   framework carries it honestly, because the number the prescriber actually
   *   wrote travels on the prescription as `repeatsAuthorisedLimit` and
   *   `evaluateRefillRule` takes the MINIMUM of that and the rule's ceiling. So a
   *   specialist's one refill is enforced by the prescription and a third refill
   *   is refused by the rule, without this pack having to know anybody's grade.
   *
   * ⚠️ AND A REFILL NOBODY AUTHORISED IS STILL REFUSED, because `refillsAllowed`
   *   is 0. Section 5.5.1 gives a General Practitioner thirty days and NO refill,
   *   which is exactly what an unendorsed prescription resolves to.
   *
   * ⚠️ THE REFILLABLE PSYCHOTROPICS ARE A NAMED LIST THIS PACK CANNOT SEE.
   *   Section 5.4.4 permits refills only for the products listed in Ministerial
   *   Decree 253 of 2020, which could not be retrieved. So this rule is WIDER
   *   than the standard for psychotropics — it allows an endorsed refill of any
   *   of them — and narrower than nothing, which was the alternative. Recorded
   *   in KNOWN_ISSUES.
   */
  ...[
    { key: 'CD', classification: AE_CLASSIFICATIONS.controlled, word: 'psychotropic' },
    { key: 'SCD', classification: AE_CLASSIFICATIONS.semiControlled, word: 'semi-controlled' },
  ].map(({ key, classification, word }) => ({
    code: `AZ-REFILL-${key}`,
    ruleType: 'REFILL_RULE',
    statement:
      `A ${word} medicinal product may be refilled only where the prescriber authorised it: a ` +
      'specialist may authorise one refill of thirty days and a consultant two, and a General ' +
      'Practitioner none. Do not dispense a refill before the end of the previous thirty days.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      refillsAllowed: 0,
      endorsedRepeatsPermitted: true,
      maxEndorsedRepeats: 2,
      validityDays: 3,
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      `Products, §§ ${key === 'CD' ? '5.4.4.1, 5.4.4.2, 5.4.4.3' : '5.5.1, 5.5.2, 5.5.3, 5.5.5'}`,
  })),

  /*
   * §5.1, §7.1–7.7 — the register, and the platform.
   *
   * ⚠️ `RECORD_IN_CONTROLLED_REGISTER` NAMES A REGISTER RCLN CANNOT BE, AGAIN.
   *   Section 3.6 defines three: PH 17 for psychotropic and semi-controlled
   *   products, PH 18 for wards, PH 20 for stores and pharmacies — all "issued
   *   by DOH against a fee", written by hand, with §7.3 forbidding erasure and
   *   requiring a corrected entry on the following line. Singapore's Misuse of
   *   Drugs Regulations reach the same place from the other direction by defining
   *   a register as "a bound book". The condition is correct; the artefact is
   *   paper, and a screen that renders it as a tick-box has recorded that
   *   somebody ticked a box.
   *
   * ⚠️ ALL THREE TIERS CARRY THE PLATFORM CONDITION. Section 5.1 names narcotics
   *   and psychotropics; §5.5.4 puts semi-controlled refills through the same
   *   system when a patient uses a different pharmacy. Raising it on all three is
   *   therefore a reading, and it errs towards asking the pharmacist to check
   *   something that is true rather than towards silence.
   */
  ...AZ_TIERS.map(({ key, classification, word }) => ({
    code: `AZ-SCHEDULE-${key}`,
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      `This is a ${word} medicinal product. Record it in its DOH register in brand and generic ` +
      'name, contemporaneously and in chronological order, and never by erasing or crossing out ' +
      'an earlier entry. The stock in the register must match the stock on the shelf.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: {
      scheduleName: `${word} medicinal product (Abu Dhabi)`,
      registerRequired: true,
      priorAuthorisationRequired: true,
      authorisationAuthority: UNIFIED_PLATFORM,
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 5.1, 7.1, 7.2, 7.3, 7.5, 7.7',
  })),

  /*
   * §6.1 and §6.2 — the cabinet.
   *
   * ⚠️ `controlledAccessRequired: true` FOR ALL THREE, AND NO `locationKinds`,
   *   WHICH IS THE CALL VICTORIA AND SINGAPORE BOTH MADE. Section 6.1 admits "an
   *   inpatient pharmacy setting OR A MEDICATION ROOM", so an allow-list naming
   *   `CONTROLLED_CABINET` would refuse a lawful DOH-approved medication room.
   *   What every limb does demand is a lock — double for a narcotic, single for
   *   the other two — and `requires_controlled_access` on the location is that
   *   fact.
   *
   * ⚠️ THE DOUBLE LOCK AND THE CCTV ARE IN `detail` AND ARE NOT CHECKED. Whether
   *   a cabinet has internal hinges, is bolted to the floor, or is covered by a
   *   camera is not a fact any software holds. Saying so is honest; asking
   *   somebody to tick it manufactures evidence of a check nobody did.
   */
  ...AZ_TIERS.map(({ key, classification, word }) => ({
    code: `AZ-STORE-${key}`,
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      `Keep ${word} medicinal products in a locked steel cabinet that the public cannot reach, ` +
      'in a pharmacy or a DOH-approved medication room, with CCTV covering it.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
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
          ? 'A steel cabinet with internal hinges and a DOUBLE locking system, fixed to a wall or ' +
            'floor or part of an immovable system, not accessible to the public, holding the ' +
            'products, the registers and the prescription forms. Stored outside the pharmacy, it ' +
            'must be a double-locked steel cabinet inside a secured medication room. CCTV must be ' +
            'installed and must clearly capture the secure area.'
          : 'A secure steel cabinet with a single locking system, separate from the narcotic ' +
            'cabinet, holding the products and their registers; outside the pharmacy, a single ' +
            'locked steel cabinet. Prescription forms must be kept in a secure cabinet the public ' +
            'cannot reach. CCTV must be installed.',
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      `Products, §§ ${key === 'NARCOTIC' ? '6.1.1, 6.1.2, 6.1.3, 6.1.4' : '6.2.1, 6.2.2, 6.2.3, 6.2.4'}`,
  })),

  /*
   * §7.4 — five years, or two.
   *
   * ⚠️ THE TWO PERIODS RUN FROM DIFFERENT EVENTS AND THE SECTION SAYS SO.
   *   Narcotic and psychotropic registers, invoices and prescription forms are
   *   kept "for a minimum of five years AFTER THE DATE OF THE LAST ENTRY";
   *   semi-controlled prescriptions "for at least two years FROM THE LAST DATE OF
   *   DISPENSING". `years` carries the number and the `detail` carries the event,
   *   because the framework has one integer and the standard has two clocks.
   */
  ...AZ_TIERS.map(({ key, classification, word, retentionYears }) => ({
    code: `AZ-RETAIN-${key}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      `Keep the ${word} register, its invoices and its prescription forms on site for at least ` +
      `${retentionYears === 5 ? 'five' : 'two'} years.`,
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: [],
    parameters: {
      years: retentionYears,
      detail:
        retentionYears === 5
          ? 'Five years after the date of the LAST ENTRY in the register, for the registers, the ' +
            'invoices and the prescription forms alike, kept on site. Both pharmacies must also ' +
            'keep contemporaneous specimen signatures of the physicians and nurses who order ' +
            'narcotic products.'
          : 'Two years from the LAST DATE OF DISPENSING, kept in the pharmacy.',
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 7.4, 7.6',
  })),

  /*
   * §4.6 — the returns to cdreport@doh.gov.ae.
   *
   * ⚠️ QUARTERLY FOR NARCOTICS AND MONTHLY FOR THE OTHER TWO, which is the one
   *   place the three tiers differ in cadence rather than in degree.
   */
  ...AZ_TIERS.map(({ key, classification, word, reportingCadence }) => ({
    code: `AZ-REPORT-${key}`,
    ruleType: 'REPORTING_REQUIREMENT',
    statement:
      `Report consumption of ${word} medicinal products to the Department of Health ` +
      `${reportingCadence === 'QUARTERLY' ? 'every quarter' : 'every month'}.`,
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      cadence: reportingCadence,
      recipient: 'the Department of Health Abu Dhabi, at cdreport@doh.gov.ae',
      detail:
        'Everything stored, prescribed, dispensed, administered, returned and disposed of, ' +
        'reconciled against the register. A discrepancy that cannot be reconciled by the end of ' +
        'the shift is reported to DOH on the Incident Report Form within 48 hours.',
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 4.6, 4.4.7, 10.1.1',
  })),

  /*
   * §8.7, §8.10, §8.11 — destruction, witnessed by the regulator.
   *
   * ⚠️ THE WITNESS IS A DOH AUDITOR AND NOT A COLLEAGUE, WHICH IS STRICTER THAN
   *   ANY PACK BEFORE IT. Victoria lets a second registered health practitioner
   *   witness a Schedule 8 destruction; Singapore requires an inspector;
   *   Abu Dhabi requires expired narcotics to go BACK to the Central Purchase
   *   Store and controlled and semi-controlled products to be destroyed with
   *   "DOH auditors will witness the destruction". So this condition cannot be
   *   discharged inside the facility at all.
   */
  ...AZ_TIERS.map(({ key, classification, word }) => ({
    code: `AZ-DISPOSE-${key}`,
    ruleType: 'DISPOSAL_REQUIREMENT',
    statement:
      key === 'NARCOTIC'
        ? 'An expired or unusable narcotic may not be destroyed here. Return it to the Abu Dhabi ' +
          'Central Purchase Store, having documented it in the register book.'
        : `An expired or unusable ${word} medicinal product is returned to the drug supplier it ` +
          'was bought from, or destroyed under DOH supervision with a DOH auditor witnessing it.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: ['DISPOSE'],
    parameters: {
      witnessRequired: true,
      method:
        key === 'NARCOTIC'
          ? 'Return to the Abu Dhabi Central Purchase Store for destruction. Empty ampoules are ' +
            'exchanged one for one and their disposal is written on the back of the narcotic ' +
            'prescription and signed by the person in charge and a witness.'
          : 'Return to the supplying drug store, or destruction by the agent under the ' +
            'supervision of the DOH audit and inspection team, which must be informed at ' +
            'cdreport@doh.gov.ae beforehand and will witness it.',
      detail:
        'Separate the stock requiring disposal from the active stock, document it in the register ' +
        'book, and notify DOH before anything is destroyed.',
    },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      'Products, §§ 4.7, 4.8, 8.3, 8.7, 8.10, 8.11',
  })),

  /*
   * §11 — the branch-to-branch transfer, and the rule most likely to bite a
   * real rcln tenant.
   *
   * ⚠️ THIS IS AN `IMPORT_RESTRICTION` ROW THAT SAYS NOTHING ABOUT IMPORTS, AND
   *   IT IS THE SECOND TIME THIS PROGRAMME HAS REACHED FOR A RULE TYPE BECAUSE
   *   ITS HANDLER DOES THE RIGHT THING (Singapore's `SG-SUPPLY-CD4` was the
   *   first). `evaluateImportRestriction` refuses when `permitted` is not true
   *   and the transaction is a `STOCK` or a `TRANSFER`, and
   *   `appliesToTransactions: ['TRANSFER']` narrows it to the second — so goods
   *   receipt from the Central Purchase Store is untouched and a transfer is
   *   refused. The OUTCOME is exactly §11; the rule type's NAME is wrong, and a
   *   `permitted: false` transaction rule is what the framework is missing.
   *   Recorded in KNOWN_ISSUES.
   *
   * ⚠️ AND IT MATTERS BECAUSE RCLN IS MULTI-BRANCH BY DESIGN. An organization
   *   with a clinic in Khalifa City and another in Al Ain holds two DOH-licensed
   *   facilities, and moving a narcotic between them is what §11.1 calls
   *   "strictly prohibited". Nothing else in this platform would have stopped it:
   *   a stock transfer between two branches of one tenant is the most ordinary
   *   movement there is.
   *
   * ⚠️ THE SEMI-CONTROLLED AND PSYCHOTROPIC CASE IS REFUSED THOUGH §11.2 PERMITS
   *   IT WITH PRIOR DOH APPROVAL. The approval is a letter in somebody's file
   *   that rcln cannot see, and there is no "permitted once an authorisation
   *   exists" shape on a transaction rule — `VERIFY_PRIOR_AUTHORISATION` hangs
   *   off `CONTROLLED_SCHEDULE`, which permits. Refusing is the safe direction
   *   and the statement says what to do about it.
   */
  ...AZ_TIERS.map(({ key, classification, word }) => ({
    code: `AZ-TRANSFER-${key}`,
    ruleType: 'IMPORT_RESTRICTION',
    statement:
      key === 'NARCOTIC'
        ? 'Narcotics may not be transferred between facilities, including between two branches of ' +
          'the same owner. Return them to the Central Purchase Store instead.'
        : `Transferring ${word} medicinal products between facilities is not permitted without ` +
          'prior written approval from the Department of Health. Obtain the approval, then record ' +
          'the movement outside this system.',
    sourceKey: 'AE_AZ_NARCOTICS_STANDARD',
    appliesToClassification: classification,
    appliesToTransactions: ['TRANSFER'],
    parameters: { permitted: false },
    citation:
      'DOH Standard for the Management of Narcotics, Psychotropic and Semi-Controlled Medicinal ' +
      `Products, § ${key === 'NARCOTIC' ? '11.1' : '11.2'}`,
  })),
];
