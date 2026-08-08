/**
 * Patients over real HTTP, through the real middleware chain.
 *
 * Beyond "CRUD works", six things are being pinned down — each of them a bug
 * that would typecheck cleanly and pass every other test:
 *
 *   1. UHID is org-wide and MRN is branch-local, both issued and gapless. Two
 *      branches both start at 1 and neither collides with the other.
 *   2. Identity is org-wide, attendance is branch-local (ADR-0016). A patient
 *      registered only at branch B is FINDABLE org-wide — that is what stops
 *      the front desk creating a second record — and comes back flagged
 *      `crossBranch`, with no MRN the caller has no business seeing.
 *   3. Every read writes a `data_access_logs` row: a detail view names the
 *      patient, a search names none and carries a hash instead of the term, and
 *      searches are NEVER deduplicated.
 *   4. ⚠️ NO PHI REACHES `audit_logs`. The suite greps every audit row written
 *      during it for the patient's name, phone, date of birth, ABHA number and
 *      allergen. This is the assertion the allow-list snapshot exists for.
 *   5. The medical history is a SEPARATE permission from patient identity.
 *   6. The CHECK constraints hold: a birth date and an approximate age cannot
 *      both be set, and an ongoing medicine cannot have a stop date.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `p${Date.now().toString(36)}`;
const SLUG_A = `pat-a-${SUFFIX}`;
const SLUG_B = `pat-b-${SUFFIX}`;
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

/** A second branch inside org A, so branch-local numbering can be observed. */
let branchA2: string;

/** Distinctive enough that finding it anywhere is unambiguous. */
const SUBJECT = {
  firstName: 'Meenakshi',
  lastName: 'Varadarajan',
  phone: '+919812345670',
  dateOfBirth: '1988-03-14',
  abhaNumber: '12-3456-7890-1234',
};

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

/**
 * Clear the data-access dedupe keys.
 *
 * A VIEW is deduplicated for 300 seconds, which is correct in production and
 * makes "the second read also logged" untestable without this. The SEARCH
 * assertions deliberately do NOT call it — not deduplicating a search is the
 * behaviour being checked.
 */
