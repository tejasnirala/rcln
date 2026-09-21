/**
 * CALIFORNIA — sub-national rule pack `US-CA` 1.0.0. The first regional pack in
 * this programme, and the reason PI-13 was chosen to exercise the region path.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from California's own
 *   publication of its statutes and cited section by section, reviewed by
 *   nobody qualified. The pack's maturity says so.
 *
 * ── WHAT A REGIONAL PACK IS, AND THE MISTAKE IT INVITES ──────────────────────
 * ⚠️ THIS IS NOT CALIFORNIA'S PHARMACY LAW. It is the handful of places where
 *   California DIFFERS from, or ADDS TO, the federal pack in a way this
 *   framework can express. A regional pack supersedes the national one PER RULE
 *   TYPE — `mostSpecific()` prefers a regional rule over a national rule of the
 *   SAME type and leaves every other type standing — so the three rules below
 *   displace federal retention, federal labelling and nothing else. Federal
 *   prescription requirements, refill limits, prescriber authority, online
 *   dispensing and controlled-schedule recordkeeping all continue to apply in
 *   California, because nothing here is of those types.
 *
 * ⚠️ WHICH MEANS ADDING A RULE HERE SWITCHES OFF EVERY FEDERAL RULE OF ITS TYPE
 *   IN THIS STATE, AND NOTHING WARNS YOU. A `PRESCRIPTION_REQUIRED` rule added
 *   to this file would take all four federal schedule rules out of the candidate
 *   set for California and replace them with itself. That is correct behaviour
 *   and a very sharp edge: a state pack written as a partial restatement of
 *   federal law would silently repeal the parts it paraphrased badly. Add a rule
 *   here only where California genuinely governs, and expect to carry the whole
 *   type when you do.
 *
 * ── THE SUPERSESSION THIS PACK EXISTS TO DEMONSTRATE ─────────────────────────
 * Federal 21 CFR 1304.04(a) keeps controlled-substance records for TWO years.
 * California B&P § 4081(a) keeps records of ALL dangerous drugs for THREE. Same
 * rule type, regional beats national, so a California branch is told three years
 * and a Nevada branch is told two — from one engine, with no country branch in
 * any code path.
 *
 * ⚠️ AND NOTE THE SPECIFICITY INVERSION, BECAUSE IT LOOKS WRONG UNTIL IT DOESN'T.
 *   The federal retention rules are keyed to a classification (specificity 4);
 *   this one names no classification at all (specificity 0), because § 4081
 *   reaches every dangerous drug. A naive "most specific wins" would keep the
 *   federal rule. `mostSpecific()` filters to the REGIONAL level FIRST and only
 *   then compares specificity within it, so the broad state rule correctly beats
 *   the narrow federal one. That ordering is the whole design — see the warning
 *   in `selection.ts` about a state override that overrides nothing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO CURES / PDMP REPORTING RULE. California requires dispensers to report
 *   controlled-substance dispensations to the CURES database. It is real and it
 *   matters, and it was not written because the reporting cadence and the exact
 *   dispensation set could not be read from a primary source in this pass. No
 *   source, no rule; the matrix cell stays `RESEARCH_REQUIRED`.
 *
 * ⚠️ NO CONTROLLED-SUBSTANCE PRESCRIPTION RULES. California's Health and Safety
 *   Code adds its own, and they were not read here. Federal rules therefore
 *   govern those types in California — which is a gap in this PACK, not a claim
 *   that California adds nothing. Said plainly so nobody reads the silence as
 *   completeness.
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/** The day this pack becomes evaluable. Not the day any of these statutes passed. */
export const US_CA_PACK_EFFECTIVE_FROM = '2026-08-19';

export const US_CA_AUTHORITIES = [
  {
    code: 'CA_BOP',
    name: 'California State Board of Pharmacy',
    websiteUrl: 'https://www.pharmacy.ca.gov/',
    remit:
      'Licenses and regulates pharmacies, pharmacists and wholesalers in California under ' +
      'division 2, chapter 9 of the Business and Professions Code. A state licensing board, ' +
      'separate from and additional to the DEA and the FDA.',
  },
] as const;

