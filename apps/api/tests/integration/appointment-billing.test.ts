/**
 * Billing a consultation, over real HTTP, through the real middleware chain.
 *
 * Six things are being pinned down, and none of them is "the endpoint returns
 * 201":
 *
 *   1. THE FEE COMES OFF THE RATE CARD AND NOBODY RETYPES IT. That is the whole
 *      phase: `doctor_branch_settings` has existed since the doctors phase with
 *      nothing reading it, and this is the code that reads it.
 *   2. THE DATE OF SUPPLY IS THE DAY OF THE VISIT, NOT TODAY. Asserted against a
 *      visit deliberately booked in a different year from the day the suite
 *      runs, because `now()` would pass every other assertion here.
 *   3. "ALREADY BILLED?" IS A QUESTION ABOUT THE LIVE INVOICE. Billed once is a
 *      409; cancelled and voided invoices leave the visit billable again and
 *      stay in its history. This is why `invoices.appointment_id` is not unique,
 *      and it is the single most likely thing for a later change to "fix".
 *   4. THE FREE-REVIEW WINDOW IS A CHARGE OF ZERO, NOT AN ABSENT ONE, and a
 *      review outside it costs the follow-up fee.
 *   5. AN UNCONFIGURED RATE CARD REFUSES RATHER THAN BILLING ZERO, and the
 *      override is the way through.
 *   6. THE DAY BOARD'S BILLING COLUMN IS BEHIND `billing.invoice.read`, and for
 *      a caller without it the field is ABSENT rather than null — a doctor shown
 *      null on every row would read the board as "nothing has been billed".
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

const SUFFIX = `ab${Date.now().toString(36)}`;
const SLUG = `apb-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';
const MEMBER_PASSWORD = 'TinyElephant4Marble';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/**
 * Mondays, which is the only day the seeded doctor consults on, and far enough
 * ahead that "is this slot in the past?" never depends on when the suite runs.
 *
 * ⚠️ THE YEAR IS THE POINT. Every visit here falls in 2027 and the suite runs in
 *   whatever year it runs in, so a `suppliedOn` of "today" cannot pass by
 *   coincidence.
 */
const FIRST_VISIT = '2027-03-01T03:30:00.000Z'; //  1 March, 09:00 IST
const FOLLOW_UP_PARENT = '2027-03-01T04:00:00.000Z'; //  1 March, 09:30 IST
const REVIEW_INSIDE = '2027-03-08T03:30:00.000Z'; //  8 March — 7 days later
const REVIEW_OUTSIDE = '2027-03-22T03:30:00.000Z'; // 22 March — 21 days later
const BILLED_VISIT = '2027-03-15T03:30:00.000Z';
const UNPRICED_VISIT = '2027-03-29T03:30:00.000Z';
const CANCELLED_VISIT = '2027-04-05T03:30:00.000Z';
const BOARD_VISIT = '2027-04-12T03:30:00.000Z';
const BOARD_DAY = '2027-04-12';

const FIRST_VISIT_DAY = '2027-03-01';
const REVIEW_INSIDE_DAY = '2027-03-08';

/** ₹500 and ₹200, in the minor units every amount crosses the wire in. */
const CONSULTATION_MINOR = 50_000;
const FOLLOW_UP_MINOR = 20_000;
const FREE_DAYS = 10;

const SUBJECT = { firstName: 'Meenakshi', lastName: 'Varadarajan' };

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ownerToken = '';
let boardToken = '';
let doctorProfileId = '';
let patientId = '';
let doctorName = '';

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

const asUser = (token: () => string) => {
  const auth = (r: request.Test): request.Test =>
    r.set('Host', hostFor(SLUG)).set('Authorization', `Bearer ${token()}`);
  return {
    get: (path: string) => auth(request(app).get(`/api/v1${path}`)),
    post: (path: string, body: object = {}) => auth(request(app).post(`/api/v1${path}`)).send(body),
    put: (path: string, body: object = {}) => auth(request(app).put(`/api/v1${path}`)).send(body),
  };
};

