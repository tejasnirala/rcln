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

describe('per-branch fees', () => {
  let doctorId: string;

  beforeAll(async () => {
    const res = await A.get('/');
    doctorId = res.body.data.doctors[0].id as string;
  });

  it('stores money as an exact decimal, never a float', async () => {
    const res = await A.put(`/${doctorId}/branch-settings`, {
      branchId: orgA.branchId,
      consultationFee: '400.50',
      followUpFee: '0',
      followUpFreeDays: 7,
      isActive: true,
    });
    expect(res.status).toBe(200);

    const { rows } = await owner.query<{ consultation_fee: string }>(
      'SELECT consultation_fee FROM doctor_branch_settings WHERE doctor_profile_id = $1',
      [doctorId]
    );
    expect(rows[0]?.consultation_fee).toBe('400.50');
  });

  it('refuses a branch outside the caller’s scope', async () => {
    const res = await A.put(`/${doctorId}/branch-settings`, {
      branchId: orgB.branchId,
      consultationFee: '100',
      isActive: true,
    });
    expect(res.status).toBe(404);
  });
});
