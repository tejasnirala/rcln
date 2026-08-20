/**
 * Jurisdictions, authorities, sources and rule packs — the law rcln publishes.
 *
 * ⚠️ PLATFORM DATA. Not one row here carries an `organization_id`, because the
 *   law of a country is identical for every clinic in it. These five tables have
 *   no RLS policy on purpose — a `tenant_isolation` policy would return zero
 *   rows for EVERYONE, every evaluation would answer `UNDETERMINED`, and
 *   `UNDETERMINED` refuses, so nobody anywhere could dispense anything. The
 *   reasoning is written out in full in `schema/regulatory.prisma`, and the
 *   tables are on the EXEMPT list in `scripts/check-rls.ts` with it.
 *
 * ⚠️ THIS FILE IS THE MACHINERY AND HOLDS NO COUNTRY'S RULES. Every rule lives
 *   in `data/regulatory-<cc>.ts`, cited to a source, and a new jurisdiction is a
 *   new data file plus one line in `main()` — never a branch in here. There is
 *   no `if (country === 'IN')` in this programme, and this file is the one place
 *   somebody would be tempted to write the first one.
 *
 * ── THE MATURITY THIS SEED MAY SET, AND THE TWO IT MAY NOT ───────────────────
 * ⚠️ A SEED IS CODE, SO IT MAY NOT SET `REGULATORY_REVIEWED` OR
 *   `PRODUCTION_ENABLED` (PI-ADR-009). Those are a named human's, holding
 *   `regulatory.pack.approve`, and the database refuses the transition from any
 *   other path.
 *
 * ⚠️ THE INDIA PACK IS SEEDED AT `AUTOMATED_TESTED`, WHICH IS EARNED AND NOT
 *   ASSUMED. Each rung below it is actually met: the rules exist
 *   (`RULES_CONFIGURED`); goods receipt and transfer consult the engine while
 *   posting, alongside `POST /v1/regulatory/evaluate` (`RULES_IMPLEMENTED`); and
 *   behaviour tests pinning each rule ship with the pack (`AUTOMATED_TESTED`).
 *   It sat at `RULES_IMPLEMENTED` for exactly as long as the call sites were
 *   unwired — the ladder is a floor, not an inventory of what exists, so tests
 *   alone would not have bought this rung.
 *
 * ⚠️ AND NOT ONE RUNG HIGHER. `SOURCE_VERIFIED` needs somebody to re-check every
 *   citation against the document; India's sources still carry `UNVERIFIED`. The
 *   two above that are a named human's. So nothing this pack says BLOCKS
 *   anything — see `services/regulatory/enforcement.ts`, which only enforces at
 *   `PRODUCTION_ENABLED`.
 *
 * ── IDEMPOTENCE, AND THE ONE PLACE IT IS NOT SIMPLE ──────────────────────────
 * Everything upserts on a natural key, so the seed is safe to re-run. Rules
 * upsert on `(pack, code, version)` — a re-run of an UNCHANGED rule rewrites the
 * same row.
 *
 * ⚠️ CHANGING A RULE'S TEXT AND RE-SEEDING IS NOT HOW A RULE CHANGES, AND THIS
 *   IS THE SHARPEST EDGE IN THE FILE. Editing the data file and re-running would
 *   silently rewrite the row a past decision cites, and re-running the engine
 *   over that decision would then produce a different answer than the one on
 *   record — the exact thing PI-ADR-008 forbids. A real change is a NEW rule row
 *   at `version + 1` with its own `effectiveFrom`, and the old row moves to
 *   `SUPERSEDED` with an `effectiveTo`. Until a pack has been used in anger this
 *   distinction is theoretical; the day it stops being theoretical, nobody gets
 *   a warning.
 */