const A = asUser(() => ownerToken);
/**
 * Reads the day board and may not read an invoice.
 *
 * ⚠️ NOT THE SEEDED `DOCTOR` ROLE, WHICH HOLDS `billing.invoice.read` — a
 *   clinician does see what the visit cost. A purpose-built role is the only way
 *   to exercise the caller this rule exists for, and the first draft of this
 *   suite used DOCTOR and passed the board assertion for the wrong reason.
 */
const Board = asUser(() => boardToken);

async function login(identifier: string, secret: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier, password: secret });
  if (!res.body.data?.accessToken) {
    throw new Error(`could not sign ${identifier} in: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

async function joinAs(email: string, fullName: string, roleId: string): Promise<string> {
  await clearRateLimits();
  const invited = await A.post('/invitations', {
    email,
    roleId,
    branchIds: [org.branchId],
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
    .set('Host', hostFor(SLUG))
    .send({ token, fullName, password: MEMBER_PASSWORD });
  if (accepted.status !== 201) {
    throw new Error(`could not accept for ${email}: ${JSON.stringify(accepted.body)}`);
  }

  return login(email, MEMBER_PASSWORD);
}

/** Book a visit, or explain why not. */
async function book(startsAt: string): Promise<string> {
  const res = await A.post('/appointments', {
    branchId: org.branchId,
    patientId,
    doctorProfileId,
    startsAt,
  });
  if (res.status !== 201) throw new Error(`could not book: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

const billing = (appointmentId: string) => A.get(`/appointments/${appointmentId}/billing`);
const raise = (appointmentId: string, body: object = {}) =>
  A.post(`/appointments/${appointmentId}/invoice`, body);

const BOARD_EMAIL = `apb-board-${SUFFIX}@example.test`;

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

  org = await registerOrganization(payload(SLUG, 'Apt Bill'));
  ownerToken = await login(`${SLUG}@example.test`, PASSWORD);

  /*
   * The branch's jurisdiction and a registration that covers it. Without both,
   * finalisation refuses every invoice — and one of these tests issues one.
   */
  await owner.query(
    `UPDATE branches
        SET country_code = 'IN', region_code = 'KA',
            address_line1 = '418, 12th Main Road', city = 'Bengaluru',
            state = 'Karnataka', pincode = '560008', phone = '+918041238890'
      WHERE id = $1`,
    [org.branchId]
  );
  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', 'Apt Bill Pvt Ltd', '2025-04-01', now())`,
    [org.organizationId]
  );
  /*
   * A consultation is EXEMPT in India, which is what the platform catalogue
   * says too. Stated as a TENANT rule so the suite does not depend on the seed
   * having run — and it keeps the arithmetic legible: grand total == the fee.
   */
  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION', 0, 'EXEMPT', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [org.organizationId]
  );

  const doctor = await A.post('/doctors', { userId: org.ownerUserId, specialtyIds: [] });
  if (doctor.status !== 201) {
    throw new Error(`could not create the doctor: ${JSON.stringify(doctor.body)}`);
  }
  doctorProfileId = doctor.body.data.id as string;
  doctorName = doctor.body.data.fullName as string;

  await A.post(`/doctors/${doctorProfileId}/schedules`, {
    branchId: org.branchId,
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '13:00',
    validFrom: '2026-01-01',
  });

  /*
   * The prices this whole phase exists to read.
   *
   * ⚠️ TWO CALLS NOW, AND THEY ARE DIFFERENT KINDS OF FACT. The money is the fee
   *   schedule's, per visit type, inherited from a clinic default unless this
   *   doctor overrides it. The free-revisit window stays on the branch setting,
   *   because it is not money — it is how long after a consultation a review
   *   costs nothing.
   */
  const card = await A.put(`/doctors/${doctorProfileId}/fees`, {
    branchId: org.branchId,
    fees: [
      { feeType: 'NEW', amountMinor: 50_000 },
      { feeType: 'FOLLOW_UP', amountMinor: 20_000 },
    ],
  });
  if (card.status !== 200) {
    throw new Error(`could not set the fees: ${JSON.stringify(card.body)}`);
  }

  const window = await A.put(`/doctors/${doctorProfileId}/branch-settings`, {
    branchId: org.branchId,
    followUpFreeDays: FREE_DAYS,
  });
  if (window.status !== 200) {
    throw new Error(`could not set the free-revisit window: ${JSON.stringify(window.body)}`);
  }

  const patient = await A.post('/patients', {
    firstName: SUBJECT.firstName,
    lastName: SUBJECT.lastName,
    branchId: org.branchId,
    gender: 'FEMALE',
    phone: '9845011223',
  });
  if (patient.status !== 201) {
    throw new Error(`could not create the patient: ${JSON.stringify(patient.body)}`);
  }
  patientId = patient.body.data.id as string;

  await A.post(`/patients/${patientId}/addresses`, {
    line1: '12 Cunningham Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560052',
    isPrimary: true,
  });

  /*
   * Every code the day board needs and not one billing code. `doctor.directory.read`
   * is what makes the board show the whole branch rather than this member's own
   * (non-existent) diary — without it the board is empty and the assertion that
   * `liveInvoice` is absent would pass over zero rows.
   */
  const boardRole = await A.post('/roles', {
    code: 'BOARD_ONLY',
    name: 'Board only',
    scopeLevel: 'BRANCH',
    permissionCodes: ['appointment.read', 'doctor.directory.read'],
  });
  if (boardRole.status !== 201) {
    throw new Error(`could not create the board role: ${JSON.stringify(boardRole.body)}`);
  }
  boardToken = await joinAs(BOARD_EMAIL, 'Board Reader', boardRole.body.data.id as string);
}, 90_000);

