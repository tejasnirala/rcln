/**
 * A super admin entering a clinic, over real HTTP.
 *
 * WHAT THIS SUITE IS GUARDING
 *   Impersonation is full access, deliberately (ADR-0012) — `authorize()`
 *   bypasses every permission check for a platform admin and always has. So
 *   nothing below is testing "can they do it": they can, and that is the design.
 *   What is under test is everything that makes that survivable:
 *
 *     1. Only a platform admin can start one, and the refusal is 404.
 *     2. A reason is required, and it reaches the clinic's own audit trail.
 *     3. The handoff ticket is single-use and bound to ONE clinic. A ticket for
 *        clinic A presented at clinic B's host must not work — that is the
 *        cross-tenant case, and the ticket is the only thing that crosses a host
 *        boundary anywhere in this product.
 *     4. Every write carries BOTH actor ids.
 *     5. The session cannot outlive its half hour, and nothing can renew it.
 *
 * TWO ORGANIZATIONS, for the same reason settings.test.ts uses two: a
 * single-tenant version of case 3 passes whether or not the check exists.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG_A = `imp-a-${SUFFIX}`;
const SLUG_B = `imp-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const ADMIN_EMAIL = `imp-admin-${SUFFIX}@example.test`;

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;
const ADMIN_HOST = `admin.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let adminUserId = '';
let adminToken = '';

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pvt Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
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

/**
 * Suites share one Redis, so a deliberate 429 in one is another's flake. Every
 * login and every claim clears the buckets first — see the PITFALLS entry on
 * `maxWorkers: 1`.
 */
