/**
 * Invitations over real HTTP, through the real middleware chain.
 *
 * Four things are being pinned down beyond "it works".
 *
 *   1. The token is a credential. Only its SHA-256 digest is stored, so a token
 *      that has been replayed, revoked, expired or reissued must be dead — and
 *      each of those is a separate case below, because each is a separate
 *      `where` clause that a refactor could drop without failing anything else.
 *   2. Accepting runs pre-membership, on an `unsafeDbClient()` transaction that
 *      adopts the tenant mid-flight. The organization it adopts comes from the
 *      HOST, so "clinic A's invitation at clinic B's subdomain" is enforced by
 *      RLS rather than by an `if`. That is the case worth having.
 *   3. `invitation_branches.branch_id` is a plain FK, not one of the composite
 *      ones — the invariant that makes a cross-tenant reference unrepresentable
 *      elsewhere does not hold here. The service checks `ctx.branchIds` first;
 *      this asserts it answers 404 rather than leaking a policy error as a 500.
 *   4. Exactly one membership. `@@unique([userId, organizationId])` would catch a
 *      duplicate as a 500; the compare-and-set is what makes it a clean refusal.
 *
 * The invitation email is intercepted rather than mocked with jest: `sender` is
 * a plain object and the token exists nowhere else, since the column holds a
 * digest.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { sender } from '../../src/services/notification/sender.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG_A = `inv-a-${SUFFIX}`;
const SLUG_B = `inv-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const INVITEE_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let tokenA: string;
let tokenB: string;

/** Every invitation email the run produced, newest last. */
const sent: { to: string; template: string; link: string }[] = [];

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

async function tokenFor(slug: string, identifier: string, secret: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier, password: secret });
  return res.body.data?.accessToken as string;
}

