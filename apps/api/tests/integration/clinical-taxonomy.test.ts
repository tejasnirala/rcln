/**
 * The clinical taxonomy over real HTTP, through the real middleware chain.
 *
 * Beyond "the endpoints respond", six things are being pinned down — each one a
 * bug that would otherwise be silent:
 *
 *   1. TRAVERSAL IS BY `parent_id`, NOT BY DEPTH. Structural Heart Disease is
 *      four levels down and Endodontics is two; both have to work through the
 *      same code path, and no caller may assume a fixed number of levels.
 *
 *   2. A TENANT CANNOT MODIFY A PLATFORM ROW, AND IT IS STOPPED TWICE.
 *      `tenant_isolation` reads permissively (`organization_id IS NULL OR = ours`)
 *      but its WITH CHECK demands `organization_id = ours`, which a platform row
 *      can never satisfy — so Postgres refuses the write. `assertMutable` in the
 *      service runs first only to turn that into a 400 that explains itself.
 *      Both layers are exercised: this suite covers the service message, and
 *      tenant-isolation.test.ts covers the database refusal.
 *
 *   3. Cycles are refused. A cycle is not a bad row, it is a hang: every
 *      ancestor walk recurses until the statement timeout.
 *
 *   4. Sibling names are unique per parent and case-insensitively so, but the
 *      SAME name under DIFFERENT parents is legal — the constraint is scoped,
 *      and a test that only checks the refusal would pass on a global unique.
 *
 *   5. Deactivation refuses to strand a subtree or detach a doctor.
 *
 *   6. FILTERING IS BY SUBTREE, NOT BY NAME. A doctor tagged only "Structural
 *      Heart Disease" must be found under Cardiology — their record contains the
 *      string "cardio" nowhere, so no `LIKE` can ever answer this.
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
const SLUG_A = `tax-a-${SUFFIX}`;
const SLUG_B = `tax-b-${SUFFIX}`;
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

/** Seeded platform nodes the assertions lean on, resolved once. */
const platform: Record<string, string> = {};

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

const asOrg = (slug: string, token: string) => {
  const send =
    (method: 'get' | 'post' | 'patch' | 'delete', base: string) =>
    (path: string, body?: object) => {
      const r = request(app)
        [method](`/api/v1/${base}${path}`)
        .set('Host', hostFor(slug))
        .set('Authorization', `Bearer ${token}`);
      return body === undefined ? r : r.send(body);
    };
  return {
    get: send('get', 'clinical-taxonomy'),
    post: send('post', 'clinical-taxonomy'),
    patch: send('patch', 'clinical-taxonomy'),
    delete: send('delete', 'clinical-taxonomy'),
    doctorsGet: send('get', 'doctors'),
    doctorsPost: send('post', 'doctors'),
    doctorsPatch: send('patch', 'doctors'),
  };
};

