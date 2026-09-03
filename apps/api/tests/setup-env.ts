import { toTestDatabaseUrl } from '../../../packages/db/scripts/test-database.js';

/**
 * Runs before any module — and therefore before `config` reads the environment.
 *
 * `RATE_LIMIT_RELAXED` is a local-development convenience that multiplies every
 * rate-limit budget (see config/index.ts). The rate-limit regression cases in
 * auth.test.ts count requests against those budgets exactly, so a developer who
 * left the flag on in `.env` would otherwise watch the suite fail — or, worse,
 * watch it spend a hundred argon2 verifications trying to exhaust a relaxed
 * login budget. dotenv does not overwrite an existing variable, so setting it
 * here wins over the file.
 */
process.env['RATE_LIMIT_RELAXED'] = 'false';

/**
 * And the WINDOW, for the half of the same argument the flag above does not
 * cover.
 *
 * ⚠️ `.env.example` TELLS DEVELOPERS TO SET `RATE_LIMIT_WINDOW_MS=10000` so that
 *   clicking through the UI stops earning 429s, and the suite reads that same
 *   `.env`. That is not survivable here. The first case in auth.test.ts's
 *   rate-limit block fires TWELVE logins expecting the eleventh to be refused,
 *   and every one of them is a real argon2 verification: the loop takes longer
 *   than ten seconds on an unhurried machine, the bucket resets halfway through,
 *   and the assertion fails with a 200 that looks like a broken limiter rather
 *   than an expired window.
 *
 *   Fifteen minutes is the default the budgets in rateLimiter.middleware.ts are
 *   written against, which is what those cases are asserting. Pinned rather than
 *   defaulted for the reason above: a developer's `.env` really is setting it.
 */
process.env['RATE_LIMIT_WINDOW_MS'] = String(15 * 60 * 1000);

/**
 * ⚠️ THE SUITES RUN AGAINST `rcl_testing`, NOT AGAINST THE DEVELOPMENT DATABASE.
 *
 *   102 suites register organizations, admit patients, dispense stock and issue
 *   invoices. Pointed at `rcln` — which is what the browser is reading while you
 *   work — every run buried the handful of records a human actually created
 *   under a few hundred fixtures, and no amount of cleanup in `afterAll` gets
 *   that back: a suite that fails halfway leaves its rows behind by definition.
 *
 *   The rewrite happens HERE, in `setupFiles`, because it must land before any
 *   module is evaluated: `config/index.ts` snapshots `process.env` into a frozen
 *   object the moment it loads, and 60 suites read `DIRECT_DATABASE_URL` at
 *   module scope to open their own owner connection. `setupFilesAfterEnv` is
 *   already too late for both.
 *
 *   Both URLs move together. Leaving the owner URL on `rcln` would be worse than
 *   not splitting at all — the fixtures would be written to one database as the
 *   owner and read from another as the app, and every suite would fail on an
 *   empty result rather than on anything true.
 *
 *   Create the database with `pnpm db:test:setup`; `docker compose up` does it
 *   for you. See packages/db/scripts/test-database.ts.
 */
const appUrl = process.env['DATABASE_URL'];
if (appUrl) process.env['DATABASE_URL'] = toTestDatabaseUrl(appUrl);

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
if (ownerUrl) process.env['DIRECT_DATABASE_URL'] = toTestDatabaseUrl(ownerUrl);

/**
 * Redis is split the same way — logical database 2, which is neither the cache
 * (0) nor the queue (1).
 *
 * Not decoration: 20 suites run `redis.keys('rl:*')` and delete what comes back,
 * so that one suite's requests do not count against another's rate-limit budget.
 * On the shared database that DELETE also lands on the dev server's live limiter
 * state, its tenant cache and its permission cache — the tests were quietly
 * flushing the application you had open in the browser.
 *
 * ⚠️ IT IS `REDIS_CACHE_DB`, NOT A PATH ON `REDIS_URL`. `utils/redis.ts` passes
 *   `db: config.redis.cacheDb` explicitly, and an ioredis option beats the URL —
 *   rewriting the URL here would have changed nothing and looked like it had.
 *
 * ⚠️ THE QUEUE IS NOT SPLIT, AND STILL SHARES DATABASE 1 WITH DEVELOPMENT.
 *   `createJobProducer` takes the bare URL and does not read `REDIS_QUEUE_DB`,
 *   so a suite that issues an invoice still enqueues a PDF job the running dev
 *   worker will pick up. That was true before this split and is unchanged by it;
 *   fixing it means teaching the producer about the queue database.
 */
process.env['REDIS_CACHE_DB'] = '2';