afterAll(async () => {
  const id = org?.organizationId;

  if (id) {
    const users = await owner?.query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE organization_id = $1',
      [id]
    );
    const userIds = users?.rows.map((r) => r.user_id) ?? [];

    if (userIds.length > 0) {
      await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
    }
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [id]);
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = $1', [id]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [id]);
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

describe('the preview', () => {
  let appointmentId = '';

  beforeAll(async () => {
    appointmentId = await book(FIRST_VISIT);
  });

  it('prices the visit from the doctor rate card', async () => {
    const res = await billing(appointmentId);

    expect(res.status).toBe(200);
    expect(res.body.data.charge).toMatchObject({
      basis: 'CONSULTATION',
      taxCategory: 'CONSULTATION',
      unitPriceMinor: CONSULTATION_MINOR,
    });
    expect(res.body.data.charge.description).toContain(doctorName);
    expect(res.body.data.unpricedReason).toBeNull();
    expect(res.body.data.billable).toBe(true);
    expect(res.body.data.blockedReason).toBeNull();
    expect(res.body.data.liveInvoice).toBeNull();
    expect(res.body.data.history).toEqual([]);
  });

  /**
   * ⚠️ THE ASSERTION THIS SUITE EXISTS FOR. `suppliedOn` selects the
   *   effective-dated tax rule and the registration, so a bill raised today for
   *   a visit on another date must be dated the VISIT. Every other assertion
   *   here would pass with `now()`.
   */
  it('dates the supply on the day of the visit, in the branch zone', async () => {
    const res = await billing(appointmentId);
    expect(res.body.data.suppliedOn).toBe(FIRST_VISIT_DAY);
  });

  it('is not open to a caller who may not read invoices', async () => {
    const res = await Board.get(`/appointments/${appointmentId}/billing`);
    expect(res.status).toBe(403);
  });
});

describe('raising the bill', () => {
  let appointmentId = '';
  let invoiceId = '';

  beforeAll(async () => {
    appointmentId = await book(BILLED_VISIT);
  });

  it('opens a priced draft citing the visit, with the patient as the customer', async () => {
    const res = await raise(appointmentId);

    expect(res.status).toBe(201);
    invoiceId = res.body.data.id as string;

    expect(res.body.data).toMatchObject({
      status: 'DRAFT',
      sourceType: 'APPOINTMENT',
      appointmentId,
      patientId,
      customerName: `${SUBJECT.firstName} ${SUBJECT.lastName}`,
      currency: 'INR',
      /* EXEMPT, so the grand total is the fee and nothing else. */
      grandTotalMinor: CONSULTATION_MINOR,
      taxTotalMinor: 0,
    });
    /* A draft has no number — the series is not burned until it is issued. */
    expect(res.body.data.invoiceNumber).toBeNull();

    /*
     * ⚠️ WHO THE PATIENT SAW, SNAPSHOTTED ONTO THE INVOICE. A consultation bill
     *   that does not name the clinician is a receipt for an unattributed
     *   service — not claimable by the patient, not acceptable to an insurer.
     *   Copied at billing time rather than joined through `appointment_id`, so a
     *   doctor who later leaves or re-registers cannot restate a document that
     *   has already gone out.
     */
    const { rows } = await owner.query<{ practitioner_name: string | null }>(
      'SELECT practitioner_name FROM invoices WHERE id = $1',
      [invoiceId]
    );
    expect(rows[0]?.practitioner_name).toBe(doctorName);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      taxCategory: 'CONSULTATION',
      quantity: '1',
      unitPriceMinor: CONSULTATION_MINOR,
    });
  });

  /**
   * ⚠️ ONE ROW, WRITTEN BY `createDraftInvoice` AND NOT AGAIN BY THIS DOOR. The
   *   appointment path differs from the generic one in what it READS — the rate
   *   card, the visit's day — and not at all in what it writes, so a second
   *   `recordAudit` here would file one creation twice. What makes the two
   *   distinguishable in the trail is the snapshot: `sourceType` and
   *   `appointmentId` say which door it came through.
   *
   *   And the patient is on the invoice, not on the row. The customer block is
   *   this visit's patient by construction — `customerName` above is their real
   *   name — so this is the sharpest place in the suite to check that none of it
   *   reached `audit_logs`.
   */
  it('files exactly one audit row, citing the visit and naming nobody', async () => {
    const rows = await owner.query<{
      action: string;
      after_data: Record<string, unknown> | null;
    }>(
      `SELECT action, after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2`,
      [org.organizationId, invoiceId]
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.action).toBe('CREATE');
    expect(rows.rows[0]?.after_data).toMatchObject({
      sourceType: 'APPOINTMENT',
      appointmentId,
      patientId,
      lineCount: 1,
      grandTotalMinor: CONSULTATION_MINOR,
    });

    const json = JSON.stringify(rows.rows[0]?.after_data);
    expect(json).not.toContain(SUBJECT.firstName);
    expect(json).not.toContain(SUBJECT.lastName);
    expect(json).not.toContain('Cunningham Road');
  });

  it('snapshots the phone and the primary address onto the document', async () => {
    const res = await A.get(`/invoices/${invoiceId}`);
    expect(res.body.data.customerPhone).toBeTruthy();
    expect(res.body.data.customerAddress).toContain('Cunningham Road');
    expect(res.body.data.customerAddress).toContain('560052');
  });

  it('dates the supply on the visit and not on today', async () => {
    const res = await A.get(`/invoices/${invoiceId}`);
    expect((res.body.data.suppliedAt as string).slice(0, 4)).toBe('2027');
  });

  it('refuses a second bill for the same visit', async () => {
    const res = await raise(appointmentId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already/i);
  });

  it('reports the live invoice and blocks the preview', async () => {
    const res = await billing(appointmentId);
    expect(res.body.data.liveInvoice).toMatchObject({
      invoiceId,
      status: 'DRAFT',
      grandTotalMinor: CONSULTATION_MINOR,
      balanceDueMinor: CONSULTATION_MINOR,
    });
    expect(res.body.data.billable).toBe(false);
    expect(res.body.data.blockedReason).toBe('ALREADY_BILLED');
  });

  /**
   * ⚠️ THE REASON `invoices.appointment_id` IS NOT UNIQUE. A cancelled draft
   *   leaves the visit unbilled, and it stays in the history so the second bill
   *   is explicable.
   */
  it('makes the visit billable again once the draft is cancelled, and keeps it in the history', async () => {
    const cancelled = await A.post(`/invoices/${invoiceId}/cancel`, { reason: 'Wrong patient' });
    expect(cancelled.status).toBe(200);

    const res = await billing(appointmentId);
    expect(res.body.data.liveInvoice).toBeNull();
    expect(res.body.data.billable).toBe(true);
    expect(res.body.data.history).toHaveLength(1);
    expect(res.body.data.history[0]).toMatchObject({ invoiceId, status: 'CANCELLED' });

    const again = await raise(appointmentId);
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(invoiceId);

    const after = await billing(appointmentId);
    expect(after.body.data.history).toHaveLength(2);
  });

  /** Same again for a document that was issued and then reversed. */
  it('makes the visit billable again once an issued invoice is voided', async () => {
    const current = await billing(appointmentId);
    const liveId = current.body.data.liveInvoice.invoiceId as string;

    const issued = await A.post(`/invoices/${liveId}/issue`);
    expect(issued.status).toBe(200);
    expect(issued.body.data.invoiceNumber).toMatch(/^INV-\d{4}-APP-MAIN-\d{6}$/);

    const blocked = await raise(appointmentId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain(issued.body.data.invoiceNumber);

    const voided = await A.post(`/invoices/${liveId}/void`, {
      reason: 'Billed to the wrong visit',
    });
    expect(voided.status).toBe(200);
    /* The number survives the void — a series with a hole cannot be explained. */
    expect(voided.body.data.invoiceNumber).toBe(issued.body.data.invoiceNumber);

    const res = await billing(appointmentId);
    expect(res.body.data.liveInvoice).toBeNull();
    expect(res.body.data.billable).toBe(true);
    expect(res.body.data.history).toHaveLength(2);
  });
});

