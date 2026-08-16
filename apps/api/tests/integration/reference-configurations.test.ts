/**
 * The reference configurations, over real HTTP (CE-7).
 *
 * ⚠️ THIS SUITE IS THE PHASE'S DEFINITION OF DONE, WRITTEN AS ASSERTIONS. CE-7
 *   promised that a second and a third specialty consultation cost a
 *   configuration row rather than a screen. What proves it is not that the
 *   endpoints respond — it is that ONE doctor, reclassified, gets three
 *   genuinely different consultations out of the same engine:
 *
 *     classified DEN         → the dentistry template, drawing the odontogram
 *     classified TRICHOLOGY  → the hair and scalp template, drawing the scalp
 *     classified as nothing  → the general consultation, drawing no chart
 *
 *   Not one line of `apps/web` and not one row of schema changed between them.
 *
 * The rest is the things that would otherwise fail silently:
 *
 *   1. ⚠️ THE SCALP MAP IS FLAT AND EVERY ZONE ANCHORS ITS OWN LABEL. A path has
 *      no centre `labelAnchorOf` can compute, so a zone that omitted the anchor
 *      would draw perfectly and be captioned nowhere — a chart of eight unnamed
 *      blobs. The seed is the only place that can get this wrong.
 *
 *   2. ⚠️ THE BODY MAP'S TWO VIEWS GROUP AND ARE NOT DRAWN, exactly as a dental
 *      quadrant does. A rectangle over the whole silhouette would swallow every
 *      click meant for a limb inside it.
 *
 *   3. ⚠️ A REFERENCE TEMPLATE IS ATTACHED TO ITS NODE AND NOT TO THE CARE
 *      CONTEXT. `specialty_id` NULL is the care-context DEFAULT — a dentistry
 *      template that lost its node would sort before `GENERAL_HUMAN` at depth 0
 *      and hand an odontogram to every human consultation in the product.
 *
 *   4. ⚠️ THE CHARTS ARE `required: false`, DELIBERATELY. A required chart
 *      refuses finalization with nothing marked on it, and a mouth with nothing
 *      wrong with it is a real consultation. This asserts a dental record signs
 *      with an untouched chart — the platform does not refuse to sign a healthy
 *      patient's record.
 *
 *   5. A procedure records WHERE it was done, from the same regions the chart
 *      draws (the picker CE-6 deferred to this phase).
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `v${Date.now().toString(36)}`;
const SLUG = `ref-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let membershipId: string;
let doctorProfileId: string;
let appointmentId: string;
let patientId: string;
let encounterId: string;
let findingItemId: string;
let procedureItemId: string;

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

/** The supported widening, per `roles.ts` — the same path a real clinic takes. */
async function grantAuthoring(): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'reference configuration test'
       FROM permissions p
      WHERE p.code IN ('clinical.encounter.create', 'clinical.encounter.close')`,
    [membershipId, org.organizationId]
  );
  await clearAccessCache();
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
const patch = api('patch');
const put = api('put');

async function platformNode(code: string): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND code = $1`,
    [code]
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error(`The platform taxonomy has no ${code} node`);
  return found.id;
}

/** Reclassify the one doctor. The whole suite turns on this. */
async function classifyAs(specialtyId: string | null): Promise<void> {
  await owner.query(`DELETE FROM doctor_specialties WHERE doctor_profile_id = $1`, [
    doctorProfileId,
  ]);
  if (specialtyId === null) return;
  await owner.query(
    `INSERT INTO doctor_specialties
       (id, organization_id, doctor_profile_id, specialty_id, is_primary, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, true, now())`,
    [org.organizationId, doctorProfileId, specialtyId]
  );
}

