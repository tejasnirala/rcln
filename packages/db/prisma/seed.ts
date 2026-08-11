/**
 * Idempotent seed. Safe to re-run — everything upserts on a natural key.
 *
 * Seeds:
 *   1. the permission catalogue          (from @rcln/permissions)
 *   2. system roles + their grants       (organization_id NULL, is_system true)
 *   3. setting definitions
 *   4. subscription plans
 *   5. the super admin — the one account never created through the UI
 */
import { config as loadEnv } from 'dotenv';
import { hash } from '@node-rs/argon2';

// Single .env at the repo root; this runs with cwd=packages/db.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type TaxonomyNodeType } from '../generated/prisma/index.js';
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLE_DEFINITIONS,
  moduleOf,
  type PermissionCode,
} from '@rcln/permissions';

// Seeds write platform-wide rows (permissions, system roles, plans) that no
// tenant owns, so this connects as the OWNER role, which RLS does not restrict.
const connectionString = process.env['DIRECT_DATABASE_URL'];
if (!connectionString) throw new Error('DIRECT_DATABASE_URL is required to seed');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Argon2id parameters. OWASP baseline: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

function describe(code: PermissionCode): string {
  const [, ...rest] = code.split('.');
  return rest.join(' ').replace(/_/g, ' ');
}

async function seedPermissions(): Promise<Map<PermissionCode, string>> {
  const ids = new Map<PermissionCode, string>();

  for (const code of ALL_PERMISSIONS) {
    const parts = code.split('.');
    const row = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: moduleOf(code),
        action: parts[parts.length - 1] ?? 'unknown',
        description: describe(code),
      },
    });
    ids.set(code, row.id);
  }

  console.warn(`  permissions      ${ids.size}`);
  return ids;
}

async function seedSystemRoles(permissionIds: Map<PermissionCode, string>): Promise<void> {
  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    // Prisma cannot target a compound unique with a NULL component, so this is
    // find-then-write rather than upsert. Uniqueness is still guaranteed by the
    // NULLS NOT DISTINCT index in the 20260725060000 migration.
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, code: def.code },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: def.name, description: def.description, scopeLevel: def.scopeLevel },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            code: def.code,
            name: def.name,
            description: def.description,
            scopeLevel: def.scopeLevel,
            isSystem: true,
          },
        });

    // Re-sync grants so editing roles.ts and re-seeding actually takes effect.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions
        .map((code) => permissionIds.get(code))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  console.warn(`  system roles     ${SYSTEM_ROLE_DEFINITIONS.length}`);
}

/**
 * The twelve months, as the financial-year setting offers them.
 *
 * Numbers, because that is what the column holds and what any date arithmetic
 * downstream will do with it — but nobody picks "4" from a list, they pick
 * April. This is exactly the case `allowed_values` exists for.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, index) => ({ value: index + 1, label }));

/**
 * The setting catalogue.
 *
 * `description` is the short name the settings screen puts on the row.
 * `helpText` is what it is FOR — written for whoever runs the clinic, saying
 * what changing it actually does, because "Fallback tax rate when a billable
 * item defines none" is a description of the column, not an explanation.
 * `allowedValues` closes the set: present means the API refuses anything else
 * and the screen renders a select. Omit it for genuinely open values.
 */