describe('follow-ups', () => {
  let parentId = '';

  beforeAll(async () => {
    parentId = await book(FOLLOW_UP_PARENT);
  });

  /**
   * ⚠️ A CHARGE OF ZERO, NOT AN ABSENT CHARGE. `follow_up_free_days` is an
   *   answer the clinic gave; a doctor with no rate card is a different fact and
   *   leaves `charge` null.
   */
  it('charges nothing for a review inside the free window', async () => {
    const review = await A.post(`/appointments/${parentId}/follow-up`, {
      startsAt: REVIEW_INSIDE,
    });
    expect(review.status).toBe(201);

    const res = await billing(review.body.data.id as string);
    expect(res.body.data.charge).toMatchObject({
      basis: 'FOLLOW_UP_FREE',
      unitPriceMinor: 0,
      freeFollowUpDays: FREE_DAYS,
    });
    expect(res.body.data.suppliedOn).toBe(REVIEW_INSIDE_DAY);
    expect(res.body.data.unpricedReason).toBeNull();
    expect(res.body.data.billable).toBe(true);
  });

  it('charges the follow-up fee for a review outside it', async () => {
    const review = await A.post(`/appointments/${parentId}/follow-up`, {
      startsAt: REVIEW_OUTSIDE,
    });
    expect(review.status).toBe(201);

    const res = await billing(review.body.data.id as string);
    expect(res.body.data.charge).toMatchObject({
      basis: 'FOLLOW_UP',
      unitPriceMinor: FOLLOW_UP_MINOR,
    });
  });
});

