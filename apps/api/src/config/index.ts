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
