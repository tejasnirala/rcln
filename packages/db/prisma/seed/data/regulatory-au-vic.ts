/**
 * VICTORIA — sub-national rule pack `AU-VIC` 1.0.0, and the pack PI-15 exists to
 * ship. The second regional pack in this programme, after California.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from the Chief Parliamentary
 *   Counsel's authorised text of the Regulations and cited regulation by
 *   regulation, reviewed by nobody qualified. The pack's maturity says so.
 *
 * ── WHY VICTORIA, AND WHY A STATE PACK WAS MANDATORY HERE ────────────────────
 * ⚠️ AUSTRALIA IS THE JURISDICTION WHERE A NATIONAL-ONLY PACK WOULD HAVE BEEN A
 *   PACK ABOUT NOTHING. COUNTRY_RULE_PACK_SURVEY.md put it plainly: the Poisons
 *   Standard is federal and has no legal force except through State and
 *   Territory legislation, so PI-15 "must ship at least one state pack or it must
 *   not ship". This is that pack. `regulatory-au.ts` carries four floor rules
 *   read off the Standard's own Schedule descriptions; every operative
 *   obligation a Victorian pharmacist actually answers to is in this file, and
 *   is quoted from an offence provision carrying a penalty in penalty units.
 *
 * ⚠️ VICTORIA AND NOT NEW SOUTH WALES, WHICH IS THE LARGER STATE, AND THE REASON
 *   IS SOURCE ACCESS RATHER THAN PREFERENCE. legislation.nsw.gov.au returned
 *   `403` on every path attempted — the same failure that has PI-14 (Great
 *   Britain) blocked on legislation.gov.uk. Victoria's own site serves an
 *   authorised PDF of the current consolidation, so Victoria is the state whose
 *   law could be read rather than guessed at. New South Wales carries a second
 *   complication worth recording: its Poisons and Therapeutic Goods Act 1966 is
 *   being replaced by the Medicines, Poisons and Therapeutic Goods Act 2022, so
 *   a NSW pack would need the commencement position established before a single
 *   rule was written.
 *
 * ── WHAT A REGIONAL PACK IS, AND THE MISTAKE IT INVITES ──────────────────────
 * ⚠️ THIS IS NOT VICTORIA'S DRUGS AND POISONS LAW. It is the places where
 *   Victoria makes operative, or departs from, what the Poisons Standard merely
 *   recommends. A regional pack supersedes the national one PER RULE TYPE —
 *   `mostSpecific()` prefers a regional rule over a national rule of the SAME
 *   type and leaves every other type standing.
 *
 * ⚠️ WHICH MEANS ADDING A RULE HERE SWITCHES OFF EVERY NATIONAL RULE OF ITS TYPE
 *   IN THIS STATE, AND NOTHING WARNS YOU. The `PRESCRIPTION_REQUIRED` rules
 *   below take `AU-RX-S4` and `AU-RX-S8` out of the candidate set for a
 *   Victorian branch and replace them — which is correct, because they say the
 *   same thing with a validity period attached and a penalty behind it, and it
 *   is correct only because both national rules were carried forward
 *   deliberately rather than paraphrased badly. Add a rule here only where
 *   Victoria genuinely governs, and expect to carry the whole type when you do.
 *
 * ⚠️ AND THE CLASSIFICATION KEYING IS LOAD-BEARING FOR EXACTLY THAT REASON. Every
 *   rule below names `SCHEDULE_4` or `SCHEDULE_8`, never neither. A
 *   `PHARMACIST_AUTHORITY` rule here with no classification would cover a
 *   Schedule 3 product too, and being regional would displace the national
 *   `AU-SUPPLY-S3` — silently repealing the pharmacist-only control on
 *   pharmacist only medicines in the one state that has a pack. Regulations 47
 *   and 48 are addressed to Schedule 4 and Schedule 8; the rules read off them
 *   say so.
 *
 * ── THE SUPERSESSIONS THIS PACK EXISTS TO DEMONSTRATE ────────────────────────
 * The Poisons Standard sets no prescription validity, because validity is a
 * State question. Regulation 50(2) gives Schedule 4 twelve months and regulation
 * 51(3) gives Schedule 8 six — so a Victorian branch is told twelve and six, a
 * Sydney branch is told nothing, and both come from one engine with no country
 * branch in any code path.
 *
 * The national `AU-SCHEDULE-S8` rule carries a schedule name and no obligations.
 * `VIC-SCHEDULE-S8` carries the register (regulation 108) and `VIC-PERMIT-S8`
 * the Schedule 8 treatment permit (regulation 10) — which is the first time in
 * this programme that `VERIFY_PRIOR_AUTHORISATION` is raised by a real pack.
 * PI-13a built that condition kind with Australia's Schedule 8 permits named in
 * the comment; this is the phase that exercises it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO SCHEDULE 9 RULES. Chapter 2 governs Schedule 4, 8 AND 9 poisons
 *   throughout, and every Schedule 9 limb has been left out. Schedule 9 is a
 *   prohibited substance available only under a permit issued for research or a
 *   clinical trial (regulations 13 to 15B), and a routine dispensing platform
 *   that carried rules for it would be modelling a supply it must never treat as
 *   routine. The same call `regulatory-au.ts` makes for Schedules 9 and 10.
 *
 * ⚠️ NO CHART-INSTRUCTION RULES. Regulations 54, 55 and 55A let a pharmacist
 *   supply against a hospital or residential medication chart instead of a
 *   prescription, and rcln has no chart. Written as no rule rather than as a
 *   prescription rule that would refuse a lawful ward supply.
 *
 * ⚠️ NO EMERGENCY OR CONTINUITY-OF-SUPPLY RULES. Regulations 25, 25A, 53, 56, 57
 *   and 57A each permit a supply that departs from the ordinary requirements —
 *   a verbal instruction, a digital image, a three-day emergency supply,
 *   continuity of treatment. They are exceptions to rules, and the framework
 *   expresses rules rather than exceptions to them: a `PRESCRIPTION_REQUIRED`
 *   rule has no way to say "unless the pharmacist judges an emergency". So this
 *   pack is STRICTER than Victorian law in exactly those cases, and a pharmacist
 *   acting under regulation 56 will be refused by `VIC-RX-S4` and will have to
 *   override. Recorded in KNOWN_ISSUES; better a visible refusal than a silent
 *   permission.
 *
 * ⚠️ NO SCHEDULE 8 TWO-DAY VERIFICATION RULE. Regulation 51(2) forbids supplying
 *   a Schedule 8 poison "in a quantity that allows for more than 2 days'
 *   treatment" UNLESS the pharmacist is familiar with the prescriber's
 *   handwriting or has taken all reasonable steps to verify the prescription.
 *   Written as a `QUANTITY_LIMIT` with `maxDaysSupply: 2` it would refuse every
 *   ordinary, lawful, verified Schedule 8 supply in Victoria — the same
 *   inverted-default trap as California's `requiresPrescriberConsent`, where the
 *   framework models a bar and the law writes a bar-with-a-discharge. The
 *   verification requirement is carried in the `VIC-RX-S8` statement instead,
 *   where the pharmacist reads it.
 *
 * ⚠️ NO MONITORED-POISONS RULE FOR SCHEDULE 4 SUBSTANCES. Schedule 6 to the
 *   Regulations makes ALL Schedule 8 poisons monitored supply poisons — which
 *   `VIC-REPORT-S8` carries — and adds "all benzodiazepines that are Schedule 4
 *   poisons", codeine, gabapentin, pregabalin, quetiapine, tramadol, zolpidem
 *   and zopiclone. Those are named SUBSTANCES inside a schedule, and
 *   `appliesToClassification` matches one classification string exactly; there
 *   is no way to say "the benzodiazepine ones" without a composition-level rule
 *   this framework does not have. The Schedule 8 limb is written because it is
 *   coextensive with a classification. The rest is a real gap, recorded.
 *
 * ⚠️ NO VETERINARY LABELLING RULE, AND IT IS THE SAME SHARP EDGE CALIFORNIA HIT.
 *   Regulation 72(a) requires the container of a medicine for an animal to carry
 *   the species, age, breed and sex of the animal and the name of its owner or
 *   carer. Those particulars are conditional on the patient being an animal, and
 *   `ObligationParameters.fields` is an unconditional list — so putting them in
 *   `fields` would demand them on every human dispense. They are carried in the
 *   `detail` text of the labelling rules instead, which a pharmacist reads and a
 *   screen cannot enforce. Recorded in KNOWN_ISSUES rather than papered over.
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';
import { AU_CLASSIFICATIONS } from './regulatory-au.js';

/** The day this pack becomes evaluable. Not the day any of these regulations was made. */
export const AU_VIC_PACK_EFFECTIVE_FROM = '2026-08-20';

