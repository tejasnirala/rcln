/**
 * The consultation, over real HTTP (CE-3).
 *
 * Beyond "the endpoints respond", these are the things pinned down here, and
 * every one of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ AN ORG_OWNER CANNOT WRITE A CONSULTATION. Invariant 7: authoring the
 *      clinical record belongs to DOCTOR alone among the system roles, and the
 *      authoring codes are stripped from the two "everything except" roles BY
 *      NAME. A new authoring code that forgot to join `CLINICAL_AUTHORING` would
 *      arrive silently on both — this is the case that notices.
 *
 *   2. ⚠️ OPENING IS IDEMPOTENT. Two calls for one appointment return the SAME
 *      draft. Without the partial unique index behind it, a double submit opens
 *      two records of one visit and which one the prescription hangs off is a
 *      race nobody can see afterwards.
 *
 *   3. ⚠️ A DRAFT MAY BE INCOMPLETE AND A SIGNED RECORD MAY NOT. The autosave
 *      accepts a half-filled examination; finalization refuses it with a
 *      sentence naming every missing field at once.
 *
 *   4. ⚠️ A FINALIZED CONSULTATION IS IMMUTABLE (CD-2). The autosave is a 409,
 *      not a silent rewrite of a record somebody has signed.
 *
 *   5. ⚠️ AN AMENDMENT IS A NEW ROW. The original keeps its content, its number
 *      and its signature and moves to AMENDED; the correction is a fresh draft
 *      citing it, carrying the ORIGINAL's snapshot rather than today's template.
 *
 *   6. ⚠️ THE NUMBER IS BURNT AT FINALIZATION, NOT AT OPEN. An abandoned draft
 *      leaves no gap in a series somebody may have to explain.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `e${Date.now().toString(36)}`;
const SLUG = `enc-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let membershipId: string;
let patientId: string;
let episodeId: string;
let doctorProfileId: string;
let appointmentId: string;

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

async function clearAccessCache(): Promise<void> {
  const keys = await redis.keys('access:*');
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * Hand the owner the authoring codes, the way a clinic does.
 *
 * ⚠️ THIS IS THE SUPPORTED WIDENING, NOT A TEST SHORTCUT. `roles.ts` says in as
 *   many words that a clinic which wants somebody other than a seeded DOCTOR to
 *   write up a consultation grants the codes per membership — so the fixture
 *   exercises the same path a real clinic would, and the 403 case above it
 *   proves the default is what the invariant says it is.
 */
async function grantAuthoring(): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'encounter test'
       FROM permissions p
      WHERE p.code IN ('clinical.encounter.create', 'clinical.encounter.close',
                       'clinical.encounter.amend')`,
    [membershipId, org.organizationId]
  );
  await clearAccessCache();
}

const api = (method: 'get' | 'post' | 'patch') => (path: string, body?: object) => {
  const r = request(app)
    [method](`/api/v1${path}`)
    .set('Host', hostFor(SLUG))
    .set('Authorization', `Bearer ${token}`);
  return body === undefined ? r : r.send(body);
};

const get = api('get');
const post = api('post');
const patch = api('patch');

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Encounters'));

  await clearRateLimits();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier: `${SLUG}@example.test`, password: PASSWORD });
  token = login.body.data.accessToken as string;

  const membership = await owner.query<{ id: string }>(
    `SELECT id FROM memberships WHERE user_id = $1 AND organization_id = $2`,
    [org.ownerUserId, org.organizationId]
  );
  membershipId = membership.rows[0]!.id;

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctor.rows[0]!.id;

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'ENCUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;

  const registration = await owner.query<{ id: string }>(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'ENCMRN1', now()) RETURNING id`,
    [org.organizationId, patientId, org.branchId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ENCEP0001', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );
  episodeId = episode.rows[0]!.id;

  const appointment = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, checked_in_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'ENCAPT0001',
             now(), now() + interval '15 minutes', 'CHECKED_IN', now(), now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      registration.rows[0]!.id,
      doctorProfileId,
      episodeId,
    ]
  );
  appointmentId = appointment.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);
  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
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

// ---------------------------------------------------------------------------