async function seedSettingDefinitions(): Promise<void> {
  const defs = [
    {
      key: 'appointment.slot_minutes',
      module: 'appointment',
      dataType: 'INT' as const,
      defaultValue: 15,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Consultation length',
      helpText:
        'How long one appointment blocks out in the calendar, in minutes. It decides how many slots a doctor’s day is divided into. A doctor who needs longer can be given their own length.',
      // Deliberately open: a physiotherapist booking 45 minutes and a screening
      // camp booking 5 are both real, and a list would have to guess.
    },
    {
      key: 'appointment.allow_online_booking',
      module: 'appointment',
      dataType: 'BOOL' as const,
      defaultValue: true,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Patient self-booking',
      helpText:
        'Whether patients can book themselves an appointment from the portal. Turn it off and every appointment has to be made by your staff. Existing bookings are not affected.',
    },
    {
      key: 'appointment.reminder_hours_before',
      module: 'appointment',
      dataType: 'JSON' as const,
      defaultValue: [24, 2],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Appointment reminders',
      helpText:
        'How many hours before an appointment each reminder goes out. [24, 2] sends one the day before and one two hours ahead. An empty list sends none.',
    },
    {
      key: 'billing.invoice_prefix',
      module: 'billing',
      dataType: 'STRING' as const,
      defaultValue: 'INV',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Invoice number prefix',
      helpText:
        'The letters in front of every invoice number this clinic issues — INV becomes INV-000123. Changing it does not renumber invoices you have already raised.',
    },
    {
      key: 'billing.default_tax_percent',
      module: 'billing',
      dataType: 'DECIMAL' as const,
      defaultValue: 0,
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Default tax rate',
      helpText:
        'The GST rate applied to a billable item that does not carry one of its own. Most clinical services are exempt, which is why this starts at 0. Items with their own rate ignore it.',
    },
    {
      /**
       * ⚠️ IN MINOR UNITS, WHICH IS WHY 100 IS "TO THE RUPEE" AND NOT "A
       *   HUNDRED RUPEES". The engine rounds the grand total to the nearest
       *   multiple of this many minor units, so 100 rounds ₹247.60 to ₹248 and
       *   `1` — the default — rounds nothing at all. Naming it in major units
       *   would make the value depend on the currency, and a clinic billing in
       *   yen has no minor unit to round away.
       *
       * ⚠️ AND IT IS READ AGAIN AT EVERY RE-PRICE, WHICH IS THE WHOLE REASON IT
       *   IS A SETTING. It used to be a request parameter that was never stored,
       *   so finalisation — which re-prices from the stored inputs — dropped it,
       *   and the document the patient received disagreed with the draft the
       *   cashier approved. See `priceDraftInvoice`.
       */
      key: 'billing.cash_rounding_minor',
      module: 'billing',
      dataType: 'INT' as const,
      defaultValue: 1,
      // BRANCH as well as ORGANIZATION: a cash desk that rounds and an
      // insurance-billing desk that does not is one hospital, not two.
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Round cash totals',
      helpText:
        'Whether the total on a bill is rounded before the patient pays it, so the counter is not counting out small change. It moves the total only — the tax is worked out first and is never rounded away. In India, “to the whole unit” means to the rupee. Off by default.',
      /*
       * ⚠️ LABELLED IN UNITS AND NOT IN RUPEES, BECAUSE THE COLUMN IS MINOR UNITS
       *   AND THE CLINIC MAY NOT BE INDIAN (Phase 2b). "To the nearest rupee" is
       *   100 minor units in INR and meaningless in JPY, which has none — the
       *   labels therefore name the multiple and the help text gives the Indian
       *   reading.
       */
      allowedValues: [
        { value: 1, label: 'No rounding' },
        { value: 50, label: 'To the nearest half unit' },
        { value: 100, label: 'To the nearest whole unit' },
        { value: 500, label: 'To the nearest five units' },
      ],
    },
    {
      key: 'billing.financial_year_start_month',
      module: 'billing',
      dataType: 'INT' as const,
      defaultValue: 4,
      allowedScopes: ['ORGANIZATION'],
      description: 'Financial year starts',
      helpText:
        'The month your books open. Indian practices run April to March, which is the default. It decides how invoice series are numbered and where reports draw the year boundary.',
      allowedValues: MONTHS,
    },
    {
      key: 'inventory.expiry_alert_days',
      module: 'inventory',
      dataType: 'JSON' as const,
      defaultValue: [90, 60, 30, 7],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Expiry warnings',
      helpText:
        'How many days before a batch expires you want warning. [90, 60, 30, 7] warns four times, with the last a week out. Earlier warnings are what let stock be returned or used first.',
    },
    {
      key: 'inventory.batch_selection_strategy',
      module: 'inventory',
      dataType: 'STRING' as const,
      defaultValue: 'FEFO',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Which batch to dispense',
      helpText:
        'Which batch the pharmacy is offered first. First expiry, first out sends the stock closest to expiring — this is what you want for medicines. First in, first out sends the oldest delivery.',
      allowedValues: [
        { value: 'FEFO', label: 'First expiry, first out' },
        { value: 'FIFO', label: 'First in, first out' },
      ],
    },
    {
      /**
       * ⚠️ A DISPLAY SETTING, NOT A STORAGE ONE, AND THE DISTINCTION IS THE WHOLE
       *   RULE. Every instant rcln holds is UTC in a `timestamptz` and travels as
       *   an ISO string with a `Z`; every screen renders it in the branch's IANA
       *   zone. This decides only whether that rendering reads `4:40 pm` or
       *   `16:40`. Nothing parses it, nothing stores against it, and no
       *   arithmetic anywhere depends on it.
       *
       * ⚠️ BRANCH AS WELL AS ORGANIZATION. A group running a hospital wing and a
       *   walk-in clinic genuinely reads its two diaries differently, and the
       *   resolver already walks BRANCH before ORGANIZATION.
       *
       * The default is 12-hour because most of the clinics rcln is built for
       * write `4:40 pm` on the appointment card, and a diary that disagrees with
       * the card is a receptionist checking every afternoon slot twice.
       */
      key: 'locale.time_format',
      module: 'locale',
      dataType: 'STRING' as const,
      defaultValue: '12H',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Clock format',
      helpText:
        'Whether times are shown as 4:40 pm or 16:40. It changes how every appointment, chart entry and report reads on screen — not what is stored, and not the time zone your clinic keeps its diary in.',
      allowedValues: [
        { value: '12H', label: '12-hour — 4:40 pm' },
        { value: '24H', label: '24-hour — 16:40' },
      ],
    },
    {
      key: 'notification.default_channel',
      module: 'notification',
      dataType: 'STRING' as const,
      defaultValue: 'WHATSAPP',
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'USER', 'PATIENT'],
      description: 'How messages are sent',
      helpText:
        'Where reminders, receipts and reports go by default. A patient who has asked for something else gets that instead — this is only the starting point.',
      allowedValues: [
        { value: 'WHATSAPP', label: 'WhatsApp' },
        { value: 'SMS', label: 'SMS' },
        { value: 'EMAIL', label: 'Email' },
      ],
    },
    {
      key: 'patient.uhid_prefix',
      module: 'patient',
      dataType: 'STRING' as const,
      defaultValue: 'P',
      allowedScopes: ['ORGANIZATION'],
      description: 'Patient number prefix',
      helpText:
        'The letters in front of every patient’s hospital number — P becomes P-000451. Patients already registered keep the number they have, so changing this splits your records into two shapes.',
    },
    {
      key: 'patient.mrn_prefix',
      module: 'patient',
      dataType: 'STRING' as const,
      defaultValue: 'MRN',
      /*
       * BRANCH as well as ORGANIZATION, unlike `patient.uhid_prefix` above.
       * The MRN series is per branch, so a group that wants its Whitefield
       * records to read WF0001 and its Indiranagar ones IN0001 sets this at the
       * branch. A UHID is org-wide and has no equivalent choice to make.
       */
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Record number prefix',
      helpText:
        'The letters in front of the record number a patient gets at each clinic — MRN becomes MRN000451. Each clinic counts separately, so two branches both start at 1. Patients already registered keep the number they have.',
    },
    {
      key: 'staff.employee_code_prefix',
      module: 'staff',
      dataType: 'STRING' as const,
      defaultValue: 'EMP',
      allowedScopes: ['ORGANIZATION'],
      description: 'Employee code prefix',
      helpText:
        'The letters in front of every staff member’s employee code — EMP becomes EMP0001. It is issued when someone accepts their invitation. People already on the team keep the code they have, so changing this splits your staff list into two shapes.',
    },
    {
      key: 'security.session_idle_timeout_minutes',
      module: 'security',
      dataType: 'INT' as const,
      defaultValue: 60,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Sign out when idle',
      helpText:
        'How long a signed-in session survives with nobody using it. Shorter is safer on a shared front-desk machine; longer interrupts a doctor mid-consultation less often.',
      allowedValues: [
        { value: 15, label: '15 minutes' },
        { value: 30, label: '30 minutes' },
        { value: 60, label: '1 hour' },
        { value: 120, label: '2 hours' },
        { value: 480, label: '8 hours — a full shift' },
      ],
    },
    {
      key: 'security.require_mfa_for_admins',
      module: 'security',
      dataType: 'BOOL' as const,
      defaultValue: false,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Second step for administrators',
      helpText:
        'Whether owners and administrators must enter a code from an authenticator app as well as their password. It protects the accounts that can see every patient record and change everyone’s access.',
    },
  ];

  for (const d of defs) {
    await prisma.settingDefinition.upsert({
      where: { key: d.key },
      update: {
        module: d.module,
        dataType: d.dataType,
        defaultValue: d.defaultValue,
        allowedScopes: d.allowedScopes,
        description: d.description,
        helpText: d.helpText,
        // `Prisma.DbNull`, not a bare `null`: on a nullable Json column a plain
        // null is ambiguous between "the SQL NULL" and "the JSON literal null",
        // and Prisma refuses it outright. This has to actually clear the
        // column — a setting that STOPS being a closed set would otherwise keep
        // its old choices and the API would keep refusing values it now allows.
        allowedValues: d.allowedValues ?? Prisma.DbNull,
      },
      create: d,
    });
  }

  console.warn(`  settings         ${defs.length}`);
}

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
async function seedTaxRuleDefaults(): Promise<void> {
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

async function seedPlans(): Promise<void> {
  const plans = [
    {
      code: 'STARTER',
      name: 'Starter',
      tagline: 'A single clinic finding its feet',
      trialDays: 14,
      sortOrder: 1,
      prices: { INR: 1499, USD: 19, EUR: 19, GBP: 16, AED: 69, SGD: 25, AUD: 29 },
      features: {
        max_branches: 1,
        max_users: 10,
        max_patients: 2000,
        pharmacy_module: false,
        lab_module: false,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'GROWTH',
      name: 'Growth',
      tagline: 'Multi-branch, pharmacy and lab included',
      trialDays: 14,
      sortOrder: 2,
      prices: { INR: 4999, USD: 59, EUR: 55, GBP: 49, AED: 219, SGD: 79, AUD: 89 },
      features: {
        max_branches: 5,
        max_users: 50,
        max_patients: 25000,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'ENTERPRISE',
      name: 'Enterprise',
      tagline: 'Hospital chains, unlimited branches',
      trialDays: 30,
      sortOrder: 3,
      prices: { INR: 14999, USD: 179, EUR: 169, GBP: 149, AED: 659, SGD: 239, AUD: 269 },
      features: {
        max_branches: -1,
        max_users: -1,
        max_patients: -1,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: true,
      },
    },
  ];

  for (const p of plans) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, tagline: p.tagline, trialDays: p.trialDays, sortOrder: p.sortOrder },
      create: {
        code: p.code,
        name: p.name,
        tagline: p.tagline,
        trialDays: p.trialDays,
        sortOrder: p.sortOrder,
      },
    });

    /*
     * Priced per currency, and NOT converted from the rupee figure.
     *
     * A published price is a commercial decision, not an exchange-rate
     * calculation: $59 is a price somebody chose, and ₹4999 at today's rate is
     * not. Converting here would also make every plan's price move whenever the
     * rate did, which is not something a customer or a finance team can work
     * with. `@rcln/payments` deliberately contains no FX for the same reason.
     *
     * A currency a plan has no row for is simply not purchasable in that
     * currency — `listPlans` omits the plan rather than showing a price that
     * would fail at checkout.
     *
     * Annual is ten months' price in every currency: two months free, which is
     * the discount the marketing page states.
     */
    for (const [currency, monthly] of Object.entries(p.prices)) {
      for (const [interval, amount] of [
        ['MONTH', monthly],
        ['YEAR', monthly * 10],
      ] as const) {
        await prisma.planPrice.upsert({
          where: {
            planId_currency_billingInterval: {
              planId: plan.id,
              currency,
              billingInterval: interval,
            },
          },
          update: { amount },
          create: { planId: plan.id, currency, billingInterval: interval, amount },
        });
      }
    }

    for (const [featureKey, value] of Object.entries(p.features)) {
      const isBool = typeof value === 'boolean';
      const payload = {
        valueType: (isBool ? 'BOOL' : 'INT') as 'BOOL' | 'INT',
        intValue: isBool ? null : (value as number),
        boolValue: isBool ? (value as boolean) : null,
      };
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey } },
        update: payload,
        create: { planId: plan.id, featureKey, ...payload },
      });
    }
  }

  console.warn(`  plans            ${plans.length}`);
}

