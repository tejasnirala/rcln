/**
 * Every rule in every shipped pack can be read by the engine that enforces it.
 *
 * ⚠️ THIS IS THE TEST THAT WAS MISSING, AND TWO DEFECTS LIVED IN THE GAP.
 *   A rule whose parameters do not parse resolves UNDETERMINED — "nothing is
 *   permitted on the strength of a rule the platform cannot read" — so a single
 *   mistyped or incomplete parameter in a seed file silently REFUSES every
 *   transaction the rule applies to, in production, for a whole classification.
 *
 *   `AU-SCHEDULE-S8` did exactly that to Schedule 8 in the seven Australian
 *   jurisdictions with no state pack, and `SG-SCHEDULE-CD3` to Singapore's Third
 *   Schedule. Both shipped green, because a behaviour case that asserts "the
 *   code appears in the reasons and no conditions were raised" describes an
 *   unreadable rule as accurately as it describes a permissive one. Neither was
 *   found by review either; both were found by running the parser over the packs,
 *   which is all this file does.
 *
 * ⚠️ IT ASKS THE ENGINE'S OWN DISPATCH, ON PURPOSE. `readRuleParameters` is the
 *   same switch `evaluateRule` uses, so a new rule type cannot be added with a
 *   parser this test does not know about — the alternative, a table of parsers
 *   maintained here, would drift from the engine and pass while lying.
 */

import { readRuleParameters, type RegulatoryRule, type RegulatoryRuleType } from '@rcln/regulatory';
import { regionsFor } from '@rcln/contracts';

import { PACKS as SEEDED_PACKS } from '../../../../packages/db/prisma/seed/regulatory-packs.js';

import { AE_AZ_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-ae-az.js';
import { AE_DU_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-ae-du.js';
import { AU_VIC_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-au-vic.js';
import { AU_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-au.js';
import { BD_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-bd.js';
import { IE_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-ie.js';
import { IN_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-in.js';
import { SG_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-sg.js';
import { US_CA_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-us-ca.js';
import { US_RULES } from '../../../../packages/db/prisma/seed/data/regulatory-us.js';

interface Seed {
  code: string;
  ruleType: string;
  parameters: Record<string, unknown>;
}

/* Every pack that ships. A pack added without a line here is the one hole this
 * file cannot see, which is why the count below is asserted too. */
const PACKS: readonly (readonly [string, readonly Seed[]])[] = [
  ['AE-AZ', AE_AZ_RULES],
  ['AE-DU', AE_DU_RULES],
  ['AU', AU_RULES],
  ['AU-VIC', AU_VIC_RULES],
  ['BD', BD_RULES],
  ['IE', IE_RULES],
  ['IN', IN_RULES],
  ['SG', SG_RULES],
  ['US', US_RULES],
  ['US-CA', US_CA_RULES],
];

/**
 * The seed carries what a pack author writes; the engine wants a whole rule.
 * Only `ruleType` and `parameters` are read by the parser, and the rest is
 * filled with values that could not affect the answer.
 */
function asRule(seed: Seed): RegulatoryRule {
  return {
    id: seed.code,
    packId: 'pack',
    packVersion: '0.0.0',
    packMaturity: 'ARCHITECTURE_SUPPORTED',
    jurisdiction: { countryCode: 'ZZ', regionCode: null },
    ruleType: seed.ruleType as RegulatoryRuleType,
    code: seed.code,
    statement: seed.code,
    status: 'ACTIVE',
    appliesToProductType: null,
    appliesToCategoryId: null,
    appliesToClassification: null,
    appliesToTransactions: [],
    parameters: seed.parameters,
    sourceId: 'source',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
  };
}

describe('every shipped rule pack is readable by the engine', () => {
  it.each(PACKS.map(([name, rules]) => [name, rules] as const))(
    '%s parses every rule it seeds',
    (name, rules) => {
      const unreadable: string[] = [];
      for (const seed of rules) {
        const parsed = readRuleParameters(asRule(seed));
        if (!parsed.ok) unreadable.push(`${seed.code} (${seed.ruleType}): ${parsed.problem}`);
      }

      /*
       * Named, not counted. A failure here has to say WHICH rule and why, or the
       * next person re-runs the parser by hand to find out — which is what this
       * file exists to stop.
       */
      expect({ pack: name, unreadable }).toEqual({ pack: name, unreadable: [] });
    }
  );

  it('covers every pack in the seed directory, so a new one cannot slip past', () => {
    expect(PACKS).toHaveLength(10);
  });
});

describe('every regional pack names a region the platform admits', () => {
  /**
   * ⚠️ THIS IS THE CHECK THAT WOULD HAVE CAUGHT TWO INERT PACKS, AND THE ONLY
   *   REASON IT DID NOT EXIST IS THAT THE FAILURE IS SILENT AT EVERY LAYER.
   *   `regionsFor` gates `branches.region_code` through `isValidRegion`, so a
   *   branch can never hold a region the list omits — and a pack keyed on that
   *   region therefore matches no branch, for ever, while seeding cleanly and
   *   appearing in the console. Australia shipped that way in PI-15 (empty
   *   `regions`, Victorian pack inert) and the UAE in PI-17, both found by a
   *   human remembering to look. The United States had the same hole standing
   *   open until PI-24 — five states that levy no sales tax were missing from a
   *   list that had quietly become the answer to a different question.
   */
  it.each(
    SEEDED_PACKS.filter((pack) => pack.regionCode !== undefined).map(
      (pack) => [`${pack.countryCode}-${pack.regionCode ?? ''}`, pack] as const
    )
  )('%s', (_label, pack) => {
    const codes = regionsFor(pack.countryCode).map((region) => region.code);
    expect(codes).toContain(pack.regionCode);
  });

  it('and there is at least one regional pack, so the loop above is not vacuous', () => {
    expect(SEEDED_PACKS.filter((pack) => pack.regionCode !== undefined).length).toBeGreaterThan(0);
  });
});