describe('who may write a consultation', () => {
  /**
   * ⚠️ THE INVARIANT-7 CASE. An ORG_OWNER is an "everything except" role and this
   *   is one of the exceptions: running the clinic is not practising in it. If a
   *   future authoring code forgets to join `CLINICAL_AUTHORING`, it arrives on
   *   this role silently and this test is what says so.
   */
  it('refuses an ORG_OWNER, who holds every other permission', async () => {
    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(403);
  });

  it('reads the consultation surface without being able to write it', async () => {
    /* `clinical.encounter.read` IS held — oversight, not authorship — and the
       answer is "nothing written up yet" rather than a 403. */
    const res = await get(`/appointments/${appointmentId}/encounter`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe('the lifecycle', () => {
  let encounterId: string;

  beforeAll(async () => {
    await grantAuthoring();
  });

  it('opens a draft against the resolved template', async () => {
    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    /* ⚠️ No number yet — an abandoned draft must burn none. */
    expect(res.body.data.encounterNumber).toBeNull();
    /* The screen specification came with it, from the frozen snapshot. */
    expect(res.body.data.configuration.length).toBeGreaterThan(0);
    encounterId = res.body.data.id as string;
  });

  /**
   * ⚠️ THE DOUBLE CLICK. Without idempotency this opens a second record of one
   *   visit, both valid, both live, and the prescription hangs off whichever one
   *   the screen happened to hold.
   */
  it('returns the same draft when the consultation is opened again', async () => {
    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(encounterId);
  });

  it('accepts a partial save while the doctor is still typing', async () => {
    const res = await patch(`/encounters/${encounterId}`, {
      chiefComplaint: 'Pain in the lower left molar',
      chiefComplaintDurationValue: 3,
      chiefComplaintDurationUnit: 'DAYS',
      onset: 'GRADUAL',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DRAFT');
    expect(typeof res.body.data.savedAt).toBe('string');
  });

  /**
   * ⚠️ A SECTION KEY THE SNAPSHOT DOES NOT DECLARE IS REFUSED AT SAVE TIME, not
   *   at signing. Storing it would mean a row that renders nowhere, and the
   *   clinician who typed into a renamed field would find out at the end.
   */
  it('refuses an answer for a section this consultation does not have', async () => {
    const res = await patch(`/encounters/${encounterId}`, {
      sections: [{ key: 'not_a_section', data: { note: 'x' } }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a section/i);
  });

  /**
   * ⚠️ THE SEEDED `GENERAL` TEMPLATE MARKS FOLLOW-UP REQUIRED, AND CE-4 IS WHAT
   *   MADE THAT TRUE. The flag was inert while nothing counted the first-class
   *   sections; now finalization refuses a consultation that never answered the
   *   question — which is precisely what `default-definition.ts` says it is for:
   *   a clinic can only tell "the doctor decided against a follow-up" from "the
   *   doctor forgot" if the question is always asked.
   *
   *   So the plan is stated first. "No follow-up needed" is a real answer and is
   *   the cheapest one to give here.
   */
  it('signs the record and burns the branch’s next number', async () => {
    const plan = await request(app)
      .put(`/api/v1/encounters/${encounterId}/follow-up`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({ isRequired: false });
    expect(plan.status).toBe(200);

    const res = await post(`/encounters/${encounterId}/finalize`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FINALIZED');
    expect(res.body.data.encounterNumber).toMatch(/^ENC/);
    expect(res.body.data.finalizedAt).not.toBeNull();
  });

  /**
   * ⚠️ THE ONE THAT MAKES A RECORD A RECORD. Not a typo, not a correction, not
   *   "just this once" — a signed consultation is corrected by an amendment, and
   *   there is no endpoint anywhere that edits one.
   */
  it('refuses to edit a signed consultation', async () => {
    const res = await patch(`/encounters/${encounterId}`, { clinicalNotes: 'second thoughts' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/amendment/i);
  });

  it('amends it as a NEW record that cites the old one', async () => {
    const res = await post(`/encounters/${encounterId}/amend`, {
      reason: 'The tooth number was wrong',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.id).not.toBe(encounterId);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.amendsEncounterId).toBe(encounterId);
    /* ⚠️ The content is carried over, so a correction is a correction and not a
       consultation retyped from memory. */
    expect(res.body.data.chiefComplaint).toBe('Pain in the lower left molar');

    /* And the original is untouched apart from its status. */
    const original = await get(`/encounters/${encounterId}`);
    expect(original.body.data.status).toBe('AMENDED');
    expect(original.body.data.encounterNumber).toMatch(/^ENC/);
    expect(original.body.data.chiefComplaint).toBe('Pain in the lower left molar');
  });

  it('refuses to amend a record that has already been superseded', async () => {
    const res = await post(`/encounters/${encounterId}/amend`, { reason: 'again' });
    expect(res.status).toBe(409);
  });
});

/**
 * ⚠️ THE AUDIT TRAIL RECORDS THAT A CONSULTATION WAS SIGNED AND NEVER WHAT IT
 *   SAID. The allow-list snapshot reports `hasChiefComplaint`; `REDACTED_KEYS`
 *   is the backstop under it. A compliance reader with no right to a patient
 *   record must not be able to read one out of this table.
 */
describe('the trails', () => {
  it('keeps the clinical text out of the audit rows', async () => {
    const { rows } = await owner.query<{ hit: string }>(
      `SELECT id AS hit FROM audit_logs
        WHERE organization_id = $1
          AND entity_type = 'encounter'
          AND (before_data::text ILIKE '%molar%' OR after_data::text ILIKE '%molar%')`,
      [org.organizationId]
    );
    expect(rows).toHaveLength(0);
  });

  it('records that the record was read, by whom, without the content', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'ENCOUNTER'`,
      [org.organizationId]
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  });
});
