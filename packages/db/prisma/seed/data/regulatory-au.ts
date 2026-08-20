/**
 * AUSTRALIA — national rule pack `AU` 1.0.0, read from the Poisons Standard.
 *
 * ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE. Read from the Federal Register of
 *   Legislation's own text of the instrument and cited paragraph by paragraph,
 *   reviewed by nobody qualified. The pack's maturity says so.
 *
 * ── THE PACK THAT BINDS NOBODY, AND WHY IT SHIPS ANYWAY ──────────────────────
 * ⚠️ AUSTRALIA IS THE ONE JURISDICTION IN THIS PROGRAMME WHOSE NATIONAL
 *   INSTRUMENT HAS NO LEGAL FORCE OF ITS OWN, AND EVERY RULE BELOW HAS TO BE
 *   READ IN THAT LIGHT. The Poisons Standard is made under paragraph 52D(2)(b)
 *   of the Therapeutic Goods Act 1989 and it *recommends*: it "lists poisons in
 *   10 Schedules according to the degree of control RECOMMENDED to be exercised
 *   over their availability to the public", and Schedule 4 is defined as
 *   substances "the use or supply of which SHOULD be by or on the order of
 *   persons permitted by STATE OR TERRITORY LEGISLATION to prescribe". It is
 *   each State's and Territory's own drugs-and-poisons law that makes any of it
 *   an offence.
 *
 *   That is the opposite of the United States, where 21 CFR 1306 binds a
 *   pharmacy in Nevada whether or not Nevada legislates — and it is why
 *   COUNTRY_RULE_PACK_SURVEY.md called Australia the hardest pack in the
 *   programme and required PI-15 to ship a state pack or not ship at all. It
 *   did: `regulatory-au-vic.ts` is Victoria, and it supersedes almost every rule
 *   in this file for a Victorian branch.
 *
 * ⚠️ SO WHAT IS THIS FILE FOR? A branch in Sydney, Brisbane or Perth has no
 *   state pack yet, and the alternative to these four rules is `UNDETERMINED` on
 *   every Australian dispense — which refuses, and refuses for a reason nobody
 *   can act on. These rules are the FLOOR the whole country's law is built on
 *   and none of the eight jurisdictions departs from: everywhere in Australia a
 *   Schedule 4 medicine needs a prescription and a Schedule 8 medicine is
 *   controlled. Each rule's statement says out loud that the Poisons Standard
 *   works through State and Territory legislation, so nobody reading a refusal
 *   mistakes this for the operative provision.
 *
 * ⚠️ AND THE HONEST CONSEQUENCE: THIS PACK IS DELIBERATELY THIN, AND ITS
 *   THINNESS IS A FINDING RATHER THAN AN UNFINISHED JOB. There is no federal
 *   dispensing label, no federal record-retention period, no federal register,
 *   no federal storage standard and no federal prescription validity — because
 *   Australia has none. Every one of those is written in `regulatory-au-vic.ts`
 *   against a Victorian regulation. Adding a national rule for any of them would
 *   mean inventing one.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * ⚠️ NO SCHEDULE 2 SUPPLY RULE. Schedule 2 is defined as substances that "should
 *   be available from a pharmacy or, WHERE A PHARMACY SERVICE IS NOT AVAILABLE,
 *   FROM A LICENSED PERSON". A `PHARMACIST_AUTHORITY` rule naming a pharmacist
 *   licence would refuse the second limb — the licensed non-pharmacy seller the
 *   Standard expressly contemplates — so the rule was not written. Schedule 3,
 *   which says "available to the public FROM A PHARMACIST without a
 *   prescription" and admits no such alternative, is written.
 *
 * ⚠️ NO DISPENSING LABEL RULE. Paragraph 40 of the instrument disapplies its own
 *   labelling requirements from a dispensed medicine labelled in accordance with
 *   clause 1 of Appendix L — so Appendix L IS the national dispensing label, and
 *   its text could not be retrieved from the Federal Register in this pass (the
 *   instrument's HTML truncates before the appendices and its PDF is thousands
 *   of pages of substance listings). No source, no rule. The matrix cell stays
 *   `RESEARCH_REQUIRED` and a reviewer with access should close it.
 *
 * ⚠️ NO IMPORT RESTRICTION. Regulation 5 of the Customs (Prohibited Imports)
 *   Regulations 1956 makes the import of a narcotic conditional on a licence and
 *   a permission, which is genuinely federal and genuinely operative — and the
 *   consolidated text could not be reached in this pass. Same discipline as the
 *   DSCSA gap in the United States pack: recorded, not guessed.
 *
 * ⚠️ NO PBS RULES. The National Health (Pharmaceutical Benefits) Regulations
 *   2017 govern prescription validity, repeats and maximum quantities for
 *   SUBSIDISED supply, and they are federal and directly operative. They apply
 *   only to a PBS prescription, and this platform holds no fact that says
 *   whether a given supply is one. A rule written as though every Australian
 *   dispense were a PBS dispense would be wrong far more often than right.
 */
