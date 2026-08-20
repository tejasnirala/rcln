/**
 * SINGAPORE — national rule pack `SG` 1.0.0, read from the subsidiary
 * legislation the Attorney-General's Chambers publishes on SSO.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from Singapore Statutes Online,
 *   the authorised publication of Singapore legislation, cited provision by
 *   provision, and reviewed by nobody qualified. The pack's maturity says so.
 *
 * ── WHY THERE IS NO SUB-NATIONAL PACK, AND WHY THAT IS NOT PI-15 AGAIN ───────
 * Singapore is a city-state. `CountryInfo.regions` for `SG` in `@rcln/contracts`
 * is `[]` and its `labels.region` is `null` with the comment "a city-state,
 * there is no second level to ask for" — which is CORRECT here, and was the
 * exact field that would have made `AU-VIC` inert when it was wrong for
 * Australia. It was checked first, per NEXT_SESSION.md, and the check is
 * recorded so nobody has to repeat it: an empty `regions` list is right when the
 * country has no subdivisions and is a latent bug when it has some and taxes
 * them uniformly.
 *
 * ── THE ONE STRUCTURAL FACT TO UNDERSTAND BEFORE READING A RULE BELOW ────────
 * ⚠️ SINGAPORE REGULATES MEDICINES UNDER TWO INSTRUMENTS THAT DO NOT SHARE A
 *   VOCABULARY, AND THIS PACK CARRIES BOTH. The Health Products (Therapeutic
 *   Products) Regulations 2016 classify a medicine as prescription-only,
 *   pharmacy-only or general sale list. The Misuse of Drugs Regulations classify
 *   a CONTROLLED DRUG by which Schedule of those Regulations it sits in. Morphine
 *   is both: a prescription-only medicine to HSA and a Second Schedule drug to
 *   the Misuse of Drugs Regulations.
 *
 * ⚠️ AND `product_regulatory_profiles.classification` IS ONE STRING, SO A CLINIC
 *   HAS TO PICK ONE. A clinic that files morphine as `MDA_SECOND_SCHEDULE` gets
 *   the controlled-drug rules and NOT `SG-RX-POM`; one that files it as
 *   `PRESCRIPTION_ONLY_MEDICINE` gets the reverse. That is why the
 *   controlled-drug rules below are written to stand alone — each Schedule
 *   carries its own prescription requirement, its own prescriber list and its
 *   own retention period rather than leaning on the therapeutic-products rules
 *   to supply them. It is a framework limitation, recorded in KNOWN_ISSUES, and
 *   the mitigation is that neither half is silently thinner than the other.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO `PHARMACIST_AUTHORITY` RULE FOR A PRESCRIPTION-ONLY OR PHARMACY-ONLY
 *   MEDICINE, WHICH IS THE MOST CONSIDERED OMISSION IN THE FILE AND THE ONE MOST
 *   LIKELY TO BE "FIXED" BY SOMEBODY WHO HAS NOT READ THIS PARAGRAPH. Every
 *   other pack in this programme has one; Singapore's law does not support it.
 *
 *   Regulation 11 of the Therapeutic Products Regulations permits retail supply
 *   of a prescription-only medicine by any of three routes: at or from a
 *   licensed retail pharmacy, OR by a healthcare service licensee to its own
 *   patient on the written instructions of a practitioner who is that licensee's
 *   personnel, OR by a practitioner (or a person acting on that practitioner's
 *   ORAL OR WRITTEN INSTRUCTIONS) to a patient under their care. Regulation
 *   13 says the same for a pharmacy-only medicine. Regulation 3 of the Licensing
 *   of Retail Pharmacies Regulations does impose a pharmacist — an "in-store
 *   pharmaceutical officer" — but its own paragraph (3) disapplies the whole of
 *   regulations 3(1) and 3(2) from exactly the clinic limbs above.
 *
 *   So the pharmacist requirement in Singapore is CONDITIONAL ON WHAT THE
 *   PREMISES ARE, and rcln holds no fact that says whether a branch is a
 *   licensed retail pharmacy or a healthcare service licensee's consulting
 *   rooms. A rule naming `QUALIFIED_PHARMACIST` would refuse a clinic assistant
 *   handing a medicine over on the doctor's written instruction — lawful under
 *   regulation 11(b) and 11(c), and the ordinary shape of a Singapore GP clinic.
 *   That is a wrong answer in the REFUSING direction, which is the direction
 *   nobody audits, and it is the same mistake `validityDays: 180` would have
 *   been for the United States. The rule is therefore absent rather than
 *   stubbed, and the matrix cell says so.
 *
 * ⚠️ THE CONTROLLED-DRUG SUPPLY RULES ARE NOT SUBJECT TO THAT PARAGRAPH, AND THE
 *   CONTRAST IS THE POINT. Regulations 7(2) and 8(2) of the Misuse of Drugs
 *   Regulations list WHO may supply a Second or Third Schedule drug, full stop —
 *   a practitioner, a pharmacist, a person lawfully conducting a retail pharmacy
 *   business, a ward nurse in charge, a collaborative prescribing practitioner,
 *   an approved researcher, an inspector. There is no "or a person acting on
 *   their instructions" limb. `SG-SUPPLY-CD2` and `SG-SUPPLY-CD3` are that list.
 *
 * ⚠️ NO PRESCRIPTION VALIDITY FOR A PRESCRIPTION-ONLY MEDICINE. The Therapeutic
 *   Products Regulations state what makes a prescription valid (reg 2(2)) and
 *   impose no expiry on it whatever. Great Britain says six months, Victoria
 *   says twelve; Singapore says nothing, and inventing a number here would
 *   refuse lawful supply while citing a regulation that permits it. Controlled
 *   drugs DO have one — 30 days, reg 12(1) — and they carry it.
 *
 * ⚠️ NO 355 mg CODEINE LIMIT. Regulation 14(1) caps codeine cough preparations
 *   two ways: 240 ml of preparation per 7 days where the supply is liquid only,
 *   and 355 mg OF CODEINE CALCULATED AS BASE where it is solid or mixed. The
 *   first is a quantity of the product and is written below; the second is a
 *   quantity of a CONTAINED SUBSTANCE measured against a product counted in
 *   tablets, which needs composition arithmetic this platform does not have.
 *   That is survey GAP 4, the same gap that left the United States pack without
 *   pseudoephedrine rules, and half-modelling it is worse than an honest
 *   absence. ⚠️ IT ALSO MEANS `SG-QTY-CODEINE-LIQUID` IS NOT THE WHOLE OF
 *   REGULATION 14 — a clinic supplying tablets is unregulated by this pack.
 *
 * ⚠️ NO CONTAINER-MARKING RULE FROM REGULATION 13 OF THE MISUSE OF DRUGS
 *   REGULATIONS, and it is absent for a reason that reads backwards. That
 *   regulation requires a controlled drug to be supplied in a container marked
 *   with the amount of drug it holds — and its own paragraph (2) disapplies it
 *   to "the supply of a controlled drug by or on the prescription of a
 *   practitioner", which is every dispense this platform models. A rule written
 *   from paragraph (1) alone would impose a marking obligation on precisely the
 *   transactions the regulation exempts.
 *
 * ⚠️ NO `ONLINE_DISPENSING` RULE, WHICH IS INDIA'S CALL MADE AGAIN AND SHOULD BE
 *   READ WITH PI-12's WARNING IN HAND. Nothing found in these instruments either
 *   authorises or prohibits remote supply as such. Regulation 17(1)(b)(iv) of
 *   the Therapeutic Products Regulations does contemplate a healthcare service
 *   licensee dispensing "by delivery" or through a remote service kiosk — but it
 *   is a LABELLING provision, and inferring an authorisation to supply from a
 *   rule about what must be printed on the box is the step `regulatory-in.ts`
 *   refuses to take about "Not for human use".
 *
 *   The consequence is the one PI-12 documented: a pack that says nothing about
 *   remote supply PERMITS it, on the strength of its rules about a counter,
 *   because those rules list `ONLINE_DISPENSE` among their transactions. That is
 *   deliberate and it is why the second gate exists —
 *   `product_regulatory_profiles.online_sale_position` and
 *   `confirmOnlineOrder`, which refuse independently of the engine. Read
 *   `packages/regulatory/tests/online-sale-gap.test.ts` before deciding either
 *   is redundant.
 *
 * ⚠️ NO ADDICT-NOTIFICATION RULE. Regulation 19 of the Misuse of Drugs
 *   Regulations requires a medical practitioner who attends a suspected drug
 *   addict to notify the Director of Medical Services and the Director of the
 *   Central Narcotics Bureau within 7 days. It is real, it is operative, and it
 *   attaches to ATTENDING A PATIENT rather than to supplying a product — there
 *   is no product, no classification and no transaction for the engine to hang
 *   it on. A `REPORTING_REQUIREMENT` rule keyed to a controlled drug would raise
 *   it on every Second Schedule dispense, which is not what the regulation says.
 *
 * ⚠️ NO PRODUCT REGISTRATION, IMPORT, WHOLESALE OR PHARMACY-LICENSING RULES.
 *   Parts 2, 5 and 6 of the Therapeutic Products Regulations are about being a
 *   manufacturer, importer, wholesaler or registrant — obligations of a
 *   business, not decisions about a transaction. This engine answers "may this
 *   supply happen, and what must be done about it"; it is not a licensing
 *   register.
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
 * ⚠️ NOT THE DAY ANY OF THESE INSTRUMENTS COMMENCED. The Misuse of Drugs
 *   Regulations date from 1973 and the Therapeutic Products Regulations from
 *   2016; `effective_from` answers "from when does rcln act on this?" and
 *   back-dating it would claim the platform had been applying the rule for
 *   decades. The law's own dates live on the SOURCE rows.
 */
