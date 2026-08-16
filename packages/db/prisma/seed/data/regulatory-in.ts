/**
 * INDIA — rule pack 1.0.0. The first jurisdiction configured on this platform.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. This is a configuration of published
 *   rules, read from the regulator's own documents and cited row by row. It has
 *   not been reviewed by a qualified person, the pack's maturity says so, and
 *   every screen that shows it carries a banner. Silence must never imply
 *   compliance — see REGULATORY_RULE_PACKS.md.
 *
 * ── WHERE EVERY RULE BELOW CAME FROM ─────────────────────────────────────────
 * Two primary documents, both read in full rather than summarised:
 *
 *   The Drugs Rules, 1945, as consolidated to September 2024 and published by
 *   CDSCO itself (963 pages). Rule 65 is the conditions of a retail sale
 *   licence, and it is where almost everything in this pack lives.
 *
 *   The Pharmacy Act, 1948 (Act 8 of 1948), from India Code. Section 42 is who
 *   may dispense; section 2(i) is what "registered pharmacist" means.
 *
 * ⚠️ A SECONDARY SOURCE IS NOT A SOURCE, AND THAT RULE COST THIS FILE TWO RULES
 *   IT WOULD OTHERWISE HAVE CARRIED. G.S.R. 588(E) of 30 August 2013 — the
 *   notification that created Schedule H1 — is published by CDSCO only as a
 *   SCANNED IMAGE, so its text could not be verified here. It is recorded as a
 *   source with `UNVERIFIED` and a note, and the Schedule H1 rules cite the
 *   CONSOLIDATED rules instead, whose text was read directly. The commencement
 *   date of that notification is deliberately not asserted anywhere in this
 *   file, because the only place it was found was a summary.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO NDPS RULES. The Narcotic Drugs and Psychotropic Substances Act, 1985 and
 *   its rules govern narcotics, and the "essential narcotic drugs" regime runs
 *   through STATE licensing of recognised medical institutions. That is a
 *   sub-national, specialist question, and a half-read version of it is worse
 *   than none. The matrix cell stays `RESEARCH_REQUIRED`.
 *
 * ⚠️ NO QUANTITY LIMIT AND NO AGE RESTRICTION. The Drugs Rules impose neither on
 *   Schedule H, H1 or X. Writing a plausible one would be inventing law. Where
 *   quantity limits exist in India they are NDPS's, which is the paragraph
 *   above.
 *
 * ⚠️ NO `ONLINE_DISPENSING` RULE, AND THAT IS THE MOST CONSIDERED OMISSION IN
 *   THE FILE. The draft e-pharmacy rules (G.S.R. 817(E), 28 August 2018) were
 *   never notified and are still draft years later, so there is no published
 *   rule that says remote supply either is or is not permitted. `permitted:
 *   false` would assert a prohibition nobody has enacted; `permitted: true`
 *   would assert an authorisation nobody has granted. Both are inventions.
 *
 *   What IS written is that the rules below apply to `ONLINE_DISPENSE` as much
 *   as to a sale over a counter — not as a new claim, but because rule 65(9)(a)
 *   speaks about a drug being "sold by retail" and says nothing about the
 *   channel it is sold through. A prescription requirement that evaporated
 *   because the customer was on a website would be a reading of the rule that
 *   the rule does not support.
 *
 * ⚠️ NO SUB-NATIONAL PACK. India's state drugs controllers license and inspect,
 *   and whether any of them varies these particular obligations is
 *   `RESEARCH_REQUIRED`. The framework is ready for one — a pack on `(IN, KA)`
 *   supersedes this per rule type — and this file writes none.
 *
 * ── HOW TO CHANGE A RULE ─────────────────────────────────────────────────────
 * You do not edit one. A change is a NEW row with a new `version` and a new
 * `effectiveFrom`, and the old one gets an `effectiveTo` and `SUPERSEDED`. A
 * decision made last year cites the old row by id and has to stay explicable for
 * as long as the retention obligation runs (PI-ADR-008).
 */

