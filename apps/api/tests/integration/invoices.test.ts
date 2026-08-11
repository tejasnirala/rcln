/**
 * The invoice API over real HTTP, through the real middleware chain.
 *
 * Six things are being pinned down, and none of them is "CRUD works":
 *
 *   1. THE VISIBILITY RULE IS APPLIED IN THE QUERY AND NOT IN A FILTER THE
 *      CALLER PASSES. A caller who may not see pharmacy invoices does not see
 *      them in the list, does not get one by id, and — the case that actually
 *      matters — does not get them all back by asking for `?sourceType=PHARMACY`
 *      himself. All three are asserted against the SAME invoice, so a rule
 *      applied at one of the three doors and not the others fails here.
 *   2. A DRAFT IS PRICED THE MOMENT IT EXISTS, INCLUDING ITS WHOLE-BILL
 *      DISCOUNT. That discount was stored and not applied until this phase, and
 *      the symptom was invisible: finalisation re-prices, so every ISSUED
 *      invoice was right and only the figure the cashier decided from was wrong.
 *   3. ISSUING IS THE ONE DOOR, and what comes back through it is a number in
 *      the branch's series, a frozen document, and a 409 on any further edit.
 *   4. THE UNRATED REFUSAL REACHES THE CLIENT as a 409 naming the line, rather
 *      than as an invoice that under-collects tax the clinic still owes.
 *   5. VOID IS NOT CANCEL. Only a draft cancels, only an issued document voids,
 *      the number survives it, and a void with no reason is refused.
 *   6. NO PHI REACHES `data_access_logs`. Measured, not asserted in prose: every
 *      row this suite writes is grepped for the customer's name, and the detail
 *      read is asserted to have written one at all — a read with no evidence is
 *      the failure the table exists to prevent.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { disconnectJobProducer } from '../../src/queue/producer.js';
/*
 * The store is configured at BOOT, in `src/index.ts` — not by `createApp()` —
 * so a test process that only builds the app has none, and the PDF route fails
 * as an unexplained 500 rather than as anything to do with invoices. Measured:
 * that is exactly what the end-to-end check of this phase hit first.
 */
