/**
 * Email and phone verification over real HTTP, through the real middleware chain.
 *
 * Three things are being pinned down here beyond "the code works".
 *
 *   1. `users` is RLS-EXEMPT. Nothing in Postgres narrows these writes — the
 *      `where id = :userId` in verification.service.ts is the entire isolation
 *      story, so the cross-account cases below are testing the only guard there
 *      is, not a second line of defence.
 *   2. `phone_verified_at` is ALSO set by OTP login. Confirming afterwards has to
 *      succeed, must not move the timestamp, and must not file a second audit
 *      row. That sequence is run for real here rather than simulated.
 *   3. The code is stored as a digest and returned exactly once, to the sender.
 *      A test cannot read it back — so the request path runs for real and then
 *      the digest is replaced with that of a known code, using the same
 *      `hashOtpCode` the service uses. Everything either side of that line is
 *      production code.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { hashOtpCode } from '../../src/services/auth/token.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `v${Date.now().toString(36)}`;
const SLUG_A = `vf-a-${SUFFIX}`;
const SLUG_B = `vf-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const KNOWN_CODE = '424242';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let tokenA: string;
let tokenB: string;
let phoneA: string;
let phoneB: string;

function payload(slug: string, label: string, phone: string) {
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
      phone,
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
  return res.body.data.accessToken as string;
}

const as = (slug: string, token: string) => ({
  post: (path: string, body?: object) =>
    request(app)
      .post(`/api/v1/auth${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {}),
});

let A: ReturnType<typeof as>;
let B: ReturnType<typeof as>;

/**
 * Replace the digest on the newest live token with that of a code we know.
 *
 * The plaintext leaves the service only through the sender, so this is the one
 * way an HTTP-level test can present a valid code. It uses the production
 * hashing function, so a change to `hashOtpCode` breaks this the same way it
 * would break the real flow.
 */
async function plantCode(userId: string, purpose: string, code = KNOWN_CODE): Promise<void> {
  const { rowCount } = await owner.query(
    `UPDATE auth_tokens SET code_hash = $1
      WHERE id = (
        SELECT id FROM auth_tokens
         WHERE user_id = $2 AND purpose::text = $3 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1)`,
    [hashOtpCode(code), userId, purpose]
  );
  if (rowCount !== 1) throw new Error(`no live ${purpose} token to plant a code on`);
}

async function verifiedAt(userId: string): Promise<{ email: Date | null; phone: Date | null }> {
  const { rows } = await owner.query<{
    email_verified_at: Date | null;
    phone_verified_at: Date | null;
  }>('SELECT email_verified_at, phone_verified_at FROM users WHERE id = $1', [userId]);
  return { email: rows[0]?.email_verified_at ?? null, phone: rows[0]?.phone_verified_at ?? null };
}

async function auditRows(
  userId: string
): Promise<
  {
    organization_id: string | null;
    before_data: Record<string, unknown>;
    after_data: Record<string, unknown>;
  }[]
> {
  const { rows } = await owner.query(
    `SELECT organization_id, before_data, after_data FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = $1 ORDER BY occurred_at`,
    [userId]
  );
  return rows;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  phoneA = `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  phoneB = `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  orgA = await registerOrganization(payload(SLUG_A, 'Verify A', phoneA));
  orgB = await registerOrganization(payload(SLUG_B, 'Verify B', phoneB));

  tokenA = await tokenFor(SLUG_A);
  tokenB = await tokenFor(SLUG_B);
  A = as(SLUG_A, tokenA);
  B = as(SLUG_B, tokenB);
}, 30_000);

beforeEach(clearRateLimits);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
    await owner?.query('DELETE FROM auth_tokens WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('the guard on the routes', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify/email/request')
      .set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });

  it('refuses an unauthenticated confirm', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify/email/confirm')
      .set('Host', hostFor(SLUG_A))
      .send({ code: KNOWN_CODE });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed code before touching the database', async () => {
    const res = await A.post('/verify/email/confirm', { code: 'abcdef' });
    expect(res.status).toBe(400);
  });
});

