/**
 * Platform-maintained starting-point tax rates, per country.
 */
import { prisma } from './client.js';

/*
 * `tax_registrations` IS DELIBERATELY NOT SEEDED, AND THAT IS THE FEATURE.
 *
 * A row in that table is an assertion that rcln is registered to collect a tax
 * in a jurisdiction — a legal claim, not a default. Seeding a plausible-looking
 * Indian GST row would make every development and staging invoice carry 18% GST
 * against a GSTIN that does not exist, and the first person to copy the seed
 * into production would start collecting tax nobody can remit.
 *
 * An empty table means every supply resolves to NOT_REGISTERED and nothing is
 * taxed, with the reason recorded on each invoice. That is the correct state for
 * a business that has not registered anywhere yet. Add rows when a registration
 * actually exists — through a platform admin, not through this file.
 *
 * See the model comment in schema.prisma and `resolveTax` in @rcln/billing.
 */
/*
 * The rate cards rcln maintains, which every clinic inherits until it overrides
 * them. UNLIKE `tax_registrations` above, this table IS seeded — and the
 * difference is worth stating, because the warning directly above says the
 * opposite about a table with a nearly identical shape.
 *
 * A `tax_registrations` row asserts that RCLN IS REGISTERED somewhere. That is a
 * legal claim about us, and a seeded one would have us collecting tax against a
 * GSTIN that does not exist.
 *
 * A `tax_rule_defaults` row asserts only that a country taxes a kind of thing a
 * certain way. It names nobody, and it has NO EFFECT AT ALL on a clinic that
 * holds no `issuer_tax_registrations` row of its own — the engine asks "may this
 * issuer charge here?" before it ever asks "at what rate?". Seeding it therefore
 * charges nobody anything; it only means that a clinic which HAS registered does
 * not start from an empty rate card.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE, AND WHY THAT IS THE POINT.
 *
 *   Only healthcare SERVICES are seeded, and only for the five jurisdictions
 *   where the treatment is unambiguous and stable. There are no rows for
 *   medicines, consumables or any other GOODS, in any country.
 *
 *   That is not laziness. A medicine's rate varies by product WITHIN a country —
 *   India alone spans nil, 5% and 12% across formulations, and the 2025 GST
 *   restructure moved most of them — so any single seeded figure would be wrong
 *   for a large share of what a pharmacy dispenses. A wrong row in THIS table is
 *   wrong invoices for every clinic in a country at once, silently, because it
 *   looks configured.
 *
 *   An unseeded category resolves to UNRATED instead: nothing charged, the
 *   reason on the document, and finalisation refusing to issue it. The clinic is
 *   forced to enter a rate it has actually checked. That is the correct failure,
 *   and it is the same principle the whole tax engine is built on.
 *
 * ⚠️ EVERY ROW BELOW STILL NEEDS A REVIEW BEFORE A CLINIC BILLS ON IT. They are
 *   a starting point maintained by rcln, not tax advice, and `source_note`
 *   carries the basis so a reviewer can check rather than guess.
 */
const HEALTHCARE_SERVICE_CATEGORIES = [
  { category: 'CONSULTATION', description: 'Doctor consultation' },
  { category: 'PROCEDURE', description: 'Clinical procedure' },
  { category: 'LAB_TEST', description: 'Diagnostic test' },
] as const;

/**
 * ⚠️ EXEMPT AND ZERO_RATED ARE BOTH HERE, AND THE DIFFERENCE IS NOT COSMETIC.
 *   An exempt supply carries no input credit and is reported differently from a
 *   zero-rated one, which does appear on a return. Australia's "GST-free" and
 *   the UAE's zero-rating of healthcare are genuinely zero-rated; India, the UK
 *   and Ireland exempt medical care. Flattening the two would misstate returns
 *   in both directions.
 */