export const SG_PACK_EFFECTIVE_FROM = '2026-08-20';

export const SG_AUTHORITIES = [
  {
    code: 'HSA',
    name: 'Health Sciences Authority',
    websiteUrl: 'https://www.hsa.gov.sg/',
    remit:
      'Singapore’s national regulator of health products. Administers the Health Products Act ' +
      '2007 and its subsidiary legislation, registers therapeutic products and classifies each ' +
      'as prescription-only, pharmacy-only or general sale list, and licenses retail pharmacies. ' +
      '⚠️ It does not administer the Misuse of Drugs Act — a controlled medicine in Singapore ' +
      'answers to HSA for what it is and to the Misuse of Drugs Regulations for how it is held ' +
      'and supplied.',
  },
  {
    code: 'SG_CNB',
    name: 'Central Narcotics Bureau',
    websiteUrl: 'https://www.cnb.gov.sg/',
    remit:
      'Singapore’s drug enforcement authority under the Misuse of Drugs Act 1973. The Misuse of ' +
      'Drugs Regulations are made by the Minister for Home Affairs and their inspectors are ' +
      'appointed under regulation 21; the Director of the Central Narcotics Bureau is named in ' +
      'the Regulations themselves. ⚠️ RECORDED AS THE AUTHORITY FOR THE INSTRUMENT, NOT AS ITS ' +
      'PUBLISHER — every source below is cited to Singapore Statutes Online, which is the ' +
      'Attorney-General’s Chambers’ authorised publication of both instruments.',
  },
] as const;

