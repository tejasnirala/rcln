/**
 * The clinic's own tax configuration over real HTTP, through the real chain.
 *
 * Five things are being pinned down, and none of them is "CRUD works":
 *
 *   1. THE RATE CARD ANSWERS FROM BOTH TABLES. A clinic with an empty
 *      `tax_rules` is fully configured, not unconfigured — it inherits rcln's
 *      published catalogue — so the card must show inherited categories with
 *      `source: 'PLATFORM'` before the clinic writes anything at all. A screen
 *      built on `GET /rules` alone would show an empty page to a clinic that is
 *      charging 12% on every medicine it sells.
 *   2. AN OVERRIDE TAKES THE WHOLE CATEGORY, AND THE CARD SAYS WHAT IT DISPLACED.
 *      One tenant rule for a category means the catalogue stops applying to that
 *      category entirely, and `overriding` is what makes "we charge 5% where rcln
 *      says 12%" visible rather than a thing somebody discovers in a return.
 *   3. A RULE THAT PRICED AN ISSUED INVOICE CANNOT HAVE ITS RATE MOVED. The
 *      invoice's totals are frozen at the database, so the document stays right
 *      while the rule that explains it silently stops matching — which is the
 *      worst of the available failures, and the reason `PATCH` returns 409. The
 *      description on the same rule still saves, because a word charged nothing.
 *   4. ENDING A RULE IS NOT DELETING IT, AND WHAT IT FALLS BACK TO DEPENDS ON THE
 *      CATEGORY. The row survives — an auditor years later needs it — and where
 *      the catalogue covers the category the inherited default applies again,
 *      which is what a clinic means by "stop charging our rate". Where it does
 *      not, which is every kind of GOODS on purpose, the category goes UNRATED
 *      and cannot be issued. Both are asserted, because assuming the first is how
 *      a clinic ends a medicine rate and discovers it at the counter.
 *   5. `billing.tax.read` DOES NOT CARRY `.manage`. A cashier may look up why a
 *      bill charged 5%; a counter may not change the rate. Asserted with a role
 *      holding exactly the read, because the seeded roles that hold one hold both.
 *
 * ⚠️ AND THE RATE CARD IS NOT A PHI SURFACE. The last case greps
 *   `data_access_logs` for anything this suite wrote against these routes: a rate
 *   names a category and a jurisdiction, never a patient, and a disclosure row
 *   filed here would be noise in the table that exists to find real ones.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { disconnectJobProducer } from '../../src/queue/producer.js';
import { sender } from '../../src/services/notification/sender.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `t${Date.now().toString(36)}`;
const SLUG_A = `tax-a-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/** Inside FY 2026-27, so every number this suite issues reads `INV-2026-`. */
const SUPPLIED_ON = '2026-08-11';

const CUSTOMER = 'Meenakshi Varadarajan';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let ownerToken = '';
let readerToken = '';

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

const asUser = (slug: string, token: () => string) => {
  const auth = (r: request.Test): request.Test =>
    r.set('Host', hostFor(slug)).set('Authorization', `Bearer ${token()}`);
  return {
    get: (path: string) => auth(request(app).get(`/api/v1${path}`)),
    post: (path: string, body: object = {}) => auth(request(app).post(`/api/v1${path}`)).send(body),
    patch: (path: string, body: object = {}) =>
      auth(request(app).patch(`/api/v1${path}`)).send(body),
  };
};

const A = asUser(SLUG_A, () => ownerToken);
const Reader = asUser(SLUG_A, () => readerToken);

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

