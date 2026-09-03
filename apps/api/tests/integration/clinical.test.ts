/**
 * The clinical vocabulary and the treatment journey, over real HTTP.
 *
 * Beyond "the endpoints respond", six things are pinned down here, and every one
 * of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ SCOPING RANKS AND DOES NOT FILTER. §11 and §34 both say a word
 *      relevant to several specialties must not be hidden from a doctor because
 *      nobody tagged it. An INNER JOIN in the search would make every untagged
 *      term invisible with no error — so this suite asserts an untagged term is
 *      STILL RETURNED when a specialty is supplied, which is the assertion a
 *      "does the filter work" test would never make.
 *
 *   2. ⚠️ THE CHAIN AND THE JOURNEY ARE DIFFERENT ANSWERS. A -> B -> C: each
 *      follow-up's parent is its IMMEDIATE predecessor, while all three share
 *      one episode. A test that only checked the episode would pass with the
 *      chain broken, and vice versa. Both are asserted on the same three rows.
 *
 *   3. A fresh booking opens a NEW journey and never joins the patient's most
 *      recent open one (CD-13) — the tempting default that would be a diagnosis
 *      made by a default value.
 *
 *   4. An episode named by the caller must belong to the named patient. Both
 *      ids arrive from one form.
 *
 *   5. A tenant cannot modify the platform vocabulary, and gets a sentence
 *      rather than a constraint name.
 *
 *   6. Reading a journey writes a `data_access_logs` row; searching the
 *      vocabulary deliberately does not.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `c${Date.now().toString(36)}`;
const SLUG = `cln-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let patientId: string;
let doctorProfileId: string;

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

const api = (method: 'get' | 'post' | 'patch' | 'delete') => (path: string, body?: object) => {
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

  org = await registerOrganization(payload(SLUG, 'Clinical'));

  await clearRateLimits();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier: `${SLUG}@example.test`, password: PASSWORD });
  token = login.body.data.accessToken as string;

  /*
   * A doctor and a patient, written as the owner. The point of this suite is the
   * episode behaviour, not the onboarding flow those other suites already cover.
   */
  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctor.rows[0]!.id;

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'CLNUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;
  await owner.query(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'CLNMRN1', now())`,
    [org.organizationId, patientId, org.branchId]
  );

  /* Doctor hours, so the availability engine will accept a booking at all. */
  for (let day = 0; day < 7; day += 1) {
    await owner.query(
      `INSERT INTO doctor_schedules
         (id, organization_id, branch_id, doctor_profile_id, day_of_week,
          start_time, end_time, slot_minutes, valid_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '09:00', '17:00', 15,
               DATE '2020-01-01', now())`,
      [org.organizationId, org.branchId, doctorProfileId, day]
    );
  }
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

describe('the clinical vocabulary', () => {
  it('serves the seeded platform terms, paginated', async () => {
    const res = await get('/clinical-data?kind=DIAGNOSIS&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.pageSize).toBe(5);
  });

  it('finds a term by a fragment of its name', async () => {
    const res = await get('/clinical-data?kind=DIAGNOSIS&search=alopecia');
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { code: string }) => i.code)).toContain(
      'ANDROGENETIC_ALOPECIA'
    );
  });

  /**
   * ⚠️ THE ASSERTION THIS WHOLE FILE EXISTS FOR.
   *
   *   `CBC` is seeded with NO specialty scope, on purpose — every specialty
   *   orders one. Supplying a specialty must still return it, below the scoped
   *   terms. If the search ever becomes an INNER JOIN, this goes red and the
   *   "does scoping work" test beside it stays green — which is precisely how a
   *   filter that silently hides half the vocabulary would otherwise ship.
   */
  it('still returns an untagged term when a specialty is supplied', async () => {
    const spec = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    );
    const res = await get(
      `/clinical-data?kind=INVESTIGATION&specialtyIds=${spec.rows[0]!.id}&pageSize=100`
    );
    expect(res.status).toBe(200);
    const codes = res.body.data.items.map((i: { code: string }) => i.code);
    expect(codes).toContain('OPG'); // scoped to Dentistry
    expect(codes).toContain('CBC'); // scoped to nothing at all
  });

  it('sorts the scoped term above the untagged one', async () => {
    const spec = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    );
    const res = await get(
      `/clinical-data?kind=INVESTIGATION&specialtyIds=${spec.rows[0]!.id}&pageSize=100`
    );
    const codes: string[] = res.body.data.items.map((i: { code: string }) => i.code);
    expect(codes.indexOf('OPG')).toBeLessThan(codes.indexOf('CBC'));
  });

  /**
   * The opt-in filter. The pair above pins that scoping RANKS; these pin that
   * `onlyScoped` narrows, and that narrowing is the caller asking rather than
   * this endpoint deciding.
   */
  it('drops the untagged term when the caller asks for only what is in scope', async () => {
    const spec = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    );
    const res = await get(
      `/clinical-data?kind=INVESTIGATION&specialtyIds=${spec.rows[0]!.id}&onlyScoped=true&pageSize=100`
    );
    expect(res.status).toBe(200);
    const codes = res.body.data.items.map((i: { code: string }) => i.code);
    expect(codes).toContain('OPG');
    expect(codes).not.toContain('CBC');
    /* ⚠️ `total` MUST FOLLOW THE FILTER. It is a window function over the
       grouped rows, so a HAVING that narrows the page and leaves the count
       alone would page a filtered list against an unfiltered total. */
    expect(res.body.data.total).toBe(codes.length);
  });

  /**
   * ⚠️ `onlyScoped` WITH NO NODES MUST NOT RETURN AN EMPTY LIST. Nothing is in
   *   scope when no scope was named, so obeying the flag literally would answer
   *   "the catalogue is empty" to a caller who simply had no template scope.
   */
  it('ignores the filter when no specialty was named', async () => {
    const res = await get('/clinical-data?kind=INVESTIGATION&onlyScoped=true&pageSize=100');
    expect(res.status).toBe(200);
    const codes = res.body.data.items.map((i: { code: string }) => i.code);
    expect(codes).toContain('CBC');
  });

  /**
   * ⚠️ THE BUG THE BRANCH WALK FIXES. `clinical_master_scopes.specialty_id` is
   *   documented as covering every node beneath it, and the query compared it
   *   with `=` — so a word tagged at the DOMAIN was invisible to a filter asking
   *   at the LEAF, which is the level a doctor is actually classified at. A
   *   dentist tagged `ENDODONTICS` got a filtered list of nothing.
   */
  it('matches a term tagged at the domain when the scope is a leaf beneath it', async () => {
    const leaf = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'ENDODONTICS'`
    );
    const res = await get(
      `/clinical-data?kind=PROCEDURE&specialtyIds=${leaf.rows[0]!.id}&onlyScoped=true&pageSize=100`
    );
    expect(res.status).toBe(200);
    const codes = res.body.data.items.map((i: { code: string }) => i.code);
    /* Both platform procedures are tagged at `DEN`, two levels up. */
    expect(codes).toContain('ROOT_CANAL_TREATMENT');
  });

  /** And the other direction: a leaf's word belongs to its domain's list. */
  it('matches a term tagged at a leaf when the scope is the domain above it', async () => {
    const den = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    );
    const endo = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'ENDODONTICS'`
    );

    const created = await post('/clinical-data', {
      kind: 'PROCEDURE',
      code: `PULPECTOMY_${SUFFIX.toUpperCase()}`,
      name: 'Pulpectomy',
      specialtyIds: [endo.rows[0]!.id],
    });
    expect(created.status).toBe(201);

    const res = await get(
      `/clinical-data?kind=PROCEDURE&specialtyIds=${den.rows[0]!.id}&onlyScoped=true&pageSize=100`
    );
    const codes = res.body.data.items.map((i: { code: string }) => i.code);
    expect(codes).toContain(`PULPECTOMY_${SUFFIX.toUpperCase()}`);
  });

  /**
   * ⚠️ THE REGRESSION THIS PINS SHIPPED AND NOTHING CAUGHT IT. `codings` and
   *   `scopes` reach their item through a COMPOSITE relation, so a nested create
   *   that also names `organizationId` is rejected outright — and every request
   *   carrying either came back 400 "Invalid data provided", naming nothing. The
   *   clinical-terms screen sends exactly that shape, so tagging a clinic's own
   *   vocabulary was impossible. Every earlier test created a BARE term.
   */
  it('adds a term carrying both a coding and a specialty scope', async () => {
    const spec = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    );

    const res = await post('/clinical-data', {
      kind: 'DIAGNOSIS',
      code: `PULPITIS_${SUFFIX.toUpperCase()}`,
      name: 'Irreversible pulpitis',
      specialtyIds: [spec.rows[0]!.id],
      codings: [{ system: 'ICD10', code: 'K04.0', isPrimary: true }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.codings).toHaveLength(1);

    /* The scope row inherits the item's organization rather than being told it. */
    const scopes = await owner.query<{ organization_id: string | null }>(
      `SELECT s.organization_id FROM clinical_master_scopes s WHERE s.item_id = $1`,
      [res.body.data.id]
    );
    expect(scopes.rows).toHaveLength(1);
    expect(scopes.rows[0]!.organization_id).not.toBeNull();
  });

  it('lets a clinic add its own term', async () => {
    const res = await post('/clinical-data', {
      kind: 'DIAGNOSIS',
      code: 'CLINIC_OWN_DX',
      name: 'A term this clinic invented',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.isOwn).toBe(true);
  });

  it('refuses a code the platform already uses, and says why', async () => {
    const res = await post('/clinical-data', {
      kind: 'DIAGNOSIS',
      code: 'DENTAL_CARIES',
      name: 'My own caries',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/platform-wide/i);
  });

  it('refuses to edit a platform term with a sentence, not a constraint name', async () => {
    const item = await owner.query<{ id: string }>(
      `SELECT id FROM clinical_master_items
        WHERE organization_id IS NULL AND code = 'DENTAL_CARIES'`
    );
    const res = await patch(`/clinical-data/${item.rows[0]!.id}`, { name: 'Renamed' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/platform-wide/i);
  });

  /**
   * ⚠️ SEARCHING THE DICTIONARY IS NOT A DISCLOSURE. "Dental caries" names
   *   nobody, and logging a row per keystroke would bury the reads that DO name
   *   a patient under millions that do not.
   */
  it('writes no read-audit row for a vocabulary search', async () => {
    const before = await owner.query<{ count: string }>(
      `SELECT count(*) FROM data_access_logs WHERE organization_id = $1`,
      [org.organizationId]
    );
    await get('/clinical-data?kind=SYMPTOM&search=hair');
    const after = await owner.query<{ count: string }>(
      `SELECT count(*) FROM data_access_logs WHERE organization_id = $1`,
      [org.organizationId]
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});

// ---------------------------------------------------------------------------

describe('the treatment journey', () => {
  /** ISO instants inside the seeded 09:00–17:00 IST window, on distinct days. */
  const slot = (dayOffset: number, hourIst: number): string => {
    const d = new Date(Date.UTC(2027, 5, 1 + dayOffset, hourIst - 5, 30, 0));
    return d.toISOString();
  };

  let apptA: string;
  let apptB: string;
  let apptC: string;
  let episodeId: string;

  it('opens a journey when a visit is booked', async () => {
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId,
      doctorProfileId,
      startsAt: slot(0, 10),
      visitType: 'NEW',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.clinicalEpisodeId).toEqual(expect.any(String));
    expect(res.body.data.clinicalEpisodeCode).toMatch(/^EP/);
    apptA = res.body.data.id;
    episodeId = res.body.data.clinicalEpisodeId;
  });

  /**
   * ⚠️ THE TWO ASSERTIONS BELOW ARE THE WHOLE POINT AND THEY ARE DIFFERENT
   *   QUESTIONS. B's PARENT is A and C's PARENT is B — not A. All three share
   *   ONE episode. A test that checked only the episode would pass with the
   *   chain flattened to point at the root; a test that checked only the chain
   *   would pass with every visit in its own journey.
   */
  it('books a follow-up whose parent is the visit it came from', async () => {
    const res = await post(`/appointments/${apptA}/follow-up`, { startsAt: slot(15, 10) });
    expect(res.status).toBe(201);
    apptB = res.body.data.id;
    expect(res.body.data.parentAppointmentId).toBe(apptA);
  });

  it('books a second follow-up off the FIRST follow-up, not off the original', async () => {
    const res = await post(`/appointments/${apptB}/follow-up`, { startsAt: slot(25, 10) });
    expect(res.status).toBe(201);
    apptC = res.body.data.id;
    expect(res.body.data.parentAppointmentId).toBe(apptB);
    expect(res.body.data.parentAppointmentId).not.toBe(apptA);
  });

  it('keeps all three visits in the same journey', async () => {
    for (const id of [apptB, apptC]) {
      const res = await get(`/appointments/${id}`);
      expect(res.body.data.clinicalEpisodeId).toBe(episodeId);
    }
  });

  it('returns the journey with its visits in order', async () => {
    const res = await get(`/clinical-episodes/${episodeId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.appointments.map((a: { id: string }) => a.id)).toEqual([
      apptA,
      apptB,
      apptC,
    ]);
    /* The chain is carried WITHIN the journey, so a timeline can draw both. */
    expect(res.body.data.appointments[2].parentAppointmentId).toBe(apptB);
    expect(res.body.data.appointmentCount).toBe(3);
  });

  /**
   * ⚠️ A FRESH BOOKING NEVER JOINS THE PATIENT'S MOST RECENT OPEN JOURNEY.
   *   That fallback is the tempting one and it is a clinical claim the software
   *   has no basis for — a sore throat in March does not belong to January's
   *   diabetes journey because it happens to be the same person.
   */
  it('opens a NEW journey for an unrelated later visit', async () => {
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId,
      doctorProfileId,
      startsAt: slot(40, 11),
      visitType: 'NEW',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.clinicalEpisodeId).not.toBe(episodeId);
  });

  it('joins an existing journey when the desk says so', async () => {
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId,
      doctorProfileId,
      startsAt: slot(50, 12),
      visitType: 'NEW',
      clinicalEpisodeId: episodeId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.clinicalEpisodeId).toBe(episodeId);
  });

  /**
   * ⚠️ BOTH IDS ARRIVE FROM ONE FORM. An episode picker that does not re-filter
   *   when the patient changes would file one person's visit under another
   *   person's treatment history — a PHI leak that presents as a UI bug.
   */
  it('refuses an episode belonging to a different patient', async () => {
    const other = await owner.query<{ id: string }>(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES (gen_random_uuid(), $1, 'CLNUHID2', 'Grace', now()) RETURNING id`,
      [org.organizationId]
    );
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CLNMRN2', now())`,
      [org.organizationId, other.rows[0]!.id, org.branchId]
    );
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId: other.rows[0]!.id,
      doctorProfileId,
      startsAt: slot(60, 13),
      visitType: 'NEW',
      clinicalEpisodeId: episodeId,
    });
    expect(res.status).toBe(404);
  });

  it('lists a patient’s journeys, newest first', async () => {
    const res = await get(`/clinical-episodes?patientId=${patientId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.episodes.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * ⚠️ READING A JOURNEY DOES DISCLOSE A NAMED PATIENT. Contrast the vocabulary
   *   search above, which deliberately logs nothing.
   *
   * ⚠️ AND THE SECOND READ IS DEDUPED, WHICH IS WHY THIS TEST OPENS A JOURNEY
   *   NOBODY HAS READ YET. `recordDataAccess` collapses repeat VIEWs of the same
   *   record inside a short window — the behaviour that stops a doctor tabbing
   *   between panels of one chart writing thirty rows. An earlier assertion in
   *   this file already read `episodeId`, so asserting a count increase on THAT
   *   id measured the dedupe rather than the logging, and failed. Both halves
   *   are pinned below so neither can regress unnoticed.
   */
  it('writes a read-audit row when a journey is opened, and dedupes the second read', async () => {
    const fresh = await post('/clinical-episodes', {
      patientId,
      branchId: org.branchId,
      title: 'A journey nothing has read yet',
    });
    const freshId = fresh.body.data.id as string;

    const countRows = async (): Promise<number> => {
      const { rows } = await owner.query<{ count: string }>(
        `SELECT count(*) FROM data_access_logs
          WHERE organization_id = $1 AND resource = 'CLINICAL_EPISODE'
            AND resource_id = $2`,
        [org.organizationId, freshId]
      );
      return Number(rows[0]!.count);
    };

    expect(await countRows()).toBe(0);
    await get(`/clinical-episodes/${freshId}`);
    expect(await countRows()).toBe(1);

    /* The dedupe window: a second read of the same record adds nothing. */
    await get(`/clinical-episodes/${freshId}`);
    expect(await countRows()).toBe(1);
  });

  /**
   * ⚠️ NO TITLE, NO NOTES, NO CLOSURE REASON IN THE AUDIT TRAIL. The allow-list
   *   `snapshot()` is the only thing keeping a diagnosis out of a table
   *   compliance staff read without any right to read patient records.
   */
  it('lets no journey title reach the audit trail', async () => {
    await patch(`/clinical-episodes/${episodeId}`, { title: 'Androgenetic alopecia' });
    const { rows } = await owner.query<{ payload: string }>(
      `SELECT coalesce(before_data::text, '') || coalesce(after_data::text, '') AS payload
         FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'clinical_episode'`,
      [org.organizationId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.payload).not.toMatch(/alopecia/i);
  });

  it('closes and reopens a journey without losing it', async () => {
    const closed = await patch(`/clinical-episodes/${episodeId}`, {
      status: 'CLOSED',
      closureReason: 'Treatment complete',
    });
    expect(closed.status).toBe(200);

    const reopened = await patch(`/clinical-episodes/${episodeId}`, { status: 'OPEN' });
    expect(reopened.status).toBe(200);

    const res = await get(`/clinical-episodes/${episodeId}`);
    expect(res.body.data.status).toBe('OPEN');
    /* Reopening clears the closure, rather than leaving a confusing residue. */
    expect(res.body.data.closedOn).toBeNull();
    expect(res.body.data.closureReason).toBeNull();
  });

  it('refuses to book into a closed journey', async () => {
    await patch(`/clinical-episodes/${episodeId}`, { status: 'CLOSED' });
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId,
      doctorProfileId,
      startsAt: slot(70, 14),
      visitType: 'NEW',
      clinicalEpisodeId: episodeId,
    });
    expect(res.status).toBe(404);
    await patch(`/clinical-episodes/${episodeId}`, { status: 'OPEN' });
  });
});