/**
 * The clinical taxonomy, seeded as PLATFORM rows (`organizationId = null`).
 *
 * Every clinic reads these; a clinic that needs a node we have not thought of
 * adds its own org-scoped row through `doctor.master.manage` rather than waiting
 * for a deploy. The RLS policy is deliberately read-permissive and write-strict,
 * so a tenant can never add to THIS list — see enable-rls.sql.
 *
 * ── WHAT THIS TREE IS, AND WHAT IT IS NOT ─────────────────────────────────────
 *
 * It is what a practitioner is TRAINED IN. It is deliberately none of:
 *
 *   · where they work      → `branches`, and `staff_profiles.department`
 *   · what they charge for → procedures/services, which reference a node here
 *   · what they hold       → `qualifications` (MBBS, MDS, board certification)
 *                            and `doctor_profiles.registration_*`
 *
 * So there is no "Angioplasty" node (a procedure) and no "Fellowship in
 * Cardiology" node (a credential). Both are real, and both live elsewhere.
 *
 * ── CODES ARE FLAT, NOT PATHS ─────────────────────────────────────────────────
 *
 * `INTERVENTIONAL_CARDIOLOGY`, never `MED-CARD-INTERVENTIONAL`. Two reasons, and
 * the second is the one that matters:
 *
 *   1. `createSpecialtyRequest` validates /^[A-Z0-9_]+$/ — hyphens are already
 *      rejected for tenant-authored codes, and the platform catalogue must not
 *      be spelled differently from the rows clinics add beside it.
 *   2. A path-encoded code becomes A LIE THE MOMENT A NODE MOVES. Re-parenting
 *      Sleep Medicine from Pulmonology to Neurology would demand a code change,
 *      the code is what the seed upserts on and what `doctor_specialties` was
 *      written against, and so the rename silently forks the node in two. The
 *      path already has a home: it is `parent_id`.
 *
 * ── ORDER-INDEPENDENT, BUT NO LONGER TWO-PASS ─────────────────────────────────
 *
 * ⚠️ This list used to be inserted flat and re-parented in a second pass. That
 *   is now unsafe. `specialties_sibling_name_key` is UNIQUE on
 *   (organization_id, parent_id, lower(name)) NULLS NOT DISTINCT — so during the
 *   old first pass, when every node briefly had parent_id NULL, EVERY NAME IN
 *   THIS FILE WAS A SIBLING OF EVERY OTHER. The seed would have started failing
 *   the first time two nodes anywhere in the tree shared a name, which is
 *   perfectly legal for nodes under different parents.
 *
 *   `ensureNode` below resolves each node's parent before writing the node, so
 *   a row is never persisted parentless. The order of this list therefore still
 *   does not matter — it is authored top-down only because that reads best.
 */