async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function login(host: string, identifier: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', host)
    .send({ identifier, password: PASSWORD });
  if (!res.body.data?.accessToken) {
    throw new Error(`could not sign ${identifier} in: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

/** Ask for a ticket into `organizationId`, as the platform admin. */
async function ticketFor(organizationId: string, reason = 'Checking a report they say is empty') {
  return request(app)
    .post(`/api/v1/platform/organizations/${organizationId}/impersonate`)
    .set('Host', ADMIN_HOST)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ reason });
}

/** Spend a ticket at a clinic's own host, which is the only place it works. */
async function claimAt(slug: string, handoffToken: string) {
  await clearRateLimits();
  return request(app)
    .post('/api/v1/auth/impersonation/claim')
    .set('Host', hostFor(slug))
    .send({ handoffToken });
}

/** Start to finish: ticket, claim, access token. */
async function enter(slug: string, organizationId: string, reason?: string): Promise<string> {
  const granted = await ticketFor(organizationId, reason);
  if (granted.status !== 201) {
    throw new Error(`no ticket for ${slug}: ${JSON.stringify(granted.body)}`);
  }
  const claimed = await claimAt(slug, granted.body.data.handoffToken as string);
  if (claimed.status !== 201) {
    throw new Error(`could not claim at ${slug}: ${JSON.stringify(claimed.body)}`);
  }
  return claimed.body.data.accessToken as string;
}

const inside = (slug: string, token: string) => ({
  get: (path: string) =>
    request(app).get(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object = {}) =>
    request(app)
      .post(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  patch: (path: string, body: object = {}) =>
    request(app)
      .patch(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
});

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Imp A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Imp B'));

  /*
   * The platform admin is made by registering a throwaway clinic's owner and
   * then setting the flag — `is_platform_admin` has no endpoint, correctly, and
   * a super admin belongs to no organization in production. The membership left
   * behind is in neither A nor B, so it cannot accidentally supply a branch
   * scope in the clinics under test.
   */
  const adminOrg = await registerOrganization(payload(`imp-p-${SUFFIX}`, 'Imp Platform'));
  adminUserId = adminOrg.ownerUserId;
  await owner.query('UPDATE users SET is_platform_admin = true, email = $2 WHERE id = $1', [
    adminUserId,
    ADMIN_EMAIL,
  ]);

  adminToken = await login(ADMIN_HOST, ADMIN_EMAIL);
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId, adminUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
  }
  // The throwaway clinic the admin owns is not in `ids`; find it by slug.
  await owner?.query(
    'DELETE FROM audit_logs WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE $1)',
    [`imp-%-${SUFFIX}`]
  );
  await owner?.query('DELETE FROM organizations WHERE slug LIKE $1', [`imp-%-${SUFFIX}`]);
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('who may start one', () => {
  it('answers a clinic owner with 404, not 403', async () => {
    const ownerToken = await login(hostFor(SLUG_A), `${SLUG_A}@example.test`);

    const res = await request(app)
      .post(`/api/v1/platform/organizations/${orgB.organizationId}/impersonate`)
      .set('Host', ADMIN_HOST)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'I would quite like a look at the competition' });

    // 403 would confirm the console exists and that the route is real. The
    // clinic owner learns nothing.
    expect(res.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app)
      .post(`/api/v1/platform/organizations/${orgA.organizationId}/impersonate`)
      .set('Host', ADMIN_HOST)
      .send({ reason: 'Nothing in particular at all' });

    expect(res.status).toBe(401);
  });

  it('demands a reason, and demands a real one', async () => {
    expect((await ticketFor(orgA.organizationId, '')).status).toBe(400);
    // Ten characters is the floor because "test" is not a reason.
    expect((await ticketFor(orgA.organizationId, 'test')).status).toBe(400);
  });

  it('404s for a clinic that does not exist', async () => {
    const res = await ticketFor('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('issues a ticket naming the clinic, and no session', async () => {
    const res = await ticketFor(orgA.organizationId);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      organizationSlug: SLUG_A,
      organizationName: 'Imp A',
      expiresInSeconds: 120,
    });
    // A ticket, not a credential for anything: no tokens come back on this host.
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.handoffToken.length).toBeGreaterThan(32);
  });
});

describe('the handoff ticket', () => {
  it('is spent exactly once', async () => {
    const granted = await ticketFor(orgA.organizationId);
    const token = granted.body.data.handoffToken as string;

    expect((await claimAt(SLUG_A, token)).status).toBe(201);
    expect((await claimAt(SLUG_A, token)).status).toBe(401);
  });

  /**
   * The cross-tenant case, and the reason this suite registers two clinics.
   *
   * The organization is decided by the Host header before any credential is
   * read, and compared with the one fixed when the ticket was issued. Presenting
   * A's ticket at B fails — and it has been consumed by then, so retrying it at
   * A does not work either.
   */
  it('cannot be redeemed at a DIFFERENT clinic, and is burnt trying', async () => {
    const granted = await ticketFor(orgA.organizationId);
    const token = granted.body.data.handoffToken as string;

    expect((await claimAt(SLUG_B, token)).status).toBe(401);
    expect((await claimAt(SLUG_A, token)).status).toBe(401);
  });

  it('cannot be redeemed on a host with no tenant at all', async () => {
    const granted = await ticketFor(orgA.organizationId);

    await clearRateLimits();
    const res = await request(app)
      .post('/api/v1/auth/impersonation/claim')
      .set('Host', ROOT)
      .send({ handoffToken: granted.body.data.handoffToken });

    expect(res.status).toBe(404);
  });

  it('rejects a token that was never issued', async () => {
    expect((await claimAt(SLUG_A, 'a'.repeat(43))).status).toBe(401);
  });

  it('stops working the moment the flag is withdrawn', async () => {
    const granted = await ticketFor(orgA.organizationId);
    await owner.query('UPDATE users SET is_platform_admin = false WHERE id = $1', [adminUserId]);

    try {
      // Checked at redemption, not trusted from the ticket — this is the only
      // moment between issuing and a live session inside somebody's clinic.
      expect((await claimAt(SLUG_A, granted.body.data.handoffToken)).status).toBe(401);
    } finally {
      await owner.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [adminUserId]);
    }
  });
});

describe('the session it buys', () => {
  it('lands inside the clinic with a real branch scope', async () => {
    const token = await enter(SLUG_A, orgA.organizationId);
    const A = inside(SLUG_A, token);

    /*
     * `branches` is the check that matters. The admin holds no membership here,
     * so `loadUserAccess` returns null — and `branch_isolation` is RESTRICTIVE,
     * so an empty scope would answer 200 with an empty list and look like an
     * empty clinic rather than a broken one.
     */
    const branches = await A.get('/api/v1/branches');
    expect(branches.status).toBe(200);
    expect(branches.body.data.branches.length).toBeGreaterThan(0);

    const members = await A.get('/api/v1/members');
    expect(members.status).toBe(200);
    expect(members.body.data.members.length).toBeGreaterThan(0);
  });

  it('reports the banner, the clinic, and no membership', async () => {
    const granted = await ticketFor(orgA.organizationId);
    const claimed = await claimAt(SLUG_A, granted.body.data.handoffToken);

    expect(claimed.body.data.impersonation).toMatchObject({
      organizationName: 'Imp A',
      adminName: 'Imp Platform Owner',
    });
    expect(claimed.body.data.activeOrganizationId).toBe(orgA.organizationId);
    expect(claimed.body.data.activeBranchId).not.toBeNull();
    // Their OWN memberships, which is what the field means everywhere else.
    expect(
      claimed.body.data.memberships.some(
        (m: { organizationId: string }) => m.organizationId === orgA.organizationId
      )
    ).toBe(false);
  });

  it('reports the whole permission catalogue, matching what authorize allows', async () => {
    const token = await enter(SLUG_A, orgA.organizationId);
    const session = await inside(SLUG_A, token).get('/api/v1/auth/session');

    // `can` returns true for a platform admin before it looks at anything else.
    // An empty list here would make the shell hide controls the API allows.
    expect(session.body.data.permissions).toContain('patient.read');
    expect(session.body.data.permissions).toContain('organization.update');
    expect(session.body.data.impersonation.organizationName).toBe('Imp A');
  });

  it('hands back NO refresh token, and expires in thirty minutes', async () => {
    const granted = await ticketFor(orgA.organizationId);
    const claimed = await claimAt(SLUG_A, granted.body.data.handoffToken);

    expect(claimed.body.data.refreshToken).toBe('');
    expect(claimed.body.data.expiresIn).toBe(1800);

    const row = await owner.query(
      `SELECT round(extract(epoch FROM (expires_at - created_at))) AS ttl,
              impersonated_by_user_id, user_id
         FROM sessions
        WHERE impersonated_by_user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [adminUserId]
    );
    // 30 minutes, not the 30 days an ordinary session gets.
    expect(Number(row.rows[0].ttl)).toBe(1800);
    // The admin acts as themselves; the second id is what marks the session.
    expect(row.rows[0].impersonated_by_user_id).toBe(row.rows[0].user_id);
  });

  it('is dead once the row expires, whatever the token says', async () => {
    const token = await enter(SLUG_A, orgA.organizationId);
    expect((await inside(SLUG_A, token).get('/api/v1/branches')).status).toBe(200);

    // The JWT is still perfectly valid for another half hour. The session row is
    // the revocation list, and it is the only thing bounding this session.
    await owner.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
        WHERE impersonated_by_user_id = $1 AND revoked_at IS NULL`,
      [adminUserId]
    );

    expect((await inside(SLUG_A, token).get('/api/v1/branches')).status).toBe(401);
  });
});

describe('the audit trail, which is the only control', () => {
  it('files the entry against the CLINIC, with the reason', async () => {
    const reason = `Ticket RCL-${SUFFIX}: the revenue report renders empty`;
    await enter(SLUG_A, orgA.organizationId, reason);

    const rows = await owner.query(
      `SELECT actor_user_id, impersonated_by_user_id, after_data
         FROM audit_logs
        WHERE organization_id = $1 AND action = 'IMPERSONATE' AND after_data IS NOT NULL
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows.rows[0].actor_user_id).toBe(adminUserId);
    expect(rows.rows[0].impersonated_by_user_id).toBe(adminUserId);
    expect(rows.rows[0].after_data.reason).toBe(reason);
  });

  it('stamps both ids on an ordinary write made under impersonation', async () => {
    const token = await enter(SLUG_A, orgA.organizationId);

    const updated = await inside(SLUG_A, token).patch('/api/v1/organization', {
      legalName: 'Imp A Healthcare Pvt Ltd',
    });
    expect(updated.status).toBe(200);

    const rows = await owner.query(
      `SELECT actor_user_id, impersonated_by_user_id, before_data, after_data
         FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'organization' AND action = 'UPDATE'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    // Both, off the TenantContext, without organization.service knowing that
    // impersonation exists at all.
    expect(rows.rows[0].actor_user_id).toBe(adminUserId);
    expect(rows.rows[0].impersonated_by_user_id).toBe(adminUserId);
    expect(rows.rows[0].after_data).toEqual({ legalName: 'Imp A Healthcare Pvt Ltd' });
  });

  it('leaves nothing in the other clinic', async () => {
    const rows = await owner.query(
      "SELECT count(*) FROM audit_logs WHERE organization_id = $1 AND action = 'IMPERSONATE'",
      [orgB.organizationId]
    );
    expect(rows.rows[0].count).toBe('0');
  });
});

describe('leaving', () => {
  it('revokes the session and files the closing row', async () => {
    const token = await enter(SLUG_A, orgA.organizationId);
    const A = inside(SLUG_A, token);

    const stopped = await A.post('/api/v1/auth/impersonation/stop');
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toEqual({ stopped: true });

    // Revoked server-side, so the token is dead even though the browser is the
    // only thing that threw the cookie away.
    expect((await A.get('/api/v1/branches')).status).toBe(401);
    expect((await A.post('/api/v1/auth/impersonation/stop')).status).toBe(401);

    const rows = await owner.query(
      `SELECT before_data FROM audit_logs
        WHERE organization_id = $1 AND action = 'IMPERSONATE' AND before_data IS NOT NULL
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );
    expect(rows.rows[0].before_data).toEqual({ impersonating: true });
  });

  it('is not a second name for sign out — an ordinary member gets 404', async () => {
    const memberToken = await login(hostFor(SLUG_A), `${SLUG_A}@example.test`);

    const res = await request(app)
      .post('/api/v1/auth/impersonation/stop')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(404);

    // And their session is untouched — this must not become a logout by stealth.
    const still = await request(app)
      .get('/api/v1/auth/session')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${memberToken}`);
    expect(still.status).toBe(200);
    expect(still.body.data.impersonation).toBeNull();
  });
});