/** Invite, accept, sign in — the way a real member comes into existence. */
async function joinAs(email: string, fullName: string, roleId: string): Promise<string> {
  await clearRateLimits();
  const invited = await A.post('/invitations', { email, roleId, branchIds: [orgA.branchId] });
  if (invited.status !== 201) {
    throw new Error(`could not invite ${email}: ${JSON.stringify(invited.body)}`);
  }

  const link = [...sent].reverse().find((mail) => mail.to === email)?.link;
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error(`no invitation email reached ${email}`);

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

const READER_EMAIL = `taxreader-${SUFFIX}@example.test`;

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

  orgA = await registerOrganization(payload(SLUG_A, 'Tax A'));
  ownerToken = await login(SLUG_A, `${SLUG_A}@example.test`, PASSWORD);

  /*
   * The branch's jurisdiction. The rate card resolves the country from the
   * BRANCHES rather than from a parameter, and a registration only covers a
   * branch whose own (country, region) it matches — which is the assertion
   * `coveredBranches` exists for.
   */
  await owner.query(
    `UPDATE branches
        SET country_code = 'IN', region_code = 'KA',
            address_line1 = '418, 12th Main Road', city = 'Bengaluru',
            state = 'Karnataka', pincode = '560008', phone = '+918041238890'
      WHERE id = $1`,
    [orgA.branchId]
  );

  /*
   * ⚠️ READ AND NOT MANAGE, WHICH NO SEEDED ROLE IS SHAPED LIKE. ACCOUNTANT holds
   *   both and BRANCH_ADMIN holds the read alongside every other branch power, so
   *   neither would show that the read alone refuses a write.
   */
  const readerRole = await A.post('/roles', {
    code: 'TAX_LOOKUP',
    name: 'Tax lookup',
    scopeLevel: 'BRANCH',
    permissionCodes: ['billing.tax.read'],
  });
  if (readerRole.status !== 201) {
    throw new Error(`could not create the reader role: ${JSON.stringify(readerRole.body)}`);
  }
  readerToken = await joinAs(READER_EMAIL, 'Tax Reader', readerRole.body.data.id as string);
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId].filter(Boolean);

  if (ids.length > 0) {
    const users = await owner?.query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE organization_id = ANY($1)',
      [ids]
    );
    const userIds = users?.rows.map((r) => r.user_id) ?? [];

    if (userIds.length > 0) {
      await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
    }
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
    if (userIds.length > 0) {
      await owner?.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
  }

  await owner?.end();
  await disconnectJobProducer();
  await disconnectDb();
  await redis.quit();
});

interface CategoryCard {
  taxCategory: string;
  source: 'TENANT' | 'PLATFORM';
  applied: { id: string; rateBps: number; treatment: string; isLive: boolean }[];
  overriding: { id: string; rateBps: number }[];
}

const cardFor = async (category: string): Promise<CategoryCard | undefined> => {
  const res = await A.get('/tax/rate-card');
  expect(res.status).toBe(200);
  return (res.body.data.categories as CategoryCard[]).find(
    (entry) => entry.taxCategory === category
  );
};

// ---------------------------------------------------------------------------

