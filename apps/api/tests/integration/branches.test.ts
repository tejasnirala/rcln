/**
 * Branch management over real HTTP, through the real middleware chain.
 *
 * Two things are being pinned down here beyond "CRUD works".
 *
 *   1. `branches` has tenant_isolation but NO branch_isolation policy, so RLS
 *      narrows a query to the organization and stops. Everything that keeps a
 *      branch admin out of another location is application-layer scoping to
 *      ctx.branchIds — code, not a policy — so it needs testing like code.
 *   2. Operating hours are stored as Postgres `time` and surfaced by Prisma as
 *      `DateTime`. Building that Date from local components instead of UTC
 *      shifts every value by the server's offset, silently, which in IST turns
 *      09:00 into 03:30. The round-trip case is there to catch that.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `b${Date.now().toString(36)}`;
const SLUG_A = `br-a-${SUFFIX}`;
const SLUG_B = `br-b-${SUFFIX}`;
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
  return res.body.data.accessToken as string;
}

const asOrg = (slug: string, token: string) => ({
  get: (path: string) =>
    request(app)
      .get(`/api/v1/branches${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(app)
      .post(`/api/v1/branches${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  patch: (path: string, body: object) =>
    request(app)
      .patch(`/api/v1/branches${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  put: (path: string, body: object) =>
    request(app)
      .put(`/api/v1/branches${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  delete: (path: string) =>
    request(app)
      .delete(`/api/v1/branches${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
});

let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Branch A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Branch B'));

  tokenA = await tokenFor(SLUG_A);
  tokenB = await tokenFor(SLUG_B);
  A = asOrg(SLUG_A, tokenA);
  B = asOrg(SLUG_B, tokenB);
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
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

describe('listing and creating', () => {
  it('starts with the branch registration created', async () => {
    const res = await A.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.branches).toHaveLength(1);
    expect(res.body.data.branches[0]).toMatchObject({ code: 'MAIN', isPrimary: true });
  });

  it('creates a second branch and returns it in the list', async () => {
    const created = await A.post('/', { name: 'Baner', code: 'BANER', city: 'Pune' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: 'BANER', city: 'Pune', isPrimary: false });

    const list = await A.get('/');
    expect(list.body.data.branches.map((b: { code: string }) => b.code).sort()).toEqual([
      'BANER',
      'MAIN',
    ]);
  });

  it('refuses a duplicate code within the organization', async () => {
    const res = await A.post('/', { name: 'Baner Two', code: 'BANER' });
    expect(res.status).toBe(409);
  });

  it('allows the other organization the same code — uniqueness is per tenant', async () => {
    const res = await B.post('/', { name: 'Baner', code: 'BANER' });
    expect(res.status).toBe(201);
  });

  it('rejects a malformed body before touching the database', async () => {
    const res = await A.post('/', { name: 'x', code: '' });
    expect(res.status).toBe(400);
  });
});

describe('the tenant boundary', () => {
  it('never lists another organization’s branches', async () => {
    const a = await A.get('/');
    const b = await B.get('/');
    const aIds = a.body.data.branches.map((x: { id: string }) => x.id);
    const bIds = b.body.data.branches.map((x: { id: string }) => x.id);
    expect(aIds.filter((id: string) => bIds.includes(id))).toEqual([]);
  });

  it('answers 404 — never 403 — for another tenant’s branch by id', async () => {
    // 403 would confirm the branch exists, which is the leak.
    const res = await A.get(`/${orgB.branchId}`);
    expect(res.status).toBe(404);
  });

  it('cannot update another tenant’s branch', async () => {
    const res = await A.patch(`/${orgB.branchId}`, { name: 'Hijacked' });
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ name: string }>(
      'SELECT name FROM branches WHERE id = $1',
      [orgB.branchId]
    );
    expect(rows[0]?.name).not.toBe('Hijacked');
  });

  it('cannot delete another tenant’s branch', async () => {
    const res = await A.delete(`/${orgB.branchId}`);
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM branches WHERE id = $1',
      [orgB.branchId]
    );
    expect(rows[0]?.deleted_at).toBeNull();
  });

  it('cannot set operating hours on another tenant’s branch', async () => {
    const res = await A.put(`/${orgB.branchId}/operating-hours`, {
      hours: [{ dayOfWeek: 1, opensAt: '00:00', closesAt: '23:59' }],
    });
    expect(res.status).toBe(404);
  });

  it('requires authentication at all', async () => {
    const res = await request(app).get('/api/v1/branches').set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });

  it('resolves the tenant from x-forwarded-host, which is how the BFF addresses it', async () => {
    /*
     * The regression this exists for: `Host` is a forbidden header name in the
     * fetch spec, so the Next BFF cannot set it — every server-side call
     * arrived as `api:5000` and resolved to no tenant. supertest DOES send
     * Host, so every other case in this file passes either way and none of them
     * would catch it coming back.
     */
    const res = await request(app)
      .get('/api/v1/branches')
      .set('Host', 'api:5000')
      .set('X-Forwarded-Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.branches.length).toBeGreaterThan(0);
  });

  it('signs in against the forwarded host rather than issuing an org-less session', async () => {
    // The same bug's other face: login reads req.tenant and falls back to null,
    // so a dropped host produced a session scoped to no organization instead of
    // an error.
    await clearRateLimits();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', 'api:5000')
      .set('X-Forwarded-Host', hostFor(SLUG_A))
      .send({ identifier: `${SLUG_A}@example.test`, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.activeOrganizationId).toBe(orgA.organizationId);
  });

  it('answers 404 for an unknown tenant, not 403', async () => {
    const res = await request(app)
      .get('/api/v1/branches')
      .set('Host', `no-such-clinic.${ROOT}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });
});

describe('operating hours', () => {
  let branchId: string;

  beforeAll(async () => {
    const created = await A.post('/', { name: 'Hours', code: 'HOURS' });
    branchId = created.body.data.id as string;
  });

  it('round-trips a time without shifting it by the server timezone', async () => {
    const res = await A.put(`/${branchId}/operating-hours`, {
      hours: [
        { dayOfWeek: 1, opensAt: '09:30', closesAt: '17:45' },
        { dayOfWeek: 2, opensAt: '09:30', closesAt: '17:45' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.operatingHours).toEqual([
      { dayOfWeek: 1, opensAt: '09:30', closesAt: '17:45', isClosed: false, slotMinutes: 15 },
      { dayOfWeek: 2, opensAt: '09:30', closesAt: '17:45', isClosed: false, slotMinutes: 15 },
    ]);
  });

  it('replaces the whole week — an omitted day is dropped', async () => {
    const res = await A.put(`/${branchId}/operating-hours`, {
      hours: [{ dayOfWeek: 1, opensAt: '10:00', closesAt: '16:00', slotMinutes: 30 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.operatingHours).toHaveLength(1);
    expect(res.body.data.operatingHours[0]).toMatchObject({ opensAt: '10:00', slotMinutes: 30 });
  });

  it('rejects the same day twice', async () => {
    const res = await A.put(`/${branchId}/operating-hours`, {
      hours: [
        { dayOfWeek: 3, opensAt: '09:00', closesAt: '12:00' },
        { dayOfWeek: 3, opensAt: '13:00', closesAt: '17:00' },
      ],
    });
    expect(res.status).toBe(409);
  });

  it('rejects a day that closes before it opens', async () => {
    const res = await A.put(`/${branchId}/operating-hours`, {
      hours: [{ dayOfWeek: 4, opensAt: '17:00', closesAt: '09:00' }],
    });
    expect(res.status).toBe(409);
  });

  it('accepts a closed day, where the times are not a range', async () => {
    const res = await A.put(`/${branchId}/operating-hours`, {
      hours: [{ dayOfWeek: 0, opensAt: '00:00', closesAt: '00:00', isClosed: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.operatingHours[0].isClosed).toBe(true);
  });

  it('does not leave the hours attached to any other branch', async () => {
    // The nested write goes through the branch parent; this is the assertion
    // that it stayed there.
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM branch_operating_hours h
       JOIN branches b ON b.id = h.branch_id
       WHERE b.organization_id = $1 AND h.branch_id <> $2`,
      [orgA.organizationId, branchId]
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('removing a branch', () => {
  it('refuses to remove the primary branch', async () => {
    const res = await A.delete(`/${orgA.branchId}`);
    expect(res.status).toBe(409);
  });

  it('soft-deletes rather than destroying the row', async () => {
    const created = await A.post('/', { name: 'Temporary', code: 'TEMP' });
    const id = created.body.data.id as string;

    expect((await A.delete(`/${id}`)).status).toBe(200);

    const { rows } = await owner.query<{ deleted_at: Date | null; status: string }>(
      'SELECT deleted_at, status FROM branches WHERE id = $1',
      [id]
    );
    // The row survives: appointments and invoices still point at it.
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.status).toBe('CLOSED');

    expect((await A.get(`/${id}`)).status).toBe(404);
  });
});

describe('the audit trail', () => {
  it('records what changed, with the old value and the new one', async () => {
    const created = await A.post('/', { name: 'Audited', code: 'AUD', city: 'Pune' });
    const id = created.body.data.id as string;

    await A.patch(`/${id}`, { name: 'Audited Clinic' });

    const { rows } = await owner.query<{
      action: string;
      before_data: Record<string, unknown> | null;
      after_data: Record<string, unknown> | null;
      actor_user_id: string;
    }>(
      `SELECT action, before_data, after_data, actor_user_id FROM audit_logs
       WHERE entity_type = 'branch' AND entity_id = $1 ORDER BY occurred_at`,
      [id]
    );

    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows[0]?.after_data).toMatchObject({ code: 'AUD' });

    // The whole point of the diff: only the field that moved, both sides of it.
    expect(rows[1]?.before_data).toEqual({ name: 'Audited' });
    expect(rows[1]?.after_data).toEqual({ name: 'Audited Clinic' });
    expect(rows[1]?.actor_user_id).toBe(orgA.ownerUserId);
  });
});