import { initDocumentStore } from '../../src/services/document/store.js';
import { sender } from '../../src/services/notification/sender.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG_A = `inv-a-${SUFFIX}`;
const SLUG_B = `inv-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/** Inside FY 2026-27, so every number in this suite reads `INV-2026-`. */
const SUPPLIED_ON = '2026-08-11';

/** Distinctive enough that finding it in a log row is unambiguous. */
const CUSTOMER = 'Meenakshi Varadarajan';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };

let ownerToken = '';
let bToken = '';
let deskToken = '';
let pharmacistToken = '';
let auditorToken = '';
let doctorToken = '';

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

/** The read-dedupe key, so a repeated detail read really does write a row. */
async function clearAccessDedupe(): Promise<void> {
  const keys = await redis.keys('dal:*');
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

const A = asUser(SLUG_A, () => ownerToken);
const B = asUser(SLUG_B, () => bToken);
const Desk = asUser(SLUG_A, () => deskToken);
const Doc = asUser(SLUG_A, () => doctorToken);
const Pharmacist = asUser(SLUG_A, () => pharmacistToken);
const Auditor = asUser(SLUG_A, () => auditorToken);

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
  const invited = await A.post('/invitations', {
    email,
    roleId,
    branchIds: [orgA.branchId],
  });
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

async function roleIdFor(code: string): Promise<string> {
  const res = await A.get('/roles');
  const role = (res.body.data.roles as { id: string; code: string }[]).find((r) => r.code === code);
  if (!role) throw new Error(`role ${code} is not visible — did the seed run?`);
  return role.id;
}

const DESK_EMAIL = `desk-${SUFFIX}@example.test`;
const PHARMACIST_EMAIL = `pharma-${SUFFIX}@example.test`;
const AUDITOR_EMAIL = `auditor-${SUFFIX}@example.test`;
const DOCTOR_EMAIL = `doctor-${SUFFIX}@example.test`;
/** A DOCTOR-role member with no `doctor_profiles` row — the PMCH case. */
const STRAY_DOCTOR_EMAIL = `stray-doc-${SUFFIX}@example.test`;

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

  orgA = await registerOrganization(payload(SLUG_A, 'Inv A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Inv B'));

  ownerToken = await login(SLUG_A, `${SLUG_A}@example.test`, PASSWORD);
  bToken = await login(SLUG_B, `${SLUG_B}@example.test`, PASSWORD);

  /*
   * The branch's jurisdiction, and a registration that covers it. Without both,
   * finalisation refuses every invoice — `assertRegistrationCoversBranch` is
   * what stops a Karnataka bill being issued under another state's GSTIN.
   */
  await owner.query(
    `UPDATE branches
        SET country_code = 'IN', region_code = 'KA',
            address_line1 = '418, 12th Main Road', city = 'Bengaluru',
            state = 'Karnataka', pincode = '560008', phone = '+918041238890'
      WHERE id = ANY($1)`,
    [[orgA.branchId, orgB.branchId]]
  );

  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', 'Inv A Pvt Ltd', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'KA', 'GST', '29BBBBB2222B1ZB', 'Inv B Pvt Ltd', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
  );

  /*
   * MEDICINE is rated, MYSTERY deliberately is not — an UNRATED line is what
   * makes an invoice unissuable, and there has to be a way to produce one.
   */
  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE',     1200, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION',    0, 'EXEMPT',   'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'GST', 'MEDICINE',     1200, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
  );

  /*
   * The front desk: the invoice surface and nothing else. No system role is
   * shaped like this — RECEPTIONIST also holds `patient.read` and the vitals
   * codes — and the narrow one is what proves the source set is DERIVED rather
   * than granted: this role holds no module read code at all.
   */
  const deskRole = await A.post('/roles', {
    code: 'DESK_BILLING',
    name: 'Desk billing',
    scopeLevel: 'BRANCH',
    permissionCodes: ['billing.invoice.read', 'billing.invoice.create'],
  });
  if (deskRole.status !== 201) {
    throw new Error(`could not create the desk role: ${JSON.stringify(deskRole.body)}`);
  }

  deskToken = await joinAs(DESK_EMAIL, 'Desk Clerk', deskRole.body.data.id as string);

  /*
   * The same role plus the one escape hatch, and still no module code. This is
   * the only caller in the suite for whom `billing.invoice.read_all` is what
   * makes a pharmacy invoice visible — the owner would see it through
   * `pharmacy.dispense.read` with the escape removed entirely.
   */
  const auditorRole = await A.post('/roles', {
    code: 'LEDGER_AUDIT',
    name: 'Ledger audit',
    scopeLevel: 'BRANCH',
    permissionCodes: ['billing.invoice.read', 'billing.invoice.read_all'],
  });
  if (auditorRole.status !== 201) {
    throw new Error(`could not create the auditor role: ${JSON.stringify(auditorRole.body)}`);
  }
  auditorToken = await joinAs(AUDITOR_EMAIL, 'Ledger Auditor', auditorRole.body.data.id as string);
  pharmacistToken = await joinAs(PHARMACIST_EMAIL, 'Pharma Cist', await roleIdFor('PHARMACIST'));
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);

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

// ---------------------------------------------------------------------------

const line = (
  description: string,
  taxCategory: string,
  unitPriceMinor: number,
  quantity = '1'
) => ({
  description,
  taxCategory,
  unitPriceMinor,
  quantity,
});

interface DraftOptions {
  sourceType?: string;
  lines?: ReturnType<typeof line>[];
  discount?: object;
  patientId?: string | null;
}

async function draft(
  client: typeof A,
  branchId: string,
  options: DraftOptions = {}
): Promise<Record<string, unknown>> {
  const res = await client.post('/invoices', {
    branchId,
    sourceType: options.sourceType ?? 'OTHER',
    customer: { name: CUSTOMER, phone: '+919845011223' },
    suppliedOn: SUPPLIED_ON,
    lines: options.lines ?? [line('Paracetamol 500mg', 'MEDICINE', 10_000, '10')],
    ...(options.discount ? { discount: options.discount } : {}),
    ...(options.patientId ? { patientId: options.patientId } : {}),
  });

  if (res.status !== 201) {
    throw new Error(`could not open a draft: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('opening a draft', () => {
  it('prices it the moment it exists — tax and totals, not zeroes', async () => {
    const invoice = await draft(A, orgA.branchId);

    // 10 × ₹100 = ₹1,000, +12% GST = ₹1,120.
    expect(invoice['subtotalMinor']).toBe(100_000);
    expect(invoice['taxTotalMinor']).toBe(12_000);
    expect(invoice['grandTotalMinor']).toBe(112_000);
    expect(invoice['balanceDueMinor']).toBe(112_000);
    expect(invoice['status']).toBe('DRAFT');
    /* No number until it is issued — that is the whole of `invoices_number_matches_status`. */
    expect(invoice['invoiceNumber']).toBeNull();
  });

  /**
   * ⚠️ THE REGRESSION THIS PHASE FOUND. `createDraftInvoice` wrote the discount
   *   columns and did not pass the discount to the engine, so the draft came
   *   back with it recorded and none of it applied. Finalisation re-prices, so
   *   the issued document was always right — only the number the cashier was
   *   looking at while deciding was wrong.
   */
  it('applies a whole-bill discount to the draft, not only to the issued invoice', async () => {
    const invoice = await draft(A, orgA.branchId, {
      discount: { type: 'PERCENTAGE', bps: 1000 },
    });

    // ₹1,000 less 10% = ₹900 taxable, +12% = ₹1,008.
    expect(invoice['invoiceDiscountTotalMinor']).toBe(10_000);
    expect(invoice['taxableAmountMinor']).toBe(90_000);
    expect(invoice['grandTotalMinor']).toBe(100_800);
    expect(invoice['discount']).toEqual({ type: 'PERCENTAGE', bps: 1000 });
  });

  it('splits GST into two rows owed to two governments', async () => {
    const invoice = await draft(A, orgA.branchId);
    const taxes = invoice['taxes'] as { name: string; rateBps: number; amountMinor: number }[];

    expect(taxes).toHaveLength(2);
    expect(taxes.map((t) => t.name).sort()).toEqual(['CGST', 'SGST']);
    /* Two 6% halves, never one 12% row — that would state a tax nobody levies. */
    expect(taxes.every((t) => t.rateBps === 600 && t.amountMinor === 6_000)).toBe(true);
  });

  it('refuses an APPOINTMENT invoice that cites no appointment', async () => {
    const res = await A.post('/invoices', {
      branchId: orgA.branchId,
      sourceType: 'APPOINTMENT',
      customer: { name: CUSTOMER },
      suppliedOn: SUPPLIED_ON,
      lines: [line('Consultation', 'CONSULTATION', 50_000)],
    });

    expect(res.status).toBe(400);
  });
});