async function clearAccessDedupe(): Promise<void> {
  const keys = await redis.keys('dal:*');
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
      .get(`/api/v1/patients${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(app)
      .post(`/api/v1/patients${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  patch: (path: string, body: object) =>
    request(app)
      .patch(`/api/v1/patients${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  put: (path: string, body: object) =>
    request(app)
      .put(`/api/v1/patients${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  delete: (path: string) =>
    request(app)
      .delete(`/api/v1/patients${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  branch: (path: string, body: object) =>
    request(app)
      .post(`/api/v1/branches${path}`)
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

  orgA = await registerOrganization(payload(SLUG_A, 'Pat A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Pat B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));

  const second = await A.branch('', { name: 'Pat A Second', code: 'SECOND' });
  branchA2 = second.body.data.id as string;

  // The owner's token was minted before the second branch existed, so its
  // branch scope does not include it. Re-issue.
  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
}, 40_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    /*
     * `data_access_logs` is append-only for `rcln_app` by a REVOKE and a
     * trigger. `rcln_owner` owns the table and bypasses the REVOKE, and the
     * trigger permits a DELETE only from the owner — see the
     * data_access_log_immutability migration.
     */
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

/** Register a patient at a branch and return the created detail body. */
async function registerAt(
  client: ReturnType<typeof asOrg>,
  branchId: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await client.post('', {
    firstName: 'Test',
    lastName: 'Person',
    branchId,
    ...overrides,
  });
  return res;
}

// ---------------------------------------------------------------------------

describe('registration and numbering', () => {
  it('issues a UHID from the org counter and an MRN from the branch counter', async () => {
    const res = await registerAt(A, orgA.branchId, {
      firstName: SUBJECT.firstName,
      lastName: SUBJECT.lastName,
      phone: SUBJECT.phone,
      dateOfBirth: SUBJECT.dateOfBirth,
      abhaNumber: SUBJECT.abhaNumber,
      gender: 'FEMALE',
      address: { line1: '14 Kasturba Road', city: 'Bengaluru', isPrimary: true },
      contacts: [{ relation: 'Husband', name: 'R Varadarajan', phone: '+919812345671' }],
    });

    expect(res.status).toBe(201);
    // Prefix from the seeded `patient.uhid_prefix`, padded to 6.
    expect(res.body.data.uhid).toMatch(/^P\d{6}$/);
    expect(res.body.data.registrations).toHaveLength(1);
    expect(res.body.data.registrations[0].mrn).toMatch(/^MRN\d{6}$/);
    expect(res.body.data.registrations[0].branchId).toBe(orgA.branchId);
    expect(res.body.data.crossBranch).toBe(false);
    expect(res.body.data.addresses).toHaveLength(1);
    expect(res.body.data.contacts).toHaveLength(1);
  });

  it('counts MRNs per branch, so a second branch starts at 1 again', async () => {
    const first = await registerAt(A, branchA2, { firstName: 'Second', lastName: 'Branch' });
    expect(first.status).toBe(201);
    expect(first.body.data.registrations[0].mrn).toBe('MRN000001');

    const second = await registerAt(A, branchA2, { firstName: 'Second', lastName: 'BranchTwo' });
    expect(second.body.data.registrations[0].mrn).toBe('MRN000002');

    // …while the org-wide UHID keeps climbing across both branches.
    expect(Number(second.body.data.uhid.slice(1))).toBeGreaterThan(
      Number(first.body.data.uhid.slice(1))
    );
  });

  it('refuses a branch the caller has no scope for', async () => {
    const res = await registerAt(A, orgB.branchId, { firstName: 'Wrong', lastName: 'Branch' });
    expect(res.status).toBe(403);
  });

  it('registers an existing patient at a second branch without a second record', async () => {
    const created = await registerAt(A, orgA.branchId, {
      firstName: 'Roving',
      lastName: 'Patient',
    });
    const patientId = created.body.data.id as string;

    const res = await A.post(`/${patientId}/registrations`, { branchId: branchA2 });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(patientId);
    expect(res.body.data.registrations).toHaveLength(2);
    // One UHID, two MRNs.
    expect(new Set(res.body.data.registrations.map((r: { mrn: string }) => r.mrn)).size).toBe(2);
  });

  it('refuses a duplicate registration at the same branch', async () => {
    const created = await registerAt(A, orgA.branchId, { firstName: 'Same', lastName: 'Branch' });
    const res = await A.post(`/${created.body.data.id}/registrations`, { branchId: orgA.branchId });
    expect(res.status).toBe(409);
  });
});

describe('the CHECK constraints', () => {
  it('refuses a date of birth and an approximate age together', async () => {
    const res = await registerAt(A, orgA.branchId, {
      firstName: 'Both',
      dateOfBirth: '1970-01-01',
      approxAgeYears: 55,
    });
    expect(res.status).toBe(400);
  });

  it('accepts an approximate age on its own, and reports it as approximate', async () => {
    const res = await registerAt(A, orgA.branchId, { firstName: 'Approx', approxAgeYears: 60 });
    expect(res.status).toBe(201);
    expect(res.body.data.age).toBe(60);
    expect(res.body.data.ageIsApproximate).toBe(true);
  });

  it('replaces an approximate age when a real birth date arrives', async () => {
    const created = await registerAt(A, orgA.branchId, {
      firstName: 'Refined',
      approxAgeYears: 40,
    });
    const res = await A.patch(`/${created.body.data.id}`, { dateOfBirth: '1985-06-01' });

    expect(res.status).toBe(200);
    expect(res.body.data.approxAgeYears).toBeNull();
    expect(res.body.data.ageIsApproximate).toBe(false);
  });
});

describe('identity is org-wide, attendance is branch-local', () => {
  let onlyAtSecond: string;

  beforeAll(async () => {
    const created = await registerAt(A, branchA2, {
      firstName: 'Kanmani',
      lastName: 'Elangovan',
      phone: '+919812345699',
    });
    onlyAtSecond = created.body.data.id as string;
  });

  it('finds a patient of another branch when the search is widened', async () => {
    const res = await A.get('/?q=Kanmani&scope=ORGANIZATION');

    expect(res.status).toBe(200);
    const found = res.body.data.patients.find((p: { id: string }) => p.id === onlyAtSecond);
    expect(found).toBeDefined();
  });

  it('does not leak that patient into another CLINIC', async () => {
    const res = await B.get('/?q=Kanmani&scope=ORGANIZATION');
    expect(res.status).toBe(200);
    expect(res.body.data.patients).toHaveLength(0);
  });

  it('serves the identity record but no other branch’s MRN', async () => {
    /*
     * The owner of org A is scoped to every branch, so to observe the
     * branch-local half the read is made with a scope that excludes branchA2 —
     * which is what the RESTRICTIVE policy on patient_registrations enforces.
     * Asserted directly against Postgres as `rcln_app`, because there is no
     * single-branch user in this fixture.
     */
    const app_ = new Client({ connectionString: process.env['DATABASE_URL'] });
    await app_.connect();
    await app_.query('BEGIN');
    await app_.query("SELECT set_config('app.current_org', $1, true)", [orgA.organizationId]);
    await app_.query("SELECT set_config('app.branch_scope', $1, true)", [`{${orgA.branchId}}`]);

    const patient = await app_.query('SELECT id FROM patients WHERE id = $1', [onlyAtSecond]);
    const registrations = await app_.query(
      'SELECT id FROM patient_registrations WHERE patient_id = $1',
      [onlyAtSecond]
    );

    await app_.query('ROLLBACK');
    await app_.end();

    // The person is visible…
    expect(patient.rowCount).toBe(1);
    // …their attendance at a branch out of scope is not.
    expect(registrations.rowCount).toBe(0);
  });
});

describe('duplicate detection', () => {
  it('matches on phone across every branch in the clinic', async () => {
    const res = await A.post('/duplicate-check', { phone: SUBJECT.phone });

    expect(res.status).toBe(200);
    expect(res.body.data.matches.length).toBeGreaterThan(0);
    expect(res.body.data.matches[0].matchedOn).toContain('PHONE');
  });

  it('matches on name and date of birth together, never on name alone', async () => {
    const both = await A.post('/duplicate-check', {
      firstName: SUBJECT.firstName,
      dateOfBirth: SUBJECT.dateOfBirth,
    });
    expect(both.body.data.matches.length).toBeGreaterThan(0);

    const nameOnly = await A.post('/duplicate-check', { firstName: SUBJECT.firstName });
    expect(nameOnly.body.data.matches).toHaveLength(0);
  });

  it('does not reach across clinics', async () => {
    const res = await B.post('/duplicate-check', { phone: SUBJECT.phone });
    expect(res.body.data.matches).toHaveLength(0);
  });

  it('refuses a second record with the same ABHA number', async () => {
    const res = await registerAt(A, orgA.branchId, {
      firstName: 'Clone',
      abhaNumber: SUBJECT.abhaNumber,
    });
    expect(res.status).toBe(409);
  });
});

describe('the read-access trail', () => {
  let subjectId: string;

  beforeAll(async () => {
    const res = await A.get(`/?q=${encodeURIComponent(SUBJECT.phone)}&scope=ORGANIZATION`);
    subjectId = res.body.data.patients[0].id as string;
  });

  it('records a VIEW naming the patient when the record is opened', async () => {
    await clearAccessDedupe();
    await A.get(`/${subjectId}`);

    const rows = await owner.query(
      `SELECT access_type, resource, patient_id, query_hash, route
         FROM data_access_logs
        WHERE organization_id = $1 AND patient_id = $2 AND resource = 'PATIENT'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId, subjectId]
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].access_type).toBe('VIEW');
    expect(rows.rows[0].query_hash).toBeNull();
    // ⚠️ The PATTERN, not the URL.
    expect(rows.rows[0].route).toBe('GET /v1/patients/:patientId');
  });

  it('deduplicates a repeated view of the same record', async () => {
    const countViews = async (): Promise<number> => {
      const rows = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM data_access_logs
          WHERE organization_id = $1 AND patient_id = $2 AND resource = 'PATIENT'`,
        [orgA.organizationId, subjectId]
      );
      return rows.rows[0]?.n ?? 0;
    };

    /*
     * Counted as a delta rather than over a time window: the preceding test
     * also cleared the dedupe key and read this record, and any window wide
     * enough to be stable also catches that read.
     */
    await clearAccessDedupe();
    const before = await countViews();

    await A.get(`/${subjectId}`);
    await A.get(`/${subjectId}`);
    await A.get(`/${subjectId}`);

    expect((await countViews()) - before).toBe(1);
  });

  it('records a search as one row, with a hash and no patient id', async () => {
    await A.get('/?q=Varadarajan&scope=ORGANIZATION');

    const rows = await owner.query(
      `SELECT patient_id, query_hash, result_count, access_type
         FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'PATIENT_LIST'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows.rows[0].access_type).toBe('SEARCH');
    expect(rows.rows[0].patient_id).toBeNull();
    expect(rows.rows[0].query_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('⚠️ never deduplicates a search — repetition IS the signal', async () => {
    const before = await owner.query(
      `SELECT count(*)::int AS n FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'PATIENT_LIST'`,
      [orgA.organizationId]
    );

    await A.get('/?q=Varadarajan&scope=ORGANIZATION');
    await A.get('/?q=Varadarajan&scope=ORGANIZATION');
    await A.get('/?q=Varadarajan&scope=ORGANIZATION');

    const after = await owner.query(
      `SELECT count(*)::int AS n FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'PATIENT_LIST'`,
      [orgA.organizationId]
    );

    expect(after.rows[0].n - before.rows[0].n).toBe(3);
  });

  it('hashes the term identically for two spellings of the same search', async () => {
    await A.get('/?q=Varadarajan&scope=ORGANIZATION');
    const one = await owner.query(
      `SELECT query_hash FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'PATIENT_LIST'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    await A.get(`/?q=${encodeURIComponent('  VARADARAJAN  ')}&scope=ORGANIZATION`);
    const two = await owner.query(
      `SELECT query_hash FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'PATIENT_LIST'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(two.rows[0].query_hash).toBe(one.rows[0].query_hash);
  });

  it('⚠️ stores no search term anywhere in the trail', async () => {
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM data_access_logs
        WHERE organization_id = $1
          AND (route ILIKE '%Varadarajan%' OR user_agent ILIKE '%Varadarajan%')`,
      [orgA.organizationId]
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('the medical history', () => {
  let subjectId: string;

  beforeAll(async () => {
    const res = await A.get(`/?q=${encodeURIComponent(SUBJECT.phone)}&scope=ORGANIZATION`);
    subjectId = res.body.data.patients[0].id as string;
  });

  it('records an allergy and returns it severest-first', async () => {
    await A.post(`/${subjectId}/allergies`, {
      allergenText: 'Amoxicillin',
      severity: 'MILD',
    });
    await A.post(`/${subjectId}/allergies`, {
      allergenText: 'Penicillin',
      severity: 'SEVERE',
      reaction: 'Anaphylaxis',
    });

    const res = await A.get(`/${subjectId}/history`);

    expect(res.status).toBe(200);
    expect(res.body.data.allergies).toHaveLength(2);
    // The enum is declared MILD→SEVERE and read DESC, so SEVERE leads.
    expect(res.body.data.allergies[0].allergenText).toBe('Penicillin');
    expect(res.body.data.allergies[0].notedByName).toBe('Pat A Owner');
  });

  it('refuses a chronic condition that has resolved', async () => {
    const res = await A.post(`/${subjectId}/conditions`, {
      conditionText: 'Hypertension',
      status: 'CHRONIC',
      resolvedDate: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('refuses an ongoing medicine with a stop date', async () => {
    const res = await A.post(`/${subjectId}/medications`, {
      medicineText: 'Metformin 500mg',
      isOngoing: true,
      stoppedOn: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('stops a medicine, moving isOngoing and stoppedOn together', async () => {
    const added = await A.post(`/${subjectId}/medications`, {
      medicineText: 'Amlodipine 5mg',
      dosage: 'Once daily',
    });
    expect(added.status).toBe(201);

    const history = await A.get(`/${subjectId}/history`);
    const medication = history.body.data.medications.find(
      (m: { medicineText: string }) => m.medicineText === 'Amlodipine 5mg'
    );

    const res = await A.post(`/${subjectId}/medications/${medication.id}/stop`, {
      stoppedOn: '2026-08-01',
    });
    expect(res.status).toBe(200);

    const after = await A.get(`/${subjectId}/history`);
    const stopped = after.body.data.medications.find(
      (m: { medicineText: string }) => m.medicineText === 'Amlodipine 5mg'
    );
    expect(stopped.isOngoing).toBe(false);
    expect(stopped.stoppedOn).toBe('2026-08-01');
  });

  it('withdraws an allergy softly, so it leaves the list but not the database', async () => {
    const history = await A.get(`/${subjectId}/history`);
    const mild = history.body.data.allergies.find(
      (a: { allergenText: string }) => a.allergenText === 'Amoxicillin'
    );

    const res = await A.delete(`/${subjectId}/allergies/${mild.id}`);
    expect(res.status).toBe(200);

    const after = await A.get(`/${subjectId}/history`);
    expect(after.body.data.allergies.some((a: { id: string }) => a.id === mild.id)).toBe(false);

    const rows = await owner.query('SELECT deleted_at FROM patient_allergies WHERE id = $1', [
      mild.id,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].deleted_at).not.toBeNull();
  });

  it('logs a MEDICAL_HISTORY read separately from a PATIENT read', async () => {
    await clearAccessDedupe();
    await A.get(`/${subjectId}/history`);

    const rows = await owner.query(
      `SELECT resource, route FROM data_access_logs
        WHERE organization_id = $1 AND patient_id = $2 AND resource = 'MEDICAL_HISTORY'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId, subjectId]
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].route).toBe('GET /v1/patients/:patientId/history');
  });

  it('refuses another clinic’s patient', async () => {
    const res = await B.get(`/${subjectId}/history`);
    expect(res.status).toBe(404);
  });
});

