/**
 * Doctors over real HTTP, through the real middleware chain.
 *
 * Beyond "CRUD works", four things are being pinned down:
 *
 *   1. The masters are a PLATFORM catalogue with per-tenant extension. Both
 *      clinics see the same seeded specialties, neither can write a
 *      platform-wide one, and neither can see the other's private additions.
 *   2. `doctor_profiles.user_id` is unique PER ORGANIZATION, not globally. The
 *      design ERD draws a bare unique, which would stop a doctor consulting at
 *      two clinics — and the failure would appear only at the second one.
 *   3. Overlapping working hours are refused by Postgres, and the 409 that
 *      surfaces never quotes the constraint DETAIL (which names the conflicting
 *      doctor and range, possibly one this caller cannot see).
 *   4. Asking for leave and granting it are different permissions.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `d${Date.now().toString(36)}`;
const SLUG_A = `doc-a-${SUFFIX}`;
const SLUG_B = `doc-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

/** The one specialty id both clinics can legitimately use. */
let generalMedicineId: string;
let mbbsId: string;

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
  return res.body.data.accessToken as string;
}

const asOrg = (slug: string, token: string) => ({
  get: (path: string) =>
    request(app)
      .get(`/api/v1/doctors${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(app)
      .post(`/api/v1/doctors${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  patch: (path: string, body: object) =>
    request(app)
      .patch(`/api/v1/doctors${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  put: (path: string, body: object) =>
    request(app)
      .put(`/api/v1/doctors${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  delete: (path: string) =>
    request(app)
      .delete(`/api/v1/doctors${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
});

/**
 * A member of clinic A with no doctor profile, made directly through the owner
 * connection.
 *
 * Registering a doctor consumes a member, so a case that needs a fresh one
 * cannot reuse the org owner. Ids are collected so `afterAll` removes the users
 * it created — `organizations` cascades to `memberships`, but `users` is global
 * and outlives the clinic.
 */
const extraUserIds: string[] = [];

async function memberOfA(label: string): Promise<string> {
  const created = await owner.query<{ id: string }>(
    `INSERT INTO users (id, full_name, email, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [label, `${label.toLowerCase().replace(/\s+/g, '-')}-${SUFFIX}@example.test`]
  );
  const id = created.rows[0]?.id as string;
  extraUserIds.push(id);

  await owner.query(
    `INSERT INTO memberships (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now())`,
    [orgA.organizationId, id]
  );

  return id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Doc A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Doc B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));

  const spec = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'GENERAL_MEDICINE'`
  );
  generalMedicineId = spec.rows[0]?.id as string;

  const qual = await owner.query<{ id: string }>(
    `SELECT id FROM qualifications WHERE organization_id IS NULL AND code = 'MBBS'`
  );
  mbbsId = qual.rows[0]?.id as string;
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId, ...extraUserIds].filter(Boolean);

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

describe('the masters catalogue', () => {
  it('serves the seeded platform specialties to every clinic', async () => {
    const res = await A.get('/masters');

    expect(res.status).toBe(200);
    const codes = res.body.data.specialties.map((s: { code: string }) => s.code);
    expect(codes).toContain('GENERAL_MEDICINE');
    expect(codes).toContain('CARDIOLOGY');
    // Platform rows are not editable by the clinic.
    const general = res.body.data.specialties.find(
      (s: { code: string }) => s.code === 'GENERAL_MEDICINE'
    );
    expect(general.isOwn).toBe(false);
  });

  it('carries the sub-specialty hierarchy', async () => {
    const res = await A.get('/masters');
    const trichology = res.body.data.specialties.find(
      (s: { code: string }) => s.code === 'TRICHOLOGY'
    );
    const dermatology = res.body.data.specialties.find(
      (s: { code: string }) => s.code === 'DERMATOLOGY'
    );
    expect(trichology.parentId).toBe(dermatology.id);
  });

  it('serves the same catalogue to both clinics', async () => {
    const forA = await A.get('/masters');
    const forB = await B.get('/masters');
    expect(forA.body.data.specialties.length).toBe(forB.body.data.specialties.length);
  });

  /*
   * The disclosure this policy exists to prevent. A clinic's own specialty is
   * private; if the RLS policy were the permissive `files` one, org B would
   * both see it and be able to add rows every tenant could read.
   */
  it("does not show one clinic another's private specialty", async () => {
    await owner.query(
      `INSERT INTO specialties (id, organization_id, code, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'SECRET_SPEC', 'Secret', now())`,
      [orgB.organizationId]
    );

    const res = await A.get('/masters');
    const codes = res.body.data.specialties.map((s: { code: string }) => s.code);
    expect(codes).not.toContain('SECRET_SPEC');

    const forB = await B.get('/masters');
    const own = forB.body.data.specialties.find((s: { code: string }) => s.code === 'SECRET_SPEC');
    expect(own.isOwn).toBe(true);
  });
});

describe('creating a doctor', () => {
  it('creates a profile against an existing member', async () => {
    const res = await A.post('/', {
      userId: orgA.ownerUserId,
      registrationNumber: 'MCI-11111',
      registrationCouncil: 'Maharashtra Medical Council',
      experienceYears: 12,
      specialtyIds: [generalMedicineId],
      primarySpecialtyId: generalMedicineId,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      userId: orgA.ownerUserId,
      status: 'ACTIVE',
      registrationNumber: 'MCI-11111',
      primarySpecialty: 'General Medicine',
    });
  });

  it('refuses a second profile for the same person', async () => {
    const res = await A.post('/', { userId: orgA.ownerUserId, specialtyIds: [] });
    expect(res.status).toBe(409);
  });

  it('refuses a user who is not a member of this clinic', async () => {
    // 404, not 403: the caller must not learn whether that user exists at all.
    const res = await A.post('/', { userId: orgB.ownerUserId, specialtyIds: [] });
    expect(res.status).toBe(404);
  });

  it('refuses a primary specialty that is not in the selected set', async () => {
    const res = await B.post('/', {
      userId: orgB.ownerUserId,
      specialtyIds: [],
      primarySpecialtyId: generalMedicineId,
    });
    expect(res.status).toBe(400);
  });

  /*
   * The ERD draws `user_id UK` — a GLOBAL unique. `users` is global here (one
   * login spans organizations), so that would mean a doctor consulting at two
   * clinics can hold exactly one profile, and the failure appears only when the
   * SECOND clinic onboards them.
   */
  it('lets the same person be a doctor at two different clinics', async () => {
    const shared = await owner.query<{ id: string }>(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES (gen_random_uuid(), 'Shared Consultant', $1, now()) RETURNING id`,
      [`shared-${SUFFIX}@example.test`]
    );
    const sharedId = shared.rows[0]?.id as string;

    for (const org of [orgA, orgB]) {
      await owner.query(
        `INSERT INTO memberships (id, organization_id, user_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now())`,
        [org.organizationId, sharedId]
      );
    }

    const inA = await A.post('/', { userId: sharedId, specialtyIds: [] });
    const inB = await B.post('/', { userId: sharedId, specialtyIds: [] });

    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);
    expect(inA.body.data.id).not.toBe(inB.body.data.id);
  });

  /*
   * ⚠️ THE REGRESSION THAT SHIPPED, AND IT LOOKED LIKE A CODE BUG BECAUSE THE
   *   MESSAGE NAMED NOTHING. `(organization_id, registration_number)` was
   *   created NULLS NOT DISTINCT, so the two NULLs COLLIDED and a clinic could
   *   hold exactly ONE doctor awaiting a council number. The second registration
   *   came back 409 "A record with this value already exists" — the middleware's
   *   bare P2002 text — for a field the admin had deliberately left blank.
   *
   *   Registering two doctors before either council number is to hand is
   *   ordinary, and the column is nullable precisely to allow it.
   */
  it('registers two doctors whose council numbers are not yet to hand', async () => {
    const first = await A.post('/', { userId: await memberOfA('Pending One'), specialtyIds: [] });
    const second = await A.post('/', { userId: await memberOfA('Pending Two'), specialtyIds: [] });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.registrationNumber ?? null).toBeNull();
    expect(second.body.data.registrationNumber ?? null).toBeNull();
  });

  /*
   * The other half of the same index: narrowing it to live rows must not narrow
   * what it was actually for. A council number that IS present is still one
   * doctor's, and the clinic's owner already holds MCI-11111.
   */
  it('still refuses a council number another doctor at this clinic holds', async () => {
    const res = await A.post('/', {
      userId: await memberOfA('Duplicate Council'),
      registrationNumber: 'MCI-11111',
      specialtyIds: [],
    });

    expect(res.status).toBe(409);
  });

  /*
   * ⚠️ THE SAME SHAPE ON `(organization_id, user_id)`. `archiveDoctor` SOFT
   *   deletes — status ARCHIVED, `deleted_at` stamped — while the create path's
   *   pre-check reads `deleted_at IS NULL`. So this passed the friendly check
   *   ("That person already has a doctor profile") and died one statement later
   *   on the total index, under the same anonymous 409. A doctor who left and
   *   came back was unrecordable.
   */
  it('registers a doctor again after they were retired', async () => {
    const userId = await memberOfA('Returning Consultant');

    const first = await A.post('/', { userId, specialtyIds: [] });
    expect(first.status).toBe(201);

    const retired = await A.delete(`/${first.body.data.id}`);
    expect(retired.status).toBe(200);

    const again = await A.post('/', { userId, specialtyIds: [] });
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(first.body.data.id);
  });

  /* And a LIVE profile is still one per person per clinic — see the case above. */
  it('still refuses a second live profile for the same person', async () => {
    const userId = await memberOfA('Twice Registered');

    expect((await A.post('/', { userId, specialtyIds: [] })).status).toBe(201);
    expect((await A.post('/', { userId, specialtyIds: [] })).status).toBe(409);
  });
});