export const AU_VIC_AUTHORITIES = [
  {
    code: 'VIC_DH',
    name: 'Department of Health (Victoria)',
    websiteUrl: 'https://www.health.vic.gov.au/drugs-and-poisons',
    remit:
      'The Secretary to the Victorian Department of Health administers the Drugs, Poisons and ' +
      'Controlled Substances Act 1981 and the Regulations made under it — licences and permits to ' +
      'deal in poisons, Schedule 8 treatment permits, and the monitored poisons database ' +
      '(SafeScript). A State authority, separate from and additional to the TGA, whose law is ' +
      'what actually binds a pharmacist in Victoria.',
  },
] as const;

/**
 * ⚠️ SEVEN SOURCES FOR ONE INSTRUMENT, KEYED BY PART. `regulatory_sources` is
 *   matched on `(authority, document_reference)`, and the staleness report reads
 *   `retrievedAt` per row — so splitting the Regulations by Part means a
 *   reviewer re-checking the records provisions marks the records Part fresh
 *   without claiming to have re-read the storage Part. The alternative, one row
 *   for the whole 321-page consolidation, makes every citation as stale as the
 *   least-recently-read clause in it.
 */
const AUTHORISED_PDF =
  'https://content.legislation.vic.gov.au/sites/default/files/2026-07/17-29sra021-authorised.pdf';

