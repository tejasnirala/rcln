/**
 * Fees, the freeze at booking, the move charge and doctor pay — over real HTTP.
 *
 * Seven things are being pinned down, and none of them is "CRUD works":
 *
 *   1. THE PRECEDENCE RULE, ALL FOUR SCOPES. A doctor's price at a branch beats
 *      their price everywhere, which beats the clinic's price at that branch,
 *      which beats the clinic's price everywhere. One resolver, and this is what
 *      proves the ladder is in the order §0.5 says it is.
 *   2. A RESOLVED ZERO IS A PRICE, AND A MISSING ROW IS NOT. Free and unpriced
 *      look identical on a screen and are opposite instructions; only the
 *      absence of a row falls through to the next scope.
 *   3. THE PRICE IS FROZEN AT BOOKING. A fee raised afterwards does not reach a
 *      booking already taken — there is deliberately no pro rata.
 *   4. A MOVE TO A DIFFERENT DOCTOR RE-RESOLVES IT, and a move that only changes
 *      the time does not.
 *   5. WHO ASKED FOR THE MOVE DECIDES WHETHER IT IS CHARGED. A clinic-initiated
 *      move costs nothing; a patient-initiated one costs the `RESCHEDULE` fee
 *      once per move and must carry a reason.
 *   6. `NO_RATE_CARD` AND `NO_FEE_SET` ARE DIFFERENT ANSWERS — an empty grid and
 *      one gap in a filled grid are different prompts.
 *   7. PAY IS NOT READABLE BY WHOEVER CAN EDIT A BIO. `doctor.update` gets you
 *      nowhere near it; the owner holds the compensation pair by being
 *      "everything except", and a doctor reads their own by ownership.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `f${Date.now().toString(36)}`;
const SLUG_A = `fee-a-${SUFFIX}`;
const SLUG_B = `fee-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/**
 * A Monday far enough ahead that "is this in the past?" never depends on today,
 * and 09:00 at an Asia/Kolkata branch is 03:30Z.
 */
const FIRST_SLOT = '2027-03-01T03:30:00.000Z';
const SECOND_SLOT = '2027-03-01T03:45:00.000Z';
const THIRD_SLOT = '2027-03-01T04:00:00.000Z';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

let doctorA: string;
let doctorA2: string;
let patientA: string;
/** A second branch at clinic A, so the per-branch half of the ladder is real. */
let branchA2: string;

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

async function tokenFor(slug: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier: `${slug}@example.test`, password: PASSWORD });
  return res.body.data.accessToken as string;
}

const asOrg = (slug: string, token: string) => {
  const auth = (r: request.Test): request.Test =>
    r.set('Host', hostFor(slug)).set('Authorization', `Bearer ${token}`);
  return {
    fees: (path: string) => auth(request(app).get(`/api/v1/fee-schedule${path}`)),
    putFees: (body: object) => auth(request(app).put('/api/v1/fee-schedule')).send(body),
    doctorFees: (doctorId: string, query = '') =>
      auth(request(app).get(`/api/v1/doctors/${doctorId}/fees${query}`)),
    putDoctorFees: (doctorId: string, body: object) =>
      auth(request(app).put(`/api/v1/doctors/${doctorId}/fees`)).send(body),
    pay: (doctorId: string) => auth(request(app).get(`/api/v1/doctors/${doctorId}/compensation`)),
    putPay: (doctorId: string, body: object) =>
      auth(request(app).put(`/api/v1/doctors/${doctorId}/compensation`)).send(body),
    book: (body: object) => auth(request(app).post('/api/v1/appointments')).send(body),
    move: (id: string, body: object) =>
      auth(request(app).post(`/api/v1/appointments/${id}/reschedule`)).send(body),
    billing: (id: string) => auth(request(app).get(`/api/v1/appointments/${id}/billing`)),
    doctors: (path: string, body: object) =>
      auth(request(app).post(`/api/v1/doctors${path}`)).send(body),
    branches: (body: object) => auth(request(app).post('/api/v1/branches')).send(body),
    patients: (body: object) => auth(request(app).post('/api/v1/patients')).send(body),
  };
};

/**
 * A doctor working Mondays 09:00–13:00 at the given branch.
 *
 * ⚠️ THE REGISTRATION NUMBER IS NOT DECORATION HERE.
 *   `doctor_profiles_organization_id_registration_number_key` is NULLS NOT
 *   DISTINCT, so a clinic may hold exactly ONE doctor without one — and this
 *   suite needs two at clinic A.
 */
