/**
 * IRELAND — national rule pack `IE` 1.0.0, read from the Irish Statute Book.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from the Office of the Attorney
 *   General's own publication of each instrument and cited regulation by
 *   regulation, reviewed by nobody qualified. The pack's maturity says so.
 *
 * ── THE FIRST JURISDICTION IN THIS PROGRAMME THAT FORBIDS REMOTE SUPPLY ──────
 * ⚠️ AND IT IS THE REASON THE PACK WAS WORTH WRITING NOW. Every pack before this
 *   one either said nothing about remote supply (India, Australia, Singapore) or
 *   conditioned it (the United States, 21 U.S.C. 829(e)). Ireland prohibits it
 *   outright, in words that need no reading between:
 *
 *     19.(1) A person shall not supply by mail order any medicinal product.
 *     19.(5) The provisions of this Regulation shall also apply to the supply,
 *            by way of information society service, of medicinal products which
 *            ... may only be supplied on foot of a prescription.
 *     19A.(8) Nothing in this Regulation shall be construed as permitting ...
 *            (b) the supply of a medicinal product subject to prescription
 *            control in the State at a distance to the public by means of
 *            information society services to a person in the State.
 *
 *   So every prescription-controlled classification below carries an
 *   `ONLINE_DISPENSING` rule with `permitted: false`, which `REFUSES`. That is
 *   the first `permitted: false` remote-supply rule in the programme, and it is
 *   worth knowing it exists before somebody reads PI-12's gate as belt on top of
 *   brace: the two gates answer different questions, and here they agree.
 *
 * ⚠️ NON-PRESCRIPTION DISTANCE SELLING IS PERMITTED AND CONDITIONED, WHICH IS
 *   WHAT FORCED ONE FRAMEWORK KEY. Regulation 19A(1) permits it only from a
 *   supplier "entered on the ISS supply list" that the Pharmaceutical Society of
 *   Ireland keeps. Written with the keys that existed before PI-18, the closest
 *   available rule was a bare `permitted: true` — which asserts the opposite of
 *   the regulation, exactly as `permitted: true` alone once asserted the
 *   opposite of 829(e). `requiresDistanceSellingAuthorisation` raises the
 *   registration as a `VERIFY_PRIOR_AUTHORISATION` condition instead; it is the
 *   same shape as `priorAuthorisationRequired` and deliberately not a second
 *   idea.
 *
 * ── WHERE EVERY RULE BELOW CAME FROM ─────────────────────────────────────────
 * Four instruments, each read directly on irishstatutebook.ie:
 *
 *   The Medicinal Products (Prescription and Control of Supply) Regulations 2003
 *   (S.I. No. 540 of 2003) — prescription control, the particulars of a
 *   prescription, repeats, validity, the dispensing label, pharmacy records, and
 *   the mail-order prohibition.
 *
 *   The Misuse of Drugs Regulations 2017 (S.I. No. 173 of 2017) — controlled
 *   drugs: the form of a prescription, the fourteen days, the register, the
 *   two-year retention and witnessed destruction.
 *
 *   The Misuse of Drugs (Safe Custody) Regulations 1982 (S.I. No. 321 of 1982) —
 *   the safe.
 *
 *   The Regulation of Retail Pharmacy Businesses Regulations 2008 (S.I. No. 488
 *   of 2008) — who may hand a medicine over.
 *
 * ⚠️ IRELAND PUBLISHES NO CONSOLIDATION OF AN S.I., AND THAT IS THE SHARPEST
 *   RESEARCH HAZARD IN THIS FILE. The 2003 Regulations have been amended more
 *   than forty times and the eISB serves each amendment separately; the text
 *   under `/made/` is the text of 2003 and says nothing about what has since
 *   been substituted out of it. Three amendments bear on rules written here and
 *   all three were read in full rather than inferred — S.I. No. 201 of 2007
 *   (registered nurses as prescribers), S.I. No. 87 of 2015 (regulation 19(5)
 *   and the whole of 19A), and S.I. No. 73 of 2024 (the substitution of
 *   regulation 7(5)(a)). Each is its own source row.
 *
 *   The rest were checked for whether they touch regulations 5, 6, 7, 9, 10, 17,
 *   18, 19 or 20 and read where they do. ⚠️ THAT IS A CHECK, NOT A GUARANTEE.
 *   A reviewer closing `SOURCE_VERIFIED` has to walk the whole chain, and the
 *   honest statement of this pack's exposure is that a substitution nobody
 *   noticed reads exactly like a rule nobody amended.
 *
 * ── THE VALIDITY THAT IS SIX MONTHS AND MAY LAWFULLY BE TWELVE ───────────────
 * ⚠️ THE PATTERN PI-17 ASKED THE NEXT PHASE TO CARRY: A GATE CONDITIONAL ON A
 *   FACT THE PLATFORM DOES NOT MODEL. Regulation 7(5)(a), as substituted by
 *   S.I. No. 73 of 2024 with effect from 1 March 2024, is two limbs:
 *
 *     (i)  six months from the date on the prescription, or
 *     (ii) save for a controlled drug in Schedule 2, 3 or 4, a greater period up
 *          to twelve months where that period is specified ON the prescription,
 *          or where a registered pharmacist decides it is appropriate under
 *          regulation 9A(1) of the Regulation of Retail Pharmacy Businesses
 *          Regulations 2008.
 *
 *   rcln holds neither fact. `PresentedPrescription` has no "validity period the
 *   prescriber wrote on it" and no record of a pharmacist's regulation 9A
 *   review, so limb (ii) is not expressible and every rule below states limb (i).
 *
 * ⚠️ WHICH MEANS THIS PACK REFUSES ON DAY 183 A DISPENSE THAT MAY WELL BE
 *   LAWFUL, AND THAT IS THE REFUSING DIRECTION NOBODY AUDITS — the same failure
 *   mode `validityMonths` itself was added to prevent. It is written this way
 *   anyway because the alternative is `validityMonths: 12`, which would permit,
 *   silently, the far larger set of prescriptions on which nobody specified
 *   anything and no pharmacist reviewed anything. The rule statements say the
 *   extension exists so the person reading the refusal knows what to look for,
 *   and the missing field is recorded in KNOWN_ISSUES. **The fix is the field,
 *   not a bolder reading.**
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO PART C CLASSIFICATION, AND ITS ABSENCE IS A REFUSAL RATHER THAN A GAP.
 *   Regulation 7(6) says a prescription for a First Schedule Part C substance
 *   "shall not be dispensed except in a hospital". That is a restriction on the
 *   PREMISES, and rcln has no `branch.licence_type` — the fourth jurisdiction in
 *   four phases to ask for the same missing fact, after Singapore's retail
 *   pharmacy versus clinic, Dubai's hospital inpatient and emergency units, and
 *   Abu Dhabi's licensed facility categories.
 *
 *   The tempting move is to define `PRESCRIPTION_ONLY_PART_C` anyway and give it
 *   the ordinary prescription rules. That would be worse than defining nothing:
 *   a clinic would file a Part C product under it and a community pharmacy would
 *   get a clean `PERMITTED` for a supply regulation 7(6) forbids. With no
 *   classification for it, a Part C product matches no rule in this pack,
 *   resolves `UNDETERMINED`, and refuses. Silence that refuses is the only kind
 *   this programme permits.
 *
 * ⚠️ NO FALSIFIED MEDICINES TRACEABILITY RULE. Commission Delegated Regulation
 *   (EU) 2016/161 is directly applicable in Ireland and obliges a pharmacy to
 *   verify and decommission the unique identifier on a prescription medicine —
 *   which is a `TRACEABILITY_REQUIREMENT`, the one rule type no pack in this
 *   programme yet uses. Its consolidated text could not be retrieved in this
 *   pass: eur-lex.europa.eu answers `202` with a client-side challenge on every
 *   path attempted. No source, no rule — the same discipline as the DSCSA gap in
 *   the United States pack and the Customs (Prohibited Imports) gap in
 *   Australia's. The matrix cell stays `RESEARCH_REQUIRED`.
 *
 *   ⚠️ AND THERE IS A SECOND REASON TO BE GLAD IT WAS NOT GUESSED.
 *   `evaluateTraceability` REFUSES on a missing identifier, and
 *   `createDispenseWithin` passes lot, expiry and serial but no GTIN. A rule
 *   written from memory as `requiredIdentifiers: ['GTIN', 'SERIAL', 'LOT',
 *   'EXPIRY']` would have refused every Irish dispense on the platform, for a
 *   field the caller simply never sends.
 *
 * ⚠️ NO CONTAINER-MARKING RULE FOR CONTROLLED DRUGS, AND THIS ONE IS A TRAP.
 *   Regulation 17 of the Misuse of Drugs Regulations 2017 requires a controlled
 *   drug's container to be marked with the drug's name and the amount of each
 *   controlled component — and regulation 17(2)(d) then disapplies the whole of
 *   it from "the supply of a controlled drug by or on the prescription of a
 *   practitioner", which is every dispense this platform performs. A rule
 *   written from regulation 17(1) alone would impose on a dispensing label a
 *   requirement the same regulation lifts from it two paragraphs later.
 *
 * ⚠️ NO REPORTING RULE. Regulation 24 requires particulars to be furnished ON
 *   DEMAND by the Minister, within fourteen days of a written demand. There is
 *   no periodic return of the kind Abu Dhabi and Dubai file monthly and
 *   quarterly, and a `REPORTING_REQUIREMENT` rule raises its condition on every
 *   evaluation — so writing one would attach a standing obligation to every
 *   Irish transaction to describe a demand that has not been made.
 *
 * ⚠️ NO SCHEDULE 1 RULES. Schedule 1 drugs need a licence granted by the
 *   Minister under section 14 of the Misuse of Drugs Act 1977 and are not
 *   dispensed in a clinic pharmacy. The same call the Australian pack makes
 *   about Schedules 9 and 10: a pack rule for them would model as routine a
 *   supply this platform must never treat as routine.
 *
 * ⚠️ NO SCHEDULE 4 PART 2 OR SCHEDULE 5 CLASSIFICATION. Regulations 15 and 16 —
 *   the form of a prescription and the fourteen days — carve both out by name,
 *   so the Misuse of Drugs Regulations impose no supply rule on them at all.
 *   What governs their supply is their status under the 2003 Regulations, and
 *   they are classified there: an anabolic steroid is a First Schedule Part A or
 *   Part B substance and is filed as one. Giving them a controlled-drug
 *   classification of their own would take them OUT of the rules that actually
 *   bind them, because `mostSpecific` decides per classification.
 *
 * ⚠️ NO EMERGENCY-SUPPLY RULE. Regulation 8 permits supply without a
 *   prescription at a practitioner's request, or on the pharmacist's own
 *   judgement with a five-day ceiling. Both are exceptions to a prohibition
 *   rather than rules of their own, and this framework has no way to say "the
 *   prescription requirement stands down because an emergency was recorded". A
 *   `QUANTITY_LIMIT` of five days' supply would need `maxDaysSupply`, which no
 *   caller can answer, and would then apply to every supply rather than to the
 *   emergency ones. Recorded in KNOWN_ISSUES.
 *
 * ⚠️ NO SUB-NATIONAL PACK, AND — UNUSUALLY FOR THIS PROGRAMME — NO PROSPECT OF
 *   ONE. Irish medicines and misuse-of-drugs law is made by the Minister for
 *   Health and applies in the whole State; a county regulates nothing here. So
 *   `CountryInfo.regions` being empty for `IE` leaves nothing inert, which is
 *   the first time that check has come back clean. See KNOWN_ISSUES for the one
 *   loose end it leaves: `labels.region` for `IE` says 'County', and no county
 *   can be selected.
 *
 * ── HOW TO CHANGE A RULE ─────────────────────────────────────────────────────
 * You do not edit one. A change is a NEW row with a new `version` and a new
 * `effectiveFrom`, and the old one gets an `effectiveTo` and `SUPERSEDED`.
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/**
 * The day this pack becomes evaluable.
 *
 * ⚠️ NOT THE DAY ANY OF THESE INSTRUMENTS COMMENCED. The 2003 Regulations came
 *   into operation on 11 November 2003 and the Safe Custody Regulations on
 *   1 March 1983; those dates live on the SOURCE rows, which is where a reader
 *   should look for them.
 */
