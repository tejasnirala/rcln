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
