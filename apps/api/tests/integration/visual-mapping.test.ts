/**
 * The visual mapping engine, over real HTTP (CE-6).
 *
 * Beyond "the endpoints respond", these are the things pinned down here, and
 * every one of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ A REQUIRED CHART WITH NOTHING ON IT CANNOT BE SIGNED. `VISUAL_MAPPING`
 *      used to fall through `countFor`'s default and answer "there is something
 *      there", because it was required-able with no table behind it. This is the
 *      test that closes it: finalize refuses, and then succeeds once a finding
 *      exists. Without it the hole reopens the first time somebody tidies that
 *      switch.
 *
 *   2. ⚠️ GEOMETRY THAT SAYS NOTHING CHECKABLE IS REFUSED. `w` for `width` comes
 *      back a 400 naming the key, rather than a tooth silently missing from a
 *      chart — and BOTH shapes of "nothing" are covered, the document that is
 *      ABSENT and the one that EXISTS and is empty. Covering only the first is
 *      exactly the gap that let PI-5 ship a permissive typo.
 *
 *   3. ⚠️ A REGION A RECORD CITES CANNOT BE DELETED. The FK is `Restrict`, so
 *      without the service's check this is a raw foreign-key violation for an
 *      action somebody will reasonably attempt.
 *
 *   4. ⚠️ REMOVING A DIAGNOSIS UNLINKS THE FINDINGS CITING IT, exactly as it
 *      already unlinks the procedures. The composite includes `organization_id`,
 *      which is NOT NULL, so `SetNull` is not available and the service has to
 *      do it — CE-4 learned this on procedures and CE-6 inherits it.
 *
 *   5. ⚠️ AN AMENDMENT COPIES THE FINDINGS AND REMAPS THEIR DIAGNOSIS LINKS. A
 *      straight copy leaves a finding on the amendment citing a diagnosis on the
 *      ORIGINAL — a reference the composite FK happily permits and no screen can
 *      render.
 *
 *   6. A tenant cannot modify the platform's odontogram, and gets a sentence
 *      rather than a constraint name.
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
const SLUG = `map-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let membershipId: string;
let humanContextId: string;
let dentalNodeId: string;
let appointmentId: string;
let encounterId: string;
let findingItemId: string;
let diagnosisItemId: string;
/** The clinic's own chart, and the two regions on it. */
let mapId: string;
let quadrantId: string;
let toothId: string;

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
 * ⚠️ THE SUPPORTED WIDENING, NOT A TEST SHORTCUT. `roles.ts` says a clinic that
 *   wants somebody other than a seeded DOCTOR to write up a consultation grants
 *   the codes per membership, so the fixture takes the path a real clinic would.
 *   The owner already holds `clinical.visual_map.manage` — it is an
 *   "everything except" role and the manage code is deliberately not excepted.
 */
async function grantAuthoring(): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'visual mapping test'
       FROM permissions p
      WHERE p.code IN ('clinical.encounter.create', 'clinical.encounter.close',
                       'clinical.encounter.amend')`,
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
const del = api('delete');

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

/** A tooth-shaped box. The shape the odontogram seed uses. */
const TOOTH = { shape: { kind: 'RECT', x: 8, y: 40, width: 34, height: 60, radius: 6 } };

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Charts'));

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

  humanContextId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'HUMAN'`
    )
  ).rows[0]!.id;
  dentalNodeId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE organization_id IS NULL AND code = 'DEN'`
    )
  ).rows[0]!.id;

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  const doctorProfileId = doctor.rows[0]!.id;

  /* Classified, so the clinic's own dentistry template is what resolves. */
  await owner.query(
    `INSERT INTO doctor_specialties
       (id, organization_id, doctor_profile_id, specialty_id, is_primary, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, true, now())`,
    [org.organizationId, doctorProfileId, dentalNodeId]
  );

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'MAPUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  const patientId = patient.rows[0]!.id;

  const registration = await owner.query<{ id: string }>(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'MAPMRN1', now()) RETURNING id`,
    [org.organizationId, patientId, org.branchId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'MAPEP0001', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );

  const appointment = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, checked_in_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'MAPAPT0001',
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

  findingItemId = await makeTerm('FINDING_TYPE', 'MAP_CARIES', 'Caries');
  diagnosisItemId = await makeTerm('DIAGNOSIS', 'MAP_CARIES_DX', 'Dental caries');
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

