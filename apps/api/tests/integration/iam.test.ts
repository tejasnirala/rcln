/**
 * Roles, members and permission overrides over real HTTP.
 *
 * Five things are being pinned down beyond "CRUD works", each of which fails
 * silently rather than loudly if the code is wrong.
 *
 *   1. `membership_roles` and `membership_permission_overrides` carry a
 *      RESTRICTIVE branch_isolation policy, and the two cases it produces are
 *      both wrong answers. Both were measured by deleting the guard and running
 *      these cases: naming another branch turns 404 into a 500, and omitting the
 *      branch altogether — an org-wide grant, which the policy permits by design
 *      — turns 403 into 201 and a real, working assignment to every branch in
 *      the clinic. The branch-scoped caller below is what holds both shut.
 *   2. You cannot grant what you do not hold. ORG_ADMIN is defined without
 *      `patient.delete`, `branch.delete` and `organization.billing.manage`;
 *      assigning ORG_OWNER to someone else is how you get all three back.
 *   3. Cache invalidation. `loadUserAccess` caches for 60 seconds, so a grant
 *      that does not drop the cache appears to work and changes nothing. Every
 *      case here re-checks with the SAME access token the target already held —
 *      if the cache were stale, the assertion would fail.
 *   4. A system role is never mutated, and a tenant role can never shadow one.
 *   5. Effective permissions are resolved DENY-first. That is unit-tested in
 *      @rcln/permissions; here it is asserted end to end, as a 403 from a real
 *      request.
 *
 * Members are created through the real invitation flow rather than by INSERT,
 * because the thing under test is what a membership looks like once the rest of
 * the system made it.
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

const SUFFIX = `m${Date.now().toString(36)}`;
const SLUG_A = `iam-a-${SUFFIX}`;
const SLUG_B = `iam-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };

/** The second branch in org A. The whole branch-scope story needs two. */
let banerId: string;

const sent: { to: string; link: string }[] = [];

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

