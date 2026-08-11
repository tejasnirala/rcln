/**
 * The invoice engine's audit trail, over real HTTP.
 *
 * Five things are being pinned down, and "a row gets written" is only the first
 * of them:
 *
 *   1. EVERY WRITE IN THE LIFE OF AN INVOICE LEAVES A ROW. Until this phase not
 *      one of them did — `invoices.test.ts` said "a creation is a write, and
 *      `audit_logs` has it" and `audit_logs` did not. A bill could be opened,
 *      re-priced, issued and voided with nothing anywhere naming who did it.
 *   2. THE ROW SAYS WHAT MOVED FINANCIALLY. An audit trail on a ledger that
 *      records a status change and not the grand total behind it is a trail
 *      that cannot answer the only question anybody asks it.
 *   3. AND IT NAMES NOBODY. The `invoices` table carries the patient in four
 *      columns on purpose — the document must keep printing them — and
 *      `audit_logs` is read by compliance staff who have no business reading
 *      patient records. The allow-list snapshot is what keeps the two apart, and
 *      the sweep at the bottom is what proves it, across every entity type this
 *      suite touches rather than only the one it is about.
 *   4. FINALISATION'S RE-PRICE IS IN THE TRAIL. The rate card can be corrected
 *      between a draft being opened and the patient being handed the bill, which
 *      moves the tax on a request where nobody typed a number. That is the one
 *      change no human made and the one most worth recording.
 *   5. THE GATE IS `audit.record.read` AND NOT `billing.invoice.read`. The
 *      widening looks obvious and is wrong — see the desk cashier's 403 below.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { disconnectJobProducer } from '../../src/queue/producer.js';
import { initDocumentStore } from '../../src/services/document/store.js';
import { sender } from '../../src/services/notification/sender.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `ia${Date.now().toString(36)}`;
const SLUG = `inv-audit-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/** Inside FY 2026-27, so every number in this suite reads `INV-2026-`. */
const SUPPLIED_ON = '2026-08-11';

/**
 * The needles. Distinctive enough that finding any of them in an audit row is
 * unambiguous — a surname that occurs in no fixture, a phone nobody else uses,
 * and a line description that is a diagnosis wearing a billing column's clothes.
 */
const CUSTOMER = 'Meenakshi Varadarajan';
const CUSTOMER_PHONE = '+919845011223';
const CUSTOMER_ADDRESS = '418, 12th Main Road, Indiranagar';
const LINE_DESCRIPTION = 'Ultrasound, obstetric';
const VOID_REASON = 'Raised against the wrong episode of care';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ownerToken = '';
let deskToken = '';

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
    put: (path: string, body: object = {}) => auth(request(app).put(`/api/v1${path}`)).send(body),
  };
};

const A = asUser(SLUG, () => ownerToken);
const Desk = asUser(SLUG, () => deskToken);

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
  const invited = await A.post('/invitations', { email, roleId, branchIds: [org.branchId] });
  if (invited.status !== 201) {
    throw new Error(`could not invite ${email}: ${JSON.stringify(invited.body)}`);
  }

  const link = [...sent].reverse().find((mail) => mail.to === email)?.link;
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error(`no invitation email reached ${email}`);

  await clearRateLimits();
  const accepted = await request(app)
    .post('/api/v1/auth/invitations/accept')
    .set('Host', hostFor(SLUG))
    .send({ token, fullName, password: MEMBER_PASSWORD });
  if (accepted.status !== 201) {
    throw new Error(`could not accept for ${email}: ${JSON.stringify(accepted.body)}`);
  }

  return login(SLUG, email, MEMBER_PASSWORD);
}