const VERSION = 'Authorised Version No. 021, as at 1 July 2026';

export const AU_VIC_SOURCES: SourceSeed[] = [
  {
    key: 'VIC_DPCS_PART2',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 2 — ' +
      'permits and forms',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 10–12',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 10 to 12 read in full. A special Schedule 8 permit is issued by the Secretary ' +
      'and authorises a named practitioner to prescribe, supply, authorise the administration of ' +
      'or administer a named special Schedule 8 poison to a NAMED patient. The note to reg 10(1) ' +
      'records that s. 34 of the Act requires a permit where treatment of a person who is not ' +
      'drug-dependent runs for a continuous period greater than 8 weeks.',
  },
  {
    key: 'VIC_DPCS_PART5',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 5 — sale ' +
      'and supply by practitioners other than pharmacists',
    documentReference: 'S.R. No. 29/2017 (Vic), reg 36',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulation 36 read in full. A registered medical practitioner may sell or supply a ' +
      'Schedule 4 or Schedule 8 poison for the medical treatment of a person under the ' +
      'practitioner’s care and to whom it is supplied — which is the proviso ' +
      '`exemptWhenActorIsPrescriber` exists to express. Reg 36(e) makes the special Schedule 8 ' +
      'permit a precondition of that supply where reg 10 requires one.',
  },
  {
    key: 'VIC_DPCS_PART6',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 6 — sale ' +
      'and supply by pharmacists',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 47, 48, 50, 51',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 47, 48, 50 and 51 read in full. Reg 50(2): a pharmacist must not supply a ' +
      'Schedule 4 poison "if it is more than 12 months since the date stated on the prescription ' +
      'as the day on which the prescription was written". Reg 51(3) is the same sentence with ' +
      '6 months for Schedule 8. The prescriber lists in regs 47(1)(a)(i) and 48(1)(a)(i) differ ' +
      'by two: an authorised optometrist and an authorised podiatrist may prescribe Schedule 4 ' +
      'and may not prescribe Schedule 8.',
  },
  {
    key: 'VIC_DPCS_PART7',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 7 — ' +
      'labelling and storage',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 72–74',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 72, 73 and 74 read in full. Reg 73(2) requires Schedule 4 poisons in "a ' +
      'lockable storage facility"; reg 74(2) requires Schedule 8 poisons in a facility at least ' +
      'equivalent to one of 10 mm mild steel plate, continuously welded, with a 6 lever lock, ' +
      'attached so as to resist hand tools for 30 minutes and power tools for 5. The two are a ' +
      'materially different obligation and this pack does not collapse them.',
  },
  {
    key: 'VIC_DPCS_PART13',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 13 — records',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 107–109',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 107, 108 and 109 read in full. Reg 109(4): a record of each transaction in a ' +
      'Schedule 4, Schedule 8 or Schedule 9 poison is retained "in a readily retrievable form for ' +
      '3 years from the date of the transaction". Reg 109(1) adds, for Schedule 8 and 9 only, ' +
      'that the records must sort by poison and show a true running balance after each ' +
      'transaction; reg 109(6) that they must not be alterable without detection.',
  },
  {
    key: 'VIC_DPCS_PART14',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 14 — ' +
      'destruction of Schedule 8 and Schedule 9 poisons',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 114–115',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 114 and 115 read in full. Reg 114 prohibits wilful destruction outright; ' +
      'reg 115(3) disapplies it where a pharmacist (among others) destroys the poison IN THE ' +
      'PRESENCE OF another registered person and records the name, strength and quantity, the ' +
      'method and place, and the names of both the destroyers and the witnesses.',
  },
  {
    key: 'VIC_DPCS_PART20',
    authorityCode: 'VIC_DH',
    title:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), Chapter 2 Part 20 — ' +
      'monitored poisons database',
    documentReference: 'S.R. No. 29/2017 (Vic), regs 132C–132E and Schedule 6',
    sourceUrl: AUTHORISED_PDF,
    version: VERSION,
    publishedOn: '2026-07-01',
    reviewStatus: 'UNVERIFIED',
    notes:
      'Regulations 132C, 132D and 132E and Schedules 5 and 6 read in full. Item 1 of Schedule 6 ' +
      'makes ALL Schedule 8 poisons monitored supply poisons. Reg 132D requires a pharmacist who ' +
      'creates a record of supply on a compatible electronic system to register with a ' +
      'prescription exchange service and provide the record AT THE TIME the record is created — ' +
      'which is why the cadence below is at the time of supply and not a periodic return.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

/**
 * The prescriber classes regulation 47(1)(a)(i) names for a Schedule 4 poison.
 *
 * ⚠️ A REGISTRATION, NOT AN rcln ROLE — the discipline `RegulatoryActor` sets
 *   out. "Nurse practitioner" here is an endorsement on a national registration,
 *   not a job title a clinic may rename, and the caller supplies it from the
 *   prescriber's record rather than from the person dispensing.
 */
const SCHEDULE_4_PRESCRIBERS = [
  'MEDICAL_PRACTITIONER',
  'VETERINARY_PRACTITIONER',
  'DENTIST',
  'NURSE_PRACTITIONER',
  'AUTHORISED_MIDWIFE',
  'AUTHORISED_OPTOMETRIST',
  'AUTHORISED_PODIATRIST',
];

/**
 * Regulation 48(1)(a)(i) — the same list MINUS the optometrist and the
 * podiatrist.
 *
 * ⚠️ THE TWO-NAME DIFFERENCE IS THE RULE, NOT AN OVERSIGHT IN THE DRAFTING. An
 *   authorised optometrist may prescribe a Schedule 4 poison in Victoria and may
 *   not prescribe a Schedule 8 one. Collapsing the two lists into one shared
 *   constant would permit an optometrist's Schedule 8 prescription, which is the
 *   kind of silent widening this whole domain is built to prevent.
 */
const SCHEDULE_8_PRESCRIBERS = [
  'MEDICAL_PRACTITIONER',
  'VETERINARY_PRACTITIONER',
  'DENTIST',
  'NURSE_PRACTITIONER',
  'AUTHORISED_MIDWIFE',
];

export const AU_VIC_RULES: RuleSeed[] = [
  /*
   * Regulations 47(1)(a) and 50(2) — Schedule 4 on prescription, and the
   * twelve-month expiry.
   *
   * ⚠️ `validityMonths`, NOT `validityDays`, AND THE DIFFERENCE IS NOT
   *   COSMETIC. Reg 50(2) counts "more than 12 months since the date stated on
   *   the prescription": a script written 29 February is lawful on 28 February
   *   the next year, and twelve months is not 365 days in any year containing a
   *   leap day. `validityMonths` was added in PI-13a for exactly this sentence
   *   and this is the second pack to use it.
   */
  {
    code: 'VIC-RX-S4',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A pharmacist may supply a Schedule 4 poison only on the original prescription of an ' +
      'authorised prescriber, and not more than 12 months after the date written on it. Obtain a ' +
      'current prescription before supplying this.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule4,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityMonths: 12 },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 47(1)(a), 50(2)',
  },

  /*
   * Regulations 48(1)(a), 51(2) and 51(3) — Schedule 8 on prescription, six
   * months, and the verification proviso the framework cannot check.
   */
  {
    code: 'VIC-RX-S8',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A pharmacist may supply a Schedule 8 poison only on the original prescription of an ' +
      'authorised prescriber, and not more than 6 months after the date written on it — and not ' +
      'in a quantity allowing more than 2 days’ treatment unless the prescription is handwritten ' +
      'in writing the pharmacist knows, or the pharmacist has taken all reasonable steps to verify ' +
      'that the purported prescriber wrote it.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true, validityMonths: 6 },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 48(1)(a), 51(2), 51(3)',
  },

  /*
   * Who may prescribe. Regulations 47(1)(a)(i) and 48(1)(a)(i).
   *
   * ⚠️ THESE RULES REFUSE UNTIL THE CALLER SUPPLIES THE PRESCRIBER'S
   *   REGISTRATION CLASS, WHICH IS THE INTENDED COST AND NOT A DEFECT.
   *   `evaluatePrescriberAuthority` answers `UNDETERMINED` — which refuses —
   *   when `prescription.prescriberClasses` is absent. The United States pack
   *   pays the same price for the same reason; the remedy is for the dispensing
   *   service to supply the class, never for the rule to be softened.
   */
  {
    code: 'VIC-PRESCRIBER-S4',
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      'A Schedule 4 poison may be supplied only on the prescription of a registered medical ' +
      'practitioner, veterinary practitioner, dentist, nurse practitioner, authorised midwife, ' +
      'authorised optometrist or authorised podiatrist. Confirm the prescriber’s registration ' +
      'before supplying.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule4,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: SCHEDULE_4_PRESCRIBERS },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), reg 47(1)(a)(i)',
  },
  {
    code: 'VIC-PRESCRIBER-S8',
    ruleType: 'PRESCRIBER_AUTHORITY',
    statement:
      'A Schedule 8 poison may be supplied only on the prescription of a registered medical ' +
      'practitioner, veterinary practitioner, dentist, nurse practitioner or authorised midwife. ' +
      'An authorised optometrist or podiatrist may not prescribe one. Confirm the prescriber’s ' +
      'registration before supplying.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedPrescriberClasses: SCHEDULE_8_PRESCRIBERS },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), reg 48(1)(a)(i)',
  },

  /*
   * Who may dispense. Regulations 47(1) and 48(1) are addressed to a pharmacist;
   * regulation 36(a) lets a registered medical practitioner sell or supply the
   * same poisons for the medical treatment of a person under their own care.
   *
   * ⚠️ `exemptWhenActorIsPrescriber` IS SET, UNLIKE THE UNITED STATES PACK, AND
   *   THE CONTRAST IS RESEARCHED RATHER THAN INHERITED. 21 CFR 1306.06 makes
   *   filling a prescription a pharmacist's act whoever wrote it, so the US rule
   *   carries no exemption. Victoria writes the doctor-dispensing case into
   *   regulation 36 as its own authority — the same shape as India's Pharmacy
   *   Act s. 42(1), which is what the key was built for. Without it, a
   *   doctor-run Victorian clinic dispensing to its own patients would be
   *   refused by a rule that does not apply to it.
   *
   * ⚠️ BOTH HALVES MUST BE TRUE: the rule opts in, AND `actor.isPrescriber` must
   *   be derived by the service from the encounter's prescriber and the caller's
   *   user id. A client that could assert it would be granting itself the
   *   exemption.
   */
  {
    code: 'VIC-DISPENSER-S4',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A Schedule 4 poison is sold or supplied by a registered pharmacist — or by the prescriber ' +
      'themselves, for the medical treatment of a person under their own care. Hand this to a ' +
      'registered pharmacist.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule4,
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: {
      permittedLicenceTypes: ['REGISTERED_PHARMACIST'],
      exemptWhenActorIsPrescriber: true,
    },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 47(1), 36(a)',
  },
  {
    code: 'VIC-DISPENSER-S8',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A Schedule 8 poison is sold or supplied by a registered pharmacist — or by the prescriber ' +
      'themselves, for the medical treatment of a person under their own care and only where they ' +
      'hold any Schedule 8 permit that regulation 10 requires. Hand this to a registered ' +
      'pharmacist.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'],
    parameters: {
      permittedLicenceTypes: ['REGISTERED_PHARMACIST'],
      exemptWhenActorIsPrescriber: true,
    },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 48(1), 36(a), 36(e)',
  },

  /*
   * The Schedule 8 obligations that the national pack has no instrument to
   * impose: the register (Part 13) and the treatment permit (regulation 10).
   *
   * ⚠️ THIS IS THE FIRST `VERIFY_PRIOR_AUTHORISATION` RAISED BY A REAL PACK IN
   *   THIS PROGRAMME, AND PI-13a NAMED THIS EXACT CASE WHEN IT BUILT THE KIND.
   *   A special Schedule 8 permit is the Secretary's written authority to treat
   *   a NAMED patient with a NAMED drug. It lives in a State registry rcln does
   *   not talk to, so refusing for want of a record we could never hold would
   *   block every lawful Schedule 8 supply in Victoria, and permitting silently
   *   would drop the requirement that makes the supply lawful. The condition
   *   says which, and names the Secretary so the screen can say where to look.
   *
   * ⚠️ AND IT IS ONE OF THE TWO CONDITIONS THE PERSON DISPENSING CANNOT
   *   DISCHARGE. `RegulatoryCondition` warns that rendering it as an "I confirm"
   *   tick-box makes a pharmacist attest to somebody else's filing cabinet. The
   *   UI question is open — see OPEN_DECISIONS.md — and this pack is the first
   *   thing that makes it concrete rather than hypothetical.
   *
   * ⚠️ THE PERMIT IS NOT REQUIRED FOR EVERY SCHEDULE 8 SUPPLY, AND THE CONDITION
   *   IS RAISED FOR EVERY ONE ANYWAY. Regulation 10 requires it only in defined
   *   circumstances — a special Schedule 8 poison, a patient who is not
   *   drug-dependent, treatment running past eight weeks under s. 34 of the Act
   *   — and none of those facts is one this platform holds. Raising a condition
   *   that says "check whether one is required, and that it is in force" is
   *   over-inclusive; refusing to raise it would be under-inclusive in the cases
   *   where the permit is the whole control. The detail text carries the
   *   qualification so the over-inclusion is visible to whoever reads it.
   *
   * ⚠️ NO `storageLocationKinds`, BECAUSE THE STORAGE RULE BELOW CARRIES IT.
   *   Regulation 74 is a construction standard for a facility, not a list of
   *   permitted location kinds, and a `STORAGE_REQUIREMENT` rule is where a
   *   caller looks for it.
   */
  {
    code: 'VIC-SCHEDULE-S8',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'Record this Schedule 8 transaction in the drugs register as soon as practicable, sorted by ' +
      'poison and showing the true running balance, in a form that cannot be altered without ' +
      'detection.',
    sourceKey: 'VIC_DPCS_PART13',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: {
      scheduleName: 'Schedule 8',
      registerRequired: true,
    },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 108, 109(1), 109(6)',
  },

  /*
   * ⚠️ A SECOND `CONTROLLED_SCHEDULE` RULE OF THE SAME CLASSIFICATION, ON
   *   PURPOSE, AND IT RELIES ON A DOCUMENTED PROPERTY OF `mostSpecific()`: TIES
   *   ARE KEPT, NOT BROKEN. Two equally-specific rules of one type both apply
   *   and the engine evaluates both. Folding the permit into the register rule
   *   above would be one row less and would raise "check the Schedule 8 permit"
   *   on a DESTRUCTION and a STOCK RECEIPT — transactions no permit has anything
   *   to say about — because the register obligation does reach those and the
   *   permit does not. Two rules is how the framework says "these two
   *   obligations engage on different transactions".
   */
  {
    code: 'VIC-PERMIT-S8',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'Where regulation 10 requires a special Schedule 8 permit for this patient and this drug, ' +
      'the prescriber must already hold one. Check it is in force before supplying.',
    sourceKey: 'VIC_DPCS_PART2',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      scheduleName: 'Schedule 8',
      priorAuthorisationRequired: true,
      authorisationAuthority: 'the Secretary to the Victorian Department of Health',
    },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 10, 12, 36(e)',
  },

  /*
   * Storage. Regulation 73(2) for Schedule 4, regulation 74(2) for Schedule 8.
   *
   * ⚠️ ONLY THE SCHEDULE 8 RULE SETS `controlledAccessRequired`, AND THE
   *   ASYMMETRY IS THE RESEARCH RATHER THAN AN OMISSION.
   *   `evaluateStorageRequirement` REFUSES a `STOCK` or `TRANSFER` into a
   *   location whose `hasControlledAccess` is not true when the key is set. Reg
   *   74(2) demands a facility equivalent to 10 mm continuously-welded mild
   *   steel with a 6 lever lock, resisting hand tools for 30 minutes — a safe,
   *   and refusing a Schedule 8 receipt into anything else is correct. Reg 73(2)
   *   demands of a Schedule 4 poison only "a lockable storage facility", which
   *   every dispensary is; setting the key there would refuse routine, lawful
   *   goods receipt of ordinary prescription medicines into ordinary stock. The
   *   United States pack made the same call for the same reason, from the
   *   opposite direction — 21 CFR 1301.75(b) expressly permits dispersal through
   *   stock, so it sets no location restriction at all.
   */
  {
    code: 'VIC-STORE-S4',
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      'Keep Schedule 4 poisons in a lockable storage facility, and take all reasonable steps to ' +
      'keep it locked and secured against access by anyone not authorised.',
    sourceKey: 'VIC_DPCS_PART7',
    appliesToClassification: AU_CLASSIFICATIONS.schedule4,
    appliesToTransactions: ['STOCK', 'TRANSFER', 'DISPENSE', 'COUNTER_SALE'],
    parameters: {
      detail:
        'A lockable storage facility, kept locked and secured at all times except when it is ' +
        'necessary to open it for an essential operation in connection with the poisons stored ' +
        'in it, or while an authorised practitioner is present.',
    },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 73(2), 73(3)',
  },
  {
    code: 'VIC-STORE-S8',
    ruleType: 'STORAGE_REQUIREMENT',
    statement:
      'Keep Schedule 8 poisons in a storage facility at least equivalent to a welded 10 mm mild ' +
      'steel cabinet with a 6 lever lock, fixed so as to resist hand tools for 30 minutes and ' +
      'power tools for 5.',
    sourceKey: 'VIC_DPCS_PART7',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: ['STOCK', 'TRANSFER', 'DISPENSE', 'COUNTER_SALE'],
    parameters: {
      controlledAccessRequired: true,
      detail:
        'A lockable facility giving security at least equivalent to one constructed of 10 mm mild ' +
        'steel plate with all edges continuously welded, a flush-fitting door on welded hinges, a ' +
        'fixed internal locking bar, a 6 lever lock affixed to the rear face of the door, and ' +
        'attachment to a wall or floor that resists hand tools for 30 minutes and power tools for ' +
        '5. Approved electronic storage and recording equipment may be used instead, on the ' +
        'conditions in reg 74(3).',
    },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 74(2), 74(3)',
  },

  /*
   * Regulation 72 — the supplementary labelling requirements, which are ADDED to
   * whatever the Poisons Standard's Appendix L requires rather than replacing
   * it.
   *
   * ⚠️ WHICH MEANS THIS PACK'S LABEL IS SHORTER THAN THE LABEL A VICTORIAN
   *   PHARMACIST ACTUALLY PRINTS, AND SAYING SO IS THE POINT. Appendix L is the
   *   national dispensing label and could not be retrieved from the Federal
   *   Register in this pass, so `regulatory-au.ts` carries no labelling rule and
   *   there is nothing for this one to supersede. A screen driven by
   *   `LABEL_FIELDS` alone would print two fields and omit the patient's name.
   *   Recorded in KNOWN_ISSUES; the fix is Appendix L, not more fields invented
   *   here.
   */
  ...[AU_CLASSIFICATIONS.schedule4, AU_CLASSIFICATIONS.schedule8].map((classification) => ({
    code: `VIC-LABEL-${classification === AU_CLASSIFICATIONS.schedule4 ? 'S4' : 'S8'}`,
    ruleType: 'LABELLING_REQUIREMENT',
    statement:
      'Label the container with the date the record of supply was made and with the directions ' +
      'for use, in addition to everything the dispensing label already requires.',
    sourceKey: 'VIC_DPCS_PART7',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      fields: ['DATE_OF_RECORD_OF_SUPPLY', 'DIRECTIONS_FOR_USE'],
      detail:
        'The date of the making of the record of supply required by Part 13, and the directions ' +
        'for use — except where the prescription carried none, where the regimen is complex ' +
        'enough that separate written instructions were supplied, or where the medicine is ' +
        'supplied for a practitioner to administer. ⚠️ A MEDICINE FOR AN ANIMAL ALSO CARRIES the ' +
        'species, age, breed and sex of the animal and the name of the person who owns or cares ' +
        'for it; those particulars are conditional on the patient and are not in the field list.',
    },
    citation: 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), reg 72',
  })),

  /*
   * Regulation 109(4) — three years, for Schedule 4 and Schedule 8 alike.
   *
   * ⚠️ THIS SUPERSEDES NOTHING, UNLIKE CALIFORNIA'S THREE YEARS. There is no
   *   national Australian retention period for the state rule to displace,
   *   because Commonwealth law imposes none — so a branch in Sydney is told
   *   nothing about retention and a branch in Melbourne is told three years.
   *   That asymmetry is the honest state of the packs and not a gap in this one.
   */
  ...[AU_CLASSIFICATIONS.schedule4, AU_CLASSIFICATIONS.schedule8].map((classification) => ({
    code: `VIC-RETAIN-${classification === AU_CLASSIFICATIONS.schedule4 ? 'S4' : 'S8'}`,
    ruleType: 'RECORD_RETENTION',
    statement:
      'Keep the record of this transaction in a readily retrievable form, in English, for three ' +
      'years from the date of the transaction, and produce it on demand to an authorised officer.',
    sourceKey: 'VIC_DPCS_PART13',
    appliesToClassification: classification,
    appliesToTransactions: [],
    parameters: {
      years: 3,
      detail:
        'Three years from the date of the transaction, readily retrievable and in English, ' +
        'produced on demand to an authorised officer.',
    },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 109(3), 109(4), 109(5)',
  })),

  /*
   * Regulations 132C to 132E and item 1 of Schedule 6 — SafeScript.
   *
   * ⚠️ THE CADENCE IS "AT THE TIME OF SUPPLY", NOT A PERIODIC RETURN, AND THAT
   *   IS WHAT REG 132D ACTUALLY SAYS: the pharmacist "must provide the record of
   *   supply to the prescription exchange service AT THE TIME the record of
   *   supply is created". A daily or monthly cadence written here would describe
   *   a different obligation that happens to have the same name.
   */
  {
    code: 'VIC-REPORT-S8',
    ruleType: 'REPORTING_REQUIREMENT',
    statement:
      'Provide the record of this supply to the prescription exchange service at the time the ' +
      'record is created, so that it reaches the monitored poisons database. Every Schedule 8 ' +
      'poison is a monitored supply poison.',
    sourceKey: 'VIC_DPCS_PART20',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: {
      cadence: 'AT_TIME_OF_SUPPLY',
      recipient: 'the monitored poisons database, via a registered prescription exchange service',
      detail:
        'The date of supply, the patient’s name, address and date of birth, the name, form, ' +
        'strength and quantity of the poison, the directions for use, and the name, address and ' +
        'phone number of both the person authorising the supply and the pharmacy — provided at ' +
        'the time the record of supply is created.',
    },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 132C, 132D, 132E(3)(b); ' +
      'Sch 6 item 1',
  },

  /*
   * Regulations 114 and 115(3) — destruction, and the witness that makes it
   * lawful.
   *
   * ⚠️ `witnessRequired` IS THE WHOLE RULE HERE. Reg 114 prohibits wilful
   *   destruction of a Schedule 8 poison outright; reg 115(3) disapplies the
   *   prohibition only where the destruction happens IN THE PRESENCE OF a second
   *   registered person and the details are recorded. So the witness is not a
   *   procedural nicety attached to a permitted act — its absence is the offence.
   */
  {
    code: 'VIC-DISPOSE-S8',
    ruleType: 'DISPOSAL_REQUIREMENT',
    statement:
      'A Schedule 8 poison may be destroyed only in the presence of a second registered person, ' +
      'and the destruction must be recorded. Destroying one otherwise is an offence.',
    sourceKey: 'VIC_DPCS_PART14',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: ['DISPOSE'],
    parameters: {
      witnessRequired: true,
      method:
        'Destruction in the presence of a registered medical practitioner, pharmacist, veterinary ' +
        'practitioner, dentist, nurse or registered midwife.',
      detail:
        'Record in the Part 13 records the name, strength and quantity of the poison destroyed, ' +
        'the method and place of destruction, the names of the persons carrying it out and the ' +
        'names of the witnesses.',
    },
    citation:
      'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), regs 114, 115(3), 108(1)(h)',
  },

  /*
   * Regulations 50(4)(c) and 51(5)(c) — brand substitution.
   *
   * ⚠️ `permitted: true` WITH THE PROVISO IN THE STATEMENT, WHICH IS THE
   *   CALIFORNIA CALL MADE AGAIN AND FOR THE SAME REASON. Victoria does not
   *   require consent to substitute; it forbids substitution WHERE THE
   *   PRESCRIPTION SPECIFIES A BRAND. `requiresPrescriberConsent` models
   *   "consent required" and would refuse every lawful substitution in the
   *   state, because the framework's default and the regulation's default are
   *   opposite. The fact that would settle it — whether this prescription names
   *   a brand — is not one the engine is given. Recorded in KNOWN_ISSUES as the
   *   same framework gap California raised, now met twice.
   */
  ...[AU_CLASSIFICATIONS.schedule4, AU_CLASSIFICATIONS.schedule8].map((classification) => ({
    code: `VIC-SUBST-${classification === AU_CLASSIFICATIONS.schedule4 ? 'S4' : 'S8'}`,
    ruleType: 'SUBSTITUTION',
    statement:
      'A different brand may be supplied — unless the prescription specifies that only a specific ' +
      'brand is to be supplied, in which case supplying another is an offence.',
    sourceKey: 'VIC_DPCS_PART6',
    appliesToClassification: classification,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permitted: true },
    citation:
      classification === AU_CLASSIFICATIONS.schedule4
        ? 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), reg 50(4)(c)'
        : 'Drugs, Poisons and Controlled Substances Regulations 2017 (Vic), reg 51(5)(c)',
  })),
];