/**
 * The picker on the /doctors screen.
 *
 * ⚠️ THE BUG THIS PINS DOWN SHIPPED, and it was invisible in review because the
 *   list was populated and sorted and looked entirely reasonable. The screen
 *   built its candidates client-side out of `GET /api/v1/members` and filtered
 *   only on "ACTIVE, and has no profile yet" — so it offered the pharmacist, the
 *   receptionist and the administrator as doctors.
 *
 * ⚠️ AND THE FILTER IS A PERMISSION, NOT A ROLE NAMED `DOCTOR` (ADR-0002). A
 *   clinic that clones DOCTOR into "Senior Consultant" must keep seeing those
 *   people; a clinic that grants authoring to one locum's membership must see
 *   that locum. Both cases are asserted below, because a `roleCode === 'DOCTOR'`
 *   implementation passes a naive test and fails both of them.
 */
describe('who can be made a doctor', () => {
  /** Holds DOCTOR, so authoring comes from the ROLE. */
  let consultantId: string;
  /** Holds RECEPTIONIST, and must never be offered. */
  let receptionistId: string;
  /** Holds RECEPTIONIST plus a GRANT override for authoring, so must be offered. */
  let locumId: string;
  /** Holds DOCTOR but is DENIED authoring, so must NOT be offered. */
  let suspendedConsultantId: string;

  async function member(name: string, roleCode: string): Promise<string> {
    const user = await owner.query<{ id: string }>(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${SUFFIX}@example.test`]
    );
    const userId = user.rows[0]?.id as string;

    const membership = await owner.query<{ id: string }>(
      `INSERT INTO memberships (id, organization_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
      [orgA.organizationId, userId]
    );

    await owner.query(
      `INSERT INTO membership_roles (id, membership_id, organization_id, role_id, branch_id)
       SELECT gen_random_uuid(), $1, $2, r.id, NULL FROM roles r WHERE r.code = $3`,
      [membership.rows[0]?.id, orgA.organizationId, roleCode]
    );

    return userId;
  }

  async function override(userId: string, effect: 'GRANT' | 'DENY'): Promise<void> {
    await owner.query(
      `INSERT INTO membership_permission_overrides
         (id, membership_id, organization_id, permission_id, branch_id, effect)
       SELECT gen_random_uuid(), m.id, $1, p.id, NULL, $3::"OverrideEffect"
         FROM memberships m, permissions p
        WHERE m.organization_id = $1 AND m.user_id = $2
          AND p.code = 'clinical.encounter.create'`,
      [orgA.organizationId, userId, effect]
    );
  }

  beforeAll(async () => {
    consultantId = await member('Candidate Consultant', 'DOCTOR');
    receptionistId = await member('Candidate Receptionist', 'RECEPTIONIST');
    locumId = await member('Candidate Locum', 'RECEPTIONIST');
    suspendedConsultantId = await member('Candidate Barred', 'DOCTOR');
    await override(locumId, 'GRANT');
    await override(suspendedConsultantId, 'DENY');
  });

  it('offers a member whose role lets them write consultations', async () => {
    const res = await A.get('/candidates');

    expect(res.status).toBe(200);
    expect(res.body.data.candidates.map((c: { userId: string }) => c.userId)).toContain(
      consultantId
    );
  });

  /** The reported bug, stated as an assertion. */
  it('does not offer the front desk', async () => {
    const res = await A.get('/candidates');

    expect(res.body.data.candidates.map((c: { userId: string }) => c.userId)).not.toContain(
      receptionistId
    );
  });

  /**
   * ⚠️ THE CASE A ROLE-NAME FILTER GETS WRONG. This person's role is
   *   RECEPTIONIST; authoring was granted on their membership, which is exactly
   *   how CLAUDE.md says a clinic widens the default.
   */
  it('offers somebody granted authoring on their own membership', async () => {
    const res = await A.get('/candidates');

    expect(res.body.data.candidates.map((c: { userId: string }) => c.userId)).toContain(locumId);
  });

  /** DENY beats the role grant, the same order `effectivePermissions` applies. */
  it('does not offer somebody the clinic has denied authoring', async () => {
    const res = await A.get('/candidates');

    expect(res.body.data.candidates.map((c: { userId: string }) => c.userId)).not.toContain(
      suspendedConsultantId
    );
  });

  it('drops somebody once they have a profile', async () => {
    const before = await A.get('/candidates');
    expect(before.body.data.candidates.map((c: { userId: string }) => c.userId)).toContain(
      consultantId
    );

    /*
     * ⚠️ A REGISTRATION NUMBER IS REQUIRED HERE OR THIS 409s, AND THE REASON IS
     *   NOT ABOUT CANDIDATES. `doctor_profiles` carries
     *   `(organization_id, registration_number) NULLS NOT DISTINCT`, so a clinic
     *   may hold at most ONE doctor with no council number — and an earlier case
     *   in this file already used up that slot for org A. Passing one keeps this
     *   test about the picker rather than about that constraint.
     */
    const created = await A.post('/', {
      userId: consultantId,
      registrationNumber: `MCI-${SUFFIX}`,
      specialtyIds: [],
    });
    expect(created.status).toBe(201);

    const after = await A.get('/candidates');
    expect(after.body.data.candidates.map((c: { userId: string }) => c.userId)).not.toContain(
      consultantId
    );
  });

  it("shows nothing of another clinic's people", async () => {
    const res = await B.get('/candidates');

    const ids = res.body.data.candidates.map((c: { userId: string }) => c.userId);
    for (const id of [consultantId, receptionistId, locumId]) expect(ids).not.toContain(id);
  });
});

describe('working hours', () => {
  let doctorId: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorId = res.body.data.doctors[0].id as string;
  });

  it('adds a block and resolves its effective slot length', async () => {
    const res = await A.post(`/${doctorId}/schedules`, {
      branchId: orgA.branchId,
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '13:00',
      validFrom: '2026-01-01',
    });
    expect(res.status).toBe(201);

    const list = await A.get(`/${doctorId}/schedules`);
    expect(list.body.data.schedules[0]).toMatchObject({
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '13:00',
      // Inherited: no per-block override, so the seeded default applies.
      slotMinutes: null,
      effectiveSlotMinutes: 15,
    });
  });

  it('round-trips the clock time without a timezone shift', async () => {
    // The scar this guards: building a Date from local components instead of
    // UTC turns 09:00 into 03:30 on an IST server, silently.
    const list = await A.get(`/${doctorId}/schedules`);
    expect(list.body.data.schedules[0].startTime).toBe('09:00');
  });

  it('refuses an overlapping block', async () => {
    const res = await A.post(`/${doctorId}/schedules`, {
      branchId: orgA.branchId,
      dayOfWeek: 1,
      startTime: '12:00',
      endTime: '17:00',
      validFrom: '2026-01-01',
    });

    expect(res.status).toBe(409);
    // Never the constraint DETAIL: it names the conflicting doctor and range,
    // which under branch scoping may be a row this caller cannot see.
    expect(res.body.message).not.toMatch(/doctor_schedules_no_overlap|conflicts with existing/i);
    expect(res.body.message).toMatch(/overlap/i);
  });

  it('allows a back-to-back block', async () => {
    // 13:00 start against a 13:00 end. The '[)' bound is what makes this work;
    // with '[]' the afternoon clinic would be unbookable.
    const res = await A.post(`/${doctorId}/schedules`, {
      branchId: orgA.branchId,
      dayOfWeek: 1,
      startTime: '13:00',
      endTime: '17:00',
      validFrom: '2026-01-01',
    });
    expect(res.status).toBe(201);
  });

  it('refuses an overnight block at the contract', async () => {
    const res = await A.post(`/${doctorId}/schedules`, {
      branchId: orgA.branchId,
      dayOfWeek: 2,
      startTime: '22:00',
      endTime: '06:00',
      validFrom: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it("refuses a branch outside the caller's scope", async () => {
    const res = await A.post(`/${doctorId}/schedules`, {
      branchId: orgB.branchId,
      dayOfWeek: 3,
      startTime: '09:00',
      endTime: '12:00',
      validFrom: '2026-01-01',
    });
    // 404, never 403.
    expect(res.status).toBe(404);
  });

  it('honours a per-block slot override', async () => {
    await A.post(`/${doctorId}/schedules`, {
      branchId: orgA.branchId,
      dayOfWeek: 4,
      startTime: '10:00',
      endTime: '12:00',
      slotMinutes: 30,
      validFrom: '2026-01-01',
    });

    const list = await A.get(`/${doctorId}/schedules`);
    const thursday = list.body.data.schedules.find((s: { dayOfWeek: number }) => s.dayOfWeek === 4);
    expect(thursday).toMatchObject({ slotMinutes: 30, effectiveSlotMinutes: 30 });
  });
});

/**
 * The week, and "same as the clinic" (DS-1).
 *
 * ⚠️ THE ASSERTIONS THAT MATTER ARE THE AVAILABILITY ONES, NOT THE CRUD ONES. A
 *   flag that saves and reads back correctly while the engine ignores it is a
 *   doctor whose diary is empty for reasons nobody can see — so every case here
 *   ends at `GET /appointments/availability`, which is what the front desk
 *   actually experiences.
 */
describe("a doctor's week", () => {
  let weekDoctorId: string;

  beforeAll(async () => {
    const user = await owner.query<{ id: string }>(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES (gen_random_uuid(), 'Week Doctor', $1, now()) RETURNING id`,
      [`week-${SUFFIX}@example.test`]
    );
    const userId = user.rows[0]?.id as string;

    /* A profile can only be created against a MEMBER — see `createDoctorRecord`. */
    await owner.query(
      `INSERT INTO memberships (id, organization_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [orgA.organizationId, userId]
    );

    const created = await A.post('/', {
      userId,
      /* Required: only ONE profile per clinic may have a null one. See the note
         in the candidates block above. */
      registrationNumber: `MCI-WEEK-${SUFFIX}`,
      specialtyIds: [],
    });
    expect(created.status).toBe(201);
    weekDoctorId = created.body.data.id as string;
  }, 20_000);

  it('starts with an empty week and no clinic-hours flag', async () => {
    const res = await A.get(`/${weekDoctorId}/week?branchId=${orgA.branchId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.followsBranchHours).toBe(false);
    expect(res.body.data.days).toHaveLength(7);
    expect(res.body.data.days.every((d: { morning: null }) => d.morning === null)).toBe(true);
  });

  it('saves a morning and an evening session on one day', async () => {
    const res = await A.put(`/${weekDoctorId}/week`, {
      branchId: orgA.branchId,
      followsBranchHours: false,
      validFrom: '2026-01-01',
      days: [
        {
          dayOfWeek: 1,
          morning: { startTime: '09:00', endTime: '13:00' },
          evening: { startTime: '17:00', endTime: '20:00' },
          slotMinutes: 15,
          maxPatients: 30,
        },
      ],
    });

    expect(res.status).toBe(200);
    const monday = res.body.data.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 1);
    expect(monday.morning).toEqual({ startTime: '09:00', endTime: '13:00' });
    expect(monday.evening).toEqual({ startTime: '17:00', endTime: '20:00' });
  });

  /**
   * ⚠️ THE OVERLAP THE OLD BLOCK FORM COULD PRODUCE. Two periods that overlap
   *   would make the engine emit the shared hour's slots twice — two bookable
   *   13:30s for one doctor, which no screen can render and no constraint would
   *   have caught, because they are not the same block.
   */
  it('refuses an evening session that starts before the morning ends', async () => {
    const res = await A.put(`/${weekDoctorId}/week`, {
      branchId: orgA.branchId,
      followsBranchHours: false,
      days: [
        {
          dayOfWeek: 2,
          morning: { startTime: '09:00', endTime: '17:00' },
          evening: { startTime: '13:00', endTime: '20:00' },
          slotMinutes: null,
          maxPatients: null,
        },
      ],
    });

    expect(res.status).toBe(400);
  });

  it('replaces the week rather than adding to it', async () => {
    await A.put(`/${weekDoctorId}/week`, {
      branchId: orgA.branchId,
      followsBranchHours: false,
      days: [
        {
          dayOfWeek: 3,
          morning: { startTime: '10:00', endTime: '12:00' },
          evening: null,
          slotMinutes: null,
          maxPatients: null,
        },
      ],
    });

    const res = await A.get(`/${weekDoctorId}/week?branchId=${orgA.branchId}`);
    const withHours = res.body.data.days.filter((d: { morning: unknown }) => d.morning !== null);

    // Monday from the earlier case is gone; only Wednesday remains.
    expect(withHours).toHaveLength(1);
    expect(withHours[0].dayOfWeek).toBe(3);
  });

  /**
   * ⚠️ THE POINT OF THE WHOLE FEATURE. The doctor keeps their own week in the
   *   database and stops being read from it; the engine answers from the
   *   branch's opening hours instead, LIVE. A copy taken at save time would pass
   *   this test and fail the next one.
   */
  it('switches to the clinic’s hours without discarding the week', async () => {
    const res = await A.put(`/${weekDoctorId}/week`, {
      branchId: orgA.branchId,
      followsBranchHours: true,
      days: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.followsBranchHours).toBe(true);

    // The rows are still there, inert.
    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*) AS count FROM doctor_schedules WHERE doctor_profile_id = $1',
      [weekDoctorId]
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('restores the doctor’s own week when the option is turned back off', async () => {
    await A.put(`/${weekDoctorId}/week`, {
      branchId: orgA.branchId,
      followsBranchHours: false,
      days: [
        {
          dayOfWeek: 3,
          morning: { startTime: '10:00', endTime: '12:00' },
          evening: null,
          slotMinutes: null,
          maxPatients: null,
        },
      ],
    });

    const res = await A.get(`/${weekDoctorId}/week?branchId=${orgA.branchId}`);
    expect(res.body.data.followsBranchHours).toBe(false);
    expect(
      res.body.data.days.find((d: { dayOfWeek: number }) => d.dayOfWeek === 3).morning
    ).toEqual({ startTime: '10:00', endTime: '12:00' });
  });

  /**
   * ⚠️ REGISTRATION HAS TO BE ABLE TO SAY THIS TOO, and it could not until the
   *   create form was rebuilt. A doctor registered as "same as the clinic" with
   *   no schedule rows and no branch-setting row is a doctor with NO
   *   availability at all — bookable nowhere, for a reason no screen shows.
   */
  it('registers a doctor already on the clinic’s hours', async () => {
    const user = await owner.query<{ id: string }>(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES (gen_random_uuid(), 'Full Timer', $1, now()) RETURNING id`,
      [`fulltime-${SUFFIX}@example.test`]
    );
    const userId = user.rows[0]?.id as string;
    await owner.query(
      `INSERT INTO memberships (id, organization_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [orgA.organizationId, userId]
    );

    const created = await A.post('/', {
      userId,
      registrationNumber: `MCI-FT-${SUFFIX}`,
      specialtyIds: [],
      followsBranchHours: [orgA.branchId],
    });
    expect(created.status).toBe(201);

    const week = await A.get(`/${created.body.data.id as string}/week?branchId=${orgA.branchId}`);
    expect(week.body.data.followsBranchHours).toBe(true);
  });

  it('refuses to register against another clinic’s branch', async () => {
    const user = await owner.query<{ id: string }>(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES (gen_random_uuid(), 'Wrong Branch', $1, now()) RETURNING id`,
      [`wrongbranch-${SUFFIX}@example.test`]
    );
    const userId = user.rows[0]?.id as string;
    await owner.query(
      `INSERT INTO memberships (id, organization_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [orgA.organizationId, userId]
    );

    const res = await A.post('/', {
      userId,
      registrationNumber: `MCI-WB-${SUFFIX}`,
      specialtyIds: [],
      followsBranchHours: [orgB.branchId],
    });

    expect(res.status).toBe(404);
  });

  it("answers 404 for another clinic's branch", async () => {
    const res = await A.get(`/${weekDoctorId}/week?branchId=${orgB.branchId}`);
    expect(res.status).toBe(404);
  });
});

describe('leave', () => {
  let doctorId: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorId = res.body.data.doctors[0].id as string;
  });

  it('lands as REQUESTED and changes nothing yet', async () => {
    const res = await A.post(`/${doctorId}/exceptions`, {
      exceptionType: 'LEAVE',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-09-05T00:00:00.000Z',
      reason: 'Conference',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('REQUESTED');
  });

  it('becomes APPROVED on a decision, and records who decided', async () => {
    const list = await A.get(`/${doctorId}/exceptions`);
    const pending = list.body.data.exceptions[0];

    const res = await A.post(`/${doctorId}/exceptions/${pending.id}/decision`, {
      decision: 'APPROVED',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', decidedBy: orgA.ownerUserId });
  });

  it('refuses to decide the same request twice', async () => {
    const list = await A.get(`/${doctorId}/exceptions`);
    const decided = list.body.data.exceptions[0];

    const res = await A.post(`/${doctorId}/exceptions/${decided.id}/decision`, {
      decision: 'REJECTED',
    });
    expect(res.status).toBe(409);
  });
});

describe('the tenant boundary', () => {
  let doctorInA: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorInA = res.body.data.doctors[0].id as string;
  });

  it('lists only its own doctors', async () => {
    const forA = await A.get('/');
    const forB = await B.get('/');

    const idsA = forA.body.data.doctors.map((d: { id: string }) => d.id);
    const idsB = forB.body.data.doctors.map((d: { id: string }) => d.id);
    expect(idsA.filter((id: string) => idsB.includes(id))).toHaveLength(0);
  });

  it("answers 404 for another clinic's doctor, not 403", async () => {
    const res = await B.patch(`/${doctorInA}`, { experienceYears: 42 });
    expect(res.status).toBe(404);

    const { rows } = await owner.query<{ experience_years: number }>(
      'SELECT experience_years FROM doctor_profiles WHERE id = $1',
      [doctorInA]
    );
    expect(rows[0]?.experience_years).not.toBe(42);
  });

  it("cannot read another clinic's working hours", async () => {
    const res = await B.get(`/${doctorInA}/schedules`);
    // The doctor is invisible, so the schedule list is simply empty.
    expect(res.status).toBe(200);
    expect(res.body.data.schedules).toHaveLength(0);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/doctors').set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });
});

describe('qualifications', () => {
  let doctorId: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorId = res.body.data.doctors[0].id as string;
  });

  it('adds and removes one', async () => {
    const added = await A.post(`/${doctorId}/qualifications`, {
      qualificationId: mbbsId,
      institute: 'Grant Medical College',
      yearOfCompletion: 2012,
    });
    expect(added.status).toBe(201);

    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM doctor_qualifications WHERE doctor_profile_id = $1',
      [doctorId]
    );
    expect(rows).toHaveLength(1);

    const removed = await A.delete(`/${doctorId}/qualifications/${rows[0]?.id}`);
    expect(removed.status).toBe(200);
  });
});

/**
 * ⚠️ NO LONGER "per-branch fees". `consultation_fee` and `follow_up_fee` left
 *   this table for the fee schedule, which prices every VISIT TYPE rather than
 *   two of the five — see `fee-schedule.test.ts`, which owns the money cases and
 *   the exact-decimal one among them. What is left here is what the row is
 *   actually for: whether a doctor consults at a branch, and how long a revisit
 *   stays free there.
 */
describe('where a doctor consults', () => {
  let doctorId: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorId = res.body.data.doctors[0].id as string;
  });

  it('records the free-revisit window against the branch', async () => {
    const res = await A.put(`/${doctorId}/branch-settings`, {
      branchId: orgA.branchId,
      followUpFreeDays: 7,
      isActive: true,
    });
    expect(res.status).toBe(200);

    const { rows } = await owner.query<{ follow_up_free_days: number }>(
      'SELECT follow_up_free_days FROM doctor_branch_settings WHERE doctor_profile_id = $1',
      [doctorId]
    );
    expect(rows[0]?.follow_up_free_days).toBe(7);
  });

  it('refuses a branch outside the caller’s scope', async () => {
    const res = await A.put(`/${doctorId}/branch-settings`, {
      branchId: orgB.branchId,
      isActive: true,
    });
    expect(res.status).toBe(404);
  });
});