import { prisma } from './client.js';
import {
  IN_AUTHORITIES,
  IN_PACK_EFFECTIVE_FROM,
  IN_RULES,
  IN_SOURCES,
  type RuleSeed,
  type SourceSeed,
} from './data/regulatory-in.js';
import {
  US_AUTHORITIES,
  US_PACK_EFFECTIVE_FROM,
  US_RULES,
  US_SOURCES,
} from './data/regulatory-us.js';
import {
  US_CA_AUTHORITIES,
  US_CA_PACK_EFFECTIVE_FROM,
  US_CA_RULES,
  US_CA_SOURCES,
} from './data/regulatory-us-ca.js';
import {
  AU_AUTHORITIES,
  AU_PACK_EFFECTIVE_FROM,
  AU_RULES,
  AU_SOURCES,
} from './data/regulatory-au.js';
import {
  AU_VIC_AUTHORITIES,
  AU_VIC_PACK_EFFECTIVE_FROM,
  AU_VIC_RULES,
  AU_VIC_SOURCES,
} from './data/regulatory-au-vic.js';
import {
  SG_AUTHORITIES,
  SG_PACK_EFFECTIVE_FROM,
  SG_RULES,
  SG_SOURCES,
} from './data/regulatory-sg.js';
import {
  AE_AZ_AUTHORITIES,
  AE_AZ_PACK_EFFECTIVE_FROM,
  AE_AZ_RULES,
  AE_AZ_SOURCES,
} from './data/regulatory-ae-az.js';
import {
  AE_DU_AUTHORITIES,
  AE_DU_PACK_EFFECTIVE_FROM,
  AE_DU_RULES,
  AE_DU_SOURCES,
} from './data/regulatory-ae-du.js';

/** A `@db.Date` column takes a day, in the jurisdiction's own reckoning. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

interface PackSeed {
  countryCode: string;
  /**
   * ISO 3166-2 WITHOUT the country prefix — `CA`, not `US-CA`. Omitted for a
   * country-wide pack, which is what most are.
   *
   * ⚠️ A SUB-NATIONAL PACK DOES NOT REPLACE THE NATIONAL ONE, IT SUPERSEDES IT
   *   PER RULE TYPE (PI-13a). `mostSpecific()` in `@rcln/regulatory` prefers a
   *   regional rule over a national one OF THE SAME TYPE and leaves every other
   *   type standing — so California's three-year retention displaces the federal
   *   two-year retention, and says nothing whatever about the federal labelling
   *   or prescription rules, which continue to apply. Seeding a state pack as a
   *   COMPLETE restatement of the country's law would silently switch off every
   *   national rule it happened not to mention.
   *
   * ⚠️ AND THE PREFIXED FORM IS THE SILENT FAILURE HERE, AS IT IS EVERYWHERE
   *   ELSE IN THIS DOMAIN: `US-CA` never equals the `CA` on a branch, so the
   *   pack matches nothing, forever, while looking perfectly seeded.
   */
  regionCode?: string;
  countryName: string;
  authorities: readonly { code: string; name: string; websiteUrl: string; remit: string }[];
  sources: readonly SourceSeed[];
  rules: readonly RuleSeed[];
  packAuthorityCode: string;
  version: string;
  name: string;
  description: string;
  effectiveFrom: string;
}

