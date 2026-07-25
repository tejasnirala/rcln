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
import { PrismaClient } from '../generated/prisma/index.js';
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

async function seedSettingDefinitions(): Promise<void> {
  const defs = [
    {
      key: 'appointment.slot_minutes',
      module: 'appointment',
      dataType: 'INT' as const,
      defaultValue: 15,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Default consultation slot length in minutes',
    },
    {
      key: 'appointment.allow_online_booking',
      module: 'appointment',
      dataType: 'BOOL' as const,
      defaultValue: true,
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'DOCTOR'],
      description: 'Patients may self-book from the portal',
    },
    {
      key: 'appointment.reminder_hours_before',
      module: 'appointment',
      dataType: 'JSON' as const,
      defaultValue: [24, 2],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Hours before the appointment at which reminders fire',
    },
    {
      key: 'billing.invoice_prefix',
      module: 'billing',
      dataType: 'STRING' as const,
      defaultValue: 'INV',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Prefix for generated invoice numbers',
    },
    {
      key: 'billing.default_tax_percent',
      module: 'billing',
      dataType: 'DECIMAL' as const,
      defaultValue: 0,
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Fallback tax rate when a billable item defines none',
    },
    {
      key: 'billing.financial_year_start_month',
      module: 'billing',
      dataType: 'INT' as const,
      defaultValue: 4,
      allowedScopes: ['ORGANIZATION'],
      description: 'Month the financial year starts. 4 = April (India)',
    },
    {
      key: 'inventory.expiry_alert_days',
      module: 'inventory',
      dataType: 'JSON' as const,
      defaultValue: [90, 60, 30, 7],
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'Days before expiry at which alerts fire',
    },
    {
      key: 'inventory.batch_selection_strategy',
      module: 'inventory',
      dataType: 'STRING' as const,
      defaultValue: 'FEFO',
      allowedScopes: ['ORGANIZATION', 'BRANCH'],
      description: 'FEFO (first expiry first out) or FIFO',
    },
    {
      key: 'notification.default_channel',
      module: 'notification',
      dataType: 'STRING' as const,
      defaultValue: 'WHATSAPP',
      allowedScopes: ['ORGANIZATION', 'BRANCH', 'USER', 'PATIENT'],
      description: 'Preferred delivery channel',
    },
    {
      key: 'patient.uhid_prefix',
      module: 'patient',
      dataType: 'STRING' as const,
      defaultValue: 'P',
      allowedScopes: ['ORGANIZATION'],
      description: 'Prefix for generated patient UHIDs',
    },
    {
      key: 'security.session_idle_timeout_minutes',
      module: 'security',
      dataType: 'INT' as const,
      defaultValue: 60,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Idle minutes before a session is invalidated',
    },
    {
      key: 'security.require_mfa_for_admins',
      module: 'security',
      dataType: 'BOOL' as const,
      defaultValue: false,
      allowedScopes: ['PLATFORM', 'ORGANIZATION'],
      description: 'Force TOTP for org owners and admins',
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
      },
      create: d,
    });
  }

  console.warn(`  settings         ${defs.length}`);
}

async function seedPlans(): Promise<void> {
  const plans = [
    {
      code: 'STARTER',
      name: 'Starter',
      tagline: 'A single clinic finding its feet',
      trialDays: 14,
      sortOrder: 1,
      amount: 1499,
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
      amount: 4999,
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
      amount: 14999,
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

    // Monthly, plus annual at ten months' price.
    for (const [interval, amount] of [
      ['MONTH', p.amount],
      ['YEAR', p.amount * 10],
    ] as const) {
      await prisma.planPrice.upsert({
        where: {
          planId_currency_billingInterval: {
            planId: plan.id,
            currency: 'INR',
            billingInterval: interval,
          },
        },
        update: { amount },
        create: { planId: plan.id, currency: 'INR', billingInterval: interval, amount },
      });
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