describe('requesting a code', () => {
  it('registration leaves both channels unverified', async () => {
    const at = await verifiedAt(orgA.ownerUserId);
    expect(at.email).toBeNull();
    expect(at.phone).toBeNull();
  });

  it('issues a VERIFY_EMAIL token and never returns the code', async () => {
    const res = await A.post('/verify/email/request');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sent: true, alreadyVerified: false });
    expect(res.body.data.expiresInSeconds).toBeGreaterThan(0);
    // Whatever else the envelope carries, it is not the credential.
    expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);

    const { rows } = await owner.query<{ code_hash: string; attempts: number }>(
      `SELECT code_hash, attempts FROM auth_tokens
        WHERE user_id = $1 AND purpose::text = 'VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1`,
      [orgA.ownerUserId]
    );
    expect(rows).toHaveLength(1);
    // Stored as a digest: a dump of this table is not a set of usable codes.
    expect(rows[0]?.code_hash).toHaveLength(64);
    expect(rows[0]?.attempts).toBe(0);
  });
});

describe('confirming', () => {
  it('counts a wrong code against the attempt cap and says nothing useful', async () => {
    await plantCode(orgA.ownerUserId, 'VERIFY_EMAIL');

    const res = await A.post('/verify/email/confirm', { code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('That code is not valid or has expired.');

    const { rows } = await owner.query<{ attempts: number }>(
      `SELECT attempts FROM auth_tokens
        WHERE user_id = $1 AND purpose::text = 'VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1`,
      [orgA.ownerUserId]
    );
    expect(rows[0]?.attempts).toBe(1);

    // Nothing was verified by a failed attempt.
    expect((await verifiedAt(orgA.ownerUserId)).email).toBeNull();
  });

  it('another account cannot redeem this one’s code', async () => {
    // B holds a real session and presents A's code. The identifiers differ, so
    // the lookup misses — the cheap half of the boundary.
    const res = await B.post('/verify/email/confirm', { code: KNOWN_CODE });

    expect(res.status).toBe(401);
    expect((await verifiedAt(orgA.ownerUserId)).email).toBeNull();
    expect((await verifiedAt(orgB.ownerUserId)).email).toBeNull();
  });

  it('will not redeem a token that carries the right identifier but another user', async () => {
    /**
     * The case the `userId` pin in confirmVerification exists for, staged.
     *
     * `auth_tokens.identifier` carries NO uniqueness constraint of its own, so
     * "the newest live row for this address" is not by itself "a code issued to
     * this person". A row belonging to A but naming B's address is reachable in
     * production the moment an address is freed by a soft-deleted account and
     * taken by a new one.
     *
     * Without the pin B verifies their own email off a code that was never sent
     * to them — measured, not assumed: deleting `userId` from the
     * consumeChallenge call makes this return 200.
     */
    await owner.query(
      // `id` is generated by Prisma, not by a column default, so it is supplied.
      `INSERT INTO auth_tokens (id, user_id, purpose, identifier, code_hash, expires_at)
       VALUES (gen_random_uuid(), $1, 'VERIFY_EMAIL', $2, $3, now() + interval '15 minutes')`,
      [orgA.ownerUserId, `${SLUG_B}@example.test`, hashOtpCode(KNOWN_CODE)]
    );

    const res = await B.post('/verify/email/confirm', { code: KNOWN_CODE });

    expect(res.status).toBe(401);
    expect((await verifiedAt(orgB.ownerUserId)).email).toBeNull();
  });

  it('accepts the right code, stamps the column and audits both sides', async () => {
    const res = await A.post('/verify/email/confirm', { code: KNOWN_CODE });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, alreadyVerified: false });
    expect((await verifiedAt(orgA.ownerUserId)).email).not.toBeNull();

    const rows = await auditRows(orgA.ownerUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(orgA.organizationId);
    expect(rows[0]?.before_data).toEqual({ emailVerifiedAt: null });
    expect(rows[0]?.after_data).toHaveProperty('emailVerifiedAt');
  });

  it('refuses the same code a second time — single use', async () => {
    const res = await A.post('/verify/email/confirm', { code: KNOWN_CODE });
    expect(res.status).toBe(401);
  });

  it('sends nothing once the channel is verified', async () => {
    const before = await owner.query(
      `SELECT count(*) FROM auth_tokens WHERE user_id = $1 AND purpose::text = 'VERIFY_EMAIL'`,
      [orgA.ownerUserId]
    );

    const res = await A.post('/verify/email/request');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: false, alreadyVerified: true, expiresInSeconds: 0 });

    const after = await owner.query(
      `SELECT count(*) FROM auth_tokens WHERE user_id = $1 AND purpose::text = 'VERIFY_EMAIL'`,
      [orgA.ownerUserId]
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe('the attempt cap', () => {
  it('burns the token after OTP_MAX_ATTEMPTS, so the right code no longer works', async () => {
    await A.post('/verify/phone/request');
    await plantCode(orgA.ownerUserId, 'VERIFY_PHONE');

    const max = Number.parseInt(process.env['OTP_MAX_ATTEMPTS'] ?? '5', 10);
    for (let i = 0; i < max; i += 1) {
      await clearRateLimits();
      const res = await A.post('/verify/phone/confirm', { code: '000001' });
      expect(res.status).toBe(401);
    }

    await clearRateLimits();
    const res = await A.post('/verify/phone/confirm', { code: KNOWN_CODE });
    expect(res.status).toBe(401);
    expect((await verifiedAt(orgA.ownerUserId)).phone).toBeNull();
  });
});

describe('idempotency with OTP login', () => {
  /**
   * The hazard the plan flagged: signing in with a code already proves control
   * of the handset, so `phone_verified_at` can be set by a path that has nothing
   * to do with this flow. A verification code minted before that must then
   * succeed rather than error, leave the earlier timestamp alone, and file no
   * audit row — nothing changed.
   */
  it('a code confirmed after an OTP login succeeds without moving the timestamp', async () => {
    await A.post('/verify/phone/request');
    await plantCode(orgA.ownerUserId, 'VERIFY_PHONE');

    // A real OTP login, which is what sets the column behind our back.
    await clearRateLimits();
    await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Host', hostFor(SLUG_A))
      .send({ phone: phoneA });
    await plantCode(orgA.ownerUserId, 'LOGIN_OTP', '135790');

    const login = await request(app)
      .post('/api/v1/auth/otp/verify')
      .set('Host', hostFor(SLUG_A))
      .send({ phone: phoneA, code: '135790' });
    expect(login.status).toBe(200);

    const stamped = (await verifiedAt(orgA.ownerUserId)).phone;
    expect(stamped).not.toBeNull();
    const auditBefore = (await auditRows(orgA.ownerUserId)).length;

    await clearRateLimits();
    const res = await A.post('/verify/phone/confirm', { code: KNOWN_CODE });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, alreadyVerified: true });
    // The first proof is the one that happened; this must not overwrite it.
    expect((await verifiedAt(orgA.ownerUserId)).phone).toEqual(stamped);
    // And nothing changed, so there is nothing to record.
    expect(await auditRows(orgA.ownerUserId)).toHaveLength(auditBefore);
  });
});

describe('the development master code', () => {
  /**
   * A backdoor exists only while no sender does, so it is pinned on both sides:
   * it confirms a channel, and it does not log anybody in.
   */
  const MASTER = process.env['DEV_MASTER_VERIFICATION_CODE'] ?? '123456';

  it('confirms a channel without a code ever having been requested', async () => {
    // B has never called /verify/email/request, so there is no live token at all.
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) FROM auth_tokens WHERE user_id = $1 AND purpose::text = 'VERIFY_EMAIL'`,
      [orgB.ownerUserId]
    );
    expect(rows[0]?.count).toBe('0');

    const res = await B.post('/verify/email/confirm', { code: MASTER });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, alreadyVerified: false });
    expect((await verifiedAt(orgB.ownerUserId)).email).not.toBeNull();
  });

  it('still writes the audit row, so a master-code confirmation is not invisible', async () => {
    const rows = await auditRows(orgB.ownerUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before_data).toEqual({ emailVerifiedAt: null });
  });

  it('does NOT sign anyone in, even with a live login token waiting', async () => {
    // A real LOGIN_OTP is issued first, so the lookup has something to find.
    // Without that, a 401 would prove nothing.
    await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Host', hostFor(SLUG_B))
      .send({ phone: phoneB });

    const live = await owner.query(
      `SELECT 1 FROM auth_tokens
        WHERE user_id = $1 AND purpose::text = 'LOGIN_OTP' AND consumed_at IS NULL`,
      [orgB.ownerUserId]
    );
    expect(live.rowCount).toBe(1);

    await clearRateLimits();
    const res = await request(app)
      .post('/api/v1/auth/otp/verify')
      .set('Host', hostFor(SLUG_B))
      .send({ phone: phoneB, code: MASTER });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('That code is not valid or has expired.');
  });
});

describe('an account with nothing to verify', () => {
  it('refuses to send when the channel is empty, and says which field to fill', async () => {
    // Runs last: B's phone is removed to reach this branch.
    await owner.query('UPDATE users SET phone = NULL WHERE id = $1', [orgB.ownerUserId]);

    const res = await B.post('/verify/phone/request');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Add a phone number first.');
  });
});