export const IE_PACK_EFFECTIVE_FROM = '2026-08-20';

export const IE_AUTHORITIES = [
  {
    code: 'HPRA',
    name: 'Health Products Regulatory Authority',
    websiteUrl: 'https://www.hpra.ie/',
    remit:
      'Ireland’s national medicines regulator, established as the Irish Medicines Board under the ' +
      'Irish Medicines Board Act 1995 and renamed by S.I. No. 87 of 2015. Authorises medicinal ' +
      'products, decides their prescription status, and enforces the Medicinal Products ' +
      '(Prescription and Control of Supply) Regulations 2003. ⚠️ It does not regulate ' +
      'pharmacists or pharmacies — that is the Pharmaceutical Society of Ireland.',
  },
  {
    code: 'PSI',
    name: 'Pharmaceutical Society of Ireland',
    websiteUrl: 'https://www.psi.ie/',
    remit:
      'The pharmacy regulator, established under the Pharmacy Act 2007. Registers pharmacists and ' +
      'retail pharmacy businesses, makes the Regulation of Retail Pharmacy Businesses Regulations ' +
      '2008 operative, and keeps the ISS supply list of pharmacies entitled to sell ' +
      'non-prescription medicines at a distance under regulation 19A.',
  },
  {
    code: 'DOH_IE',
    name: 'Department of Health',
    websiteUrl: 'https://www.gov.ie/en/organisation/department-of-health/',
    remit:
      'The Minister for Health makes the Misuse of Drugs Regulations under the Misuse of Drugs ' +
      'Act 1977 and grants the section 14 licences that authorise anything the Regulations do ' +
      'not. ⚠️ Controlled-drug obligations in Ireland run to the Minister, not to the medicines ' +
      'regulator — the demand for particulars under regulation 24 is the Minister’s.',
  },
] as const;