const PACKS: readonly PackSeed[] = [
  {
    countryCode: 'IN',
    countryName: 'India',
    authorities: IN_AUTHORITIES,
    sources: IN_SOURCES,
    rules: IN_RULES,
    packAuthorityCode: 'CDSCO',
    version: '1.0.0',
    name: 'India — Drugs Rules 1945 and Pharmacy Act 1948',
    description:
      'Prescription requirements for Schedule H, H1 and X, the registers and retention periods ' +
      'that follow from them, who may dispense, container and dispensing labelling, and Schedule ' +
      'X storage. Configured from CDSCO’s own consolidated Drugs Rules and from the Pharmacy Act ' +
      'on India Code. ⚠️ No NDPS rules, no quantity limits, no age restrictions and no ' +
      'e-pharmacy position — each is either a specialist question or has no notified rule, and ' +
      'the country matrix says which. Not reviewed by a qualified person.',
    effectiveFrom: IN_PACK_EFFECTIVE_FROM,
  },
  {
    countryCode: 'US',
    countryName: 'United States of America',
    authorities: US_AUTHORITIES,
    sources: US_SOURCES,
    rules: US_RULES,
    packAuthorityCode: 'DEA',
    version: '1.0.0',
    name: 'United States — federal: Controlled Substances Act and FDCA § 503',
    description:
      'Prescription requirements for DEA Schedules II–V and for non-controlled legend drugs, the ' +
      'five-refill six-month limit, who may prescribe and who may fill, dispensing labels, ' +
      'controlled-substance recordkeeping and its two-year retention, storage, the Ryan Haight ' +
      'in-person evaluation requirement on remote supply, and the exempt over-the-counter ' +
      'narcotic limits. Configured from eCFR’s own XML of 21 CFR 1301/1304/1306 and from GPO’s ' +
      'publication of 21 U.S.C. 353, 829 and 830. ⚠️ No pseudoephedrine rules (the limit is on a ' +
      'contained chemical this platform cannot compute), no DSCSA traceability (no reachable ' +
      'primary source), and no substitution rule (substitution is state law, not federal). Not ' +
      'reviewed by a qualified person.',
    effectiveFrom: US_PACK_EFFECTIVE_FROM,
  },
  /*
   * ⚠️ CALIFORNIA MUST BE SEEDED AFTER THE UNITED STATES, AND NOT FOR A REASON
   *   THE DATABASE ENFORCES. Nothing here has a foreign key to the federal pack
   *   — a regional pack is a sibling, not a child — so a reversed order would
   *   seed cleanly and behave identically. It is ordered this way so the console
   *   output reads `US` then `US-CA`, which is how somebody debugging a
   *   supersession expects to see them.
   */
  {
    countryCode: 'US',
    regionCode: 'CA',
    countryName: 'California',
    authorities: US_CA_AUTHORITIES,
    sources: US_CA_SOURCES,
    rules: US_CA_RULES,
    packAuthorityCode: 'CA_BOP',
    version: '1.0.0',
    name: 'California — Business and Professions Code, pharmacy',
    description:
      'The places California departs from or adds to federal law in ways this framework can ' +
      'express: a three-year record retention for every dangerous drug where federal law keeps ' +
      'controlled-substance records for two, the eleven-element prescription container label, and ' +
      'generic substitution, which federal law does not regulate at all. ⚠️ NOT a statement of ' +
      'California pharmacy law as a whole — it supersedes federal rules PER RULE TYPE, so every ' +
      'federal rule of a type absent here still applies in California. No CURES reporting rule ' +
      'and no state controlled-substance prescription rules. Not reviewed by a qualified person.',
    effectiveFrom: US_CA_PACK_EFFECTIVE_FROM,
  },

  /*
   * ⚠️ AUSTRALIA IS THE ONE PACK IN THIS LIST WHOSE NATIONAL INSTRUMENT BINDS
   *   NOBODY, AND THE PAIR BELOW IS THE WHOLE POINT OF PI-15. The Poisons
   *   Standard is made under the Therapeutic Goods Act 1989 and RECOMMENDS a
   *   degree of control; it takes legal effect only as adopted by State and
   *   Territory legislation. A national-only `AU` pack would therefore have been
   *   configured, visible and describing an instrument with no legal force —
   *   this domain's signature failure, which is why COUNTRY_RULE_PACK_SURVEY.md
   *   required PI-15 to ship a state pack or not ship. `AU-VIC` is that state
   *   pack, and it carries almost every operative obligation.
   */
  {
    countryCode: 'AU',
    countryName: 'Australia',
    authorities: AU_AUTHORITIES,
    sources: AU_SOURCES,
    rules: AU_RULES,
    packAuthorityCode: 'TGA',
    version: '1.0.0',
    name: 'Australia — the Poisons Standard (SUSMP)',
    description:
      'The national scheduling floor: a prescription for Schedule 4 and Schedule 8, a pharmacist ' +
      'for Schedule 3, and the Schedule 8 classification itself. Configured from the Federal ' +
      'Register of Legislation’s own text of the Therapeutic Goods (Poisons Standard—June 2026) ' +
      'Instrument 2026. ⚠️ THE POISONS STANDARD RECOMMENDS AND DOES NOT BIND — it has legal ' +
      'force only through State and Territory legislation, so these four rules are the floor ' +
      'every jurisdiction builds on rather than the provision anyone is prosecuted under. A ' +
      'Victorian branch gets the `AU-VIC` pack instead, per rule type. No dispensing label ' +
      '(Appendix L could not be retrieved), no import restriction, no PBS rules, no record ' +
      'retention and no storage standard — Australia has no national ones. Not reviewed by a ' +
      'qualified person.',
    effectiveFrom: AU_PACK_EFFECTIVE_FROM,
  },
  {
    countryCode: 'AU',
    regionCode: 'VIC',
    countryName: 'Victoria',
    authorities: AU_VIC_AUTHORITIES,
    sources: AU_VIC_SOURCES,
    rules: AU_VIC_RULES,
    packAuthorityCode: 'VIC_DH',
    version: '1.0.0',
    name: 'Victoria — Drugs, Poisons and Controlled Substances Regulations 2017',
    description:
      'What a Victorian pharmacist actually answers to: Schedule 4 and Schedule 8 on prescription ' +
      'with twelve- and six-month validity, the two prescriber lists that differ by an ' +
      'optometrist and a podiatrist, the drugs register and the Schedule 8 treatment permit, the ' +
      'lockable facility and the welded steel safe, supplementary labelling, three-year record ' +
      'retention, SafeScript reporting at the time of supply, witnessed destruction, and brand ' +
      'substitution. Configured from the Chief Parliamentary Counsel’s authorised consolidation. ' +
      '⚠️ NOT a statement of Victorian drugs law as a whole — it supersedes the national rules ' +
      'PER RULE TYPE, so every national rule of a type absent here still applies. No Schedule 9 ' +
      'rules, no chart-instruction or emergency-supply exceptions (so this pack is STRICTER than ' +
      'the law in those cases), and no monitored-poisons rule for the Schedule 4 substances ' +
      'Schedule 6 names individually. Not reviewed by a qualified person.',
    effectiveFrom: AU_VIC_PACK_EFFECTIVE_FROM,
  },

  /*
   * ⚠️ SINGAPORE HAS NO SUB-NATIONAL PACK AND NEVER WILL, AND THE CHECK THAT
   *   ESTABLISHED THAT IS THE ONE PI-15 LEARNED TO RUN FIRST. `CountryInfo.regions`
   *   for `SG` in `@rcln/contracts` is `[]` — correct here, because a city-state
   *   has no subdivisions, and the same emptiness that would have made `AU-VIC`
   *   inert forever. An empty `regions` list is a fact to verify against the
   *   country rather than a shape to trust.
   */
  {
    countryCode: 'SG',
    countryName: 'Singapore',
    authorities: SG_AUTHORITIES,
    sources: SG_SOURCES,
    rules: SG_RULES,
    packAuthorityCode: 'HSA',
    version: '1.0.0',
    name: 'Singapore — therapeutic products and controlled drugs',
    description:
      'Two instruments that do not share a vocabulary, carried together: the Health Products ' +
      '(Therapeutic Products) Regulations 2016 for prescription-only and pharmacy-only medicines ' +
      '— the prescription, who may write it, repeats, the six-field dispensing label, the ' +
      'two-year records and the 240 ml codeine cough limit — and the Misuse of Drugs ' +
      'Regulations for controlled drugs, whose Second, Third and Fourth Schedules each carry ' +
      'their own 30-day prescription, prescriber list, supply list, register, locked store, ' +
      'three-year retention and witnessed destruction. Configured from Singapore Statutes Online, ' +
      'the Attorney-General’s Chambers’ authorised publication. ⚠️ NO ' +
      'PHARMACIST-ONLY RULE for a prescription-only or pharmacy-only medicine — Singapore ' +
      'makes that gate conditional on whether the premises are a licensed retail pharmacy or a ' +
      'healthcare service licensee, which rcln does not know, and a rule would refuse the lawful ' +
      'clinic case. No 355 mg contained-codeine limit, no general sale list rules, no ' +
      'e-pharmacy position and no addict-notification rule. No sub-national pack: Singapore is a ' +
      'city-state. Not reviewed by a qualified person.',
    effectiveFrom: SG_PACK_EFFECTIVE_FROM,
  },

  /*
   * ⚠️ THE UNITED ARAB EMIRATES HAS TWO EMIRATE PACKS AND NO NATIONAL ONE, WHICH
   *   IS THE FIRST TIME THAT SHAPE HAS APPEARED AND IS PI-17'S CENTRAL FINDING.
   *   Every other country here is national-first: India and Singapore are
   *   national only, the United States and Australia are national plus a
   *   sub-national pack. The UAE is sub-national ALONE, because
   *   `uaelegislation.gov.ae` returns `403` and `mohap.gov.ae` resets the
   *   connection, so the federal Ministerial Decrees both emirates cite could be
   *   read only as those emirates restate them — a secondary source, which this
   *   programme does not write rules from.
   *
   * ⚠️ THE CONSEQUENCE IS NOT SYMMETRIC WITH AUSTRALIA'S AND IS WORSE. A branch
   *   in Sydney with no state pack still gets the Poisons Standard; a branch in
   *   Sharjah gets nothing at all, so every evaluation there answers
   *   `UNDETERMINED`, which refuses. That is the honest state of the sources.
   *
   * ⚠️ AND BOTH PACKS WERE INERT UNTIL `UAE_REGIONS` EXISTED. `CountryInfo.regions`
   *   for `AE` was `[]` — correct about VAT, which is federal at one rate, and
   *   fatal to a pack keyed on `branches.region_code`. Australia's was the same
   *   defect in PI-15. Two countries in three phases: check that list first.
   */
  {
    countryCode: 'AE',
    regionCode: 'AZ',
    countryName: 'Abu Dhabi',
    authorities: AE_AZ_AUTHORITIES,
    sources: AE_AZ_SOURCES,
    rules: AE_AZ_RULES,
    packAuthorityCode: 'AE_DOH',
    version: '1.0.0',
    name: 'Abu Dhabi — narcotics, psychotropics and semi-controlled products',
    description:
      'What a DOH-licensed facility in Abu Dhabi answers to for controlled medicines: a ' +
      'prescription valid three days for all three tiers, specialists and consultants only for ' +
      'narcotics, no narcotic refill and an endorsed ceiling of two for the rest, the PH 17/18/20 ' +
      'registers, the unified platform raised as a precondition the pharmacist can only verify, ' +
      'locked steel storage, five-year and two-year retention, monthly and quarterly returns, ' +
      'destruction witnessed by a DOH auditor, and a flat prohibition on moving narcotics between ' +
      'facilities. Configured from the Department of Health’s own standard DOH/HLME/DMP/1.0/2021. ' +
      '⚠️ NOT A STATEMENT OF UAE FEDERAL LAW: the Ministerial Decrees this standard quotes could ' +
      'not be retrieved and no rule cites one. ⚠️ NO DAYS’-SUPPLY LADDER — it turns on the ' +
      'prescriber’s grade, which no rule shape carries. No dispensing label, no self-prescribing ' +
      'rule, no forecast or procurement rules. Not reviewed by a qualified person.',
    effectiveFrom: AE_AZ_PACK_EFFECTIVE_FROM,
  },
  {
    countryCode: 'AE',
    regionCode: 'DU',
    countryName: 'Dubai',
    authorities: AE_DU_AUTHORITIES,
    sources: AE_DU_SOURCES,
    rules: AE_DU_RULES,
    packAuthorityCode: 'AE_DHA',
    version: '1.0.0',
    name: 'Dubai — Pharmacy Guidelines, the mandatory clauses',
    description:
      'The DHA Pharmacy Guidelines are 100 pages and most of them recommend; this pack is built ' +
      'from the clauses that do not. Guideline Fourteen in full — three-day validity for ' +
      'narcotics, controlled and semi controlled drugs, consultants and specialists only for ' +
      'narcotics, no narcotic refill, the MOHAP and DHA register books, the Unified Controlled ' +
      'Medication Platform for narcotics and CDs but not SCDs, steel cabinets, five-year and ' +
      'two-year retention, monthly and quarterly returns, disposal through MOHAP Central Medical ' +
      'Stores or an HRS-audited waste contractor, and the prohibition on transferring any of them ' +
      'between facilities — plus the one prohibition outside it, that a prescription only medicine ' +
      'may not be sold without a formal prescription. ⚠️ NO DISPENSING LABEL: the eleven-field ' +
      'label at 13.3.2 is written as a recommendation and a LABEL_FIELDS condition is an ' +
      'obligation. ⚠️ NO DAYS’-SUPPLY LADDER, no price rules. ⚠️ NOT A STATEMENT OF UAE FEDERAL ' +
      'LAW. Not reviewed by a qualified person.',
    effectiveFrom: AE_DU_PACK_EFFECTIVE_FROM,
  },
];