const asOrg = (slug: string, token: string) => ({
  get: (path: string) =>
    request(app)
      .get(`/api/v1/invitations${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(app)
      .post(`/api/v1/invitations${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  delete: (path: string, body: object = {}) =>
    request(app)
      .delete(`/api/v1/invitations${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
});

/** The accept side is unauthenticated and lives on the auth router. */
const atHost = (slug: string) => ({
  preview: (token: string) =>
    request(app)
      .post('/api/v1/auth/invitations/preview')
      .set('Host', hostFor(slug))
      .send({ token }),
  accept: (body: object) =>
    request(app).post('/api/v1/auth/invitations/accept').set('Host', hostFor(slug)).send(body),
});

let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

/** The last link sent to this address, reduced to the token in its query. */
function tokenSentTo(email: string): string {
  const last = [...sent].reverse().find((mail) => mail.to === email);
  if (!last) throw new Error(`no invitation email was sent to ${email}`);
  const token = new URL(last.link).searchParams.get('token');
  if (!token) throw new Error(`invitation link carried no token: ${last.link}`);
  return token;
}

async function roleId(client: ReturnType<typeof asOrg>, code: string): Promise<string> {
  const res = await client.get('/');
  const role = (res.body.data.roles as { id: string; code: string }[]).find((r) => r.code === code);
  if (!role) throw new Error(`role ${code} is not assignable — did the seed run?`);
  return role.id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  // The token is handed to the sender and to nobody else — the column holds a
  // digest — so this interception is the only way to test the accept flow.
  sender.sendEmail = (to, template, vars) => {
    sent.push({ to, template, link: vars['link'] ?? '' });
    return Promise.resolve();
  };

  orgA = await registerOrganization(payload(SLUG_A, 'Invite A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Invite B'));

  tokenA = await tokenFor(SLUG_A, `${SLUG_A}@example.test`, PASSWORD);
  tokenB = await tokenFor(SLUG_B, `${SLUG_B}@example.test`, PASSWORD);
  A = asOrg(SLUG_A, tokenA);
  B = asOrg(SLUG_B, tokenB);
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);

  // Accepting creates users this suite did not register, so they are found by
  // the address pattern rather than tracked.
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE $1 OR email LIKE $2`,
    [`%${SUFFIX}@example.test`, `%${SUFFIX}.invitee@example.test`]
  );
  const users = [orgA?.ownerUserId, orgB?.ownerUserId, ...rows.map((r) => r.id)].filter(Boolean);

  if (users.length > 0) {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('issuing', () => {
  it('starts empty, and offers the system roles to invite into', async () => {
    const res = await A.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.invitations).toEqual([]);

    const codes = (res.body.data.roles as { code: string }[]).map((r) => r.code);
    expect(codes).toContain('RECEPTIONIST');
    // A PLATFORM-scoped role must never appear: an invitation naming it would
    // hand a clinic administrator the whole platform.
    expect(codes).not.toContain('SUPER_ADMIN');
  });

  it('issues an org-wide invitation and stores only a digest of the token', async () => {
    const res = await A.post('/', {
      email: `nurse-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', branches: [] });
    // The clear token must never come back on the response.
    expect(JSON.stringify(res.body.data)).not.toContain(
      tokenSentTo(`nurse-${SUFFIX}@example.test`)
    );

    const { rows } = await owner.query<{ token: string }>(
      'SELECT token FROM invitations WHERE id = $1',
      [res.body.data.id]
    );
    // 64 hex characters is a SHA-256 digest; the token itself is base64url.
    expect(rows[0]?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token).not.toBe(tokenSentTo(`nurse-${SUFFIX}@example.test`));
  });

  it('refuses a second outstanding invitation to the same address', async () => {
    const res = await A.post('/', {
      email: `nurse-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
    });
    expect(res.status).toBe(409);
  });

  it('refuses an organization-scoped role pinned to specific branches', async () => {
    const res = await A.post('/', {
      email: `admin-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'ORG_ADMIN'),
      branchIds: [orgA.branchId],
    });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed body before touching the database', async () => {
    const res = await A.post('/', { email: 'not-an-email', roleId: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('the tenant boundary', () => {
  it('never lists another organization’s invitations', async () => {
    const a = await A.get('/');
    const b = await B.get('/');
    const aIds = (a.body.data.invitations as { id: string }[]).map((i) => i.id);
    const bIds = (b.body.data.invitations as { id: string }[]).map((i) => i.id);
    expect(aIds.length).toBeGreaterThan(0);
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
  });

  it('answers 404 — never 403 — when revoking another tenant’s invitation', async () => {
    const mine = await A.get('/');
    const id = (mine.body.data.invitations as { id: string }[])[0]?.id;

    const res = await B.delete(`/${id as string}`);
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM invitations WHERE id = $1',
      [id]
    );
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it('refuses a role that belongs to the other organization', async () => {
    // Custom roles do not exist yet, so this uses a branch id as a stand-in for
    // "a uuid that resolves to a row this tenant cannot see".
    const res = await A.post('/', {
      email: `role-${SUFFIX}@example.test`,
      roleId: orgB.branchId,
    });
    expect(res.status).toBe(404);
  });

  it('refuses to attach another organization’s branch to an invitation', async () => {
    /*
     * invitation_branches.branch_id is a PLAIN FK to branches(id), so the
     * composite-FK invariant does not make this unrepresentable. The RESTRICTIVE
     * branch_in_same_org policy would refuse the write — as a 500. The service
     * checks ctx.branchIds first so it reads as a 404, and nothing is written.
     */
    const res = await A.post('/', {
      email: `branch-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'RECEPTIONIST'),
      branchIds: [orgB.branchId],
    });
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*) AS count FROM invitation_branches WHERE branch_id = $1',
      [orgB.branchId]
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('cannot preview an invitation from another clinic’s subdomain', async () => {
    const token = tokenSentTo(`nurse-${SUFFIX}@example.test`);

    expect((await atHost(SLUG_A).preview(token)).status).toBe(200);
    // Same token, wrong host: RLS narrows the lookup to org B and finds nothing.
    expect((await atHost(SLUG_B).preview(token)).status).toBe(404);
  });

  it('cannot accept an invitation from another clinic’s subdomain', async () => {
    await clearRateLimits();
    const token = tokenSentTo(`nurse-${SUFFIX}@example.test`);

    const res = await atHost(SLUG_B).accept({
      token,
      fullName: 'Wrong Clinic',
      password: INVITEE_PASSWORD,
    });
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*) AS count FROM memberships WHERE organization_id = $1',
      [orgB.organizationId]
    );
    // Just the owner from registration.
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('has no tenant to look a token up against on the apex', async () => {
    await clearRateLimits();
    const res = await request(app)
      .post('/api/v1/auth/invitations/preview')
      .set('Host', ROOT)
      .send({ token: tokenSentTo(`nurse-${SUFFIX}@example.test`) });
    expect(res.status).toBe(404);
  });
});

describe('accepting as a new user', () => {
  const email = `newbie-${SUFFIX}@example.test`;
  let token: string;
  let invitationId: string;

  beforeAll(async () => {
    await clearRateLimits();
    const created = await A.post('/', {
      email,
      roleId: await roleId(A, 'RECEPTIONIST'),
      branchIds: [orgA.branchId],
    });
    invitationId = created.body.data.id as string;
    token = tokenSentTo(email);
  });

  it('previews the clinic and says an account is needed', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_A).preview(token);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      organizationName: 'Invite A',
      email,
      roleName: 'Receptionist / Front Desk',
      needsAccount: true,
    });
    expect(res.body.data.branchNames).toEqual(['Invite A Main']);
  });

  it('refuses a password that would not pass the strength rules', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_A).accept({ token, fullName: 'Too Weak', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('creates the account, exactly one membership, and lands signed in', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_A).accept({
      token,
      fullName: 'Newbie Receptionist',
      password: INVITEE_PASSWORD,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.activeOrganizationId).toBe(orgA.organizationId);
    expect(res.body.data.activeBranchId).toBe(orgA.branchId);
    // Permissions are resolved from the role that was just granted, not from
    // the token — which is what proves the access cache was invalidated.
    expect(res.body.data.permissions).toContain('appointment.create');
    expect(res.body.data.permissions).not.toContain('iam.user.invite');

    const memberships = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE u.email = $1 AND m.organization_id = $2`,
      [email, orgA.organizationId]
    );
    expect(Number(memberships.rows[0]?.count)).toBe(1);

    const roles = await owner.query<{ branch_id: string | null }>(
      `SELECT mr.branch_id FROM membership_roles mr
       JOIN memberships m ON m.id = mr.membership_id
       JOIN users u ON u.id = m.user_id
       WHERE u.email = $1`,
      [email]
    );
    // One branch was named, so one row pinned to it — not the org-wide NULL.
    expect(roles.rows.map((r) => r.branch_id)).toEqual([orgA.branchId]);

    const invitation = await owner.query<{ accepted_at: Date | null }>(
      'SELECT accepted_at FROM invitations WHERE id = $1',
      [invitationId]
    );
    expect(invitation.rows[0]?.accepted_at).not.toBeNull();
  });

  it('treats the account as email-verified, because the token proved the mailbox', async () => {
    const { rows } = await owner.query<{ email_verified_at: Date | null; status: string }>(
      'SELECT email_verified_at, status FROM users WHERE email = $1',
      [email]
    );
    expect(rows[0]?.email_verified_at).not.toBeNull();
    expect(rows[0]?.status).toBe('ACTIVE');
  });

  it('refuses the same token a second time', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_A).accept({
      token,
      fullName: 'Newbie Again',
      password: INVITEE_PASSWORD,
    });
    expect(res.status).toBe(404);
  });

  it('grants only what the role carries — no invite permission for a receptionist', async () => {
    const staffToken = await tokenFor(SLUG_A, email, INVITEE_PASSWORD);
    const res = await asOrg(SLUG_A, staffToken).post('/', {
      email: `escalate-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
    });
    expect(res.status).toBe(403);
  });
});

