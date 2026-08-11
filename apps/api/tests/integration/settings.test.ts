/**
 * Organization profile and settings over real HTTP.
 *
 * WHY THIS SUITE IS DIFFERENT FROM THE OTHERS
 *   Every other tenant-scoped suite is testing code that sits ON TOP of an RLS
 *   policy — get the `where` wrong and Postgres still refuses. Both tables here
 *   are on the EXEMPT list in `packages/db/scripts/check-rls.ts`:
 *
 *     organizations   the table the tenant is resolved FROM; scoping it by the
 *                     tenant would be circular
 *     setting_values  keyed by (scope_type, scope_id), so there is no
 *                     organization_id column for a policy to filter on
 *
 *   So the isolation is entirely application code, and a missing filter fails
 *   the way missing filters always fail: silently, with every single-tenant test
 *   still green. The two-organization cases below are not belt and braces —
 *   they are the only thing standing between one clinic and another clinic's
 *   configuration. `db:rls:check` will never notice.
 *
 * The other two things being pinned down:
 *
 *   1. `resolveTenant` caches `{ organizationId, slug, status, currency,
 *      timezone }` per host for 300 seconds, and two of those five are editable
 *      here. An update that does not drop that cache is correct in Postgres and
 *      wrong for five minutes.
 *   2. `audit_logs.entity_id` is a `uuid` column. A setting key is not a uuid,
 *      and writing one there is a 500 that typechecks perfectly — this suite
 *      pins the row id, and pins that the key survives on the snapshot.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { sender } from '../../src/services/notification/sender.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `s${Date.now().toString(36)}`;
const SLUG_A = `set-a-${SUFFIX}`;
const SLUG_B = `set-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/** Test-only definitions, so the "you may not set this" paths have something to
 *  refuse. All twelve seeded settings are organization-editable, by design. */
