/**
 * UNITED STATES — federal rule pack 1.0.0. The second jurisdiction configured,
 * and the first with a sub-national pack beside it (`regulatory-us-ca.ts`).
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. This is a configuration of published
 *   rules, read from the regulator's own documents and cited row by row. It has
 *   not been reviewed by a qualified person, the pack's maturity says so, and
 *   every screen that shows it carries a banner. Silence must never imply
 *   compliance — see REGULATORY_RULE_PACKS.md.
 *
 * ── WHERE EVERY RULE BELOW CAME FROM ─────────────────────────────────────────
 * Five primary documents, all read directly rather than summarised:
 *
 *   21 CFR parts 1301, 1304 and 1306 — DEA's registration, recordkeeping and
 *   prescription rules — retrieved as XML from eCFR's own versioner API at the
 *   2025-01-01 edition, so the text is the government's rather than a render of
 *   it. Part 1306 is the spine of this pack.
 *
 *   21 U.S.C. 829 and 353 — the Controlled Substances Act's prescription section
 *   and the Federal Food, Drug, and Cosmetic Act's § 503 — from govinfo, which
 *   is GPO's own publication of the Code.
 *
 *   21 CFR 201.105 — the veterinary caution statement.
 *
 * ⚠️ THE STATUTE AND THE REGULATION SAY THE SAME THING TWICE, AND EACH RULE
 *   CITES THE ONE IT WAS READ FROM. 829(a) and 1306.12(a) both forbid refilling
 *   a Schedule II prescription; 829(b) and 1306.22(a) both give Schedule III/IV
 *   five refills in six months. Where a rule is a reading of the REGULATION it
 *   cites the CFR, because that is the text with the operative detail. Nothing
 *   is cited to both, because a rule with two sources is a rule whose supersession
 *   nobody can reason about.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO PSEUDOEPHEDRINE RULES, AND THIS IS THE MOST CONSIDERED OMISSION IN THE
 *   FILE. 21 U.S.C. 830(d)(1) caps retail sales at "a daily amount of 3.6 grams"
 *   of ephedrine, pseudoephedrine or phenylpropanolamine BASE. The limit is on a
 *   quantity of a chemical CONTAINED IN the product, and the product's base unit
 *   is tablets — so answering it needs the composition and the strength, and
 *   arithmetic across both. `maxPerTransactionBase: "3.6"` against a product
 *   measured in tablets would be badly and invisibly wrong.
 *
 *   The statute is recorded as a source with a note and cited by no rule, which
 *   is the same call PI-6 made about India's G.S.R. 588(E). See survey GAP 4 in
 *   COUNTRY_RULE_PACK_SURVEY.md; it needs a phase of its own.
 *
 * ⚠️ NO DSCSA TRACEABILITY RULES. 21 U.S.C. 360eee-1 imposes real product-tracing
 *   obligations on dispensers, and it could not be retrieved from any primary
 *   source reachable here — govinfo returned a 404 for every granule path tried.
 *   No source, no rule. The matrix cell stays `RESEARCH_REQUIRED`, and a
 *   reviewer with access should write these.
 *
 * ⚠️ NO SUBSTITUTION RULE, AND ITS ABSENCE IS THE POINT. Generic substitution is
 *   not federally regulated in the United States — it is entirely a creature of
 *   state pharmacy law, which is why `regulatory-us-ca.ts` carries one and this
 *   file does not. A federal `permitted: true` would assert an authorisation no
 *   federal instrument grants, and `permitted: false` a prohibition none imposes.
 *
 * ⚠️ NO SCHEDULE V REFILL RULE. 21 U.S.C. 829(b) and 21 CFR 1306.22 reach
 *   Schedules III and IV only. Schedule V refills are left to the states, and
 *   writing a federal five-refill rule for Schedule V by analogy would be
 *   inventing law out of symmetry.
 *
 * ⚠️ NO PRESCRIPTION VALIDITY FOR SCHEDULE II OR FOR NON-CONTROLLED LEGEND
 *   DRUGS. Federal law states none for either. The six-month figure below
 *   belongs to Schedules III and IV alone, and copying it across would refuse
 *   lawful dispenses on the strength of a rule nobody enacted.
 *
 * ── THE ONE PLACE THIS PACK IS LOOSER THAN INDIA'S, ON PURPOSE ───────────────
 * ⚠️ CONTROLLED SUBSTANCES CARRY NO `storageLocationKinds` HERE, AND THAT IS
 *   READ OFF THE RULE RATHER THAN FORGOTTEN. 21 CFR 1301.75(b) requires a
 *   "securely locked, substantially constructed cabinet" — and then expressly
 *   permits pharmacies to "disperse such substances throughout the stock of
 *   noncontrolled substances in such a manner as to obstruct the theft or
 *   diversion". Both arrangements are lawful. `storageLocationKinds` on a
 *   `CONTROLLED_SCHEDULE` rule REFUSES a receipt into any other kind of place,
 *   so writing one would refuse the dispersal the regulation permits by name.
 *   India's Schedule X has no such alternative, which is why its pack does the
 *   opposite. The obligation is carried as a `STORAGE_REQUIREMENT` instead.
 *
 * ── HOW TO CHANGE A RULE ─────────────────────────────────────────────────────
 * You do not edit one. A change is a NEW row with a new `version` and a new
 * `effectiveFrom`, and the old one gets an `effectiveTo` and `SUPERSEDED`
 * (PI-ADR-008).
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/**
 * The day this pack becomes evaluable.
 *
 * ⚠️ NOT THE DAY ANY OF THESE LAWS CAME INTO FORCE. The Controlled Substances
 *   Act dates from 1970 and part 1306 from 1971. `effective_from` answers "from
 *   when does rcln act on this?"; the law's own dates live on the SOURCE rows.
 */