/** Resolve a seeded platform node id by code, as the owner (RLS-exempt). */
async function platformId(code: string): Promise<string> {
  const res = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND code = $1`,
    [code]
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`seed is missing the platform specialty ${code}`);
  return id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Tax A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Tax B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));

  for (const code of [
    'MED',
    'DEN',
    'CARDIOLOGY',
    'INTERVENTIONAL_CARDIOLOGY',
    'STRUCTURAL_HEART_DISEASE',
    'ENDODONTICS',
    'GENERAL_MEDICINE',
  ]) {
    platform[code] = await platformId(code);
  }
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    // doctor_specialties and the tenants' own specialties cascade from here.
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('reading the tree', () => {
  /**
   * ⚠️ THE ROOTS ARE CARE CONTEXTS SINCE CE-1, NOT DOMAINS (CD-3).
   *
   *   Human and Veterinary were inserted ABOVE the seven domains, because the
   *   consultation engine resolves a template by walking a doctor's
   *   classification up to its care context — veterinary dermatology and human
   *   dermatology want different forms, different vocabulary and different
   *   anatomical maps, and are otherwise indistinguishable in this tree.
   *
   *   This test changing is the POINT of that enum being a LABEL rather than a
   *   depth: inserting a level cost a `parent_id` update and this assertion, and
   *   nothing else in the traversal code moved. `doctor_specialties` points at
   *   leaves and never noticed.
   */
  it('serves the care contexts as roots, to every clinic alike', async () => {
    const res = await A.get('');

    expect(res.status).toBe(200);
    const codes = res.body.data.nodes.map((n: { code: string }) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['HUMAN', 'VET']));
    expect(res.body.data.nodes.every((n: { type: string }) => n.type === 'CARE_CONTEXT')).toBe(
      true
    );
    expect(res.body.data.nodes.every((n: { parentId: null }) => n.parentId === null)).toBe(true);
  });

  it('serves the clinical domains one level down, under Human', async () => {
    const human = await platformId('HUMAN');
    const res = await A.get(`/${human}/children`);

    expect(res.status).toBe(200);
    const codes = res.body.data.nodes.map((n: { code: string }) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['MED', 'DEN', 'MBH', 'ALH', 'DGN', 'REH']));
    expect(res.body.data.nodes.every((n: { type: string }) => n.type === 'DOMAIN')).toBe(true);
  });

  it('reports hasChildren so a selector need not probe every node', async () => {
    const res = await A.get(`/${platform['CARDIOLOGY']}/children`);

    const byName = Object.fromEntries(
      res.body.data.nodes.map((n: { name: string; hasChildren: boolean }) => [
        n.name,
        n.hasChildren,
      ])
    );
    expect(byName['Interventional Cardiology']).toBe(true);
    expect(byName['Heart Failure']).toBe(false);
  });

  it('returns children one level deep, not the whole subtree', async () => {
    const res = await A.get(`/${platform['CARDIOLOGY']}/children`);

    const names = res.body.data.nodes.map((n: { name: string }) => n.name);
    expect(names).toContain('Interventional Cardiology');
    // A grandchild. Present in /tree, absent here.
    expect(names).not.toContain('Structural Heart Disease');
  });

  it('nests a subtree to whatever depth the data has', async () => {
    const res = await A.get(`/${platform['CARDIOLOGY']}/tree`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Cardiology');

    const interventional = res.body.data.children.find(
      (c: { code: string }) => c.code === 'INTERVENTIONAL_CARDIOLOGY'
    );
    expect(interventional.children.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['Structural Heart Disease', 'Coronary Intervention'])
    );
  });

  /**
   * ⚠️ THE CENTRAL CLAIM OF THE WHOLE DESIGN. Two branches of different depths
   *   resolve through one code path. If anything ever hardcodes four levels,
   *   this is the test that fails.
   */
  it('walks ancestors to arbitrary depth, root first, excluding the node itself', async () => {
    const deep = await A.get(`/${platform['STRUCTURAL_HEART_DISEASE']}/ancestors`);
    expect(deep.status).toBe(200);
    /* ⚠️ 'Human' leads every chain since CE-1 (CD-3) — the care context is the
       root, and the domain is one level down. */
    expect(deep.body.data.ancestors.map((n: { name: string }) => n.name)).toEqual([
      'Human',
      'Medical',
      'Cardiology',
      'Interventional Cardiology',
    ]);
    expect(deep.body.data.node.name).toBe('Structural Heart Disease');
    expect(deep.body.data.node.depth).toBe(4);

    const shallow = await A.get(`/${platform['ENDODONTICS']}/ancestors`);
    expect(shallow.body.data.ancestors.map((n: { name: string }) => n.name)).toEqual([
      'Human',
      'Dental',
    ]);
    expect(shallow.body.data.node.depth).toBe(2);
  });

  /**
   * ⚠️ THE EMPTY CHAIN BELONGS TO A CARE CONTEXT NOW, NOT TO A DOMAIN (CD-3).
   *   A domain sits one level down and its chain is `['Human']`. Both are
   *   asserted, so a future change that flattens the tree fails here rather
   *   than quietly making the second case look like the first.
   */
  it('returns an empty ancestor chain for a care context, and one entry for a domain', async () => {
    const context = await A.get(`/${await platformId('HUMAN')}/ancestors`);
    expect(context.body.data.ancestors).toEqual([]);
    expect(context.body.data.node.depth).toBe(0);

    const res = await A.get(`/${platform['MED']}/ancestors`);
    expect(res.body.data.ancestors.map((n: { name: string }) => n.name)).toEqual(['Human']);
    expect(res.body.data.node.depth).toBe(1);
  });

  /**
   * ⚠️ REGRESSION GUARD, AND THE BUG IT GUARDS WAS IN THREE PLACES.
   *
   * `depth` is "distance from the root of the tenant-visible tree" — one number
   * per node, whoever asks. It was hardcoded per endpoint instead: `loadNode`
   * said 0, `/children` said 1, `/tree` counted from its own root. So
   * Interventional Cardiology answered 2 from /search, 1 from /children and 1
   * from /tree, and each endpoint looked perfectly correct in isolation.
   *
   * Anything reading depth to indent a row or pick a column label was being told
   * a different answer depending on how the node arrived.
   */
  it('reports the same depth for one node from every endpoint', async () => {
    const target = platform['INTERVENTIONAL_CARDIOLOGY'];

    const viaAncestors = await A.get(`/${target}/ancestors`);
    const viaSearch = await A.get('/search?q=Interventional Cardiology');
    const viaChildren = await A.get(`/${platform['CARDIOLOGY']}/children`);
    const viaTree = await A.get(`/${platform['MED']}/tree`);

    // HUMAN -> MED -> CARDIOLOGY -> INTERVENTIONAL_CARDIOLOGY
    const expected = 3;

    expect(viaAncestors.body.data.node.depth).toBe(expected);
    expect(viaSearch.body.data.nodes.find((n: { id: string }) => n.id === target).depth).toBe(
      expected
    );
    expect(viaChildren.body.data.nodes.find((n: { id: string }) => n.id === target).depth).toBe(
      expected
    );

    const cardiology = viaTree.body.data.children.find(
      (c: { code: string }) => c.code === 'CARDIOLOGY'
    );
    expect(cardiology.depth).toBe(2);
    expect(cardiology.children.find((c: { id: string }) => c.id === target).depth).toBe(expected);
    /*
     * The subtree root reports its own ABSOLUTE depth, not zero.
     *
     * ⚠️ THIS ASSERTION GOT STRONGER WITH CE-1. `MED` used to be a root, so the
     *   correct answer was 0 — indistinguishable from the hardcoded `0 AS depth`
     *   bug this whole test exists to guard against. Now that a care context
     *   sits above it, the correct answer is 1 and the bug would be caught.
     */
    expect(viaTree.body.data.depth).toBe(1);
  });

  it('answers 404, never 403, for an id that does not exist', async () => {
    const res = await A.get('/00000000-0000-4000-8000-000000000000/children');
    expect(res.status).toBe(404);
  });
});

describe('search', () => {
  it('matches on name across depths and reports where each hit sits', async () => {
    const res = await A.get('/search?q=cardio');

    expect(res.status).toBe(200);
    const names = res.body.data.nodes.map((n: { name: string }) => n.name);
    expect(names).toContain('Cardiology');
    expect(names).toContain('Interventional Cardiology');
    // Every hit carries its depth, so a picker can disambiguate identical names.
    expect(res.body.data.nodes.every((n: { depth: number }) => typeof n.depth === 'number')).toBe(
      true
    );
  });

  it('ranks a prefix match above a mere substring match', async () => {
    const res = await A.get('/search?q=Cardio');
    expect(res.body.data.nodes[0].name).toBe('Cardiology');
  });

  it('matches on code as well as name', async () => {
    const res = await A.get('/search?q=ENDODONTICS');
    expect(res.body.data.nodes.map((n: { code: string }) => n.code)).toContain('ENDODONTICS');
  });

  it('scopes to a subtree when asked', async () => {
    const inside = await A.get(`/search?q=cardio&underId=${platform['CARDIOLOGY']}`);
    const names = inside.body.data.nodes.map((n: { name: string }) => n.name);
    expect(names).toContain('Interventional Cardiology');
    // Cardiothoracic Surgery matches "cardio" but hangs off MED, not Cardiology.
    expect(names).not.toContain('Cardiothoracic Surgery');
  });

  it('rejects a one-character query rather than returning the catalogue', async () => {
    const res = await A.get('/search?q=a');
    expect(res.status).toBe(400);
  });
});

describe('curating the catalogue', () => {
  let ownNodeId: string;

  // Created here rather than left as a side effect of the first `it`, so that a
  // failure in one assertion cannot cascade into unrelated tests looking up
  // `/undefined` and reporting a validation error instead of what they check.
  beforeAll(async () => {
    const res = await A.post('', {
      code: 'PRP_THERAPY',
      name: 'PRP Therapy',
      parentId: platform['CARDIOLOGY'],
      type: 'FOCUS_AREA',
    });
    if (res.status !== 201) throw new Error(`fixture setup failed: ${JSON.stringify(res.body)}`);
    ownNodeId = res.body.data.id;
  });

  it("creates the node as the clinic's own, at its true depth", async () => {
    const res = await A.get(`/${ownNodeId}/ancestors`);

    expect(res.body.data.node.isOwn).toBe(true);
    // HUMAN -> MED -> CARDIOLOGY -> here. The create response must agree.
    expect(res.body.data.node.depth).toBe(3);
    expect(res.body.data.ancestors.map((n: { name: string }) => n.name)).toEqual([
      'Human',
      'Medical',
      'Cardiology',
    ]);
  });

  /**
   * ⚠️ REGRESSION GUARD. `loadNode` supplies the POST/PATCH response body, and
   *   hardcoded `0 AS depth` — so a node created three levels down answered
   *   "depth: 0" while every other endpoint reported it correctly. A cascading
   *   selector reading the create response would file a new sub-specialty under
   *   the domain column.
   */
  it('reports a real depth on the CREATE response, not zero', async () => {
    const res = await A.post('', {
      code: 'DEPTH_CHECK',
      name: 'Depth Check',
      parentId: platform['INTERVENTIONAL_CARDIOLOGY'],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.isOwn).toBe(true);
    // MED -> CARDIOLOGY -> INTERVENTIONAL_CARDIOLOGY -> here.
    expect(res.body.data.depth).toBe(4);
  });

  it('reports a real depth on the UPDATE response too', async () => {
    const res = await A.patch(`/${ownNodeId}`, { description: 'Platelet-rich plasma.' });

    expect(res.status).toBe(200);
    expect(res.body.data.depth).toBe(3);
  });

  /**
   * ⚠️ THE ONE THAT MATTERS. RLS permits this read, therefore it permits the
   *   UPDATE's USING check. Only the service refuses it. Deleting
   *   `assertMutable` would let any clinic rename Cardiology for all of them,
   *   and no other test in this repo would notice.
   */
  it('refuses to let a clinic modify a PLATFORM node', async () => {
    const res = await A.patch(`/${platform['CARDIOLOGY']}`, { name: 'Hijacked' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/platform-wide/i);

    const check = await owner.query<{ name: string }>(
      `SELECT name FROM specialties WHERE id = $1`,
      [platform['CARDIOLOGY']]
    );
    expect(check.rows[0]?.name).toBe('Cardiology');
  });

  it('refuses to let a clinic deactivate a PLATFORM node', async () => {
    const res = await A.delete(`/${platform['CARDIOLOGY']}`);
    expect(res.status).toBe(400);
  });

  it("hides one clinic's private node from another, as 404 not 403", async () => {
    const seen = await B.get(`/${ownNodeId}/children`);
    expect(seen.status).toBe(404);

    const search = await B.get('/search?q=PRP');
    expect(search.body.data.nodes).toEqual([]);
  });

  it('refuses a duplicate code within the same clinic', async () => {
    const res = await A.post('', {
      code: 'PRP_THERAPY',
      name: 'Something Else',
      parentId: platform['CARDIOLOGY'],
    });
    expect(res.status).toBe(409);
  });

  it('lets a DIFFERENT clinic reuse the same code', async () => {
    const res = await B.post('', {
      code: 'PRP_THERAPY',
      name: 'PRP Therapy',
      parentId: platform['CARDIOLOGY'],
    });
    expect(res.status).toBe(201);
  });

  it('refuses two siblings with the same name, ignoring case', async () => {
    const res = await A.post('', {
      code: 'PRP_THERAPY_2',
      name: 'prp therapy',
      parentId: platform['CARDIOLOGY'],
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/same parent/i);
  });

  /**
   * The scoping half of the constraint. Without this the suite would pass just
   * as happily against a global unique on `name`, which would be wrong — two
   * domains legitimately contain a node of the same name.
   */
  it('allows the same name under a DIFFERENT parent', async () => {
    const res = await A.post('', {
      code: 'PRP_THERAPY_DENTAL',
      name: 'PRP Therapy',
      parentId: platform['DEN'],
    });
    expect(res.status).toBe(201);
  });

  it('refuses a node parented to itself', async () => {
    const res = await A.patch(`/${ownNodeId}`, { parentId: ownNodeId });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/its own parent/i);
  });

  /**
   * A cycle is not a bad row, it is a hang — every ancestor walk would recurse
   * until the statement timeout. Refused in the service AND by the
   * `specialties_no_cycle` trigger; this exercises the service's message.
   */
  it('refuses a move that would put a node beneath its own descendant', async () => {
    const parent = await A.post('', {
      code: 'CYCLE_PARENT',
      name: 'Cycle Parent',
      parentId: platform['MED'],
    });
    const child = await A.post('', {
      code: 'CYCLE_CHILD',
      name: 'Cycle Child',
      parentId: parent.body.data.id,
    });

    const res = await A.patch(`/${parent.body.data.id}`, { parentId: child.body.data.id });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/loop|descendant/i);
  });

  it('refuses to add a node under an inactive parent', async () => {
    const parent = await A.post('', {
      code: 'RETIRED_PARENT',
      name: 'Retired Parent',
      parentId: platform['MED'],
    });
    await A.delete(`/${parent.body.data.id}`);

    const res = await A.post('', {
      code: 'ORPHAN_TO_BE',
      name: 'Orphan To Be',
      parentId: parent.body.data.id,
    });
    expect(res.status).toBe(400);
  });

  it('refuses to deactivate a node that still has active children', async () => {
    const parent = await A.post('', {
      code: 'HAS_KIDS',
      name: 'Has Kids',
      parentId: platform['MED'],
    });
    await A.post('', {
      code: 'THE_KID',
      name: 'The Kid',
      parentId: parent.body.data.id,
    });

    const res = await A.delete(`/${parent.body.data.id}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/sub-classification/i);
  });

  it('deactivates rather than deletes, so existing references keep resolving', async () => {
    const node = await A.post('', {
      code: 'TO_RETIRE',
      name: 'To Retire',
      parentId: platform['MED'],
    });

    const res = await A.delete(`/${node.body.data.id}`);
    expect(res.status).toBe(200);

    // The row is still there — a DELETE would have broken any doctor_specialty
    // pointing at it, which is why the route is a soft one.
    const row = await owner.query<{ is_active: boolean }>(
      `SELECT is_active FROM specialties WHERE id = $1`,
      [node.body.data.id]
    );
    expect(row.rows[0]?.is_active).toBe(false);

    // And it has left the default listing.
    const listed = await A.get(`/${platform['MED']}/children`);
    expect(listed.body.data.nodes.map((n: { code: string }) => n.code)).not.toContain('TO_RETIRE');

    const withInactive = await A.get(`/${platform['MED']}/children?includeInactive=true`);
    expect(withInactive.body.data.nodes.map((n: { code: string }) => n.code)).toContain(
      'TO_RETIRE'
    );
  });
});