const HEALTHCARE_DEFAULTS: {
  countryCode: string;
  scheme: 'GST' | 'VAT';
  lineName: string;
  split: 'NONE' | 'INTRA_STATE_HALVES';
  treatment: 'EXEMPT' | 'ZERO_RATED';
  sourceNote: string;
}[] = [
  {
    countryCode: 'IN',
    scheme: 'GST',
    lineName: 'GST',
    // The only country here with a constitutional split. See `TaxSplit`.
    split: 'INTRA_STATE_HALVES',
    treatment: 'EXEMPT',
    sourceNote:
      'Health care services by a clinical establishment or authorised medical practitioner are exempt under the GST services exemption notification (SAC heading 9993). Verify the current notification before billing.',
  },
  {
    countryCode: 'GB',
    scheme: 'VAT',
    lineName: 'VAT',
    split: 'NONE',
    treatment: 'EXEMPT',
    sourceNote:
      'Medical care provided by a registered health professional is exempt under VATA 1994 Sch 9 Group 7. Verify scope — cosmetic work without a therapeutic purpose is standard-rated.',
  },
  {
    countryCode: 'IE',
    scheme: 'VAT',
    lineName: 'VAT',
    split: 'NONE',
    treatment: 'EXEMPT',
    sourceNote:
      'Professional medical services by a recognised practitioner are exempt under VATCA 2010 Sch 1. Verify scope before billing.',
  },
  {
    countryCode: 'AU',
    scheme: 'GST',
    lineName: 'GST',
    split: 'NONE',
    // GST-free, which is zero-rating and NOT exemption. See the warning above.
    treatment: 'ZERO_RATED',
    sourceNote:
      'Medical and other health services are GST-free under A New Tax System (GST) Act 1999 Subdiv 38-B. GST-free is zero-rating, not exemption.',
  },
  {
    countryCode: 'AE',
    scheme: 'VAT',
    lineName: 'VAT',
    split: 'NONE',
    treatment: 'ZERO_RATED',
    sourceNote:
      'Preventive and basic healthcare services are zero-rated under Federal Decree-Law 8 of 2017 and its Executive Regulation. Elective and cosmetic treatment is standard-rated — verify per service.',
  },
];

/*
 * Singapore, Nepal, Sri Lanka and Bangladesh are supported countries with NO
 * rows here, deliberately. Their treatment of healthcare is narrower or less
 * stable than the five above, and a default nobody has verified is worse than no
 * default — the clinic sees UNRATED and enters a rate it has checked.
 *
 * The United States has none either, and cannot: sales tax needs a provider, so
 * the engine returns PROVIDER_REQUIRED before a rate card is ever consulted.
 *
 * ⚠️ Canada is fully supported by the ENGINE — federal GST stacked with
 *   provincial PST/QST, and Ontario's harmonised HST, are all covered and
 *   tested — but it is not in `locale.ts`, so no clinic can select it at signup
 *   yet. Adding it there is a small, separate change.
 */
export async function seedTaxRuleDefaults(): Promise<void> {
  // The date the platform began maintaining these, not a legislative date. Each
  // row's real basis is in its `source_note`.
  const effectiveFrom = new Date('2020-01-01T00:00:00.000Z');
  let written = 0;

  for (const country of HEALTHCARE_DEFAULTS) {
    for (const item of HEALTHCARE_SERVICE_CATEGORIES) {
      /*
       * findFirst + create rather than upsert: the unique key includes a
       * NULLABLE `region_code`, and Prisma cannot express a compound-unique
       * lookup whose member is NULL. The index is NULLS NOT DISTINCT so the
       * database still refuses a duplicate if this race is ever lost.
       */
      const existing = await prisma.taxRuleDefault.findFirst({
        where: {
          countryCode: country.countryCode,
          regionCode: null,
          scheme: country.scheme,
          taxCategory: item.category,
          effectiveFrom,
        },
      });

      const data = {
        countryCode: country.countryCode,
        regionCode: null,
        scheme: country.scheme,
        taxCategory: item.category,
        description: item.description,
        // An untaxed treatment must carry a zero rate — enforced by CHECK.
        rateBps: 0,
        treatment: country.treatment,
        lineName: country.lineName,
        split: country.split,
        stacks: false,
        sourceNote: country.sourceNote,
        effectiveFrom,
      };

      if (existing) {
        await prisma.taxRuleDefault.update({ where: { id: existing.id }, data });
      } else {
        await prisma.taxRuleDefault.create({ data });
      }
      written += 1;
    }
  }

  console.warn(
    `  tax defaults     ${written} (healthcare services only — goods are deliberately unrated)`
  );
}