const DESK_EMAIL = `desk-${SUFFIX}@example.test`;

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  initDocumentStore();
  app = createApp();

  sender.sendEmail = (to, _template, vars) => {
    sent.push({ to, link: vars['link'] ?? '' });
    return Promise.resolve();
  };

  org = await registerOrganization(payload(SLUG, 'Inv Audit'));
  ownerToken = await login(SLUG, `${SLUG}@example.test`, PASSWORD);

  /*
   * The branch's jurisdiction and a registration covering it. Without both,
   * finalisation refuses every invoice and half this suite never reaches the
   * transition it is about.
   */
  await owner.query(`UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = $1`, [
    org.branchId,
  ]);

  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR9911K1ZP',
             'Inv Audit Pvt Ltd', '2025-04-01', now())`,
    [org.organizationId]
  );

  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE', 1200, 'STANDARD', 'GST',
             'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [org.organizationId]
  );

  /*
   * The front desk: the whole invoice surface and NO `audit.record.read`. No
   * system role is shaped this way, and the narrow one is what proves the gate
   * is not implied by `billing.invoice.read` — see the 403 below.
   */
  const deskRole = await A.post('/roles', {
    code: 'DESK_BILLING',
    name: 'Desk billing',
    scopeLevel: 'BRANCH',
    permissionCodes: [
      'billing.invoice.read',
      'billing.invoice.create',
      'billing.invoice.update',
      'billing.invoice.cancel',
    ],
  });
  if (deskRole.status !== 201) {
    throw new Error(`could not create the desk role: ${JSON.stringify(deskRole.body)}`);
  }

  deskToken = await joinAs(DESK_EMAIL, 'Desk Clerk', deskRole.body.data.id as string);
}, 60_000);

afterAll(async () => {
  if (org?.organizationId) {
    const users = await owner?.query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE organization_id = $1',
      [org.organizationId]
    );
    const userIds = users?.rows.map((r) => r.user_id) ?? [];

    if (userIds.length > 0) {
      await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
    }
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
    if (userIds.length > 0) {
      await owner?.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
  }

  await owner?.end();
  await disconnectJobProducer();
  await disconnectDb();
  await redis.quit();
});

// ---------------------------------------------------------------------------

const line = (description: string, unitPriceMinor: number, quantity = '1') => ({
  description,
  taxCategory: 'MEDICINE',
  unitPriceMinor,
  quantity,
});

const customer = {
  name: CUSTOMER,
  phone: CUSTOMER_PHONE,
  address: CUSTOMER_ADDRESS,
};

async function draft(lines = [line(LINE_DESCRIPTION, 100_000)]): Promise<string> {
  const res = await A.post('/invoices', {
    branchId: org.branchId,
    sourceType: 'OTHER',
    customer,
    suppliedOn: SUPPLIED_ON,
    lines,
  });
  if (res.status !== 201) {
    throw new Error(`could not open a draft: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id as string;
}

interface AuditRow {
  action: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  branch_id: string | null;
  actor_user_id: string | null;
}

/** Every row for one invoice, oldest first — the order the life happened in. */
async function trailFor(invoiceId: string): Promise<AuditRow[]> {
  const rows = await owner.query<AuditRow>(
    `SELECT action, before_data, after_data, branch_id, actor_user_id
       FROM audit_logs
      WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2
      ORDER BY occurred_at ASC, id ASC`,
    [org.organizationId, invoiceId]
  );
  return rows.rows;
}

// ---------------------------------------------------------------------------