describe('authorization', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/clinical-taxonomy').set('Host', hostFor(SLUG_A));
    expect(res.status).toBe(401);
  });

  it('answers 404 for an unknown tenant, never 403', async () => {
    const res = await request(app)
      .get('/api/v1/clinical-taxonomy')
      .set('Host', hostFor('no-such-clinic-at-all'));
    expect(res.status).toBe(404);
  });
});

/**
 * ⚠️ THE REQUIREMENT THAT NO STRING MATCH CAN SATISFY.
 *
 * The doctor below is tagged with exactly one node, four levels down. The word
 * "cardio" appears nowhere in their record. Every assertion here would fail
 * against a `LIKE '%cardiology%'` implementation, which is the whole reason the
 * filter resolves a subtree instead.
 */
describe('doctor filtering by classification subtree', () => {
  beforeAll(async () => {
    const res = await A.doctorsPost('', {
      userId: orgA.ownerUserId,
      specialtyIds: [platform['STRUCTURAL_HEART_DISEASE']],
      primarySpecialtyId: platform['STRUCTURAL_HEART_DISEASE'],
    });
    expect(res.status).toBe(201);
  });

  const countFor = async (query: string): Promise<number> => {
    const res = await A.doctorsGet(query);
    expect(res.status).toBe(200);
    return res.body.data.doctors.length;
  };

  it('finds a doctor tagged only with the leaf, from every ancestor level', async () => {
    expect(await countFor(`?specialtyId=${platform['MED']}`)).toBe(1);
    expect(await countFor(`?specialtyId=${platform['CARDIOLOGY']}`)).toBe(1);
    expect(await countFor(`?specialtyId=${platform['INTERVENTIONAL_CARDIOLOGY']}`)).toBe(1);
    expect(await countFor(`?specialtyId=${platform['STRUCTURAL_HEART_DISEASE']}`)).toBe(1);
  });

  /**
   * ⚠️ ANCESTORS ARE DERIVED, NOT STORED, AND THIS TEST PROVES BOTH HALVES.
   *
   * The doctor holds ONE `doctor_specialties` row. The API still returns the
   * whole chain above it, resolved from `parent_id` on read — which is what the
   * brief means by "do not require clients to provide redundant ancestors".
   *
   * The row count assertion is the other half: if a future change starts writing
   * an extra row per ancestor, this fails. That matters because re-parenting a
   * node would leave every such row asserting a chain that is no longer true,
   * silently.
   */
  it('returns the derived ancestor chain without storing extra rows', async () => {
    const doctors = await A.doctorsGet('');
    const classification = doctors.body.data.doctors[0].specialties[0];

    expect(classification.name).toBe('Structural Heart Disease');
    expect(classification.ancestors.map((a: { name: string }) => a.name)).toEqual([
      'Human',
      'Medical',
      'Cardiology',
      'Interventional Cardiology',
    ]);
    /* ⚠️ The chain now starts at a CARE_CONTEXT (CD-3). The types are asserted
       as well as the names, so flattening the tree cannot pass this quietly. */
    expect(classification.ancestors.map((a: { type: string }) => a.type)).toEqual([
      'CARE_CONTEXT',
      'DOMAIN',
      'DEPARTMENT',
      'SUB_SPECIALTY',
    ]);

    const stored = await owner.query<{ count: string }>(
      `SELECT count(*) AS count FROM doctor_specialties WHERE organization_id = $1`,
      [orgA.organizationId]
    );
    expect(Number(stored.rows[0]?.count)).toBe(1);
  });

  /**
   * ⚠️ RENAMED WITH CE-1. A specialty directly under a DOMAIN no longer has a
   *   one-entry chain — the care context above it makes two. The test still
   *   covers what it was for: a SHALLOW classification, walked to the top.
   */
  it('walks a shallow classification all the way to its care context', async () => {
    const doctors = await A.doctorsGet('');
    const doctorId = doctors.body.data.doctors[0].id;

    const updated = await A.doctorsPatch(`/${doctorId}`, {
      specialtyIds: [platform['GENERAL_MEDICINE']],
      primarySpecialtyId: platform['GENERAL_MEDICINE'],
    });
    expect(updated.body.data.specialties[0].ancestors.map((a: { code: string }) => a.code)).toEqual(
      ['HUMAN', 'MED']
    );

    // Put it back for the tests that follow.
    await A.doctorsPatch(`/${doctorId}`, {
      specialtyIds: [platform['STRUCTURAL_HEART_DISEASE']],
      primarySpecialtyId: platform['STRUCTURAL_HEART_DISEASE'],
    });
  });

  it('records proficiency and effective dates when supplied', async () => {
    const doctors = await A.doctorsGet('');
    const doctorId = doctors.body.data.doctors[0].id;

    const res = await A.doctorsPatch(`/${doctorId}`, {
      classifications: [
        {
          specialtyId: platform['STRUCTURAL_HEART_DISEASE'],
          proficiency: 'EXPERT',
          effectiveFrom: '2019-04-01',
        },
      ],
      primarySpecialtyId: platform['STRUCTURAL_HEART_DISEASE'],
    });

    expect(res.status).toBe(200);
    const [only] = res.body.data.specialties;
    expect(only.proficiency).toBe('EXPERT');
    expect(only.effectiveFrom).toBe('2019-04-01');
    expect(only.effectiveTo).toBeNull();
  });

  it('does not find them under an unrelated domain', async () => {
    expect(await countFor(`?specialtyId=${platform['DEN']}`)).toBe(0);
  });

  it('narrows to the exact node when descendants are excluded', async () => {
    expect(await countFor(`?specialtyId=${platform['CARDIOLOGY']}&includeDescendants=false`)).toBe(
      0
    );
    expect(
      await countFor(
        `?specialtyId=${platform['STRUCTURAL_HEART_DISEASE']}&includeDescendants=false`
      )
    ).toBe(1);
  });

  /**
   * The direction that is easy to get backwards. Asking for a structural-heart
   * specialist must not return a general cardiologist — descendants match
   * upwards, not downwards.
   */
  it('does not match a descendant filter against an ancestor tag', async () => {
    const doctors = await A.doctorsGet('');
    const doctorId = doctors.body.data.doctors[0].id;

    await A.doctorsPatch(`/${doctorId}`, {
      specialtyIds: [platform['CARDIOLOGY']],
      primarySpecialtyId: platform['CARDIOLOGY'],
    });

    expect(await countFor(`?specialtyId=${platform['CARDIOLOGY']}`)).toBe(1);
    expect(await countFor(`?specialtyId=${platform['STRUCTURAL_HEART_DISEASE']}`)).toBe(0);
  });

  /**
   * ⚠️ An unseeable id must match NOTHING. The tempting implementation lets an
   *   empty subtree fall through to "no filter applied", which lists every
   *   doctor in the clinic — a failure that looks exactly like success.
   */
  it('returns nobody for an id the tenant cannot see', async () => {
    expect(await countFor('?specialtyId=00000000-0000-4000-8000-000000000000')).toBe(0);
  });

  it('rejects a malformed id rather than ignoring the filter', async () => {
    const res = await A.doctorsGet('?specialtyId=not-a-uuid');
    expect(res.status).toBe(400);
  });
});