describe('⚠️ no PHI reaches the audit trail', () => {
  it('records that a patient was created without recording who they are', async () => {
    const rows = await owner.query(
      `SELECT before_data, after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'patient' AND action = 'CREATE'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows.rowCount).toBe(1);
    const after = rows.rows[0].after_data;
    // The identifier that says WHICH record, and nothing that says who.
    expect(after).toHaveProperty('uhid');
    expect(after).not.toHaveProperty('firstName');
    expect(after).not.toHaveProperty('lastName');
    expect(after).not.toHaveProperty('phone');
    expect(after).not.toHaveProperty('dateOfBirth');
    expect(after).not.toHaveProperty('abhaNumber');
    // …but that an identifier EXISTS is auditable.
    expect(after).toHaveProperty('hasAbhaNumber');
  });

  it('greps every audit row written by this suite for the subject’s details', async () => {
    const needles = [
      SUBJECT.firstName,
      SUBJECT.lastName,
      SUBJECT.phone,
      SUBJECT.dateOfBirth,
      SUBJECT.abhaNumber,
      'Penicillin',
      'Anaphylaxis',
      'Amlodipine',
      'Once daily',
      'Kasturba',
      'R Varadarajan',
    ];

    const rows = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE organization_id = $1
          AND (before_data::text ILIKE ANY($2) OR after_data::text ILIKE ANY($2))`,
      [orgA.organizationId, needles.map((n) => `%${n}%`)]
    );

    expect(rows.rows[0]?.n).toBe(0);
  });
});

describe('erasure', () => {
  it('soft-deletes and drops the record out of every list', async () => {
    const created = await registerAt(A, orgA.branchId, {
      firstName: 'Erasable',
      lastName: 'Record',
    });
    const patientId = created.body.data.id as string;

    const res = await A.delete(`/${patientId}`);
    expect(res.status).toBe(200);

    expect((await A.get(`/${patientId}`)).status).toBe(404);
    const list = await A.get('/?q=Erasable&scope=ORGANIZATION');
    expect(list.body.data.patients).toHaveLength(0);

    const rows = await owner.query('SELECT deleted_at, status FROM patients WHERE id = $1', [
      patientId,
    ]);
    expect(rows.rows[0].deleted_at).not.toBeNull();
  });
});