describe('the platform odontogram', () => {
  it('ships the 32 FDI teeth and their four quadrants', async () => {
    const list = await get('/visual-maps?pageSize=50');
    expect(list.status).toBe(200);

    const dental = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_DENTAL');
    expect(dental).toBeDefined();
    expect(dental.isOwn).toBe(false);
    /* 32 teeth + 4 quadrants. A count that drifts is a seed that half ran. */
    expect(dental.regionCount).toBe(36);

    const detail = await get(`/visual-maps/${dental.id}`);
    expect(detail.status).toBe(200);
    const codes = detail.body.data.regions.map((r: { code: string }) => r.code);
    expect(codes).toContain('TOOTH_11');
    expect(codes).toContain('TOOTH_48');
    /* ⚠️ FDI, never an index — see CD-11. */
    expect(codes).not.toContain('TOOTH_1');

    /* A quadrant groups and is not drawn: no geometry at all, not an empty one. */
    const quadrant = detail.body.data.regions.find(
      (r: { code: string }) => r.code === 'QUADRANT_1'
    );
    expect(quadrant.metadata).toBeNull();
  });

  it('refuses to let a tenant modify the platform chart', async () => {
    const list = await get('/visual-maps?pageSize=50');
    const dental = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_DENTAL');

    const res = await patch(`/visual-maps/${dental.id}`, { name: 'Ours now' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/platform-wide/i);
  });
});

describe('a chart of the clinic’s own', () => {
  it('creates one, empty', async () => {
    const res = await post('/visual-maps', {
      code: 'MAP_TEST',
      name: 'Test chart',
      careContextId: humanContextId,
      specialtyId: dentalNodeId,
      viewBox: '0 0 200 200',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.regions).toHaveLength(0);
    mapId = res.body.data.id;
  });

  it('refuses a coordinate space that is not four numbers', async () => {
    const res = await post('/visual-maps', {
      code: 'MAP_BROKEN',
      name: 'Broken',
      careContextId: humanContextId,
      viewBox: '0 0 200',
    });
    expect(res.status).toBe(400);
  });

  it('takes a grouping region with no geometry at all', async () => {
    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'QUADRANT_1',
      label: 'Upper right',
    });
    expect(res.status).toBe(201);
    quadrantId = res.body.data.regions.find((r: { code: string }) => r.code === 'QUADRANT_1')
      .id as string;
  });

  /** ⚠️ The other half of the pair. See the file header. */
  it('REFUSES a geometry document that exists and is empty', async () => {
    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'EMPTY',
      label: 'Empty',
      metadata: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/empty geometry/i);
  });

  it('refuses a rectangle whose width is misspelled, and names the key', async () => {
    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'TYPO',
      label: 'Typo',
      metadata: { shape: { kind: 'RECT', x: 0, y: 0, w: 10, height: 10 } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/"width"/);
  });

  it('adds a drawn region under the quadrant', async () => {
    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'TOOTH_16',
      label: '16',
      parentId: quadrantId,
      metadata: TOOTH,
    });
    expect(res.status).toBe(201);
    toothId = res.body.data.regions.find((r: { code: string }) => r.code === 'TOOTH_16')
      .id as string;
  });

  it('refuses a second region with the same code', async () => {
    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'TOOTH_16',
      label: '16 again',
      metadata: TOOTH,
    });
    expect(res.status).toBe(409);
  });

  /**
   * ⚠️ CHECKED BY A TRIGGER AND ANNOUNCED BY THE SERVICE. The foreign key says
   *   only "a region", so without both a quadrant of one chart could group a
   *   zone of another and the walk would leave the picture.
   */
  it('refuses a parent on a different chart', async () => {
    const list = await get('/visual-maps?pageSize=50');
    const dental = list.body.data.items.find((m: { code: string }) => m.code === 'HUMAN_DENTAL');
    const foreign = await get(`/visual-maps/${dental.id}`);
    const foreignRegionId = foreign.body.data.regions[0].id as string;

    const res = await post(`/visual-maps/${mapId}/regions`, {
      code: 'STRAY',
      label: 'Stray',
      parentId: foreignRegionId,
      metadata: TOOTH,
    });
    expect(res.status).toBe(400);
  });

  it('refuses removing a region that groups others', async () => {
    const res = await del(`/visual-maps/${mapId}/regions/${quadrantId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/groups others/i);
  });
});

describe('the chart on a consultation', () => {
  let templateId: string;

  it('publishes a template whose chart section is REQUIRED', async () => {
    const created = await post('/consultation-templates', {
      code: 'MAP_DENTAL',
      name: 'Dental consultation',
      careContextId: humanContextId,
      specialtyId: dentalNodeId,
    });
    expect(created.status).toBe(201);
    templateId = created.body.data.id as string;
    const draftId = created.body.data.draftVersion.id as string;

    const saved = await put(`/consultation-templates/${templateId}/versions/${draftId}`, {
      definition: {
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
          {
            type: 'DIAGNOSIS',
            key: 'diagnosis',
            label: 'Diagnosis',
            order: 30,
            visible: true,
            required: false,
          },
          {
            /* ⚠️ The section this whole phase exists for, and it is REQUIRED. */
            type: 'VISUAL_MAPPING',
            key: 'odontogram',
            label: 'Chart',
            order: 20,
            visible: true,
            required: true,
            mapCode: 'MAP_TEST',
          },
        ],
      },
    });
    expect(saved.status).toBe(200);

    const published = await post(
      `/consultation-templates/${templateId}/versions/${draftId}/publish`
    );
    expect(published.status).toBe(200);
  });

  /**
   * ⚠️ THE CODE BECOMES A PICTURE ON THE SERVER (CD-6, §33). A definition holds
   *   a `mapCode` and never an id; the browser is handed the regions already
   *   resolved and decides nothing.
   */
  it('resolves the chart onto the section, regions and all', async () => {
    const res = await get(`/appointments/${appointmentId}/consultation-config`);
    expect(res.status).toBe(200);

    const section = res.body.data.sections.find(
      (s: { type: string }) => s.type === 'VISUAL_MAPPING'
    );
    expect(section.mapCode).toBe('MAP_TEST');
    expect(section.map.code).toBe('MAP_TEST');
    expect(section.map.regions).toHaveLength(2);
  });

  it('opens the consultation under that template', async () => {
    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(201);
    encounterId = res.body.data.id as string;
    expect(res.body.data.content.findings).toEqual([]);
  });

  /** ⚠️ ITEM 1 IN THE HEADER. The hole `countFor`'s default used to leave open. */
  it('refuses to sign a required chart with nothing drawn on it', async () => {
    await patch(`/encounters/${encounterId}`, { chiefComplaint: 'Pain on the upper right' });

    const res = await post(`/encounters/${encounterId}/finalize`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Chart/);
  });

  it('records a finding on a region', async () => {
    const res = await post(`/encounters/${encounterId}/findings`, {
      sectionKey: 'odontogram',
      visualRegionId: toothId,
      findingItemId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.findings).toHaveLength(1);
    expect(res.body.data.findings[0].region.code).toBe('TOOTH_16');
    expect(res.body.data.findings[0].item.name).toBe('Caries');
    expect(res.body.data.findings[0].sectionKey).toBe('odontogram');
  });

  it('refuses the same word twice on the same region — that is a double click', async () => {
    const res = await post(`/encounters/${encounterId}/findings`, {
      sectionKey: 'odontogram',
      visualRegionId: toothId,
      findingItemId,
    });
    expect(res.status).toBe(409);
  });

  it('refuses a region from outside the caller’s reach', async () => {
    const res = await post(`/encounters/${encounterId}/findings`, {
      sectionKey: 'odontogram',
      visualRegionId: '00000000-0000-4000-8000-000000000000',
      findingItemId,
    });
    expect(res.status).toBe(404);
  });

  it('links the finding to a diagnosis recorded at the same visit', async () => {
    const diagnosis = await post(`/encounters/${encounterId}/diagnoses`, {
      itemId: diagnosisItemId,
      role: 'PRIMARY',
    });
    expect(diagnosis.status).toBe(201);
    const diagnosisId = diagnosis.body.data.diagnoses[0].id as string;

    const content = await get(`/encounters/${encounterId}`);
    const findingId = content.body.data.content.findings[0].id as string;

    const res = await patch(`/encounters/${encounterId}/findings/${findingId}`, {
      diagnosisId,
      severity: 'MODERATE',
      notes: 'Occlusal surface',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.findings[0].diagnosisId).toBe(diagnosisId);
    expect(res.body.data.findings[0].severity).toBe('MODERATE');
  });

  /** ⚠️ ITEM 3. `Restrict`, so this is a 409 and not a stack trace. */
  it('refuses to delete a region a consultation has drawn on', async () => {
    const res = await del(`/visual-maps/${mapId}/regions/${toothId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already refer/i);
  });

  /** ⚠️ ITEM 4. The lesson CE-4 learned on procedures, inherited. */
  it('unlinks the finding when the diagnosis it explains is removed', async () => {
    const before = await get(`/encounters/${encounterId}`);
    const diagnosisId = before.body.data.content.diagnoses[0].id as string;

    const res = await del(`/encounters/${encounterId}/diagnoses/${diagnosisId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.diagnoses).toHaveLength(0);
    /* The finding stays. What was FOUND is still true; only the link went. */
    expect(res.body.data.findings).toHaveLength(1);
    expect(res.body.data.findings[0].diagnosisId).toBeNull();
  });

  it('signs once the chart has something on it', async () => {
    const res = await post(`/encounters/${encounterId}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FINALIZED');
    expect(res.body.data.content.findings).toHaveLength(1);
  });

  it('refuses every finding writer past FINALIZED', async () => {
    const res = await post(`/encounters/${encounterId}/findings`, {
      sectionKey: 'odontogram',
      visualRegionId: quadrantId,
      findingItemId,
    });
    expect(res.status).toBe(409);
  });

  /** ⚠️ ITEM 5. */
  it('copies the findings onto an amendment, remapping the diagnosis link', async () => {
    const amended = await post(`/encounters/${encounterId}/amend`, {
      reason: 'The chart was marked on the wrong tooth',
    });
    expect(amended.status).toBe(201);

    const findings = amended.body.data.content.findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].region.code).toBe('TOOTH_16');
    /* A copy, not a move: the original still carries its own. */
    expect(findings[0].id).not.toBe(encounterId);

    const original = await get(`/encounters/${encounterId}`);
    expect(original.body.data.content.findings).toHaveLength(1);
  });

  it('counts the findings on the visit history', async () => {
    const original = await get(`/encounters/${encounterId}`);
    const patientId = original.body.data.patientId as string;

    const res = await get(`/patients/${patientId}/visit-history`);
    expect(res.status).toBe(200);
    const visits = res.body.data.episodes.flatMap(
      (episode: { visits: unknown[] }) => episode.visits
    );
    const withChart = visits.find(
      (visit: { encounter: { findingCount: number } | null }) =>
        visit.encounter !== null && visit.encounter.findingCount > 0
    );
    expect(withChart).toBeDefined();
  });
});
