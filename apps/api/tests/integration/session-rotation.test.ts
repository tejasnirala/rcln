/**
 * Refresh-token rotation, and what happens when a token is replayed.
 *
 * Rotation is the whole reason refresh tokens are stateful. The property that
 * matters is not "a new token is issued" — it is that presenting an ALREADY
 * ROTATED token revokes the entire family, because that can only happen if the
 * token leaked, and there is no way to tell the thief from the victim.
 *
 * Runs against real Postgres: `sessions` is where the state lives, and a mocked
 * client would prove nothing about it.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import {
  createSession,
  findLiveSession,
  revokeSession,
  rotateRefreshToken,
} from '../../src/services/auth/session.service.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  hashesMatch,
  generateOtpCode,
} from '../../src/services/auth/token.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const USER_ID = 'eeeeeeee-0000-0000-0000-0000000000e1';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  await owner.query(
    `INSERT INTO users (id, email, full_name, status, updated_at)
     VALUES ($1, 'rotation@example.test', 'Rotation User', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID]
  );
});

afterAll(async () => {
  await owner?.query('DELETE FROM sessions WHERE user_id = $1', [USER_ID]);
  await owner?.query('DELETE FROM users WHERE id = $1', [USER_ID]);
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

afterEach(async () => {
  await owner.query('DELETE FROM sessions WHERE user_id = $1', [USER_ID]);
});

function newSession() {
  return createSession({ userId: USER_ID, activeOrganizationId: null, activeBranchId: null });
}

describe('token primitives', () => {
  it('never stores the refresh token itself', async () => {
    const session = await newSession();

    const { rows } = await owner.query<{ refresh_token_hash: string }>(
      'SELECT refresh_token_hash FROM sessions WHERE id = $1',
      [session.id]
    );

    // A dump of this table must not be replayable.
    expect(rows[0]?.refresh_token_hash).not.toBe(session.refreshToken);
    expect(rows[0]?.refresh_token_hash).toBe(hashRefreshToken(session.refreshToken));
  });

  it('generates refresh tokens with enough entropy to be unguessable', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(500);
    // 32 random bytes, base64url — 43 characters, no padding.
    expect([...tokens][0]).toMatch(/^[\w-]{43}$/);
  });

  it('compares hashes without leaking their contents through timing', () => {
    const a = hashRefreshToken('one');
    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, hashRefreshToken('two'))).toBe(false);
    // Different lengths must be rejected rather than throwing out of timingSafeEqual.
    expect(hashesMatch(a, 'abcd')).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });

  it('generates OTP codes of the configured length, zero-padded', () => {
    const codes = Array.from({ length: 200 }, () => generateOtpCode());
    const length = Number(process.env['OTP_LENGTH'] ?? 6);
    for (const code of codes) {
      expect(code).toMatch(new RegExp(`^\\d{${length}}$`));
    }
    // Not a constant.
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe('rotation', () => {
  it('issues a new token and retires the old one', async () => {
    const first = await newSession();
    const second = await rotateRefreshToken(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.id).toBe(first.id); // same session, new credential

    const { rows } = await owner.query<{
      refresh_token_hash: string;
      previous_token_hash: string;
    }>('SELECT refresh_token_hash, previous_token_hash FROM sessions WHERE id = $1', [first.id]);

    expect(rows[0]?.refresh_token_hash).toBe(hashRefreshToken(second.refreshToken));
    expect(rows[0]?.previous_token_hash).toBe(hashRefreshToken(first.refreshToken));
  });

  it('lets the newest token keep working', async () => {
    const first = await newSession();
    const second = await rotateRefreshToken(first.refreshToken);
    const third = await rotateRefreshToken(second.refreshToken);

    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('rejects a token that was never issued', async () => {
    await expect(rotateRefreshToken(generateRefreshToken())).rejects.toThrow(/session expired/i);
  });

  it('rejects a revoked session', async () => {
    const session = await newSession();
    await revokeSession(session.id);

    await expect(rotateRefreshToken(session.refreshToken)).rejects.toThrow(/session expired/i);
  });

  it('rejects an expired session', async () => {
    const session = await newSession();
    await owner.query(`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      session.id,
    ]);

    await expect(rotateRefreshToken(session.refreshToken)).rejects.toThrow(/session expired/i);
  });
});

describe('reuse detection', () => {
  it('revokes the whole family when a rotated token is replayed', async () => {
    // Two live sessions for the same user — say a laptop and a phone.
    const laptop = await newSession();
    const phone = await newSession();

    const rotated = await rotateRefreshToken(laptop.refreshToken);

    // The attacker replays the token they captured before the rotation.
    await expect(rotateRefreshToken(laptop.refreshToken)).rejects.toThrow(/session expired/i);

    // Everything the user had is now dead: we cannot tell which party was the
    // thief, so both are made to re-authenticate.
    expect(await findLiveSession(laptop.id)).toBeNull();
    expect(await findLiveSession(phone.id)).toBeNull();

    // Including the token that was legitimately issued a moment ago.
    await expect(rotateRefreshToken(rotated.refreshToken)).rejects.toThrow(/session expired/i);
  });

  it('does not treat an ordinary rotation as theft', async () => {
    const session = await newSession();
    await rotateRefreshToken(session.refreshToken);

    // One rotation, no replay — the session must survive.
    expect(await findLiveSession(session.id)).not.toBeNull();
  });
});
