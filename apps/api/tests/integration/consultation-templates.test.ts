/**
 * Consultation templates and the configuration resolver, over real HTTP.
 *
 * Beyond "the endpoints respond", six things are pinned down here, and every one
 * of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ A CONFIGURATION THAT SAYS NOTHING CHECKABLE IS REFUSED. `{ "require":
 *      true }` for `{ "required": true }` comes back a 400 naming the key,
 *      rather than a mandatory field silently switched off on a clinical form.
 *      Both shapes of "nothing" are covered — the key that is ABSENT and the one
 *      that EXISTS but is empty. Covering only the first is exactly the gap that
 *      let PI-5 ship a permissive typo.
 *
 *   2. ⚠️ RESOLUTION IS MOST-SPECIFIC-WINS AND IT NEVER RETURNS NOTHING. A
 *      doctor with no classification gets the care-context default; classify
 *      them and the specialty template takes over. A test that only asserted the
 *      second would pass with the default missing entirely — and the symptom of
 *      that is an unclassified doctor unable to open a consultation.
 *
 *   3. ⚠️ AN UNPUBLISHED TEMPLATE CHANGES NOTHING. The draft is invisible to the
 *      resolver until it is published, which is what makes editing a live
 *      configuration safe.
 *
 *   4. A published version is immutable. Editing one is a 409, not a silent
 *      rewrite of a document finalized consultations will cite (§29).
 *
 *   5. A tenant cannot modify the platform's template, and gets a sentence
 *      rather than a constraint name.
 *
 *   6. The definition holds CODES and never ids (CD-6) — a uuid in `scopes` is
 *      refused.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `t${Date.now().toString(36)}`;
const SLUG = `tpl-${SUFFIX}`;
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
let humanContextId: string;
let dentalNodeId: string;

/** A minimal but LEGAL document — every mandatory key stated explicitly. */
const definition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  scopes: [],
  sections: [
    {
      type: 'CHIEF_COMPLAINT',
      key: 'chief_complaint',
      label: 'Chief complaint',
      order: 10,
      visible: true,
      required: true,
    },
  ],
  ...over,
});

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

const api =
  (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (path: string, body?: object) => {
    const r = request(app)
      [method](`/api/v1${path}`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? r : r.send(body);
  };

const get = api('get');
const post = api('post');
const put = api('put');
const del = api('delete');

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Templates'));

  await clearRateLimits();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier: `${SLUG}@example.test`, password: PASSWORD });
  token = login.body.data.accessToken as string;

  const context = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'HUMAN'`
  );
  humanContextId = context.rows[0]!.id;

  const dental = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
  );
  dentalNodeId = dental.rows[0]!.id;

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctor.rows[0]!.id;

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'TPLUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;
  await owner.query(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'TPLMRN1', now())`,
    [org.organizationId, patientId, org.branchId]
  );

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

