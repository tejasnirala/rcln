import { config as loadEnv } from 'dotenv';

// One .env at the repo root. Each app runs with its own cwd, so the path is
// resolved explicitly rather than relying on process.cwd().
loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const getEnvVar = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getEnvNumber = (key: string, defaultValue: number): number => {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number`);
  return parsed;
};

const env = getEnvVar('NODE_ENV', 'development');
const isProduction = env === 'production';

const jwtSecret = getEnvVar('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
if (isProduction && jwtSecret.includes('change-me')) {
  throw new Error('JWT_SECRET is still the placeholder value — generate one before deploying');
}

/**
 * A master verification code must never reach production, so its presence there
 * is fatal rather than ignored. Ignoring it would leave a variable named
 * DEV_MASTER_VERIFICATION_CODE sitting in a production environment looking like
 * it does something — and the next person to read `config` would have to prove
 * that it does not.
 */
if (isProduction && process.env['DEV_MASTER_VERIFICATION_CODE']) {
  throw new Error(
    'DEV_MASTER_VERIFICATION_CODE is set in production. It is a development-only ' +
      'backdoor for email and phone verification; remove it from the environment.'
  );
}

const databaseUrl = getEnvVar('DATABASE_URL');
if (isProduction && /rcln_owner|\/\/postgres:/.test(databaseUrl)) {
  // Cheap string check; assertRlsActive() does the authoritative check at boot.
  throw new Error(
    'DATABASE_URL appears to point at an owner/superuser role. RLS would be bypassed.'
  );
}

export const config = {
  env,
  port: getEnvNumber('PORT', 5000),
  host: getEnvVar('HOST', '0.0.0.0'),
  isProduction,
  isDevelopment: env === 'development',
  isTest: env === 'test',

  // Tenancy
  rootDomain: getEnvVar('ROOT_DOMAIN', 'lvh.me'),
  webUrl: getEnvVar('WEB_URL', 'http://lvh.me:3000'),

  // Database — the app role, never the owner.
  databaseUrl,
  databasePoolSize: getEnvNumber('DATABASE_POOL_SIZE', 10),

  redis: {
    url: getEnvVar('REDIS_URL', 'redis://localhost:6379'),
    cacheDb: getEnvNumber('REDIS_CACHE_DB', 0),
    queueDb: getEnvNumber('REDIS_QUEUE_DB', 1),
  },

  jwt: {
    secret: jwtSecret,
    accessTokenExpiresIn: getEnvVar('JWT_ACCESS_TOKEN_EXPIRES_IN', '15m'),
    refreshTokenExpiresIn: getEnvVar('JWT_REFRESH_TOKEN_EXPIRES_IN', '30d'),
  },

  otp: {
    length: getEnvNumber('OTP_LENGTH', 6),
    ttlSeconds: getEnvNumber('OTP_TTL_SECONDS', 300),
    maxAttempts: getEnvNumber('OTP_MAX_ATTEMPTS', 5),
  },

  verification: {
    /**
     * Longer than a login OTP on purpose. That one goes to a handset already in
     * the user's hand; this one has to survive a mail queue, a spam filter and
     * somebody finishing with a patient before they read it. The attempt cap
     * and the code length are shared with `otp` — same generator, same table.
     */
    ttlSeconds: getEnvNumber('VERIFICATION_TTL_SECONDS', 900),

    /**
     * A code that always confirms an email address or a phone number.
     *
     * ⚠️ THIS IS A BACKDOOR, AND IT IS NULL IN PRODUCTION BY CONSTRUCTION.
     *   Neither channel can actually deliver a message yet — SES is unverified
     *   and TRAI DLT registration is pending (.kb/STATUS.md) — so the only way
     *   to reach a verified account outside the API log is a code that is known
     *   in advance. That is a development affordance and nothing else.
     *
     *   It is not read from the environment in production, so no deployment can
     *   turn it on by setting a variable. Setting one anyway aborts the boot
     *   (see the assertion below) rather than being silently ignored, because a
     *   variable named this appearing in a production environment is a mistake
     *   somebody needs told about.
     *
     * IT DOES NOT UNLOCK LOGIN. `verifyOtp` never consults it — verifying an
     * address you already control is a different thing from proving who you are,
     * and only the first one is stubbed here. See verification.service.ts.
     */
    masterCode: isProduction ? null : getEnvVar('DEV_MASTER_VERIFICATION_CODE', '123456'),
  },

  cors: {
    // Static allowlist for local dev and the marketing site. Tenant subdomains
    // are validated dynamically against organization_domains.
    origins: getEnvVar('CORS_ORIGINS', 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: getEnvNumber('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    maxRequests: getEnvNumber('RATE_LIMIT_MAX_REQUESTS', 100),
    authMaxRequests: getEnvNumber('RATE_LIMIT_AUTH_MAX_REQUESTS', 10),
  },

  log: {
    level: getEnvVar('LOG_LEVEL', 'info'),
  },
} as const;

export type Config = typeof config;