export const US_CA_SOURCES: SourceSeed[] = [
  {
    key: 'CA_BPC_4081',
    authorityCode: 'CA_BOP',
    title: 'California Business and Professions Code § 4081 — records; inventory',
    documentReference: 'Cal. Bus. & Prof. Code § 4081(a)',
    sourceUrl:
      'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=4081.',
    version: 'As amended by Stats. 2025, Ch. 196',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From leginfo.legislature.ca.gov, the California Legislature’s own publication of its ' +
      'codes. § 4081(a) was read in full: records "shall be preserved for at least three years ' +
      'from the date of making". UNVERIFIED means no qualified person has confirmed the READING.',
  },
  {
    key: 'CA_BPC_4076',
    authorityCode: 'CA_BOP',
    title: 'California Business and Professions Code § 4076 — prescription container labels',
    documentReference: 'Cal. Bus. & Prof. Code § 4076(a)(1)–(11)',
    sourceUrl:
      'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=4076.',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Read in full. Eleven required label elements, several materially beyond the federal set — ' +
      'the drug’s strength, the quantity dispensed, the expiration date, the condition or purpose ' +
      'where the prescription states it, and a physical description of the medication.',
  },
  {
    key: 'CA_BPC_4073',
    authorityCode: 'CA_BOP',
    title: 'California Business and Professions Code § 4073 — generic substitution',
    documentReference: 'Cal. Bus. & Prof. Code § 4073(a)–(e)',
    sourceUrl:
      'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=4073.',
    version: 'As amended by Stats. 2006, Ch. 659',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Read in full, including the three provisos: the prescriber’s personally-initialled "Do not ' +
      'substitute" blocks it, the substitute must cost the patient less, and the substitution ' +
      'must be communicated to the patient and named on the label.',
  },
];