/**
 * The day the pack, and every rule in it, becomes evaluable.
 *
 * ⚠️ THIS IS NOT THE DAY THE LAW CAME INTO FORCE AND MUST NOT BE CONFUSED WITH
 *   IT. The Drugs Rules date from 1945 and have been amended continuously since.
 *   `effective_from` on a pack or a rule row answers "from when does rcln act on
 *   this?", and back-dating it to 1945 would claim this platform had been
 *   applying the rule for eighty years — which would also mean a decision
 *   re-evaluated against a historical date silently acquired rules that did not
 *   exist here at the time. The LAW's own dates live on the SOURCE row, which is
 *   where a reader should look for them.
 */
export const IN_PACK_EFFECTIVE_FROM = '2026-08-13';

export interface SourceSeed {
  key: string;
  authorityCode: string;
  title: string;
  documentReference: string;
  sourceUrl: string;
  version?: string;
  publishedOn?: string;
  reviewStatus: 'UNVERIFIED' | 'VERIFIED' | 'UNAVAILABLE' | 'SUPERSEDED';
  notes: string;
}

export interface RuleSeed {
  code: string;
  ruleType: string;
  statement: string;
  sourceKey: string;
  appliesToProductType?: string;
  appliesToClassification?: string;
  appliesToTransactions: string[];
  parameters: Record<string, unknown>;
  /** The clause this rule is a reading of. Shown in the console beside the rule. */
  citation: string;
}

// ---------------------------------------------------------------------------
// Authorities
// ---------------------------------------------------------------------------

export const IN_AUTHORITIES = [
  {
    code: 'CDSCO',
    name: 'Central Drugs Standard Control Organisation',
    websiteUrl: 'https://cdsco.gov.in/',
    remit:
      'India’s national drugs regulator, under the Ministry of Health and Family Welfare. ' +
      'Administers the Drugs and Cosmetics Act, 1940 and the Drugs Rules, 1945.',
  },
  {
    code: 'PCI',
    name: 'Pharmacy Council of India',
    websiteUrl: 'https://www.pci.nic.in/',
    remit:
      'The statutory council constituted under the Pharmacy Act, 1948. The register of ' +
      'pharmacists that section 42 turns on is maintained by the State Councils under it.',
  },
] as const;

// ---------------------------------------------------------------------------
// Sources — the registry every rule below must cite to exist
// ---------------------------------------------------------------------------

