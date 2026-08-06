/**
 * Registration writes across the RLS boundary. This proves it lands correctly.
 *
 * `registerOrganization()` is the only place in the codebase that sets the
 * tenant session variables by hand, mid-transaction, rather than going through
 * `withTenant()`. It has to: three of its tables are RLS-exempt and four are
 * not, and the organization those four are scoped to does not exist until
 * halfway through the same transaction.
 *
 * That makes it the highest-risk write path in the system. A mistake would not
 * throw — RLS fails closed, so the rows would simply be missing, or worse, land
 * attached to nothing. This suite registers two clinics through the real service
 * and then checks, from a genuinely tenant-scoped connection, that each one sees
 * exactly its own rows and none of the other's.
 *
 * Runs against real Postgres with real migrations. Never mock Prisma here.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `t${Date.now().toString(36)}`;
const SLUG_A = `reg-a-${SUFFIX}`;
const SLUG_B = `reg-b-${SUFFIX}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
const appUrl = process.env['DATABASE_URL'];

let owner: Client;
let app: Client;

let orgA: { organizationId: string; branchId: string; ownerUserId: string };
let orgB: { organizationId: string; branchId: string; ownerUserId: string };

/**
 * Run a query with the tenant session variables set, exactly as withTenant does.
 * `branchIds` matters: membership_roles carries a RESTRICTIVE branch policy on
 * top of tenant isolation.
 */
