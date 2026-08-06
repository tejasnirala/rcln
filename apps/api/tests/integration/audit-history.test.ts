/**
 * A record's history over real HTTP, through the real middleware chain.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *   Not "the endpoint returns rows". `audit_logs` is the trail that ADR-0012 rests
 *   on — it is the only control over a platform admin who can enter any clinic and
 *   change anything — so what matters is that reading it cannot become a way to
 *   read somebody else's:
 *
 *     1. The trail for a record in clinic B is invisible from clinic A, and
 *        indistinguishable from a record that does not exist. An id is not a
 *        capability.
 *     2. `audit.record.read` is required, and its absence is a 403 rather than an
 *        empty list — an empty list is how a permissions bug goes unnoticed.
 *     3. Actor names are resolved on the way out (the row stores an id only), and
 *        the join to the RLS-exempt `users` table cannot be steered by the caller.
 *     4. The diff is field-level and reflects what actually moved.
 *
 * The append-only guarantee is measured in `tenant-isolation.test.ts`, at the
 * database, because that is the layer that enforces it.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `h${Date.now().toString(36)}`;
const SLUG_A = `hist-a-${SUFFIX}`;
const SLUG_B = `hist-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let tokenA: string;
let tokenB: string;

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
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function tokenFor(slug: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier: `${slug}@example.test`, password: PASSWORD });
  if (!res.body.data?.accessToken) {
    throw new Error(`could not sign in at ${slug}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

const historyOf = (slug: string, token: string, entityType: string, entityId: string) =>
  request(app)
    .get('/api/v1/audit')
    .query({ entityType, entityId })
    .set('Host', hostFor(slug))
    .set('Authorization', `Bearer ${token}`);

const patchBranch = (slug: string, token: string, branchId: string, body: object) =>
  request(app)
    .patch(`/api/v1/branches/${branchId}`)
    .set('Host', hostFor(slug))
    .set('Authorization', `Bearer ${token}`)
    .send(body);

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'History A'));
  orgB = await registerOrganization(payload(SLUG_B, 'History B'));

  tokenA = await tokenFor(SLUG_A);
  tokenB = await tokenFor(SLUG_B);

  // A real change, made through the real endpoint, so the row under test is one
  // `recordAudit` wrote rather than one this file invented.
  const renamed = await patchBranch(SLUG_A, tokenA, orgA.branchId, { city: 'Pune' });
  if (renamed.status !== 200) {
    throw new Error(`could not edit the branch: ${JSON.stringify(renamed.body)}`);
  }
}, 30_000);

afterAll(async () => {
  for (const org of [orgA, orgB]) {
    if (!org) continue;
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('reading a record’s history', () => {
  it('returns the change that was just made, field by field', async () => {
    const res = await historyOf(SLUG_A, tokenA, 'branch', orgA.branchId);

    expect(res.status).toBe(200);
    expect(res.body.data.entityId).toBe(orgA.branchId);

    const update = res.body.data.entries.find(
      (entry: { action: string }) => entry.action === 'UPDATE'
    );
    expect(update).toBeDefined();

    const city = update.changes.find((c: { field: string }) => c.field === 'city');
    expect(city.after).toBe('Pune');
  });

  it('names the actor, which the row itself does not store', async () => {
    const res = await historyOf(SLUG_A, tokenA, 'branch', orgA.branchId);
    const update = res.body.data.entries.find(
      (entry: { action: string }) => entry.action === 'UPDATE'
    );

    // `audit_logs` holds `actor_user_id` and nothing else about the person —
    // CONVENTIONS.md forbids re-storing PII on the row — so a name here proves the
    // join happened rather than that it was copied at write time.
    expect(update.actor.id).toBe(orgA.ownerUserId);
    expect(update.actor.fullName).toBe('History A Owner');
  });

  it('reports no impersonator for an ordinary change', async () => {
    const res = await historyOf(SLUG_A, tokenA, 'branch', orgA.branchId);
    const update = res.body.data.entries.find(
      (entry: { action: string }) => entry.action === 'UPDATE'
    );

    // `claimImpersonation` sets actor and impersonator to the SAME id (ADR-0012 —
    // the admin acts as themselves), so a naive implementation reports "changed by
    // X on behalf of X" on every row. This is the ordinary case: null.
    expect(update.onBehalfOf).toBeNull();
  });

  /**
   * THE CROSS-TENANT CASE, and the reason this suite registers two clinics.
   *
   * A single-tenant version of this passes whether or not the isolation exists.
   */
  it('shows clinic B nothing of clinic A’s record, even given the id', async () => {
    const res = await historyOf(SLUG_B, tokenB, 'branch', orgA.branchId);

    // 200 with an empty list, NOT 404 or 403: the answer for another tenant's id
    // has to be identical to the answer for an id that was never real, or this
    // endpoint becomes a way to test whether a given id exists somewhere.
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
  });

  it('answers the same way for an id that never existed', async () => {
    const res = await historyOf(SLUG_A, tokenA, 'branch', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
  });

  it('refuses a caller without audit.record.read, with 403 not an empty list', async () => {
    /*
     * The owner holds every non-platform permission, so the code is taken away at
     * the source: a DENY override beats every grant (ADR-0002 and the resolver's
     * precedence), and the access cache is dropped so the next request re-resolves.
     */
    const membership = await owner.query<{ id: string }>(
      `SELECT id FROM memberships WHERE user_id = $1 AND organization_id = $2`,
      [orgA.ownerUserId, orgA.organizationId]
    );

    await owner.query(
      `INSERT INTO membership_permission_overrides
         (id, membership_id, organization_id, permission_id, effect, reason)
       SELECT gen_random_uuid(), $1, $2, p.id, 'DENY', 'audit history test'
         FROM permissions p WHERE p.code = 'audit.record.read'`,
      [membership.rows[0]?.id, orgA.organizationId]
    );

    const keys = await redis.keys('access:*');
    if (keys.length > 0) await redis.del(...keys);

    try {
      const res = await historyOf(SLUG_A, tokenA, 'branch', orgA.branchId);
      expect(res.status).toBe(403);
    } finally {
      await owner.query(
        `DELETE FROM membership_permission_overrides
          WHERE membership_id = $1 AND reason = 'audit history test'`,
        [membership.rows[0]?.id]
      );
      const after = await redis.keys('access:*');
      if (after.length > 0) await redis.del(...after);
    }
  });

  it('rejects a malformed entity id before it reaches the database', async () => {
    const res = await historyOf(SLUG_A, tokenA, 'branch', 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app)
      .get('/api/v1/audit')
      .query({ entityType: 'branch', entityId: orgA.branchId })
      .set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });
});