export const SG_SOURCES: SourceSeed[] = [
  {
    key: 'SG_THERAPEUTIC_PRODUCTS',
    authorityCode: 'HSA',
    title: 'Health Products (Therapeutic Products) Regulations 2016',
    documentReference: 'G.N. No. S 329/2016, regs 2(2), 11, 13, 14, 16 and 17',
    sourceUrl: 'https://sso.agc.gov.sg/SL/HPA2007-S329-2016',
    version: 'As at 20 Aug 2026; amended by S 767/2025',
    publishedOn: '2025-12-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From Singapore Statutes Online, the Attorney-General’s Chambers’ authorised publication of ' +
      'Singapore legislation. `publishedOn` is the day the current version came into force. Regulations 2, 11, 12, 13, 14, 16 and 17 were read in full; Parts ' +
      '2, 5, 6, 7, 8 and 9 — manufacture, import, registration and the duties of licensees — were ' +
      'not, because they regulate a business rather than a transaction. The Third Schedule, which ' +
      'lists the persons who may supply or administer particular prescription-only medicines ' +
      'without a prescription, was NOT read and no rule below relies on it. UNVERIFIED means no ' +
      'qualified person has confirmed the READING.',
  },
  {
    key: 'SG_RETAIL_PHARMACIES',
    authorityCode: 'HSA',
    title: 'Health Products (Licensing of Retail Pharmacies) Regulations 2016',
    documentReference: 'G.N. No. S 330/2016, reg 3',
    sourceUrl: 'https://sso.agc.gov.sg/SL/HPA2007-S330-2016',
    version: 'As at 20 Aug 2026; amended by S 692/2024',
    publishedOn: '2024-09-04',
    reviewStatus: 'UNVERIFIED',
    notes:
      '⚠️ CITED FOR A RULE THAT IS NOT WRITTEN, WHICH IS WHY IT IS HERE AT ALL. Regulation 3(1) ' +
      'requires retail supply from a licensed pharmacy to be carried out by an in-store ' +
      'pharmaceutical officer and confines access to controlled drugs to a qualified pharmacist — ' +
      'and regulation 3(3) disapplies the whole of 3(1) and 3(2) to a healthcare service licensee ' +
      'or a practitioner supplying their own patient. The pharmacist gate is therefore conditional ' +
      'on what the premises are, which is a fact rcln does not hold, so no PHARMACIST_AUTHORITY ' +
      'rule is written for a prescription-only or pharmacy-only medicine. The source is recorded ' +
      'so the reasoning is auditable and so a later reviewer starts from the text.',
  },
  {
    key: 'SG_MISUSE_OF_DRUGS',
    authorityCode: 'SG_CNB',
    title: 'Misuse of Drugs Regulations',
    documentReference:
      'Misuse of Drugs Act 1973, subsidiary legislation, regs 2, 7, 8, 8A, 11, 12, 14, 15, 17, 20 and 28',
    sourceUrl: 'https://sso.agc.gov.sg/SL/MDA1973-RG1',
    version: 'As at 20 Aug 2026; amended by S 322/2026',
    publishedOn: '2026-06-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From Singapore Statutes Online. Parts I to IV were read; the First to Fourth Schedules — ' +
      'which name the substances in each class — were NOT enumerated, because which schedule a ' +
      'given medicine sits in is a fact the clinic records on the product, not one this pack ' +
      'asserts. ⚠️ Regulation 2 defines “register” as A BOUND BOOK, expressly excluding a loose ' +
      'leaf register or a card index; see `SG-SCHEDULE-CD2`. UNVERIFIED means no qualified person ' +
      'has confirmed the READING.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The classification strings this pack is written against.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`, AND
 *   NOT PARSED, CASE-FOLDED OR TRIMMED — the discipline every pack in this
 *   programme is written under. A clinic that records `POM` instead of
 *   `PRESCRIPTION_ONLY_MEDICINE` has a product no rule here matches, which
 *   resolves `UNDETERMINED` and refuses rather than silently permitting, and
 *   still looks to that clinic like the platform is broken.
 *
 * ⚠️ THE TWO VOCABULARIES ARE NOT INTERCHANGEABLE AND A PRODUCT CAN ONLY WEAR
 *   ONE. See the file header: `PRESCRIPTION_ONLY_MEDICINE` is HSA's word and
 *   `MDA_SECOND_SCHEDULE` is the Misuse of Drugs Regulations', and morphine is
 *   both. Every controlled-drug rule below is written so that the Schedule
 *   spelling alone is sufficient.
 *
 * ⚠️ GENERAL SALE LIST MEDICINES ARE ABSENT ON PURPOSE. The only provision found
 *   about them is regulation 15, which is about VENDING MACHINES, and this
 *   platform does not model one. A general sale list product therefore matches
 *   no rule in this pack and resolves `UNDETERMINED`, which refuses — an honest
 *   gap rather than a permission nobody wrote.
 *
 * ⚠️ AND `CODEINE_COUGH_PREPARATION_LIQUID` IS A THIRD SPELLING OF THE SAME
 *   PROBLEM. A codeine linctus is a prescription-only medicine AND a preparation
 *   regulation 14 caps; a clinic that files it under this key gets the 240 ml
 *   limit and not `SG-RX-POM`, and one that files it as a prescription-only
 *   medicine gets the reverse. `SG-RX-CODEINE-LIQUID` exists so the first half
 *   of that trade is not a loss.
 */
export const SG_CLASSIFICATIONS = {
  prescriptionOnly: 'PRESCRIPTION_ONLY_MEDICINE',
  pharmacyOnly: 'PHARMACY_ONLY_MEDICINE',
  codeineCoughLiquid: 'CODEINE_COUGH_PREPARATION_LIQUID',
  controlledSecond: 'MDA_SECOND_SCHEDULE',
  controlledThird: 'MDA_THIRD_SCHEDULE',
  controlledFourth: 'MDA_FOURTH_SCHEDULE',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/**
 * The three Misuse of Drugs Schedules a medicine can sit in, with the short name
 * used in a rule code and the words the Regulations themselves use.
 *
 * ⚠️ THE FIRST SCHEDULE IS ABSENT AND IS NOT AN OVERSIGHT. Regulations 10 to 16,
 *   28 and 20 each carve out "a drug specified in the First Schedule" by name —
 *   those are the exempted preparations, and a rule imposing a register, a
 *   30-day prescription or a safe on them would impose the opposite of what the
 *   Regulations say. Regulation 18 keeps a lighter record for them and is not
 *   modelled.
 */
const CONTROLLED_SCHEDULES = [
  {
    key: 'CD2',
    classification: SG_CLASSIFICATIONS.controlledSecond,
    name: 'Second Schedule',
  },
  {
    key: 'CD3',
    classification: SG_CLASSIFICATIONS.controlledThird,
    name: 'Third Schedule',
  },
  {
    key: 'CD4',
    classification: SG_CLASSIFICATIONS.controlledFourth,
    name: 'Fourth Schedule',
  },
] as const;

/**
 * Who may write a prescription for a controlled drug.
 *
 * ⚠️ THIS LIST HAS A VETERINARY SURGEON ON IT AND THE THERAPEUTIC-PRODUCTS LIST
 *   DOES NOT, WHICH IS A DIFFERENCE BETWEEN TWO INSTRUMENTS RATHER THAN AN
 *   INCONSISTENCY IN THIS FILE. Regulation 2 of the Misuse of Drugs Regulations
 *   defines "prescription" to include one issued "by a veterinary surgeon for
 *   the purposes of animal treatment", and "practitioner" as a medical
 *   practitioner, dentist or veterinary surgeon. Regulation 2(1) of the
 *   Therapeutic Products Regulations defines "qualified practitioner" as a
 *   registered medical practitioner or a first-division registered dentist, and
 *   no vet appears anywhere in it.
 */
const CONTROLLED_DRUG_PRESCRIBERS = [
  'MEDICAL_PRACTITIONER',
  'DENTIST',
  'VETERINARY_SURGEON',
  'COLLABORATIVE_PRESCRIBING_PRACTITIONER',
];

/**
 * Who may hand a Second or Third Schedule drug over, from regs 7(2) and 8(2).
 *
 * ⚠️ A LICENCE TYPE, NOT A ROLE CODE — see the warning on `RegulatoryActor`. A
 *   clinic may rename its `PHARMACIST` role to "Dispensary Lead" tomorrow, and a
 *   rule naming the role would then match nobody at that clinic.
 *
 * ⚠️ AND A DISPENSARY ASSISTANT IS DELIBERATELY NOT ON IT. That is the whole
 *   difference between a controlled drug and a prescription-only medicine in
 *   Singapore: regulation 11(c) of the Therapeutic Products Regulations lets "a
 *   person acting in accordance with the oral or written instructions of a
 *   qualified practitioner" supply a prescription-only medicine, and regulations
 *   7(2) and 8(2) contain no such limb. The people the Regulations DO name and
 *   this list omits — an approved researcher, a laboratory custodian, an HSA or
 *   DSO analyst, an inspector, a ship's master — are not people standing at a
 *   dispensing point, and naming them would widen a supply rule to cover
 *   transactions this platform does not model.
 */
const CONTROLLED_DRUG_SUPPLIERS = [
  'MEDICAL_PRACTITIONER',
  'DENTIST',
  'VETERINARY_SURGEON',
  'QUALIFIED_PHARMACIST',
  'RETAIL_PHARMACY_BUSINESS',
  'COLLABORATIVE_PRESCRIBING_PRACTITIONER',
  'WARD_NURSE_IN_CHARGE',
];

export const SG_RULES: RuleSeed[] = [
  /*
   * ── Therapeutic products ──────────────────────────────────────────────────
   *
   * Regulation 11 — a prescription-only medicine reaches a patient by one of
   * three routes, and every one of them runs through a practitioner: a licensed
   * retail pharmacy, a healthcare service licensee acting on a practitioner's
   * written instructions, or the practitioner themselves. Regulation 2(2) is
   * what makes the prescription a prescription.
   *
   * ⚠️ NO `validityDays` AND NO `validityMonths`. See the file header: these
   *   Regulations impose no expiry on a prescription for a prescription-only
   *   medicine, and the number somebody would reach for — 6 months, because
   *   Britain says so — would refuse lawful supply while citing a regulation
   *   that permits it.
   */
  {
    code: 'SG-RX-POM',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A prescription-only medicine may be supplied only on the prescription of a qualified ' +
      'practitioner or collaborative prescribing practitioner, or on that practitioner’s ' +
      'instructions to a patient under their care. Obtain the prescription before supplying this.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, regs 11 and 2(2)',
  },

  /*
   * Regulation 2(2)(a) — "written and signed by a qualified practitioner or
   * collaborative prescribing practitioner". A closed list, so it is expressible.
   *
   * ⚠️ A VETERINARY SURGEON IS NOT ON IT, AND A VET'S PRESCRIPTION FOR A
   *   PRESCRIPTION-ONLY MEDICINE IS THEREFORE REFUSED BY THIS RULE. That is a
   *   reading of regulation 2(1), which defines "qualified practitioner" as a
   *   registered medical practitioner or a first-division registered dentist and
   *   nothing else — not a finding that veterinary supply is unlawful in
   *   Singapore, which is the Animals and Birds Act's question and is not
   *   researched here. A veterinary clinic dispensing a controlled drug gets
   *   `SG-PRESCRIBER-CD2` and its siblings, which DO name a vet. Recorded in
   *   KNOWN_ISSUES.
   */
  {
    code: 'SG-PRESCRIBER-POM',
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      'A prescription for a prescription-only medicine is valid only if it is written and signed ' +
      'by a qualified practitioner — a registered medical practitioner or a first-division ' +
      'registered dentist — or by a collaborative prescribing practitioner.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      permittedPrescriberClasses: [
        'MEDICAL_PRACTITIONER',
        'DENTIST',
        'COLLABORATIVE_PRESCRIBING_PRACTITIONER',
      ],
    },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, regs 2(1) and 2(2)(a)',
  },

  /*
   * Regulation 17(2) — repeats.
   *
   * ⚠️ `refillsAllowed: 0` WITH `endorsedRepeatsPermitted: true` IS THE EXACT
   *   SHAPE OF THE REGULATION AND NOT A CONVENTION BORROWED FROM INDIA.
   *   Paragraph (a) governs where the prescriber "does not specify that the
   *   prescription is to be repeated" — dispense once, mark it, keep it two
   *   years. Paragraph (b) governs where the prescriber does — dispense no more
   *   than "the total number of times specified on the prescription". So the
   *   endorsement is the only thing that permits a second supply, which is what
   *   `endorsedRepeatsPermitted` means.
   *
   * ⚠️ AND NO `maxEndorsedRepeats`, WHICH MAKES AN UNNUMBERED ENDORSEMENT
   *   `UNDETERMINED` — AND THAT IS SINGAPORE'S OWN ANSWER RATHER THAN THE
   *   FRAMEWORK'S DEFAULT SHOWING THROUGH. Regulation 2(2)(b)(v) requires a
   *   prescription intended to be repeated to state "the number of times, and
   *   the time period between which" the product may be supplied. A prescription
   *   that says "repeat" and no number is not a valid prescription under
   *   regulation 2(2), so refusing to guess a ceiling is the statute's position,
   *   not a limitation of the engine.
   */
  {
    code: 'SG-REPEAT-POM',
    ruleType: 'REFILL_RULE',
    statement:
      'A prescription-only medicine may be dispensed once unless the prescriber specified that ' +
      'the prescription is to be repeated, and then no more times than the prescription states.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { refillsAllowed: 0, endorsedRepeatsPermitted: true },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, regs 17(2) and 2(2)(b)(v)',
  },

  /*
   * Regulation 17(1) — the dispensing label, and the only rule in this pack that
   * names no classification at all.
   *
   * ⚠️ THAT BREADTH IS THE REGULATION'S, NOT A SHORTCUT. Regulation 17(1) opens
   *   "A relevant person may dispense a therapeutic product only if the package
   *   or container ... is labelled with all of the following information in
   *   English" — every therapeutic product, whatever its classification. A
   *   classification-keyed copy of it per class would be four rules saying one
   *   thing, and the first class somebody forgot would dispense unlabelled.
   *
   * ⚠️ AND IT IS NOT ON `COUNTER_SALE`, DELIBERATELY. Regulation 2(1) defines
   *   "dispense" as preparing and supplying a product to a patient by a
   *   practitioner, a pharmacist, or someone under their supervision. Selling a
   *   general sale list medicine over a counter is not that, and putting the
   *   label rule on `COUNTER_SALE` would impose a patient's name on a
   *   transaction that names no patient.
   *
   * ⚠️ `SUPPLYING_PREMISES` IS ONE FIELD HERE AND FOUR ALTERNATIVES IN THE
   *   REGULATION. Paragraph (b) states the premises particulars four different
   *   ways depending on whether the supply is at a licensed retail pharmacy, at
   *   a healthcare service licensee's approved permanent premises, at temporary
   *   premises or a conveyance, or by remote service kiosk or delivery — each
   *   resolving to a name, an address and an identification number or logo. The
   *   `detail` says so; collapsing them into one field is a statement about what
   *   the screen must print, and the screen cannot know which limb applies
   *   because rcln does not hold the licence the branch operates under.
   */
  {
    code: 'SG-LABEL-DISPENSE',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'A dispensed therapeutic product must be labelled in English with the patient’s name, the ' +
      'supplying premises, the date of dispensing, the directions for use, the product name and, ' +
      'where the non-proprietary name is used, the quantitative particulars of each active ' +
      'ingredient.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToTransactions: ['DISPENSE', 'ONLINE_DISPENSE'],
    parameters: {
      fields: [
        'PATIENT_NAME',
        'SUPPLYING_PREMISES',
        'DISPENSING_DATE',
        'DIRECTIONS_FOR_USE',
        'PRODUCT_NAME',
        'ACTIVE_INGREDIENT_PARTICULARS',
      ],
      detail:
        'All six particulars, in English. “Supplying premises” is the name, address and any ' +
        'identification number or logo of the licensed retail pharmacy, or of the healthcare ' +
        'service licensee under its business name — including where the supply is by delivery or ' +
        'through a remote service kiosk. The active-ingredient particulars are required only ' +
        'where the label carries the appropriate non-proprietary name rather than the ' +
        'proprietary one.',
    },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, reg 17(1)',
  },

  /*
   * Regulations 16(3) and 17(2) — two years, for a prescribed therapeutic
   * product; regulation 13(3) — two years, for a pharmacy-only medicine.
   *
   * ⚠️ TWO RULES RATHER THAN ONE BECAUSE THEY ARE TWO OBLIGATIONS IN TWO
   *   REGULATIONS THAT HAPPEN TO AGREE ON THE NUMBER. Regulation 16 keeps the
   *   record of a supply made on a practitioner's prescription; regulation 13(2)
   *   keeps a record of a pharmacy-only supply made without one, and its
   *   particulars are different — it wants the purpose of the treatment, which
   *   regulation 16 does not. Merging them into an unclassified rule would also
   *   apply a two-year period to a controlled drug, which keeps records for
   *   three.
   */
  {
    code: 'SG-RETAIN-POM',
    ruleType: 'RECORD_RETENTION',
    statement:
      'Keep the record of this supply, and the prescription it was made on, for at least two ' +
      'years after the date of supply.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.prescriptionOnly,
    appliesToTransactions: [],
    parameters: {
      years: 2,
      fields: [
        'DATE_OF_SUPPLY',
        'PATIENT_NAME_AND_IDENTIFICATION',
        'PATIENT_CONTACT_DETAILS',
        'PRODUCT_NAME_AND_TOTAL_AMOUNT',
        'PRESCRIBER_NAME_AND_ADDRESS',
      ],
      detail:
        'The record is made on the day of supply or, where that is not reasonably practicable, ' +
        'within 24 hours after it, kept at the premises the product was supplied from, and ' +
        'produced to the Authority on demand. The prescriber’s name and address are required ' +
        'where the supply was by or under the supervision of a qualified pharmacist or at or ' +
        'from a licensed retail pharmacy. The marked prescription itself is retained for two ' +
        'years after dispensing — or, where it was repeated, two years after the last time.',
    },
    citation:
      'Health Products (Therapeutic Products) Regulations 2016, regs 16(1)–16(3), 17(2)(a)(ii), 17(2)(b)(iii)',
  },
  {
    code: 'SG-RETAIN-PHARMACY-ONLY',
    ruleType: 'RECORD_RETENTION',
    statement:
      'Keep the record of a pharmacy-only medicine supply, including the purpose of the ' +
      'treatment, for at least two years after the date of supply.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.pharmacyOnly,
    appliesToTransactions: [],
    parameters: {
      years: 2,
      fields: [
        'DATE_OF_SUPPLY',
        'PATIENT_NAME_AND_IDENTIFICATION',
        'PATIENT_CONTACT_DETAILS',
        'PRODUCT_NAME_STRENGTH_AND_TOTAL_AMOUNT',
        'DOSAGE',
        'FREQUENCY_AND_PURPOSE_OF_TREATMENT',
      ],
      detail:
        'Made on the day of supply or within 24 hours after it, kept at the premises, and ' +
        'produced to the Authority on demand. ⚠️ This obligation does not apply where the ' +
        'pharmacy-only medicine is administered to or applied in a person in the course of ' +
        'diagnosis, treatment or a test — reg 13(5).',
    },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, regs 13(2)–13(4)',
  },

  /*
   * Regulation 14(1)(a) — codeine cough preparations, liquid form.
   *
   * ⚠️ 240 ml IS A QUANTITY OF PREPARATION AND IS THEREFORE EXPRESSIBLE; THE
   *   OTHER LIMB OF THE SAME REGULATION IS NOT. See the file header. This rule
   *   is regulation 14(1)(a) and nothing else.
   *
   * ⚠️ `maxPerPeriodBase` MAKES EVERY SUPPLY OF THIS PRODUCT `UNDETERMINED`
   *   UNTIL THE CALLER CAN SAY WHAT THE PATIENT HAS ALREADY HAD, AND THAT IS THE
   *   INTENDED COST. `evaluateQuantityLimit` refuses to read a missing
   *   `priorQuantityInPeriodBase` as zero, because "we did not check" is not
   *   "they have had none" — and the caller who cannot answer is precisely the
   *   one whose patient history is incomplete. A per-transaction cap would be
   *   readable everywhere and would say something regulation 14 does not: the
   *   limit is an AGGREGATE over seven days, and one 240 ml bottle a day would
   *   satisfy a per-transaction reading of it.
   *
   * ⚠️ AND THE UNIT IS THE PRODUCT'S BASE UNIT, WHICH THE PACK CANNOT ENFORCE. A
   *   clinic that files a linctus in bottles rather than millilitres gets a
   *   limit of 240 BOTTLES. That is the identifier-and-unit debt this programme
   *   carries throughout, not something this rule can fix; the statement names
   *   millilitres so a refusal at least reads honestly.
   */
  {
    code: 'SG-QTY-CODEINE-LIQUID',
    ruleType: 'QUANTITY_LIMIT',
    statement:
      'Not more than 240 ml of codeine cough preparations in liquid form may be supplied to one ' +
      'individual within any period of 7 days.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.codeineCoughLiquid,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { maxPerPeriodBase: '240.000000', periodDays: 7 },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, reg 14(1)(a)',
  },

  /*
   * ⚠️ A CODEINE LINCTUS IS ALSO A PRESCRIPTION-ONLY MEDICINE, AND THIS RULE IS
   *   THE PRICE OF A SINGLE-STRING CLASSIFICATION. A product filed under
   *   `CODEINE_COUGH_PREPARATION_LIQUID` does not match `SG-RX-POM`, so without
   *   this rule the quantity cap would be the only thing standing between a
   *   customer and a bottle of it. Regulation 11 applies to it as much as to any
   *   other prescription-only medicine.
   *
   * ⚠️ IT IS NOT A SECOND READING OF REGULATION 11 — IT IS THE SAME READING,
   *   WRITTEN TWICE BECAUSE THE PRODUCT CAN ONLY BE FILED ONCE. If the framework
   *   ever grows a second classification axis, this rule is the one to delete.
   */
  {
    code: 'SG-RX-CODEINE-LIQUID',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A codeine cough preparation is a prescription-only medicine and may be supplied only on ' +
      'the prescription or instructions of a qualified practitioner or collaborative prescribing ' +
      'practitioner. Counselling on its use must be given on each occasion of supply.',
    sourceKey: 'SG_THERAPEUTIC_PRODUCTS',
    appliesToClassification: SG_CLASSIFICATIONS.codeineCoughLiquid,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true },
    citation: 'Health Products (Therapeutic Products) Regulations 2016, regs 11, 14(2)',
  },

  /*
   * ── Controlled drugs ──────────────────────────────────────────────────────
   *
   * Regulation 12(1) — a controlled drug may not be supplied on a prescription
   * "before the date specified in the prescription and later than 30 days after"
   * it.
   *
   * ⚠️ 30 DAYS IS A DAY COUNT IN THE REGULATION ITSELF, SO `validityDays` IS THE
   *   RIGHT KEY AND `validityMonths` WOULD BE WRONG. Survey GAP 1 is about
   *   jurisdictions that state validity in calendar MONTHS; Singapore states it
   *   in days, like Britain's 28 and Ireland's 14. Converting it to "a month"
   *   would extend it by a day in most months.
   *
   * ⚠️ THE "NOT BEFORE THE DATE" LIMB IS ALSO ENFORCED, AND NOT BY THIS
   *   PARAMETER. `evaluatePrescriptionRequired` refuses a prescription dated
   *   after the day it is being dispensed whenever a validity is stated at all —
   *   which is the same prohibition arrived at from the other direction, and is
   *   why setting `validityDays` here buys both halves of regulation 12(1).
   */
  ...CONTROLLED_SCHEDULES.map(({ key, classification, name }) => ({
    code: `SG-RX-${key}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `A ${name} controlled drug may be supplied on a prescription only, not before the date on ` +
      'the prescription and not later than 30 days after it, and only where the prescription ' +
      'complies with regulation 11 and gives an address in Singapore.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityDays: 30 },
    citation: 'Misuse of Drugs Regulations, regs 12(1) and 11(1)',
  })),

  /*
   * Regulation 2 — who may issue a prescription for a controlled drug.
   *
   * ⚠️ THE ENGINE CANNOT CHECK REGULATION 11's FORM REQUIREMENTS AND MUST NOT
   *   PRETEND TO. Regulation 11(1) requires the dose, the form, the strength and
   *   the total quantity to be written IN THE PRESCRIBER'S OWN HANDWRITING and
   *   the quantity in both words and figures — facts about a piece of paper that
   *   this platform does not hold and could not verify if it did. What is
   *   checkable is who signed it, so that is what this rule says, and the
   *   statement names the rest so a pharmacist reading the reason knows the
   *   check is theirs.
   */
  ...CONTROLLED_SCHEDULES.map(({ key, classification, name }) => ({
    code: `SG-PRESCRIBER-${key}`,
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      `A prescription for a ${name} controlled drug must be issued by a medical practitioner, a ` +
      'dentist, a veterinary surgeon or a collaborative prescribing practitioner, and must be ' +
      'signed, dated and — for the dose, form, strength and total quantity — written in the ' +
      'prescriber’s own handwriting.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: CONTROLLED_DRUG_PRESCRIBERS },
    citation: 'Misuse of Drugs Regulations, regs 2(1) and 11(1)',
  })),

  /*
   * Regulations 7(2) and 8(2) — who may supply a Second or Third Schedule drug.
   * See `CONTROLLED_DRUG_SUPPLIERS` for what is on the list and what is not.
   */
  ...[
    {
      key: 'CD2',
      classification: SG_CLASSIFICATIONS.controlledSecond,
      name: 'Second Schedule',
      citation: 'Misuse of Drugs Regulations, reg 7(2)',
    },
    {
      key: 'CD3',
      classification: SG_CLASSIFICATIONS.controlledThird,
      name: 'Third Schedule',
      citation: 'Misuse of Drugs Regulations, reg 8(2)',
    },
  ].map(({ key, classification, name, citation }) => ({
    code: `SG-SUPPLY-${key}`,
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      `A ${name} controlled drug may be supplied only by a practitioner, a pharmacist, a person ` +
      'lawfully conducting a retail pharmacy business, a collaborative prescribing practitioner ' +
      'or a ward nurse in charge. Hand this to one of them.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedLicenceTypes: CONTROLLED_DRUG_SUPPLIERS },
    citation,
  })),

  /*
   * Regulation 8A — the Fourth Schedule, and the one rule in this pack that
   * exists in order to REFUSE.
   *
   * ⚠️ THIS IS A `PHARMACIST_AUTHORITY` RULE THAT NAMES NO PHARMACIST, WHICH
   *   LOOKS WRONG AND IS THE MOST FAITHFUL READING AVAILABLE. Regulation 8A
   *   lists who may supply a Fourth Schedule drug — an approved researcher, a
   *   laboratory custodian, an HSA or DSO analyst, an inspector — and a
   *   pharmacist is conspicuously absent, unlike regulations 7(2) and 8(2) which
   *   name one. So a Fourth Schedule drug is not a medicine that a dispensing
   *   point may hand to a patient at all, and the honest way to say that with
   *   the rule types this framework has is an authority rule whose list nobody
   *   at a counter can satisfy.
   *
   * ⚠️ A `permitted: false` RULE TYPE WOULD BE THE HONEST SHAPE AND DOES NOT
   *   EXIST. Recorded in KNOWN_ISSUES rather than invented here: adding a rule
   *   type is a framework change and belongs in a framework phase, and this
   *   rule's OUTCOME — a refusal, with a statement that says why — is correct
   *   today. What is imperfect is the reason text saying "hand this to" a person
   *   the clinic does not employ.
   */
  {
    code: 'SG-SUPPLY-CD4',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A Fourth Schedule controlled drug may be supplied only by a researcher approved by the ' +
      'Director, a person in charge of an approved laboratory’s controlled drugs, an analyst of ' +
      'the Health Sciences Authority or DSO National Laboratories, or an inspector. It is not a ' +
      'medicine a dispensing point may supply to a patient.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: SG_CLASSIFICATIONS.controlledFourth,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      permittedLicenceTypes: [
        'DIRECTOR_APPROVED_RESEARCHER',
        'APPROVED_LABORATORY_CUSTODIAN',
        'HSA_ANALYST',
        'DSO_ANALYST',
        'MISUSE_OF_DRUGS_INSPECTOR',
      ],
    },
    citation: 'Misuse of Drugs Regulations, reg 8A',
  },

  /*
   * Regulations 14 and 15 — the register, for the Second and Fourth Schedules.
   *
   * ⚠️ THE THIRD SCHEDULE GETS A RULE WITH NO REGISTER, AND ITS EMPTINESS IS THE
   *   POINT. Regulation 14(1) binds "every person authorised ... to supply any
   *   drug specified in the Second or Fourth Schedule" and says nothing about
   *   the Third. Setting `registerRequired` on all three would impose a bound
   *   book on a schedule the Regulations exempt; omitting the Third Schedule
   *   rule entirely would lose the one thing it does say, which is that this is
   *   a controlled drug at all. `evaluateControlledSchedule` permits with an
   *   empty condition list and a reason naming the schedule, and that reason is
   *   the value — without it a Third Schedule supply would come back
   *   indistinguishable from an ordinary one.
   *
   * ⚠️ AND `RECORD_IN_CONTROLLED_REGISTER` IS RAISED AGAINST A REGISTER RCLN
   *   CANNOT BE. Regulation 2(1) defines "register" as "a bound book" and says
   *   it "does not include any form of loose leaf register or card index" — so
   *   the obligation this condition carries is discharged on paper, at the
   *   premises, in ink, by hand, and a screen that renders it as a tick-box has
   *   recorded that somebody ticked a box. The condition is correct; what it
   *   asks for is not something this platform can hold.
   *
   * ⚠️ NO `priorAuthorisationRequired`. Nothing in these Regulations requires a
   *   permit obtained from somebody else before a controlled drug is supplied,
   *   the way a Victorian Schedule 8 treatment permit does. The key stays absent
   *   rather than being set to look thorough.
   */
  ...[
    {
      key: 'CD2',
      classification: SG_CLASSIFICATIONS.controlledSecond,
      name: 'Second Schedule',
      register: true,
    },
    {
      key: 'CD3',
      classification: SG_CLASSIFICATIONS.controlledThird,
      name: 'Third Schedule',
      register: false,
    },
    {
      key: 'CD4',
      classification: SG_CLASSIFICATIONS.controlledFourth,
      name: 'Fourth Schedule',
      register: true,
    },
  ].map(({ key, classification, name, register }) => ({
    code: `SG-SCHEDULE-${key}`,
    ruleType: 'CONTROLLED_SCHEDULE',
    statement: register
      ? `This is a ${name} controlled drug. Enter every quantity obtained and every quantity ` +
        'supplied in the controlled drugs register for its class, on the day it happens or the ' +
        'next day, in ink, and never by altering an earlier entry.'
      : `This is a ${name} controlled drug. Its supply, possession and storage are restricted ` +
        'under the Misuse of Drugs Regulations, which require no register for this schedule.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: register
      ? { scheduleName: `${name} (Misuse of Drugs Regulations)`, registerRequired: true }
      : { scheduleName: `${name} (Misuse of Drugs Regulations)` },
    citation: register
      ? 'Misuse of Drugs Regulations, regs 14(1), 15 and 2(1)'
      : 'Misuse of Drugs Regulations, regs 8 and 14(1) — which names the Second and Fourth Schedules only',
  })),

  /*
   * Regulation 20 — storage.
   *
   * ⚠️ `controlledAccessRequired: true` AND NO `locationKinds`, WHICH IS THE
   *   VICTORIAN CALL MADE AGAIN AND FOR A REASON WRITTEN INTO THE REGULATION
   *   ITSELF. Regulation 20(1) demands "a safe, cabinet OR ROOM that is
   *   constructed for the storage of the controlled drugs", in the dispensary or
   *   premises under the control of a pharmacist. A room qualifies, so an
   *   allow-list of `CONTROLLED_CABINET` would refuse goods receipt into a
   *   locked dispensary that satisfies the regulation exactly. What regulation
   *   20(2) does demand of every one of them is a lock — physical, electronic or
   *   biometric — and `requires_controlled_access` on the location is that fact.
   *
   * ⚠️ THE KEY-CUSTODY OBLIGATIONS OF REGULATION 20(3) ARE IN THE `detail` AND
   *   ARE NOT CHECKED. Whether the pharmacist keeps the key on their person, or
   *   has disclosed the access code, is not a fact any software holds. Saying so
   *   in the condition is honest; asking somebody to tick it would manufacture
   *   evidence of a check nobody did.
   */
  ...CONTROLLED_SCHEDULES.map(({ key, classification, name }) => ({
    code: `SG-STORE-${key}`,
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      `Keep all stocks of ${name} controlled drugs in a safe, cabinet or room constructed for ` +
      'storing them and kept locked, in the dispensary or other premises under the control of a ' +
      'pharmacist or the person authorised to supply them.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: ['STOCK', 'TRANSFER', 'DISPENSE', 'COUNTER_SALE'],
    parameters: {
      controlledAccessRequired: true,
      detail:
        'A safe, cabinet or room constructed for the storage of controlled drugs and maintained ' +
        'to prevent unauthorised access, locked with a physical lock and key, an electronic ' +
        'access control system or a biometric one. The pharmacist or authorised person must keep ' +
        'the key or access card in their personal possession at all times, must not disclose the ' +
        'access code, and must ensure only their own particulars are enabled on a biometric ' +
        'system. Where the stock is for a ward, theatre or department, it is held in the hospital ' +
        'premises under the control of the nurse in charge of it.',
    },
    citation: 'Misuse of Drugs Regulations, regs 20(1), 20(2) and 20(3)',
  })),

  /*
   * Regulation 17 — three years, against the therapeutic products' two.
   *
   * ⚠️ THIS IS NOT A SUPERSESSION AND MUST NOT BE READ AS ONE. California's
   *   three years displaces a federal two years of the same rule type in the
   *   same place; this three years and `SG-RETAIN-POM`'s two years are two rules
   *   of one type in ONE pack, separated by classification, and both are live
   *   for their own products. `mostSpecific` prefers the highest specificity
   *   within a type — both name a classification, so both score 4 — and the
   *   classification filter has already decided which one a given product sees.
   *   A product filed under both spellings would be a single string, and it
   *   cannot be.
   */
  ...CONTROLLED_SCHEDULES.map(({ key, classification, name }) => ({
    code: `SG-RETAIN-${key}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      `Keep the ${name} register, and every requisition, order or prescription on which one of ` +
      'these drugs was supplied, for three years — the register from its last entry, the ' +
      'prescription from the last delivery made under it.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: [],
    parameters: {
      years: 3,
      detail:
        'Three years, running from the date of the last entry in the register and, for a ' +
        'requisition, order or prescription, from the date of the last delivery made under it. ' +
        '⚠️ Longer than the two years the Health Products (Therapeutic Products) Regulations ' +
        'require of a prescription-only medicine record, so a controlled drug that is also a ' +
        'prescription-only medicine keeps its papers for three.',
    },
    citation: 'Misuse of Drugs Regulations, regs 17(1) and 17(2)',
  })),

  /*
   * Regulation 28 — destruction, for the Second and Fourth Schedules.
   *
   * ⚠️ `witnessRequired` IS THE WHOLE RULE, AND THE WITNESS IS AN INSPECTOR
   *   RATHER THAN A COLLEAGUE. Victoria lets a second registered health
   *   practitioner witness a Schedule 8 destruction; regulation 28(1) requires
   *   the destruction to happen "in the presence of and in accordance with any
   *   directions given by an inspector or such other person as the Minister may
   *   authorise", and regulation 28(2) requires that person to SIGN the record.
   *   So this condition cannot be discharged inside the pharmacy at all, and the
   *   `method` says who has to be standing there.
   *
   * ⚠️ THE THIRD SCHEDULE IS ABSENT AGAIN, FOR THE SAME REASON AS THE REGISTER.
   *   Regulation 28(1) binds a person "required ... to keep records with respect
   *   to a drug specified in the Second or Fourth Schedule", which by regulation
   *   14(1) is the register-keeping schedules and not the Third.
   */
  ...[
    { key: 'CD2', classification: SG_CLASSIFICATIONS.controlledSecond, name: 'Second Schedule' },
    { key: 'CD4', classification: SG_CLASSIFICATIONS.controlledFourth, name: 'Fourth Schedule' },
  ].map(({ key, classification, name }) => ({
    code: `SG-DISPOSE-${key}`,
    ruleType: 'DISPOSAL_REQUIREMENT',
    statement:
      `A ${name} controlled drug may be destroyed only in the presence of, and following the ` +
      'directions of, an inspector or another person the Minister authorises. Destroying one ' +
      'otherwise is an offence.',
    sourceKey: 'SG_MISUSE_OF_DRUGS',
    appliesToClassification: classification,
    appliesToTransactions: ['DISPOSE'],
    parameters: {
      witnessRequired: true,
      method:
        'Destruction in the presence of, and in accordance with the directions of, an inspector ' +
        'appointed under regulation 21 or another person authorised by the Minister.',
      detail:
        'Record the date of destruction and the quantity destroyed in the register entry for the ' +
        'drug, and have the record signed by the inspector or authorised person in whose ' +
        'presence it was destroyed.',
    },
    citation: 'Misuse of Drugs Regulations, regs 28(1) and 28(2)',
  })),
];
