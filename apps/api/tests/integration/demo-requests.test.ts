/**
 * The public demo form.
 *
 * Noted in .kb/STATUS.md as verified by hand but untested. The behaviour worth
 * pinning is the part that is deliberately counter-intuitive: spam, duplicates
 * and genuine submissions all get the SAME response, because telling them apart
 * would turn this into a way to ask whether a given clinic is talking to rcln.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `d${Date.now().toString(36)}`;
const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

const emails: string[] = [];

function submission(overrides: Record<string, unknown> = {}) {
  const email = `demo-${SUFFIX}-${emails.length}@example.test`;
  emails.push(email);

  return {
    clinicName: 'Test Clinic',
    contactName: 'A Person',
    email,
    phone: '+919876500321',
    city: 'Pune',
    // Above MIN_FILL_MS, so the timing check treats it as a human.
    elapsedMs: 9_000,
    ...overrides,
  };
}

async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

const post = async (body: Record<string, unknown>) => {
  await clearRateLimits();
  return request(app).post('/api/v1/public/demo-requests').set('Host', ROOT).send(body);
};

const countFor = async (email: string): Promise<number> => {
  const { rows } = await owner.query<{ count: string }>(
    'SELECT count(*) AS count FROM demo_requests WHERE email = $1',
    [email]
  );
  return Number(rows[0]?.count);
};

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();
});

afterAll(async () => {
  if (emails.length > 0) {
    await owner?.query('DELETE FROM demo_requests WHERE email = ANY($1)', [emails]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('POST /public/demo-requests', () => {
  it('stores a genuine submission', async () => {
    const body = submission();
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(res.body.data.received).toBe(true);
    expect(await countFor(body.email as string)).toBe(1);
  });

  it('accepts a duplicate without storing it twice', async () => {
    const body = submission();
    await post(body);
    const second = await post(body);

    // Same 201. "We already have you" would confirm the first submission.
    expect(second.status).toBe(201);
    expect(await countFor(body.email as string)).toBe(1);
  });

  it('silently discards a honeypot hit', async () => {
    const body = submission({ website: 'http://spam.example' });
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(res.body.data.received).toBe(true);
    expect(await countFor(body.email as string)).toBe(0);
  });

  it('silently discards a form filled faster than a person could', async () => {
    const body = submission({ elapsedMs: 200 });
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await countFor(body.email as string)).toBe(0);
  });

  it('is indistinguishable across all three outcomes', async () => {
    const genuine = await post(submission());
    const spam = await post(submission({ website: 'http://spam.example' }));
    const fast = await post(submission({ elapsedMs: 100 }));

    for (const res of [spam, fast]) {
      expect(res.status).toBe(genuine.status);
      expect(res.body).toEqual(genuine.body);
    }
  });

  it('rejects a malformed submission', async () => {
    const res = await post(submission({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('lands outside RLS by design, and is unreadable without a policy', async () => {
    // demo_requests has no organization_id and no policy — the exemption is
    // recorded in enable-rls.sql and check-rls.ts. Access is gated in the
    // application layer: write-only in public, reads for platform admins.
    const { rows } = await owner.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'demo_requests'`
    );
    expect(rows[0]?.relrowsecurity).toBe(false);
  });
});