describe('a draft being opened', () => {
  it('files a CREATE row carrying the priced totals, not the zeroes it was inserted with', async () => {
    const invoiceId = await draft();
    const [created, ...rest] = await trailFor(invoiceId);

    expect(rest).toHaveLength(0);
    expect(created?.action).toBe('CREATE');
    expect(created?.branch_id).toBe(org.branchId);
    expect(created?.actor_user_id).toBe(org.ownerUserId);

    /*
     * ⚠️ THE TOTALS, NOT `@default(0)`. The row exists between the INSERT and
     *   the pricing with every money column at zero, and a snapshot taken there
     *   would file a ₹1,000 invoice as costing nothing — permanently, into a
     *   table that cannot be corrected. ₹1,000 + 12% GST = ₹1,120.
     */
    expect(created?.after_data).toMatchObject({
      status: 'DRAFT',
      sourceType: 'OTHER',
      lineCount: 1,
      currency: 'INR',
      subtotalMinor: 100_000,
      taxTotalMinor: 12_000,
      grandTotalMinor: 112_000,
      invoiceNumber: null,
    });
  });

  it('names nobody — no customer block, no line description', async () => {
    const invoiceId = await draft();
    const [created] = await trailFor(invoiceId);
    const after = created?.after_data ?? {};

    for (const key of ['customerName', 'customerPhone', 'customerEmail', 'customerAddress']) {
      expect(after).not.toHaveProperty(key);
    }
    /* `lineCount` is what an audit row needs; what the lines were FOR is on the
       invoice, behind `billing.invoice.read` and a `data_access_logs` row. */
    expect(after).not.toHaveProperty('items');
    expect(after).not.toHaveProperty('lines');
    expect(JSON.stringify(after)).not.toContain(LINE_DESCRIPTION);
  });
});

describe('a draft being edited', () => {
  it('narrows to what moved and says nothing about what did not', async () => {
    const invoiceId = await draft();

    const res = await A.put(`/invoices/${invoiceId}`, {
      customer,
      suppliedOn: SUPPLIED_ON,
      lines: [line(LINE_DESCRIPTION, 100_000), line('Syrup', 20_000)],
    });
    expect(res.status).toBe(200);

    const [, edited] = await trailFor(invoiceId);
    expect(edited?.action).toBe('UPDATE');

    /* ₹1,000 → ₹1,200 of goods, and the tax follows it. */
    expect(edited?.before_data).toMatchObject({ lineCount: 1, grandTotalMinor: 112_000 });
    expect(edited?.after_data).toMatchObject({ lineCount: 2, grandTotalMinor: 134_400 });

    /*
     * The branch, the source and the currency did not move, so the diff must not
     * restate them — a trail that repeats the unchanged row on every edit is the
     * same as one that records nothing. `diffSnapshots` does this; the assertion
     * is here because a snapshot built from the REQUEST rather than from the row
     * would quietly break it.
     */
    expect(edited?.after_data).not.toHaveProperty('branchId');
    expect(edited?.after_data).not.toHaveProperty('sourceType');
    expect(edited?.after_data).not.toHaveProperty('currency');
  });
});

describe('issuing', () => {
  it('records the number, the status and the re-price as one row', async () => {
    const invoiceId = await draft();

    const res = await A.post(`/invoices/${invoiceId}/issue`, {});
    expect(res.status).toBe(200);

    const trail = await trailFor(invoiceId);
    const issued = trail[trail.length - 1];

    expect(issued?.action).toBe('UPDATE');
    expect(issued?.before_data).toMatchObject({ status: 'DRAFT', invoiceNumber: null });
    expect(issued?.after_data).toMatchObject({ status: 'ISSUED' });
    expect(String((issued?.after_data ?? {})['invoiceNumber'])).toMatch(/^INV-2026-/);

    /* The registration the document was issued under — the fact a return is
       reconciled against, and the one an edit to the registration row can no
       longer change afterwards. */
    expect(issued?.after_data).toHaveProperty('issuerTaxId', '29AAACR9911K1ZP');

    /*
     * ⚠️ FINALIZING IS NOT IN THE TRAIL, AND THAT IS DELIBERATE. It is the shape
     *   of the write — two updates so the frozen columns land while the row is
     *   still open — and no reader can ever be shown an invoice in it. Three
     *   rows for one issue would file a state that does not exist.
     */
    expect(trail).toHaveLength(2);
  });

  /**
   * ⚠️ THE CHANGE NO HUMAN MADE. Finalisation prices from the stored inputs
   *   again, so a rate corrected between the draft being opened and the bill
   *   being handed over moves the tax on a request whose body was empty. A
   *   snapshot taken AFTER the re-price would show the status and the number
   *   changing and would be silent about the money.
   */
  it('shows the tax moving when the rate card changed under the draft', async () => {
    const invoiceId = await draft();

    /* 12% → 18%, from before this invoice's day of supply. */
    await owner.query(
      `UPDATE tax_rules SET rate_bps = 1800
        WHERE organization_id = $1 AND tax_category = 'MEDICINE'`,
      [org.organizationId]
    );

    try {
      const res = await A.post(`/invoices/${invoiceId}/issue`, {});
      expect(res.status).toBe(200);

      const trail = await trailFor(invoiceId);
      const issued = trail[trail.length - 1];

      expect(issued?.before_data).toMatchObject({ taxTotalMinor: 12_000 });
      expect(issued?.after_data).toMatchObject({ taxTotalMinor: 18_000 });
      expect(issued?.after_data).toMatchObject({ grandTotalMinor: 118_000 });
    } finally {
      await owner.query(
        `UPDATE tax_rules SET rate_bps = 1200
          WHERE organization_id = $1 AND tax_category = 'MEDICINE'`,
        [org.organizationId]
      );
    }
  });
});