export const IE_SOURCES: SourceSeed[] = [
  {
    key: 'IE_PCS_2003',
    authorityCode: 'HPRA',
    title: 'Medicinal Products (Prescription and Control of Supply) Regulations 2003',
    documentReference:
      'S.I. No. 540 of 2003, regulations 5, 6, 7, 9, 10, 17, 18, 19 and 20 and the First Schedule',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2003/si/540/made/en/print',
    version: 'As made, 11 November 2003 — see the notes on amendments',
    publishedOn: '2003-11-11',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From the electronic Irish Statute Book, produced by the Office of the Attorney General. ' +
      'Read in full. ⚠️ THE eISB PUBLISHES NO CONSOLIDATION OF AN S.I. — this is the text of ' +
      '2003, and the Regulations have been amended more than forty times since. Every amendment ' +
      'in the collective citation was checked for whether it touches regulations 5, 6, 7, 9, 10, ' +
      '17, 18, 19 or 20; the three that bear on rules in this pack are separate source rows and ' +
      'were read in full. UNVERIFIED means no qualified person has confirmed either the reading ' +
      'or the completeness of that chain.',
  },
  {
    key: 'IE_PCS_2007_NURSES',
    authorityCode: 'HPRA',
    title: 'Medicinal Products (Prescription and Control of Supply) (Amendment) Regulations 2007',
    documentReference: 'S.I. No. 201 of 2007, regulations 3, 4 and 5',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2007/si/201/made/en/print',
    publishedOn: '2007-05-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Substitutes the definition of “prescription” in regulation 4(1) of the 2003 Regulations to ' +
      'add a registered nurse and an equivalent practitioner practising in another Member State, ' +
      'inserts regulations 5A and 5B, and substitutes regulation 7(1)(c). Read in full. ⚠️ THE ' +
      'MEMBER-STATE LIMB CARRIES ITS OWN MAIL-ORDER PROVISO — such a prescription counts only if ' +
      'it "has not been issued with a view to enabling the supply of a medicinal product by mail ' +
      'order", which is regulation 19 reaching back into the definition itself.',
  },
  {
    key: 'IE_PCS_2015_ISS',
    authorityCode: 'HPRA',
    title: 'Medicinal Products (Prescription and Control of Supply) (Amendment) Regulations 2015',
    documentReference: 'S.I. No. 87 of 2015, regulations 7 and 8 — regulation 19(5) and 19A',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2015/si/87/made/en/print',
    version: 'In operation 24 June 2015',
    publishedOn: '2015-06-24',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Extends regulation 19 to supply by information society service of prescription-controlled ' +
      'medicines, and inserts regulation 19A — the ISS supply list, the common logo, the ' +
      'over-18 check, the two-year transaction record, and the four things paragraph (8) says ' +
      'nothing in the regulation permits. Read in full. Implements Article 85c of Directive ' +
      '2001/83/EC and Commission Implementing Regulation (EU) No. 699/2014, neither of which was ' +
      'retrieved.',
  },
  {
    key: 'IE_PCS_2024_VALIDITY',
    authorityCode: 'HPRA',
    title:
      'Medicinal Products (Prescription and Control of Supply) (Amendment) (No. 2) Regulations 2024',
    documentReference: 'S.I. No. 73 of 2024, regulations 4, 5 and 6',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2024/si/73/made/en/print',
    version: 'In operation 1 March 2024',
    publishedOn: '2024-03-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Substitutes regulation 7(5)(a) of the 2003 Regulations with the two-limb validity — six ' +
      'months, or up to twelve where the prescription says so or a pharmacist decides so under ' +
      'regulation 9A(1) of the Regulation of Retail Pharmacy Businesses Regulations 2008, and ' +
      'never for a controlled drug in Schedule 2, 3 or 4. Also deletes regulation 7(2A), the ' +
      'temporary Covid-19 additional supply, and inserts regulation 10E, the record a pharmacist ' +
      'makes when extending. Read in full. ⚠️ ONLY LIMB (i) IS CONFIGURED — see the file header.',
  },
  {
    key: 'IE_MDR_2017',
    authorityCode: 'DOH_IE',
    title: 'Misuse of Drugs Regulations 2017',
    documentReference: 'S.I. No. 173 of 2017, regulations 15, 16, 17, 19, 22, 23, 24 and 25',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2017/si/173/made/en/print',
    publishedOn: '2017-05-11',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Made by the Minister for Health under the Misuse of Drugs Act 1977; revokes and replaces ' +
      'the Misuse of Drugs Regulations 1988. Read in full for the regulations cited. ⚠️ THE ' +
      'SCHEDULE NUMBERS IN OTHER INSTRUMENTS POINT AT REVOKED REGULATIONS AND ARE CARRIED ' +
      'FORWARD BY REGULATION 29(1), which construes a reference to the 1988 Regulations as a ' +
      'reference to these. That chain is why the Safe Custody source below needs its own warning.',
  },
  {
    key: 'IE_SAFE_CUSTODY_1982',
    authorityCode: 'DOH_IE',
    title: 'Misuse of Drugs (Safe Custody) Regulations 1982',
    documentReference: 'S.I. No. 321 of 1982, articles 4, 5 and 6 and the Schedule',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/1982/si/321/made/en/print',
    version: 'In operation 1 March 1983',
    publishedOn: '1983-03-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Article 5 requires a pharmacy to keep Schedule 1, 2 and 3 controlled drugs in a locked ' +
      'safe or cabinet built to the standard in the Schedule — welded sheet steel, a five-lever ' +
      'lock, bolted through an anchor plate, and nothing on the outside saying what is inside. ' +
      '⚠️ THE SCHEDULE NUMBERS ARE THOSE OF THE MISUSE OF DRUGS REGULATIONS 1979, WHICH HAVE ' +
      'BEEN REVOKED TWICE SINCE — by the 1988 Regulations and then by the 2017 Regulations. ' +
      'Regulation 29(1) of the 2017 Regulations carries the 1988 references forward; the step ' +
      'from 1979 to 1988 was not read in this pass and is a real loose end for whoever verifies ' +
      'this source. The rules below are written against the 2017 schedule numbering because that ' +
      'is what a clinic classifies a product under.',
  },
  {
    key: 'IE_RRPB_2008',
    authorityCode: 'PSI',
    title: 'Regulation of Retail Pharmacy Businesses Regulations 2008',
    documentReference: 'S.I. No. 488 of 2008, regulations 4, 5, 9 and 12',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2008/si/488/made/en/print',
    version: 'In force 29 November 2008',
    publishedOn: '2008-11-29',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Made by the Minister under section 18 of the Pharmacy Act 2007. Regulation 5(1)(d) is the ' +
      'personal-supervision requirement this pack’s dispenser rules rest on. Read in full for ' +
      'the regulations cited. ⚠️ REGULATION 9A — the pharmacist’s decision to extend a ' +
      'prescription beyond six months, which S.I. No. 73 of 2024 points at — was NOT read: it ' +
      'was inserted by a later amendment that was not retrieved. Nothing in this pack depends on ' +
      'it, precisely because limb (ii) of regulation 7(5)(a) is not configured.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The classification strings this pack is written against.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`, AND
 *   NOT PARSED, CASE-FOLDED OR TRIMMED — the same discipline every pack in this
 *   programme is written under. A clinic that records "POM" or "Schedule 2"
 *   instead of the strings below has a product no rule here matches, which
 *   resolves `UNDETERMINED` and refuses rather than silently permitting, and
 *   still looks to that clinic like the platform is broken.
 *
 * ⚠️ IRELAND CLASSIFIES A MEDICINE TWICE AND A PRODUCT CAN HOLD ONLY ONE
 *   STRING, WHICH DECIDES THE SHAPE OF THIS WHOLE FILE. A morphine preparation
 *   is both a prescription-only medicine under the 2003 Regulations and a
 *   Schedule 2 controlled drug under the 2017 Regulations. Because
 *   `mostSpecific` selects per classification, a product filed as
 *   `CD_SCHEDULE_2` never sees a rule written against `PRESCRIPTION_ONLY_PART_A`
 *   — so each controlled schedule below carries its OWN complete set of rules,
 *   including the ones that would otherwise have come from the 2003 Regulations.
 *   Dropping one of those from a schedule is not a smaller pack; it is a hole.
 *
 * ⚠️ THE PART A / PART B SPLIT IS THE FIRST SCHEDULE'S OWN, AND IT IS THE ONLY
 *   THING THAT DECIDES WHETHER A PRESCRIPTION REPEATS. Regulation 7(2)(a) gives
 *   a Part A substance one occasion; 7(2)(b) gives a Part B substance as many as
 *   the pharmacist thinks appropriate within the validity. A pack that collapsed
 *   them into one `PRESCRIPTION_ONLY` would have to pick one, and either choice
 *   is wrong for half the First Schedule.
 */
export const IE_CLASSIFICATIONS = {
  /** First Schedule Part A — prescription only, one occasion unless endorsed. */
  prescriptionOnlyPartA: 'PRESCRIPTION_ONLY_PART_A',
  /** First Schedule Part B — prescription only, repeatable within the validity. */
  prescriptionOnlyPartB: 'PRESCRIPTION_ONLY_PART_B',
  /**
   * Prescription only by reason of regulation 5(1)(b) or (c) rather than the
   * First Schedule — anything for parenteral administration, and a new chemical
   * molecule for three years from its authorisation.
   *
   * ⚠️ IT REPEATS LIKE A PART A SUBSTANCE BECAUSE REGULATION 7(4) SAYS SO, NOT
   *   BECAUSE THAT IS THE CAUTIOUS CHOICE. "The prescription in the case of a
   *   medicinal product to which regulation 5(1)(b) or (c) applies shall be
   *   dispensed in accordance with this regulation as it relates to a product
   *   which is or which contains a substance specified in Part A."
   */
  prescriptionOnly: 'PRESCRIPTION_ONLY',
  /** Not prescription controlled, but supplied only through a pharmacy — regulation 6(1). */
  pharmacyOnly: 'PHARMACY_ONLY',
  cdSchedule2: 'CD_SCHEDULE_2',
  cdSchedule3: 'CD_SCHEDULE_3',
  cdSchedule4Part1: 'CD_SCHEDULE_4_PART_1',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/**
 * The three prescription-controlled classifications the 2003 Regulations decide,
 * with the short name used in a rule code and the words the Regulations use.
 */
const PRESCRIPTION_TIERS = [
  {
    key: 'PART-A',
    classification: IE_CLASSIFICATIONS.prescriptionOnlyPartA,
    name: 'First Schedule Part A',
    spoken: 'a Part A prescription only medicine',
  },
  {
    key: 'PART-B',
    classification: IE_CLASSIFICATIONS.prescriptionOnlyPartB,
    name: 'First Schedule Part B',
    spoken: 'a Part B prescription only medicine',
  },
  {
    key: 'POM',
    classification: IE_CLASSIFICATIONS.prescriptionOnly,
    name: 'regulation 5(1)(b) and (c)',
    spoken: 'a prescription only medicine',
  },
] as const;

/**
 * The three controlled schedules a clinic pharmacy dispenses from.
 *
 * `validityDays` is the fourteen days of regulation 16(1)(e)(i); Part 1 of
 * Schedule 4 has none, because regulation 16(3)(b) disapplies that subparagraph
 * and 16(3)(a) sends the dispenser to regulation 7 of the 2003 Regulations
 * instead — which is six months.
 *
 * `registerRequired` follows regulation 19(1), which reaches Schedules 1 and 2
 * and stops there. `safeRequired` follows article 5 of the Safe Custody
 * Regulations, which reaches Schedules 1, 2 and 3 and stops there. ⚠️ THE TWO
 * LISTS ARE DIFFERENT AND NEITHER IS "THE CONTROLLED DRUGS" — a Schedule 3 drug
 * lives in the safe and appears in no register, and a Part 1 Schedule 4 drug
 * does neither.
 */
interface ControlledSchedule {
  key: string;
  classification: string;
  name: string;
  validityDays?: number;
  validityMonths?: number;
  registerRequired: boolean;
  safeRequired: boolean;
  handwritingRequired: boolean;
}

const CONTROLLED_SCHEDULES: readonly ControlledSchedule[] = [
  {
    key: 'CD2',
    classification: IE_CLASSIFICATIONS.cdSchedule2,
    name: 'Schedule 2',
    validityDays: 14,
    registerRequired: true,
    safeRequired: true,
    handwritingRequired: true,
  },
  {
    key: 'CD3',
    classification: IE_CLASSIFICATIONS.cdSchedule3,
    name: 'Schedule 3',
    validityDays: 14,
    registerRequired: false,
    safeRequired: true,
    handwritingRequired: true,
  },
  {
    key: 'CD4A',
    classification: IE_CLASSIFICATIONS.cdSchedule4Part1,
    name: 'Part 1 of Schedule 4',
    validityMonths: 6,
    registerRequired: false,
    safeRequired: false,
    handwritingRequired: false,
  },
];

/**
 * Who may write a prescription for an ordinary medicine, from the definition of
 * “prescription” substituted into regulation 4(1) by S.I. No. 201 of 2007.
 *
 * ⚠️ A PRESCRIBER CLASS, NOT A ROLE CODE, AND NOT A LICENCE TYPE EITHER — see
 *   the warning on `RegulatoryActor`. This is what the PRESCRIBER is registered
 *   as, read off the prescription.
 *
 * ⚠️ THE MEMBER-STATE PRACTITIONER IS ON THIS LIST AND CARRIES THREE PROVISOS
 *   THIS RULE CANNOT CHECK: the address in that Member State must be on the
 *   prescription, the practitioner must not be connected with any practice of
 *   medicine or dentistry in the State, and the prescription must not have been
 *   issued with a view to enabling supply by mail order. Naming the class
 *   without the provisos is the honest half of a rule rather than the whole of
 *   it, and it is on the list because omitting it would refuse a cross-border
 *   prescription the definition expressly admits.
 */
const PRESCRIBER_CLASSES = [
  'REGISTERED_MEDICAL_PRACTITIONER',
  'REGISTERED_DENTIST',
  'REGISTERED_NURSE',
  'EEA_EQUIVALENT_PRACTITIONER',
];

/**
 * Who may write a prescription for a controlled drug, from regulation 15(2)(b).
 *
 * ⚠️ NO MEMBER-STATE PRACTITIONER, AND THAT IS A DIFFERENCE BETWEEN TWO
 *   INSTRUMENTS RATHER THAN AN INCONSISTENCY HERE. Regulation 16(1)(b) forbids
 *   supply "unless the address specified in the prescription as the address of
 *   the practitioner issuing it is an address within the State", which shuts the
 *   cross-border limb that the 2003 Regulations open.
 *
 * ⚠️ A VETERINARY PRACTITIONER IS ON THIS LIST AND IS NOT ON THE ORDINARY ONE,
 *   FOR THE SAME REASON. Regulation 15(2)(b) names one; the definition of
 *   “prescription” in the 2003 Regulations does not.
 */
const CONTROLLED_DRUG_PRESCRIBERS = [
  'REGISTERED_MEDICAL_PRACTITIONER',
  'REGISTERED_DENTIST',
  'REGISTERED_VETERINARY_PRACTITIONER',
  'REGISTERED_NURSE',
  'REGISTERED_MIDWIFE',
];

/**
 * The thirty EEA States a non-prescription medicine may be sent to under
 * regulation 19A(1), and no further.
 *
 * ⚠️ REGULATION 19A(8)(a) IS WHY THIS LIST EXISTS RATHER THAN BEING LEFT OFF.
 *   "Nothing in this Regulation shall be construed as permitting the supply of a
 *   medicinal product at a distance to the public by means of information
 *   society services to a person in a State other than an EEA State." Great
 *   Britain is deliberately absent: it left the EEA, and a parcel to Manchester
 *   is the case the paragraph was rewritten for.
 *
 * ⚠️ AND A DESTINATION MUST BE SUPPLIED OR THE RULE ANSWERS `UNDETERMINED`,
 *   WHICH REFUSES. That is `evaluateOnlineDispensing`'s behaviour and it is the
 *   right one — an order with no delivery country is not an order that can be
 *   shown to be lawful.
 */
const EEA_STATES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IS',
  'IE',
  'IT',
  'LV',
  'LI',
  'LT',
  'LU',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];

/** The sentence every prescription rule ends with, so the six months is never read as final. */
const VALIDITY_NOTE =
  'A prescription may not be dispensed more than six months after its date, unless a longer ' +
  'period of up to twelve months is written on it or a pharmacist has recorded a decision to ' +
  'extend it — neither of which this platform holds, so check the prescription itself before ' +
  'treating this as expired.';

export const IE_RULES: RuleSeed[] = [
  // ── The 2003 Regulations: prescription control ────────────────────────────

  /*
   * Regulation 5(1) — the prohibition — with regulation 7(5)(a) as substituted
   * by S.I. No. 73 of 2024 supplying the validity.
   */
  ...PRESCRIPTION_TIERS.map(({ key, classification, name, spoken }) => ({
    code: `IE-RX-${key}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `A person shall not supply ${spoken} except in accordance with a prescription. ` +
      VALIDITY_NOTE,
    sourceKey: 'IE_PCS_2024_VALIDITY',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityMonths: 6 },
    citation: `S.I. No. 540 of 2003, reg. 5(1) (${name}); reg. 7(5)(a) as substituted by S.I. No. 73 of 2024, reg. 4(c)`,
  })),

  /*
   * Regulation 7(1)(c), as substituted by S.I. No. 201 of 2007 — the
   * prescription must say what the prescriber is registered as.
   *
   * ⚠️ `evaluatePrescriberAuthority` ANSWERS `UNDETERMINED` — WHICH REFUSES —
   *   WHEN `prescription.prescriberClasses` IS ABSENT, and that cost is paid
   *   knowingly. The whole content of regulation 7(1)(c) is that the document
   *   states the class; a platform that dispenses without establishing it has
   *   not read the prescription, it has merely accepted one.
   */
  ...PRESCRIPTION_TIERS.map(({ key, spoken, classification }) => ({
    code: `IE-PRESCRIBER-${key}`,
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      `A prescription for ${spoken} is valid only if it clearly indicates the name of the person ` +
      'issuing it and states whether they are a registered medical practitioner, a registered ' +
      'dentist or a registered nurse — with the nurse’s registration number where it is a nurse ' +
      '— or is issued by an equivalent practitioner practising in another Member State.',
    sourceKey: 'IE_PCS_2007_NURSES',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: PRESCRIBER_CLASSES },
    citation:
      'S.I. No. 540 of 2003, reg. 7(1)(c) as substituted by S.I. No. 201 of 2007, reg. 5; ' +
      'definition of “prescription” in reg. 4(1) as substituted by S.I. No. 201 of 2007, reg. 3',
  })),

  /*
   * Repeats — regulation 7(2).
   *
   * ⚠️ THE ENDORSEMENT HERE IS AN INTERVAL OR A NUMBER WRITTEN ON THE
   *   PRESCRIPTION, AND FOR A PART A SUBSTANCE IT MUST BE IN THE PRESCRIBER'S
   *   OWN HAND. Regulation 7(2)(h): a prescription for a Part A substance or a
   *   regulation 5(1)(b)/(c) product "shall not be a repeatable prescription
   *   unless the intervals of supply or the number of occasions of supply has
   *   been written thereon in the prescriber's own handwriting or prescriber's
   *   own typed script". `repeatsAuthorised` is read off the prescription and
   *   never asserted by the person dispensing — see `PresentedPrescription` —
   *   but whether it was handwritten is not a fact rcln holds, so that limb
   *   lives in the statement rather than in a parameter.
   *
   * ⚠️ `maxEndorsedRepeats: 2` IS "NOT MORE THAN THREE OCCASIONS" COUNTED THE
   *   WAY THIS ENGINE COUNTS. `refillsUsed` is prior supplies, so three
   *   occasions is the original plus two repeats. Writing 3 here would permit
   *   four.
   */
  ...PRESCRIPTION_TIERS.filter(
    (tier) => tier.classification !== IE_CLASSIFICATIONS.prescriptionOnlyPartB
  ).map((tier) => ({
    code: `IE-REPEAT-${tier.key}`,
    ruleType: 'REFILL_RULE',
    statement:
      `A prescription for ${tier.spoken} may be dispensed on one occasion only, unless the ` +
      'prescriber has written the intervals or the number of occasions of supply on it in their ' +
      'own handwriting or their own typed script — and then on not more than three occasions in ' +
      'all where only the intervals are stated.',
    sourceKey: 'IE_PCS_2003',
    appliesToClassification: tier.classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      refillsAllowed: 0,
      endorsedRepeatsPermitted: true,
      maxEndorsedRepeats: 2,
      validityMonths: 6,
    },
    citation: 'S.I. No. 540 of 2003, regs. 7(2)(a), 7(2)(c), 7(2)(h) and 7(4)',
  })),

  /*
   * Part B — regulations 7(2)(b) and 7(2)(d).
   *
   * ⚠️ NO `refillsAllowed`, AND ITS ABSENCE IS THE RULE RATHER THAN AN OMISSION.
   *   A Part B prescription may be dispensed "on such number of occasions within
   *   the period of six months after the date thereon as the person dispensing
   *   the prescription considers appropriate having regard to the specified rate
   *   of dosage". There is no number. The only ceiling the Regulations impose is
   *   the validity, so the validity is the only thing this rule states — and
   *   `parseRefillRule` accepts a rule that states a validity and no count,
   *   precisely so that a jurisdiction shaped this way can be configured
   *   honestly instead of having a plausible number invented for it.
   *
   * ⚠️ THE PHARMACIST'S JUDGEMENT ABOUT THE RATE OF DOSAGE IS NOT MODELLED AND
   *   MUST NOT BE MISTAKEN FOR MODELLED. This rule permits a fourth repeat that
   *   a pharmacist might properly refuse; the regulation makes that their call,
   *   and this platform is not making it for them.
   */
  {
    code: 'IE-REPEAT-PART-B',
    ruleType: 'REFILL_RULE',
    statement:
      'A prescription for a Part B prescription only medicine may be dispensed on as many ' +
      'occasions within its validity as the person dispensing considers appropriate having regard ' +
      'to the rate of dosage specified on it, and at the intervals it states where it states any. ' +
      VALIDITY_NOTE,
    sourceKey: 'IE_PCS_2003',
    appliesToClassification: IE_CLASSIFICATIONS.prescriptionOnlyPartB,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { validityMonths: 6 },
    citation: 'S.I. No. 540 of 2003, regs. 7(2)(b), 7(2)(d) and 7(2)(e)',
  },

  /*
   * Regulation 10(1) and 10(3) — the pharmacy register, and two years.
   *
   * ⚠️ ONE RULE PER CLASSIFICATION RATHER THAN ONE UNCLASSIFIED RULE, BECAUSE
   *   REGULATION 10(1) IS NOT A GENERAL RETENTION OBLIGATION. It bites "every
   *   supply of a medicinal product which by virtue of these Regulations may not
   *   be supplied except in accordance with a prescription" — so it says nothing
   *   about an over-the-counter sale, and an unclassified rule would assert that
   *   it does.
   */
  ...PRESCRIPTION_TIERS.map(({ key, classification }) => ({
    code: `IE-RETAIN-${key}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      'Enter this supply in the pharmacy register, and keep the register and the prescription for ' +
      'two years — the register from its last entry, the prescription from the day it was ' +
      'dispensed for the last time.',
    sourceKey: 'IE_PCS_2003',
    appliesToClassification: classification,
    appliesToTransactions: [],
    parameters: {
      years: 2,
      fields: [
        'DATE_OF_SUPPLY',
        'PRODUCT_NAME_QUANTITY_FORM_AND_STRENGTH',
        'PRESCRIBER_NAME_AND_ADDRESS',
        'PATIENT_NAME_AND_ADDRESS',
        'DATE_OF_PRESCRIPTION',
      ],
      detail:
        'Two years from the relevant date: for the register, the day the last entry was made; ' +
        'for a prescription, the day it was dispensed for the last time. A computerised record ' +
        'satisfies this only if a dated print-out for each day the pharmacy opened is certified ' +
        'by the authorised person managing it, on that day or within twenty-four hours. An ' +
        'electronically transmitted prescription is printed, treated as the original, and both ' +
        'the print and the electronic version are kept.',
    },
    citation:
      'S.I. No. 540 of 2003, regs. 10(1), 10(3), 10(4) and 10(5); reg. 10(7) as inserted by ' +
      'S.I. No. 98 of 2020, reg. 6',
  })),

  /*
   * Regulation 9(2) — the dispensing label.
   *
   * ⚠️ ONE RULE PER CLASSIFICATION, AND THE FIRST DRAFT OF THIS PACK GOT IT
   *   WRONG IN A WAY WORTH RECORDING. Regulation 9(1) defines a "dispensed
   *   medicinal product" by HOW it was supplied rather than by what it is — on a
   *   prescription, on a specification from the person it is for, or where the
   *   supervising pharmacist exercises their own judgement about the treatment
   *   required. An over-the-counter recommendation is inside that definition, so
   *   the obviously faithful move was to leave the rule UNCLASSIFIED.
   *
   * ⚠️ AN UNCLASSIFIED RULE IN A PACK IS A FAIL-OPEN FOR EVERY CLASSIFICATION
   *   THE PACK DOES NOT RECOGNISE. `coversProduct` matches a rule with no
   *   classification against ANY product, so a product filed under a string this
   *   pack never heard of — a First Schedule Part C substance, a typo, a
   *   classification from another country's vocabulary — matched this one rule,
   *   raised a label obligation, and came back `PERMITTED_WITH_CONDITIONS`.
   *   Nothing refused, because nothing that refuses had anything to say. With
   *   every rule classified, such a product matches nothing, resolves
   *   `UNDETERMINED`, and refuses. **A behaviour case pins the Part C product at
   *   `UNDETERMINED` for exactly this reason.**
   *
   * ⚠️ THE COST: A PRODUCT WITH NO IRISH CLASSIFICATION GETS NO LABEL RULE
   *   EITHER. That is the right way round — it is already being refused, and a
   *   labelling obligation attached to a refusal is noise.
   */
  ...(
    [
      ...PRESCRIPTION_TIERS.map((tier) => tier.classification),
      IE_CLASSIFICATIONS.pharmacyOnly,
    ] as string[]
  )
    .concat(CONTROLLED_SCHEDULES.map((schedule) => schedule.classification))
    .map((classification) => ({
      code: `IE-LABEL-${classification}`,
      ruleType: 'LABELLING_REQUIREMENT',
      statement:
        'Label the container or outer package of a dispensed medicinal product with the name of ' +
        'the person it is to be administered to, the name and address of the supplier, the date ' +
        'it was dispensed, the name of the product, the directions and precautions the ' +
        'prescriber specified, the words “Keep out of the reach of children”, and “For external ' +
        'use only” where it is for external use.',
      sourceKey: 'IE_PCS_2003',
      appliesToClassification: classification,
      appliesToTransactions: SUPPLY_TO_PATIENT,
      parameters: {
        fields: [
          'PATIENT_NAME',
          'SUPPLIER_NAME_AND_ADDRESS',
          'DISPENSING_DATE',
          'PRODUCT_NAME',
          'DIRECTIONS_FOR_USE',
          'PRECAUTIONS',
          'KEEP_OUT_OF_REACH_OF_CHILDREN',
          'FOR_EXTERNAL_USE_ONLY_WHERE_APPLICABLE',
          'CAUTIONARY_AND_WARNING_NOTICES',
        ],
        detail:
          'The prescriber may direct that the product name is omitted. Where the pharmacist ' +
          'judges a particular the prescriber specified to be inappropriate and cannot reach ' +
          'them, they substitute particulars of the same kind that they consider appropriate. ' +
          'Regulation 9(3) treats the manufacturer’s own container and outer package, supplied ' +
          'intact with its patient information leaflet and nothing obscured, as sufficient ' +
          'compliance with the product name, the children warning, the external-use warning and ' +
          'the cautionary notices — but not with the patient’s name, the supplier or the date. ' +
          '⚠️ Regulation 17 of the Misuse of Drugs Regulations 2017 adds a container marking for ' +
          'a controlled drug and regulation 17(2)(d) then lifts the whole of it from a supply on ' +
          'a practitioner’s prescription, so nothing here comes from that instrument.',
      },
      citation: 'S.I. No. 540 of 2003, regs. 9(1), 9(2) and 9(3)',
    })),

  /*
   * Regulation 5(1)(d) of the Regulation of Retail Pharmacy Businesses
   * Regulations 2008 — the sale or supply of a medicinal product, and the
   * dispensing of a prescription, is carried out by or under the personal
   * supervision of a registered pharmacist.
   *
   * ⚠️ A LICENCE TYPE, NOT A ROLE CODE — see the warning on `RegulatoryActor`. A
   *   clinic may rename its `PHARMACIST` role to "Dispensary Lead" tomorrow, and
   *   a rule naming the role would then match nobody at that clinic.
   *
   * ⚠️ `exemptWhenActorIsPrescriber` IS OPT-IN AND IRELAND OPTS IN, ON A PROVISO
   *   IN THE 2003 REGULATIONS RATHER THAN ON A GENERAL PRINCIPLE. Regulation
   *   20(3)(c) disapplies regulations 5 and 6 from "the supply of a medicinal
   *   product to a patient of his by a registered medical practitioner or
   *   registered dentist in the course of his professional practice" — the same
   *   shape as India's Pharmacy Act s. 42(1). And the 2008 Regulations bind a
   *   retail pharmacy business, which a doctor dispensing in their own practice
   *   is not. ⚠️ THE EXEMPTION IS NARROWER THAN THE KEY: regulation 20(3)(c)
   *   names a practitioner and a dentist and not a nurse, and `isPrescriber` does
   *   not carry the class. A nurse prescriber dispensing their own prescription
   *   is exempted by this rule and is not exempted by the regulation. Recorded
   *   in KNOWN_ISSUES; the fix is a class on the exemption, not a wider rule.
   */
  ...PRESCRIPTION_TIERS.map(({ key, spoken, classification }) => ({
    code: `IE-DISPENSER-${key}`,
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      `The supply of ${spoken}, and the dispensing of the prescription for it, must be carried ` +
      'out by or under the personal supervision of a registered pharmacist. Hand this to one.',
    sourceKey: 'IE_RRPB_2008',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      permittedLicenceTypes: ['REGISTERED_PHARMACIST'],
      exemptWhenActorIsPrescriber: true,
    },
    citation:
      'S.I. No. 488 of 2008, reg. 5(1)(d); exemption from S.I. No. 540 of 2003, reg. 20(3)(c)',
  })),

  /*
   * The same rule for the controlled schedules, and its ABSENCE INVERTED THE
   * WHOLE GATE.
   *
   * ⚠️ THIS PACK REFUSED AN UNLICENSED PERSON A PART A POM AND PERMITTED THEM
   *   MORPHINE. `IE-DISPENSER-*` was generated over `PRESCRIPTION_TIERS` only,
   *   and `IE-DISPENSER-PHARMACY-ONLY` covers the pharmacy-only class — so
   *   `CD_SCHEDULE_2`, `CD_SCHEDULE_3` and `CD_SCHEDULE_4_PART_1` had no
   *   `PHARMACIST_AUTHORITY` rule at all, and a Schedule 2 supply by somebody
   *   holding no registration whatsoever came back PERMITTED. Every other pack
   *   in the programme gates its controlled supply. Regulation 5(1)(d), which
   *   the rules above already cite, is not limited to the First Schedule tiers.
   *   Found in the PI-24 review by running the engine rather than reading the
   *   rows.
   *
   * ⚠️ AND NO `exemptWhenActorIsPrescriber` HERE, WHICH IS THE DELIBERATE
   *   DIFFERENCE FROM THE THREE ABOVE. Regulation 20(3)(c) disapplies
   *   regulations 5 and 6 of the 2003 Regulations; it says nothing about the
   *   Misuse of Drugs Regulations, so a practitioner dispensing a controlled
   *   drug to their own patient is not carried out of this requirement by it.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-DISPENSER-${schedule.key}`,
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      `The supply of a ${schedule.name} controlled drug, and the dispensing of the prescription ` +
      'for it, must be carried out by or under the personal supervision of a registered ' +
      'pharmacist. Hand this to one.',
    sourceKey: 'IE_RRPB_2008',
    appliesToClassification: schedule.classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      permittedLicenceTypes: ['REGISTERED_PHARMACIST'],
    },
    citation: 'S.I. No. 488 of 2008, reg. 5(1)(d)',
  })),

  /*
   * Regulation 6(1) — a medicine exempted from prescription control by
   * regulation 5(2) may still be supplied only from a pharmacy, by or under the
   * personal supervision of an authorised person.
   *
   * ⚠️ NO `exemptWhenActorIsPrescriber` ON THIS ONE, WHICH IS THE DELIBERATE
   *   CONTRAST WITH THE THREE ABOVE. Regulation 20(3)(c) disapplies regulations
   *   5 AND 6 alike, so the proviso does reach it — but there is no prescription
   *   in an over-the-counter sale, so `isPrescriber` is false for every caller
   *   this rule ever sees and setting the key would be decoration. A doctor
   *   handing a patient a packet in their own surgery is exempted by regulation
   *   20(3)(c) and this rule cannot tell; that is the limit of `isPrescriber`,
   *   not a reading of the regulation.
   */
  {
    code: 'IE-DISPENSER-PHARMACY-ONLY',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A medicinal product that is exempt from prescription control may still be supplied only ' +
      'from a pharmacy, by or under the personal supervision of an authorised person. Hand this ' +
      'to a registered pharmacist.',
    sourceKey: 'IE_PCS_2003',
    appliesToClassification: IE_CLASSIFICATIONS.pharmacyOnly,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedLicenceTypes: ['REGISTERED_PHARMACIST'] },
    citation: 'S.I. No. 540 of 2003, reg. 6(1)',
  },

  // ── Distance supply ───────────────────────────────────────────────────────

  /*
   * Regulation 19(1) and 19(5), and regulation 19A(8)(b). The prohibition.
   *
   * ⚠️ `permitted: false` REFUSES, AND IT IS THE FIRST ONE IN THIS PROGRAMME.
   *   Read `evaluateOnlineDispensing`: `permitted !== true` returns `refused`
   *   with the rule's statement, before the destination or the classification
   *   exclusions are looked at. Nothing about the order can rescue it, which is
   *   the correct behaviour for a prohibition that admits no exception.
   *
   * ⚠️ AND THIS IS WHERE PI-12'S SECOND GATE STOPS LOOKING REDUNDANT. A
   *   `REFUSED` decision enforces nothing until a named human sets this pack to
   *   `PRODUCTION_ENABLED`, and nobody has. `confirmOnlineOrder` refuses
   *   independently, on the clinic's own record of the product's online sale
   *   position. Ireland is the jurisdiction where the two gates finally agree
   *   about the same product — and the engine's answer is still the one that
   *   cites the law.
   */
  ...PRESCRIPTION_TIERS.map(({ key, spoken, classification }) => ({
    code: `IE-ONLINE-${key}`,
    ruleType: 'ONLINE_DISPENSING',
    statement:
      `${spoken.charAt(0).toUpperCase()}${spoken.slice(1)} may not be supplied by mail order, ` +
      'or at a distance to a person in the State by means of an information society service. ' +
      'This order cannot be fulfilled remotely; the patient must be supplied in the pharmacy.',
    sourceKey: 'IE_PCS_2015_ISS',
    appliesToClassification: classification,
    appliesToTransactions: ['ONLINE_DISPENSE'],
    parameters: { permitted: false },
    citation:
      'S.I. No. 540 of 2003, reg. 19(1); reg. 19(5) as inserted by S.I. No. 87 of 2015, reg. 7; ' +
      'reg. 19A(8)(b) as inserted by S.I. No. 87 of 2015, reg. 8',
  })),

  /*
   * Regulation 19A(1) — the permission, and the four things it hangs on.
   *
   * ⚠️ THE ISS SUPPLY LIST IS THE WHOLE RULE, WHICH IS WHY PI-18 ADDED A KEY
   *   RATHER THAN WRITING `permitted: true`. See the file header, and
   *   `OnlineDispensingParameters.requiresDistanceSellingAuthorisation`.
   *
   * ⚠️ THE MARKETING AUTHORISATION IN THE DESTINATION STATE — regulation
   *   19A(1)(c) — IS NOT CHECKED AND IS NOT CHECKABLE HERE. Whether this product
   *   is authorised in Portugal is a fact about a Portuguese register. It is in
   *   the statement so the person reading the decision knows the condition
   *   exists; asking somebody to tick it would manufacture evidence of a check
   *   nobody did.
   *
   * ⚠️ THE EIGHTH SCHEDULE HOLE IS REAL AND IS NOT CLOSED. Regulation 19(4), as
   *   substituted by S.I. No. 525 of 2011, lifts the mail-order prohibition from
   *   a non-prescription medicine EXCEPT one specified in the Eighth Schedule —
   *   the products a trained pharmacist may administer under regulation 4B, an
   *   influenza vaccine among them. A vaccine filed as `PHARMACY_ONLY` therefore
   *   gets this permission when regulation 19 still forbids sending it. The fix
   *   is a classification of its own, and it needs somebody to read the Eighth
   *   Schedule as it now stands — it has been substituted repeatedly. Recorded
   *   in KNOWN_ISSUES.
   */
  {
    code: 'IE-ONLINE-PHARMACY-ONLY',
    ruleType: 'ONLINE_DISPENSING',
    statement:
      'A non-prescription medicinal product may be supplied at a distance only by a supplier ' +
      'entered on the ISS supply list, only to a person in an EEA State, and only where the ' +
      'product holds a marketing authorisation in the State it is being sent to. A registered ' +
      'pharmacist must personally review the order and authorise the supply.',
    sourceKey: 'IE_PCS_2015_ISS',
    appliesToClassification: IE_CLASSIFICATIONS.pharmacyOnly,
    appliesToTransactions: ['ONLINE_DISPENSE'],
    parameters: {
      permitted: true,
      destinationCountryCodes: EEA_STATES,
      requiresDistanceSellingAuthorisation: true,
      distanceSellingAuthority: 'the Pharmaceutical Society of Ireland',
    },
    citation:
      'S.I. No. 540 of 2003, regs. 19A(1), 19A(7) and 19A(8)(a) as inserted by S.I. No. 87 of ' +
      '2015, reg. 8',
  },

  /*
   * Regulation 19A(6)(c)(i) — over eighteen, checked before supplying.
   *
   * ⚠️ `ONLINE_DISPENSE` ONLY, AND DELIBERATELY NOT THE COUNTER. The paragraph
   *   opens "in the course of each transaction for such supply", where "such
   *   supply" is supply at a distance by means of information society services.
   *   Ireland sets no general age limit on an over-the-counter medicine sale,
   *   and a rule that reached `COUNTER_SALE` would invent one.
   */
  {
    code: 'IE-AGE-DISTANCE',
    ruleType: 'AGE_RESTRICTION',
    statement:
      'Before supplying a non-prescription medicine at a distance, check that the purchaser is ' +
      'over 18, that they know the product should be used as its packaging recommends, and — ' +
      'having regard to what has already been sent to them — that the quantity is no more than ' +
      'they reasonably require for their own treatment.',
    sourceKey: 'IE_PCS_2015_ISS',
    appliesToClassification: IE_CLASSIFICATIONS.pharmacyOnly,
    appliesToTransactions: ['ONLINE_DISPENSE'],
    parameters: { minimumAgeYears: 18, verificationRequired: true },
    citation: 'S.I. No. 540 of 2003, reg. 19A(6)(c) as inserted by S.I. No. 87 of 2015, reg. 8',
  },

  /*
   * Regulation 19A(6)(b) — two years, for the distance-selling records.
   *
   * ⚠️ NO `appliesToTransactions`, WHICH MEANS EVERY TRANSACTION, AND THAT IS
   *   RIGHT FOR THIS ONE. The paragraph requires both the invoices for stock
   *   OBTAINED for distance supply and the records of each transaction SUPPLYING
   *   it — two ends of the same product's life, and the retention obligation
   *   attaches at both.
   */
  {
    code: 'IE-RETAIN-DISTANCE',
    ruleType: 'RECORD_RETENTION',
    statement:
      'Keep, at the premises named in the ISS supply list application, every invoice for stock ' +
      'obtained for distance supply and a record of every distance transaction, for at least two ' +
      'years from the date the product was received or supplied.',
    sourceKey: 'IE_PCS_2015_ISS',
    appliesToClassification: IE_CLASSIFICATIONS.pharmacyOnly,
    appliesToTransactions: [],
    parameters: {
      years: 2,
      fields: [
        'DATE_OF_TRANSACTION',
        'PRODUCT_NAME_AND_QUANTITY',
        'SUPPLIER_NAME_AND_ADDRESS',
        'RECIPIENT_NAME_AND_ADDRESS',
        'EVIDENCE_OF_THE_AGE_AND_QUANTITY_CHECKS',
        'EVIDENCE_OF_THE_PHARMACIST_REVIEW',
      ],
      detail:
        'At least two years from the date of receipt or of supply, kept at the fixed premises ' +
        'identified in the application for entry on the ISS supply list. The website must also ' +
        'state that such a record is kept for two years.',
    },
    citation:
      'S.I. No. 540 of 2003, regs. 19A(1)(d)(iv) and 19A(6)(b) as inserted by S.I. No. 87 of ' +
      '2015, reg. 8',
  },

  // ── The 2017 Regulations: controlled drugs ────────────────────────────────

  /*
   * Regulations 15 and 16 — the prescription, and how long it lives.
   *
   * ⚠️ FOURTEEN DAYS FOR SCHEDULES 2 AND 3, SIX MONTHS FOR PART 1 OF SCHEDULE 4,
   *   AND THE SECOND FIGURE COMES FROM A DIFFERENT INSTRUMENT. Regulation
   *   16(3)(b) disapplies the fourteen days from Part 1 of Schedule 4 and
   *   16(3)(a) sends the dispenser to regulation 7 of the 2003 Regulations
   *   instead — so `validityMonths` rather than `validityDays`, and the
   *   twelve-month extension of regulation 7(5)(a)(ii) is expressly unavailable
   *   to any controlled drug in Schedules 2, 3 or 4.
   *
   * ⚠️ THE HANDWRITING REQUIREMENT IS IN THE STATEMENT AND NOT IN A PARAMETER.
   *   Regulation 15(2)(g) requires the drug's name, the dose, the form and
   *   strength and the total quantity IN BOTH WORDS AND FIGURES to be in the
   *   practitioner's own handwriting, and 15(4) lifts that for Part 1 of
   *   Schedule 4 and for methadone. Whether a document was handwritten is not a
   *   fact rcln holds and this framework has no key for it, so the rule says so
   *   to the person holding the paper rather than pretending to check.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-RX-${schedule.key}`,
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      `A ${schedule.name} controlled drug may be supplied only on a prescription that complies ` +
      'with regulation 15 — indelible, signed and dated, giving the prescriber’s full name, ' +
      'registration number, address and telephone number and the patient’s full name and address' +
      (schedule.handwritingRequired
        ? ', with the drug’s name, dose, form, strength and total quantity in both words and ' +
          'figures in the prescriber’s own handwriting'
        : '') +
      '. ' +
      (schedule.validityDays !== undefined
        ? 'It may not be dispensed more than 14 days after its date.'
        : 'It may not be dispensed more than six months after its date, and the twelve-month ' +
          'extension available to other medicines is not available to a controlled drug.'),
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      required: true,
      ...(schedule.validityDays !== undefined ? { validityDays: schedule.validityDays } : {}),
      ...(schedule.validityMonths !== undefined ? { validityMonths: schedule.validityMonths } : {}),
    },
    citation:
      schedule.validityDays !== undefined
        ? 'S.I. No. 173 of 2017, regs. 15(2) and 16(1)(a) and (e)(i)'
        : 'S.I. No. 173 of 2017, regs. 15(2), 15(4)(a) and 16(3)(a)–(b); S.I. No. 540 of 2003, reg. 7(5)(a)',
  })),

  /*
   * Regulation 15(2)(b) with regulation 16(1)(b) — who, and from where.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-PRESCRIBER-${schedule.key}`,
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      `A prescription for a ${schedule.name} controlled drug must state whether the practitioner ` +
      'issuing it is a registered medical practitioner, registered dentist, registered veterinary ' +
      'practitioner, registered nurse or registered midwife, and give their registration number. ' +
      'The address on it must be an address within the State.',
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: CONTROLLED_DRUG_PRESCRIBERS },
    citation: 'S.I. No. 173 of 2017, regs. 15(2)(b) and 16(1)(b)',
  })),

  /*
   * Instalments — regulation 16(1)(e)(ii), and regulation 16(3)(c) for Part 1 of
   * Schedule 4.
   *
   * ⚠️ NO `maxEndorsedRepeats`, AND THE `UNDETERMINED` THAT FOLLOWS IS THE POINT.
   *   The Regulations set no ceiling on the number of instalments; regulation
   *   15(2)(h) instead requires the PRESCRIPTION to state "the number of
   *   instalments and the intervals at which the instalments may be dispensed".
   *   So an endorsement that does not say how many, under a rule with no cap of
   *   its own, resolves `UNDETERMINED` — which refuses, with a reason that says
   *   to ring the prescriber. That is regulation 15(2)(h) enforced, not a
   *   framework limitation showing through.
   *
   * ⚠️ TWO MONTHS RATHER THAN FOURTEEN DAYS FOR THE LATER INSTALMENTS, AND BOTH
   *   NUMBERS ARE LIVE AT ONCE. `IE-RX-CD2` carries the fourteen days that bound
   *   the FIRST instalment; this rule carries the two months that bound the
   *   subsequent ones. The engine evaluates both and a refusal from either
   *   refuses — which is exactly regulation 16(1)(e) read as one sentence.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-REPEAT-${schedule.key}`,
    ruleType: 'REFILL_RULE',
    statement:
      `A prescription for a ${schedule.name} controlled drug may be dispensed on one occasion ` +
      'only, unless it directs that specified instalments be dispensed at stated intervals and ' +
      'says how many. The first instalment must be supplied within 14 days of the date on the ' +
      'prescription and the last no later than two months after it.',
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      refillsAllowed: 0,
      endorsedRepeatsPermitted: true,
      validityMonths: 2,
    },
    citation:
      schedule.validityDays !== undefined
        ? 'S.I. No. 173 of 2017, regs. 15(2)(h) and 16(1)(e)(ii)'
        : 'S.I. No. 173 of 2017, regs. 15(2)(h) and 16(3)(c)',
  })),

  /*
   * Regulation 19(1) — the register, for Schedules 1 and 2.
   *
   * ⚠️ ALL THREE SCHEDULES GET A `CONTROLLED_SCHEDULE` RULE, AND ONLY ONE OF
   *   THEM CARRIES A REGISTER. Regulation 19(1) reaches Schedules 1 and 2 and
   *   stops, so Schedule 3 and Part 1 of Schedule 4 need no register, no safe
   *   under this rule type and no prior authorisation. What they still need is
   *   to be NAMED: a decision that does not say "this is a controlled drug"
   *   reads exactly like an ordinary supply.
   *
   *   Until PI-24 they had no rule at all, and the reason was a framework
   *   constraint rather than a reading of the regulation —
   *   `parseControlledSchedule` refused a document that imposed no obligation,
   *   so a `scheduleName`-only rule resolved `UNDETERMINED`, **which refuses**.
   *   The framework now takes `informationalOnly`, an EXPLICIT opt-out: the
   *   deliberate label is accepted, and a rule that imposes nothing without
   *   saying so still fails closed, because that shape is what a mistyped
   *   parameter looks like.
   *
   * ⚠️ THE SHAPE THIS FILE ONCE WARNED AGAINST IS NOW THE SUPPORTED ONE, AND THE
   *   WARNING IS WORTH KEEPING FOR WHAT IT CAUGHT. `AU-SCHEDULE-S8` shipped in
   *   PI-15 carrying `{ scheduleName: 'Schedule 8' }` and nothing else — found
   *   while writing this file — so every Schedule 8 transaction outside Victoria
   *   answered `UNDETERMINED`, which refuses, in seven jurisdictions. Its own
   *   comment claimed the opposite, and its behaviour case asserted the rule CODE
   *   appeared and that no conditions were raised, which is precisely what an
   *   unreadable rule produces. Both it and `SG-SCHEDULE-CD3` are fixed in PI-24,
   *   and `apps/api/tests/unit/rule-pack-readable.test.ts` now parses every rule
   *   in every pack so the class cannot ship a third time.
   *
   * ⚠️ NO `storageLocationKinds`, BECAUSE THE SAFE IS ITS OWN RULE. Article 5 of
   *   the Safe Custody Regulations is about a receptacle rather than a room, and
   *   `IE-STORE-*` below carries it with `controlledAccessRequired`, which is
   *   the fact a location row actually holds.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-SCHEDULE-${schedule.key}`,
    ruleType: 'CONTROLLED_SCHEDULE',
    statement: schedule.registerRequired
      ? `This is a ${schedule.name} controlled drug. Enter every quantity obtained and every ` +
        'quantity supplied in the controlled drugs register for its class, in chronological ' +
        'order and showing a running stock balance, on the day it happens or the next day — in ' +
        'ink, never altered, and corrected only by a dated marginal note.'
      : `This is a ${schedule.name} controlled drug. Its supply, possession and storage are ` +
        'restricted under the Misuse of Drugs Regulations, which require no register entry for ' +
        'this schedule.',
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: schedule.registerRequired
      ? { scheduleName: schedule.name, registerRequired: true }
      : /*
         * ⚠️ THE COST RECORDED ABOVE, NOW PAID (PI-24). The paragraph said the
         *   reason line "This is a Schedule 3 controlled drug" was worth having
         *   and unobtainable without asserting a register Regulation 19(1) does
         *   not impose — and that the fix was a framework decision, not
         *   Ireland's. That decision was taken: `informationalOnly` is the
         *   explicit opt-out from the "imposes no obligation" refusal, so the
         *   schedule can be NAMED without an obligation being invented for it.
         *   Nothing about the reading of the regulation changed — Schedule 3 and
         *   Part 1 of Schedule 4 still require no register, and the safe is still
         *   `IE-STORE-*`.
         */
        { scheduleName: schedule.name, informationalOnly: true },
    citation: schedule.registerRequired
      ? 'S.I. No. 173 of 2017, regs. 19(1), 19(2) and 19(5)'
      : 'S.I. No. 173 of 2017, reg. 19(1) — which reaches Schedules 1 and 2 and stops',
  })),

  /*
   * Article 5 of the Safe Custody Regulations — the safe, for Schedules 1, 2 and 3.
   *
   * ⚠️ `controlledAccessRequired` REFUSES A STOCK OR TRANSFER TRANSACTION INTO A
   *   LOCATION THAT HAS NO CONTROLLED ACCESS, and that is the whole enforceable
   *   content of the article. Whether the cabinet is welded 16-gauge sheet steel
   *   with a five-lever lock bolted through a 3mm anchor plate is not a fact any
   *   software holds; the Schedule's specification is in the `detail` so a
   *   pharmacy fitting one knows what to buy.
   *
   * ⚠️ PART 1 OF SCHEDULE 4 IS ABSENT AND IT IS NOT AN OVERSIGHT. Article 5(1)
   *   binds a person keeping open shop in respect of "any controlled drug
   *   specified in Schedule 1, 2 or 3", and stops. Benzodiazepines live in Part
   *   1 of Schedule 4 and are not required to be in the safe.
   */
  ...CONTROLLED_SCHEDULES.filter((schedule) => schedule.safeRequired).map((schedule) => ({
    code: `IE-STORE-${schedule.key}`,
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      `A ${schedule.name} controlled drug held in a pharmacy must ordinarily be kept in a locked ` +
      'safe or cabinet constructed and maintained so as to prevent unauthorised access to it.',
    sourceKey: 'IE_SAFE_CUSTODY_1982',
    appliesToClassification: schedule.classification,
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
        'A locked safe or cabinet meeting at least the standard in the Schedule to S.I. No. 321 ' +
        'of 1982: pressed and welded sheet steel or steel mesh no lighter than 16 gauge, no more ' +
        'than 3mm clearance at the door, a lock of at least five differing levers or six pins ' +
        'with a 12mm dead-bolt throw, rag-bolted through a 3mm anchor plate to a solid wall or ' +
        'floor, and nothing displayed outside it to indicate that drugs are kept in it. A Garda ' +
        'Superintendent may certify an equivalent safe instead, for two years at a time. Anyone ' +
        'else lawfully holding one of these drugs keeps it, so far as circumstances permit, in a ' +
        'locked fixed receptacle they alone can open.',
    },
    citation: 'S.I. No. 321 of 1982, arts. 4(1), 5(1), 5(2) and 6(5) and the Schedule',
  })),

  /*
   * Regulations 22 and 23 — two years, from whichever date the paragraph names.
   *
   * ⚠️ TWO YEARS EVERYWHERE, WHICH MAKES THIS RULE LOOK REDUNDANT BESIDE
   *   `IE-RETAIN-PART-A` AND IS NOT. A controlled drug is filed under a
   *   controlled classification, so it never sees the 2003 Regulations' rule at
   *   all — `mostSpecific` selects per classification. If this row were dropped
   *   because "it says the same thing", a Schedule 2 supply would have no
   *   retention rule and the decision would say nothing about the register it
   *   has to keep for two years.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-RETAIN-${schedule.key}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      `Keep every ${schedule.name} register, prescription, requisition, order, invoice and ` +
      'receipt for two years — the register from its last entry, a prescription from the last ' +
      'supply made on it, an invoice from the day it was issued.',
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: [],
    parameters: {
      years: 2,
      detail:
        'Two years, running from the date the paragraph names: for a register, the date of the ' +
        'last entry in it; for a prescription, requisition or order, the date of the last supply ' +
        'made on it; for a receipt, the date of receipt entered on it; for an invoice, the date ' +
        'it was issued. A copy made within the two years is treated as the original. The ' +
        'prescription itself is marked with the date of supply and retained on the premises the ' +
        'drug was supplied from.',
    },
    citation: 'S.I. No. 173 of 2017, regs. 16(2), 22(1), 22(2), 22(4), 22(7), 23(5) and 23(6)',
  })),

  /*
   * Regulation 25 — destruction, in the presence of somebody the Minister
   * authorised.
   *
   * ⚠️ THIS CONDITION CANNOT BE DISCHARGED INSIDE THE PHARMACY, WHICH IS THE
   *   SAME SHAPE AS SINGAPORE'S INSPECTOR AND NOT VICTORIA'S SECOND
   *   PRACTITIONER. Regulation 25(1) forbids destruction "except in the presence
   *   of and in accordance with any directions given by a person authorised ...
   *   by the Minister", and 25(3) requires that person to sign the record. So
   *   the `method` names who has to be standing there, because two colleagues
   *   signing each other's form is not compliance with this regulation.
   *
   * ⚠️ IT REACHES ALL THREE SCHEDULES, INCLUDING THE TWO WITH NO REGISTER.
   *   Regulation 25(1) binds a person "required by any provision of these
   *   Regulations ... to keep records with respect to a drug specified in
   *   Schedule 1, 2, 3 or 4", and regulation 23(4)(a) makes a retail pharmacy
   *   business keep invoices for Schedule 3 and Part 1 of Schedule 4. ⚠️ BUT
   *   REGULATION 25(5) THEN DISAPPLIES 25(1) AND 25(3) FROM A PERSON REQUIRED TO
   *   KEEP RECORDS ONLY BY VIRTUE OF REGULATION 23(4)(a) — which is a retail
   *   pharmacy business, for exactly those two schedules. The rule is written
   *   for all three anyway and the exemption is named in the `detail`, because
   *   whether a given pharmacy keeps its Schedule 3 records only by virtue of
   *   23(4)(a) depends on what else it does, and refusing to raise the witness
   *   condition would be the permissive reading of a paragraph that is not
   *   simply an exemption. ⚠️ THIS IS THE WEAKEST READING IN THE PACK.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-DISPOSE-${schedule.key}`,
    ruleType: 'DISPOSAL_REQUIREMENT',
    statement:
      `A ${schedule.name} controlled drug may be destroyed only in the presence of, and following ` +
      'the directions of, a person the Minister has authorised for that purpose. Record the date, ' +
      'the drug and the quantity destroyed, and have that person sign the record.',
    sourceKey: 'IE_MDR_2017',
    appliesToClassification: schedule.classification,
    appliesToTransactions: ['DISPOSE'],
    parameters: {
      witnessRequired: true,
      method:
        'Destruction in the presence of, and in accordance with the directions of, a person ' +
        'authorised by the Minister for Health under regulation 25(1) — personally or as a member ' +
        'of a class. That person may take a sample for analysis first.',
      detail:
        'The record of destruction states the date, the name of the controlled drug and the ' +
        'quantity destroyed, and is signed by the authorised person who witnessed it. ' +
        '⚠️ Regulation 25(5) disapplies this from a person required to keep records only by ' +
        'virtue of regulation 23(4)(a) — a retail pharmacy business keeping invoices for ' +
        'Schedule 3 or Part 1 of Schedule 4 and nothing else. Whether that describes this ' +
        'pharmacy is a question about the whole business, not about this transaction.',
    },
    citation: 'S.I. No. 173 of 2017, regs. 25(1), 25(2), 25(3) and 25(5)',
  })),

  /*
   * Regulation 19 of the 2003 Regulations, reaching a controlled drug.
   *
   * ⚠️ CITED TO THE 2003 REGULATIONS AND NOT TO THE MISUSE OF DRUGS
   *   REGULATIONS, WHICH SAY NOTHING ABOUT MAIL ORDER. A controlled drug
   *   dispensed in a pharmacy is a medicinal product subject to prescription
   *   control in the State, so regulation 19(1) and regulation 19A(8)(b) reach
   *   it directly. Citing regulation 16 of the 2017 Regulations here would put a
   *   reference on the row that does not contain the prohibition.
   */
  ...CONTROLLED_SCHEDULES.map((schedule) => ({
    code: `IE-ONLINE-${schedule.key}`,
    ruleType: 'ONLINE_DISPENSING',
    statement:
      `A ${schedule.name} controlled drug may not be supplied by mail order, or at a distance to ` +
      'a person in the State by means of an information society service. This order cannot be ' +
      'fulfilled remotely; the patient must be supplied in the pharmacy.',
    sourceKey: 'IE_PCS_2015_ISS',
    appliesToClassification: schedule.classification,
    appliesToTransactions: ['ONLINE_DISPENSE'],
    parameters: { permitted: false },
    citation:
      'S.I. No. 540 of 2003, reg. 19(1); reg. 19(5) as inserted by S.I. No. 87 of 2015, reg. 7; ' +
      'reg. 19A(8)(b) as inserted by S.I. No. 87 of 2015, reg. 8',
  })),
];