export const US_PACK_EFFECTIVE_FROM = '2026-08-19';

// ---------------------------------------------------------------------------
// Authorities
// ---------------------------------------------------------------------------

export const US_AUTHORITIES = [
  {
    code: 'DEA',
    name: 'Drug Enforcement Administration',
    websiteUrl: 'https://www.deadiversion.usdoj.gov/',
    remit:
      'The United States’ controlled-substances regulator, within the Department of Justice. ' +
      'Administers the Controlled Substances Act, 1970 and 21 CFR chapter II — registration, ' +
      'recordkeeping, prescriptions and physical security.',
  },
  {
    code: 'FDA',
    name: 'Food and Drug Administration',
    websiteUrl: 'https://www.fda.gov/',
    remit:
      'The United States’ medicines regulator, within the Department of Health and Human ' +
      'Services. Administers the Federal Food, Drug, and Cosmetic Act, 1938 — including § 503(b), ' +
      'which is what makes a drug prescription-only, and § 503(f) for veterinary drugs.',
  },
] as const;

// ---------------------------------------------------------------------------
// Sources — the registry every rule below must cite to exist
// ---------------------------------------------------------------------------

export const US_SOURCES: SourceSeed[] = [
  {
    key: 'US_CFR_1306',
    authorityCode: 'DEA',
    title: '21 CFR Part 1306 — Prescriptions',
    documentReference:
      '21 CFR §§ 1306.03, 1306.06, 1306.11, 1306.12, 1306.14, 1306.21, 1306.22, 1306.24, 1306.26',
    sourceUrl: 'https://www.ecfr.gov/current/title-21/chapter-II/subchapter-A/part-1306',
    version: 'eCFR edition of 2025-01-01',
    publishedOn: '1971-04-24',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Retrieved as XML from eCFR’s versioner API (/api/versioner/v1/full/2025-01-01/title-21.xml' +
      '?chapter=II&subchapter=A&part=1306), so the text read was the government’s own rather than ' +
      'a rendering of it. Every clause cited by a rule below was read in full. UNVERIFIED means ' +
      'no qualified person has confirmed the READING — not that the document is in doubt.',
  },
  {
    key: 'US_CFR_1304',
    authorityCode: 'DEA',
    title: '21 CFR Part 1304 — Records and Reports of Registrants',
    documentReference: '21 CFR §§ 1304.03, 1304.04',
    sourceUrl: 'https://www.ecfr.gov/current/title-21/chapter-II/subchapter-A/part-1304',
    version: 'eCFR edition of 2025-01-01',
    publishedOn: '1971-04-24',
    reviewStatus: 'UNVERIFIED',
    notes:
      '§ 1304.04(a) is the two-year retention period this pack configures. Retrieved as XML from ' +
      'eCFR’s versioner API and read directly.',
  },
  {
    key: 'US_CFR_1301',
    authorityCode: 'DEA',
    title: '21 CFR Part 1301 — Registration of Manufacturers, Distributors, and Dispensers',
    documentReference: '21 CFR § 1301.75 (physical security controls for practitioners)',
    sourceUrl: 'https://www.ecfr.gov/current/title-21/chapter-II/subchapter-A/part-1301',
    version: 'eCFR edition of 2025-01-01',
    publishedOn: '1974-01-29',
    reviewStatus: 'UNVERIFIED',
    notes:
      '§ 1301.75(b) requires a securely locked, substantially constructed cabinet AND expressly ' +
      'permits a pharmacy to disperse controlled substances through its ordinary stock instead. ' +
      'Both limbs were read; see the file header for why no location restriction follows.',
  },
  {
    key: 'US_CSA_829',
    authorityCode: 'DEA',
    title: 'Controlled Substances Act § 309 — Prescriptions (21 U.S.C. 829)',
    documentReference: '21 U.S.C. § 829(a), (b), (e)',
    sourceUrl:
      'https://www.govinfo.gov/content/pkg/USCODE-2023-title21/html/USCODE-2023-title21-chap13-subchapI-partC-sec829.htm',
    version: 'United States Code, 2023 Edition',
    publishedOn: '1970-10-27',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From govinfo, the Government Publishing Office’s own publication of the Code. § 829(e) — ' +
      'the Ryan Haight provision, added by Pub. L. 110–425 in 2008 — is the source of the ' +
      'in-person evaluation requirement on remote supply, and was read in full.',
  },
  {
    key: 'US_FDCA_353',
    authorityCode: 'FDA',
    title: 'Federal Food, Drug, and Cosmetic Act § 503 (21 U.S.C. 353)',
    documentReference: '21 U.S.C. § 353(b)(1), (b)(2), (b)(4)(A)',
    sourceUrl:
      'https://www.govinfo.gov/content/pkg/USCODE-2023-title21/html/USCODE-2023-title21-chap9-subchapV-partA-sec353.htm',
    version: 'United States Code, 2023 Edition',
    publishedOn: '1938-06-25',
    reviewStatus: 'UNVERIFIED',
    notes:
      '§ 503(b)(1) is what makes a drug prescription-only in the United States — the "legend ' +
      'drug". § 503(b)(2) is the dispensing-label content. § 503(b)(4)(A) is the "Rx only" ' +
      'symbol. All read in full from govinfo.',
  },
  {
    key: 'US_CFR_201_105',
    authorityCode: 'FDA',
    title: '21 CFR § 201.105 — Veterinary drugs',
    documentReference: '21 CFR § 201.105(b)(1)',
    sourceUrl: 'https://www.ecfr.gov/current/title-21/section-201.105',
    version: 'eCFR edition of 2025-01-01',
    publishedOn: '1975-04-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'The federal veterinary caution statement. ⚠️ eCFR carries a notice that an amendment was ' +
      'published at 89 FR 51768 (18 June 2024) which the 2025-01-01 edition read here may not ' +
      'reflect in full. A reviewer should check the caution wording against the amendment.',
  },
  {
    key: 'US_CSA_830',
    authorityCode: 'DEA',
    title: 'Controlled Substances Act § 310 — Regulation of listed chemicals (21 U.S.C. 830)',
    documentReference: '21 U.S.C. § 830(d)(1), (e)(1)',
    sourceUrl:
      'https://www.govinfo.gov/content/pkg/USCODE-2023-title21/html/USCODE-2023-title21-chap13-subchapI-partC-sec830.htm',
    version: 'United States Code, 2023 Edition',
    publishedOn: '1970-10-27',
    reviewStatus: 'UNVERIFIED',
    notes:
      '⚠️ RECORDED BUT CITED BY NO RULE, DELIBERATELY. § 830(d)(1) caps retail sales at 3.6 g of ' +
      'ephedrine/pseudoephedrine/phenylpropanolamine BASE per purchaser per day, and § 830(e) ' +
      'adds behind-the-counter placement, photo ID and a logbook. The quantity is denominated in ' +
      'a chemical CONTAINED IN the product while the product’s base unit is tablets, and this ' +
      'platform does no composition arithmetic — so the rules cannot be written honestly yet. ' +
      'Recorded so the research is not repeated. See COUNTRY_RULE_PACK_SURVEY.md, GAP 4.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The classification strings this pack is written against.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`, AND
 *   NOT PARSED, CASE-FOLDED OR TRIMMED. A clinic that records "Schedule II"
 *   instead of `SCHEDULE_II` has a product no rule in this pack matches — which
 *   resolves `UNDETERMINED` and refuses rather than silently permitting, but it
 *   still looks to that clinic like the platform is broken.
 *
 * ⚠️ `PRESCRIPTION_ONLY` IS THE NON-CONTROLLED LEGEND DRUG AND IS NOT A DEA
 *   SCHEDULE. Most prescription medicines in the United States are this: § 503(b)
 *   makes them prescription-only, and no schedule applies. A clinic that files
 *   an ordinary antibiotic under a schedule gets the controlled-substance rules
 *   applied to it, which refuses far more than the law does.
 *
 * ⚠️ THE TWO `EXEMPT_NARCOTIC_OTC` VALUES ARE SPLIT BY OPIUM CONTENT BECAUSE
 *   21 CFR 1306.26(b) SETS TWO DIFFERENT CEILINGS, and this platform cannot tell
 *   them apart from the composition. Collapsing them into one would either
 *   refuse lawful opium-containing sales at the lower ceiling or permit
 *   unlawful ones at the higher.
 */
export const US_CLASSIFICATIONS = {
  scheduleII: 'SCHEDULE_II',
  scheduleIII: 'SCHEDULE_III',
  scheduleIV: 'SCHEDULE_IV',
  scheduleV: 'SCHEDULE_V',
  prescriptionOnly: 'PRESCRIPTION_ONLY',
  veterinaryPrescription: 'VETERINARY_PRESCRIPTION',
  exemptNarcoticOtc: 'EXEMPT_NARCOTIC_OTC',
  exemptNarcoticOtcOpium: 'EXEMPT_NARCOTIC_OTC_OPIUM',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/** The four DEA schedules this pack configures. Schedule I is not dispensable. */
const SCHEDULES = [
  US_CLASSIFICATIONS.scheduleII,
  US_CLASSIFICATIONS.scheduleIII,
  US_CLASSIFICATIONS.scheduleIV,
  US_CLASSIFICATIONS.scheduleV,
];

/** `SCHEDULE_III` → `SCH-III`, for a rule code. */
function suffix(classification: string): string {
  return classification.replace('SCHEDULE_', 'SCH-');
}

/** `SCHEDULE_III` → `Schedule III`, for a sentence. */
function spoken(classification: string): string {
  return classification.replace('SCHEDULE_', 'Schedule ');
}

/**
 * 21 CFR 1306.11(a) and 1306.21(a) — a controlled substance that is a
 * prescription drug is dispensed only on a prescription.
 *
 * ⚠️ THE VALIDITY IS ON SCHEDULES III AND IV ALONE, AND IT IS STATED IN MONTHS.
 *   21 U.S.C. 829(b): "Such prescriptions may not be filled or refilled more
 *   than six months after the date thereof." Six months is not 180 days — a
 *   script written 1 January is lawful on 1 July, which is 181 — so this uses
 *   `validityMonths`, added in PI-13a for exactly this sentence. Schedule II and
 *   Schedule V have no federal validity period and get none here.
 */
const prescriptionRules: RuleSeed[] = SCHEDULES.map((classification) => {
  const monthsApply =
    classification === US_CLASSIFICATIONS.scheduleIII ||
    classification === US_CLASSIFICATIONS.scheduleIV;

  return {
    code: `US-RX-${suffix(classification)}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `A ${spoken(classification)} controlled substance may be dispensed only on the ` +
      'prescription of a practitioner. Obtain the prescription before supplying this.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: monthsApply ? { required: true, validityMonths: 6 } : { required: true },
    citation:
      classification === US_CLASSIFICATIONS.scheduleII
        ? '21 CFR 1306.11(a)'
        : '21 CFR 1306.21(a); 21 U.S.C. 829(b) for the six-month validity',
  };
});

/**
 * 21 CFR 1306.03(a) — "A prescription for a controlled substance may be issued
 * only by an individual practitioner who is (1) authorized to prescribe
 * controlled substances by the jurisdiction in which he is licensed to practice
 * his profession and (2) either registered or exempted from registration."
 *
 * ⚠️ THIS RULE REFUSES UNTIL THE CALLER SUPPLIES THE PRESCRIBER'S REGISTRATION
 *   CLASS, AND THAT IS THE INTENDED BEHAVIOUR RATHER THAN A DEFECT.
 *   `evaluatePrescriberAuthority` answers `UNDETERMINED` — which refuses — when
 *   `prescription.prescriberClasses` is absent. India's pack carries no rule of
 *   this type, so this is the first place the programme meets that cost.
 *
 *   It is worth paying here. Dispensing a Schedule II drug without establishing
 *   that the prescriber holds a DEA registration is the single failure US
 *   enforcement is most concerned with, and a platform that permits it because
 *   nobody passed a field has not checked anything. The remedy is for the
 *   dispensing service to supply the class, not for the rule to be softened.
 */
const prescriberRules: RuleSeed[] = SCHEDULES.map((classification) => ({
  code: `US-PRESCRIBER-${suffix(classification)}`,
  ruleType: 'PRESCRIBER_AUTHORITY',
  statement:
    `A ${spoken(classification)} controlled substance may be prescribed only by a practitioner ` +
    'authorised to prescribe in the state where they are licensed and registered with the DEA, ' +
    'or exempt from registration. Confirm the prescriber’s registration before supplying.',
  sourceKey: 'US_CFR_1306',
  appliesToClassification: classification,
  appliesToTransactions: SUPPLY_TO_PATIENT,
  parameters: {
    permittedPrescriberClasses: ['DEA_REGISTERED_PRACTITIONER', 'DEA_EXEMPT_PRACTITIONER'],
  },
  citation: '21 CFR 1306.03(a)',
}));

/**
 * Refills.
 *
 * ⚠️ SCHEDULE II IS A FLAT PROHIBITION AND CARRIES NO `endorsedRepeatsPermitted`,
 *   WHICH IS THE DELIBERATE CONTRAST WITH INDIA. 21 CFR 1306.12(a) is four
 *   words long — "The refilling of a prescription for a controlled substance
 *   listed in Schedule II is prohibited" — and offers the prescriber no way to
 *   authorise one. India's rule 65(11) does offer exactly that, which is why its
 *   pack opts in and this one must not: the key is absent, absent means no, and
 *   a prescriber's endorsement changes nothing here.
 *
 * ⚠️ THE 90-DAY MULTIPLE-PRESCRIPTION PROVISION IS NOT A REFILL AND IS NOT
 *   MODELLED. 21 CFR 1306.12(b) lets a practitioner issue several Schedule II
 *   prescriptions totalling up to a 90-day supply, each with the earliest date
 *   it may be filled written on it. Those are separate prescriptions, not
 *   repeats of one — and the "earliest fill date" is a fact about a document
 *   this platform does not hold. Writing it as a refill allowance would permit
 *   exactly what 1306.12(a) forbids.
 */
const refillRules: RuleSeed[] = [
  {
    code: 'US-REPEAT-SCH-II',
    ruleType: 'REFILL_RULE',
    statement:
      'A Schedule II prescription may not be refilled, in any circumstances. A further supply ' +
      'needs a new prescription.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: US_CLASSIFICATIONS.scheduleII,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { refillsAllowed: 0 },
    citation: '21 CFR 1306.12(a); 21 U.S.C. 829(a)',
  },
  ...[US_CLASSIFICATIONS.scheduleIII, US_CLASSIFICATIONS.scheduleIV].map((classification) => ({
    code: `US-REPEAT-${suffix(classification)}`,
    ruleType: 'REFILL_RULE',
    statement:
      `A ${spoken(classification)} prescription may be refilled at most five times, and not at ` +
      'all more than six months after it was written. Beyond either, the prescriber must write a ' +
      'new prescription.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { refillsAllowed: 5, validityMonths: 6 },
    citation: '21 CFR 1306.22(a); 21 U.S.C. 829(b)',
  })),
];

/**
 * 21 CFR 1306.14(a) and 1306.24(a) — what goes on the label of a dispensed
 * controlled substance. The two sections differ in one field, and the difference
 * is preserved rather than smoothed over: Schedule II says "date of filling",
 * Schedules III–V say "date of initial filling", which is the date the refill
 * series began.
 */
const labelFieldsScheduleII = [
  'DATE_OF_FILLING',
  'PHARMACY_NAME',
  'PHARMACY_ADDRESS',
  'PRESCRIPTION_SERIAL_NUMBER',
  'PATIENT_NAME',
  'PRESCRIBER_NAME',
  'DIRECTIONS_FOR_USE',
  'CAUTIONARY_STATEMENTS',
];

const labellingRules: RuleSeed[] = [
  {
    code: 'US-LABEL-SCH-II',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Label the package with the date of filling, the pharmacy’s name and address, the ' +
      'prescription serial number, the patient’s name, the prescriber’s name, and the directions ' +
      'for use and any cautionary statements.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: US_CLASSIFICATIONS.scheduleII,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      fields: labelFieldsScheduleII,
      detail:
        'Date of filling, pharmacy name and address, the serial number of the prescription, the ' +
        'patient’s name, the prescribing practitioner’s name, and directions for use with any ' +
        'cautionary statements the prescription carries or the law requires.',
    },
    citation: '21 CFR 1306.14(a)',
  },
  ...[
    US_CLASSIFICATIONS.scheduleIII,
    US_CLASSIFICATIONS.scheduleIV,
    US_CLASSIFICATIONS.scheduleV,
  ].map((classification) => ({
    code: `US-LABEL-${suffix(classification)}`,
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Label the package with the pharmacy’s name and address, the prescription serial number and ' +
      'the date of the INITIAL filling, the patient’s name, the prescriber’s name, and the ' +
      'directions for use and any cautionary statements.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      fields: [
        'PHARMACY_NAME',
        'PHARMACY_ADDRESS',
        'PRESCRIPTION_SERIAL_NUMBER',
        'DATE_OF_INITIAL_FILLING',
        'PATIENT_NAME',
        'PRESCRIBER_NAME',
        'DIRECTIONS_FOR_USE',
        'CAUTIONARY_STATEMENTS',
      ],
      detail:
        'Pharmacy name and address, the serial number and the date of the initial filling — not ' +
        'of this refill — the patient’s name, the practitioner’s name, and directions for use ' +
        'with any cautionary statements.',
    },
    citation: '21 CFR 1306.24(a)',
  })),

  /*
   * FDCA § 503(b)(2) — the label that exempts a dispensed drug from the ordinary
   * misbranding requirements. It reaches EVERY prescription drug, controlled or
   * not, which is why it is keyed to the legend classification: the controlled
   * schedules already have their own, more specific, rules above.
   */
  {
    code: 'US-LABEL-LEGEND',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Label the package with the dispenser’s name and address, the prescription serial number ' +
      'and the date of the prescription or its filling, the prescriber’s name, the patient’s name ' +
      'where the prescription states it, and the directions for use and any cautionary statements.',
    sourceKey: 'US_FDCA_353',
    appliesToClassification: US_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      fields: [
        'DISPENSER_NAME',
        'DISPENSER_ADDRESS',
        'PRESCRIPTION_SERIAL_NUMBER',
        'PRESCRIPTION_DATE',
        'PRESCRIBER_NAME',
        'PATIENT_NAME',
        'DIRECTIONS_FOR_USE',
        'CAUTIONARY_STATEMENTS',
      ],
      detail:
        'Name and address of the dispenser, the serial number and date of the prescription or of ' +
        'its filling, the prescriber’s name, the patient’s name if the prescription states it, ' +
        'and the directions for use with any cautionary statements.',
    },
    citation: '21 U.S.C. 353(b)(2)',
  },

  /*
   * 21 CFR 201.105(b)(1) — the federal veterinary caution.
   *
   * ⚠️ NARROWED BY PRODUCT TYPE RATHER THAN BY CLASSIFICATION, SO IT WORKS
   *   WITHOUT A PROFILE — the same call India's veterinary rule makes, for the
   *   same reason. A veterinary medicine is one whatever any clinic has recorded
   *   about it.
   */
  {
    code: 'US-LABEL-VETERINARY',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'A veterinary medicine must be labelled “Caution: Federal law restricts this drug to use by ' +
      'or on the order of a licensed veterinarian.”',
    sourceKey: 'US_CFR_201_105',
    appliesToProductType: 'VETERINARY_MEDICINE',
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK'],
    parameters: {
      fields: ['CAUTION_FEDERAL_LAW_VETERINARY'],
      detail:
        'The statement “Caution: Federal law restricts this drug to use by or on the order of a ' +
        'licensed veterinarian.” must appear on the label.',
    },
    citation: '21 CFR 201.105(b)(1)',
  },
];

/**
 * 21 U.S.C. 829(e) — the Ryan Haight provision.
 *
 * "No controlled substance that is a prescription drug … may be delivered,
 * distributed, or dispensed by means of the Internet without a valid
 * prescription", where a valid prescription is one issued by a practitioner who
 * "has conducted at least 1 in-person medical evaluation of the patient", or by
 * a covering practitioner.
 *
 * ⚠️ `permitted: true` ALONE WOULD ASSERT THE OPPOSITE OF THE SECTION, WHICH IS
 *   WHY PI-13a EXISTS. The section does not authorise internet supply; it
 *   forbids it except on a prescription with a particular history. Before
 *   `requiresPriorInPersonEvaluation` the closest expressible rule returned a
 *   bare `PERMITTED` with the proviso — the whole content of the section —
 *   silently dropped. It now raises a `VERIFY_PRIOR_IN_PERSON_EVALUATION`
 *   condition, which the engine cannot check and does not pretend to.
 *
 * ⚠️ NO RULE FOR NON-CONTROLLED PRESCRIPTION DRUGS. 829(e) reaches controlled
 *   substances only, and no federal instrument prohibits the remote supply of an
 *   ordinary legend drug. Writing `permitted: false` for `PRESCRIPTION_ONLY`
 *   would invent a federal prohibition; state law is where that question lives.
 */
const onlineRules: RuleSeed[] = SCHEDULES.map((classification) => ({
  code: `US-ONLINE-${suffix(classification)}`,
  ruleType: 'ONLINE_DISPENSING',
  statement:
    `A ${spoken(classification)} controlled substance may be supplied over the internet only on a ` +
    'prescription from a practitioner who has already examined this patient in person, or from a ' +
    'covering practitioner.',
  sourceKey: 'US_CSA_829',
  appliesToClassification: classification,
  appliesToTransactions: ['ONLINE_DISPENSE'],
  parameters: { permitted: true, requiresPriorInPersonEvaluation: true },
  citation: '21 U.S.C. 829(e)',
}));

/**
 * 21 CFR 1304.03 and 1304.04(f)–(g) — the registrant's controlled-substance
 * records, kept separately from everything else.
 *
 * ⚠️ NO `storageLocationKinds`, FOR THE REASON IN THE FILE HEADER. 1301.75(b)
 *   permits dispersal through ordinary stock, so a location restriction here
 *   would refuse a lawful pharmacy.
 */
const controlledScheduleRules: RuleSeed[] = SCHEDULES.map((classification) => ({
  code: `US-CD-${suffix(classification)}`,
  ruleType: 'CONTROLLED_SCHEDULE',
  statement:
    `Record this ${spoken(classification)} transaction in the controlled-substance records, kept ` +
    'separately from the pharmacy’s other records or in a form from which they are readily ' +
    'retrievable.',
  sourceKey: 'US_CFR_1304',
  appliesToClassification: classification,
  appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'DISPOSE'],
  parameters: { scheduleName: spoken(classification), registerRequired: true },
  citation: '21 CFR 1304.03; 1304.04(f)–(g)',
}));

/** 21 CFR 1304.04(a) — two years, for every controlled-substance record. */
const retentionRules: RuleSeed[] = SCHEDULES.map((classification) => ({
  code: `US-RETAIN-${suffix(classification)}`,
  ruleType: 'RECORD_RETENTION',
  statement:
    'Keep every inventory and record for this controlled substance for at least two years, ' +
    'available for inspection and copying by the DEA.',
  sourceKey: 'US_CFR_1304',
  appliesToClassification: classification,
  appliesToTransactions: [],
  parameters: {
    years: 2,
    detail:
      'At least two years from the date of the inventory or record, available for inspection and ' +
      'copying by authorised employees of the Drug Enforcement Administration.',
  },
  citation: '21 CFR 1304.04(a)',
}));

export const US_RULES: RuleSeed[] = [
  ...prescriptionRules,
  ...prescriberRules,
  ...refillRules,
  ...labellingRules,
  ...onlineRules,
  ...controlledScheduleRules,
  ...retentionRules,

  /*
   * 21 CFR 1306.06 — "A prescription for a controlled substance may only be
   * filled by a pharmacist, acting in the usual course of his professional
   * practice and either registered individually or employed in a registered
   * pharmacy, a registered central fill pharmacy, or registered institutional
   * practitioner."
   *
   * ⚠️ NO `exemptWhenActorIsPrescriber`, AND ITS ABSENCE IS RESEARCHED RATHER
   *   THAN FORGOTTEN — the deliberate contrast with India's Pharmacy Act rule.
   *   Section 42(1) of that Act carves out "the dispensing by a medical
   *   practitioner of medicine for his own patients" IN THE SECTION ITSELF.
   *   1306.06 contains no such proviso: filling a prescription is a pharmacist's
   *   act in the United States whoever wrote it.
   *
   *   What 1306.11(b) and 1306.21(b) DO allow is an individual practitioner
   *   administering or dispensing directly WITHOUT a prescription in the course
   *   of their practice. That is a different transaction, not an exemption from
   *   this one, and reading it as one would let any prescriber fill their own
   *   prescriptions.
   *
   * ⚠️ A LICENCE TYPE, NOT A ROLE CODE. "Pharmacist" here is a state licensure,
   *   not the rcln role a clinic may rename tomorrow — see `RegulatoryActor`.
   */
  {
    code: 'US-DISPENSER-PHARMACIST',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A prescription for a controlled substance may be filled only by a pharmacist acting in the ' +
      'usual course of professional practice. Hand this to a licensed pharmacist.',
    sourceKey: 'US_CFR_1306',
    appliesToTransactions: ['DISPENSE', 'ONLINE_DISPENSE'],
    parameters: { permittedLicenceTypes: ['LICENSED_PHARMACIST'] },
    citation: '21 CFR 1306.06',
  },

  /*
   * 21 CFR 1301.75(b) — the storage obligation, carried as an obligation rather
   * than as a location restriction. Both lawful arrangements are named in the
   * detail, because a pharmacist reading only the first would think the second
   * was forbidden.
   */
  {
    code: 'US-STORE-CONTROLLED',
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      'Keep controlled substances in a securely locked, substantially constructed cabinet — or, ' +
      'in a pharmacy, dispersed through the ordinary stock so as to obstruct theft or diversion.',
    sourceKey: 'US_CFR_1301',
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
      detail:
        'A securely locked, substantially constructed cabinet. A pharmacy may instead disperse ' +
        'controlled substances throughout the stock of non-controlled substances in a manner that ' +
        'obstructs theft or diversion — 1301.75(b) permits either.',
    },
    citation: '21 CFR 1301.75(b)',
  },

  /*
   * 21 CFR 1306.26 — a controlled substance that is NOT a prescription drug,
   * sold over the counter by a pharmacist. The exempt narcotic preparations.
   *
   * ⚠️ THE VOLUMETRIC LIMITS OF 1306.26(b) ARE NOT WRITTEN. The section caps
   *   "240 cc. (8 ounces) of any such controlled substance containing opium, nor
   *   more than 120 cc. (4 ounces) of any other" alongside the dosage-unit caps
   *   configured below. A volume limit cannot be checked against a product whose
   *   base unit is a dosage unit, and this platform does not know which a given
   *   product is measured in at rule-authoring time. The dosage-unit limbs are
   *   written; the volumetric limbs are not, and a liquid exempt narcotic is
   *   therefore under-constrained by this pack. Said plainly rather than
   *   approximated.
   */
  ...[
    { classification: US_CLASSIFICATIONS.exemptNarcoticOtc, units: '24.000000', kind: 'other' },
    {
      classification: US_CLASSIFICATIONS.exemptNarcoticOtcOpium,
      units: '48.000000',
      kind: 'opium-containing',
    },
  ].map(({ classification, units, kind }) => ({
    code: `US-QTY-${classification.replace('EXEMPT_NARCOTIC_OTC', 'EXEMPT')}`,
    ruleType: 'QUANTITY_LIMIT',
    statement:
      `No more than ${units.split('.')[0]} dosage units of an ${kind} exempt controlled ` +
      'substance may be sold to the same purchaser in any 48-hour period.',
    sourceKey: 'US_CFR_1306',
    appliesToClassification: classification,
    appliesToTransactions: ['COUNTER_SALE'],
    parameters: { maxPerPeriodBase: units, periodDays: 2 },
    citation: '21 CFR 1306.26(b)',
  })),

  ...[US_CLASSIFICATIONS.exemptNarcoticOtc, US_CLASSIFICATIONS.exemptNarcoticOtcOpium].map(
    (classification) => ({
      code: `US-AGE-${classification.replace('EXEMPT_NARCOTIC_OTC', 'EXEMPT')}`,
      ruleType: 'AGE_RESTRICTION',
      statement:
        'This may be sold over the counter only to a purchaser aged 18 or over, and the pharmacist ' +
        'must see suitable identification from any purchaser they do not know.',
      sourceKey: 'US_CFR_1306',
      appliesToClassification: classification,
      appliesToTransactions: ['COUNTER_SALE'],
      parameters: { minimumAgeYears: 18, verificationRequired: true },
      citation: '21 CFR 1306.26(c)–(d)',
    })
  ),

  /*
   * 1306.26(a) — the counter sale itself is a pharmacist's act, and expressly
   * not a non-pharmacist employee's even under supervision.
   */
  ...[US_CLASSIFICATIONS.exemptNarcoticOtc, US_CLASSIFICATIONS.exemptNarcoticOtcOpium].map(
    (classification) => ({
      code: `US-DISPENSER-${classification.replace('EXEMPT_NARCOTIC_OTC', 'EXEMPT')}`,
      ruleType: 'PHARMACIST_AUTHORITY',
      statement:
        'Only a pharmacist may make this sale — not a non-pharmacist employee, even under a ' +
        'pharmacist’s supervision.',
      sourceKey: 'US_CFR_1306',
      appliesToClassification: classification,
      appliesToTransactions: ['COUNTER_SALE'],
      parameters: { permittedLicenceTypes: ['LICENSED_PHARMACIST'] },
      citation: '21 CFR 1306.26(a)',
    })
  ),

  /*
   * FDCA § 503(b)(1) — what makes an ordinary medicine prescription-only in the
   * United States. Most prescription drugs are this and no schedule applies.
   *
   * ⚠️ NO VALIDITY PERIOD. Federal law puts no expiry on a legend-drug
   *   prescription; where one exists it is a state's. A number here would be
   *   this platform inventing a rule and refusing dispenses on the strength of it.
   */
  {
    code: 'US-RX-LEGEND',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'This drug may be dispensed only on the prescription of a practitioner licensed to ' +
      'administer it. Obtain the prescription before supplying this.',
    sourceKey: 'US_FDCA_353',
    appliesToClassification: US_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true },
    citation: '21 U.S.C. 353(b)(1)',
  },

  /*
   * FDCA § 503(f)(1), given effect by 21 CFR 201.105 — a veterinary
   * prescription drug is used only by or on the order of a licensed
   * veterinarian.
   */
  {
    code: 'US-RX-VETERINARY',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'This veterinary medicine may be supplied only by or on the order of a licensed ' +
      'veterinarian. Obtain the veterinarian’s order before supplying this.',
    sourceKey: 'US_CFR_201_105',
    appliesToClassification: US_CLASSIFICATIONS.veterinaryPrescription,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, prescriberClasses: ['VETERINARIAN'] },
    citation: '21 CFR 201.105; FDCA § 503(f)(1)',
  },
];
