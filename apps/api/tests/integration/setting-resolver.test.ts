/**
 * The setting resolver, against real rows.
 *
 * Two things are being pinned down.
 *
 *   1. Precedence. USER > DOCTOR > BRANCH > ORGANIZATION > PLATFORM > default,
 *      most specific wins. Each level is asserted by writing a value there and
 *      watching it take over from the one below.
 *   2. THE TENANT BOUNDARY, which for this table is application code and
 *      nothing else. `setting_values` is RLS-EXEMPT — it is keyed by
 *      (scope_type, scope_id) with no organization_id, so there is no policy to
 *      filter it and `db:rls:check` will never notice a missing `where`. A
 *      resolver that pinned only the key would hand clinic A clinic B's
 *      calendar cadence, silently. That case is the reason this suite exists.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { withTenant, type TenantContext } from '@rcln/db';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import {
  resolveSettings,
  asPositiveInt,
  asBoolean,
} from '../../src/services/settings/resolver.service.js';

const SUFFIX = `s${Date.now().toString(36)}`;
const SLUG_A = `set-a-${SUFFIX}`;
const SLUG_B = `set-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const SLOT_KEY = 'appointment.slot_minutes';
const ONLINE_KEY = 'appointment.allow_online_booking';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let ctxA: TenantContext;

/** A stand-in doctor profile id — doctor_profiles does not exist until Stage 2. */
const DOCTOR_ID = '11111111-1111-4111-8111-111111111111';

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

/** Written as the owner: these are fixtures, not behaviour under test. */
async function setValue(
  key: string,
  scopeType: string,
  scopeId: string | null,
  value: unknown
): Promise<void> {
  await owner.query(
    `INSERT INTO setting_values (id, setting_key, scope_type, scope_id, value, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"SettingScopeType", $3, $4::jsonb, now())`,
    [key, scopeType, scopeId, JSON.stringify(value)]
  );
}

async function clearValues(): Promise<void> {
  await owner.query(`DELETE FROM setting_values WHERE setting_key = ANY($1)`, [
    [SLOT_KEY, ONLINE_KEY],
  ]);
}

async function resolve(scopes: Parameters<typeof resolveSettings>[2]): Promise<number> {
  const map = await withTenant(ctxA, (tx) => resolveSettings(tx, [SLOT_KEY], scopes));
  return asPositiveInt(map.get(SLOT_KEY) ?? null, -1);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  orgA = await registerOrganization(payload(SLUG_A, 'Set A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Set B'));

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  };
}, 30_000);

afterEach(async () => {
  await clearValues();
});

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  await clearValues();
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

describe('precedence', () => {
  it('falls back to the definition default when nothing is set', async () => {
    // The seeded default for appointment.slot_minutes.
    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(15);
  });

  it('a PLATFORM value overrules the definition default', async () => {
    await setValue(SLOT_KEY, 'PLATFORM', null, 20);
    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(20);
  });

  it('an ORGANIZATION value overrules PLATFORM', async () => {
    await setValue(SLOT_KEY, 'PLATFORM', null, 20);
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, 30);
    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(30);
  });

  it('a BRANCH value overrules ORGANIZATION', async () => {
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, 30);
    await setValue(SLOT_KEY, 'BRANCH', orgA.branchId, 10);

    await expect(
      resolve({ organizationId: orgA.organizationId, branchId: orgA.branchId })
    ).resolves.toBe(10);
  });

  it('a DOCTOR value overrules BRANCH', async () => {
    await setValue(SLOT_KEY, 'BRANCH', orgA.branchId, 10);
    await setValue(SLOT_KEY, 'DOCTOR', DOCTOR_ID, 45);

    await expect(
      resolve({
        organizationId: orgA.organizationId,
        branchId: orgA.branchId,
        doctorProfileId: DOCTOR_ID,
      })
    ).resolves.toBe(45);
  });

  it('a USER value overrules DOCTOR', async () => {
    await setValue(SLOT_KEY, 'DOCTOR', DOCTOR_ID, 45);
    await setValue(SLOT_KEY, 'USER', orgA.ownerUserId, 5);

    await expect(
      resolve({
        organizationId: orgA.organizationId,
        branchId: orgA.branchId,
        doctorProfileId: DOCTOR_ID,
        userId: orgA.ownerUserId,
      })
    ).resolves.toBe(5);
  });

  it('ignores a more specific value when that scope was not asked for', async () => {
    // The branch value exists, but a caller resolving org-wide must not pick it
    // up — that is what makes the org settings screen honest about its scope.
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, 30);
    await setValue(SLOT_KEY, 'BRANCH', orgA.branchId, 10);

    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(30);
  });

  it('resolves several keys in one call', async () => {
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, 25);
    await setValue(ONLINE_KEY, 'ORGANIZATION', orgA.organizationId, false);

    const map = await withTenant(ctxA, (tx) =>
      resolveSettings(tx, [SLOT_KEY, ONLINE_KEY], { organizationId: orgA.organizationId })
    );

    expect(asPositiveInt(map.get(SLOT_KEY) ?? null, -1)).toBe(25);
    expect(asBoolean(map.get(ONLINE_KEY) ?? null, true)).toBe(false);
  });
});

describe('the tenant boundary', () => {
  /*
   * The case this suite exists for.
   *
   * `setting_values` has no organization_id and no RLS policy, so if the
   * resolver pinned only (settingKey, scopeType) and took the first row, clinic
   * A would run on clinic B's cadence. Nothing else in the system would notice:
   * no error, no failing policy, and db:rls:check cannot see it.
   */
  it("is not affected by another clinic's ORGANIZATION value", async () => {
    await setValue(SLOT_KEY, 'ORGANIZATION', orgB.organizationId, 99);

    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(15);
  });

  it("is not affected by another clinic's BRANCH value", async () => {
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, 30);
    await setValue(SLOT_KEY, 'BRANCH', orgB.branchId, 99);

    await expect(
      resolve({ organizationId: orgA.organizationId, branchId: orgA.branchId })
    ).resolves.toBe(30);
  });
});

describe('coercion', () => {
  it('reads an INT setting stored as a JSON string', async () => {
    await setValue(SLOT_KEY, 'ORGANIZATION', orgA.organizationId, '40');
    await expect(resolve({ organizationId: orgA.organizationId })).resolves.toBe(40);
  });

  it('falls back rather than propagating NaN into slot arithmetic', () => {
    // A NaN slot length silently produces an empty calendar, which reads as
    // "the doctor is not working today" rather than as a bug.
    expect(asPositiveInt('not a number', 15)).toBe(15);
    expect(asPositiveInt(0, 15)).toBe(15);
    expect(asPositiveInt(-5, 15)).toBe(15);
    expect(asPositiveInt(null, 15)).toBe(15);
  });

  it('coerces booleans and falls back on anything else', () => {
    expect(asBoolean(true, false)).toBe(true);
    expect(asBoolean('false', true)).toBe(false);
    expect(asBoolean('nonsense', true)).toBe(true);
  });
});