export const IN_SOURCES: SourceSeed[] = [
  {
    key: 'IN_DRUGS_RULES_1945',
    authorityCode: 'CDSCO',
    title: 'The Drugs Rules, 1945',
    documentReference: 'Drugs Rules, 1945 — rule 65 (conditions of licences), rule 97 (labelling)',
    sourceUrl:
      'https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf',
    version: 'Consolidated to September 2024',
    publishedOn: '1945-12-21',
    reviewStatus: 'UNVERIFIED',
    notes:
      'CDSCO’s own consolidated publication, 963 pages, text extracted and read directly rather ' +
      'than summarised. Every rule in this pack that cites it quotes a clause that was read in ' +
      'full. UNVERIFIED means no qualified person has confirmed the READING — not that the ' +
      'document is in doubt.',
  },
  {
    key: 'IN_PHARMACY_ACT_1948',
    authorityCode: 'PCI',
    title: 'The Pharmacy Act, 1948',
    documentReference: 'Act 8 of 1948 — section 42 (dispensing by unregistered persons), s. 2(i)',
    sourceUrl: 'https://www.indiacode.nic.in/bitstream/123456789/19163/1/pharmacy_act_1948.pdf',
    publishedOn: '1948-03-04',
    reviewStatus: 'UNVERIFIED',
    notes:
      'India Code, the Government of India’s own repository of central legislation. Section 42(1) ' +
      'and the section 2(i) definition were read in full. ⚠️ Section 42(1) commences in a State ' +
      'on a date THAT STATE appoints by notification, with a fallback. This pack does not model ' +
      'that per-State commencement and does not claim to.',
  },
  {
    key: 'IN_GSR_588E_2013',
    authorityCode: 'CDSCO',
    title:
      'G.S.R. 588(E) — amendment of rules 65 and 97, inclusion of Schedule H1 and labelling ' +
      'requirements',
    documentReference: 'G.S.R. 588(E) dated 30 August 2013',
    sourceUrl:
      'https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/DR_G.S.R.%20588(E)%20dt_30.08.2013_Amendment%20Rule%2065,%20Rule%2097_Inclusion%20of%20Sch%20H1,%20Labelling%20requirements,%20Sch%20H%20list.pdf',
    publishedOn: '2013-08-30',
    reviewStatus: 'UNAVAILABLE',
    notes:
      '⚠️ RECORDED BUT NOT CITED BY ANY RULE. CDSCO publishes this notification only as a scanned ' +
      'image, so its text could not be read here. It is the notification that created Schedule H1; ' +
      'the Schedule H1 rules in this pack therefore cite the CONSOLIDATED Drugs Rules instead, ' +
      'whose text WAS read. Its commencement date is deliberately not asserted anywhere in this ' +
      'pack. A reviewer with the paper copy should verify and re-point the H1 rules at it.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The three classification strings this pack is written against.
 *
 * ⚠️ THESE ARE MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`
 *   AND ARE NOT PARSED, CASE-FOLDED OR TRIMMED. A clinic that records
 *   "Schedule H" instead of `SCHEDULE_H` has a product no rule in this pack
 *   matches — which resolves to UNDETERMINED and refuses, rather than silently
 *   permitting, but it still looks to that clinic like the platform is broken.
 *   The profile screen offers these as a picker for exactly that reason.
 */
export const IN_CLASSIFICATIONS = {
  scheduleH: 'SCHEDULE_H',
  scheduleH1: 'SCHEDULE_H1',
  scheduleX: 'SCHEDULE_X',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

const scheduled = [
  IN_CLASSIFICATIONS.scheduleH,
  IN_CLASSIFICATIONS.scheduleH1,
  IN_CLASSIFICATIONS.scheduleX,
];

/**
 * Rule 65(9)(a) — the spine of the pack.
 *
 * "Substances specified in Schedule H and Schedule H1 or Schedule X shall not be
 * sold by retail except on and in accordance with the prescription of a
 * Registered Medical Practitioner…"
 *
 * ⚠️ NO `validityDays`, AND ITS ABSENCE IS RESEARCHED RATHER THAN FORGOTTEN. The
 *   Drugs Rules put no expiry on a prescription for a Schedule H, H1 or X drug.
 *   A number here — 30 days, 6 months, whatever a comparable jurisdiction uses —
 *   would be this platform inventing a rule and then refusing dispenses on the
 *   strength of it.
 */
const prescriptionRules: RuleSeed[] = scheduled.map((classification) => ({
  code: `IN-RX-${classification.replace('SCHEDULE_', 'SCH-')}`,
  ruleType: 'PRESCRIPTION_REQUIRED',
  statement:
    `A ${classification.replace('SCHEDULE_', 'Schedule ')} drug may be supplied only on and in ` +
    'accordance with the prescription of a Registered Medical Practitioner. Obtain the ' +
    'prescription before supplying this.',
  sourceKey: 'IN_DRUGS_RULES_1945',
  appliesToClassification: classification,
  appliesToTransactions: SUPPLY_TO_PATIENT,
  parameters: { required: true },
  citation: 'Drugs Rules, 1945, rule 65(9)(a)',
}));

/**
 * Rule 65(11)(a) — "the prescription must not be dispensed more than once unless
 * the prescriber has stated thereon that it may be dispensed more than once."
 *
 * `refillsAllowed: 0` is the position where the prescriber has said nothing.
 * `endorsedRepeatsPermitted: true` is clause (b): where the prescriber HAS
 * endorsed a repeat, it may be dispensed as endorsed.
 *
 * ⚠️ THE SECOND KEY WAS ADDED IN PI-7 AND THE RULE WAS NOT WEAKENED TO ADD IT.
 *   PI-6 shipped this rule with the default alone, because
 *   `PresentedPrescription` had no field in which a caller could state that an
 *   endorsement exists — so the correct default also refused the legitimate
 *   endorsed case (KNOWN_ISSUES defect 3). The gap was closed in the FRAMEWORK,
 *   as that entry required: `repeatsAuthorised` is read off the prescription and
 *   the engine reads this key only where the rule opts in.
 *
 * ⚠️ AND THE PARAMETERS WERE EDITED IN PLACE RATHER THAN SUPERSEDED, WHICH IS
 *   ONLY DEFENSIBLE IN THIS ONE WINDOW. PI-ADR-008 forbids restating a rule a
 *   past decision cites — and no decision has ever cited one, because
 *   `regulatory_decisions` did not exist until this phase created it and nothing
 *   could dispense. The next change to this rule is a new version.
 *
 * ⚠️ NO `maxEndorsedRepeats`. The Drugs Rules state no ceiling on an endorsed
 *   repeat, and inventing one would be inventing law. An endorsement that does
 *   not itself state a number therefore resolves `UNDETERMINED` — which refuses,
 *   and tells the pharmacist to confirm the number with the prescriber.
 */
const refillRules: RuleSeed[] = scheduled.map((classification) => ({
  code: `IN-REPEAT-${classification.replace('SCHEDULE_', 'SCH-')}`,
  ruleType: 'REFILL_RULE',
  statement:
    'This prescription may not be dispensed more than once unless the prescriber has endorsed ' +
    'on it that it may be. Check the prescriber’s endorsement before repeating it.',
  sourceKey: 'IN_DRUGS_RULES_1945',
  appliesToClassification: classification,
  appliesToTransactions: SUPPLY_TO_PATIENT,
  parameters: { refillsAllowed: 0, endorsedRepeatsPermitted: true },
  citation: 'Drugs Rules, 1945, rule 65(11)(a)–(b)',
}));

/**
 * Rule 65(11A) — "No person dispensing a prescription containing substances
 * specified in Schedule H and Schedule H1 or X may supply any other preparation,
 * whether containing the same substances or not in lieu thereof."
 *
 * ⚠️ THIS IS A FLAT PROHIBITION AND IS NOT A CONSENT REQUIREMENT. The
 *   substitution handler refuses outright on `permitted: false` and never
 *   reaches the consent keys, which is correct here: the rule does not offer
 *   the prescriber's agreement as a way round it.
 */
const substitutionRules: RuleSeed[] = scheduled.map((classification) => ({
  code: `IN-SUBST-${classification.replace('SCHEDULE_', 'SCH-')}`,
  ruleType: 'SUBSTITUTION',
  statement:
    'No other preparation may be supplied in place of the one prescribed, whether or not it ' +
    'contains the same substances. Supply what was prescribed, or refer back to the prescriber.',
  sourceKey: 'IN_DRUGS_RULES_1945',
  appliesToClassification: classification,
  appliesToTransactions: SUPPLY_TO_PATIENT,
  parameters: { permitted: false },
  citation: 'Drugs Rules, 1945, rule 65(11A)',
}));

export const IN_RULES: RuleSeed[] = [
  ...prescriptionRules,
  ...refillRules,
  ...substitutionRules,

  /*
   * Rule 65(1)(h) — "the supply of a drug specified in Schedule H1 shall be
   * recorded in a separate register at the time of the supply giving the name
   * and address of the prescriber, the name of the patient, the name of the drug
   * and the quantity supplied and such records shall be maintained for three
   * years and be open for inspection."
   *
   * Split across two rules on purpose: the OBLIGATION TO RECORD is a
   * `CONTROLLED_SCHEDULE` condition raised at the moment of supply, and the
   * RETENTION PERIOD is a `RECORD_RETENTION` obligation about the register that
   * results. One rule carrying both would surface a three-year retention notice
   * to a pharmacist at a counter, which is not what they need to be told.
   */
  {
    code: 'IN-CD-SCH-H1-REGISTER',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'Record this supply in the Schedule H1 register at the time of supply: the prescriber’s ' +
      'name and address, the patient’s name, the drug and the quantity supplied.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleH1,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { scheduleName: 'Schedule H1', registerRequired: true },
    citation: 'Drugs Rules, 1945, rule 65(1)(h)',
  },
  {
    code: 'IN-RETAIN-SCH-H1-REGISTER',
    ruleType: 'RECORD_RETENTION',
    statement: 'The Schedule H1 register must be kept for three years and be open for inspection.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleH1,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      years: 3,
      detail:
        'Keep the Schedule H1 register for three years from the entry, available for inspection.',
      fields: [
        'PRESCRIBER_NAME',
        'PRESCRIBER_ADDRESS',
        'PATIENT_NAME',
        'DRUG_NAME',
        'QUANTITY_SUPPLIED',
      ],
    },
    citation: 'Drugs Rules, 1945, rule 65(1)(h)',
  },

  /*
   * Rule 65(21) — the Schedule X register is a bound, serially page-numbered
   * book with a page per drug, and rule 65(9)(a) requires the prescription
   * itself in duplicate with one copy retained two years.
   */
  {
    code: 'IN-CD-SCH-X-REGISTER',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'Record this supply in the bound, serially numbered Schedule X register, on the page for ' +
      'this drug, and retain one copy of the duplicate prescription.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleX,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { scheduleName: 'Schedule X', registerRequired: true },
    citation: 'Drugs Rules, 1945, rules 65(9)(a) and 65(21)',
  },
  {
    code: 'IN-RETAIN-SCH-X-RX',
    ruleType: 'RECORD_RETENTION',
    statement:
      'A Schedule X prescription is written in duplicate and one copy is kept for two years.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleX,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      years: 2,
      detail:
        'Keep one copy of the duplicate Schedule X prescription for two years from the supply.',
    },
    citation: 'Drugs Rules, 1945, rule 65(9)(a)',
  },

  /*
   * Rule 65(12) — Schedule X substances "shall be stored under lock and key in
   * cupboard or drawer reserved solely for the storage of these substances; or
   * in a part of the premises separated from the remainder of the premises and
   * to which only responsible persons have access."
   *
   * ⚠️ `storageLocationKinds` IS ON THE CONTROLLED_SCHEDULE RULE, NOT THIS ONE,
   *   AND THE SPLIT IS THE ENGINE'S NOT MINE. `evaluateControlledSchedule` is
   *   the handler that checks the location on a `STOCK` transaction and REFUSES
   *   a receipt into the wrong kind of place; `evaluateStorageRequirement`
   *   raises an obligation to carry out. Both are wanted, so both are written.
   */
  {
    code: 'IN-CD-SCH-X-STORAGE',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'A Schedule X drug may be kept only under lock and key in a cabinet reserved solely for it, ' +
      'or in a separated part of the premises only responsible persons can reach.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleX,
    appliesToTransactions: ['STOCK', 'TRANSFER'],
    parameters: {
      scheduleName: 'Schedule X',
      storageLocationKinds: ['CONTROLLED_CABINET'],
    },
    citation: 'Drugs Rules, 1945, rule 65(12)',
  },
  {
    code: 'IN-STORE-SCH-X',
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      'Keep this under lock and key in a cabinet reserved solely for Schedule X substances, or ' +
      'in a separated part of the premises only responsible persons can reach.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleX,
    appliesToTransactions: ['STOCK', 'TRANSFER', 'DISPENSE', 'COUNTER_SALE'],
    parameters: {
      locationKinds: ['CONTROLLED_CABINET'],
      controlledAccessRequired: true,
      detail:
        'Under lock and key in a cupboard or drawer reserved solely for Schedule X substances, ' +
        'or in a separated part of the premises to which only responsible persons have access.',
    },
    citation: 'Drugs Rules, 1945, rule 65(12)',
  },

  /*
   * Rule 65(7) — "all registers and records maintained under these rules shall be
   * preserved for a period of not less than two years from the date of the last
   * entry therein."
   *
   * ⚠️ NO `applies_to_*` AT ALL, WHICH MEANS EVERY PRODUCT, AND THAT IS THE
   *   POINT. It is the catch-all retention obligation; the Schedule H1 rule
   *   above is more specific and supersedes it for H1 products, per rule type,
   *   which is exactly the three-year period displacing the two-year one.
   */
  {
    code: 'IN-RETAIN-RECORDS',
    ruleType: 'RECORD_RETENTION',
    statement:
      'Registers and records kept under the Drugs Rules must be preserved for at least two years ' +
      'from the date of the last entry in them.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToTransactions: [],
    parameters: {
      years: 2,
      detail:
        'Preserve every register and record kept under the Drugs Rules for at least two years ' +
        'from the last entry.',
    },
    citation: 'Drugs Rules, 1945, rule 65(7)',
  },

  /*
   * Pharmacy Act, 1948, section 42(1) — "no person other than a registered
   * pharmacist shall compound, prepare, mix, or dispense any medicine on the
   * prescription of a medical practitioner", with a proviso for a practitioner
   * dispensing to their own patients.
   *
   * ⚠️ A LICENCE TYPE, NOT A ROLE CODE, AND THE DISTINCTION IS THE ONE
   *   `RegulatoryActor` WARNS ABOUT AT LENGTH. "Registered pharmacist" is a
   *   REGISTRATION under section 2(i) — a name in a State Council's register —
   *   and it is not the rcln role called PHARMACIST, which a clinic may rename
   *   to "Dispensary Lead" tomorrow. Naming the role here would produce a rule
   *   that refuses an actual registered pharmacist for not holding one of our
   *   role codes, which is a statement about our software rather than the law.
   *
   * ⚠️ THE SECTION 42 PROVISO IS MODELLED, AS OF PI-7, AND IT IS PART OF THE
   *   SECTION RATHER THAN AN EXCEPTION TO IT: s. 42(1) does not apply to "the
   *   dispensing by a medical practitioner of medicine for his own patients".
   *   `exemptWhenActorIsPrescriber: true` is that clause, and it fires only when
   *   the person dispensing IS the prescriber of the prescription in hand —
   *   derived by the service from the encounter, never asserted by a client.
   *   Without it, a doctor-run clinic (the common shape in India) was refused by
   *   a rule that does not reach it. KNOWN_ISSUES defect 4, closed in the
   *   framework as that entry required.
   */
  {
    code: 'IN-DISPENSER-REGISTERED-PHARMACIST',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'Only a registered pharmacist may compound, prepare, mix or dispense a medicine on a ' +
      'prescription. Hand this to a registered pharmacist.',
    sourceKey: 'IN_PHARMACY_ACT_1948',
    appliesToTransactions: ['DISPENSE'],
    parameters: {
      permittedLicenceTypes: ['REGISTERED_PHARMACIST'],
      exemptWhenActorIsPrescriber: true,
    },
    citation: 'Pharmacy Act, 1948, s. 42(1) read with s. 2(i)',
  },

  /*
   * Rule 65(19) — a supply in a container other than the manufacturer's is made
   * only by a dealer employing a registered pharmacist, under that pharmacist's
   * direct supervision, and the wrapper carries the name of the drug, the
   * quantity supplied, and the name and address of the dealer.
   */
  {
    code: 'IN-LABEL-DISPENSED',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'A supply made in anything other than the manufacturer’s own container must be labelled ' +
      'with the name of the drug, the quantity supplied, and the name and address of the dealer.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: {
      fields: ['DRUG_NAME', 'QUANTITY_SUPPLIED', 'DEALER_NAME', 'DEALER_ADDRESS'],
      detail:
        'Label the wrapper with the name of the drug, the quantity supplied, and the dealer’s ' +
        'name and address. The supply is made under a registered pharmacist’s direct supervision.',
    },
    citation: 'Drugs Rules, 1945, rule 65(19)',
  },

  /*
   * Rule 97(1)(c)–(f) — the manufacturer's container labelling. Raised on
   * `STOCK` rather than on a supply, because it is a thing to CHECK WHEN THE
   * STOCK ARRIVES: a Schedule H pack that reaches the shelf without its red Rx
   * and warning box is a pack to query with the supplier, not something the
   * pharmacist can fix at the counter later.
   */
  {
    code: 'IN-LABEL-CONTAINER-SCH-H',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Check the container carries the symbol Rx in red on the top left and the boxed warning ' +
      '“SCHEDULE H PRESCRIPTION DRUG — WARNING”.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleH,
    appliesToTransactions: ['STOCK'],
    parameters: {
      fields: ['SYMBOL_RX_RED', 'WARNING_BOX_SCHEDULE_H'],
      detail:
        'Symbol Rx in red, conspicuously on the left top corner, and in a completely red ' +
        'rectangular box: “SCHEDULE H PRESCRIPTION DRUG — WARNING. To be sold by retail on the ' +
        'prescription of a Registered Medical Practitioner only.”',
    },
    citation: 'Drugs Rules, 1945, rule 97(1)(c)',
  },
  {
    code: 'IN-LABEL-CONTAINER-SCH-H1',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Check the container carries the symbol Rx in red on the top left and the boxed caution ' +
      '“SCHEDULE H1 PRESCRIPTION DRUG — CAUTION”.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleH1,
    appliesToTransactions: ['STOCK'],
    parameters: {
      fields: ['SYMBOL_RX_RED', 'WARNING_BOX_SCHEDULE_H1'],
      detail:
        'Symbol Rx in red, conspicuously on the left top corner, and in a completely red ' +
        'rectangular box: “SCHEDULE H1 PRESCRIPTION DRUG — CAUTION. It is dangerous to take this ' +
        'preparation except in accordance with the medical advice. Not to be sold by retail ' +
        'without the prescription of a Registered Medical Practitioner.” Where the drug also ' +
        'falls under the NDPS Act, 1985 the symbol is NRx.',
    },
    citation: 'Drugs Rules, 1945, rule 97(1)(e)–(f)',
  },
  {
    code: 'IN-LABEL-CONTAINER-SCH-X',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Check the container carries the symbol XRx in red on the top left and the boxed warning ' +
      '“SCHEDULE X PRESCRIPTION DRUG — WARNING”.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToClassification: IN_CLASSIFICATIONS.scheduleX,
    appliesToTransactions: ['STOCK'],
    parameters: {
      fields: ['SYMBOL_XRX_RED', 'WARNING_BOX_SCHEDULE_X'],
      detail:
        'Symbol XRx in red, conspicuously on the left top corner, and in a completely red ' +
        'rectangular box: “SCHEDULE X PRESCRIPTION DRUG — WARNING. To be sold by retail on the ' +
        'prescription of a Registered Medical Practitioner only.”',
    },
    citation: 'Drugs Rules, 1945, rule 97(1)(d)',
  },

  /*
   * Rule 65(20) and rule 97(3) — veterinary medicines carry "Not for human
   * use — for treatment of animals only" and are stored apart from the rest of
   * the shop.
   *
   * ⚠️ NARROWED BY PRODUCT TYPE RATHER THAN BY CLASSIFICATION, WHICH IS WHY IT
   *   WORKS WITHOUT A PROFILE. A veterinary medicine is a veterinary medicine
   *   whatever any clinic has or has not recorded about it, so this rule
   *   applies from the moment the product is typed — unlike everything keyed on
   *   a schedule, which needs the clinic to say which schedule the drug is in.
   */
  {
    code: 'IN-LABEL-VETERINARY',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'A veterinary medicine must be labelled “Not for human use — for treatment of animals only” ' +
      'and kept apart from the rest of the stock.',
    sourceKey: 'IN_DRUGS_RULES_1945',
    appliesToProductType: 'VETERINARY_MEDICINE',
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE', 'STOCK'],
    parameters: {
      fields: ['NOT_FOR_HUMAN_USE'],
      detail:
        'Label with the words “Not for human use — for treatment of animals only”. Keep in a ' +
        'cupboard or drawer reserved for veterinary drugs, or in a part of the premises ' +
        'customers cannot reach.',
    },
    citation: 'Drugs Rules, 1945, rules 65(20) and 97(3)',
  },
];
