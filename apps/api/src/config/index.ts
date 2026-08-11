import { isAbsolute, resolve as resolvePath } from 'node:path';

import { config as loadEnv } from 'dotenv';

/**
 * The monorepo root, derived from this file's own location.
 *
 * ⚠️ NEVER `process.cwd()`. Each app runs with its own working directory —
 *   the API server's is `apps/api`, the worker's is `apps/worker` — so a
 *   relative path means a different place in each process. That is already why
 *   `.env` is resolved this way, and it is why `STORAGE_LOCAL_PATH` is too.
 */
const repoRoot = new URL('../../../../', import.meta.url).pathname;

// One .env at the repo root. Each app runs with its own cwd, so the path is
// resolved explicitly rather than relying on process.cwd().
loadEnv({ path: `${repoRoot}.env` });

const getEnvVar = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

/**
 * An optional variable, where BLANK MEANS UNSET.
 *
 * `.env` files are written with the keys present and the values empty —
 * `CASHFREE_WEBHOOK_SECRET=` — so `process.env[key]` is `''`, not `undefined`,
 * and `?? fallback` never fires. That cost a live 401 on every webhook: an
 * empty signing secret read as "a secret is configured".
 */
const getOptionalEnvVar = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/** Absolute paths pass through; relative ones are anchored to the repo root. */
const resolveStoragePath = (value: string): string =>
  isAbsolute(value) ? value : resolvePath(repoRoot, value);

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

/**
 * A development escape hatch for the rate limiters, and a production footgun.
 *
 * Every budget in rateLimiter.middleware.ts is sized for one human working at
 * human speed. Clicking through the UI is not that: a screen refresh is a dozen
 * requests, and an afternoon of hot-reloading exhausts a 100-per-15-minutes
 * budget several times over. `RATE_LIMIT_RELAXED=true` multiplies EVERY budget
 * — including the ones written as literals, like registration and OTP — by
 * `RATE_LIMIT_RELAXED_FACTOR`, so the shape of the protection is unchanged and
 * only its scale moves.
 *
 * Fatal in production for the same reason as DEV_MASTER_VERIFICATION_CODE: a
 * variable that quietly removes brute-force protection must not be able to
 * survive a copied .env into a real deployment.
 */