describe('the platform catalogue', () => {
  it('ships a published general consultation for the human care context', async () => {
    const res = await get('/consultation-templates?pageSize=50');
    expect(res.status).toBe(200);

    const general = res.body.data.templates.find(
      (t: { code: string }) => t.code === 'GENERAL_HUMAN'
    );
    expect(general).toBeDefined();
    expect(general.isOwn).toBe(false);
    expect(general.publishedVersion).not.toBeNull();
    /* The default consultation, all of it visible. */
    expect(general.publishedVersion.visibleSectionCount).toBeGreaterThan(5);
  });

  /**
   * ⚠️ A CLINIC CANNOT EDIT A PLATFORM TEMPLATE, AND GETS A SENTENCE. The
   *   database refuses it too — `tenant_isolation`'s WITH CHECK and the
   *   `platform_rows_immutable` trigger — so this is asserting the message, not
   *   the protection.
   */
  it('refuses to let a tenant modify the platform template', async () => {
    const list = await get('/consultation-templates?pageSize=50');
    const general = list.body.data.templates.find(
      (t: { code: string }) => t.code === 'GENERAL_HUMAN'
    );

    const res = await request(app)
      .patch(`/api/v1/consultation-templates/${general.id}`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ours now' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/platform-wide/i);
  });
});

describe('a configuration that says nothing checkable', () => {
  let templateId: string;
  let draftId: string;

  it('creates a template with the default consultation already in its draft', async () => {
    const res = await post('/consultation-templates', {
      code: 'DENTAL_TEST',
      name: 'Dental consultation',
      careContextId: humanContextId,
      specialtyId: dentalNodeId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.draftVersion.version).toBe(1);
    /* ⚠️ Not blank: a template that starts empty is how a clinic publishes a
       three-section consultation having meant to add to the ordinary one. */
    expect(res.body.data.draftVersion.sectionCount).toBeGreaterThan(5);
    templateId = res.body.data.id;
    draftId = res.body.data.draftVersion.id;
  });

  it('refuses a field descriptor whose "required" is ABSENT', async () => {
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition({
        sections: [
          {
            type: 'HISTORY',
            key: 'history',
            label: 'History',
            order: 30,
            visible: true,
            required: false,
            fields: [{ key: 'onset', type: 'TEXT', label: 'Onset' }],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/i);
  });

  it('refuses the MISSPELLED key by name rather than ignoring it', async () => {
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition({
        sections: [
          {
            type: 'HISTORY',
            key: 'history',
            label: 'History',
            order: 30,
            visible: true,
            required: false,
            fields: [{ key: 'onset', type: 'TEXT', label: 'Onset', require: true }],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('require');
  });

  it('refuses a SELECT whose options EXIST but are EMPTY', async () => {
    /* ⚠️ The second half of the PI-5 gap, and the one nobody covered there. */
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition({
        sections: [
          {
            type: 'EXAMINATION',
            key: 'exam',
            label: 'Examination',
            order: 40,
            visible: true,
            required: false,
            fields: [
              { key: 'severity', type: 'SELECT', label: 'Severity', required: true, options: [] },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/empty/i);
  });

  it('refuses an EMPTY definition as well as an absent one', async () => {
    const empty = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: {},
    });
    expect(empty.status).toBe(400);

    const absent = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {});
    expect(absent.status).toBe(400);
  });

  /** ⚠️ CD-6: a definition holds CODES. An id in JSONB is invisible to every
   *  constraint in the database and belongs to exactly one tenant. */
  it('refuses a uuid where a scope code belongs', async () => {
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition({ scopes: [dentalNodeId] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/code/i);
  });

  it('accepts a document that states everything it should', async () => {
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition({
        scopes: ['DEN'],
        sections: [
          {
            type: 'CHIEF_COMPLAINT',
            key: 'chief_complaint',
            label: 'Chief complaint',
            order: 10,
            visible: true,
            required: true,
          },
          {
            type: 'HISTORY',
            key: 'dental_history',
            label: 'Dental history',
            order: 30,
            visible: true,
            required: false,
            fields: [
              {
                key: 'brushing',
                type: 'SELECT',
                label: 'Brushing frequency',
                required: true,
                options: [
                  { value: 'ONCE', label: 'Once a day' },
                  { value: 'TWICE', label: 'Twice a day' },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.draftVersion.visibleSectionCount).toBe(2);
  });

  it('refuses to edit a version once it is published', async () => {
    const published = await post(
      `/consultation-templates/${templateId}/versions/${draftId}/publish`
    );
    expect(published.status).toBe(200);
    expect(published.body.data.publishedVersion.version).toBe(1);
    expect(published.body.data.draftVersion).toBeNull();

    /* ⚠️ §29: a finalized consultation's snapshot is a statement about the
       configuration that existed when it was made. */
    const res = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: definition(),
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/published/i);
  });

  it('starts the next draft as a COPY of the published version, not a blank', async () => {
    const res = await post(`/consultation-templates/${templateId}/versions`);
    expect(res.status).toBe(201);
    expect(res.body.data.draftVersion.version).toBe(2);
    expect(res.body.data.draftVersion.visibleSectionCount).toBe(2);
  });

  it('refuses a second open draft', async () => {
    const res = await post(`/consultation-templates/${templateId}/versions`);
    expect(res.status).toBe(409);
  });

  it('discards a draft without touching the published version', async () => {
    const detail = await get(`/consultation-templates/${templateId}`);
    const draft = detail.body.data.draftVersion;

    const res = await del(`/consultation-templates/${templateId}/versions/${draft.id}`);
    expect(res.status).toBe(200);

    const after = await get(`/consultation-templates/${templateId}`);
    expect(after.body.data.draftVersion).toBeNull();
    expect(after.body.data.publishedVersion.version).toBe(1);
  });
});

describe('resolving a consultation', () => {
  const slot = (dayOffset: number, hourIst: number): string =>
    new Date(Date.UTC(2027, 7, 1 + dayOffset, hourIst - 5, 30, 0)).toISOString();

  let appointmentId: string;

  it('books a visit to resolve against', async () => {
    const res = await post('/appointments', {
      branchId: org.branchId,
      patientId,
      doctorProfileId,
      startsAt: slot(0, 10),
      visitType: 'NEW',
    });
    expect(res.status).toBe(201);
    appointmentId = res.body.data.id;
  });

  /**
   * ⚠️ THE ASSERTION THAT MATTERS MOST. A doctor with NO classification at all
   *   still gets a consultation (Scenario 3) — resolution never returns nothing.
   *   A suite that only tested the specialty case would pass with the
   *   care-context default missing, and the symptom is a doctor who cannot open
   *   a consultation with a patient in the chair.
   */
  it('falls back to the care-context default for an unclassified doctor', async () => {
    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('GENERAL_HUMAN');
    expect(res.body.data.careContext.code).toBe('HUMAN');
    /* The care-context default sits at the root of the path. */
    expect(res.body.data.template.matchedSpecialtyId).toBeNull();
    expect(res.body.data.template.matchedDepth).toBe(0);
    expect(res.body.data.sections.length).toBeGreaterThan(5);
  });

  it("takes the clinic's specialty template once the doctor is classified", async () => {
    await owner.query(
      `INSERT INTO doctor_specialties
         (id, organization_id, doctor_profile_id, specialty_id, is_primary, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, true, now())`,
      [org.organizationId, doctorProfileId, dentalNodeId]
    );

    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('DENTAL_TEST');
    expect(res.body.data.template.matchedSpecialtyId).toBe(dentalNodeId);
    expect(res.body.data.sections.map((s: { key: string }) => s.key)).toEqual([
      'chief_complaint',
      'dental_history',
    ]);
  });

  /** The scope CODES in the document, resolved to taxonomy ids for the selectors. */
  it("resolves the definition's scope codes into taxonomy ids", async () => {
    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    const section = res.body.data.sections.find((s: { key: string }) => s.key === 'dental_history');
    expect(section.scopeIds).toContain(dentalNodeId);
  });

  /**
   * ⚠️ AN UNPUBLISHED TEMPLATE CHANGES NOTHING, AND THIS IS WHAT MAKES EDITING A
   *   LIVE CONFIGURATION SAFE. A draft is work in progress and has never been a
   *   statement about how consultations are conducted.
   */
  it('ignores a draft until it is published', async () => {
    const before = await get(`/appointments/${appointmentId}/consultation-config`);
    const version = before.body.data.template.version;

    const detail = await get('/consultation-templates?pageSize=50');
    const dental = detail.body.data.templates.find(
      (t: { code: string }) => t.code === 'DENTAL_TEST'
    );
    const draft = await post(`/consultation-templates/${dental.id}/versions`);
    expect(draft.status).toBe(201);

    await put(`/consultation-templates/${dental.id}/versions/${draft.body.data.draftVersion.id}`, {
      definition: definition({
        sections: [
          {
            type: 'CLINICAL_NOTES',
            key: 'only_notes',
            label: 'Notes',
            order: 10,
            visible: true,
            required: false,
          },
        ],
      }),
    });

    const after = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(after.body.data.template.version).toBe(version);
    expect(after.body.data.sections.map((s: { key: string }) => s.key)).not.toContain('only_notes');
  });

  /**
   * ⚠️ NO `data_access_logs` ROW, AND THAT IS THE DECISION RATHER THAN AN
   *   OMISSION. The configuration discloses section labels and descriptors, not
   *   clinical content about the person in the chair — and a row per screen open
   *   would bury the reads that DO disclose one patient.
   */
  it('does not write a data-access row for a configuration read', async () => {
    const before = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM data_access_logs WHERE organization_id = $1`,
      [org.organizationId]
    );
    await get(`/appointments/${appointmentId}/consultation-config`);
    const after = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM data_access_logs WHERE organization_id = $1`,
      [org.organizationId]
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("answers 404, never 403, for an appointment that is not this clinic's", async () => {
    const res = await get(`/appointments/${org.organizationId}/consultation-config`);
    expect(res.status).toBe(404);
  });
});