export const US_CA_RULES: RuleSeed[] = [
  /*
   * § 4081(a) — "All records of manufacture and of sale, acquisition, receipt,
   * shipment, or disposition of dangerous drugs or dangerous devices shall be at
   * all times during business hours open to inspection by authorized officers of
   * the law, and shall be preserved for at least three years from the date of
   * making."
   *
   * ⚠️ NO `appliesToClassification`, AND THAT BREADTH IS THE RULE'S OWN. It
   *   reaches every dangerous drug, not merely the scheduled ones — so in
   *   California an ordinary legend drug carries a three-year retention where
   *   federal law, which reaches only controlled substances, says nothing at all
   *   about it.
   */
  {
    code: 'CA-RETAIN-RECORDS',
    ruleType: 'RECORD_RETENTION',
    statement:
      'Keep records of the manufacture, sale, acquisition, receipt, shipment or disposition of ' +
      'this drug for at least three years from the date of making, open to inspection during ' +
      'business hours.',
    sourceKey: 'CA_BPC_4081',
    appliesToTransactions: [],
    parameters: {
      years: 3,
      detail:
        'At least three years from the date the record was made, open at all times during ' +
        'business hours to inspection by authorised officers of the law. California requires a ' +
        'year longer than the federal two, and for every dangerous drug rather than only the ' +
        'controlled ones.',
    },
    citation: 'Cal. Bus. & Prof. Code § 4081(a)',
  },

  /*
   * § 4076(a) — the dispensing container label.
   *
   * ⚠️ THIS SUPERSEDES EVERY FEDERAL LABELLING RULE IN CALIFORNIA, INCLUDING THE
   *   VETERINARY CAUTION, AND THAT IS A REAL COST OF THE PER-TYPE MODEL. The
   *   federal `US-LABEL-VETERINARY` rule is a `LABELLING_REQUIREMENT`, so a
   *   veterinary medicine dispensed in California matches this rule instead of
   *   that one and the "Caution: Federal law restricts this drug…" statement
   *   drops out of the conditions — even though federal law plainly still
   *   requires it. § 4076(a)(11)(A)(i) expressly exempts prescriptions dispensed
   *   by a veterinarian from the physical-description element, which tells us
   *   California contemplated veterinary dispensing here and did not displace
   *   the federal caution.
   *
   *   The honest fix is a California veterinary labelling rule carrying both
   *   sets of fields, which needs the state's veterinary labelling provisions
   *   read — not done in this pass. Recorded in KNOWN_ISSUES rather than papered
   *   over, because the failure is silent: the label simply comes back missing a
   *   field nobody is told about.
   */
  {
    code: 'CA-LABEL-DISPENSED',
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Label the container with the drug name and manufacturer, the directions for use, the ' +
      'patient’s name, the prescriber’s name, the date of issue, the pharmacy’s name and address, ' +
      'the prescription number, the strength, the quantity, the expiration date, the condition or ' +
      'purpose where the prescription states it, and a physical description of the medication.',
    sourceKey: 'CA_BPC_4076',
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: {
      fields: [
        'DRUG_NAME_AND_MANUFACTURER',
        'DIRECTIONS_FOR_USE',
        'PATIENT_NAME',
        'PRESCRIBER_NAME',
        'DATE_OF_ISSUE',
        'PHARMACY_NAME',
        'PHARMACY_ADDRESS',
        'PRESCRIPTION_NUMBER',
        'DRUG_STRENGTH',
        'QUANTITY_DISPENSED',
        'EXPIRATION_DATE',
        'CONDITION_OR_PURPOSE',
        'PHYSICAL_DESCRIPTION',
      ],
      detail:
        'The eleven elements of § 4076(a). The physical description — colour, shape and any ' +
        'identification code — applies to outpatient pharmacies and may go on an auxiliary ' +
        'label; it does not apply to prescriptions dispensed by a veterinarian. The condition or ' +
        'purpose is required only where the prescription states it.',
    },
    citation: 'Cal. Bus. & Prof. Code § 4076(a)(1)–(11)',
  },

  /*
   * § 4073 — generic substitution. Federal law has none, so this ADDS a type
   * rather than superseding one.
   *
   * ⚠️ THE THREE PROVISOS LIVE IN THE STATEMENT BECAUSE THE FRAMEWORK CANNOT
   *   CHECK ANY OF THEM, AND ONE OF THEM IS THE WRONG SHAPE ENTIRELY.
   *
   *   `requiresPrescriberConsent` REFUSES unless the prescriber has agreed. That
   *   is the inverse of § 4073(b), where substitution is permitted BY DEFAULT
   *   and the prescriber's personally-initialled "Do not substitute" is what
   *   blocks it. Setting the key would refuse every lawful generic substitution
   *   in California — the framework models "consent required", and California
   *   writes "objection blocks", and those have opposite defaults. Recorded in
   *   KNOWN_ISSUES as a framework gap.
   *
   *   `requiresPatientConsent` is likewise wrong: § 4073(e) requires the
   *   substitution to be COMMUNICATED to the patient, not agreed by them, and
   *   the key refuses without an agreement.
   *
   *   The cost test — "In no case shall the pharmacist select a drug product
   *   unless the drug product selected costs the patient less" — has no key at
   *   all, and pricing is not something this engine is given.
   *
   *   So the rule permits, and the statement carries all three provisos verbatim
   *   enough for the pharmacist who reads it. That is weaker than checking them
   *   and stronger than pretending the section says only "substitution is
   *   allowed".
   */
  {
    code: 'CA-SUBST-GENERIC',
    ruleType: 'SUBSTITUTION',
    statement:
      'A generic with the same active ingredients, strength, quantity and dosage form may be ' +
      'substituted — but not if the prescriber has personally initialled “Do not substitute”, not ' +
      'unless it costs the patient less, and only if the substitution is communicated to the ' +
      'patient and the dispensed product is named on the label.',
    sourceKey: 'CA_BPC_4073',
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: { permitted: true },
    citation: 'Cal. Bus. & Prof. Code § 4073(a)–(e)',
  },
];