describe('accepting as someone who already has an account', () => {
  // Org A's owner, invited to work at org B as well. The case that made
  // `users.email` globally unique in the first place.
  const email = `${SLUG_A}@example.test`;
  let token: string;

  beforeAll(async () => {
    await clearRateLimits();
    await B.post('/', { email, roleId: await roleId(B, 'DOCTOR') });
    token = tokenSentTo(email);
  });

  it('says no account is needed', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_B).preview(token);
    expect(res.status).toBe(200);
    expect(res.body.data.needsAccount).toBe(false);
  });

  it('refuses the wrong password without consuming the invitation', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_B).accept({ token, password: 'NotTheirPassword9X' });
    expect(res.status).toBe(401);

    // Still live: a failed attempt must not burn someone else's invitation.
    await clearRateLimits();
    expect((await atHost(SLUG_B).preview(token)).status).toBe(200);
  });

  it('joins the second clinic with the existing account, not a new one', async () => {
    await clearRateLimits();
    const res = await atHost(SLUG_B).accept({ token, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.id).toBe(orgA.ownerUserId);
    expect(res.body.data.activeOrganizationId).toBe(orgB.organizationId);
    // Both clinics now appear in the switcher.
    expect(
      (res.body.data.memberships as { organizationId: string }[])
        .map((m) => m.organizationId)
        .sort()
    ).toEqual([orgA.organizationId, orgB.organizationId].sort());

    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*) AS count FROM users WHERE email = $1',
      [email]
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe('revoking, resending and expiry', () => {
  it('kills the token when the invitation is revoked', async () => {
    await clearRateLimits();
    const email = `revoked-${SUFFIX}@example.test`;
    const created = await A.post('/', { email, roleId: await roleId(A, 'NURSE') });
    const token = tokenSentTo(email);

    const revoked = await A.delete(`/${created.body.data.id as string}`, {
      reason: 'wrong person',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.status).toBe('REVOKED');

    await clearRateLimits();
    expect((await atHost(SLUG_A).preview(token)).status).toBe(404);
  });

  it('kills the previous token when the invitation is resent', async () => {
    await clearRateLimits();
    const email = `resent-${SUFFIX}@example.test`;
    const created = await A.post('/', { email, roleId: await roleId(A, 'NURSE') });
    const first = tokenSentTo(email);

    const again = await A.post(`/${created.body.data.id as string}/resend`, {});
    expect(again.status).toBe(200);
    const second = tokenSentTo(email);
    expect(second).not.toBe(first);

    await clearRateLimits();
    // A link that has been sitting in a mailbox must not survive a reissue.
    expect((await atHost(SLUG_A).preview(first)).status).toBe(404);
    expect((await atHost(SLUG_A).preview(second)).status).toBe(200);
  });

  it('refuses an expired token', async () => {
    await clearRateLimits();
    const email = `expired-${SUFFIX}@example.test`;
    const created = await A.post('/', { email, roleId: await roleId(A, 'NURSE') });
    const token = tokenSentTo(email);

    await owner.query(
      `UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [created.body.data.id]
    );

    await clearRateLimits();
    expect((await atHost(SLUG_A).preview(token)).status).toBe(404);

    const list = await A.get('/');
    const row = (list.body.data.invitations as { id: string; status: string }[]).find(
      (i) => i.id === created.body.data.id
    );
    expect(row?.status).toBe('EXPIRED');
  });
});

describe('the audit trail', () => {
  it('records the grant, and never the token', async () => {
    const { rows } = await owner.query<{
      action: string;
      entity_type: string;
      after_data: Record<string, unknown> | null;
    }>(
      `SELECT action, entity_type, after_data FROM audit_logs
       WHERE organization_id = $1 AND entity_type IN ('invitation', 'membership')
       ORDER BY occurred_at`,
      [orgA.organizationId]
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => `${r.entity_type}:${r.action}`)).toContain('invitation:CREATE');
    expect(rows.map((r) => `${r.entity_type}:${r.action}`)).toContain('membership:CREATE');

    // A digest is 64 hex characters; nothing that shape belongs in an audit row.
    expect(JSON.stringify(rows)).not.toMatch(/[0-9a-f]{64}/);
  });
});
