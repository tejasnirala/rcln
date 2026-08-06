/**
 * Authentication over real HTTP, through the real middleware chain.
 *
 * The chain IS the security model — resolveTenant, then authenticate, then
 * authorize — and the cases that matter most are the ones where it must refuse:
 * a token minted for one clinic presented to another, and every flavour of bad
 * credential looking identical to every other.
 *
 * Uses supertest against the real app with real Postgres. The Host header is
 * what selects the tenant, exactly as a browser would.
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
const SLUG_A = `auth-a-${SUFFIX}`;
const SLUG_B = `auth-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };

const emailFor = (slug: string): string => `${slug}@example.test`;

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
      email: emailFor(slug),
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

/** The rate limiters are Redis-backed and shared, so a busy suite trips them. */
async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function login(slug: string, body: Record<string, unknown>) {
  await clearRateLimits();
  return request(app).post('/api/v1/auth/login').set('Host', hostFor(slug)).send(body);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Auth A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Auth B'));
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

beforeEach(async () => {
  // Lockout is per-user and persists between tests, so the lockout case would
  // otherwise poison every test after it. Scoped to this suite's own users:
  // jest runs suites in parallel workers against one database, and an
  // unqualified UPDATE here would reach into whatever a sibling suite is doing.
  await owner.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ANY($1)',
    [[orgA.ownerUserId, orgB.ownerUserId]]
  );
  await clearRateLimits();
});

describe('POST /auth/login', () => {
  it('signs the owner in and resolves their permissions', async () => {
    const res = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.activeOrganizationId).toBe(orgA.organizationId);
    expect(res.body.data.activeBranchId).toBe(orgA.branchId);
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    // Resolved per request from membership_roles, never carried in the JWT.
    expect(res.body.data.permissions.length).toBeGreaterThan(50);
    expect(res.body.data.permissions).toContain('branch.create');

    // The identity bootstrap that own_membership exists for.
    expect(res.body.data.memberships).toHaveLength(1);
    expect(res.body.data.memberships[0].organizationSlug).toBe(SLUG_A);
    expect(res.body.data.memberships[0].roles).toEqual(['ORG_OWNER']);
  });

  it('never returns the password hash', async () => {
    const res = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: PASSWORD });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/i);
  });

  it('rejects a wrong password', async () => {
    const res = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: 'WrongPassword123' });
    expect(res.status).toBe(401);
  });

  it('gives an unknown identifier the same answer as a wrong password', async () => {
    const unknown = await login(SLUG_A, {
      identifier: 'nobody@example.test',
      password: 'WrongPassword123',
    });
    const wrong = await login(SLUG_A, {
      identifier: emailFor(SLUG_A),
      password: 'WrongPassword123',
    });

    // Any difference here is a user-enumeration oracle.
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('gives a real user at the wrong clinic the same answer too', async () => {
    // A's owner has no membership in B. Saying so would let anyone with an
    // account test which clinics a colleague works at.
    const res = await login(SLUG_B, { identifier: emailFor(SLUG_A), password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/not valid/i);
  });

  it('locks the account after five failures, then refuses the correct password', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login(SLUG_A, { identifier: emailFor(SLUG_A), password: 'WrongPassword123' });
    }

    const res = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/locked/i);
  });

  it('rejects a malformed body before touching the database', async () => {
    const res = await login(SLUG_A, { identifier: 'not-an-email-or-phone', password: '' });
    expect(res.status).toBe(400);
  });
});

describe('the tenant boundary', () => {
  let tokenA: string;

  beforeEach(async () => {
    const res = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: PASSWORD });
    tokenA = res.body.data.accessToken;
  });

  it('accepts the token on its own clinic', async () => {
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.activeOrganizationId).toBe(orgA.organizationId);
  });

  it('answers 404 — never 403 — for that token on another clinic', async () => {
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Host', hostFor(SLUG_B))
      .set('Authorization', `Bearer ${tokenA}`);

    // 403 would confirm the subdomain exists, letting a holder of any valid
    // token walk the customer list one guess at a time.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('answers 401 with no token', async () => {
    const res = await request(app).get('/api/v1/auth/session').set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });

  it('answers 401 for a forged token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
  });

  it('answers 401 once the session is revoked, even though the JWT is still valid', async () => {
    await request(app)
      .post('/api/v1/auth/logout')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    // The access token has not expired. The session row is the revocation list,
    // and checking it is what makes signing out mean anything.
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(401);
  });
});