const BRANCH_ONLY_KEY = `test.branch_only_${SUFFIX}`;
const PLATFORM_LOCKED_KEY = `test.platform_locked_${SUFFIX}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };

const sent: { to: string; link: string }[] = [];

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

async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

const asUser = (slug: string, token: () => string) => ({
  get: (path: string) =>
    request(app).get(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token()}`),
  post: (path: string, body: object = {}) =>
    request(app)
      .post(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
  patch: (path: string, body: object = {}) =>
    request(app)
      .patch(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
  put: (path: string, body: object = {}) =>
    request(app)
      .put(path)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token()}`)
      .send(body),
  delete: (path: string) =>
    request(app).delete(path).set('Host', hostFor(slug)).set('Authorization', `Bearer ${token()}`),
});

async function login(slug: string, identifier: string, secret: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier, password: secret });
  if (!res.body.data?.accessToken) {
    throw new Error(`could not sign ${identifier} in: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

let ownerToken = '';
let bToken = '';
let readerToken = '';

const A = asUser(SLUG_A, () => ownerToken);
const B = asUser(SLUG_B, () => bToken);
/** Holds both read permissions and neither write one. */
const Reader = asUser(SLUG_A, () => readerToken);

const READER_EMAIL = `reader-${SUFFIX}@example.test`;

/** Invite, accept, sign in — the way a real member comes into existence. */
async function joinAs(email: string, fullName: string, roleId: string): Promise<string> {
  await clearRateLimits();
  const invited = await A.post('/api/v1/invitations', { email, roleId, branchIds: [] });
  if (invited.status !== 201) {
    throw new Error(`could not invite ${email}: ${JSON.stringify(invited.body)}`);
  }

  const link = [...sent].reverse().find((mail) => mail.to === email)?.link;
  if (!link) throw new Error(`no invitation email reached ${email}`);
  const token = new URL(link).searchParams.get('token');

  await clearRateLimits();
  const accepted = await request(app)
    .post('/api/v1/auth/invitations/accept')
    .set('Host', hostFor(SLUG_A))
    .send({ token, fullName, password: MEMBER_PASSWORD });
  if (accepted.status !== 201) {
    throw new Error(`could not accept for ${email}: ${JSON.stringify(accepted.body)}`);
  }

  return login(SLUG_A, email, MEMBER_PASSWORD);
}

interface Setting {
  key: string;
  value: unknown;
  isOverridden: boolean;
  inheritedValue: unknown;
  inheritedFrom: string;
  editable: boolean;
  updatedAt: string | null;
  helpText: string | null;
  choices: { value: unknown; label: string }[] | null;
}

async function settingsOf(who: typeof A): Promise<Map<string, Setting>> {
  const res = await who.get('/api/v1/organization/settings');
  if (res.status !== 200) throw new Error(`settings unreadable: ${JSON.stringify(res.body)}`);
  return new Map((res.body.data.settings as Setting[]).map((s) => [s.key, s]));
}

const SLOT = 'appointment.slot_minutes';

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  sender.sendEmail = (to, _template, vars) => {
    sent.push({ to, link: vars['link'] ?? '' });
    return Promise.resolve();
  };

  // Two definitions the seed does not carry, because every seeded one is
  // organization-editable and the refusals need something to refuse.
  await owner.query(
    `INSERT INTO setting_definitions (key, module, data_type, default_value, allowed_scopes, is_tenant_editable, description)
     VALUES ($1, 'test', 'INT', '5'::jsonb, '["BRANCH"]'::jsonb, true,  'Branch scope only'),
            ($2, 'test', 'BOOL', 'false'::jsonb, '["ORGANIZATION"]'::jsonb, false, 'Managed by the platform')`,
    [BRANCH_ONLY_KEY, PLATFORM_LOCKED_KEY]
  );

  orgA = await registerOrganization(payload(SLUG_A, 'Set A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Set B'));

  ownerToken = await login(SLUG_A, `${SLUG_A}@example.test`, PASSWORD);
  bToken = await login(SLUG_B, `${SLUG_B}@example.test`, PASSWORD);

  /**
   * A role that may look and not touch.
   *
   * No system role is shaped like this — ORG_ADMIN holds all four permissions
   * and BRANCH_ADMIN holds none of them — and the read/write split is the
   * reason there are four codes rather than two.
   */
  const created = await A.post('/api/v1/roles', {
    code: 'SETTINGS_READER',
    name: 'Settings reader',
    scopeLevel: 'ORGANIZATION',
    permissionCodes: ['organization.read', 'settings.organization.read'],
  });
  if (created.status !== 201) {
    throw new Error(`could not create the reader role: ${JSON.stringify(created.body)}`);
  }

  readerToken = await joinAs(READER_EMAIL, 'Reader Person', created.body.data.id as string);
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (ids.length > 0) {
    await owner?.query(
      "DELETE FROM setting_values WHERE scope_type = 'ORGANIZATION' AND scope_id = ANY($1)",
      [ids]
    );
  }
  await owner?.query('DELETE FROM setting_definitions WHERE key = ANY($1)', [
    [BRANCH_ONLY_KEY, PLATFORM_LOCKED_KEY],
  ]);

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
  await owner?.query('DELETE FROM users WHERE email = $1', [READER_EMAIL]);

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('the organization profile', () => {
  it('answers with the clinic the Host header named', async () => {
    const res = await A.get('/api/v1/organization');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: orgA.organizationId,
      slug: SLUG_A,
      legalName: 'Set A Pvt Ltd',
      currency: 'INR',
      status: 'ACTIVE',
    });
  });

  it('gives each clinic its own record, never the other’s', async () => {
    const a = await A.get('/api/v1/organization');
    const b = await B.get('/api/v1/organization');
    expect(a.body.data.id).toBe(orgA.organizationId);
    expect(b.body.data.id).toBe(orgB.organizationId);
  });

  it('updates the fields a clinic owns', async () => {
    const res = await A.patch('/api/v1/organization', {
      legalName: 'Set A Healthcare Pvt Ltd',
      displayName: 'Set A Healthcare',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      legalName: 'Set A Healthcare Pvt Ltd',
      displayName: 'Set A Healthcare',
    });
  });

  it('leaves the OTHER clinic untouched — nothing in Postgres would stop it', async () => {
    // organizations is RLS-exempt. If updateOrganization ever addressed anything
    // but ctx.organizationId, this is the assertion that notices.
    const b = await B.get('/api/v1/organization');
    expect(b.body.data.legalName).toBe('Set B Pvt Ltd');
    expect(b.body.data.displayName).toBe('Set B');
  });

  /**
   * A clinic that corrects its country during the trial is quoted in the new
   * currency — and the subscription row is what does the quoting.
   *
   * Left behind, it said INR while the organization said EUR, and the billing
   * screen believed the subscription: catalogue, current plan and upgrade quote
   * all in rupees for a clinic that had just told us it was in Ireland.
   * Untouched once money has moved — see `realignUnbilledCurrency`.
   */
  it('moves an unbilled subscription onto the new currency, price and all', async () => {
    await A.patch('/api/v1/organization', { countryCode: 'IE', currency: 'EUR' });

    const { rows } = await owner.query<{ currency: string; price_currency: string }>(
      `SELECT s.currency, pp.currency AS price_currency
       FROM subscriptions s
       JOIN plan_prices pp ON pp.id = s.plan_price_id
       WHERE s.organization_id = $1`,
      [orgA.organizationId]
    );

    expect(rows[0]?.currency.trim()).toBe('EUR');
    expect(rows[0]?.price_currency.trim()).toBe('EUR');

    await A.patch('/api/v1/organization', { countryCode: 'IN', currency: 'INR' });
  });

  it('normalises the currency code to upper case', async () => {
    const res = await A.patch('/api/v1/organization', { currency: 'usd' });
    expect(res.body.data.currency).toBe('USD');
    await A.patch('/api/v1/organization', { currency: 'INR' });
  });

  it('drops the host cache, because currency and timezone are cached in it', async () => {
    // Warm it, then change one of the five cached fields.
    await A.get('/api/v1/organization');
    expect(await redis.get(`tenant:host:${hostFor(SLUG_A)}`)).not.toBeNull();

    await A.patch('/api/v1/organization', { timezone: 'Asia/Dubai' });
    expect(await redis.get(`tenant:host:${hostFor(SLUG_A)}`)).toBeNull();

    await A.patch('/api/v1/organization', { timezone: 'Asia/Kolkata' });
  });

  /*
   * ⚠️ THESE TWO CASES USED TO SET AND CLEAR A GSTIN HERE, AND THE FIELD IS GONE
   *   ON PURPOSE. A tax number is a property of a TAX REGISTRATION — which also
   *   carries the scheme, the jurisdiction, the name it is held in and the dates
   *   it was in force — and keeping an editable copy on the organization meant
   *   the settings screen could show one number while every invoice printed
   *   another, permanently, with nothing to reconcile them.
   *
   *   `organizations.tax_id` still exists and is still returned: the subscription
   *   side needs one number for this clinic as rcln's CUSTOMER. It is now derived
   *   from the registration that applies, by the tax service, and
   *   `tax-registration-coverage.test.ts` is where that derivation is asserted.
   */
  it('ignores a tax number sent to the organization, because registrations own it', async () => {
    const before = (await A.get('/api/v1/organization')).body.data.taxId;

    // Not a 400: the key is simply not in the contract, and Zod strips it. What
    // matters is that it cannot become a second source of truth.
    await A.patch('/api/v1/organization', { taxId: '27AAAPA1234A1ZV' });

    expect((await A.get('/api/v1/organization')).body.data.taxId).toBe(before);
  });

  it('reports the clinic’s registrations on the profile, for display', async () => {
    const res = await A.get('/api/v1/organization');

    expect(res.status).toBe(200);
    // An array, and an empty one is a clinic below the registration threshold —
    // a legitimate steady state rather than an unfilled field.
    expect(Array.isArray(res.body.data.taxRegistrations)).toBe(true);
  });

  it('rejects a time zone that is not one', async () => {
    const res = await A.patch('/api/v1/organization', { timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect((await A.get('/api/v1/organization')).body.data.timezone).toBe('Asia/Kolkata');
  });

  it('rejects a currency code that is not one', async () => {
    // `new Intl.NumberFormat('en', { currency: 'XYZ' })` does NOT throw — it
    // only checks the three-letter shape — so an earlier version of this
    // contract accepted XYZ and stored it. The check is against
    // Intl.supportedValuesOf, and this case is what pins that.
    const res = await A.patch('/api/v1/organization', { currency: 'XYZ' });
    expect(res.status).toBe(400);

    const shape = await A.patch('/api/v1/organization', { currency: '1NR' });
    expect(shape.status).toBe(400);

    expect((await A.get('/api/v1/organization')).body.data.currency).toBe('INR');
  });

  it('refuses to move the subdomain — it is not a settings field', async () => {
    const res = await A.patch('/api/v1/organization', { slug: 'somewhere-else' });
    // Whether Zod strips it or rejects it, the slug must not move.
    const after = await A.get('/api/v1/organization');
    expect(after.body.data.slug).toBe(SLUG_A);
    expect([200, 400]).toContain(res.status);
  });

  it('writes a field-level audit row naming both actor and change', async () => {
    await A.patch('/api/v1/organization', { displayName: 'Set A Clinic' });

    const rows = await owner.query(
      `SELECT actor_user_id, entity_id, before_data, after_data FROM audit_logs
       WHERE organization_id = $1 AND entity_type = 'organization' AND action = 'UPDATE'
       ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );
    expect(rows.rows[0]).toMatchObject({
      actor_user_id: orgA.ownerUserId,
      entity_id: orgA.organizationId,
      before_data: { displayName: 'Set A Healthcare' },
      after_data: { displayName: 'Set A Clinic' },
    });
  });

  it('answers 401 without a token and 404 for an unknown host', async () => {
    const anonymous = await request(app).get('/api/v1/organization').set('Host', hostFor(SLUG_A));
    expect(anonymous.status).toBe(401);

    const nowhere = await request(app)
      .get('/api/v1/organization')
      .set('Host', `no-such-clinic-${SUFFIX}.${ROOT}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    // 404, never 403 — a 403 confirms the subdomain exists.
    expect(nowhere.status).toBe(404);
  });
});

describe('reading and writing are separate grants', () => {
  it('lets a reader read both the profile and the settings', async () => {
    expect((await Reader.get('/api/v1/organization')).status).toBe(200);
    expect((await Reader.get('/api/v1/organization/settings')).status).toBe(200);
  });

  it('refuses the same person either write', async () => {
    expect((await Reader.patch('/api/v1/organization', { displayName: 'Mine now' })).status).toBe(
      403
    );
    expect((await Reader.put(`/api/v1/organization/settings/${SLOT}`, { value: 45 })).status).toBe(
      403
    );
    expect((await Reader.delete(`/api/v1/organization/settings/${SLOT}`)).status).toBe(403);
  });
});

describe('settings resolution', () => {
  it('starts every setting on the definition default, overridden by nobody', async () => {
    const settings = await settingsOf(A);
    const slot = settings.get(SLOT);
    expect(slot).toMatchObject({
      value: 15,
      isOverridden: false,
      inheritedValue: 15,
      inheritedFrom: 'DEFAULT',
      editable: true,
      updatedAt: null,
    });
  });

  it('sets a clinic-wide value and reports what it is overruling', async () => {
    const res = await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      value: 20,
      isOverridden: true,
      inheritedValue: 15,
      inheritedFrom: 'DEFAULT',
    });
    expect(res.body.data.updatedAt).not.toBeNull();
  });

  it('does not leak that value to the other clinic', async () => {
    // setting_values is RLS-exempt and keyed only by (key, scope, scope id). A
    // `where` naming the key alone would hand this row to every tenant.
    const settings = await settingsOf(B);
    expect(settings.get(SLOT)).toMatchObject({ value: 15, isOverridden: false });
  });

  it('keeps two clinics’ answers to the same key apart', async () => {
    await B.put(`/api/v1/organization/settings/${SLOT}`, { value: 45 });

    expect((await settingsOf(A)).get(SLOT)?.value).toBe(20);
    expect((await settingsOf(B)).get(SLOT)?.value).toBe(45);
  });

  it('replaces the existing value rather than adding a second row', async () => {
    await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 25 });

    expect((await settingsOf(A)).get(SLOT)?.value).toBe(25);
    const rows = await owner.query(
      "SELECT count(*) FROM setting_values WHERE setting_key = $1 AND scope_type = 'ORGANIZATION' AND scope_id = $2",
      [SLOT, orgA.organizationId]
    );
    expect(rows.rows[0].count).toBe('1');
  });

  it('falls back to a PLATFORM value, not the definition default, when one exists', async () => {
    // gen_random_uuid() is not optional: Prisma generates ids in the CLIENT, so
    // `id` has no column default and a bare INSERT violates NOT NULL.
    await owner.query(
      `INSERT INTO setting_values (id, setting_key, scope_type, scope_id, value, updated_at)
       VALUES (gen_random_uuid(), $1, 'PLATFORM', NULL, '10'::jsonb, now())`,
      [SLOT]
    );

    try {
      const slot = (await settingsOf(A)).get(SLOT);
      // The clinic's own value still wins — it is the more specific scope.
      expect(slot).toMatchObject({ value: 25, inheritedValue: 10, inheritedFrom: 'PLATFORM' });

      const untouched = (await settingsOf(B)).get(SLOT);
      expect(untouched).toMatchObject({ value: 45, inheritedValue: 10, inheritedFrom: 'PLATFORM' });
    } finally {
      await owner.query(
        "DELETE FROM setting_values WHERE setting_key = $1 AND scope_type = 'PLATFORM'",
        [SLOT]
      );
    }
  });

  it('clears the override and falls back to what it was overruling', async () => {
    const res = await A.delete(`/api/v1/organization/settings/${SLOT}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ value: 15, isOverridden: false, updatedAt: null });

    // And only this clinic's row went.
    expect((await settingsOf(B)).get(SLOT)?.value).toBe(45);
  });

  it('treats clearing something never set as a success', async () => {
    const res = await A.delete(`/api/v1/organization/settings/${SLOT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isOverridden).toBe(false);
  });
});