async function makeTerm(kind: string, code: string, name: string): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `INSERT INTO clinical_master_items
       (id, organization_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ClinicalMasterKind", $3, $4, now())
     RETURNING id`,
    [org.organizationId, kind, code, name]
  );
  return row.rows[0]!.id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Reference'));

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
  await grantAuthoring();

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctor.rows[0]!.id;

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'REFUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;

  const registration = await owner.query<{ id: string }>(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'REFMRN1', now()) RETURNING id`,
    [org.organizationId, patientId, org.branchId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'REFEP0001', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );

  const appointment = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, checked_in_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'REFAPT0001',
             now(), now() + interval '15 minutes', 'CHECKED_IN', now(), now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      registration.rows[0]!.id,
      doctorProfileId,
      episode.rows[0]!.id,
    ]
  );
  appointmentId = appointment.rows[0]!.id;

  findingItemId = await makeTerm('FINDING_TYPE', 'REF_CARIES', 'Caries');
  procedureItemId = await makeTerm('PROCEDURE', 'REF_RCT', 'Root canal treatment');
}, 40_000);

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

describe('the platform charts', () => {
  /** ⚠️ ITEM 1 IN THE HEADER. */
  it('ships the scalp as eight flat zones, each anchoring its own label', async () => {
    const list = await get('/visual-maps?pageSize=50');
    expect(list.status).toBe(200);

    const scalp = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_SCALP');
    expect(scalp).toBeDefined();
    expect(scalp.isOwn).toBe(false);
    expect(scalp.regionCount).toBe(8);

    const detail = await get(`/visual-maps/${scalp.id}`);
    expect(detail.status).toBe(200);
    const regions: {
      code: string;
      parentId: string | null;
      metadata: { shape: { kind: string }; label?: { x: number; y: number } } | null;
    }[] = detail.body.data.regions;

    expect(regions.map((r) => r.code)).toEqual(
      expect.arrayContaining(['FRONTAL_HAIRLINE', 'VERTEX', 'TEMPORAL_RIGHT', 'NAPE'])
    );
    /* Flat: no zone groups under another. The odontogram's quadrants are the
       other case, and both ship. */
    expect(regions.every((r) => r.parentId === null)).toBe(true);
    /* Drawn, as paths, and every one of them captioned. */
    for (const region of regions) {
      expect(region.metadata).not.toBeNull();
      expect(region.metadata?.shape.kind).toBe('PATH');
      expect(typeof region.metadata?.label?.x).toBe('number');
      expect(typeof region.metadata?.label?.y).toBe('number');
    }
  });

  /** ⚠️ ITEM 2. */
  it('ships the body as two views that group and are not drawn', async () => {
    const list = await get('/visual-maps?pageSize=50');
    const body = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_BODY');
    expect(body).toBeDefined();
    /* Twelve places on each of two views, plus the two views themselves. */
    expect(body.regionCount).toBe(26);

    const detail = await get(`/visual-maps/${body.id}`);
    const regions: { code: string; parentId: string | null; metadata: unknown }[] =
      detail.body.data.regions;

    const views = regions.filter((r) => r.code.startsWith('VIEW_'));
    expect(views).toHaveLength(2);
    for (const view of views) {
      /* No geometry AT ALL, which is not the same as an empty document. */
      expect(view.metadata).toBeNull();
      expect(view.parentId).toBeNull();
    }

    const viewIds = new Set(views.map((view) => view.code));
    expect(viewIds).toEqual(new Set(['VIEW_ANTERIOR', 'VIEW_POSTERIOR']));
    /* Everything else hangs off a view and is drawn. */
    for (const region of regions.filter((r) => !r.code.startsWith('VIEW_'))) {
      expect(region.parentId).not.toBeNull();
      expect(region.metadata).not.toBeNull();
    }

    /*
     * ⚠️ THE SIDES MIRROR BETWEEN THE VIEWS, and the codes are the patient's
     *   side on both. A chart that laid the two out identically would collect
     *   half its marks on the wrong limb.
     */
    expect(regions.map((r) => r.code)).toEqual(
      expect.arrayContaining(['ANT_ARM_R', 'ANT_ARM_L', 'POST_ARM_R', 'POST_ARM_L'])
    );
  });

  /** A body diagram is nobody's specialty in particular. */
  it('offers the body map across the whole care context', async () => {
    const list = await get('/visual-maps?pageSize=50');
    const body = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_BODY');
    expect(body.specialtyId).toBeNull();
    expect(body.careContextName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('one doctor, three consultations', () => {
  it('gives a dentist the dentistry template and its odontogram', async () => {
    await classifyAs(await platformNode('DEN'));

    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('DENTAL_HUMAN');
    /* ⚠️ ITEM 3: attached to the node, not to the care context. */
    expect(res.body.data.template.matchedSpecialtyId).not.toBeNull();
    expect(res.body.data.template.matchedDepth).toBeGreaterThan(0);

    const chart = res.body.data.sections.find((s: { type: string }) => s.type === 'VISUAL_MAPPING');
    expect(chart.key).toBe('odontogram');
    expect(chart.mapCode).toBe('HUMAN_DENTAL');
    /* The code became a picture on the server (CD-6, §33). */
    expect(chart.map.regions).toHaveLength(36);
    /* ⚠️ ITEM 4. */
    expect(chart.required).toBe(false);

    const history = res.body.data.sections.find((s: { key: string }) => s.key === 'dental_history');
    expect(history.fields.map((f: { key: string }) => f.key)).toContain('habits');
  });

  it('gives a trichologist the hair and scalp template and its scalp chart', async () => {
    await classifyAs(await platformNode('TRICHOLOGY'));

    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('HAIR_SCALP_HUMAN');

    const chart = res.body.data.sections.find((s: { type: string }) => s.type === 'VISUAL_MAPPING');
    expect(chart.key).toBe('scalp_chart');
    expect(chart.mapCode).toBe('HUMAN_SCALP');
    expect(chart.map.regions).toHaveLength(8);

    const examination = res.body.data.sections.find(
      (s: { key: string }) => s.key === 'scalp_examination'
    );
    const grade = examination.fields.find((f: { key: string }) => f.key === 'pattern_grade');
    /* Published scales, named as such — Norwood and Ludwig. Nothing invented. */
    expect(grade.options.map((o: { label: string }) => o.label)).toContain('Norwood III');
    const density = examination.fields.find((f: { key: string }) => f.key === 'hair_density');
    expect(density.type).toBe('MEASUREMENT');
    expect(density.unit).toBe('hairs/cm²');
  });

  /**
   * ⚠️ A DERMATOLOGIST WHO IS NOT A TRICHOLOGIST IS UNAFFECTED, and this is the
   *   assertion behind attaching the hair template at the FOCUS AREA rather than
   *   at the department. Specificity only ever walks up: somebody treating acne
   *   under a department-level hair template would have no way to decline it.
   */
  it('leaves the rest of dermatology on the general consultation', async () => {
    await classifyAs(await platformNode('DERMATOLOGY'));

    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('GENERAL_HUMAN');
    expect(res.body.data.sections.some((s: { type: string }) => s.type === 'VISUAL_MAPPING')).toBe(
      false
    );
  });

  it('gives an unclassified doctor the general consultation, and no chart', async () => {
    await classifyAs(null);

    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);
    expect(res.body.data.template.code).toBe('GENERAL_HUMAN');
    expect(res.body.data.template.matchedSpecialtyId).toBeNull();
    expect(res.body.data.template.matchedDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('a dental consultation, end to end', () => {
  it('opens under the platform dentistry template', async () => {
    await classifyAs(await platformNode('DEN'));

    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(201);
    encounterId = res.body.data.id as string;

    /*
     * ⚠️ THE FROZEN SNAPSHOT, NOT THE TEMPLATE ROW (§29). What a record renders
     *   through for ever is the configuration copied onto it when it opened —
     *   so that is what this asserts, and editing the platform template
     *   tomorrow changes nothing about this consultation.
     */
    const chart = res.body.data.configuration.find(
      (s: { type: string }) => s.type === 'VISUAL_MAPPING'
    );
    expect(chart.mapCode).toBe('HUMAN_DENTAL');
  });

  it('marks a tooth on the platform odontogram', async () => {
    const config = await get(`/appointments/${appointmentId}/consultation-config`);
    const chart = config.body.data.sections.find(
      (s: { type: string }) => s.type === 'VISUAL_MAPPING'
    );
    const tooth = chart.map.regions.find((r: { code: string }) => r.code === 'TOOTH_36');
    expect(tooth).toBeDefined();

    const res = await post(`/encounters/${encounterId}/findings`, {
      sectionKey: 'odontogram',
      visualRegionId: tooth.id,
      findingItemId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.findings[0].region.code).toBe('TOOTH_36');
  });

  /** ⚠️ ITEM 5 — the picker CE-6 deferred, over the API it deferred it onto. */
  it('records the procedure against the tooth it was done on', async () => {
    const content = await get(`/encounters/${encounterId}`);
    const regionId = content.body.data.content.findings[0].region.id as string;

    const res = await post(`/encounters/${encounterId}/procedures`, {
      itemId: procedureItemId,
      visualRegionId: regionId,
      status: 'PERFORMED',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.procedures[0].region.code).toBe('TOOTH_36');
  });

  it('signs the record', async () => {
    await patch(`/encounters/${encounterId}`, { chiefComplaint: 'Pain on the lower left' });
    await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: true,
      intervalValue: 14,
      intervalUnit: 'DAYS',
      reason: 'Review the restoration',
    });

    const res = await post(`/encounters/${encounterId}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FINALIZED');
  });
});

