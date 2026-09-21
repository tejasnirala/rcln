/**
 * The setup wizard over real HTTP, through the real middleware chain (CO-1).
 *
 * Four things are being pinned down here beyond "the endpoints work", and every
 * one of them is a property that would fail silently:
 *
 *   1. **Seeding never overwrites.** The wizard writes `setting_values` rows
 *      only where the clinic has not already answered. That is what makes
 *      re-entering a step in year two safe, and a seeder that upserted would
 *      revert a tuned value with no error anywhere. ADR-0018 rests on it.
 *   2. **One care context seeds a default; two do not.** The pet clinic. This is
 *      the behaviour the whole feature exists to produce.
 *   3. **`registered_at` survived its rename.** The column used to be called
 *      `onboarded_at` and used to be set by registration, so a clinic that had
 *      merely registered would have read as fully onboarded. The rename is a
 *      hand-written `ALTER ... RENAME` in the migration; Prisma generates
 *      DROP + ADD, which loses every value.
 *   4. **A plan refusal is a 400, not a 403 and not a 422.** A permission status
 *      would send the clinic to their administrator instead of to billing, and
 *      422 on this API means a jurisdiction refused something.
 *
 * ⚠️ `setting_values` IS RLS-EXEMPT, so the tenant-isolation suite has no case
 *   for it and structurally cannot have one — there is no policy to prove. The
 *   cross-clinic case at the foot of this file is the only thing asserting that
 *   the seeder's pinned `(key, scopeType, scopeId)` predicates actually isolate.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `o${Date.now().toString(36)}`;
const SLUG_A = `ob-a-${SUFFIX}`;
const SLUG_B = `ob-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };

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
  get: () =>
    request(app)
      .get('/api/v1/onboarding')
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
  put: (path: string, body: object) =>
    request(app)
      .put(`/api/v1/onboarding${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`)
      .send(body),
  complete: () =>
    request(app)
      .post('/api/v1/onboarding/complete')
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
});

let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

/** The two platform care contexts, by code, as `seed/data/specialties.ts` names them. */
async function careContextId(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE code = $1 AND type = 'CARE_CONTEXT' AND organization_id IS NULL`,
    [code]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`the ${code} care context is not seeded; run pnpm db:seed`);
  return id;
}

async function settingAt(
  key: string,
  scopeType: string,
  scopeId: string
): Promise<unknown | undefined> {
  const { rows } = await owner.query<{ value: unknown }>(
    `SELECT value FROM setting_values
      WHERE setting_key = $1 AND scope_type = $2 AND scope_id = $3`,
    [key, scopeType, scopeId]
  );
  return rows[0]?.value;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Onboarding A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Onboarding B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));
}, 30_000);

afterAll(async () => {
  await owner.end();
  await disconnectDb();
  await redis.quit();
});

describe('onboarding', () => {
  it('reports a freshly registered clinic as not set up', async () => {
    const res = await A.get();

    expect(res.status).toBe(200);
    expect(res.body.data.completedAt).toBeNull();
    expect(res.body.data.profile.careContextIds).toEqual([]);
    expect(res.body.data.steps).toHaveLength(7);
    expect(res.body.data.steps.every((s: { completedAt: null }) => s.completedAt === null)).toBe(
      true
    );
  });

  /**
   * ⚠️ THE RENAME, ASSERTED. `registered_at` is stamped by registration and has
   *   always meant "registered" — it was called `onboarded_at`, which is why
   *   reusing it for wizard completion would have marked every clinic on the
   *   platform as already onboarded. If the migration ever ships with Prisma's
   *   generated DROP + ADD instead of the hand-written RENAME, this is null.
   */
  it('kept the registration timestamp through the rename', async () => {
    const { rows } = await owner.query<{ registered_at: Date | null }>(
      'SELECT registered_at FROM organizations WHERE id = $1',
      [orgA.organizationId]
    );
    expect(rows[0]?.registered_at).toBeInstanceOf(Date);
  });

  it('offers the platform care contexts and the entitled modules', async () => {
    const res = await A.get();

    const codes = res.body.data.careContextOptions.map((o: { code: string }) => o.code);
    expect(codes).toContain('HUMAN');
    expect(codes).toContain('VET');

    /*
     * STARTER has `pharmacy_module: false`, so the counter is offered and the
     * pharmacy is not. Appointments is ungated and must always be there — a
     * clinic that cannot book is not a clinic.
     */
    expect(res.body.data.entitledModules).toContain('APPOINTMENTS');
    expect(res.body.data.entitledModules).not.toContain('PHARMACY');
  });

  // -- the pet clinic --------------------------------------------------------

  /**
   * ⚠️ THE CASE THE WHOLE FEATURE EXISTS FOR. One care context means the front
   *   desk is never asked "person or animal?", so a default must be seeded for
   *   it — and `VET` must seed ANIMAL rather than the column's own HUMAN
   *   default, which is what a clinic registering dogs as people would look
   *   like.
   */
  it('seeds ANIMAL as the default when a clinic treats only animals', async () => {
    const vet = await careContextId('VET');

    const res = await A.put('/steps/care-contexts', { careContextIds: [vet] });
    expect(res.status).toBe(200);

    expect(
      await settingAt('patient.default_subject_type', 'ORGANIZATION', orgA.organizationId)
    ).toBe('ANIMAL');
    expect(res.body.data.profile.careContextCodes).toEqual(['VET']);
  });

  /**
   * ⚠️ AND THE SEED IS NOT REVISED WHEN THE ANSWER CHANGES, WHICH IS THE HALF
   *   THAT LOOKS LIKE A BUG AND IS NOT. Adding a second context means the picker
   *   appears, so the stored default becomes only what it starts on — and it is
   *   now a value the clinic OWNS. Overwriting it here would be the wizard
   *   overruling a settings screen, which is exactly what ADR-0018 forbids.
   */
  it('leaves the seeded default alone when a second context is added', async () => {
    const [vet, human] = [await careContextId('VET'), await careContextId('HUMAN')];

    const res = await A.put('/steps/care-contexts', { careContextIds: [vet, human] });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.careContextIds).toHaveLength(2);

    expect(
      await settingAt('patient.default_subject_type', 'ORGANIZATION', orgA.organizationId)
    ).toBe('ANIMAL');
  });

  it('refuses a care context that is not one', async () => {
    // A SPECIALTY id rather than a CARE_CONTEXT one. The FK would accept it.
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM specialties WHERE type <> 'CARE_CONTEXT' AND organization_id IS NULL LIMIT 1`
    );
    if (!rows[0]) return; // no platform specialties seeded; nothing to prove here

    const res = await A.put('/steps/care-contexts', { careContextIds: [rows[0].id] });
    expect(res.status).toBe(400);
  });

  it('refuses an empty list of care contexts', async () => {
    const res = await A.put('/steps/care-contexts', { careContextIds: [] });
    expect(res.status).toBe(400);
  });

  // -- modules and the plan --------------------------------------------------

  /**
   * ⚠️ 400, AND SPECIFICALLY NOT 403 OR 422. A 403 is a statement about the
   *   caller and sends them to their administrator; 422 on this API means a
   *   jurisdiction refused something and carries rule codes. This is a
   *   commercial limit and belongs to neither.
   */
  it('refuses a module the plan does not include, as a 400', async () => {
    const res = await A.put('/steps/modules', { modules: ['PHARMACY'] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/plan/i);
  });

  it('accepts the modules the plan does include', async () => {
    const res = await A.put('/steps/modules', {
      modules: ['APPOINTMENTS', 'CONSULTATIONS', 'BILLING'],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.modules).toEqual(
      expect.arrayContaining(['APPOINTMENTS', 'CONSULTATIONS', 'BILLING'])
    );
  });

  it('replaces the module set rather than adding to it', async () => {
    const res = await A.put('/steps/modules', { modules: ['APPOINTMENTS'] });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.modules).toEqual(['APPOINTMENTS']);
  });

  // -- seeding never overwrites ---------------------------------------------

  /**
   * ⚠️ THE PROPERTY ADR-0018 RESTS ON. The clinic tunes a value in Settings;
   *   re-running the step that seeded it must leave that alone. A seeder that
   *   upserted would pass every other test in this file and quietly revert a
   *   clinic's configuration every time somebody revisited setup.
   */
  it('does not overwrite a value the clinic has since set itself', async () => {
    await A.put('/steps/tax', { invoicePrefix: 'SEED' });
    expect(await settingAt('billing.invoice_prefix', 'ORGANIZATION', orgA.organizationId)).toBe(
      'SEED'
    );

    // The clinic changes its mind through the settings screen's own path.
    await owner.query(
      `UPDATE setting_values SET value = '"TUNED"'::jsonb
        WHERE setting_key = 'billing.invoice_prefix'
          AND scope_type = 'ORGANIZATION' AND scope_id = $1`,
      [orgA.organizationId]
    );

    await A.put('/steps/tax', { invoicePrefix: 'SEED_AGAIN' });

    expect(await settingAt('billing.invoice_prefix', 'ORGANIZATION', orgA.organizationId)).toBe(
      'TUNED'
    );
  });

  // -- completion ------------------------------------------------------------

  it('finishes without every step being answered', async () => {
    const res = await A.complete();

    expect(res.status).toBe(200);
    expect(res.body.data.completedAt).not.toBeNull();

    const { rows } = await owner.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM clinic_profiles WHERE organization_id = $1 AND branch_id IS NULL',
      [orgA.organizationId]
    );
    expect(rows[0]?.completed_at).toBeInstanceOf(Date);
  });

  it('answers 404 for a branch belonging to another clinic', async () => {
    const vet = await careContextId('VET');

    const res = await A.put('/steps/care-contexts', {
      branchId: orgB.branchId,
      careContextIds: [vet],
    });

    expect(res.status).toBe(404);
  });

  // -- the seeder's isolation, which no RLS policy covers --------------------

  /**
   * ⚠️ THE ONLY ASSERTION IN THIS REPOSITORY THAT THE SEEDER SCOPES CORRECTLY.
   *   `setting_values` has no `organization_id` and no policy, so a `where` that
   *   named only the key would write every clinic's row and `db:rls:check` would
   *   stay green. A ran its wizard above; B must be untouched.
   */
  it("leaves another clinic's settings alone", async () => {
    expect(
      await settingAt('patient.default_subject_type', 'ORGANIZATION', orgB.organizationId)
    ).toBeUndefined();
    expect(
      await settingAt('billing.invoice_prefix', 'ORGANIZATION', orgB.organizationId)
    ).toBeUndefined();

    const res = await B.get();
    expect(res.body.data.completedAt).toBeNull();
    expect(res.body.data.profile.modules).toEqual([]);
  });
});