async function asTenant<T>(
  organizationId: string,
  branchIds: string[],
  fn: () => Promise<T>
): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(
      `SELECT set_config('app.current_org', $1, true),
              set_config('app.branch_scope', $2, true)`,
      [organizationId, `{${branchIds.join(',')}}`]
    );
    const result = await fn();
    await app.query('COMMIT');
    return result;
  } catch (err) {
    await app.query('ROLLBACK');
    throw err;
  }
}

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pvt Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: `${label} Main`, code: 'MAIN', city: 'Pune' },
    owner: {
      fullName: `${label} Owner`,
      // Unique per run: users.email and users.phone are globally unique, and
      // registration refuses an identifier that already exists.
      email: `${slug}@example.test`,
      phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: 'CorrectHorse9Battery',
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

beforeAll(async () => {
  if (!ownerUrl || !appUrl) {
    throw new Error('DATABASE_URL and DIRECT_DATABASE_URL must be set to run this suite');
  }

  owner = new Client({ connectionString: ownerUrl });
  app = new Client({ connectionString: appUrl });
  await owner.connect();
  await app.connect();

  // The service uses the shared Prisma client, which the server normally boots.
  // assertRlsActive() runs inside, so this also proves the suite is talking to
  // rcln_app and not an owner connection that would bypass every policy.
  await initDatabase();

  orgA = await registerOrganization(payload(SLUG_A, 'Reg A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Reg B'));
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (ids.length > 0) {
    // organizations cascade to domains, branches, memberships, membership_roles
    // and subscriptions; audit_logs and users do not, so clear them explicitly.
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await app?.end();
  await disconnectDb();
  await redis.quit();
});

describe('registration writes every row', () => {
  it('creates the organization, domain and owner (the RLS-exempt tables)', async () => {
    const { rows } = await owner.query<{ status: string; domain: string; owner_email: string }>(
      `SELECT o.status,
              d.domain,
              u.email AS owner_email
       FROM organizations o
       JOIN organization_domains d ON d.organization_id = o.id
       JOIN users u ON u.id = o.owner_user_id
       WHERE o.id = $1`,
      [orgA.organizationId]
    );

    expect(rows).toHaveLength(1);
    // ACTIVE, not the PENDING default — nothing else would activate it, and
    // requireTenant only rejects SUSPENDED, so PENDING would be a limbo state.
    expect(rows[0]?.status).toBe('ACTIVE');
    expect(rows[0]?.domain).toBe(`${SLUG_A}.${process.env['ROOT_DOMAIN'] ?? 'lvh.me'}`);
    expect(rows[0]?.owner_email).toBe(`${SLUG_A}@example.test`);
  });

  it('creates the branch, membership, role and subscription (the RLS-enforced tables)', async () => {
    const counts = await asTenant(orgA.organizationId, [orgA.branchId], async () => {
      const one = async (sql: string): Promise<number> => {
        const { rows } = await app.query<{ count: string }>(sql);
        return Number(rows[0]?.count);
      };

      return {
        branches: await one('SELECT count(*) AS count FROM branches'),
        memberships: await one('SELECT count(*) AS count FROM memberships'),
        roles: await one('SELECT count(*) AS count FROM membership_roles'),
        subscriptions: await one('SELECT count(*) AS count FROM subscriptions'),
      };
    });

    expect(counts).toEqual({ branches: 1, memberships: 1, roles: 1, subscriptions: 1 });
  });

  it('gives the owner ORG_OWNER across every branch, not just the first', async () => {
    const { rows } = await owner.query<{ code: string; branch_id: string | null }>(
      `SELECT r.code, mr.branch_id
       FROM membership_roles mr
       JOIN roles r ON r.id = mr.role_id
       WHERE mr.organization_id = $1`,
      [orgA.organizationId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('ORG_OWNER');
    // NULL = org-wide. A clinic that opens a second location must not need a
    // new grant for its own owner (ADR-0002).
    expect(rows[0]?.branch_id).toBeNull();
  });

  it('starts a trial with a period, since both period columns are NOT NULL', async () => {
    const { rows } = await owner.query<{
      status: string;
      trial_ends_at: Date | null;
      current_period_start: Date | null;
      current_period_end: Date | null;
    }>(
      `SELECT status, trial_ends_at, current_period_start, current_period_end
       FROM subscriptions WHERE organization_id = $1`,
      [orgA.organizationId]
    );

    expect(rows[0]?.status).toBe('TRIALING');
    expect(rows[0]?.trial_ends_at).not.toBeNull();
    expect(rows[0]?.current_period_start).not.toBeNull();
    expect(rows[0]?.current_period_end).not.toBeNull();
  });
});

describe('two registrations are isolated from each other', () => {
  it('shows each clinic only its own branch', async () => {
    const a = await asTenant(orgA.organizationId, [orgA.branchId], async () => {
      const { rows } = await app.query<{ id: string }>('SELECT id FROM branches');
      return rows.map((r) => r.id);
    });
    const b = await asTenant(orgB.organizationId, [orgB.branchId], async () => {
      const { rows } = await app.query<{ id: string }>('SELECT id FROM branches');
      return rows.map((r) => r.id);
    });

    expect(a).toEqual([orgA.branchId]);
    expect(b).toEqual([orgB.branchId]);
  });

  it('hides the other clinic’s membership even with the id in hand', async () => {
    const found = await asTenant(orgA.organizationId, [orgA.branchId], async () => {
      const { rows } = await app.query('SELECT id FROM memberships WHERE organization_id = $1', [
        orgB.organizationId,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('hides the other clinic’s subscription', async () => {
    const found = await asTenant(orgA.organizationId, [orgA.branchId], async () => {
      const { rows } = await app.query('SELECT id FROM subscriptions WHERE organization_id = $1', [
        orgB.organizationId,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('leaves nothing visible once the transaction ends', async () => {
    // The registration transaction set app.current_org with set_config(..., true),
    // so it reverted on COMMIT. If it had not, the next request to borrow this
    // pooled connection would inherit a tenant — the exact bug withTenant exists
    // to prevent.
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM branches');
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('registration refuses to collide', () => {
  it('rejects a slug that is already taken', async () => {
    await expect(registerOrganization(payload(SLUG_A, 'Copycat'))).rejects.toThrow(
      /subdomain is already taken/i
    );
  });

  it('rejects an email that already has an account', async () => {
    const duplicate = payload(`reg-c-${SUFFIX}`, 'Reg C');
    duplicate.owner.email = `${SLUG_A}@example.test`;

    await expect(registerOrganization(duplicate)).rejects.toThrow(/already exists/i);
  });
});

/**
 * A clinic outside India is billed in its own currency, everywhere.
 *
 * Both halves of this failed at once and neither threw. The country never
 * reached the API, so the column default made every clinic Indian; and the
 * subscription's own `currency` was left to ITS default, so even a clinic that
 * did register in Ireland — on a EUR price — carried a row saying INR. Every
 * billing read quotes from that row, so the whole billing screen came back in
 * rupees for a clinic in Dublin.
 */
describe('registration bills a clinic in its own currency', () => {
  const SLUG_IE = `reg-ie-${SUFFIX}`;
  let orgIE: { organizationId: string; ownerUserId: string };

  beforeAll(async () => {
    const input = payload(SLUG_IE, 'Reg IE');
    input.organization.countryCode = 'IE';
    input.organization.timezone = 'Europe/Dublin';
    // Deliberately absent: the server derives it from the country against the
    // prices the plan actually publishes. Sending one would prove nothing.
    delete (input.organization as { currency?: string }).currency;

    orgIE = await registerOrganization(input);
  }, 30_000);

  afterAll(async () => {
    if (orgIE) {
      await owner.query('DELETE FROM audit_logs WHERE organization_id = $1', [
        orgIE.organizationId,
      ]);
      await owner.query('DELETE FROM organizations WHERE id = $1', [orgIE.organizationId]);
      await owner.query('DELETE FROM users WHERE id = $1', [orgIE.ownerUserId]);
    }
  });

  it('stores the country and time zone it was given', async () => {
    const { rows } = await owner.query<{
      country_code: string;
      timezone: string;
      currency: string;
    }>('SELECT country_code, timezone, currency FROM organizations WHERE id = $1', [
      orgIE.organizationId,
    ]);

    expect(rows[0]?.country_code).toBe('IE');
    expect(rows[0]?.timezone).toBe('Europe/Dublin');
    expect(rows[0]?.currency).toBe('EUR');
  });

  it('puts that currency on the subscription row, not just on the price', async () => {
    const { rows } = await owner.query<{ currency: string; price_currency: string }>(
      `SELECT s.currency, pp.currency AS price_currency
       FROM subscriptions s
       JOIN plan_prices pp ON pp.id = s.plan_price_id
       WHERE s.organization_id = $1`,
      [orgIE.organizationId]
    );

    expect(rows[0]?.currency.trim()).toBe('EUR');
    expect(rows[0]?.price_currency.trim()).toBe('EUR');
  });
});