/**
 * ⚠️ THE PRICES ARE REMOVED AND PUT BACK AROUND THIS BLOCK, as the owner,
 *   because a clinic retires a price by clearing the box and `PUT /fees` leaves
 *   a fee type it was not sent alone.
 *
 * ⚠️ AND `booked_fee` HAS TO BE CLEARED TOO, WHICH IS THE WHOLE POINT OF THE
 *   FREEZE. The visit below is booked while the grid is still filled in, so it
 *   carries a price of its own and would keep quoting it however empty the grid
 *   becomes. Nulling it is what makes this appointment stand for one booked
 *   before the fee schedule existed — the only case that still resolves live.
 */
describe('a clinic with no fees set', () => {
  let appointmentId = '';

  const clearPrices = async (): Promise<void> => {
    await owner.query('DELETE FROM fee_schedule_entries WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner.query('UPDATE appointments SET booked_fee = NULL WHERE id = $1', [appointmentId]);
  };

  beforeAll(async () => {
    appointmentId = await book(UNPRICED_VISIT);
    await clearPrices();
    await owner.query('DELETE FROM doctor_branch_settings WHERE doctor_profile_id = $1', [
      doctorProfileId,
    ]);
  });

  afterAll(async () => {
    await A.put(`/doctors/${doctorProfileId}/fees`, {
      branchId: org.branchId,
      fees: [
        { feeType: 'NEW', amountMinor: 50_000 },
        { feeType: 'FOLLOW_UP', amountMinor: 20_000 },
      ],
    });
    await A.put(`/doctors/${doctorProfileId}/branch-settings`, {
      branchId: org.branchId,
      followUpFreeDays: FREE_DAYS,
    });
  });

  it('reports the gap rather than pricing the visit at zero', async () => {
    const res = await billing(appointmentId);
    expect(res.body.data.charge).toBeNull();
    expect(res.body.data.unpricedReason).toBe('NO_RATE_CARD');
    /* Still billable — the cashier can send the amount. */
    expect(res.body.data.billable).toBe(true);
  });

  it('refuses to raise a bill it cannot price', async () => {
    const res = await raise(appointmentId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/fee schedule/i);
  });

  /*
   * A clinic that priced five of six visit types is not an unconfigured clinic,
   * and telling it to "set up billing" is the wrong prompt. The price below is
   * for a kind of visit this appointment is not.
   */
  it('distinguishes one unpriced visit type from an empty grid', async () => {
    await A.put(`/doctors/${doctorProfileId}/fees`, {
      branchId: org.branchId,
      fees: [{ feeType: 'RESCHEDULE', amountMinor: 10_000 }],
    });

    const res = await billing(appointmentId);
    expect(res.body.data.unpricedReason).toBe('NO_FEE_SET');

    await clearPrices();
  });

  it('bills what the cashier sends when the card cannot price it', async () => {
    const res = await raise(appointmentId, { unitPriceMinor: 75_000 });
    expect(res.status).toBe(201);
    expect(res.body.data.grandTotalMinor).toBe(75_000);
    expect(res.body.data.items[0].unitPriceMinor).toBe(75_000);
  });
});

describe('a visit that never happened', () => {
  let appointmentId = '';

  beforeAll(async () => {
    appointmentId = await book(CANCELLED_VISIT);
    await A.post(`/appointments/${appointmentId}/cancel`, { reason: 'Patient rang to postpone' });
  });

  it('is not billable, and says which of the two reasons applies', async () => {
    const res = await billing(appointmentId);
    expect(res.body.data.billable).toBe(false);
    expect(res.body.data.blockedReason).toBe('APPOINTMENT_CANCELLED');
  });

  it('refuses the bill', async () => {
    const res = await raise(appointmentId);
    expect(res.status).toBe(409);
  });
});

describe('the day board', () => {
  let appointmentId = '';

  beforeAll(async () => {
    appointmentId = await book(BOARD_VISIT);
    const raised = await raise(appointmentId);
    if (raised.status !== 201) {
      throw new Error(`could not bill the visit: ${JSON.stringify(raised.body)}`);
    }
  });

  const boardFor = (client: typeof A) =>
    client.get(`/appointments?branchId=${org.branchId}&date=${BOARD_DAY}`);

  it('answers "is this visit billed?" per row, in one query', async () => {
    const res = await boardFor(A);
    expect(res.status).toBe(200);

    const row = (res.body.data.appointments as { id: string; liveInvoice: unknown }[]).find(
      (a) => a.id === appointmentId
    );
    expect(row?.liveInvoice).toMatchObject({
      status: 'DRAFT',
      grandTotalMinor: CONSULTATION_MINOR,
    });
  });

  /**
   * ⚠️ ABSENT, NOT NULL. A doctor shown `liveInvoice: null` on every row would
   *   read the board as "nothing has been billed today", which is a different
   *   claim from "you were not told".
   */
  it('omits the field entirely for a caller who may not read invoices', async () => {
    const res = await boardFor(Board);
    expect(res.status).toBe(200);

    const rows = res.body.data.appointments as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('liveInvoice');
  });

  it('carries the same answer on the detail read', async () => {
    const res = await A.get(`/appointments/${appointmentId}`);
    expect(res.body.data.liveInvoice).toMatchObject({ status: 'DRAFT' });

    const board = await Board.get(`/appointments/${appointmentId}`);
    expect(board.status).toBe(200);
    expect(board.body.data).not.toHaveProperty('liveInvoice');
  });
});
