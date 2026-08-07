/**
 * Document numbering under concurrency.
 *
 * The whole value of `issueNumber` is a claim about what happens when two
 * receptionists press the button at the same instant, so that is what this
 * suite measures — real transactions against real Postgres, fired in parallel,
 * not a simulation with a mocked clock.
 *
 * Three things are being pinned down:
 *
 *   1. No duplicates and no gaps under parallel load. A duplicate UHID means two
 *      patients share a hospital number; a gap in an appointment series is what
 *      an auditor asks about.
 *   2. The number rolls back with its transaction. This is the property a
 *      Postgres SEQUENCE would NOT give us and the reason this table exists.
 *   3. Counters are isolated by tenant and by branch, so clinic B's first
 *      patient is P000001 even after clinic A has issued forty.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { withTenant, type TenantContext } from '@rcln/db';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import {
  issueNumber,
  financialYearOf,
} from '../../src/services/numbering/number-sequence.service.js';

const SUFFIX = `n${Date.now().toString(36)}`;
const SLUG_A = `num-a-${SUFFIX}`;
const SLUG_B = `num-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let ctxA: TenantContext;
let ctxB: TenantContext;

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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  orgA = await registerOrganization(payload(SLUG_A, 'Num A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Num B'));

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  };
  ctxB = {
    organizationId: orgB.organizationId,
    branchIds: [orgB.branchId],
    userId: orgB.ownerUserId,
  };
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

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

describe('issuing a number', () => {
  it('starts at 1 and formats with the prefix and padding', async () => {
    const issued = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'UHID', prefix: 'P', padding: 6 })
    );

    expect(issued.number).toBe(1);
    expect(issued.formatted).toBe('P000001');
  });

  it('increments on the next call', async () => {
    const issued = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'UHID', prefix: 'P', padding: 6 })
    );

    expect(issued.number).toBe(2);
    expect(issued.formatted).toBe('P000002');
  });

  it('keeps the presentation the counter was created with', async () => {
    // A later caller passing a different prefix must not restyle the series —
    // numbers already handed to patients cannot change shape retroactively.
    const issued = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'UHID', prefix: 'ZZZ', padding: 2 })
    );

    expect(issued.formatted).toBe('P000003');
  });

  it('keeps a separate counter per type', async () => {
    const mrn = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'MRN', branchId: orgA.branchId, prefix: 'MAIN' })
    );

    // UHID is already at 3; MRN is its own series and starts over.
    expect(mrn.number).toBe(1);
  });

  it('keeps a separate counter per period', async () => {
    const spec = { type: 'APPOINTMENT' as const, branchId: orgA.branchId, prefix: 'A' };

    const first = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { ...spec, periodKey: '2026-27' })
    );
    const nextYear = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { ...spec, periodKey: '2027-28' })
    );

    expect(first.number).toBe(1);
    expect(nextYear.number).toBe(1);
  });
});

describe('the tenant and branch boundary', () => {
  it("does not continue another clinic's series", async () => {
    // Org A's UHID counter is well past 1 by now.
    const issued = await withTenant(ctxB, (tx) =>
      issueNumber(tx, ctxB, { type: 'UHID', prefix: 'P', padding: 6 })
    );

    expect(issued.number).toBe(1);
  });

  it('keeps MRN counters separate per branch', async () => {
    const second = await owner.query<{ id: string }>(
      `INSERT INTO branches (id, organization_id, code, name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'SECOND', 'Second', now(), now())
       RETURNING id`,
      [orgA.organizationId]
    );
    const secondBranchId = second.rows[0]?.id as string;

    const ctx = { ...ctxA, branchIds: [orgA.branchId, secondBranchId] };
    const issued = await withTenant(ctx, (tx) =>
      issueNumber(tx, ctx, { type: 'MRN', branchId: secondBranchId, prefix: 'SECOND' })
    );

    // The MAIN branch is already at 1; a different branch is a different series.
    expect(issued.number).toBe(1);
    expect(issued.formatted).toBe('SECOND000001');
  });
});

describe('concurrency', () => {
  /*
   * The load-bearing case. Fifty transactions race for the same counter; the
   * set of numbers they receive must be exactly 1..50 — no value twice (two
   * patients sharing a hospital number) and none missing (a gap an auditor
   * asks about).
   */
  it('hands out no duplicates and leaves no gaps under parallel load', async () => {
    const ROUNDS = 50;

    const issued = await Promise.all(
      Array.from({ length: ROUNDS }, () =>
        withTenant(ctxA, (tx) =>
          issueNumber(tx, ctxA, { type: 'QUEUE_TOKEN', branchId: orgA.branchId, periodKey: 'race' })
        )
      )
    );

    const numbers = issued.map((i) => i.number).sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(ROUNDS);
    expect(numbers).toEqual(Array.from({ length: ROUNDS }, (_, i) => i + 1));
  }, 30_000);

  /*
   * The property a Postgres SEQUENCE would not give us, and the stated reason
   * this table exists rather than `nextval`. A booking that fails must not burn
   * the number it had claimed.
   */
  it('rolls the number back when its transaction fails', async () => {
    const before = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'APPOINTMENT', branchId: orgA.branchId, periodKey: 'rollback' })
    );

    await expect(
      withTenant(ctxA, async (tx) => {
        await issueNumber(tx, ctxA, {
          type: 'APPOINTMENT',
          branchId: orgA.branchId,
          periodKey: 'rollback',
        });
        throw new Error('the booking failed after taking a number');
      })
    ).rejects.toThrow('the booking failed after taking a number');

    const after = await withTenant(ctxA, (tx) =>
      issueNumber(tx, ctxA, { type: 'APPOINTMENT', branchId: orgA.branchId, periodKey: 'rollback' })
    );

    // The burnt number was returned to the series, not skipped.
    expect(after.number).toBe(before.number + 1);
  });
});

describe('financialYearOf', () => {
  // April to March. The boundary is the whole point — an appointment on 31
  // March and one on 1 April belong to different series.
  it.each([
    ['2026-04-01', '2026-27'],
    ['2026-12-31', '2026-27'],
    ['2027-03-31', '2026-27'],
    ['2027-04-01', '2027-28'],
    ['2026-01-15', '2025-26'],
  ])('files %s under FY %s', (date, expected) => {
    expect(financialYearOf(new Date(`${date}T00:00:00Z`))).toBe(expected);
  });
});
