/**
 * Compositions (PI-1).
 *
 * ⚠️ THIS SUITE EXISTS BECAUSE `createComposition` HAD NEVER BEEN CALLED. Every
 *   other catalogue master is reachable from a screen that shipped with PI-1;
 *   compositions were API-only until the catalogue master screens landed, and
 *   the tenant-isolation suite seeds its composition rows with raw SQL. So the
 *   nested write below typechecked, passed 2266 tests, and threw
 *   `PrismaClientValidationError` — surfaced as a bare "Invalid data provided" —
 *   the first time a human pressed the button.
 *
 * The shape being pinned is the one that broke: a composition CREATED WITH its
 * ingredients in one nested write, which is a different Prisma input type from
 * the `createMany` the update path uses.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

import {
  createActiveIngredient,
  createComposition,
  updateComposition,
} from '../../src/services/product/catalogue.service.js';

const SUFFIX = `c${Date.now().toString(36)}`;
const SLUG = `comp-${SUFFIX}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let mgUnitId: string;
let paracetamolId: string;
let clavulanicId: string;

const ctx = () => ({
  organizationId: org.organizationId,
  branchIds: [org.branchId],
  userId: org.ownerUserId,
});

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization({
    organization: {
      legalName: `Comp ${SUFFIX} Pvt Ltd`,
      displayName: 'Comp',
      slug: SLUG,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: 'Comp Main', code: 'MAIN' },
    owner: {
      fullName: 'Comp Owner',
      email: `${SLUG}@example.test`,
      phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: 'CorrectHorse9Battery',
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  });

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'MG'`
  );
  const found = unit.rows[0]?.id;
  if (!found) throw new Error('the seed is missing the MG unit');
  mgUnitId = found;

  paracetamolId = (
    await createActiveIngredient(ctx(), { code: `PARA_${SUFFIX}`, name: 'Paracetamol' })
  ).id;
  clavulanicId = (
    await createActiveIngredient(ctx(), { code: `CLAV_${SUFFIX}`, name: 'Clavulanic acid' })
  ).id;
});

afterAll(async () => {
  if (org?.organizationId) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('creating a composition with its ingredients', () => {
  it('creates the single-ingredient case', async () => {
    const created = await createComposition(ctx(), {
      code: `COMP_PARA_500_${SUFFIX}`,
      name: 'Paracetamol 500 mg',
      dosageForm: 'TABLET',
      ingredients: [
        {
          ingredientId: paracetamolId,
          strength: '500',
          strengthUnitId: mgUnitId,
          perQuantity: null,
          displayOrder: 0,
        },
      ],
    });

    expect(created.name).toBe('Paracetamol 500 mg');
    expect(created.ingredients).toHaveLength(1);
    expect(created.ingredients[0]?.strength).toBe('500');
    expect(created.ingredients[0]?.ingredientName).toBe('Paracetamol');
    expect(created.isOwn).toBe(true);
  });

  /**
   * ⚠️ THE CHILD ROWS MUST CARRY THE PARENT'S `organization_id`, and this is the
   *   assertion the fix turns on. The composite FK `(organization_id,
   *   composition_id)` and the RESTRICTIVE RLS policy both key on it — a child
   *   written with NULL there is a platform row every other tenant can read, and
   *   one written with the wrong org is a cross-tenant leak. Prisma infers it
   *   from the parent in a nested create; passing it explicitly is what threw.
   */
  it('stamps the tenant onto the ingredient rows', async () => {
    const created = await createComposition(ctx(), {
      code: `COMP_AMOXCLAV_${SUFFIX}`,
      name: 'Amoxicillin 500 mg + Clavulanic acid 125 mg',
      dosageForm: 'TABLET',
      ingredients: [
        {
          ingredientId: paracetamolId,
          strength: '500',
          strengthUnitId: mgUnitId,
          perQuantity: null,
          displayOrder: 0,
        },
        {
          ingredientId: clavulanicId,
          strength: '125',
          strengthUnitId: mgUnitId,
          perQuantity: '5',
          displayOrder: 1,
        },
      ],
    });

    expect(created.ingredients).toHaveLength(2);

    const { rows } = await owner.query<{ organization_id: string | null }>(
      'SELECT organization_id FROM composition_ingredients WHERE composition_id = $1',
      [created.id]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.organization_id).toBe(org.organizationId);
  });

  it('replaces the whole set on update', async () => {
    const created = await createComposition(ctx(), {
      code: `COMP_REPLACE_${SUFFIX}`,
      name: 'Replace me',
      dosageForm: 'TABLET',
      ingredients: [
        {
          ingredientId: paracetamolId,
          strength: '500',
          strengthUnitId: mgUnitId,
          perQuantity: null,
          displayOrder: 0,
        },
      ],
    });

    const updated = await updateComposition(ctx(), created.id, {
      ingredients: [
        {
          ingredientId: clavulanicId,
          strength: '125',
          strengthUnitId: mgUnitId,
          perQuantity: null,
          displayOrder: 0,
        },
      ],
    });

    expect(updated.ingredients).toHaveLength(1);
    expect(updated.ingredients[0]?.ingredientName).toBe('Clavulanic acid');
  });
});