describe('registrations', () => {
  let registrationId = '';

  it('a clinic starts with none, which is a legitimate state and not an error', async () => {
    const res = await A.get('/tax/registrations');
    expect(res.status).toBe(200);
    expect(res.body.data.registrations).toEqual([]);
  });

  it('records one, and says which branches it covers', async () => {
    const res = await A.post('/tax/registrations', {
      countryCode: 'IN',
      regionCode: 'KA',
      scheme: 'GST',
      registrationNumber: '29AAACR1234K1ZP',
      legalName: 'Tax A Pvt Ltd',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.placeOfSupply).toBe('IN-KA');
    expect(res.body.data.isLive).toBe(true);
    /*
     * The assertion that matters. A registration matching no branch covers
     * nothing, invoices then issue with no tax and no error, and the region code
     * is where the typo lives.
     */
    expect(res.body.data.coveredBranches).toHaveLength(1);
    expect(res.body.data.coveredBranches[0].id).toBe(orgA.branchId);

    registrationId = res.body.data.id as string;
  });

  /*
   * ⚠️ THIS USED TO ASSERT A 409, AND THE INVERSION IS THE POINT.
   *
   *   The rule was one registration per (country, region, scheme) — "one per
   *   place" — and it made two ordinary things unrecordable. India has permitted
   *   a second GSTIN in one state for a separate business vertical since 2019,
   *   and a clinic whose number changes has to keep the old one to explain the
   *   invoices issued under it. The old check even told the caller to lapse the
   *   existing registration instead, which did not work: it ignored
   *   `effective_to`, so the lapsed row went on blocking its own successor.
   *
   *   What cannot repeat is the NUMBER, which the next case covers.
   */
  it('records a SECOND registration in the same jurisdiction, which is legitimate', async () => {
    const res = await A.post('/tax/registrations', {
      countryCode: 'IN',
      regionCode: 'KA',
      scheme: 'GST',
      registrationNumber: '29ZZZZZ9999Z1ZZ',
      /*
       * Dated ahead so this suite still has exactly one LIVE Karnataka
       * registration — the rest of it asserts what the engine prices against, and
       * two live ones in a jurisdiction is a question about coverage rather than
       * about rates. `tax-registration-coverage.test.ts` is where the concurrent
       * case is exercised.
       */
      effectiveFrom: '2027-04-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.placeOfSupply).toBe('IN-KA');
    // Recorded, not yet in force — the third state the dates can describe.
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(res.body.data.isLive).toBe(false);
  });

  it('refuses the SAME registration number twice, which is a duplicate and not a second one', async () => {
    const res = await A.post('/tax/registrations', {
      countryCode: 'IN',
      regionCode: 'KA',
      scheme: 'GST',
      registrationNumber: '29ZZZZZ9999Z1ZZ',
      effectiveFrom: '2028-04-01',
    });

    expect(res.status).toBe(409);
  });

  it('a registration for a region no branch is in covers nothing', async () => {
    const res = await A.post('/tax/registrations', {
      countryCode: 'IN',
      regionCode: 'MH',
      scheme: 'GST',
      registrationNumber: '27AAACR1234K1ZP',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.coveredBranches).toEqual([]);
  });

  /*
   * ⚠️ LAPSING IS AN UPDATE, NOT A DELETE, AND IT IS HOW A SUCCESSION IS RECORDED.
   *   The row stays because it is the account of every invoice issued under it.
   *   The screen reaches this through the same PATCH.
   */
  it('lapses a registration by giving it an end date, and keeps the row', async () => {
    const res = await A.patch(`/tax/registrations/${registrationId}`, {
      effectiveTo: '2030-03-31',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.effectiveTo).toBe('2030-03-31');
    // Still in force today — an end date in the future is a scheduled lapse.
    expect(res.body.data.status).toBe('ACTIVE');

    const listed = await A.get('/tax/registrations');
    expect((listed.body.data.registrations as { id: string }[]).map((r) => r.id)).toContain(
      registrationId
    );
  });

  it('refuses an end date before the registration began', async () => {
    /*
     * A backwards range matches nothing, silently and forever: the registration
     * stops being found and every invoice comes out NOT_REGISTERED with nothing
     * on it to say why. The database refuses it as well, but a CHECK surfaces as
     * a 500 with a constraint name in it.
     */
    const res = await A.patch(`/tax/registrations/${registrationId}`, {
      effectiveTo: '2020-01-01',
    });

    expect(res.status).toBe(400);
  });

  it('corrects a mistyped number in place, because the invoice snapshotted it', async () => {
    const res = await A.patch(`/tax/registrations/${registrationId}`, {
      registrationNumber: '29AAACR1234K1Z9',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.registrationNumber).toBe('29AAACR1234K1Z9');
  });

  it('files an audit row naming the registration, and no PHI', async () => {
    const { rows } = await owner.query<{ action: string; after_data: unknown }>(
      `SELECT action, after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'issuer_tax_registration'
        ORDER BY occurred_at ASC`,
      [orgA.organizationId]
    );

    expect(rows.length).toBeGreaterThanOrEqual(3);
    // The clinic's own number is on the row on purpose — it is printed on every
    // invoice it covers, and who changed it is the question an auditor asks.
    expect(JSON.stringify(rows)).toContain('29AAACR1234K1ZP');
    expect(JSON.stringify(rows)).not.toContain(CUSTOMER);
  });
});

describe('the rate card', () => {
  it('shows inherited categories before the clinic writes a single rule', async () => {
    const res = await A.get('/tax/rate-card');

    expect(res.status).toBe(200);
    expect(res.body.data.countryCode).toBe('IN');
    /*
     * ⚠️ THE CASE A SCREEN BUILT ON `GET /rules` WOULD GET WRONG. The seed's
     *   healthcare defaults are the whole of this clinic's rate card, and they
     *   live in a table it owns no rows in.
     */
    expect((res.body.data.categories as CategoryCard[]).length).toBeGreaterThan(0);
    expect((res.body.data.categories as CategoryCard[]).every((c) => c.source === 'PLATFORM')).toBe(
      true
    );
  });

  it('reports no unrated categories when there are no drafts to be unrated', async () => {
    const res = await A.get('/tax/rate-card');
    expect(res.body.data.unratedCategories).toEqual([]);
  });
});

describe('rules', () => {
  let ruleId = '';
  const CATEGORY = 'MEDICINE';

  it('adds an override, and it takes the whole category', async () => {
    const res = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: CATEGORY,
      description: 'Our own medicine rate',
      rateBps: 500,
      treatment: 'STANDARD',
      lineName: 'GST',
      split: 'INTRA_STATE_HALVES',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.jurisdiction).toBe('IN');
    expect(res.body.data.usedOnIssuedInvoices).toBe(false);
    ruleId = res.body.data.id as string;

    const card = await cardFor(CATEGORY);
    expect(card?.source).toBe('TENANT');
    expect(card?.applied.map((rule) => rule.id)).toEqual([ruleId]);
  });

  it('refuses a rate of anything on an exempt rule', async () => {
    const res = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: 'PHYSIO',
      rateBps: 1200,
      treatment: 'EXEMPT',
      lineName: 'GST',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.rateBps).toBeDefined();
  });

  it('refuses a country-wide rule that stacks, because it would stack on itself', async () => {
    const res = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: 'SUPPLIES',
      rateBps: 500,
      lineName: 'GST',
      stacks: true,
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.regionCode).toBeDefined();
  });

  it('refuses a second rule starting on the same day for the same category', async () => {
    const res = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: CATEGORY,
      rateBps: 1800,
      lineName: 'GST',
      effectiveFrom: '2025-04-01',
    });

    // Two rules from the same date have no defined winner.
    expect(res.status).toBe(409);
  });

  describe('once an invoice has been issued under it', () => {
    beforeAll(async () => {
      const draft = await A.post('/invoices', {
        branchId: orgA.branchId,
        sourceType: 'OTHER',
        customer: { name: CUSTOMER },
        suppliedOn: SUPPLIED_ON,
        lines: [
          {
            description: 'Paracetamol 500mg',
            taxCategory: CATEGORY,
            quantity: '2',
            unitPriceMinor: 5000,
          },
        ],
      });
      if (draft.status !== 201) {
        throw new Error(`could not open the draft: ${JSON.stringify(draft.body)}`);
      }

      const issued = await A.post(`/invoices/${draft.body.data.id}/issue`, {});
      if (issued.status !== 200) {
        throw new Error(`could not issue: ${JSON.stringify(issued.body)}`);
      }

      /*
       * The clinic's 5% and not the catalogue's 12% — which is also the proof
       * that an override reaches the engine and not only the screen.
       */
      expect(issued.body.data.taxes[0].rateBps).toBe(250);
    });

    it('says so on the rule', async () => {
      const res = await A.get('/tax/rules');
      const rule = (res.body.data.rules as { id: string; usedOnIssuedInvoices: boolean }[]).find(
        (entry) => entry.id === ruleId
      );
      expect(rule?.usedOnIssuedInvoices).toBe(true);
    });

    it('refuses to move the rate', async () => {
      const res = await A.patch(`/tax/rules/${ruleId}`, { rateBps: 1800 });

      // The invoice's totals are frozen at the database, so the document would
      // stay right while the rule explaining it stopped matching.
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('rate');
    });

    it('still saves a description, because a word charged nothing', async () => {
      const res = await A.patch(`/tax/rules/${ruleId}`, { description: 'Medicines, 5%' });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe('Medicines, 5%');
    });

    it('ends it rather than deleting it, and the row survives', async () => {
      const res = await A.post(`/tax/rules/${ruleId}/end`, { effectiveTo: '2025-06-30' });
      expect(res.status).toBe(200);
      expect(res.body.data.effectiveTo).toBe('2025-06-30');

      // Still listed, because an auditor years later needs the row that priced
      // the invoice. `includeExpired` is what asks for it.
      const listed = await A.get('/tax/rules?includeExpired=true');
      expect((listed.body.data.rules as { id: string }[]).map((r) => r.id)).toContain(ruleId);
    });

    it('and MEDICINE goes UNRATED, because the catalogue never covered it', async () => {
      /*
       * ⚠️ ENDING A RULE FALLS BACK TO THE CATALOGUE ONLY WHERE THE CATALOGUE
       *   COVERS THE CATEGORY, AND FOR GOODS IT DELIBERATELY DOES NOT. rcln
       *   publishes healthcare SERVICES — a medicine's rate depends on the
       *   medicine, and a plausible wrong default there is worse than none. So a
       *   clinic that ends its own MEDICINE rate is charging nothing and cannot
       *   issue: the correct failure, and not one this endpoint should hide.
       */
      const card = await cardFor(CATEGORY);
      expect(card?.applied).toEqual([]);
    });

    it('refuses an end date before the rule began', async () => {
      const res = await A.post(`/tax/rules/${ruleId}/end`, { effectiveTo: '2020-01-01' });
      expect(res.status).toBe(400);
    });
  });
});

describe('ending an override on a category the catalogue covers', () => {
  /*
   * CONSULTATION rather than MEDICINE, because this is the assertion that the
   * inherited default comes BACK — which it can only do where there is one. The
   * seed publishes healthcare services per country; India exempts them.
   */
  let ruleId = '';

  it('starts inherited and exempt', async () => {
    const card = await cardFor('CONSULTATION');
    expect(card?.source).toBe('PLATFORM');
    expect(card?.applied[0]?.treatment).toBe('EXEMPT');
  });

  it('an override displaces it, and the card says what it displaced', async () => {
    const res = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: 'CONSULTATION',
      description: 'Cosmetic consultations, standard-rated',
      rateBps: 1800,
      treatment: 'STANDARD',
      lineName: 'GST',
      split: 'INTRA_STATE_HALVES',
      effectiveFrom: '2025-04-01',
    });
    expect(res.status).toBe(201);
    ruleId = res.body.data.id as string;

    const card = await cardFor('CONSULTATION');
    expect(card?.source).toBe('TENANT');
    expect(card?.applied.map((rule) => rule.id)).toEqual([ruleId]);
    /*
     * "We charge 18% where rcln says exempt" — either the clinic is right about
     * its own mix of work, or somebody has just put GST on medical care. Either
     * way it is the sentence this screen exists to produce.
     */
    expect(card?.overriding.length).toBeGreaterThan(0);
  });

  it('and ending it brings the catalogue back', async () => {
    const ended = await A.post(`/tax/rules/${ruleId}/end`, { effectiveTo: '2025-06-30' });
    expect(ended.status).toBe(200);

    const card = await cardFor('CONSULTATION');
    expect(card?.source).toBe('PLATFORM');
    expect(card?.applied[0]?.treatment).toBe('EXEMPT');
  });
});

describe('the read does not carry the write', () => {
  it('lets a reader see the rate card', async () => {
    const res = await Reader.get('/tax/rate-card');
    expect(res.status).toBe(200);
  });

  it('refuses the same caller a new rule', async () => {
    const res = await Reader.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: 'ANYTHING',
      rateBps: 500,
      lineName: 'GST',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(403);
  });

  it('refuses the same caller a registration', async () => {
    const res = await Reader.post('/tax/registrations', {
      countryCode: 'IN',
      scheme: 'VAT',
      registrationNumber: 'IE1234567X',
      effectiveFrom: '2025-04-01',
    });

    expect(res.status).toBe(403);
  });
});

describe('this is not a PHI surface', () => {
  it('writes no data_access_logs row for a rate-card read', async () => {
    const { rows } = await owner.query<{ route: string }>(
      `SELECT route FROM data_access_logs
        WHERE organization_id = $1 AND route LIKE '%/tax%'`,
      [orgA.organizationId]
    );

    /*
     * A rate names a category and a jurisdiction. Filing a disclosure row for it
     * would put noise in the table whose only job is finding the reads that
     * matter — and a rate card is opened by whoever is reconciling, repeatedly.
     */
    expect(rows).toEqual([]);
  });
});