describe('cancelling and voiding', () => {
  it('records a cancelled draft as a status change with a reason on file', async () => {
    const invoiceId = await draft();

    const res = await A.post(`/invoices/${invoiceId}/cancel`, { reason: 'Opened by mistake' });
    expect(res.status).toBe(200);

    const trail = await trailFor(invoiceId);
    const cancelled = trail[trail.length - 1];

    expect(cancelled?.before_data).toMatchObject({ status: 'DRAFT' });
    expect(cancelled?.after_data).toMatchObject({
      status: 'CANCELLED',
      /* THAT a reason was given. Not the sentence — see the sweep below. */
      hasCancellationReason: true,
    });
    expect(cancelled?.after_data).not.toHaveProperty('cancellationReason');
  });

  /**
   * ⚠️ THE FROZEN FINANCIALS ARE IDENTICAL ON BOTH SIDES OF A VOID, WHICH IS THE
   *   POINT. A void reverses a document without changing a figure on it, so the
   *   diff must narrow to the status and the reversal — and the fact that the
   *   totals did NOT move becomes provable from the trail, because a row that
   *   moved them would have said so.
   */
  it('records a void without restating a single figure on the document', async () => {
    const invoiceId = await draft();
    expect((await A.post(`/invoices/${invoiceId}/issue`, {})).status).toBe(200);

    const res = await A.post(`/invoices/${invoiceId}/void`, { reason: VOID_REASON });
    expect(res.status).toBe(200);

    const trail = await trailFor(invoiceId);
    const voided = trail[trail.length - 1];

    expect(voided?.before_data).toMatchObject({ status: 'ISSUED' });
    expect(voided?.after_data).toMatchObject({
      status: 'VOID',
      hasCancellationReason: true,
    });

    for (const key of ['grandTotalMinor', 'taxTotalMinor', 'invoiceNumber', 'issuerTaxId']) {
      expect(voided?.after_data).not.toHaveProperty(key);
    }
  });
});

