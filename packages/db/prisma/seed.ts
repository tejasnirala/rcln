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
import { Prisma, PrismaClient } from '../generated/prisma/index.js';
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
