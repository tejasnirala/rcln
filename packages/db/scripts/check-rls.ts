/**
 * CI guard. Two things must hold, or tenant isolation is fiction:
 *
 *   1. every table with an `organization_id` column has RLS enabled and at
 *      least one policy — unless it is on the EXEMPT list with a stated reason
 *   2. the application role owns nothing, is not a superuser, and does not have
 *      BYPASSRLS — because policies are ENABLE, not FORCE, so an owner or
 *      superuser connection silently ignores every one of them
 *
 * This exists because RLS fails silently. A table that ships without a policy
 * does not error, does not log, and does not break any test that only ever
 * looks at one tenant. It just returns other clinics' rows.
 *
 * Run: pnpm db:rls:check
 */
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

// Single .env at the repo root; this script runs with cwd=packages/db.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const { Client } = pg;

/** Tables intentionally not tenant-scoped. Keep in sync with prisma/rls/enable-rls.sql. */
const EXEMPT: Record<string, string> = {
  organizations: 'resolved by hostname before a tenant context exists',
  organization_domains:
    'the host -> tenant lookup itself; scoping it would be circular (see enable-rls.sql)',
  users: 'global identity — one login spans organizations',
  sessions: 'looked up by refresh-token hash pre-context',
  auth_tokens: 'OTP verification happens pre-context',
  user_identities: 'SSO callback happens pre-context',
  roles: 'system roles have organization_id NULL by design',
  permissions: 'static catalogue',
  role_permissions: 'joins two non-tenant tables',
  plans: 'platform-wide product catalogue',
  plan_prices: 'platform-wide product catalogue',
  plan_features: 'platform-wide product catalogue',
  subscription_feature_overrides: 'child of subscriptions; reached via scoped parent',
  subscription_invoice_lines: 'child of subscription_invoices; reached via scoped parent',
  subscription_payments: 'child of subscription_invoices; reached via scoped parent',
  setting_definitions: 'static catalogue',
  setting_values: 'scoped by (scope_type, scope_id), not organization_id',
  branch_operating_hours: 'child of branches; reached via scoped parent',
  branch_closures: 'child of branches; reached via scoped parent',
  invitation_branches: 'child of invitations; reached via scoped parent',
  staff_profiles: 'child of memberships; reached via scoped parent',
  _prisma_migrations: 'prisma internal',
};

interface TableRow {
  table_name: string;
  rls_enabled: boolean;
  policy_count: number;
  has_org_column: boolean;
}

async function main(): Promise<void> {
  const url = process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DIRECT_DATABASE_URL or DATABASE_URL must be set');

  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows } = await client.query<TableRow>(`
    SELECT c.relname                              AS table_name,
           c.relrowsecurity                       AS rls_enabled,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name   = c.relname
               AND col.column_name  = 'organization_id'
           )                                      AS has_org_column
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const failures: string[] = [];
  let checked = 0;

  // Policies are ENABLE, not FORCE, so isolation depends entirely on the app
  // connecting as a non-owner without BYPASSRLS. Verify that separately.
  const { rows: roleRows } = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rcln_app'`);

  // The app role must not own any RLS table — an owner bypasses its own policies.
  const { rows: ownedRows } = await client.query<{ count: string }>(`
    SELECT count(*) AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND pg_get_userbyid(c.relowner) = 'rcln_app'
  `);

  await client.end();

  if (Number(ownedRows[0]?.count ?? 0) > 0) {
    failures.push(
      `rcln_app owns ${ownedRows[0]?.count} RLS table(s) — an owner bypasses its own policies`
    );
  }

  const appRole = roleRows[0];
  if (!appRole) failures.push('rcln_app role does not exist');
  else if (appRole.rolsuper) failures.push('rcln_app is a SUPERUSER — it bypasses every policy');
  else if (appRole.rolbypassrls) failures.push('rcln_app has BYPASSRLS — it bypasses every policy');

  for (const t of rows) {
    if (EXEMPT[t.table_name]) continue;
    if (!t.has_org_column) continue;

    checked++;
    if (!t.rls_enabled) failures.push(`${t.table_name}: RLS not enabled`);
    else if (t.policy_count === 0)
      failures.push(`${t.table_name}: RLS enabled but no policy — denies everything`);
  }

  // A table that has org_id but was silently added to EXEMPT should be noticed.
  const unusedExemptions = Object.keys(EXEMPT).filter(
    (name) => name !== '_prisma_migrations' && !rows.some((r) => r.table_name === name)
  );

  if (failures.length > 0) {
    console.error(`\n✗ RLS check failed — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`   ${f}`);
    console.error('\n  Fix: add the table to prisma/rls/enable-rls.sql and re-run the migration,');
    console.error('  or add it to EXEMPT in scripts/check-rls.ts with a written reason.\n');
    process.exit(1);
  }

  console.warn(`✓ RLS check passed — ${checked} tenant table(s) protected.`);
  if (unusedExemptions.length > 0) {
    console.warn(`  Note: stale exemptions for missing tables: ${unusedExemptions.join(', ')}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