if (isProduction && process.env['RATE_LIMIT_RELAXED']?.trim() === 'true') {
  throw new Error(
    'RATE_LIMIT_RELAXED is set in production. It multiplies every rate-limit ' +
      'budget for local UI development; remove it from the environment.'
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

  /**
   * Outbound email.
   *
   * `console` logs the message and delivers nothing — the historical default,
   * and still the right one for the test suite and for a native run with no
   * Docker. `smtp` hands the message to a relay.
   *
   * IN DEVELOPMENT THE RELAY IS MAILPIT, AND THAT IS THE POINT
   *   Mailpit accepts everything on `mailpit:1025` and delivers nothing to the
   *   outside world; every invitation link and verification code shows up at
   *   http://localhost:8025. Compose sets `EMAIL_PROVIDER=smtp` for exactly
   *   this reason, so an invitation is a link you can click rather than a line
   *   in the API log.
   *
   *   Same code path as a real provider. SES, Postmark and Resend all speak
   *   SMTP, so moving off Mailpit is host, port and credentials — not a rewrite.
   */
  email: {
    /**
     * Forced to `console` under NODE_ENV=test, and not read from the
     * environment there.
     *
     * The integration suites replace `sendEmail` to capture the invitation
     * token, but not every suite does — and compose exports
     * `EMAIL_PROVIDER=smtp` into the very container the tests run in. A suite
     * that reaches a real socket is a suite whose result depends on whether
     * Mailpit happened to be up.
     */
    provider: (env === 'test'
      ? 'console'
      : getEnvVar('EMAIL_PROVIDER', 'console') === 'smtp'
        ? 'smtp'
        : 'console') as 'console' | 'smtp',
    from: getEnvVar('EMAIL_FROM', 'rcln <noreply@rcln.local>'),
    smtp: {
      host: getEnvVar('SMTP_HOST', 'localhost'),
      port: getEnvNumber('SMTP_PORT', 1025),
      /** Implicit TLS (465). Mailpit speaks plaintext; a real relay on 587 upgrades via STARTTLS. */
      secure: getEnvVar('SMTP_SECURE', 'false') === 'true',
      /** Unset for Mailpit, which authenticates nobody. Blank means unset — see above. */
      user: getOptionalEnvVar('SMTP_USER'),
      password: getOptionalEnvVar('SMTP_PASSWORD'),
    },
  },

  /**
   * Document storage.
   *
   * WHICH PROVIDER IS A DEPLOYMENT DECISION, EXACTLY LIKE THE ACQUIRER
   *   `STORAGE_PROVIDER` selects an implementation in `@rcln/storage`. Nothing
   *   outside that package names one, and `DocumentService` does not know which
   *   it is holding — so moving a deployment to S3 is this variable plus its
   *   credentials. No migration, no contract change, no screen. §24, §29.
   *
   * ⚠️ `STORAGE_LOCAL_PATH` IS THE SINGLE SOURCE OF TRUTH FOR WHERE DOCUMENTS
   *   LIVE, AND COMPOSE USES THE SAME VALUE ON BOTH SIDES OF A BIND MOUNT.
   *   The host folder and the in-container path are identical, and the API and
   *   the worker mount it the same way — so this variable alone moves the
   *   documents, and a queued PDF generation cannot land somewhere the API
   *   cannot read.
   *
   *   Two ways to get it wrong, and NEITHER RAISES AN ERROR:
   *     - a path Docker Desktop does not share (/var/lib, /opt, /srv). Docker
   *       creates it inside its own VM instead, the write succeeds, and the
   *       files never appear on the host. Anywhere under $HOME is shared.
   *     - a path that only exists inside the container, which loses every PDF
   *       on the next `--build` while the `files` rows survive — an invoice
   *       that insists it has a document that 404s.
   *
   * AWS CREDENTIALS ARE DELIBERATELY ABSENT FROM THIS BLOCK
   *   The S3 provider will take them from the standard AWS credential chain —
   *   environment, shared config, or (in production) the instance's IAM role.
   *   Reading them into `config` would put a long-lived secret in a frozen
   *   object that gets logged whenever somebody debugs configuration, and would
   *   make an IAM role harder to use than a static key. §29, §50.
   */
  storage: {
    provider: (getEnvVar('STORAGE_PROVIDER', 'local') === 's3' ? 's3' : 'local') as 'local' | 's3',
    local: {
      /**
       * Always absolute by the time anything reads it. Under compose it is set
       * from `.env` and defaults to `${HOME}/rcln/documents`.
       *
       * ⚠️ A RELATIVE PATH IS RESOLVED AGAINST THE REPO ROOT, NOT `cwd`.
       *   Compose requires an absolute path (a relative one cannot be a mount
       *   point), so this only bites a native run — but the rule has to hold
       *   there too: the API server runs from `apps/api` and the worker from
       *   `apps/worker`, so the obvious `resolve('./storage/documents')` would
       *   silently give the two processes DIFFERENT storage roots, and a PDF
       *   written by the API would not exist as far as the worker was
       *   concerned. Pinned by `tests/unit/storage-path.test.ts`.
       */
      rootDir: resolveStoragePath(getEnvVar('STORAGE_LOCAL_PATH', './storage/documents')),
    },
    s3: {
      bucket: getOptionalEnvVar('S3_BUCKET') ?? '',
      region: getOptionalEnvVar('S3_REGION') ?? '',
      keyPrefix: getOptionalEnvVar('S3_KEY_PREFIX'),
    },
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
    /**
     * Development only — see the RATE_LIMIT_RELAXED guard above. Applied as a
     * multiplier by `budget()` in rateLimiter.middleware.ts, so it reaches the
     * hard-coded budgets too. 1 means "the limits as written".
     */
    relaxedFactor:
      getEnvVar('RATE_LIMIT_RELAXED', 'false').trim() === 'true' && !isProduction
        ? getEnvNumber('RATE_LIMIT_RELAXED_FACTOR', 100)
        : 1,
  },

  log: {
    level: getEnvVar('LOG_LEVEL', 'info'),
  },

  /**
   * Payments.
   *
   * WHICH ACQUIRER IS A DEPLOYMENT DECISION, NOT A CODE ONE
   *   `PAYMENT_PROVIDER` selects an adapter in `@rcln/payments`. Nothing outside
   *   that package names one, so switching is this variable plus its credentials
   *   — no migration, no contract change, no screen.
   *
   * `mock` IS THE DEVELOPMENT DEFAULT, AND IT IS REAL
   *   It signs its webhooks with the same HMAC scheme, redirects to a sandbox
   *   page an operator has to interact with, and can be told to decline or to
   *   deliver an event twice. The whole subscription lifecycle runs end to end
   *   without a gateway account. It is refused in production below.
   */
  payments: {
    provider: getEnvVar('PAYMENT_PROVIDER', isProduction ? 'cashfree' : 'mock'),

    /**
     * Where providers POST outcomes.
     *
     * Must be publicly reachable, which `localhost` is not — use a tunnel in
     * development, or stay on the mock provider, whose "webhook" is generated
     * in-process by the sandbox route and never leaves the network.
     */
    webhookBaseUrl: getEnvVar(
      'PAYMENTS_WEBHOOK_BASE_URL',
      getEnvVar('API_URL', 'http://localhost:5000')
    ),

    cashfree: {
      appId: getOptionalEnvVar('CASHFREE_APP_ID') ?? '',
      secretKey: getOptionalEnvVar('CASHFREE_SECRET_KEY') ?? '',
      /**
       * Cashfree signs with the API secret unless a separate one is configured.
       * Blank means unset — see `getOptionalEnvVar`; a `''` here silently
       * became the signing key and refused every delivery.
       */
      webhookSecret: getOptionalEnvVar('CASHFREE_WEBHOOK_SECRET'),
      environment: (getEnvVar('CASHFREE_ENVIRONMENT', isProduction ? 'production' : 'sandbox') ===
      'production'
        ? 'production'
        : 'sandbox') as 'sandbox' | 'production',
    },

    /**
     * Whether a customer-present checkout redirects to the provider or mounts
     * its widget on our own page.
     *
     * A DEPLOYMENT DECISION, NOT A CUSTOMER'S — there is no request field for
     * it, deliberately. `embedded` degrades to `redirect` on a provider that
     * declares no widget (`presentationFor` in @rcln/billing), so this and
     * `PAYMENT_PROVIDER` can be changed independently without either becoming a
     * broken checkout.
     */
    checkoutPresentation: (getEnvVar('PAYMENTS_CHECKOUT_PRESENTATION', 'embedded') === 'redirect'
      ? 'redirect'
      : 'embedded') as 'redirect' | 'embedded',

    razorpay: {
      keyId: getOptionalEnvVar('RAZORPAY_KEY_ID') ?? '',
      keySecret: getOptionalEnvVar('RAZORPAY_KEY_SECRET') ?? '',
      /**
       * ⚠️ NOT the API secret, and there is no fallback.
       *
       * Razorpay's signing secret is whatever the merchant typed into the
       * dashboard when creating the webhook. The adapter refuses to construct
       * without it, so a blank here fails the boot rather than 401-ing every
       * delivery — which is the whole point of `getOptionalEnvVar`.
       */
      webhookSecret: getOptionalEnvVar('RAZORPAY_WEBHOOK_SECRET') ?? '',
      /**
       * Declared, and checked against the key's `rzp_test_` / `rzp_live_`
       * prefix at construction. Razorpay serves test and live from the SAME
       * URL, so this variable is the only thing that can catch a live key in a
       * staging deployment before it charges a real card.
       */
      environment: (getEnvVar('RAZORPAY_ENVIRONMENT', isProduction ? 'production' : 'sandbox') ===
      'production'
        ? 'production'
        : 'sandbox') as 'sandbox' | 'production',
      /** Which recurring rail a mandate is taken on. See `RazorpayConfig`. */
      mandateMethod: (getEnvVar('RAZORPAY_MANDATE_METHOD', 'upi') === 'emandate'
        ? 'emandate'
        : getEnvVar('RAZORPAY_MANDATE_METHOD', 'upi') === 'card'
          ? 'card'
          : 'upi') as 'upi' | 'emandate' | 'card',
      /**
       * What the authorisation transaction itself charges, in paise. Zero is a
       * real zero-amount authorisation and is what UPI Autopay uses; some card
       * issuers need ₹1 (`100`), which Razorpay refunds automatically.
       */
      mandateAuthAmountMinor: getEnvNumber('RAZORPAY_MANDATE_AUTH_AMOUNT_MINOR', 0),
    },

    mock: {
      /**
       * Signs the mock's webhooks. Not protecting money — it is protecting the
       * shape of the code path, so that a signature failure in development means
       * the same thing it means in production.
       */
      webhookSecret: getEnvVar('MOCK_PAYMENTS_SECRET', 'mock-payments-development-secret'),
    },
  },
} as const;

/**
 * The mock provider must never bill anybody.
 *
 * Fatal rather than ignored, for the same reason as the master verification
 * code above: a production deployment quietly running the mock would report
 * every subscription as paid and take nothing, and the first symptom would be a
 * revenue report that looks fine.
 */
/**
 * Mailpit must never be a production relay.
 *
 * It accepts every message and delivers none, so a production deployment
 * pointed at it would report every invitation as sent and nobody would ever
 * receive one. Fatal rather than ignored, for the same reason as the mock
 * payment provider below.
 */
if (
  isProduction &&
  config.email.provider === 'smtp' &&
  /^mailpit$|^localhost$|^127\./.test(config.email.smtp.host)
) {
  throw new Error(
    `SMTP_HOST is '${config.email.smtp.host}' in production. That is the local Mailpit catcher ` +
      '(or an unset default); it accepts mail and delivers nothing.'
  );
}

/**
 * S3 selected without a bucket is a boot failure, not a fallback.
 *
 * Falling back to local disk here would be the storage equivalent of running
 * the mock payment provider in production: every invoice PDF written to
 * container scratch space, every `files` row claiming it is in S3, and the
 * first symptom a download that 404s weeks later. Fatal now, loudly.
 *
 * ⚠️ Local storage in production is NOT fatal, deliberately. A single-VM
 *   deployment with a persistent disk is a legitimate way to run this, and
 *   refusing it would force S3 on a one-clinic install that does not need it.
 *   Whether the disk survives a deploy is an operator's problem, and one they
 *   can actually see — unlike a silent fallback.
 */
if (config.storage.provider === 's3' && (!config.storage.s3.bucket || !config.storage.s3.region)) {
  throw new Error(
    'STORAGE_PROVIDER=s3 but S3_BUCKET or S3_REGION is unset. Documents would have nowhere to go.'
  );
}

if (isProduction && config.payments.provider === 'mock') {
  throw new Error(
    'PAYMENT_PROVIDER=mock in production. The mock provider simulates payments and collects no money.'
  );
}

export type Config = typeof config;