const SPECIALTIES: {
  code: string;
  name: string;
  parent?: string;
  type?: TaxonomyNodeType;
  description?: string;
}[] = [
  // ── Domains ────────────────────────────────────────────────────────────────
  //
  // Seven roots, not the six the brief named. `TRAD` is the addition: Ayurveda
  // and Homeopathy already existed as top-level rows, and filing them under
  // `MED` would assert they are allopathic specialties, which they are not.
  // WHO's own framing is "Traditional and Complementary Medicine", and the
  // domain generalises past India — Unani, Siddha, TCM, osteopathy, chiropractic
  // all belong here rather than in a country-specific bucket.
  {
    code: 'MED',
    name: 'Medical',
    type: 'DOMAIN',
    description: 'Physician specialties in the allopathic tradition.',
  },
  {
    code: 'DEN',
    name: 'Dental',
    type: 'DOMAIN',
    description: 'Dental and oral health specialties.',
  },
  {
    code: 'MBH',
    name: 'Mental & Behavioural Health',
    type: 'DOMAIN',
    description:
      'Psychiatry, psychology and the behavioural therapies. Psychiatry is filed here rather than under Medical — see its own note.',
  },
  {
    code: 'ALH',
    name: 'Allied Health',
    type: 'DOMAIN',
    description:
      'Clinical professions outside medicine and dentistry: therapy, diagnostics support, optometry, dietetics.',
  },
  {
    code: 'DGN',
    name: 'Diagnostic Services',
    type: 'DOMAIN',
    description:
      'Physician specialties that report on investigations rather than treat directly. The allied professions that OPERATE the equipment sit under Allied Health.',
  },
  {
    code: 'REH',
    name: 'Rehabilitation',
    type: 'DOMAIN',
    description:
      'Restoring function after injury, surgery or illness. The rehabilitation DISCIPLINES; the professions delivering them are under Allied Health.',
  },
  {
    code: 'TRAD',
    name: 'Traditional & Complementary Medicine',
    type: 'DOMAIN',
    description:
      'Systems of medicine outside the allopathic tradition, recognised and licensed differently by jurisdiction.',
  },

  // ── Medical ────────────────────────────────────────────────────────────────
  { code: 'GENERAL_MEDICINE', name: 'General Medicine', parent: 'MED' },
  { code: 'FAMILY_MEDICINE', name: 'Family Medicine', parent: 'MED' },
  { code: 'GERIATRICS', name: 'Geriatric Medicine', parent: 'MED' },
  { code: 'EMERGENCY_MEDICINE', name: 'Emergency Medicine', parent: 'MED' },
  { code: 'PALLIATIVE_MEDICINE', name: 'Palliative Medicine', parent: 'MED' },
  { code: 'PREVENTIVE_MEDICINE', name: 'Preventive Medicine', parent: 'MED' },
  { code: 'OCCUPATIONAL_MEDICINE', name: 'Occupational Medicine', parent: 'MED' },
  { code: 'INFECTIOUS_DISEASES', name: 'Infectious Diseases', parent: 'MED' },
  { code: 'ALLERGY_IMMUNOLOGY', name: 'Allergy & Immunology', parent: 'MED' },
  { code: 'CLINICAL_GENETICS', name: 'Clinical Genetics', parent: 'MED' },

  { code: 'PAEDIATRICS', name: 'Paediatrics', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'NEONATOLOGY', name: 'Neonatology', parent: 'PAEDIATRICS', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_CARDIOLOGY',
    name: 'Paediatric Cardiology',
    parent: 'PAEDIATRICS',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'PAEDIATRIC_NEUROLOGY',
    name: 'Paediatric Neurology',
    parent: 'PAEDIATRICS',
    type: 'SUB_SPECIALTY',
  },

  {
    code: 'OBSTETRICS_GYNAECOLOGY',
    name: 'Obstetrics & Gynaecology',
    parent: 'MED',
    type: 'DEPARTMENT',
  },
  {
    code: 'MATERNAL_FETAL_MEDICINE',
    name: 'Maternal & Fetal Medicine',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'REPRODUCTIVE_MEDICINE',
    name: 'Reproductive Medicine',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'GYNAECOLOGIC_ONCOLOGY',
    name: 'Gynaecologic Oncology',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'CARDIOLOGY', name: 'Cardiology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'INTERVENTIONAL_CARDIOLOGY',
    name: 'Interventional Cardiology',
    parent: 'CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'STRUCTURAL_HEART_DISEASE',
    name: 'Structural Heart Disease',
    parent: 'INTERVENTIONAL_CARDIOLOGY',
    type: 'SUB_SPECIALTY',
    description:
      'Four levels deep — MED → CARDIOLOGY → INTERVENTIONAL_CARDIOLOGY → here. Nothing in the schema knows or cares that this branch is deeper than Dental.',
  },
  {
    code: 'CORONARY_INTERVENTION',
    name: 'Coronary Intervention',
    parent: 'INTERVENTIONAL_CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'ELECTROPHYSIOLOGY',
    name: 'Cardiac Electrophysiology',
    parent: 'CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'HEART_FAILURE', name: 'Heart Failure', parent: 'CARDIOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'CARDIOTHORACIC_SURGERY', name: 'Cardiothoracic Surgery', parent: 'MED' },
  { code: 'VASCULAR_SURGERY', name: 'Vascular Surgery', parent: 'MED' },

  { code: 'NEUROLOGY', name: 'Neurology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'STROKE_MEDICINE', name: 'Stroke Medicine', parent: 'NEUROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'EPILEPTOLOGY', name: 'Epileptology', parent: 'NEUROLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'MOVEMENT_DISORDERS',
    name: 'Movement Disorders',
    parent: 'NEUROLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEUROSURGERY', name: 'Neurosurgery', parent: 'MED' },

  { code: 'ORTHOPAEDICS', name: 'Orthopaedics', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'SPINE_SURGERY', name: 'Spine Surgery', parent: 'ORTHOPAEDICS', type: 'SUB_SPECIALTY' },
  {
    code: 'JOINT_REPLACEMENT',
    name: 'Joint Replacement',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'SPORTS_MEDICINE',
    name: 'Sports Medicine',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
    description:
      'The physician sub-specialty. Distinct from SPORTS_REHABILITATION under Physiotherapy, which is the therapy focus area.',
  },
  { code: 'HAND_SURGERY', name: 'Hand Surgery', parent: 'ORTHOPAEDICS', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_ORTHOPAEDICS',
    name: 'Paediatric Orthopaedics',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
  },

  { code: 'GENERAL_SURGERY', name: 'General Surgery', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'GASTROINTESTINAL_SURGERY',
    name: 'Gastrointestinal Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'COLORECTAL_SURGERY',
    name: 'Colorectal Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'BARIATRIC_SURGERY',
    name: 'Bariatric Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PLASTIC_SURGERY', name: 'Plastic & Reconstructive Surgery', parent: 'MED' },

  { code: 'DERMATOLOGY', name: 'Dermatology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'TRICHOLOGY', name: 'Trichology', parent: 'DERMATOLOGY', type: 'FOCUS_AREA' },
  { code: 'COSMETOLOGY', name: 'Cosmetology', parent: 'DERMATOLOGY', type: 'FOCUS_AREA' },

  { code: 'OPHTHALMOLOGY', name: 'Ophthalmology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'CORNEA',
    name: 'Cornea & Refractive Surgery',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'VITREORETINAL_SURGERY',
    name: 'Vitreoretinal Surgery',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'GLAUCOMA', name: 'Glaucoma', parent: 'OPHTHALMOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_OPHTHALMOLOGY',
    name: 'Paediatric Ophthalmology',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'ENT', name: 'ENT (Otorhinolaryngology)', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'OTOLOGY', name: 'Otology & Neurotology', parent: 'ENT', type: 'SUB_SPECIALTY' },
  { code: 'RHINOLOGY', name: 'Rhinology', parent: 'ENT', type: 'SUB_SPECIALTY' },
  { code: 'HEAD_NECK_SURGERY', name: 'Head & Neck Surgery', parent: 'ENT', type: 'SUB_SPECIALTY' },

  { code: 'GASTROENTEROLOGY', name: 'Gastroenterology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'HEPATOLOGY', name: 'Hepatology', parent: 'GASTROENTEROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'NEPHROLOGY', name: 'Nephrology', parent: 'MED' },
  { code: 'UROLOGY', name: 'Urology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'ANDROLOGY', name: 'Andrology', parent: 'UROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'ENDOCRINOLOGY', name: 'Endocrinology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'DIABETOLOGY', name: 'Diabetology', parent: 'ENDOCRINOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'PULMONOLOGY', name: 'Pulmonology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'SLEEP_MEDICINE', name: 'Sleep Medicine', parent: 'PULMONOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'RHEUMATOLOGY', name: 'Rheumatology', parent: 'MED' },
  { code: 'HAEMATOLOGY', name: 'Haematology', parent: 'MED' },

  { code: 'ONCOLOGY', name: 'Oncology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'MEDICAL_ONCOLOGY', name: 'Medical Oncology', parent: 'ONCOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'SURGICAL_ONCOLOGY',
    name: 'Surgical Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'RADIATION_ONCOLOGY',
    name: 'Radiation Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'PAEDIATRIC_ONCOLOGY',
    name: 'Paediatric Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'ANAESTHESIOLOGY', name: 'Anaesthesiology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'PAIN_MEDICINE',
    name: 'Pain Medicine',
    parent: 'ANAESTHESIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CRITICAL_CARE',
    name: 'Critical Care Medicine',
    parent: 'ANAESTHESIOLOGY',
    type: 'SUB_SPECIALTY',
  },

  // ── Dental ─────────────────────────────────────────────────────────────────
  //
  // ⚠️ `DENTISTRY` IS REPURPOSED, NOT REPLACED. It used to be the top-level
  //   dental node with Orthodontics and friends beneath it. `DEN` is now that
  //   root, and DENTISTRY becomes the "General Dentistry" leaf. The code is
  //   untouched on purpose: any doctor already tagged DENTISTRY meant "a
  //   dentist, unspecified", and General Dentistry is precisely that. Renaming
  //   the code instead would have orphaned those `doctor_specialties` rows.
  {
    code: 'DENTISTRY',
    name: 'General Dentistry',
    parent: 'DEN',
    description:
      'Formerly the root of the dental tree. Re-typed as the general-practice leaf when DEN was introduced; the code is preserved so existing assignments keep resolving.',
  },
  { code: 'ORTHODONTICS', name: 'Orthodontics', parent: 'DEN' },
  { code: 'ENDODONTICS', name: 'Endodontics', parent: 'DEN' },
  { code: 'PERIODONTICS', name: 'Periodontics', parent: 'DEN' },
  { code: 'PROSTHODONTICS', name: 'Prosthodontics', parent: 'DEN' },
  { code: 'PAEDIATRIC_DENTISTRY', name: 'Paediatric Dentistry', parent: 'DEN' },
  { code: 'ORAL_MEDICINE', name: 'Oral Medicine', parent: 'DEN' },
  { code: 'ORAL_PATHOLOGY', name: 'Oral & Maxillofacial Pathology', parent: 'DEN' },
  {
    code: 'ORAL_MAXILLOFACIAL_SURGERY',
    name: 'Oral & Maxillofacial Surgery',
    parent: 'DEN',
  },
  {
    code: 'ORAL_MAXILLOFACIAL_RADIOLOGY',
    name: 'Oral & Maxillofacial Radiology',
    parent: 'DEN',
  },
  { code: 'PUBLIC_HEALTH_DENTISTRY', name: 'Public Health Dentistry', parent: 'DEN' },
  { code: 'IMPLANTOLOGY', name: 'Implantology', parent: 'DEN', type: 'FOCUS_AREA' },

  // ── Mental & Behavioural Health ────────────────────────────────────────────
  //
  // ⚠️ PSYCHIATRY IS FILED HERE, NOT UNDER MED, AND A TREE FORCES THAT CHOICE.
  //   It is genuinely both: a physician specialty and a mental-health one. The
  //   brief lists it under both headings, which a single-parent hierarchy cannot
  //   express. MBH wins because a user browsing for mental health expects to
  //   find psychiatry there and would consider its absence a bug, whereas a user
  //   browsing Medical is not surprised to be sent one level sideways.
  //   If cross-listing is ever genuinely needed, it is a second edge — a
  //   join table — NOT a duplicate node with a second code.
  { code: 'PSYCHIATRY', name: 'Psychiatry', parent: 'MBH', type: 'DEPARTMENT' },
  {
    code: 'CHILD_ADOLESCENT_PSYCHIATRY',
    name: 'Child & Adolescent Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'ADDICTION_PSYCHIATRY',
    name: 'Addiction Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'GERIATRIC_PSYCHIATRY',
    name: 'Geriatric Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CONSULTATION_LIAISON_PSYCHIATRY',
    name: 'Consultation-Liaison Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PSYCHOLOGY', name: 'Psychology', parent: 'MBH', type: 'DEPARTMENT' },
  {
    code: 'CLINICAL_PSYCHOLOGY',
    name: 'Clinical Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'COUNSELLING_PSYCHOLOGY',
    name: 'Counselling Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEUROPSYCHOLOGY', name: 'Neuropsychology', parent: 'PSYCHOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'CHILD_PSYCHOLOGY',
    name: 'Child Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PSYCHOTHERAPY', name: 'Psychotherapy', parent: 'MBH' },
  { code: 'BEHAVIOURAL_THERAPY', name: 'Behavioural Therapy', parent: 'MBH' },
  { code: 'ADDICTION_MEDICINE', name: 'Addiction Medicine', parent: 'MBH' },

  // ── Allied Health ──────────────────────────────────────────────────────────
  //
  // Nursing is deliberately absent. A nurse's grade is a JOB TITLE, which this
  // codebase already models as a `designations` row attached to a staff profile.
  // Adding it here would create the second answer to "what is this person" that
  // the whole exercise exists to avoid.
  { code: 'PHYSIOTHERAPY', name: 'Physiotherapy', parent: 'ALH', type: 'DEPARTMENT' },
  {
    code: 'SPORTS_REHABILITATION',
    name: 'Sports Rehabilitation',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  {
    code: 'NEURO_PHYSIOTHERAPY',
    name: 'Neurological Physiotherapy',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  {
    code: 'PAEDIATRIC_PHYSIOTHERAPY',
    name: 'Paediatric Physiotherapy',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  { code: 'OCCUPATIONAL_THERAPY', name: 'Occupational Therapy', parent: 'ALH' },
  { code: 'SPEECH_LANGUAGE_THERAPY', name: 'Speech & Language Therapy', parent: 'ALH' },
  { code: 'AUDIOLOGY', name: 'Audiology', parent: 'ALH' },
  { code: 'OPTOMETRY', name: 'Optometry', parent: 'ALH' },
  { code: 'NUTRITION_DIETETICS', name: 'Nutrition & Dietetics', parent: 'ALH', type: 'DEPARTMENT' },
  {
    code: 'CLINICAL_NUTRITION',
    name: 'Clinical Nutrition',
    parent: 'NUTRITION_DIETETICS',
    type: 'FOCUS_AREA',
  },
  {
    code: 'SPORTS_NUTRITION',
    name: 'Sports Nutrition',
    parent: 'NUTRITION_DIETETICS',
    type: 'FOCUS_AREA',
  },
  { code: 'RESPIRATORY_THERAPY', name: 'Respiratory Therapy', parent: 'ALH' },
  { code: 'PODIATRY', name: 'Podiatry', parent: 'ALH' },
  { code: 'PROSTHETICS_ORTHOTICS', name: 'Prosthetics & Orthotics', parent: 'ALH' },
  {
    code: 'MEDICAL_LABORATORY_TECHNOLOGY',
    name: 'Medical Laboratory Technology',
    parent: 'ALH',
    description:
      'The allied profession running the bench. PATHOLOGY under Diagnostic Services is the physician specialty that reports on it.',
  },
  {
    code: 'RADIOGRAPHY',
    name: 'Radiography & Imaging Technology',
    parent: 'ALH',
    description:
      'The allied profession that acquires the images. RADIOLOGY under Diagnostic Services is the physician specialty that reports them. Same equipment, different training, different node.',
  },

  // ── Diagnostic Services ────────────────────────────────────────────────────
  { code: 'RADIOLOGY', name: 'Radiology', parent: 'DGN', type: 'DEPARTMENT' },
  {
    code: 'INTERVENTIONAL_RADIOLOGY',
    name: 'Interventional Radiology',
    parent: 'RADIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEURORADIOLOGY', name: 'Neuroradiology', parent: 'RADIOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'MUSCULOSKELETAL_RADIOLOGY',
    name: 'Musculoskeletal Radiology',
    parent: 'RADIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PATHOLOGY', name: 'Pathology', parent: 'DGN', type: 'DEPARTMENT' },
  { code: 'HISTOPATHOLOGY', name: 'Histopathology', parent: 'PATHOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'CYTOPATHOLOGY', name: 'Cytopathology', parent: 'PATHOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'HAEMATOPATHOLOGY',
    name: 'Haematopathology',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CLINICAL_BIOCHEMISTRY',
    name: 'Clinical Biochemistry',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CLINICAL_MICROBIOLOGY',
    name: 'Clinical Microbiology',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NUCLEAR_MEDICINE', name: 'Nuclear Medicine', parent: 'DGN' },
  { code: 'TRANSFUSION_MEDICINE', name: 'Transfusion Medicine', parent: 'DGN' },

  // ── Rehabilitation ─────────────────────────────────────────────────────────
  {
    code: 'PHYSICAL_MEDICINE_REHABILITATION',
    name: 'Physical Medicine & Rehabilitation',
    parent: 'REH',
    type: 'DEPARTMENT',
  },
  { code: 'NEURO_REHABILITATION', name: 'Neurological Rehabilitation', parent: 'REH' },
  { code: 'CARDIAC_REHABILITATION', name: 'Cardiac Rehabilitation', parent: 'REH' },
  { code: 'PULMONARY_REHABILITATION', name: 'Pulmonary Rehabilitation', parent: 'REH' },
  { code: 'GERIATRIC_REHABILITATION', name: 'Geriatric Rehabilitation', parent: 'REH' },

  // ── Traditional & Complementary ────────────────────────────────────────────
  { code: 'AYURVEDA', name: 'Ayurveda', parent: 'TRAD' },
  { code: 'HOMEOPATHY', name: 'Homeopathy', parent: 'TRAD' },
  { code: 'UNANI', name: 'Unani Medicine', parent: 'TRAD' },
  { code: 'SIDDHA', name: 'Siddha Medicine', parent: 'TRAD' },
  { code: 'NATUROPATHY', name: 'Naturopathy', parent: 'TRAD' },
  { code: 'YOGA_THERAPY', name: 'Yoga Therapy', parent: 'TRAD' },
  { code: 'ACUPUNCTURE', name: 'Acupuncture', parent: 'TRAD' },
  { code: 'CHIROPRACTIC', name: 'Chiropractic', parent: 'TRAD' },
  { code: 'OSTEOPATHIC_MEDICINE', name: 'Osteopathic Medicine', parent: 'TRAD' },
  {
    code: 'TRADITIONAL_CHINESE_MEDICINE',
    name: 'Traditional Chinese Medicine',
    parent: 'TRAD',
  },
];

/**
 * Credentials, seeded as PLATFORM rows.
 *
 * ── THIS IS NOT THE TAXONOMY, AND MUST NEVER BECOME IT ───────────────────────
 * A qualification is what someone HOLDS; a `specialties` node is what they are
 * TRAINED IN. "MD" and "Cardiology" answer different questions and a doctor has
 * both independently — an MD who practises dermatology is not a contradiction.
 * ⚠️ Never add "Fellowship in Cardiology" here AND a Cardiology node there and
 *   expect them to stay in step; the fellowship is the credential, the node is
 *   the classification, and joining them would recreate the single-field
 *   `specialization` string this schema exists to replace.
 *
 * ── WHY THE LIST IS EXPLICITLY MULTI-JURISDICTION ────────────────────────────
 * It began as India-only — MBBS/MD/MS/DNB/BAMS — which quietly made the product
 * India-only too: a clinic in Nairobi or Dubai opening the qualification picker
 * found nothing their doctors actually hold, and the only way forward was
 * typing a free-text row per doctor. The taxonomy was deliberately built to
 * work internationally (ADR-free, but see the DOMAIN roots in SPECIALTIES);
 * leaving credentials parochial would have undone that at the one point a
 * clinic notices.
 *
 * ⚠️ NO CODE HERE WAS RENAMED. The seed upserts on (organization_id, code) and
 *   `doctor_qualifications` rows point at these ids, so a rename would orphan
 *   existing records. Entries were added, and some display names clarified.
 *
 * Licensing and registration remain a SEPARATE system —
 * `doctor_profiles.registration_number` / `registration_council`. A licence is
 * jurisdiction-specific and expires; a degree does neither.
 */
const QUALIFICATIONS: { code: string; name: string }[] = [
  // ── Medical, entry to practice ────────────────────────────────────────────
  { code: 'MBBS', name: 'MBBS — Bachelor of Medicine, Bachelor of Surgery' },
  { code: 'MD_US', name: 'MD — Doctor of Medicine (US/Canada entry degree)' },
  { code: 'DO_US', name: 'DO — Doctor of Osteopathic Medicine (US)' },
  { code: 'MBCHB', name: 'MBChB — Bachelor of Medicine and Surgery (UK/Africa/NZ)' },
  { code: 'MBBCH', name: 'MB BCh BAO — Bachelor of Medicine (Ireland)' },
  { code: 'CEREMED', name: 'State medical degree (other jurisdiction)' },

  // ── Medical, postgraduate ─────────────────────────────────────────────────
  { code: 'MD', name: 'MD — Doctor of Medicine (postgraduate)' },
  { code: 'MS', name: 'MS — Master of Surgery' },
  { code: 'DNB', name: 'DNB — Diplomate of National Board (India)' },
  { code: 'DM', name: 'DM — Doctorate of Medicine (super-specialty)' },
  { code: 'MCH', name: 'MCh — Magister Chirurgiae (super-specialty)' },
  { code: 'DIPLOMA', name: 'Post-graduate Diploma' },
  { code: 'RESIDENCY', name: 'Residency — completed' },
  { code: 'FELLOWSHIP', name: 'Clinical fellowship' },
  { code: 'PHD', name: 'PhD' },
  { code: 'MPH', name: 'MPH — Master of Public Health' },

  // ── Board certification and college membership ────────────────────────────
  //
  // The recognised route to specialist practice differs by country and none of
  // these is a superset of the others.
  { code: 'BOARD_CERT', name: 'Board certification (specialty board)' },
  { code: 'FRCS', name: 'FRCS — Fellow, Royal College of Surgeons' },
  { code: 'FRCP', name: 'FRCP — Fellow, Royal College of Physicians' },
  { code: 'MRCP', name: 'MRCP — Member, Royal College of Physicians' },
  { code: 'MRCS', name: 'MRCS — Member, Royal College of Surgeons' },
  { code: 'MRCGP', name: 'MRCGP — Member, Royal College of General Practitioners' },
  { code: 'FACS', name: 'FACS — Fellow, American College of Surgeons' },
  { code: 'FACP', name: 'FACP — Fellow, American College of Physicians' },
  { code: 'FRACP', name: 'FRACP — Fellow, Royal Australasian College of Physicians' },
  { code: 'FRCPC', name: 'FRCPC — Fellow, Royal College of Physicians of Canada' },
  { code: 'FCPS', name: 'FCPS — Fellow, College of Physicians & Surgeons' },
  { code: 'EUR_SPEC', name: 'European specialist qualification (CCT/equivalent)' },

  // ── Dental ────────────────────────────────────────────────────────────────
  { code: 'BDS', name: 'BDS — Bachelor of Dental Surgery' },
  { code: 'MDS', name: 'MDS — Master of Dental Surgery' },
  { code: 'DDS', name: 'DDS — Doctor of Dental Surgery (US/Canada)' },
  { code: 'DMD', name: 'DMD — Doctor of Dental Medicine (US/Canada)' },

  // ── Traditional & complementary ───────────────────────────────────────────
  { code: 'BAMS', name: 'BAMS — Ayurvedic Medicine & Surgery' },
  { code: 'BHMS', name: 'BHMS — Homeopathic Medicine & Surgery' },
  { code: 'BUMS', name: 'BUMS — Unani Medicine & Surgery' },
  { code: 'BSMS', name: 'BSMS — Siddha Medicine & Surgery' },
  { code: 'BNYS', name: 'BNYS — Naturopathy & Yogic Sciences' },
  { code: 'DC_CHIRO', name: 'DC — Doctor of Chiropractic' },
  { code: 'LAC_TCM', name: 'L.Ac. — Licensed Acupuncturist / TCM' },

  // ── Mental & behavioural health ───────────────────────────────────────────
  { code: 'PSYD', name: 'PsyD — Doctor of Psychology' },
  { code: 'MPHIL_CLIN_PSY', name: 'MPhil Clinical Psychology' },
  { code: 'MA_PSYCH', name: 'Master of Psychology / Counselling' },
  { code: 'MSW', name: 'MSW — Master of Social Work' },

  // ── Allied health ─────────────────────────────────────────────────────────
  { code: 'BPT', name: 'BPT — Bachelor of Physiotherapy' },
  { code: 'MPT', name: 'MPT — Master of Physiotherapy' },
  { code: 'DPT', name: 'DPT — Doctor of Physical Therapy (US)' },
  { code: 'BOT', name: 'BOT — Bachelor of Occupational Therapy' },
  { code: 'MOT', name: 'MOT — Master of Occupational Therapy' },
  { code: 'SLP', name: 'Speech & Language Pathology degree' },
  { code: 'AUD', name: 'AuD — Doctor of Audiology' },
  { code: 'BOPTOM', name: 'Optometry degree (BOptom / OD)' },
  { code: 'RD_DIET', name: 'Registered Dietitian / Nutrition degree' },
  { code: 'RRT_RESP', name: 'Respiratory therapy qualification' },
  { code: 'DPM_POD', name: 'DPM — Doctor of Podiatric Medicine' },
  { code: 'DMLT', name: 'DMLT — Medical Laboratory Technology' },
  { code: 'BMLT', name: 'BMLT — Bachelor of Medical Lab Technology' },
  { code: 'BSC_RADIO', name: 'Radiography / Medical Imaging degree' },

  // ── Nursing ───────────────────────────────────────────────────────────────
  //
  // Present as CREDENTIALS only. Nursing is deliberately absent from the
  // clinical taxonomy, where a nurse's grade is a `designations` row instead.
  { code: 'BSC_NURSING', name: 'BSc Nursing' },
  { code: 'MSC_NURSING', name: 'MSc Nursing' },
  { code: 'GNM', name: 'GNM — General Nursing & Midwifery' },
  { code: 'ANM', name: 'ANM — Auxiliary Nurse Midwife' },
  { code: 'RN', name: 'RN — Registered Nurse' },
  { code: 'NP_ADV', name: 'Nurse Practitioner / Advanced Practice Nurse' },
  { code: 'MIDWIFERY', name: 'Midwifery qualification' },

  // ── Pharmacy ──────────────────────────────────────────────────────────────
  { code: 'BPHARM', name: 'B.Pharm' },
  { code: 'MPHARM', name: 'M.Pharm' },
  { code: 'DPHARM', name: 'D.Pharm' },
  { code: 'PHARMD', name: 'PharmD — Doctor of Pharmacy' },
];

/**
 * Job titles, seeded as PLATFORM rows so a new clinic's invite form is not empty
 * on day one. A clinic adds its own through `iam.designation.manage`; those are
 * org-scoped and invisible to everyone else.
 *
 * Deliberately broader than the role list: a role is what someone may DO
 * (permissions), a designation is what they ARE CALLED. Three consultants can
 * share the DOCTOR role and hold three different titles.
 */
const DESIGNATIONS: { code: string; name: string }[] = [
  { code: 'CONSULTANT', name: 'Consultant' },
  { code: 'SENIOR_CONSULTANT', name: 'Senior Consultant' },
  { code: 'JUNIOR_CONSULTANT', name: 'Junior Consultant' },
  { code: 'VISITING_CONSULTANT', name: 'Visiting Consultant' },
  { code: 'RESIDENT_MEDICAL_OFFICER', name: 'Resident Medical Officer' },
  { code: 'MEDICAL_OFFICER', name: 'Medical Officer' },
  { code: 'DUTY_DOCTOR', name: 'Duty Doctor' },
  { code: 'HEAD_OF_DEPARTMENT', name: 'Head of Department' },
  { code: 'MEDICAL_SUPERINTENDENT', name: 'Medical Superintendent' },
  { code: 'NURSING_SUPERINTENDENT', name: 'Nursing Superintendent' },
  { code: 'HEAD_NURSE', name: 'Head Nurse' },
  { code: 'STAFF_NURSE', name: 'Staff Nurse' },
  { code: 'TRAINEE_NURSE', name: 'Trainee Nurse' },
  { code: 'WARD_BOY', name: 'Ward Attendant' },
  { code: 'FRONT_DESK_EXECUTIVE', name: 'Front Desk Executive' },
  { code: 'RECEPTIONIST', name: 'Receptionist' },
  { code: 'CLINIC_MANAGER', name: 'Clinic Manager' },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager' },
  { code: 'ADMINISTRATOR', name: 'Administrator' },
  { code: 'ACCOUNTS_EXECUTIVE', name: 'Accounts Executive' },
  { code: 'ACCOUNTS_MANAGER', name: 'Accounts Manager' },
  { code: 'BILLING_EXECUTIVE', name: 'Billing Executive' },
  { code: 'PHARMACIST', name: 'Pharmacist' },
  { code: 'CHIEF_PHARMACIST', name: 'Chief Pharmacist' },
  { code: 'LAB_TECHNICIAN', name: 'Lab Technician' },
  { code: 'SENIOR_LAB_TECHNICIAN', name: 'Senior Lab Technician' },
  { code: 'PATHOLOGIST', name: 'Pathologist' },
  { code: 'RADIOLOGIST', name: 'Radiologist' },
  { code: 'RADIOGRAPHER', name: 'Radiographer' },
  { code: 'PHYSIOTHERAPIST', name: 'Physiotherapist' },
  { code: 'DIETICIAN', name: 'Dietician' },
  { code: 'COUNSELLOR', name: 'Counsellor' },
  { code: 'IT_ADMINISTRATOR', name: 'IT Administrator' },
  { code: 'HOUSEKEEPING', name: 'Housekeeping' },
  { code: 'SECURITY', name: 'Security' },
];

/**
 * Which titles fit which built-in role, so a Receptionist cannot be made a
 * Radiologist.
 *
 * ⚠️ A TITLE ABSENT FROM EVERY LIST HERE FITS EVERY ROLE.
 *   The eligibility query treats "no visible pairing at all" as "fits
 *   anywhere", not "fits nowhere" — otherwise a clinic that adds a title and
 *   forgets to map it watches it vanish from every menu. So the omissions below
 *   are deliberate, not oversights: IT_ADMINISTRATOR, HOUSEKEEPING and SECURITY
 *   are support roles that any of the built-in roles might carry, and pinning
 *   them to one would be a guess.
 *
 * SUPER_ADMIN and PATIENT get nothing: neither is a staff role, and the invite
 * service already refuses a PLATFORM-scoped role outright.
 */
const ROLE_DESIGNATIONS: Record<string, string[]> = {
  ORG_OWNER: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'MEDICAL_SUPERINTENDENT', 'HEAD_OF_DEPARTMENT'],
  ORG_ADMIN: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'BRANCH_MANAGER', 'MEDICAL_SUPERINTENDENT'],
  BRANCH_ADMIN: ['BRANCH_MANAGER', 'CLINIC_MANAGER', 'ADMINISTRATOR'],
  DOCTOR: [
    'CONSULTANT',
    'SENIOR_CONSULTANT',
    'JUNIOR_CONSULTANT',
    'VISITING_CONSULTANT',
    'RESIDENT_MEDICAL_OFFICER',
    'MEDICAL_OFFICER',
    'DUTY_DOCTOR',
    'HEAD_OF_DEPARTMENT',
    'MEDICAL_SUPERINTENDENT',
    'PHYSIOTHERAPIST',
    'DIETICIAN',
    'COUNSELLOR',
  ],
  NURSE: ['NURSING_SUPERINTENDENT', 'HEAD_NURSE', 'STAFF_NURSE', 'TRAINEE_NURSE', 'WARD_BOY'],
  RECEPTIONIST: ['FRONT_DESK_EXECUTIVE', 'RECEPTIONIST', 'CLINIC_MANAGER'],
  LAB_ASSISTANT: ['LAB_TECHNICIAN', 'RADIOGRAPHER'],
  LAB_MANAGER: [
    'SENIOR_LAB_TECHNICIAN',
    'LAB_TECHNICIAN',
    'PATHOLOGIST',
    'RADIOLOGIST',
    'RADIOGRAPHER',
  ],
  PHARMACIST: ['PHARMACIST', 'CHIEF_PHARMACIST'],
  ACCOUNTANT: ['ACCOUNTS_EXECUTIVE', 'ACCOUNTS_MANAGER', 'BILLING_EXECUTIVE'],
};

async function seedRoleDesignations(): Promise<void> {
  const roles = new Map(
    (
      await prisma.role.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((r) => [r.code, r.id])
  );

  const designations = new Map(
    (
      await prisma.designation.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((d) => [d.code, d.id])
  );

  let pairs = 0;

  for (const [roleCode, designationCodes] of Object.entries(ROLE_DESIGNATIONS)) {
    const roleId = roles.get(roleCode);
    if (!roleId) continue;

    for (const designationCode of designationCodes) {
      const designationId = designations.get(designationCode);
      if (!designationId) {
        throw new Error(`ROLE_DESIGNATIONS names ${designationCode}, which is not in DESIGNATIONS`);
      }

      // findFirst then create, for the same NULLS NOT DISTINCT reason as above.
      const existing = await prisma.roleDesignation.findFirst({
        where: { organizationId: null, roleId, designationId },
        select: { id: true },
      });
      if (!existing) {
        await prisma.roleDesignation.create({
          data: { organizationId: null, roleId, designationId },
        });
      }
      pairs += 1;
    }
  }

  console.warn(`  role↔title       ${pairs}`);
}

async function seedDesignations(): Promise<void> {
  // findFirst then create/update, not upsert: the unique is
  // (organization_id, code) NULLS NOT DISTINCT and Prisma refuses to build a
  // `where` for a compound unique with a nullable component. Same constraint,
  // and the same workaround, as the settings and specialty seeds. See PITFALLS.
  for (const d of DESIGNATIONS) {
    const existing = await prisma.designation.findFirst({
      where: { organizationId: null, code: d.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.designation.update({ where: { id: existing.id }, data: { name: d.name } });
    } else {
      await prisma.designation.create({
        data: { organizationId: null, code: d.code, name: d.name },
      });
    }
  }

  console.warn(`  designations     ${DESIGNATIONS.length}`);
}

async function seedClinicalMasters(): Promise<void> {
  /*
   * `findFirst` then create/update rather than `upsert`.
   *
   * The unique is (organization_id, code) NULLS NOT DISTINCT, and Prisma refuses
   * to build a `where` for a compound unique with a nullable component —
   * organization_id is null on every platform row. Same constraint, and the same
   * workaround, as the settings seed. See PITFALLS.
   */
  const byCode = new Map(SPECIALTIES.map((s) => [s.code, s]));
  const orderOf = new Map(SPECIALTIES.map((s, i) => [s.code, i]));
  const resolved = new Map<string, string>();
  const inFlight = new Set<string>();

  /*
   * Write one node, having first written its parent. Memoised on `code`, so the
   * whole tree costs one pass regardless of how the list is ordered.
   *
   * ⚠️ A NODE IS NEVER PERSISTED WITHOUT ITS PARENT. The old seed inserted every
   *   row flat and re-parented afterwards, which `specialties_sibling_name_key`
   *   now forbids: with parent_id NULL and NULLS NOT DISTINCT, every row in the
   *   file is momentarily a sibling of every other, so any two nodes sharing a
   *   name anywhere in the tree collide. "Sports Medicine" under Orthopaedics
   *   and "Sports Nutrition" under Dietetics are fine; two nodes both called
   *   "Clinical Nutrition" under different parents would not have been.
   *
   * `inFlight` catches a cycle in THIS FILE — a typo'd parent code — with a
   * legible error, rather than letting it recurse until the stack gives out or
   * the database trigger fires mid-write.
   */
  async function ensureNode(code: string): Promise<string> {
    const cached = resolved.get(code);
    if (cached) return cached;

    const spec = byCode.get(code);
    if (!spec) throw new Error(`SPECIALTIES references unknown parent code "${code}"`);

    if (inFlight.has(code)) {
      throw new Error(
        `SPECIALTIES contains a parent cycle through "${code}" — check the \`parent\` fields`
      );
    }
    inFlight.add(code);
    const parentId = spec.parent ? await ensureNode(spec.parent) : null;
    inFlight.delete(code);

    /*
     * `findFirst` then create/update rather than `upsert`.
     *
     * The unique is (organization_id, code) NULLS NOT DISTINCT, and Prisma
     * refuses to build a `where` for a compound unique with a nullable component
     * — organization_id is null on every platform row. Same constraint, and the
     * same workaround, as the settings seed. See PITFALLS.
     */
    const payload = {
      name: spec.name,
      parentId,
      type: spec.type ?? ('SPECIALTY' as TaxonomyNodeType),
      description: spec.description ?? null,
      // Position in the source array. Sibling order is therefore whatever this
      // file reads as, and `ORDER BY display_order, name` is total.
      displayOrder: orderOf.get(code) ?? 0,
    };

    const existing = await prisma.specialty.findFirst({
      where: { organizationId: null, code },
      select: { id: true },
    });

    const id = existing
      ? (await prisma.specialty.update({ where: { id: existing.id }, data: payload })).id
      : (
          await prisma.specialty.create({
            data: { organizationId: null, code, ...payload },
          })
        ).id;

    resolved.set(code, id);
    return id;
  }

  for (const spec of SPECIALTIES) {
    await ensureNode(spec.code);
  }

  for (const q of QUALIFICATIONS) {
    const existing = await prisma.qualification.findFirst({
      where: { organizationId: null, code: q.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.qualification.update({ where: { id: existing.id }, data: { name: q.name } });
    } else {
      await prisma.qualification.create({
        data: { organizationId: null, code: q.code, name: q.name },
      });
    }
  }

  console.warn(`  specialties      ${SPECIALTIES.length}`);
  console.warn(`  qualifications   ${QUALIFICATIONS.length}`);
}

async function seedSuperAdmin(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? 'superadmin@rcln.local';
  const password = process.env['SUPERADMIN_PASSWORD'];
  const fullName = process.env['SUPERADMIN_NAME'] ?? 'Platform Super Admin';

  if (!password) {
    console.warn('  super admin      SKIPPED (SUPERADMIN_PASSWORD not set)');
    return;
  }

  if (process.env['NODE_ENV'] === 'production' && password.length < 16) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 16 characters in production');
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { isPlatformAdmin: true, status: 'ACTIVE' },
    create: {
      email,
      fullName,
      passwordHash: await hash(password, ARGON2),
      status: 'ACTIVE',
      isPlatformAdmin: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.warn(`  super admin      ${user.email}`);
}

async function main(): Promise<void> {
  console.warn('\nSeeding rcln…\n');

  const permissionIds = await seedPermissions();
  await seedSystemRoles(permissionIds);
  await seedSettingDefinitions();
  await seedDesignations();
  // After both roles and designations exist — it pairs them by code.
  await seedRoleDesignations();
  await seedClinicalMasters();
  await seedTaxRuleDefaults();
  await seedPlans();
  await seedSuperAdmin();

  console.warn('\nDone.\n');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