describe('the platform console', () => {
  it('hides itself from a clinic account', async () => {
    const login1 = await login(SLUG_A, { identifier: emailFor(SLUG_A), password: PASSWORD });

    const res = await request(app)
      .get('/api/v1/platform/demo-requests')
      .set('Host', `admin.${ROOT}`)
      .set('Authorization', `Bearer ${login1.body.data.accessToken}`);

    // 404, not 403 — a caller who may not use the console is not told it exists.
    expect(res.status).toBe(404);
  });

  it('requires authentication at all', async () => {
    const res = await request(app)
      .get('/api/v1/platform/demo-requests')
      .set('Host', `admin.${ROOT}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/otp/request', () => {
  it('answers identically for a known and an unknown number', async () => {
    const known = await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Host', hostFor(SLUG_A))
      .send({ phone: '+919876543210' });

    await clearRateLimits();

    const unknown = await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Host', hostFor(SLUG_A))
      .send({ phone: '+919000000001' });

    expect(known.status).toBe(unknown.status);
    expect(known.body.message).toBe(unknown.body.message);
  });

  it('rejects a number that is not E.164', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Host', hostFor(SLUG_A))
      .send({ phone: '9876543210' });

    expect(res.status).toBe(400);
  });
});

describe('public registration over HTTP', () => {
  it('reports an available slug, and a taken one', async () => {
    await clearRateLimits();
    const free = await request(app).get(
      `/api/v1/public/organizations/check-slug?slug=never-taken-${SUFFIX}`
    );
    expect(free.body.data.available).toBe(true);

    const taken = await request(app).get(`/api/v1/public/organizations/check-slug?slug=${SLUG_A}`);
    expect(taken.body.data.available).toBe(false);

    // Only a boolean — no name, no status, no "taken by whom".
    expect(Object.keys(taken.body.data).sort()).toEqual(['available', 'slug']);
  });

  it('refuses a reserved subdomain', async () => {
    await clearRateLimits();
    const res = await request(app).get('/api/v1/public/organizations/check-slug?slug=admin');
    expect(res.status).toBe(400);
  });
});

/**
 * Who a rate limit applies to.
 *
 * Both cases here were broken in a way nothing else would catch: the API only
 * ever saw the BFF's address, because every call from the web app is
 * server-to-server and `trust proxy` was off outside production. One bucket
 * covered every user of every clinic, and `authLimiter` allows ten requests per
 * fifteen minutes — so the eleventh person to sign in anywhere on the platform
 * was told their password was wrong. supertest connects directly and looks like
 * a distinct client, which is exactly why the existing suite stayed green.
 */
describe('rate limits are attributed to the right party', () => {
  const spraySubject = `spray-${SUFFIX}@example.test`;

  beforeEach(async () => {
    await clearRateLimits();
  });

  it('bills two clients at the same proxy to separate address budgets', async () => {
    // Eleven attempts from one address exhausts authLimiter (max 10)...
    for (let i = 0; i < 11; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .set('Host', hostFor(SLUG_A))
        .set('X-Forwarded-For', '203.0.113.1')
        .send({ identifier: `a${String(i)}-${SUFFIX}@example.test`, password: PASSWORD });
    }

    const exhausted = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', hostFor(SLUG_A))
      .set('X-Forwarded-For', '203.0.113.1')
      .send({ identifier: emailFor(SLUG_A), password: PASSWORD });
    expect(exhausted.status).toBe(429);

    // ...and leaves a different client completely unaffected. Before the fix
    // both collapsed onto the web container's address and this was a 429.
    const neighbour = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', hostFor(SLUG_A))
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ identifier: emailFor(SLUG_A), password: PASSWORD });
    expect(neighbour.status).toBe(200);
  });

  it('caps attempts on one account even when every attempt comes from a new address', async () => {
    /*
     * A password spray: one guess per address, so the per-address budget is
     * never approached. identityLimiter is the only thing that sees the pattern.
     * The subject deliberately does not exist — this must be about the limiter,
     * not about the account lockout in password.service.ts.
     */
    const attempt = (address: string) =>
      request(app)
        .post('/api/v1/auth/login')
        .set('Host', hostFor(SLUG_A))
        .set('X-Forwarded-For', address)
        .send({ identifier: spraySubject, password: 'WrongGuess123' });

    for (let i = 1; i <= 10; i += 1) {
      const res = await attempt(`198.51.100.${String(i)}`);
      // Every one of these is a fresh address, so only the credential check
      // rejects them. A 429 here would mean the addresses are collapsing.
      expect(res.status).toBe(401);
    }

    const eleventh = await attempt('198.51.100.11');
    expect(eleventh.status).toBe(429);
    // Says nothing about whether the account exists.
    expect(eleventh.body.message).not.toMatch(/exist|found|unknown/i);
  });

  it('does not make colleagues at one address share an account budget', async () => {
    const one = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', hostFor(SLUG_A))
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ identifier: `colleague-one-${SUFFIX}@example.test`, password: 'WrongGuess123' });

    const two = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', hostFor(SLUG_A))
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ identifier: `colleague-two-${SUFFIX}@example.test`, password: 'WrongGuess123' });

    // One clinic behind one office NAT: the address budget is shared by design,
    // but one person's typos must not spend another's.
    expect(one.status).toBe(401);
    expect(two.status).toBe(401);
    expect(await redis.get(`rl:identity:colleague-one-${SUFFIX}@example.test`)).toBe('1');
    expect(await redis.get(`rl:identity:colleague-two-${SUFFIX}@example.test`)).toBe('1');
  });
});
