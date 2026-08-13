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

/** A `@db.Date` column takes a day, in the jurisdiction's own reckoning. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

interface PackSeed {
  countryCode: string;
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
];

export async function seedRegulatoryPacks(): Promise<void> {
  for (const pack of PACKS) {
    /*
     * ⚠️ `findFirst` + create RATHER THAN `upsert`, AND NOT BY PREFERENCE.
     *   `region_code` is nullable and the country-wide row is the one being
     *   written, but Prisma refuses `null` inside a compound-unique `where` —
     *   "Argument `regionCode` must not be null" — so the natural key cannot be
     *   expressed as an upsert at all. The database DOES constrain it: the
     *   unique index is rewritten `NULLS NOT DISTINCT` in the migration, without
     *   which `IN` could be inserted twice and every rule lookup would see half
     *   the pack. A concurrent second seed therefore loses on the constraint
     *   rather than duplicating, which is the correct failure.
     */
    const existingJurisdiction = await prisma.jurisdiction.findFirst({
      where: { countryCode: pack.countryCode, regionCode: null },
      select: { id: true },
    });
    const jurisdiction = existingJurisdiction
      ? await prisma.jurisdiction.update({
          where: { id: existingJurisdiction.id },
          data: { name: pack.countryName },
        })
      : await prisma.jurisdiction.create({
          data: { countryCode: pack.countryCode, regionCode: null, name: pack.countryName },
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

    console.warn(
      `  ${pack.countryCode} ${pack.version}: ${String(pack.sources.length)} sources, ` +
        `${String(pack.rules.length)} rules`
    );
  }
}
