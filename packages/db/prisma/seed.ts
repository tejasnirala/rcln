/**
 * Idempotent seed. Safe to re-run — everything upserts on a natural key.
 *
 * This file is the ORCHESTRATOR ONLY: the order of the steps and nothing else.
 * Each step lives in its own module under `seed/`, owns its own data, and can be
 * edited without touching any other. Adding a step means writing one module and
 * adding one line to `main()`.
 *
 *   seed/client.ts              the owner-role connection every step shares
 *   seed/permissions.ts         the permission catalogue
 *   seed/system-roles.ts        system roles + their grants
 *   seed/setting-definitions.ts the setting catalogue
 *   seed/designations.ts        job titles
 *   seed/role-designations.ts   which title fits which role
 *   seed/clinical-masters.ts    specialties + qualifications (data in seed/data/)
 *   seed/tax-rule-defaults.ts   starting-point tax rates per country
 *   seed/plans.ts               subscription plans, prices, features
 *   seed/super-admin.ts         the one account never created through the UI
 */
import { prisma } from './seed/client.js';
import { seedClinicalMasters } from './seed/clinical-masters.js';
import { seedDesignations } from './seed/designations.js';
import { seedPermissions } from './seed/permissions.js';
import { seedPlans } from './seed/plans.js';
import { seedRoleDesignations } from './seed/role-designations.js';
import { seedSettingDefinitions } from './seed/setting-definitions.js';
import { seedSuperAdmin } from './seed/super-admin.js';
import { seedSystemRoles } from './seed/system-roles.js';
import { seedTaxRuleDefaults } from './seed/tax-rule-defaults.js';

/**
 * ⚠️ THE ORDER IS LOAD-BEARING IN TWO PLACES, AND NOWHERE ELSE.
 *   `seedSystemRoles` takes the permission map `seedPermissions` returns, and
 *   `seedRoleDesignations` pairs roles with titles by code so both must already
 *   exist. Every other step is independent and may be reordered freely.
 */
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
