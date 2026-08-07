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

/**
 * The employment record, filled the moment someone accepts.
 *
 * Three things land without anybody typing them: an employee code from the
 * org-wide EMPLOYEE sequence, the designation chosen on the invitation, and
 * today's date IN THE CLINIC'S OWN TIMEZONE.
 *
 * That last one is the case worth having. The column is a bare `date`, the API
 * container runs UTC, and clinics do not: someone accepting at 01:00 IST is
 * 19:30 UTC the previous day, so a `new Date()` would record them as joining
 * YESTERDAY. It is a one-day error nobody notices until payroll disagrees with
 * a contract.
 */
describe('the employment record', () => {
  const email = `employed-${SUFFIX}@example.test`;
  let designationId: string;
  /** Which of the two extreme zones actually disagreed with UTC this run. */
  const differedFromUtc = new Set<string>();

  beforeAll(async () => {
    await clearRateLimits();
    const designations = await request(app)
      .get('/api/v1/designations')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    designationId = (designations.body.data.designations as { id: string; code: string }[]).find(
      (d) => d.code === 'SENIOR_CONSULTANT'
    )?.id as string;
  });

  it('offers the platform catalogue to every clinic', () => {
    expect(designationId).toBeDefined();
  });

  it('fills employee code, designation and joining date on accept', async () => {
    await clearRateLimits();
    const created = await A.post('/', {
      email,
      roleId: await roleId(A, 'DOCTOR'),
      designationId,
      branchIds: [orgA.branchId],
    });
    expect(created.status).toBe(201);

    await clearRateLimits();
    const accepted = await atHost(SLUG_A).accept({
      token: tokenSentTo(email),
      fullName: 'Employed Doctor',
      password: INVITEE_PASSWORD,
    });
    expect(accepted.status).toBe(201);

    const { rows } = await owner.query<{
      employee_code: string | null;
      designation_name: string | null;
      joined_on: Date | null;
      expected_today: string;
    }>(
      `SELECT sp.employee_code,
              d.name AS designation_name,
              sp.joined_on,
              to_char((now() AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS expected_today
       FROM staff_profiles sp
       JOIN memberships m  ON m.id = sp.membership_id
       JOIN users u        ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN designations d ON d.id = sp.designation_id
       WHERE u.email = $1`,
      [email]
    );

    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.designation_name).toBe('Senior Consultant');
    // Prefix from the seeded `staff.employee_code_prefix`, padded to 4.
    expect(row?.employee_code).toMatch(/^EMP\d{4}$/);
    // The clinic's today, not the server's.
    expect(row?.joined_on?.toISOString().slice(0, 10)).toBe(row?.expected_today);
  });

  /*
   * The timezone case, and the reason it runs TWO zones rather than one.
   *
   * A single far-east zone is a flaky test dressed as a strict one: Kiritimati
   * (UTC+14) shares UTC's calendar date for fourteen hours out of every
   * twenty-four, and during those hours a naive `new Date()` produces the right
   * answer by accident and the test passes. Measured at the time of writing —
   * UTC and Kiritimati were both 2026-08-07, and the assertion proved nothing.
   *
   * Kiritimati (UTC+14) and Midway (UTC-11) are 25 hours apart, so their
   * calendar dates can never BOTH equal UTC's. Running both means at least one
   * of these two cases is always a real test, whatever the hour, and the
   * `differed` assertion at the end fails loudly if that ever stops being true.
   */
  it.each([
    ['Pacific/Kiritimati', 'east'],
    ['Pacific/Midway', 'west'],
  ])("uses the clinic's calendar, not the server's (%s)", async (timezone, label) => {
    const invitee = `${label}-${SUFFIX}@example.test`;

    await owner.query(`UPDATE organizations SET timezone = $1 WHERE id = $2`, [
      timezone,
      orgA.organizationId,
    ]);

    try {
      await clearRateLimits();
      await A.post('/', {
        email: invitee,
        roleId: await roleId(A, 'NURSE'),
        branchIds: [orgA.branchId],
      });

      await clearRateLimits();
      const accepted = await atHost(SLUG_A).accept({
        token: tokenSentTo(invitee),
        fullName: `${label} Nurse`,
        password: INVITEE_PASSWORD,
      });
      expect(accepted.status).toBe(201);

      const { rows } = await owner.query<{
        joined_on: Date;
        clinic_today: string;
        utc_today: string;
      }>(
        `SELECT sp.joined_on,
                to_char((now() AT TIME ZONE $2)::date,    'YYYY-MM-DD') AS clinic_today,
                to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS utc_today
         FROM staff_profiles sp
         JOIN memberships m ON m.id = sp.membership_id
         JOIN users u       ON u.id = m.user_id
         WHERE u.email = $1`,
        [invitee, timezone]
      );

      const row = rows[0];

      // Recorded BEFORE the assertion, so the guard below reports whether this
      // zone was meaningful rather than merely whether it passed.
      if (row && row.clinic_today !== row.utc_today) differedFromUtc.add(timezone);

      expect(row?.joined_on.toISOString().slice(0, 10)).toBe(row?.clinic_today);
    } finally {
      await owner.query(`UPDATE organizations SET timezone = 'Asia/Kolkata' WHERE id = $1`, [
        orgA.organizationId,
      ]);
    }
  });

  it('had at least one timezone that genuinely disagreed with UTC', () => {
    /*
     * The guard on the guard. If this ever fails, the two cases above ran at an
     * hour where both zones happened to match UTC — which is impossible for
     * zones 25 hours apart, so it would mean the zones were changed to
     * something closer together and the test quietly stopped testing anything.
     */
    expect(differedFromUtc.size).toBeGreaterThan(0);
  });

  it('issues a different employee code to each person', async () => {
    const { rows } = await owner.query<{ employee_code: string }>(
      `SELECT sp.employee_code
       FROM staff_profiles sp
       JOIN memberships m ON m.id = sp.membership_id
       WHERE m.organization_id = $1 AND sp.employee_code IS NOT NULL`,
      [orgA.organizationId]
    );

    const codes = rows.map((r) => r.employee_code);
    expect(codes.length).toBeGreaterThan(1);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('refuses an invitation naming a designation that does not exist', async () => {
    await clearRateLimits();
    const res = await A.post('/', {
      email: `ghost-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
      designationId: '11111111-1111-4111-8111-111111111111',
      branchIds: [orgA.branchId],
    });
    // 404, not a 500 from the RESTRICTIVE designation_visible policy.
    expect(res.status).toBe(404);
  });
});

/**
 * A Receptionist is not a Radiologist.
 *
 * The invite form filters the title menu by the chosen role, but a filtered
 * dropdown is a convenience rather than a control — so the API refuses the
 * combination too, and that is what these cases pin down.
 *
 * The rule has one deliberate asymmetry worth testing directly: a title nobody
 * has mapped fits EVERY role. "No visible pairing" means unrestricted, not
 * forbidden, so that a clinic which adds a title and forgets to map it does not
 * watch it disappear from every menu.
 */
describe('role and title eligibility', () => {
  const titleFor = async (code: string): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM designations WHERE organization_id IS NULL AND code = $1`,
      [code]
    );
    return rows[0]?.id as string;
  };

  it('refuses a Radiologist title on a Receptionist invitation', async () => {
    await clearRateLimits();
    const res = await A.post('/', {
      email: `mismatch-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'RECEPTIONIST'),
      designationId: await titleFor('RADIOLOGIST'),
      branchIds: [orgA.branchId],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a title for/i);
  });

  it('accepts a Front Desk Executive title on a Receptionist invitation', async () => {
    await clearRateLimits();
    const res = await A.post('/', {
      email: `matched-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'RECEPTIONIST'),
      designationId: await titleFor('FRONT_DESK_EXECUTIVE'),
      branchIds: [orgA.branchId],
    });

    expect(res.status).toBe(201);
  });

  it('accepts a Radiologist title on a Lab Manager invitation', async () => {
    // The same title that was refused above — it is the PAIR that is wrong,
    // not the title.
    await clearRateLimits();
    const res = await A.post('/', {
      email: `radio-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'LAB_MANAGER'),
      designationId: await titleFor('RADIOLOGIST'),
      branchIds: [orgA.branchId],
    });

    expect(res.status).toBe(201);
  });

  it('lets an unmapped title through for any role', async () => {
    // HOUSEKEEPING is deliberately paired with no role in the seed: a support
    // title any of the built-in roles might carry.
    await clearRateLimits();
    const res = await A.post('/', {
      email: `unmapped-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'DOCTOR'),
      designationId: await titleFor('HOUSEKEEPING'),
      branchIds: [orgA.branchId],
    });

    expect(res.status).toBe(201);
  });

  it('reports which roles each title fits, so the menu can filter', async () => {
    await clearRateLimits();
    const res = await request(app)
      .get('/api/v1/designations')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

    const list = res.body.data.designations as {
      code: string;
      roleIds: string[];
      fitsAnyRole: boolean;
    }[];

    const radiologist = list.find((d) => d.code === 'RADIOLOGIST');
    const housekeeping = list.find((d) => d.code === 'HOUSEKEEPING');

    // A mapped title names its roles and is constrained to them.
    expect(radiologist?.roleIds.length).toBeGreaterThan(0);
    expect(radiologist?.fitsAnyRole).toBe(false);

    /*
     * An unmapped title carries EVERY role AND the flag. The flag is what the
     * client filters on: an empty roleIds is ambiguous, because a title whose
     * every pairing a clinic switched off also has none and must fit nothing.
     */
    expect(housekeeping?.fitsAnyRole).toBe(true);
    expect(housekeeping?.roleIds.length).toBeGreaterThan(0);
  });

  it('maps a title added from the invite form to that role straight away', async () => {
    await clearRateLimits();
    const doctorRole = await roleId(A, 'DOCTOR');

    const created = await request(app)
      .post('/api/v1/designations')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: `Trichology Consultant ${SUFFIX}`, roleId: doctorRole });

    expect(created.status).toBe(201);
    expect(created.body.data.roleIds).toEqual([doctorRole]);

    // And it is immediately usable for that role, but not for another.
    await clearRateLimits();
    const good = await A.post('/', {
      email: `tricho-${SUFFIX}@example.test`,
      roleId: doctorRole,
      designationId: created.body.data.id,
      branchIds: [orgA.branchId],
    });
    expect(good.status).toBe(201);

    // NURSE, not ACCOUNTANT: an organization-scoped role is refused with a 409
    // for carrying branch ids at all, which would mask the 400 under test.
    await clearRateLimits();
    const bad = await A.post('/', {
      email: `tricho2-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
      designationId: created.body.data.id,
      branchIds: [orgA.branchId],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not a title for/i);
  });
});

/**
 * Managing the pairings from the clinic settings screen.
 *
 * The reconciliation stores the DIFFERENCE from the platform defaults, not the
 * whole list, so a clinic that never touched a role keeps tracking the defaults
 * and a clinic that returns a role to its default leaves no residue.
 *
 * Two cases here are the ones the eligibility rule was rewritten for. Both look
 * like corner cases and both are reachable with one tick of one checkbox.
 */
describe('managing role and title pairings', () => {
  const titleFor = async (code: string): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM designations WHERE organization_id IS NULL AND code = $1`,
      [code]
    );
    return rows[0]?.id as string;
  };

  const pairings = () =>
    request(app)
      .get('/api/v1/designations/pairings')
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`);

  const setPairings = (roleId: string, designationIds: string[]) =>
    request(app)
      .put(`/api/v1/designations/pairings/${roleId}`)
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ designationIds });

  const titlesFor = async (roleCode: string) => {
    const res = await pairings();
    const role = (res.body.data.roles as { roleCode: string; titles: unknown[] }[]).find(
      (r) => r.roleCode === roleCode
    );
    return role?.titles as {
      designationId: string;
      name: string;
      enabled: boolean;
      isPlatformDefault: boolean;
    }[];
  };

  it('reports the seeded defaults as enabled and marked as defaults', async () => {
    const titles = await titlesFor('RECEPTIONIST');
    const frontDesk = titles.find((t) => t.name === 'Front Desk Executive');
    const radiologist = titles.find((t) => t.name === 'Radiologist');

    expect(frontDesk).toMatchObject({ enabled: true, isPlatformDefault: true });
    expect(radiologist).toMatchObject({ enabled: false, isPlatformDefault: false });
  });

  it('switches a platform default off, and the API then refuses it', async () => {
    const targetRole = await roleId(A, 'RECEPTIONIST');
    const keep = (await titlesFor('RECEPTIONIST'))
      .filter((t) => t.enabled && t.name !== 'Clinic Manager')
      .map((t) => t.designationId);

    const saved = await setPairings(targetRole, keep);
    expect(saved.status).toBe(200);

    const after = (await titlesFor('RECEPTIONIST')).find((t) => t.name === 'Clinic Manager');
    // Still flagged as a platform default — the clinic has overridden it, not
    // rewritten what the platform says.
    expect(after).toMatchObject({ enabled: false, isPlatformDefault: true });

    await clearRateLimits();
    const invite = await A.post('/', {
      email: `excluded-${SUFFIX}@example.test`,
      roleId: targetRole,
      designationId: await titleFor('CLINIC_MANAGER'),
      branchIds: [orgA.branchId],
    });
    expect(invite.status).toBe(400);
  });

  it('switches it back on and leaves no row behind', async () => {
    const targetRole = await roleId(A, 'RECEPTIONIST');

    /*
     * Everything currently enabled PLUS the one that was switched off — not
     * just the platform defaults. An unmapped title is enabled too (it fits any
     * role), so sending only the defaults would untick every unmapped title and
     * write a pile of exclusions, which is correct behaviour and not what this
     * case is about.
     */
    const current = await titlesFor('RECEPTIONIST');
    const all = current
      .filter((t) => t.enabled || t.name === 'Clinic Manager')
      .map((t) => t.designationId);

    await setPairings(targetRole, all);

    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM role_designations
       WHERE organization_id = $1 AND role_id = $2`,
      [orgA.organizationId, targetRole]
    );
    // Back to the default state, so the difference is empty and nothing is stored.
    expect(Number(rows[0]?.count)).toBe(0);
  });

  /*
   * BACKFIRE ONE. Housekeeping is unmapped, so it fits every role. Unticking it
   * for Doctor creates its only row — an exclusion. If exclusions counted
   * towards "is this title mapped", Housekeeping would read as managed and
   * vanish from every OTHER role's menu too.
   */
  it('excluding an unmapped title for one role leaves it available to the rest', async () => {
    const doctorRole = await roleId(A, 'DOCTOR');
    const housekeeping = await titleFor('HOUSEKEEPING');

    const keep = (await titlesFor('DOCTOR'))
      .filter((t) => t.enabled && t.designationId !== housekeeping)
      .map((t) => t.designationId);
    await setPairings(doctorRole, keep);

    // Gone for Doctor…
    await clearRateLimits();
    const forDoctor = await A.post('/', {
      email: `hk-doc-${SUFFIX}@example.test`,
      roleId: doctorRole,
      designationId: housekeeping,
      branchIds: [orgA.branchId],
    });
    expect(forDoctor.status).toBe(400);

    // …but still there for everyone else.
    await clearRateLimits();
    const forNurse = await A.post('/', {
      email: `hk-nurse-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'NURSE'),
      designationId: housekeeping,
      branchIds: [orgA.branchId],
    });
    expect(forNurse.status).toBe(201);
  });

  /*
   * BACKFIRE TWO, the opposite direction. Pharmacist is paired with exactly
   * PHARMACIST and CHIEF_PHARMACIST. Untick both and only exclusions remain —
   * if positives had gone to zero the title would read as unmapped, and
   * unmapped means valid EVERYWHERE.
   */
  it('excluding every pairing of a title makes it fit nothing, not everything', async () => {
    const pharmacistRole = await roleId(A, 'PHARMACIST');
    const chiefPharmacist = await titleFor('CHIEF_PHARMACIST');

    // CHIEF_PHARMACIST is paired only with PHARMACIST, so emptying that role's
    // list removes its only positive pairing.
    await setPairings(pharmacistRole, []);

    await clearRateLimits();
    const forPharmacist = await A.post('/', {
      email: `cp-pharm-${SUFFIX}@example.test`,
      roleId: pharmacistRole,
      designationId: chiefPharmacist,
      branchIds: [orgA.branchId],
    });
    expect(forPharmacist.status).toBe(400);

    // And it has NOT become universally available.
    await clearRateLimits();
    const forDoctor = await A.post('/', {
      email: `cp-doc-${SUFFIX}@example.test`,
      roleId: await roleId(A, 'DOCTOR'),
      designationId: chiefPharmacist,
      branchIds: [orgA.branchId],
    });
    expect(forDoctor.status).toBe(400);
  });

  it("refuses to configure another clinic's private role", async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO roles (id, organization_id, code, name, scope_level, updated_at)
       VALUES (gen_random_uuid(), $1, 'B_ONLY_ROLE', 'B Only', 'BRANCH', now())
       RETURNING id`,
      [orgB.organizationId]
    );

    const res = await setPairings(rows[0]?.id as string, []);
    expect(res.status).toBe(404);

    await owner.query('DELETE FROM roles WHERE id = $1', [rows[0]?.id]);
  });
});