// ---------------------------------------------------------------------------

/** ⚠️ ITEM 4, stated as its own case: an untouched chart does not block a signature. */
describe('a dental consultation with nothing wrong', () => {
  it('signs with the odontogram untouched', async () => {
    const registration = await owner.query<{ id: string }>(
      `SELECT id FROM patient_registrations WHERE patient_id = $1`,
      [patientId]
    );
    const episode = await owner.query<{ id: string }>(
      `SELECT id FROM clinical_episodes WHERE patient_id = $1`,
      [patientId]
    );
    const second = await owner.query<{ id: string }>(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, clinical_episode_id, appointment_number,
          scheduled_start, scheduled_end, status, checked_in_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'REFAPT0002',
               now() + interval '1 day', now() + interval '1 day 15 minutes',
               'CHECKED_IN', now(), now())
       RETURNING id`,
      [
        org.organizationId,
        org.branchId,
        patientId,
        registration.rows[0]!.id,
        doctorProfileId,
        episode.rows[0]!.id,
      ]
    );
    const checkUpId = second.rows[0]!.id;

    const opened = await post('/encounters', { appointmentId: checkUpId });
    expect(opened.status).toBe(201);
    const id = opened.body.data.id as string;

    await patch(`/encounters/${id}`, { chiefComplaint: 'Routine check-up' });
    await put(`/encounters/${id}/follow-up`, {
      isRequired: true,
      intervalValue: 6,
      intervalUnit: 'MONTHS',
      reason: 'Routine review',
    });

    const res = await post(`/encounters/${id}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.data.content.findings).toHaveLength(0);
  });
});