async function seedDoctor(
  client: ReturnType<typeof asOrg>,
  userId: string,
  branchId: string,
  registrationNumber: string
): Promise<string> {
  const doctor = await client.doctors('/', { userId, specialtyIds: [], registrationNumber });
  if (doctor.status !== 201) {
    throw new Error(`seedDoctor: ${doctor.status} ${JSON.stringify(doctor.body)}`);
  }
  const doctorId = doctor.body.data.id as string;
  await client.doctors(`/${doctorId}/schedules`, {
    branchId,
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '13:00',
    validFrom: '2026-01-01',
  });
  return doctorId;
}

/**
 * Back to an empty clinic: no prices, no bookings, no trail.
 *
 * The bookings have to go with the prices. Every case here books into the same
 * three slots of the same Monday, and the EXCLUDE constraint that stops a doctor
 * being double-booked does not care that the first booking belonged to a test
 * that has finished. `appointment_reschedules` and the status trail cascade with
 * their appointment.
 */
async function reset(): Promise<void> {
  await owner.query('DELETE FROM fee_schedule_entries WHERE organization_id = $1', [
    orgA.organizationId,
  ]);
  await owner.query('DELETE FROM appointments WHERE organization_id = $1', [orgA.organizationId]);
  await owner.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgA.organizationId]);
}

const bookAt = (startsAt: string, doctorProfileId: string, visitType = 'NEW') =>
  A.book({
    branchId: orgA.branchId,
    patientId: patientA,
    doctorProfileId,
    startsAt,
    visitType,
    source: 'FRONT_DESK',
  });

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Fee A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Fee B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));

  doctorA = await seedDoctor(A, orgA.ownerUserId, orgA.branchId, `REG-${SUFFIX}-1`);

  /*
   * A second practitioner, so the doctor-swap re-resolve is a real swap. The
   * profile hangs off a second user because `doctor_profiles.user_id` is unique
   * per organization, and that user needs a membership before `createDoctor`
   * will look at them — seeded here rather than through the invitation flow,
   * which is a different suite's subject.
   */
  const second = await owner.query<{ id: string }>(
    `INSERT INTO users (id, full_name, email, updated_at)
     VALUES (gen_random_uuid(), 'Fee A Second', $1, now()) RETURNING id`,
    [`second-${SLUG_A}@example.test`]
  );
  const secondUserId = second.rows[0]?.id as string;
  await owner.query(
    `INSERT INTO memberships (id, user_id, organization_id, status, joined_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now())`,
    [secondUserId, orgA.organizationId]
  );
  doctorA2 = await seedDoctor(A, secondUserId, orgA.branchId, `REG-${SUFFIX}-2`);

  const branch = await A.branches({ name: 'Fee A Second Branch', code: 'SEC' });
  branchA2 = branch.body.data?.id as string;

  const patient = await A.patients({
    firstName: 'Fee',
    lastName: 'Payer',
    branchId: orgA.branchId,
    gender: 'FEMALE',
  });
  patientA = patient.body.data.id as string;
}, 60_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE email LIKE $1', [`%${SLUG_A}@example.test`]);
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

// ---------------------------------------------------------------------------