export async function seedRegulatoryPacks(): Promise<void> {
  for (const pack of PACKS) {
    /*
     * ⚠️ `findFirst` + create RATHER THAN `upsert`, AND NOT BY PREFERENCE.
     *   `region_code` is nullable, and PI-13a made it actually vary — a state or
     *   emirate pack sets it — but Prisma refuses `null` inside a compound-unique
     *   `where` for the country-wide case, and one code path has to serve both.
     *   The error is "Argument `regionCode` must not be null" —
     *   "Argument `regionCode` must not be null" — so the natural key cannot be
     *   expressed as an upsert at all. The database DOES constrain it: the
     *   unique index is rewritten `NULLS NOT DISTINCT` in the migration, without
     *   which `IN` could be inserted twice and every rule lookup would see half
     *   the pack. A concurrent second seed therefore loses on the constraint
     *   rather than duplicating, which is the correct failure.
     */
    const regionCode = pack.regionCode ?? null;
    const existingJurisdiction = await prisma.jurisdiction.findFirst({
      where: { countryCode: pack.countryCode, regionCode },
      select: { id: true },
    });
    const jurisdiction = existingJurisdiction
      ? await prisma.jurisdiction.update({
          where: { id: existingJurisdiction.id },
          data: { name: pack.countryName },
        })
      : await prisma.jurisdiction.create({
          data: { countryCode: pack.countryCode, regionCode, name: pack.countryName },
        });

    const authorityIds = new Map<string, string>();
    for (const authority of pack.authorities) {
      const row = await prisma.regulatoryAuthority.upsert({
        where: { code: authority.code },
        update: {
          name: authority.name,
          websiteUrl: authority.websiteUrl,
          remit: authority.remit,
          jurisdictionId: jurisdiction.id,
        },
        create: { ...authority, jurisdictionId: jurisdiction.id },
      });
      authorityIds.set(authority.code, row.id);
    }

    /*
     * `regulatory_sources` has no natural unique key — two amendments can share
     * a title — so it is matched on `(authority, document_reference)`, which is
     * the citation a lawyer would use and is unique in practice. `retrievedAt`
     * is set on every run: it records WHEN SOMEBODY LAST LOOKED, and the
     * staleness report reads it.
     */
    const sourceIds = new Map<string, string>();
    for (const source of pack.sources) {
      const authorityId = authorityIds.get(source.authorityCode);
      if (authorityId === undefined) {
        throw new Error(`Source ${source.key} cites unknown authority ${source.authorityCode}`);
      }

      const existing = await prisma.regulatorySource.findFirst({
        where: { authorityId, documentReference: source.documentReference },
        select: { id: true },
      });

      const data = {
        jurisdictionId: jurisdiction.id,
        authorityId,
        title: source.title,
        documentReference: source.documentReference,
        sourceUrl: source.sourceUrl,
        ...(source.version !== undefined ? { version: source.version } : {}),
        ...(source.publishedOn !== undefined ? { publishedOn: day(source.publishedOn) } : {}),
        retrievedAt: new Date(),
        reviewStatus: source.reviewStatus,
        notes: source.notes,
      };

      const row = existing
        ? await prisma.regulatorySource.update({ where: { id: existing.id }, data })
        : await prisma.regulatorySource.create({ data });
      sourceIds.set(source.key, row.id);
    }

    const packAuthorityId = authorityIds.get(pack.packAuthorityCode);
    if (packAuthorityId === undefined) {
      throw new Error(`Pack ${pack.countryCode} cites unknown authority ${pack.packAuthorityCode}`);
    }

    const packRow = await prisma.regulatoryRulePack.upsert({
      where: {
        jurisdictionId_version: { jurisdictionId: jurisdiction.id, version: pack.version },
      },
      update: {
        name: pack.name,
        description: pack.description,
        authorityId: packAuthorityId,
        /*
         * ⚠️ NOT `REGULATORY_REVIEWED`, NOT `PRODUCTION_ENABLED`, AND A RE-RUN
         *   MUST NOT WALK A PACK BACK DOWN THE LADDER EITHER. If a human has
         *   since signed this pack off, re-seeding would otherwise silently
         *   revoke that sign-off, which is a human decision being undone by a
         *   script — so the maturity is only written on CREATE.
         *
         * ⚠️ THE PRICE OF THAT IS THAT A MATURITY CORRECTION NEVER REACHES AN
         *   ENVIRONMENT THAT ALREADY SEEDED. Changing the literal below fixes
         *   fresh databases and leaves every existing one where it was — which
         *   is right for a pack somebody signed off and surprising for a pack
         *   nobody has. It bit this file's own author: the India pack was
         *   created at `AUTOMATED_TESTED`, corrected here to
         *   `RULES_IMPLEMENTED`, and stayed at the old value until it was moved
         *   by hand. Correcting one is a deliberate `UPDATE`, or a
         *   `prisma migrate reset`, and never a re-seed.
         */
      },
      create: {
        jurisdictionId: jurisdiction.id,
        authorityId: packAuthorityId,
        version: pack.version,
        name: pack.name,
        description: pack.description,
        maturity: 'AUTOMATED_TESTED',
        effectiveFrom: day(pack.effectiveFrom),
      },
    });

    for (const rule of pack.rules) {
      const sourceId = sourceIds.get(rule.sourceKey);
      if (sourceId === undefined) {
        throw new Error(`Rule ${rule.code} cites unknown source ${rule.sourceKey}`);
      }

      await prisma.regulatoryRule.upsert({
        where: {
          packId_code_version: { packId: packRow.id, code: rule.code, version: 1 },
        },
        update: {
          statement: rule.statement,
          parameters: rule.parameters,
          sourceId,
        },
        create: {
          packId: packRow.id,
          ruleType: rule.ruleType as never,
          code: rule.code,
          statement: rule.statement,
          status: 'ACTIVE',
          ...(rule.appliesToProductType !== undefined
            ? { appliesToProductType: rule.appliesToProductType as never }
            : {}),
          ...(rule.appliesToClassification !== undefined
            ? { appliesToClassification: rule.appliesToClassification }
            : {}),
          appliesToTransactions: rule.appliesToTransactions as never,
          parameters: rule.parameters,
          sourceId,
          version: 1,
          effectiveFrom: day(pack.effectiveFrom),
        },
      });
    }

    const label = regionCode === null ? pack.countryCode : `${pack.countryCode}-${regionCode}`;
    console.warn(
      `  ${label} ${pack.version}: ${String(pack.sources.length)} sources, ` +
        `${String(pack.rules.length)} rules`
    );
  }
}