describe('what a value is allowed to be', () => {
  it('refuses a value of the wrong type, and names the type it wanted', async () => {
    const int = await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 'twenty' });
    expect(int.status).toBe(400);
    expect(int.body.message).toContain('whole number');

    const fraction = await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 12.5 });
    expect(fraction.status).toBe(400);

    const bool = await A.put('/api/v1/organization/settings/security.require_mfa_for_admins', {
      value: 'yes',
    });
    expect(bool.status).toBe(400);

    const text = await A.put('/api/v1/organization/settings/billing.invoice_prefix', { value: 7 });
    expect(text.status).toBe(400);
  });

  it('accepts a fraction where the definition asks for a DECIMAL', async () => {
    const res = await A.put('/api/v1/organization/settings/billing.default_tax_percent', {
      value: 12.5,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe(12.5);
    await A.delete('/api/v1/organization/settings/billing.default_tax_percent');
  });

  it('round-trips a JSON document', async () => {
    const res = await A.put('/api/v1/organization/settings/inventory.expiry_alert_days', {
      value: [120, 30],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toEqual([120, 30]);
    expect((await settingsOf(A)).get('inventory.expiry_alert_days')?.value).toEqual([120, 30]);
    await A.delete('/api/v1/organization/settings/inventory.expiry_alert_days');
  });

  it('refuses a setting the definition does not allow at the organization scope', async () => {
    const res = await A.put(`/api/v1/organization/settings/${BRANCH_ONLY_KEY}`, { value: 9 });
    expect(res.status).toBe(400);
    expect((await settingsOf(A)).get(BRANCH_ONLY_KEY)?.editable).toBe(false);
  });

  it('refuses a setting the platform holds for itself', async () => {
    const res = await A.put(`/api/v1/organization/settings/${PLATFORM_LOCKED_KEY}`, {
      value: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('managed by rcln');
    expect((await settingsOf(A)).get(PLATFORM_LOCKED_KEY)?.editable).toBe(false);
  });

  it('answers 404 for a key the catalogue does not carry', async () => {
    const res = await A.put('/api/v1/organization/settings/no.such.setting', { value: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects a body with no value at all before touching the database', async () => {
    const res = await A.put(`/api/v1/organization/settings/${SLOT}`, {});
    expect(res.status).toBe(400);
  });
});

/**
 * A setting whose `allowed_values` is set is a closed set at the API, not only
 * in the select the screen renders.
 *
 * The screen builds its options from this same column, so the two cannot drift
 * — but the screen is not the only caller, and a delivery channel set to
 * anything a curl can spell fails much later, as a notification nothing can
 * send.
 */
describe('closed sets', () => {
  const CHANNEL = 'notification.default_channel';
  const FY_MONTH = 'billing.financial_year_start_month';

  it('publishes the choices and the help text the screen renders from', async () => {
    const settings = await settingsOf(A);

    const channel = settings.get(CHANNEL);
    expect(channel?.choices).toEqual([
      { value: 'WHATSAPP', label: 'WhatsApp' },
      { value: 'SMS', label: 'SMS' },
      { value: 'EMAIL', label: 'Email' },
    ]);
    expect(channel?.helpText).toContain('Where reminders');

    // Numbers keep their type through the JSONB round trip: April is 4, not "4".
    const month = settings.get(FY_MONTH);
    expect(month?.choices).toHaveLength(12);
    expect(month?.choices?.[3]).toEqual({ value: 4, label: 'April' });
  });

  it('accepts a value from the set', async () => {
    expect((await A.put(`/api/v1/organization/settings/${CHANNEL}`, { value: 'SMS' })).status).toBe(
      200
    );
    expect((await A.put(`/api/v1/organization/settings/${FY_MONTH}`, { value: 1 })).status).toBe(
      200
    );
  });

  it('refuses one that is not, and lists what it would take', async () => {
    const res = await A.put(`/api/v1/organization/settings/${CHANNEL}`, { value: 'PIGEON' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('WhatsApp, SMS, Email');

    // Still the last good value — the refusal did not half-apply.
    expect((await settingsOf(A)).get(CHANNEL)?.value).toBe('SMS');
  });

  it('refuses a number outside the set even though the TYPE is right', async () => {
    // 13 is a perfectly good INT. `fits` passes it; the closed set is what does
    // not, which is the whole reason the two checks are separate.
    const res = await A.put(`/api/v1/organization/settings/${FY_MONTH}`, { value: 13 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('January');
  });

  it('leaves an open setting open', async () => {
    // No allowed_values on the invoice prefix, so any text is accepted.
    const res = await A.put('/api/v1/organization/settings/billing.invoice_prefix', {
      value: 'SETA',
    });
    expect(res.status).toBe(200);
    expect((await settingsOf(A)).get('billing.invoice_prefix')?.choices).toBeNull();
  });

  it('clears back to a value that is itself in the set', async () => {
    const res = await A.delete(`/api/v1/organization/settings/${CHANNEL}`);
    expect(res.body.data.value).toBe('WHATSAPP');
    await A.delete(`/api/v1/organization/settings/${FY_MONTH}`);
    await A.delete('/api/v1/organization/settings/billing.invoice_prefix');
  });
});

describe('the audit trail', () => {
  it('files the ROW id, not the setting key — entity_id is a uuid column', async () => {
    await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 20 });

    const rows = await owner.query(
      `SELECT a.entity_id, a.action, a.after_data, v.id AS value_id FROM audit_logs a
       JOIN setting_values v ON v.id = a.entity_id
       WHERE a.organization_id = $1 AND a.entity_type = 'setting_value'
       ORDER BY a.occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );
    // The join is the assertion: a key written into entity_id would not cast.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].after_data).toEqual({ [SLOT]: 20 });
  });

  it('keeps the setting named on an update, where the diff would drop a flat key', async () => {
    await A.put(`/api/v1/organization/settings/${SLOT}`, { value: 35 });

    const rows = await owner.query(
      `SELECT before_data, after_data FROM audit_logs
       WHERE organization_id = $1 AND entity_type = 'setting_value' AND action = 'UPDATE'
       ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );
    expect(rows.rows[0]).toMatchObject({
      before_data: { [SLOT]: 20 },
      after_data: { [SLOT]: 35 },
    });
  });

  it('records the clearing too', async () => {
    await A.delete(`/api/v1/organization/settings/${SLOT}`);

    const rows = await owner.query(
      `SELECT before_data, after_data FROM audit_logs
       WHERE organization_id = $1 AND entity_type = 'setting_value' AND action = 'DELETE'
       ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );
    expect(rows.rows[0].before_data).toEqual({ [SLOT]: 35 });
    expect(rows.rows[0].after_data).toBeNull();
  });

  it('files nothing against the other clinic', async () => {
    const rows = await owner.query(
      `SELECT count(*) FROM audit_logs
       WHERE organization_id = $1 AND entity_type = 'setting_value'`,
      [orgB.organizationId]
    );
    // B set exactly one value in this suite and never cleared it.
    expect(rows.rows[0].count).toBe('1');
  });
});