describe('reading the trail back', () => {
  it('returns the whole life of an invoice to a caller holding audit.record.read', async () => {
    const invoiceId = await draft();
    await A.put(`/invoices/${invoiceId}`, {
      customer,
      suppliedOn: SUPPLIED_ON,
      lines: [line(LINE_DESCRIPTION, 250_000)],
    });
    await A.post(`/invoices/${invoiceId}/issue`, {});

    const res = await A.get(`/audit?entityType=invoice&entityId=${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(3);
    /* Most recent first — the endpoint's own ordering. */
    expect(res.body.data.entries[0].action).toBe('UPDATE');
    expect(res.body.data.entries[2].action).toBe('CREATE');
    /* The actor is joined on the way out; the row itself stores only an id. */
    expect(res.body.data.entries[0].actor.fullName).toBe('Inv Audit Owner');

    const fields = (res.body.data.entries[0].changes as { field: string }[]).map((c) => c.field);
    expect(fields).toContain('status');
    expect(fields).toContain('invoiceNumber');
  });

  /**
   * ⚠️ `billing.invoice.read` DOES NOT IMPLY IT, AND THE WIDENING WOULD BE A
   *   §0.7 HOLE RATHER THAN A CONVENIENCE. The audit endpoint keys on
   *   `(entityType, entityId)` and knows nothing about an invoice's SOURCE, so
   *   adding `invoice` to `HISTORY_ALSO_READABLE_BY` would hand this cashier the
   *   trail of a LAB invoice the ledger correctly refuses to show them — and
   *   `loadVisible`'s 404 exists precisely so they cannot learn that the id is a
   *   lab invoice at all.
   */
  it('refuses the desk cashier who may raise the bill but not audit it', async () => {
    const invoiceId = await draft();

    const res = await Desk.get(`/audit?entityType=invoice&entityId=${invoiceId}`);
    expect(res.status).toBe(403);
  });
});

/**
 * ⚠️ THE SWEEP. Every audit row this organization has, not only the invoice
 *   ones: the point of an allow-list is that it holds for entity types nobody
 *   thought to check, and `tax_rule` and `issuer_tax_registration` have been
 *   writing rows since Phase 9 with no screen reading them back.
 */
describe('⚠️ no PHI reaches the audit trail', () => {
  it('greps every audit row written by this suite for the customer’s details', async () => {
    /* A rate card write, so the tax entity types are in the sweep's scope. */
    const rule = await A.post('/tax/rules', {
      countryCode: 'IN',
      scheme: 'GST',
      taxCategory: 'PROCEDURE',
      rateBps: 500,
      treatment: 'STANDARD',
      lineName: 'GST',
      split: 'INTRA_STATE_HALVES',
      effectiveFrom: '2026-04-01',
      description: `Charged for ${CUSTOMER}`,
    });
    expect(rule.status).toBe(201);

    const needles = [
      CUSTOMER,
      'Meenakshi',
      'Varadarajan',
      CUSTOMER_PHONE,
      CUSTOMER_ADDRESS,
      'Indiranagar',
      LINE_DESCRIPTION,
      'obstetric',
      VOID_REASON,
      'Opened by mistake',
    ];

    const rows = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE organization_id = $1
          AND (before_data::text ILIKE ANY($2) OR after_data::text ILIKE ANY($2))`,
      [org.organizationId, needles.map((n) => `%${n}%`)]
    );

    /*
     * ⚠️ NOT ZERO, AND THE ONE HIT IS THE POINT OF INCLUDING IT. A tax rule's
     *   `description` is a field a clinic writes about its own rate card and the
     *   service records it verbatim — correctly, because who renamed a rate is
     *   the question that screen's trail exists to answer. Typing a patient's
     *   name into it puts that name on an audit row, and no allow-list can stop
     *   a user doing that to a free-text field whose contents ARE the record.
     *   Asserted rather than fixed: the alternative is a rate card whose trail
     *   cannot say what changed. Every other needle — the customer block, the
     *   line description, the void reason — must be absent.
     */
    expect(rows.rows[0]?.n).toBe(1);

    const invoiceRows = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE organization_id = $1
          AND entity_type IN ('invoice', 'issuer_tax_registration')
          AND (before_data::text ILIKE ANY($2) OR after_data::text ILIKE ANY($2))`,
      [org.organizationId, needles.map((n) => `%${n}%`)]
    );

    expect(invoiceRows.rows[0]?.n).toBe(0);
  });

  it('writes no data_access_logs row for reading a trail', async () => {
    const invoiceId = await draft();
    await A.get(`/audit?entityType=invoice&entityId=${invoiceId}`);

    /*
     * The history drawer is not a disclosure: it returns ids, statuses and
     * money, and the one thing on it that names a person is the STAFF member who
     * acted. A row here would file every manager's reconciliation as a read of a
     * patient's chart.
     */
    const rows = await owner.query(
      `SELECT 1 FROM data_access_logs
        WHERE organization_id = $1 AND route = 'GET /v1/audit'`,
      [org.organizationId]
    );

    expect(rows.rowCount).toBe(0);
  });
});