describe('editing a draft', () => {
  it('replaces the lines and re-prices the whole document', async () => {
    const invoice = await draft(A, orgA.branchId);

    const res = await A.put(`/invoices/${String(invoice['id'])}`, {
      customer: { name: CUSTOMER },
      suppliedOn: SUPPLIED_ON,
      lines: [line('Consultation', 'CONSULTATION', 50_000), line('Syrup', 'MEDICINE', 20_000)],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    /* Only the medicine is taxed; the consultation is exempt. */
    expect(res.body.data.taxTotalMinor).toBe(2_400);
    expect(res.body.data.grandTotalMinor).toBe(72_400);
  });

  /**
   * ⚠️ A DRAFT'S CURRENCY IS THE DRAFT'S, NOT THE ORGANIZATION'S. The prices in
   *   a PUT that omits `currency` have to be built in the currency the invoice
   *   was opened in — building them in the org default refuses a perfectly valid
   *   edit with a mismatch raised from inside the pricing engine, and only for
   *   invoices that are not in the house currency.
   */
  it('edits an invoice raised in another currency without being told which', async () => {
    const created = await A.post('/invoices', {
      branchId: orgA.branchId,
      sourceType: 'OTHER',
      customer: { name: 'Overseas Patient' },
      suppliedOn: SUPPLIED_ON,
      currency: 'USD',
      lines: [line('Consultation', 'CONSULTATION', 5_000)],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.currency).toBe('USD');

    const res = await A.put(`/invoices/${String(created.body.data.id)}`, {
      customer: { name: 'Overseas Patient' },
      suppliedOn: SUPPLIED_ON,
      lines: [line('Consultation', 'CONSULTATION', 7_500)],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('USD');
    expect(res.body.data.grandTotalMinor).toBe(7_500);
  });
});

describe('issuing', () => {
  it('takes a number in the branch series and freezes the document', async () => {
    const invoice = await draft(A, orgA.branchId);

    const issued = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });

    expect(issued.status).toBe(200);
    expect(issued.body.data.status).toBe('ISSUED');
    /*
     * The branch code is IN the number. Two branches under one GSTIN both
     * starting at 000001 would repeat a number, which GST does not permit.
     */
    expect(issued.body.data.invoiceNumber).toMatch(/^INV-2026-OTH-MAIN-\d{6}$/);
    expect(issued.body.data.issuerTaxId).toBe('29AAACR1234K1ZP');
    expect(issued.body.data.placeOfSupply).toBe('IN-KA');
  });

  it('refuses to edit it afterwards', async () => {
    const invoice = await draft(A, orgA.branchId);
    await A.post(`/invoices/${String(invoice['id'])}/issue`, { issuedOn: SUPPLIED_ON });

    const res = await A.put(`/invoices/${String(invoice['id'])}`, {
      customer: { name: 'Someone Else' },
      suppliedOn: SUPPLIED_ON,
      lines: [line('Paracetamol 500mg', 'MEDICINE', 1, '1')],
    });

    expect(res.status).toBe(409);
  });

  /**
   * ⚠️ AN UNRATED LINE IS A CATEGORY THE CLINIC NEVER GAVE A RATE FOR. The
   *   engine charged nothing rather than guessing, and issuing that is a bill
   *   that under-collects tax the clinic still owes.
   */
  it('refuses an invoice with a line it has no rate for', async () => {
    const invoice = await draft(A, orgA.branchId, {
      lines: [line('Something nobody priced', 'MYSTERY', 10_000)],
    });

    expect(invoice['issuable']).toBe(false);
    expect((invoice['unissuableReasons'] as string[]).length).toBeGreaterThan(0);

    const res = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });
    expect(res.status).toBe(409);
  });
});

describe('cancel and void', () => {
  it('cancels a draft, and refuses to cancel an issued document', async () => {
    const first = await draft(A, orgA.branchId);
    const cancelled = await A.post(`/invoices/${String(first['id'])}/cancel`, {
      reason: 'Patient left',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const second = await draft(A, orgA.branchId);
    await A.post(`/invoices/${String(second['id'])}/issue`, { issuedOn: SUPPLIED_ON });
    const refused = await A.post(`/invoices/${String(second['id'])}/cancel`, {});
    expect(refused.status).toBe(409);
  });

  it('voids an issued document and keeps its number', async () => {
    const invoice = await draft(A, orgA.branchId);
    const issued = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });
    const number = issued.body.data.invoiceNumber as string;

    const voided = await A.post(`/invoices/${String(invoice['id'])}/void`, {
      reason: 'Billed to the wrong patient',
    });

    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    /* The number survives — a deleted one is a hole no reprint can fill. */
    expect(voided.body.data.invoiceNumber).toBe(number);
  });

  it('refuses a void with no reason', async () => {
    const invoice = await draft(A, orgA.branchId);
    await A.post(`/invoices/${String(invoice['id'])}/issue`, { issuedOn: SUPPLIED_ON });

    const res = await A.post(`/invoices/${String(invoice['id'])}/void`, { reason: '' });
    expect(res.status).toBe(400);
  });

  it('refuses to void a draft — there is nothing to reverse', async () => {
    const invoice = await draft(A, orgA.branchId);
    const res = await A.post(`/invoices/${String(invoice['id'])}/void`, { reason: 'Mistake' });
    expect(res.status).toBe(409);
  });
});

describe('who sees which invoices', () => {
  let pharmacyInvoiceId = '';

  beforeAll(async () => {
    const invoice = await draft(A, orgA.branchId, { sourceType: 'PHARMACY' });
    pharmacyInvoiceId = String(invoice['id']);
  });

  it('keeps a pharmacy invoice out of a desk clerk’s list', async () => {
    const res = await Desk.get('/invoices?limit=100');

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(pharmacyInvoiceId);
    /* The general sources are still theirs — the rule narrows, it does not refuse. */
    expect(ids.length).toBeGreaterThan(0);
  });

  it('answers 404, not 403, when they ask for it by id', async () => {
    const res = await Desk.get(`/invoices/${pharmacyInvoiceId}`);
    expect(res.status).toBe(404);
  });

  /**
   * ⚠️ THE CASE THE WHOLE RULE EXISTS FOR. A filter the caller controls is not a
   *   boundary: if the source set were a default rather than an intersection,
   *   this request would return every pharmacy invoice in the clinic.
   */
  it('returns nothing when they filter for the source they may not see', async () => {
    const res = await Desk.get('/invoices?sourceType=PHARMACY&limit=100');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('shows it to the pharmacist, who holds no invoice code beyond read', async () => {
    const res = await Pharmacist.get(`/invoices/${pharmacyInvoiceId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sourceType).toBe('PHARMACY');
  });

  /**
   * ⚠️ THE OWNER IS NOT THE TEST OF `read_all`, AND ASSUMING IT WAS WOULD HAVE
   *   BEEN WRONG. ORG_OWNER is "everything except", so it holds
   *   `pharmacy.dispense.read` and would see this invoice through the MODULE
   *   rule with the escape hatch removed entirely. Measured: this case passed
   *   before the code existed in the database at all. The auditor below is the
   *   real proof — `billing.invoice.read` plus `read_all` and not one module
   *   code between them.
   */
  it('shows it to the owner, who holds every module besides', async () => {
    const res = await A.get(`/invoices/${pharmacyInvoiceId}`);
    expect(res.status).toBe(200);
  });

  it('shows it to a ledger-wide reader holding no module code at all', async () => {
    const res = await Auditor.get(`/invoices/${pharmacyInvoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sourceType).toBe('PHARMACY');

    const list = await Auditor.get('/invoices?sourceType=PHARMACY&limit=100');
    expect((list.body.data as { id: string }[]).map((i) => i.id)).toContain(pharmacyInvoiceId);
  });

  it('hides it from the other clinic entirely', async () => {
    const res = await B.get(`/invoices/${pharmacyInvoiceId}`);
    expect(res.status).toBe(404);
  });
});

/**
 * A clinician sees the invoices for the care THEY gave, and no others.
 *
 * ⚠️ THE SECOND AXIS OF `invoice-visibility.ts`, AND THE ONE THAT IS ABOUT A
 *   PERSON RATHER THAN A MODULE. A doctor holds `billing.invoice.read` and not
 *   `.read_all`, so before this they saw every consultation in the clinic —
 *   including their colleagues' — which is a disclosure nobody granted.
 *
 * ⚠️ AND THE ID IS 404, NOT 403. Same rule as the source scope: a 403 on an
 *   invoice id confirms the invoice exists, and whose it is is not this
 *   caller's business either way.
 */
describe('a doctor sees only their own invoices', () => {
  let mineId = '';
  let theirsId = '';

  beforeAll(async () => {
    doctorToken = await joinAs(DOCTOR_EMAIL, 'Aman Verma', await roleIdFor('DOCTOR'));

    const user = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      DOCTOR_EMAIL,
    ]);
    const doctorUserId = user.rows[0]?.id;
    if (doctorUserId === undefined) throw new Error('the doctor member was not created');

    /*
     * Two profiles: the caller's, and a colleague's. The colleague needs no
     * login — an invoice attributed to somebody else is the whole test.
     */
    const profiles = await owner.query<{ id: string }>(
      /*
       * Distinct registration numbers, because `(organization_id,
       * registration_number)` is unique NULLS NOT DISTINCT — two profiles
       * without one collide, which is the constraint doing its job.
       */
      `INSERT INTO doctor_profiles
         (id, organization_id, user_id, registration_number, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $4, now()),
              (gen_random_uuid(), $1, $3, $5, now())
       RETURNING id`,
      [
        orgA.organizationId,
        doctorUserId,
        orgA.ownerUserId,
        `REG-MINE-${SUFFIX}`,
        `REG-THEIRS-${SUFFIX}`,
      ]
    );
    const mineProfile = profiles.rows[0]?.id;
    const theirsProfile = profiles.rows[1]?.id;

    const mine = await draft(A, orgA.branchId);
    const theirs = await draft(A, orgA.branchId);
    mineId = String(mine['id']);
    theirsId = String(theirs['id']);

    await owner.query('UPDATE invoices SET practitioner_profile_id = $1 WHERE id = $2', [
      mineProfile,
      mineId,
    ]);
    await owner.query('UPDATE invoices SET practitioner_profile_id = $1 WHERE id = $2', [
      theirsProfile,
      theirsId,
    ]);
  }, 60_000);

  it('lists the invoices they attended and none of a colleague’s', async () => {
    const res = await Doc.get('/invoices?limit=100');

    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(theirsId);
  });

  it('hides every unattributed invoice too, because none of them is theirs', async () => {
    /*
     * The counter sales this suite opens carry no practitioner. A scope that let
     * them through would be "your invoices, plus everything nobody claimed".
     */
    const res = await Doc.get('/invoices?limit=100');
    const rows = res.body.data as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(mineId);
  });

  it('answers 404 for a colleague’s invoice asked for by id', async () => {
    expect((await Doc.get(`/invoices/${theirsId}`)).status).toBe(404);
    // And still 200 for their own, so the scope narrows rather than refusing.
    expect((await Doc.get(`/invoices/${mineId}`)).status).toBe(200);
  });

  it('cannot widen the scope with a filter it controls', async () => {
    /*
     * ⚠️ THE FILTER INTERSECTS THE VISIBLE SET AND NEVER REPLACES IT. A caller
     *   who names their colleague's patient, branch or invoice number still gets
     *   only their own rows back.
     */
    const byNumber = await Doc.get(`/invoices?branchId=${orgA.branchId}&limit=100`);
    const ids = (byNumber.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain(theirsId);
  });

  /*
   * ⚠️ THE CASE THAT WAS FOUND ON REAL DATA, AND IT FAILED OPEN. A member with
   *   the DOCTOR role and no `doctor_profiles` row resolved to "not scoped" and
   *   read every consultation in the clinic — a colleague's included. Being a
   *   clinician is now a permission question (`clinical.prescription.sign`,
   *   DOCTOR-only by invariant 7), so the missing profile narrows to nothing
   *   instead of widening to everything.
   */
  it('shows a doctor with no profile nothing at all, rather than everything', async () => {
    const strayToken = await joinAs(STRAY_DOCTOR_EMAIL, 'Aman Verma', await roleIdFor('DOCTOR'));
    const Stray = asUser(SLUG_A, () => strayToken);

    const res = await Stray.get('/invoices?limit=100');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // Not even a colleague's, by id.
    expect((await Stray.get(`/invoices/${theirsId}`)).status).toBe(404);
  }, 60_000);

  it('still shows the whole ledger to a caller holding read_all', async () => {
    const res = await A.get('/invoices?limit=100');
    const ids = (res.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(mineId);
    expect(ids).toContain(theirsId);
  });
});

describe('the list', () => {
  it('paginates, and reports a total that is not the page size', async () => {
    const res = await A.get('/invoices?limit=2&page=1');

    expect(res.status).toBe(200);
    expect((res.body.data as unknown[]).length).toBeLessThanOrEqual(2);
    expect(res.body.meta.total).toBeGreaterThan(2);
    expect(res.body.meta.totalPages).toBeGreaterThan(1);
  });

  it('filters by status and by invoice number, whole or partial', async () => {
    const invoice = await draft(A, orgA.branchId);
    const issued = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });
    const number = issued.body.data.invoiceNumber as string;

    const byNumber = await A.get(`/invoices?invoiceNumber=${number}`);
    expect(byNumber.body.data).toHaveLength(1);
    expect(byNumber.body.data[0].id).toBe(invoice['id']);

    /*
     * ⚠️ THE FRAGMENT IS THE POINT. Somebody reading a number off a printed bill
     *   types the digits that distinguish it, not the whole `INV-2026-APP-MAIN-`
     *   prefix. This used to be an exact match and answered "no invoices" to
     *   every one of those — a blank ledger being indistinguishable, on screen,
     *   from a clinic that has billed nothing.
     */
    const tail = number.slice(-4);
    const byFragment = await A.get(`/invoices?invoiceNumber=${tail}`);
    expect((byFragment.body.data as { id: string }[]).map((row) => row.id)).toContain(
      invoice['id']
    );

    // Case-insensitive, because the prefix is upper case and nobody types it so.
    const lower = await A.get(`/invoices?invoiceNumber=${number.toLowerCase()}`);
    expect((lower.body.data as { id: string }[]).map((row) => row.id)).toContain(invoice['id']);

    const drafts = await A.get('/invoices?status=DRAFT&limit=100');
    expect((drafts.body.data as { status: string }[]).every((i) => i.status === 'DRAFT')).toBe(
      true
    );
  });

  /** A draft has no issue date, and would vanish from every range if the filter used one column. */
  it('finds a draft by date, not only an issued invoice', async () => {
    const invoice = await draft(A, orgA.branchId);

    /*
     * ⚠️ "TODAY" IS TODAY IN THE BRANCH'S ZONE, NOT IN UTC, AND THE DIFFERENCE
     *   IS A REAL FAILURE THIS TEST USED TO HAVE. `?from=&to=` are calendar
     *   dates, and the service converts both bounds using `branches.timezone`
     *   when a branch is named (invoice.service.ts — "converted from the
     *   branch's zone when a branch is named"). This line was
     *   `new Date().toISOString().slice(0, 10)`, which is the UTC date.
     *
     *   The fixture branch is Asia/Kolkata, +05:30. So for the 5½ hours after
     *   18:30 UTC the UTC date is still yesterday while the branch is already
     *   on tomorrow: the test asked for yesterday-in-Kolkata, which ends at
     *   18:29:59Z, and the draft it had just created was stamped after that.
     *   The test failed every night between 18:30 and 24:00 UTC and passed the
     *   other 18½ hours — which is exactly how it survived, since CI rarely
     *   runs in that window.
     *
     *   This is invariant 6 in the test suite: compute in the clinic's zone,
     *   never the container's. `en-CA` is used only because it formats as
     *   YYYY-MM-DD, which is the shape the query string wants.
     */
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const res = await A.get(
      `/invoices?branchId=${orgA.branchId}&from=${today}&to=${today}&limit=100`
    );
    const ids = (res.body.data as { id: string }[]).map((i) => i.id);

    expect(ids).toContain(invoice['id']);
  });
});

describe('the document', () => {
  it('returns the same value the worker renders the PDF from', async () => {
    const invoice = await draft(A, orgA.branchId);
    const issued = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });

    const res = await A.get(`/invoices/${String(invoice['id'])}/document`);

    expect(res.status).toBe(200);
    expect(res.body.data.invoiceNumber).toBe(issued.body.data.invoiceNumber);
    expect(res.body.data.issuer.taxId).toBe('29AAACR1234K1ZP');
    /*
     * The zone and the country travel WITH the document, because what it calls
     * itself and which day it prints are both derived from them — in three
     * different runtimes, one of which is a headless Chromium in another
     * container.
     */
    expect(res.body.data.timezone).toBe('Asia/Kolkata');
    expect(res.body.data.countryCode).toBe('IN');
    expect(res.body.data.lines).toHaveLength(1);
  });

  /**
   * ⚠️ THE PREVIEW IS RENDERED HERE AND NOT IN THE WEB APP, WHICH THE BUILD
   *   DECIDED. Phase 6 put `renderInvoiceHtml` in a Server Component that nothing
   *   imported; the first screen to import it failed `next build`, because Next
   *   declines `react-dom/server` in a Server Component's module graph and in an
   *   App Route's alike. So the render moved to the service that owns the data,
   *   and the web is now a conduit for both representations of the invoice.
   *
   * ⚠️ AND IT IS THE SAME FUNCTION THE WORKER PRINTS WITH, WHICH IS THE POINT.
   *   The number and the registration are asserted in the HTML for exactly that
   *   reason: this and the stored PDF are one document, or Phase 6 bought nothing.
   */
  it('renders the same document as HTML, for the preview frame', async () => {
    const invoice = await draft(A, orgA.branchId);
    const issued = await A.post(`/invoices/${String(invoice['id'])}/issue`, {
      issuedOn: SUPPLIED_ON,
    });

    const res = await A.get(`/invoices/${String(invoice['id'])}/preview`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(String(issued.body.data.invoiceNumber));
    expect(res.text).toContain('29AAACR1234K1ZP');

    /*
     * ⚠️ NO SCRIPT, AND THE HEADERS SAY SO TOO. The frame is sandboxed without
     *   `allow-scripts` and this policy is the third layer — a template that one
     *   day interpolated something unescaped still could not run it.
     */
    expect(res.text).not.toContain('<script');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    // The document names a patient. It must not sit in any cache.
    expect(res.headers['cache-control']).toContain('no-store');
  });

  /** A draft has no PDF and DOES have a preview — that is what the phase was for. */
  it('renders a draft too, which is the whole point of a preview', async () => {
    const invoice = await draft(A, orgA.branchId);

    const res = await A.get(`/invoices/${String(invoice['id'])}/preview`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  /**
   * ⚠️ 409 AND NOT 404, BECAUSE THE TWO ASK THE CLIENT FOR DIFFERENT THINGS. A
   *   404 says stop; this says the document does not exist YET. A draft's answer
   *   is deterministic — it can never have a PDF — where an issued invoice's is a
   *   race with the worker, which is the same reply a moment later.
   */
  it('answers 409 rather than 404 for a draft, which has no PDF by construction', async () => {
    const invoice = await draft(A, orgA.branchId);

    const res = await A.get(`/invoices/${String(invoice['id'])}/pdf`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no document yet/i);
  });
});

describe('the disclosure trail', () => {
  it('records a detail read of a patient’s invoice, and never their name', async () => {
    const patient = await A.post('/patients', {
      firstName: 'Meenakshi',
      lastName: 'Varadarajan',
      branchId: orgA.branchId,
      gender: 'FEMALE',
    });
    const patientId = patient.body.data.id as string;

    const invoice = await draft(A, orgA.branchId, { patientId });
    await clearAccessDedupe();
    await A.get(`/invoices/${String(invoice['id'])}`);

    const rows = await owner.query<{ route: string; resource: string; access_type: string }>(
      `SELECT route, resource, access_type
         FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'INVOICE' AND resource_id = $2`,
      [orgA.organizationId, invoice['id']]
    );

    /* A read with no evidence is the failure this table exists to prevent. */
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.access_type).toBe('VIEW');
    /* The PATTERN, never the resolved URL. */
    expect(rows.rows[0]?.route).toBe('GET /v1/invoices/:invoiceId');
  });

  /**
   * ⚠️ THE CREATE'S OWN READ-BACK MUST NOT LOG. Every write answers with the
   *   priced document, and filing that echo as a disclosure would fill the table
   *   with cashiers reading their own work — the noise that makes the rows which
   *   matter impossible to find. A creation is a write, and `audit_logs` has it.
   */
  it('files nothing for the read-back a write answers with', async () => {
    const patient = await A.post('/patients', {
      firstName: 'Anantha',
      lastName: 'Krishnan',
      branchId: orgA.branchId,
      gender: 'MALE',
    });
    const patientId = patient.body.data.id as string;

    const invoice = await draft(A, orgA.branchId, { patientId });

    const rows = await owner.query(
      `SELECT 1 FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'INVOICE' AND resource_id = $2`,
      [orgA.organizationId, invoice['id']]
    );

    expect(rows.rowCount).toBe(0);
  });

  it('puts no customer name anywhere in the trail', async () => {
    const all = await owner.query<{ row: string }>(
      `SELECT d::text AS row FROM data_access_logs d WHERE organization_id = $1`,
      [orgA.organizationId]
    );

    for (const { row } of all.rows) {
      expect(row).not.toContain('Meenakshi');
      expect(row).not.toContain('Varadarajan');
    }
  });
});