import type { RuleSeed, SourceSeed } from './regulatory-in.js';

/** The day this pack becomes evaluable. Not the day the Poisons Standard commenced. */
export const AU_PACK_EFFECTIVE_FROM = '2026-08-20';

export const AU_AUTHORITIES = [
  {
    code: 'TGA',
    name: 'Therapeutic Goods Administration',
    websiteUrl: 'https://www.tga.gov.au/',
    remit:
      'Australia’s national medicines and medical devices regulator, part of the Department of ' +
      'Health, Disability and Ageing. Administers the Therapeutic Goods Act 1989 and makes the ' +
      'Poisons Standard under section 52D. ⚠️ It schedules substances; it does not police ' +
      'dispensing — that is each State’s and Territory’s own drugs and poisons authority.',
  },
] as const;

export const AU_SOURCES: SourceSeed[] = [
  {
    key: 'AU_POISONS_STANDARD',
    authorityCode: 'TGA',
    title:
      'Therapeutic Goods (Poisons Standard—June 2026) Instrument 2026 — the Standard for the ' +
      'Uniform Scheduling of Medicines and Poisons (SUSMP)',
    documentReference: 'F2026L00633, Parts 1 and 2 and the Schedule descriptions',
    sourceUrl: 'https://www.legislation.gov.au/F2026L00633/asmade',
    version: 'June 2026, cited as SUSMP No. 48',
    publishedOn: '2026-05-28',
    reviewStatus: 'UNVERIFIED',
    notes:
      'From the Federal Register of Legislation, the authorised whole-of-government publication ' +
      'of Commonwealth law. Commenced 1 June 2026. The Schedule descriptions and paragraph 40 ' +
      '(dispensed medicines) were read in full; the substance listings and the Appendices were ' +
      'not, and Appendix L — the national dispensing label — could not be retrieved at all. ' +
      '⚠️ THE INSTRUMENT RECOMMENDS RATHER THAN BINDS: it takes legal effect only as adopted by ' +
      'State and Territory legislation. UNVERIFIED means no qualified person has confirmed the ' +
      'READING.',
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * The classification strings this pack is written against.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `product_regulatory_profiles.classification`, AND
 *   NOT PARSED, CASE-FOLDED OR TRIMMED — the same discipline the India and
 *   United States packs are written under. A clinic that records "S8" or
 *   "Schedule 8" instead of `SCHEDULE_8` has a product no rule in this pack
 *   matches, which resolves `UNDETERMINED` and refuses rather than silently
 *   permitting, and still looks to that clinic like the platform is broken.
 *
 * ⚠️ SCHEDULES 5, 6, 7, 9 AND 10 ARE ABSENT ON PURPOSE. Schedules 5 to 7 are
 *   non-medicinal poisons — paints, solvents, agricultural chemicals — which a
 *   clinic pharmacy does not dispense. Schedules 9 and 10 are prohibited
 *   substances, available only under a research permit or not at all; a pack
 *   rule for them would describe supply this platform must never model as
 *   routine. Schedule 1 is intentionally blank in the instrument itself.
 */
export const AU_CLASSIFICATIONS = {
  schedule2: 'SCHEDULE_2',
  schedule3: 'SCHEDULE_3',
  schedule4: 'SCHEDULE_4',
  schedule8: 'SCHEDULE_8',
} as const;

/** Every transaction in which a product reaches a patient, whatever the channel. */
const SUPPLY_TO_PATIENT = ['DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE'];

export const AU_RULES: RuleSeed[] = [
  /*
   * Schedule 4 — "Substances, the use or supply of which should be by or on the
   * order of persons permitted by State or Territory legislation to prescribe
   * and should be available from a pharmacist on prescription."
   *
   * ⚠️ NO `validityMonths`, AND ITS ABSENCE IS THE WHOLE POINT OF THE FILE
   *   HEADER. The Poisons Standard sets no expiry on a prescription, because
   *   expiry is a State question — Victoria says twelve months for Schedule 4
   *   and six for Schedule 8, and `regulatory-au-vic.ts` carries both. A
   *   national validity invented here would be superseded in Victoria and wrong
   *   everywhere else.
   *
   * ⚠️ AND NO `PRESCRIBER_AUTHORITY` RULE BESIDE IT, WHICH IS THE SHARPER
   *   OMISSION. The Standard names no prescriber classes: it says "persons
   *   permitted by State or Territory legislation", which is a pointer to eight
   *   different lists rather than a list. `evaluatePrescriberAuthority` refuses
   *   a rule that names no classes as unreadable, and rightly — so the rule is
   *   absent rather than stubbed. Victoria's two lists are in the state pack.
   */
  {
    code: 'AU-RX-S4',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A Schedule 4 prescription only medicine is supplied by or on the order of a person ' +
      'permitted by State or Territory legislation to prescribe, and from a pharmacist on ' +
      'prescription. Obtain the prescription before supplying this.',
    sourceKey: 'AU_POISONS_STANDARD',
    appliesToClassification: AU_CLASSIFICATIONS.schedule4,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true },
    citation: 'Poisons Standard (June 2026), Schedule 4 description',
  },

  /*
   * Schedule 8 — "Substances which should be available for use but require
   * restriction of manufacture, supply, distribution, possession and use to
   * reduce abuse, misuse and physical or psychological dependence."
   *
   * ⚠️ THE STANDARD DOES NOT SAY "ON PRESCRIPTION" FOR SCHEDULE 8, AND THIS RULE
   *   SAYS IT ANYWAY. Read strictly, the Schedule 8 description names a degree
   *   of restriction and leaves the mechanism to the States — every one of which
   *   requires a prescription. Writing `required: true` here is therefore a
   *   reading of the Standard against the uniform practice it exists to produce,
   *   not a quotation of it. It is recorded as such rather than dressed up: the
   *   citation names the Schedule 8 description, the statement names State and
   *   Territory legislation, and a Victorian branch gets `VIC-RX-S8` instead,
   *   which is quoted from an actual offence provision.
   */
  {
    code: 'AU-RX-S8',
    ruleType: 'PRESCRIPTION_REQUIRED',
    statement:
      'A Schedule 8 controlled drug is available only under the restrictions on supply, ' +
      'distribution and possession that State and Territory legislation imposes, which everywhere ' +
      'in Australia means on prescription. Obtain the prescription before supplying this.',
    sourceKey: 'AU_POISONS_STANDARD',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { required: true },
    citation: 'Poisons Standard (June 2026), Schedule 8 description',
  },

  /*
   * Schedule 3 — "Substances, the safe use of which requires professional advice
   * but which should be available to the public from a pharmacist without a
   * prescription."
   *
   * ⚠️ A LICENCE TYPE, NOT A ROLE CODE — see the warning on `RegulatoryActor`. A
   *   clinic may rename its `PHARMACIST` role to "Dispensary Lead" tomorrow, and
   *   a rule naming the role would then match nobody at that clinic.
   *
   * ⚠️ NO `exemptWhenActorIsPrescriber`. The Schedule 3 description contains no
   *   proviso of the kind India's Pharmacy Act s. 42(1) writes into the section
   *   itself, and a pharmacist-only medicine supplied without a prescription is
   *   precisely the transaction the pharmacist's advice is the control on.
   */
  {
    code: 'AU-SUPPLY-S3',
    ruleType: 'PHARMACIST_AUTHORITY',
    statement:
      'A Schedule 3 pharmacist only medicine may be supplied to the public without a prescription, ' +
      'but only by a pharmacist, because the professional advice is the control. Hand this to a ' +
      'registered pharmacist.',
    sourceKey: 'AU_POISONS_STANDARD',
    appliesToClassification: AU_CLASSIFICATIONS.schedule3,
    appliesToTransactions: SUPPLY_TO_PATIENT,
    parameters: { permittedLicenceTypes: ['REGISTERED_PHARMACIST'] },
    citation: 'Poisons Standard (June 2026), Schedule 3 description',
  },

  /*
   * The schedule itself, carried so that a Schedule 8 decision anywhere in
   * Australia says which schedule it is.
   *
   * ⚠️ NO `registerRequired`, NO `priorAuthorisationRequired`, NO
   *   `storageLocationKinds` — AND EACH ABSENCE IS RESEARCHED RATHER THAN
   *   FORGOTTEN. The controlled-drugs register, the Schedule 8 treatment permit
   *   and the safe are all real obligations and all three are STATE obligations:
   *   Victoria's are regulations 108, 10 and 74 respectively, and they are
   *   written in `regulatory-au-vic.ts` on a rule of this same type, which
   *   supersedes this one for a Victorian branch. Setting any of them here would
   *   assert a national obligation that no national instrument imposes — and
   *   would raise it, wrongly, in the seven jurisdictions that have no pack yet.
   *
   * ⚠️ WHICH MAKES THIS RULE CARRY NO CONDITIONS AT ALL, AND THAT IS NOT A BUG.
   *   `evaluateControlledSchedule` permits with an empty condition list and one
   *   reason line naming the schedule. The reason is the value: without it a
   *   Schedule 8 supply in Sydney would come back indistinguishable from an
   *   ordinary one.
   */
  {
    code: 'AU-SCHEDULE-S8',
    ruleType: 'CONTROLLED_SCHEDULE',
    statement:
      'This is a Schedule 8 controlled drug. Its manufacture, supply, distribution, possession and ' +
      'use are restricted to reduce abuse, misuse and dependence, on the terms the State or ' +
      'Territory imposes.',
    sourceKey: 'AU_POISONS_STANDARD',
    appliesToClassification: AU_CLASSIFICATIONS.schedule8,
    appliesToTransactions: [...SUPPLY_TO_PATIENT, 'STOCK', 'TRANSFER', 'DISPOSE'],
    parameters: { scheduleName: 'Schedule 8' },
    citation: 'Poisons Standard (June 2026), Schedule 8 description',
  },
];