describe('the fee grid', () => {
  beforeEach(reset);

  it('shows every known fee type, unset, before a clinic has done anything', async () => {
    const res = await A.fees('');

    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('INR');
    const keys = res.body.data.rows.map((r: { feeType: string }) => r.feeType);
    expect(keys).toEqual(
      expect.arrayContaining([
        'NEW',
        'FOLLOW_UP',
        'WALK_IN',
        'TELECONSULT',
        'PROCEDURE',
        'RESCHEDULE',
      ])
    );
    for (const row of res.body.data.rows) {
      expect(row.amountMinor).toBeNull();
      expect(row.level).toBeNull();
    }
  });

  it('saves the clinic default and reports where it resolved from', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const res = await A.fees('');
    const row = res.body.data.rows.find((r: { feeType: string }) => r.feeType === 'NEW');
    expect(row.amountMinor).toBe(50_000);
    expect(row.level).toBe('CLINIC_ORGANIZATION');
    expect(row.ownAmountMinor).toBe(50_000);
  });

  /*
   * The whole ladder, one rung at a time, checked from the doctor's sheet at the
   * second branch — the most specific scope, which every rung has to beat in
   * turn.
   */
  it('resolves doctor+branch over doctor, over clinic+branch, over clinic', async () => {
    const at = async (): Promise<{ amountMinor: number; level: string }> => {
      const res = await A.doctorFees(doctorA, `?branchId=${branchA2}`);
      return res.body.data.rows.find((r: { feeType: string }) => r.feeType === 'NEW');
    };

    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 10_000 }] });
    expect(await at()).toMatchObject({ amountMinor: 10_000, level: 'CLINIC_ORGANIZATION' });

    await A.putFees({ branchId: branchA2, fees: [{ feeType: 'NEW', amountMinor: 20_000 }] });
    expect(await at()).toMatchObject({ amountMinor: 20_000, level: 'CLINIC_BRANCH' });

    await A.putDoctorFees(doctorA, {
      branchId: null,
      fees: [{ feeType: 'NEW', amountMinor: 30_000 }],
    });
    expect(await at()).toMatchObject({ amountMinor: 30_000, level: 'DOCTOR_ORGANIZATION' });

    await A.putDoctorFees(doctorA, {
      branchId: branchA2,
      fees: [{ feeType: 'NEW', amountMinor: 40_000 }],
    });
    expect(await at()).toMatchObject({ amountMinor: 40_000, level: 'DOCTOR_BRANCH' });
  });

  /*
   * ⚠️ THE ONE THAT MATTERS MOST. A clinic that waives first visits for one
   *   doctor has decided something; reading that zero as "unset" and falling
   *   through to the clinic's 500 charges a patient for a visit the clinic said
   *   was free.
   */
  it('treats a resolved zero as a price, not as unset', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });
    await A.putDoctorFees(doctorA, { branchId: null, fees: [{ feeType: 'NEW', amountMinor: 0 }] });

    const res = await A.doctorFees(doctorA);
    const row = res.body.data.rows.find((r: { feeType: string }) => r.feeType === 'NEW');
    expect(row.amountMinor).toBe(0);
    expect(row.level).toBe('DOCTOR_ORGANIZATION');
  });

  it('goes back to inheriting when an override is cleared', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });
    await A.putDoctorFees(doctorA, {
      branchId: null,
      fees: [{ feeType: 'NEW', amountMinor: 90_000 }],
    });
    await A.putDoctorFees(doctorA, {
      branchId: null,
      fees: [{ feeType: 'NEW', amountMinor: null }],
    });

    const res = await A.doctorFees(doctorA);
    const row = res.body.data.rows.find((r: { feeType: string }) => r.feeType === 'NEW');
    expect(row.amountMinor).toBe(50_000);
    expect(row.level).toBe('CLINIC_ORGANIZATION');
    expect(row.ownAmountMinor).toBeNull();
  });

  /* A screen posting a subset must not wipe what it did not send. */
  it('leaves fee types the request did not name alone', async () => {
    await A.putFees({
      branchId: null,
      fees: [
        { feeType: 'NEW', amountMinor: 50_000 },
        { feeType: 'TELECONSULT', amountMinor: 30_000 },
      ],
    });
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 60_000 }] });

    const res = await A.fees('');
    const rows = res.body.data.rows as { feeType: string; amountMinor: number | null }[];
    expect(rows.find((r) => r.feeType === 'NEW')?.amountMinor).toBe(60_000);
    expect(rows.find((r) => r.feeType === 'TELECONSULT')?.amountMinor).toBe(30_000);
  });

  it('quotes a visit for the booking form, and says null rather than zero when unpriced', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const priced = await A.fees(
      `/quote?doctorProfileId=${doctorA}&branchId=${orgA.branchId}&feeType=NEW`
    );
    expect(priced.status).toBe(200);
    expect(priced.body.data.amountMinor).toBe(50_000);
    expect(priced.body.data.level).toBe('CLINIC_ORGANIZATION');

    const unpriced = await A.fees(
      `/quote?doctorProfileId=${doctorA}&branchId=${orgA.branchId}&feeType=TELECONSULT`
    );
    expect(unpriced.body.data.amountMinor).toBeNull();
    expect(unpriced.body.data.level).toBeNull();
  });

  /* Prices are the clinic's business and nobody else's. */
  it("does not let one clinic read another's prices", async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 77_700 }] });

    const res = await B.fees('');
    const row = res.body.data.rows.find((r: { feeType: string }) => r.feeType === 'NEW');
    expect(row.amountMinor).toBeNull();
  });

  it('refuses a branch this caller cannot reach, as a 404', async () => {
    const res = await A.putFees({
      branchId: orgB.branchId,
      fees: [{ feeType: 'NEW', amountMinor: 100 }],
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('the price frozen at booking', () => {
  beforeEach(reset);

  it('freezes the price onto the appointment, and a later rise does not move it', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const booked = await bookAt(FIRST_SLOT, doctorA);
    expect(booked.status).toBe(201);
    const appointmentId = booked.body.data.id as string;

    /* The clinic puts its prices up the next morning. */
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 80_000 }] });

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.charge.unitPriceMinor).toBe(50_000);
  });

  it('keeps the frozen price when only the time moves', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });
    const booked = await bookAt(SECOND_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    await A.putDoctorFees(doctorA, {
      branchId: null,
      fees: [{ feeType: 'NEW', amountMinor: 90_000 }],
    });
    const moved = await A.move(appointmentId, { startsAt: THIRD_SLOT, initiatedBy: 'CLINIC' });
    expect(moved.status).toBe(200);

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.charge.unitPriceMinor).toBe(50_000);
  });

  /*
   * A different practitioner gives a different consultation. This is not the
   * withdrawn pro-rata rule: that was one doctor's price moving over time.
   */
  it('re-resolves the price when the booking moves to another doctor', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });
    await A.putDoctorFees(doctorA2, {
      branchId: null,
      fees: [{ feeType: 'NEW', amountMinor: 120_000 }],
    });

    const booked = await bookAt(FIRST_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    const moved = await A.move(appointmentId, {
      startsAt: SECOND_SLOT,
      doctorProfileId: doctorA2,
      initiatedBy: 'CLINIC',
    });
    expect(moved.status).toBe(200);

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.charge.unitPriceMinor).toBe(120_000);
  });

  it('books an unpriced visit rather than refusing it', async () => {
    const booked = await bookAt(THIRD_SLOT, doctorA, 'TELECONSULT');
    expect(booked.status).toBe(201);

    const billing = await A.billing(booked.body.data.id as string);
    expect(billing.body.data.charge).toBeNull();
    /* Nothing priced anywhere — the "fill your grid in" prompt. */
    expect(billing.body.data.unpricedReason).toBe('NO_RATE_CARD');
  });

  it('tells an unpriced VISIT TYPE apart from an unpriced clinic', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const booked = await bookAt(SECOND_SLOT, doctorA, 'TELECONSULT');
    const billing = await A.billing(booked.body.data.id as string);

    expect(billing.body.data.charge).toBeNull();
    expect(billing.body.data.unpricedReason).toBe('NO_FEE_SET');
  });

  /* Most clinics price the first consultation and leave the review blank. */
  it('falls back from FOLLOW_UP to NEW, and to nothing else', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const review = await bookAt(FIRST_SLOT, doctorA, 'FOLLOW_UP');
    const reviewBilling = await A.billing(review.body.data.id as string);
    expect(reviewBilling.body.data.charge.unitPriceMinor).toBe(50_000);

    const walkIn = await bookAt(SECOND_SLOT, doctorA, 'WALK_IN');
    const walkInBilling = await A.billing(walkIn.body.data.id as string);
    expect(walkInBilling.body.data.charge).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('moving a booking', () => {
  beforeEach(reset);

  it('charges nothing when the clinic moved it, and records that it did', async () => {
    await A.putFees({
      branchId: null,
      fees: [
        { feeType: 'NEW', amountMinor: 50_000 },
        { feeType: 'RESCHEDULE', amountMinor: 20_000 },
      ],
    });

    const booked = await bookAt(FIRST_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    await A.move(appointmentId, { startsAt: SECOND_SLOT, initiatedBy: 'CLINIC' });

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.rescheduleCount).toBe(0);
    expect(billing.body.data.rescheduleChargeMinor).toBe(0);

    const rows = await owner.query(
      'SELECT initiated_by, charge_amount FROM appointment_reschedules WHERE appointment_id = $1',
      [appointmentId]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].initiated_by).toBe('CLINIC');
  });

  it('charges once per move when the patient asked, and adds them up', async () => {
    await A.putFees({
      branchId: null,
      fees: [
        { feeType: 'NEW', amountMinor: 50_000 },
        { feeType: 'RESCHEDULE', amountMinor: 20_000 },
      ],
    });

    const booked = await bookAt(FIRST_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    await A.move(appointmentId, {
      startsAt: SECOND_SLOT,
      initiatedBy: 'PATIENT',
      reason: 'Travelling that morning',
    });
    await A.move(appointmentId, {
      startsAt: THIRD_SLOT,
      initiatedBy: 'PATIENT',
      reason: 'Travelling again',
    });

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.rescheduleCount).toBe(2);
    expect(billing.body.data.rescheduleChargeMinor).toBe(40_000);
    /* The consultation itself is untouched by the moves. */
    expect(billing.body.data.charge.unitPriceMinor).toBe(50_000);
  });

  it('refuses a patient-requested move with no reason', async () => {
    const booked = await bookAt(FIRST_SLOT, doctorA);
    const res = await A.move(booked.body.data.id as string, {
      startsAt: SECOND_SLOT,
      initiatedBy: 'PATIENT',
    });
    expect(res.status).toBe(400);
  });

  /* A move must not be blocked by a price the clinic never set. */
  it('moves at no charge when RESCHEDULE is unpriced', async () => {
    await A.putFees({ branchId: null, fees: [{ feeType: 'NEW', amountMinor: 50_000 }] });

    const booked = await bookAt(FIRST_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    const moved = await A.move(appointmentId, {
      startsAt: SECOND_SLOT,
      initiatedBy: 'PATIENT',
      reason: 'Asked to come later',
    });
    expect(moved.status).toBe(200);

    const billing = await A.billing(appointmentId);
    expect(billing.body.data.rescheduleChargeMinor).toBe(0);
  });

  /*
   * ⚠️ PHI. "Chemotherapy clashes" is a diagnosis, and the audit trail is read
   *   by compliance staff who have no business reading patient records.
   */
  it('keeps the reason out of the audit trail', async () => {
    const secret = 'Chemotherapy on Tuesdays';
    const booked = await bookAt(FIRST_SLOT, doctorA);
    const appointmentId = booked.body.data.id as string;

    await A.move(appointmentId, {
      startsAt: SECOND_SLOT,
      initiatedBy: 'PATIENT',
      reason: secret,
    });

    const trail = await owner.query(
      'SELECT before_data, after_data FROM audit_logs WHERE organization_id = $1',
      [orgA.organizationId]
    );
    const dump = JSON.stringify(trail.rows);
    expect(dump).not.toContain(secret);
    expect(dump).toContain('rescheduleInitiatedBy');

    const stored = await owner.query(
      'SELECT reason FROM appointment_reschedules WHERE appointment_id = $1',
      [appointmentId]
    );
    expect(stored.rows[0].reason).toBe(secret);
  });
});

// ---------------------------------------------------------------------------

describe('what the clinic pays a doctor', () => {
  it('is empty rather than missing before anything is agreed', async () => {
    const res = await A.pay(doctorA2);

    expect(res.status).toBe(200);
    expect(res.body.data.amountMinor).toBeNull();
    expect(res.body.data.interval).toBeNull();
    expect(res.body.data.currency).toBe('INR');
  });

  it('records an agreed figure and reads it back', async () => {
    const saved = await A.putPay(doctorA, { amountMinor: 12_000_000, interval: 'MONTHLY' });
    expect(saved.status).toBe(200);

    const res = await A.pay(doctorA);
    expect(res.body.data.amountMinor).toBe(12_000_000);
    expect(res.body.data.interval).toBe('MONTHLY');
  });

  /* An amount nobody can act on, and a schedule for paying nothing. */
  it('refuses an amount without an interval', async () => {
    const res = await A.putPay(doctorA, { amountMinor: 5_000, interval: null });
    expect(res.status).toBe(400);
  });

  it('clears both together', async () => {
    await A.putPay(doctorA, { amountMinor: 9_000, interval: 'WEEKLY' });
    const cleared = await A.putPay(doctorA, { amountMinor: null, interval: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.amountMinor).toBeNull();
    expect(cleared.body.data.interval).toBeNull();
  });

  it("does not let one clinic read another's payroll", async () => {
    const res = await B.pay(doctorA);
    expect(res.status).toBe(404);
  });
});