/** Every call in this suite carries a Host and a bearer token; nothing else. */
const asUser = (slug: string, token: () => string) => ({
  get: (path: string) =>
    request(app).get(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token()}`),
  post: (path: string, body: object = {}) =>
    request(app)
      .post(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
  patch: (path: string, body: object = {}) =>
    request(app)
      .patch(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
  delete: (path: string, body: object = {}) =>
    request(app)
      .delete(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
});

async function login(slug: string, identifier: string, secret: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier, password: secret });
  if (!res.body.data?.accessToken) {
    throw new Error(`could not sign ${identifier} in: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

/**
 * Tokens are read through a closure rather than captured, because several of
 * them do not exist until `beforeAll` has invited and accepted their owner.
 */
let ownerToken = '';
let bToken = '';
let scopedToken = '';
let targetToken = '';
let adminToken = '';

const A = asUser(SLUG_A, () => ownerToken);
const B = asUser(SLUG_B, () => bToken);
const Scoped = asUser(SLUG_A, () => scopedToken);
const Target = asUser(SLUG_A, () => targetToken);
const OrgAdmin = asUser(SLUG_A, () => adminToken);

/** Invite, accept, sign in — the way a real member comes into existence. */
async function joinAs(
  email: string,
  fullName: string,
  roleId: string,
  branchIds: string[]
): Promise<string> {
  await clearRateLimits();
  const invited = await A.post('/api/v1/invitations', { email, roleId, branchIds });
  if (invited.status !== 201) {
    throw new Error(`could not invite ${email}: ${JSON.stringify(invited.body)}`);
  }

  const link = [...sent].reverse().find((mail) => mail.to === email)?.link;
  if (!link) throw new Error(`no invitation email reached ${email}`);
  const token = new URL(link).searchParams.get('token');

  await clearRateLimits();
  const accepted = await request(app)
    .post('/api/v1/auth/invitations/accept')
    .set('Host', hostFor(SLUG_A))
    .send({ token, fullName, password: MEMBER_PASSWORD });
  if (accepted.status !== 201) {
    throw new Error(`could not accept for ${email}: ${JSON.stringify(accepted.body)}`);
  }

  return login(SLUG_A, email, MEMBER_PASSWORD);
}

async function roleIdFor(code: string): Promise<string> {
  const res = await A.get('/api/v1/roles');
  const role = (res.body.data.roles as { id: string; code: string }[]).find((r) => r.code === code);
  if (!role) throw new Error(`role ${code} is not visible — did the seed run?`);
  return role.id;
}

async function membershipIdFor(email: string): Promise<string> {
  const res = await A.get('/api/v1/members');
  const member = (res.body.data.members as { id: string; email: string }[]).find(
    (m) => m.email === email
  );
  if (!member) throw new Error(`${email} is not a member`);
  return member.id;
}

const SCOPED_EMAIL = `scoped-${SUFFIX}@example.test`;
const TARGET_EMAIL = `target-${SUFFIX}@example.test`;
const ADMIN_EMAIL = `orgadmin-${SUFFIX}@example.test`;

let scopedRoleId = '';
let deskViewRoleId = '';
let targetMembershipId = '';
let ownerMembershipId = '';

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  sender.sendEmail = (to, _template, vars) => {
    sent.push({ to, link: vars['link'] ?? '' });
    return Promise.resolve();
  };

  orgA = await registerOrganization(payload(SLUG_A, 'Iam A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Iam B'));

  ownerToken = await login(SLUG_A, `${SLUG_A}@example.test`, PASSWORD);
  bToken = await login(SLUG_B, `${SLUG_B}@example.test`, PASSWORD);

  const baner = await A.post('/api/v1/branches', { name: 'Baner', code: 'BANER', city: 'Pune' });
  banerId = baner.body.data.id as string;

  /**
   * A role that can assign roles, scoped to one branch. There is no system role
   * shaped like this — BRANCH_ADMIN deliberately holds `iam.role.read` and not
   * `iam.permission.assign` — and it is the only way to exercise the
   * branch-scoped write path, which is the point of the suite.
   */
  const created = await A.post('/api/v1/roles', {
    code: 'SCOPED_IAM',
    name: 'Scoped access manager',
    scopeLevel: 'BRANCH',
    permissionCodes: ['iam.user.read', 'iam.role.read', 'iam.permission.assign', 'branch.read'],
  });
  scopedRoleId = created.body.data.id as string;

  /**
   * A role the scoped manager may actually hand out.
   *
   * "You cannot grant what you do not hold" is checked before the branch scope
   * is, so a role carrying anything outside the scoped manager's own set — even
   * NURSE — is refused on those grounds and never reaches the branch check.
   * This one is a strict subset of what they hold, which is what makes the
   * branch-scope cases below test the branch scope.
   */
  const deskView = await A.post('/api/v1/roles', {
    code: 'DESK_VIEW',
    name: 'Desk view',
    scopeLevel: 'BRANCH',
    permissionCodes: ['branch.read'],
  });
  deskViewRoleId = deskView.body.data.id as string;

  scopedToken = await joinAs(SCOPED_EMAIL, 'Scoped Manager', scopedRoleId, [orgA.branchId]);
  targetToken = await joinAs(TARGET_EMAIL, 'Target Person', await roleIdFor('RECEPTIONIST'), [
    orgA.branchId,
  ]);
  adminToken = await joinAs(ADMIN_EMAIL, 'Org Admin', await roleIdFor('ORG_ADMIN'), []);

  targetMembershipId = await membershipIdFor(TARGET_EMAIL);
  ownerMembershipId = await membershipIdFor(`${SLUG_A}@example.test`);
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);

  const { rows } = await owner.query<{ id: string }>('SELECT id FROM users WHERE email LIKE $1', [
    `%${SUFFIX}@example.test`,
  ]);
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

describe('the role catalogue', () => {
  it('lists the system roles alongside the clinic’s own, and never a platform one', async () => {
    const res = await A.get('/api/v1/roles');
    expect(res.status).toBe(200);

    const codes = (res.body.data.roles as { code: string }[]).map((r) => r.code);
    expect(codes).toContain('DOCTOR');
    expect(codes).toContain('SCOPED_IAM');
    // A clinic that could assign SUPER_ADMIN would own the platform.
    expect(codes).not.toContain('SUPER_ADMIN');
  });

  it('offers no platform permission in the catalogue', async () => {
    const res = await A.get('/api/v1/roles');
    const modules = (res.body.data.permissions as { module: string }[]).map((p) => p.module);
    expect(modules).not.toContain('platform');
    expect(res.body.data.permissions.length).toBeGreaterThan(50);
  });

  it('marks a system role as one, and the clinic’s own as not', async () => {
    const res = await A.get('/api/v1/roles');
    const roles = res.body.data.roles as { code: string; isSystem: boolean; memberCount: number }[];
    expect(roles.find((r) => r.code === 'DOCTOR')?.isSystem).toBe(true);
    expect(roles.find((r) => r.code === 'SCOPED_IAM')?.isSystem).toBe(false);
    // The scoped manager holds it.
    expect(roles.find((r) => r.code === 'SCOPED_IAM')?.memberCount).toBe(1);
  });
});

describe('creating and editing a role', () => {
  it('refuses a code that shadows a system role, and says which', async () => {
    const res = await A.post('/api/v1/roles', {
      code: 'DOCTOR',
      name: 'Our doctors',
      scopeLevel: 'BRANCH',
      permissionCodes: ['patient.read'],
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/reserved/i);
  });

  it('refuses a duplicate code within the clinic', async () => {
    const res = await A.post('/api/v1/roles', {
      code: 'SCOPED_IAM',
      name: 'Another one',
      scopeLevel: 'BRANCH',
      permissionCodes: ['patient.read'],
    });
    expect(res.status).toBe(409);
  });

  it('refuses a permission that is not in the catalogue', async () => {
    const res = await A.post('/api/v1/roles', {
      code: 'MADE_UP',
      name: 'Made up',
      scopeLevel: 'BRANCH',
      permissionCodes: ['patient.read', 'patient.teleport'],
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/patient\.teleport/);
  });

  it('refuses to edit a system role', async () => {
    const res = await A.patch(`/api/v1/roles/${await roleIdFor('DOCTOR')}`, {
      name: 'Doctors, but ours',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/built-in/i);
  });

  it('replaces the permission set wholesale — an omitted code is removed', async () => {
    const created = await A.post('/api/v1/roles', {
      code: 'FRONT_DESK_LITE',
      name: 'Front desk (bookings only)',
      scopeLevel: 'BRANCH',
      permissionCodes: ['patient.read', 'appointment.read', 'appointment.create'],
    });
    expect(created.status).toBe(201);

    const updated = await A.patch(`/api/v1/roles/${created.body.data.id as string}`, {
      permissionCodes: ['patient.read', 'appointment.read'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissionCodes).toEqual(['appointment.read', 'patient.read']);
  });

  it('deletes a role nobody holds', async () => {
    const res = await A.delete(
      `/api/v1/roles/${(await A.get('/api/v1/roles')).body.data.roles.find((r: { code: string }) => r.code === 'FRONT_DESK_LITE').id}`
    );
    expect(res.status).toBe(200);
  });

  /**
   * Found by curling the demo clinic, not by a test: a doctor working at two
   * branches has two DOCTOR rows in `membership_roles` — that is what the branch
   * column is for — and counting rows reported "held by 2 people" for one
   * person. Every test passed, because none of them had anyone holding a role
   * at more than one branch.
   */
  it('counts the people holding a role, not the rows naming it', async () => {
    const twoBranches = await A.post('/api/v1/roles', {
      code: 'ROVING_NURSE',
      name: 'Roving nurse',
      scopeLevel: 'BRANCH',
      permissionCodes: ['patient.read'],
    });
    const roleId = twoBranches.body.data.id as string;
    expect(twoBranches.body.data.memberCount).toBe(0);

    for (const branchId of [orgA.branchId, banerId]) {
      const assigned = await A.post(`/api/v1/members/${targetMembershipId}/roles`, {
        roleId,
        branchId,
      });
      expect(assigned.status).toBe(201);
    }

    const roles = await A.get('/api/v1/roles');
    const role = (roles.body.data.roles as { code: string; memberCount: number }[]).find(
      (r) => r.code === 'ROVING_NURSE'
    );
    // Two assignments, one person.
    expect(role?.memberCount).toBe(1);

    const refused = await A.delete(`/api/v1/roles/${roleId}`);
    expect(refused.body.message).toMatch(/held by 1 person/i);

    // Leave the target as the rest of the suite expects to find them.
    const member = await A.get(`/api/v1/members/${targetMembershipId}`);
    for (const assignment of (member.body.data.roles as { id: string; roleCode: string }[]).filter(
      (r) => r.roleCode === 'ROVING_NURSE'
    )) {
      await A.delete(`/api/v1/members/${targetMembershipId}/roles/${assignment.id}`);
    }
    await A.delete(`/api/v1/roles/${roleId}`);
  });

  it('refuses to delete a role somebody still holds', async () => {
    // membership_roles.role_id cascades, so this would silently strip it.
    const res = await A.delete(`/api/v1/roles/${scopedRoleId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/held by 1 person/i);
  });

  it('never shows one clinic’s custom role to another', async () => {
    const res = await B.get('/api/v1/roles');
    const codes = (res.body.data.roles as { code: string }[]).map((r) => r.code);
    expect(codes).not.toContain('SCOPED_IAM');
  });

  it('answers 404 — never 403 — for another clinic’s role by id', async () => {
    const res = await B.patch(`/api/v1/roles/${scopedRoleId}`, { name: 'Mine now' });
    expect(res.status).toBe(404);
  });
});

describe('the members list', () => {
  it('lists everyone who joined, and nobody from the other clinic', async () => {
    const res = await A.get('/api/v1/members');
    expect(res.status).toBe(200);

    const emails = (res.body.data.members as { email: string }[]).map((m) => m.email);
    expect(emails).toEqual(
      expect.arrayContaining([SCOPED_EMAIL, TARGET_EMAIL, ADMIN_EMAIL, `${SLUG_A}@example.test`])
    );
    expect(emails).not.toContain(`${SLUG_B}@example.test`);
  });

  it('marks the caller’s own membership, so the screen can hide the controls', async () => {
    const res = await A.get('/api/v1/members');
    const members = res.body.data.members as { email: string; isSelf: boolean }[];
    expect(members.find((m) => m.email === `${SLUG_A}@example.test`)?.isSelf).toBe(true);
    expect(members.find((m) => m.email === TARGET_EMAIL)?.isSelf).toBe(false);
  });

  it('shows an org-wide assignment as covering no single branch', async () => {
    const res = await A.get('/api/v1/members');
    const admin = (
      res.body.data.members as { email: string; roles: { branchId: string | null }[] }[]
    ).find((m) => m.email === ADMIN_EMAIL);
    expect(admin?.roles).toHaveLength(1);
    expect(admin?.roles[0]?.branchId).toBeNull();
  });

  it('answers 404 for a membership at another clinic', async () => {
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM memberships WHERE organization_id = $1 LIMIT 1',
      [orgB.organizationId]
    );
    const res = await A.get(`/api/v1/members/${rows[0]?.id ?? ''}`);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed membership id before touching the database', async () => {
    const res = await A.get('/api/v1/members/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('the branch-scoped caller', () => {
  it('cannot assign a role at a branch it does not manage', async () => {
    // Without the guard this is a 500: the policy's WITH CHECK refuses the
    // INSERT. 404 is the right answer, because a branch out of scope is one
    // that does not exist as far as this caller is concerned.
    const res = await Scoped.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: deskViewRoleId,
      branchId: banerId,
    });
    expect(res.status).toBe(404);
  });

  it('cannot make an org-wide assignment, which would reach every branch', async () => {
    const res = await Scoped.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: deskViewRoleId,
      branchId: null,
    });
    // 403, not 404: nothing is hidden, and naming branches explicitly is the fix.
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/branches you manage/i);
  });

  it('cannot hand out a role carrying permissions it does not hold', async () => {
    const res = await Scoped.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: await roleIdFor('ORG_OWNER'),
      branchId: orgA.branchId,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not hold/i);
  });

  it('is told its own scope covers only part of the clinic', async () => {
    const res = await Scoped.get('/api/v1/members');
    expect(res.body.data.canAssignOrgWide).toBe(false);
    expect(res.body.data.branches).toHaveLength(1);
  });

  it('can assign within the branch it does manage', async () => {
    const res = await Scoped.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: deskViewRoleId,
      branchId: orgA.branchId,
    });
    expect(res.status).toBe(201);
    expect((res.body.data.roles as { roleCode: string }[]).map((r) => r.roleCode)).toContain(
      'DESK_VIEW'
    );
  });

  it('refuses the same assignment twice', async () => {
    const res = await Scoped.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: deskViewRoleId,
      branchId: orgA.branchId,
    });
    expect(res.status).toBe(409);
  });
});

describe('nobody edits their own access', () => {
  it('refuses a self-assignment', async () => {
    const res = await A.post(`/api/v1/members/${ownerMembershipId}/roles`, {
      roleId: await roleIdFor('DOCTOR'),
      branchId: orgA.branchId,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own access/i);
  });

  it('refuses self-suspension', async () => {
    const res = await A.post(`/api/v1/members/${ownerMembershipId}/suspend`, {});
    expect(res.status).toBe(403);
  });
});

describe('a grant takes effect on the next request, not on the next cache miss', () => {
  it('starts with the target unable to read the staff list', async () => {
    // This populates the access cache, which is what makes the next case a real
    // test of invalidation rather than an accident of timing.
    const res = await Target.get('/api/v1/members');
    expect(res.status).toBe(403);
  });

  it('lets them in immediately after the role is granted — same token', async () => {
    const granted = await A.post(`/api/v1/members/${targetMembershipId}/roles`, {
      roleId: scopedRoleId,
      branchId: orgA.branchId,
    });
    expect(granted.status).toBe(201);

    const res = await Target.get('/api/v1/members');
    expect(res.status).toBe(200);
  });

  it('shuts them out again the moment a DENY override is written', async () => {
    const denied = await A.post(`/api/v1/members/${targetMembershipId}/overrides`, {
      permissionCode: 'iam.user.read',
      branchId: orgA.branchId,
      effect: 'DENY',
      reason: 'Covering the front desk this week',
    });
    expect(denied.status).toBe(200);
    expect(denied.body.data.overrides).toHaveLength(1);

    // DENY beats the role grant. Resolved per request, so the same token that
    // worked a line ago does not now.
    const res = await Target.get('/api/v1/members');
    expect(res.status).toBe(403);
  });

  it('flips the same override rather than creating a second row', async () => {
    const flipped = await A.post(`/api/v1/members/${targetMembershipId}/overrides`, {
      permissionCode: 'iam.user.read',
      branchId: orgA.branchId,
      effect: 'GRANT',
    });
    expect(flipped.status).toBe(200);
    // The unique is (membership, permission, branch) with NULLS NOT DISTINCT —
    // one row, whichever way its effect points.
    expect(flipped.body.data.overrides).toHaveLength(1);
    expect(flipped.body.data.overrides[0].effect).toBe('GRANT');
  });

  it('clears the override and leaves the role grant standing', async () => {
    const member = await A.get(`/api/v1/members/${targetMembershipId}`);
    const overrideId = member.body.data.overrides[0].id as string;

    const cleared = await A.delete(`/api/v1/members/${targetMembershipId}/overrides/${overrideId}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.overrides).toEqual([]);

    const res = await Target.get('/api/v1/members');
    expect(res.status).toBe(200);
  });

  it('takes the access away with the role', async () => {
    const member = await A.get(`/api/v1/members/${targetMembershipId}`);
    const assignment = (member.body.data.roles as { id: string; roleCode: string }[]).find(
      (r) => r.roleCode === 'SCOPED_IAM'
    );

    const revoked = await A.delete(
      `/api/v1/members/${targetMembershipId}/roles/${assignment?.id ?? ''}`
    );
    expect(revoked.status).toBe(200);

    const res = await Target.get('/api/v1/members');
    expect(res.status).toBe(403);
  });
});

describe('suspension', () => {
  it('cuts a member off with their access token still live', async () => {
    const suspended = await A.post(`/api/v1/members/${targetMembershipId}/suspend`, {
      reason: 'Left the practice',
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.status).toBe('SUSPENDED');

    // 401, not 403: loadUserAccess only returns an ACTIVE membership, so
    // `authenticate` decides they have no access to this organization at all.
    // `/auth/session` is the probe rather than a permissioned route: it needs
    // only authenticate + requireAuth, so a 401 here is unambiguously "this
    // person no longer has access to this organization" and not a missing
    // permission.
    const res = await Target.get('/api/v1/auth/session');
    expect(res.status).toBe(401);
  });

  it('refuses to suspend the same person twice', async () => {
    const res = await A.post(`/api/v1/members/${targetMembershipId}/suspend`, {});
    expect(res.status).toBe(409);
  });

  it('gives everything back on reactivation', async () => {
    const restored = await A.post(`/api/v1/members/${targetMembershipId}/reactivate`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe('ACTIVE');

    const res = await Target.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
  });

  it('will not leave the clinic without an owner', async () => {
    // The org admin holds iam.user.suspend and is not the owner, so this is the
    // one route to the last-owner state that the self-check does not already
    // block.
    const res = await OrgAdmin.post(`/api/v1/members/${ownerMembershipId}/suspend`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/without an owner/i);
  });

  it('will not let the last owner’s role be revoked either', async () => {
    const member = await A.get(`/api/v1/members/${ownerMembershipId}`);
    const assignment = (member.body.data.roles as { id: string; roleCode: string }[]).find(
      (r) => r.roleCode === 'ORG_OWNER'
    );

    const res = await OrgAdmin.delete(
      `/api/v1/members/${ownerMembershipId}/roles/${assignment?.id ?? ''}`
    );
    expect(res.status).toBe(409);
  });
});

describe('the employment record', () => {
  it('sets the fields the invitation had nowhere to put', async () => {
    const res = await A.patch(`/api/v1/members/${targetMembershipId}`, {
      employeeCode: 'EMP-0042',
      department: 'Front office',
      joinedOn: '2026-04-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      employeeCode: 'EMP-0042',
      department: 'Front office',
      joinedOn: '2026-04-01',
    });
  });

  it('clears a field with null, which is not the same as omitting it', async () => {
    const res = await A.patch(`/api/v1/members/${targetMembershipId}`, { department: null });
    expect(res.status).toBe(200);
    expect(res.body.data.department).toBeNull();
    // Untouched, because it was not mentioned.
    expect(res.body.data.employeeCode).toBe('EMP-0042');
  });
});

describe('the audit trail', () => {
  it('records a permission change as codes and ids, never as a name', async () => {
    const { rows } = await owner.query<{
      action: string;
      entity_type: string;
      after_data: Record<string, unknown> | null;
    }>(
      `SELECT action, entity_type, after_data FROM audit_logs
       WHERE organization_id = $1 AND entity_type = 'membership_role'
         AND after_data IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows[0]?.action).toBe('PERMISSION_CHANGE');
    const after = rows[0]?.after_data ?? {};
    expect(after['roleCode']).toBeDefined();
    const serialised = JSON.stringify(after);
    expect(serialised).not.toContain('Target Person');
    expect(serialised).not.toContain(TARGET_EMAIL);
  });
});
