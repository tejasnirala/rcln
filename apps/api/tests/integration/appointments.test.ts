/**
 * Appointments over real HTTP, through the real middleware chain.
 *
 * Six things are being pinned down, and none of them is "CRUD works":
 *
 *   1. THE ENGINE READS WALL-CLOCK HOURS AND RETURNS INSTANTS. A block written
 *      as 09:00 at an Asia/Kolkata branch must come back as 03:30Z. The bug this
 *      guards is a Date built from local components on a UTC container, which
 *      shifts every slot by 5:30 and fails nothing.
 *   2. DOUBLE-BOOKING IS REFUSED, and the 409 never quotes the constraint
 *      DETAIL — which names the conflicting range, possibly one this caller
 *      cannot see.
 *   3. CANCELLING FREES THE SLOT, with no release step anywhere: the EXCLUDE
 *      constraint's predicate and the engine's status filter are the same rule
 *      written twice, and this is what proves they agree.
 *   4. THE TRANSITION MAP HOLDS. Specifically, NO_SHOW is unreachable after a
 *      check-in — a patient standing at the desk cannot retrospectively not have
 *      turned up.
 *   5. AVAILABILITY NEVER NAMES WHO HOLDS A SLOT.
 *   6. NO PHI REACHES `audit_logs`. Measured, not asserted in prose: every audit
 *      row this suite writes is grepped for the patient's name and the reason.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `a${Date.now().toString(36)}`;
const SLUG_A = `apt-a-${SUFFIX}`;
const SLUG_B = `apt-b-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/**
 * A Monday well in the future, so "is this slot in the past?" never depends on
 * when the suite runs. 2027-03-01 is a Monday; 2027-02-28 is the Sunday before
 * it, and the doctor has no hours on a Sunday.
 */
const MONDAY = '2027-03-01';
const SUNDAY = '2027-02-28';
/** 09:00 at an Asia/Kolkata branch. The whole timezone contract in one string. */
const FIRST_SLOT = '2027-03-01T03:30:00.000Z';
const SECOND_SLOT = '2027-03-01T03:45:00.000Z';

/** Distinctive enough that finding it in an audit row is unambiguous. */
const SUBJECT = { firstName: 'Meenakshi', lastName: 'Varadarajan' };
const REASON = 'Palpitations since Tuesday';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let A: ReturnType<typeof asOrg>;
let B: ReturnType<typeof asOrg>;

let doctorA: string;
let doctorB: string;
let patientA: string;
let patientB: string;

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

async function clearAccessDedupe(): Promise<void> {
  const keys = await redis.keys('dal:*');
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
    get: (path: string) => auth(request(app).get(`/api/v1/appointments${path}`)),
    post: (path: string, body: object) =>
      auth(request(app).post(`/api/v1/appointments${path}`)).send(body),
    patch: (path: string, body: object) =>
      auth(request(app).patch(`/api/v1/appointments${path}`)).send(body),
    put: (path: string, body: object) =>
      auth(request(app).put(`/api/v1/appointments${path}`)).send(body),
    doctors: (path: string, body: object) =>
      auth(request(app).post(`/api/v1/doctors${path}`)).send(body),
    patients: (path: string, body: object) =>
      auth(request(app).post(`/api/v1/patients${path}`)).send(body),
    patientsGet: (path: string) => auth(request(app).get(`/api/v1/patients${path}`)),
  };
};

/** A doctor working Mondays 09:00–13:00 at the org's main branch. */
async function seedDoctor(
  client: ReturnType<typeof asOrg>,
  userId: string,
  branchId: string
): Promise<string> {
  const doctor = await client.doctors('/', { userId, specialtyIds: [] });
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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Apt A'));
  orgB = await registerOrganization(payload(SLUG_B, 'Apt B'));

  A = asOrg(SLUG_A, await tokenFor(SLUG_A));
  B = asOrg(SLUG_B, await tokenFor(SLUG_B));

  doctorA = await seedDoctor(A, orgA.ownerUserId, orgA.branchId);
  doctorB = await seedDoctor(B, orgB.ownerUserId, orgB.branchId);

  const pA = await A.patients('', {
    firstName: SUBJECT.firstName,
    lastName: SUBJECT.lastName,
    branchId: orgA.branchId,
    gender: 'FEMALE',
  });
  patientA = pA.body.data.id as string;

  const pB = await B.patients('', {
    firstName: 'Other',
    lastName: 'Clinic',
    branchId: orgB.branchId,
  });
  patientB = pB.body.data.id as string;
}, 40_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    /*
     * Both trails are append-only for `rcln_app` and cascade-deleted here as
     * the OWNER, which is the only role that can. Same shape as the patients
     * suite; `appointment_status_history` goes with its appointment.
     */
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const availability = (
  client: ReturnType<typeof asOrg>,
  branchId: string,
  doctorId: string,
  date: string
) => client.get(`/availability?branchId=${branchId}&doctorProfileId=${doctorId}&date=${date}`);

// ---------------------------------------------------------------------------

describe('the availability engine', () => {
  it('turns 09:00 wall-clock at an IST branch into 03:30Z', async () => {
    const res = await availability(A, orgA.branchId, doctorA, MONDAY);

    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe('Asia/Kolkata');
    expect(res.body.data.slotMinutes).toBe(15);
    // 09:00–13:00 at 15 minutes is sixteen slots, and the first one is 03:30Z.
    expect(res.body.data.slots).toHaveLength(16);
    expect(res.body.data.slots[0].startsAt).toBe(FIRST_SLOT);
    expect(res.body.data.slots[0].available).toBe(true);
    expect(res.body.data.notWorking).toBe(false);
  });

  /*
   * "No hours today" and "every slot has gone" are different sentences, and a
   * screen that cannot tell them apart sends the front desk hunting for a
   * cancellation that was never going to appear.
   */
  it('says the doctor is not working, rather than returning an empty day', async () => {
    const res = await availability(A, orgA.branchId, doctorA, SUNDAY);

    expect(res.status).toBe(200);
    expect(res.body.data.notWorking).toBe(true);
    expect(res.body.data.slots).toHaveLength(0);
  });

  it('marks a day in the past as past rather than free', async () => {
    // 2020-03-02 was also a Monday, so the block exists and only time excludes it.
    const res = await availability(A, orgA.branchId, doctorA, '2026-03-02');
    const past = res.body.data.slots.filter((s: { reason: string }) => s.reason === 'PAST');
    expect(past.length).toBeGreaterThan(0);
    expect(res.body.data.slots.every((s: { available: boolean }) => !s.available)).toBe(true);
  });

  it("refuses a branch outside the caller's scope with a 404, never a 403", async () => {
    const res = await availability(A, orgB.branchId, doctorA, MONDAY);
    expect(res.status).toBe(404);
  });
});

/**
 * A doctor who consults whenever the clinic is open (DS-1).
 *
 * ⚠️ THESE ARE THE ASSERTIONS THE FEATURE ACTUALLY RESTS ON. Saving the flag and
 *   reading it back proves nothing — if the engine ignores it, the result is a
 *   doctor whose diary is empty for a reason nobody can see from any screen. So
 *   every case here goes through the availability endpoint, which is what the
 *   front desk experiences.
 *
 * ⚠️ AND THE LAST ONE IS WHY THE HOURS ARE DERIVED RATHER THAN COPIED. Changing
 *   the branch's opening hours must change this doctor's availability, without
 *   anybody re-saving the doctor. A copy taken at save time passes every other
 *   case in this block and fails that one.
 */
describe('a doctor on the clinic’s own hours', () => {
  /**
   * The doctor from the fixture works Mondays 09:00-13:00 and nothing else.
   * Turning the flag on should make Sunday bookable too, because the branch is
   * open then — which is the observable difference between the two sources.
   */
  async function follow(value: boolean): Promise<void> {
    await owner.query(
      `INSERT INTO doctor_branch_settings
         (id, organization_id, doctor_profile_id, branch_id, follows_branch_hours, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
       ON CONFLICT (organization_id, doctor_profile_id, branch_id)
       DO UPDATE SET follows_branch_hours = EXCLUDED.follows_branch_hours`,
      [orgA.organizationId, doctorA, orgA.branchId, value]
    );
  }

  async function setBranchWeek(day: number, opens: string, closes: string): Promise<void> {
    await owner.query(
      `INSERT INTO branch_operating_hours
         (id, branch_id, day_of_week, opens_at, closes_at, is_closed, slot_minutes)
       VALUES (gen_random_uuid(), $1, $2, $3::time, $4::time, false, 30)
       ON CONFLICT (branch_id, day_of_week)
       DO UPDATE SET opens_at = EXCLUDED.opens_at,
                     closes_at = EXCLUDED.closes_at,
                     is_closed = false,
                     slot_minutes = EXCLUDED.slot_minutes`,
      [orgA.branchId, day, opens, closes]
    );
  }

  afterAll(async () => {
    await follow(false);
    await owner.query('DELETE FROM branch_operating_hours WHERE branch_id = $1', [orgA.branchId]);
  });

  it('is not working on a day the doctor has no block and the flag is off', async () => {
    await follow(false);
    const res = await availability(A, orgA.branchId, doctorA, SUNDAY);
    expect(res.body.data.notWorking).toBe(true);
  });

  it('consults on a day the CLINIC is open once the flag is on', async () => {
    await setBranchWeek(0, '10:00', '12:00');
    await follow(true);

    const res = await availability(A, orgA.branchId, doctorA, SUNDAY);

    expect(res.status).toBe(200);
    expect(res.body.data.notWorking).toBe(false);
    // 10:00-12:00 at the BRANCH's own 30-minute slots is four.
    expect(res.body.data.slots).toHaveLength(4);
  });

  /**
   * ⚠️ THE DOCTOR'S OWN BLOCKS MUST NOT ALSO APPLY. Reading both sources would
   *   double the Monday morning — every slot offered twice, from two rows the
   *   engine had no way to reconcile.
   */
  it('reads the clinic’s hours INSTEAD of the doctor’s own, not as well', async () => {
    await setBranchWeek(1, '14:00', '16:00');
    await follow(true);

    const res = await availability(A, orgA.branchId, doctorA, MONDAY);

    // The branch says 14:00-16:00 at 30 minutes: four slots. The doctor's own
    // 09:00-13:00 block is still in the database and must contribute nothing.
    expect(res.body.data.slots).toHaveLength(4);
    expect(res.body.data.slots[0].startsAt).toBe('2027-03-01T08:30:00.000Z');
  });

  it('the day picker agrees with the slot list', async () => {
    await follow(true);
    const res = await A.get(
      `/availability/days?branchId=${orgA.branchId}&doctorProfileId=${doctorA}&from=${SUNDAY}&to=${SUNDAY}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.days[0].bookable).toBe(true);
  });

  /** The whole reason this is derived and not copied. */
  it('follows the clinic when the clinic changes its hours', async () => {
    await follow(true);
    await setBranchWeek(0, '10:00', '11:00');

    const res = await availability(A, orgA.branchId, doctorA, SUNDAY);

    // Nobody touched the doctor; the clinic shortened its Sunday and the
    // doctor's day shortened with it.
    expect(res.body.data.slots).toHaveLength(2);
  });
});

/*
 * What the date picker greys out. The doctor here works Mondays and nothing
 * else, which is the whole case: a receptionist should not be able to land on a
 * Wednesday and be told the diary is empty.
 */
describe('the working-day probe', () => {
  const days = (branchId: string, doctorId: string, from: string, to: string) =>
    A.get(
      `/availability/days?branchId=${branchId}&doctorProfileId=${doctorId}&from=${from}&to=${to}`
    );

  it('answers for every day in the span, and says why each is shut', async () => {
    const res = await days(orgA.branchId, doctorA, MONDAY, '2027-03-07');

    expect(res.status).toBe(200);
    // None missing: the picker indexes by date and a hole would render as
    // "bookable" by omission.
    expect(res.body.data.days).toHaveLength(7);

    type Day = { date: string; bookable: boolean; reason: string | null };
    const byDate: Record<string, Day> = Object.fromEntries(
      (res.body.data.days as Day[]).map((day) => [day.date, day])
    );

    expect(byDate[MONDAY]?.bookable).toBe(true);
    expect(byDate[MONDAY]?.reason).toBeNull();
    expect(byDate['2027-03-03']?.bookable).toBe(false);
    expect(byDate['2027-03-03']?.reason).toBe('NOT_SCHEDULED');
  });

  /*
   * The doctor's rota does not reach back to 2020 either, so this is also the
   * precedence check: a day that has gone reads as PAST, not NOT_SCHEDULED.
   */
  it('marks a day that has gone as past, whatever the rota says', async () => {
    const res = await days(orgA.branchId, doctorA, '2020-03-02', '2020-03-02');
    expect(res.body.data.days[0].reason).toBe('PAST');
    expect(res.body.data.days[0].bookable).toBe(false);
  });

  it('refuses a span wider than a picker asks for', async () => {
    const res = await days(orgA.branchId, doctorA, '2027-03-01', '2027-12-31');
    expect(res.status).toBe(400);
  });

  it("refuses a branch outside the caller's scope with a 404, never a 403", async () => {
    const res = await days(orgB.branchId, doctorA, MONDAY, MONDAY);
    expect(res.status).toBe(404);
  });
});

describe('booking', () => {
  let appointmentId: string;

  it('books the offered instant and issues a branch-local number', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: FIRST_SLOT,
      reason: REASON,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.appointmentNumber).toMatch(/^A\d{6}$/);
    expect(res.body.data.status).toBe('BOOKED');
    expect(res.body.data.scheduledStart).toBe(FIRST_SLOT);
    // 15 minutes later, from the resolved cadence rather than anything sent.
    expect(res.body.data.scheduledEnd).toBe('2027-03-01T03:45:00.000Z');
    // Booking at a branch registers the patient there — an MRN comes back.
    expect(res.body.data.mrn).toMatch(/^MRN\d{6}$/);

    appointmentId = res.body.data.id as string;
  });

  it('shows the slot as taken without naming who has it', async () => {
    const res = await availability(A, orgA.branchId, doctorA, MONDAY);
    const first = res.body.data.slots[0];

    expect(first.available).toBe(false);
    expect(first.reason).toBe('BOOKED');
    // ⚠️ The disclosure this response exists to avoid.
    expect(JSON.stringify(res.body)).not.toContain(SUBJECT.lastName);
  });

  it('refuses the same slot twice, without quoting the constraint', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: FIRST_SLOT,
    });

    expect(res.status).toBe(409);
    expect(res.body.message).not.toMatch(/appointments_no_doctor_overlap|23P01|tstzrange/i);
    expect(res.body.message).toMatch(/no longer free/i);
  });

  it('refuses a time the doctor does not work', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      // 20:00 IST — well outside the 09:00–13:00 block.
      startsAt: '2027-03-01T14:30:00.000Z',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a time that is not on the slot grid', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      // 09:07 IST. Inside the block, not a slot.
      startsAt: '2027-03-01T03:37:00.000Z',
    });
    expect(res.status).toBe(400);
  });

  /*
   * A long booking has to consume CONSECUTIVE free slots. Checking only the
   * first is how a 45-minute procedure gets booked over the end of the clinic.
   */
  it('consumes consecutive slots for a longer booking', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: '2027-03-01T04:00:00.000Z',
      durationMinutes: 45,
      visitType: 'PROCEDURE',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.scheduledEnd).toBe('2027-03-01T04:45:00.000Z');

    const after = await availability(A, orgA.branchId, doctorA, MONDAY);
    const taken = after.body.data.slots.filter(
      (s: { reason: string | null }) => s.reason === 'BOOKED'
    );
    // The first slot plus the three the procedure covers.
    expect(taken).toHaveLength(4);
  });

  it('refuses a booking that would run past the end of the clinic', async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      // 12:45 IST is the last slot; 60 minutes does not fit before 13:00.
      startsAt: '2027-03-01T07:15:00.000Z',
      durationMinutes: 60,
    });
    expect(res.status).toBe(400);
  });

  it('cancelling frees the slot, with no release step anywhere', async () => {
    const cancel = await A.post(`/${appointmentId}/cancel`, { reason: 'Patient rang to postpone' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');

    const res = await availability(A, orgA.branchId, doctorA, MONDAY);
    expect(res.body.data.slots[0].available).toBe(true);

    // And the freed slot is genuinely bookable again.
    const rebook = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: FIRST_SLOT,
    });
    expect(rebook.status).toBe(201);
    appointmentId = rebook.body.data.id as string;
  });
});

describe('the day board', () => {
  it('lists the day in time order with zero-filled counts', async () => {
    const res = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);

    expect(res.status).toBe(200);
    expect(res.body.data.appointments.length).toBeGreaterThan(0);
    // Zero-filled: a header that renders "Cancelled 3" one minute and nothing
    // the next reads as a bug in the board.
    expect(res.body.data.counts.NO_SHOW).toBe(0);
    expect(res.body.data.counts.CANCELLED).toBe(1);
  });

  /**
   * ⚠️ THE BOARD SAYS WHY A ROW IS STRUCK THROUGH, AND STILL NOT WHY THE PATIENT
   *   WAS COMING. Those are two different disclosures and only one of them
   *   belongs on a screen anybody at the desk can glance at.
   *
   *   Without `cancellationReason` here the only way to answer "why is this one
   *   cancelled?" is to open the visit — and THAT page carries `reason`, the
   *   chief complaint. The cheap question would force the expensive read, which
   *   is the opposite of what the split is for. `reason` staying absent is the
   *   half of this test that matters most.
   */
  it('carries the cancellation reason on the row, and never the chief complaint', async () => {
    const res = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    expect(res.status).toBe(200);

    const rows = res.body.data.appointments as {
      status: string;
      cancellationReason: string | null;
      reason?: string;
    }[];

    const cancelled = rows.filter((row) => row.status === 'CANCELLED');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.cancellationReason).toBe('Patient rang to postpone');

    // Null on every other status — not absent, and not the empty string.
    for (const row of rows.filter((r) => r.status !== 'CANCELLED')) {
      expect(row.cancellationReason).toBeNull();
    }

    // The board never carries the chief complaint, on any row.
    for (const row of rows) {
      expect(row.reason).toBeUndefined();
    }
  });

  /**
   * ⚠️ A FOLLOW-UP CONTINUES A VISIT THAT HAPPENED, and a cancelled booking is
   *   not one. It inherits the parent's episode, doctor and frozen fee because
   *   it is the next chapter of that consultation — hung off a booking nobody
   *   attended, it is a live appointment in a chain no screen can explain.
   *
   *   The same two statuses `POST /{id}/vitals` refuses on, and refused for the
   *   same reason. This is checked BEFORE availability, so the 409 does not
   *   depend on the slot being free.
   */
  it('refuses a follow-up booked off a visit that never went ahead', async () => {
    const res = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    const cancelledId = (res.body.data.appointments as { id: string; status: string }[]).find(
      (row) => row.status === 'CANCELLED'
    )?.id;
    expect(cancelledId).toBeDefined();

    const followUp = await A.post(`/${cancelledId}/follow-up`, {
      startsAt: '2027-03-08T03:30:00.000Z',
    });

    expect(followUp.status).toBe(409);
    expect(String(followUp.body.message)).toMatch(/did not go ahead/i);
  });

  /*
   * ⚠️ WITHOUT THIS THE CLIENT GUESSES, AND ITS GUESS IS THE CONTAINER'S UTC.
   *   `scheduledStart` is an instant; the wall-clock time a receptionist reads
   *   off it is that instant in the BRANCH's zone, and nothing in an ISO-8601
   *   string says which zone was meant. The consultation header formatted
   *   without one and rendered a 09:00 IST booking as 03:30.
   */
  it('carries the zone its times are to be read in', async () => {
    const res = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    expect(res.body.data.appointments[0].timezone).toBe('Asia/Kolkata');

    // And on the detail response, which is what the consultation page reads.
    const id = res.body.data.appointments[0].id as string;
    const one = await A.get(`/${id}`);
    expect(one.body.data.timezone).toBe('Asia/Kolkata');

    /*
     * The pair together is the actual contract: 09:00 at an IST branch is
     * 03:30Z, and it is only readable as "09:00" with the zone beside it.
     */
    const shown = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: one.body.data.timezone as string,
    }).format(new Date(one.body.data.scheduledStart as string));
    expect(shown).toBe('09:00');
  });

  /*
   * The row carries the patient's NAME — a desk that cannot see who is arriving
   * cannot work — but not the reason. Name plus reason on a screen anybody can
   * glance at is a diagnosis with extra steps.
   */
  it('carries the name but never the reason', async () => {
    const res = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    const body = JSON.stringify(res.body);

    expect(body).toContain(SUBJECT.lastName);
    expect(body).not.toContain(REASON);
  });

  it("shows another clinic nothing of this one's day", async () => {
    const res = await B.get(`/?branchId=${orgB.branchId}&date=${MONDAY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.appointments).toHaveLength(0);
  });

  /*
   * The week and month views are this same read with a wider bound. What is
   * worth testing is that the bound is INCLUSIVE of its last day and that the
   * span is capped — an uncapped range is every patient the clinic has seen.
   */
  it('widens to a range, inclusive of the last day', async () => {
    const day = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    const week = await A.get(`/?branchId=${orgA.branchId}&date=2027-02-28&to=2027-03-06`);

    expect(week.status).toBe(200);
    expect(week.body.data.appointments.length).toBe(day.body.data.appointments.length);

    // Ending the range the day BEFORE excludes them, which is what makes the
    // line above evidence of an inclusive bound rather than of a wide net.
    const before = await A.get(`/?branchId=${orgA.branchId}&date=2027-02-22&to=2027-02-28`);
    expect(before.body.data.appointments).toHaveLength(0);
  });

  it('refuses a range that runs backwards or too far', async () => {
    const backwards = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}&to=2027-02-01`);
    expect(backwards.status).toBe(400);

    const tooWide = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}&to=2027-12-31`);
    expect(tooWide.status).toBe(400);
  });
});

describe('the life of a booking', () => {
  let appointmentId: string;

  beforeAll(async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: SECOND_SLOT,
    });
    appointmentId = res.body.data.id as string;
  });

  it('refuses a jump that skips the middle', async () => {
    const res = await A.post(`/${appointmentId}/status`, { status: 'COMPLETED' });
    expect(res.status).toBe(409);
  });

  it('stamps the time when the patient checks in', async () => {
    const res = await A.post(`/${appointmentId}/status`, { status: 'CHECKED_IN' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CHECKED_IN');
    // The CHECK constraint refuses the row without it, and every waiting-time
    // report is silently wrong if it is missing.
    expect(res.body.data.checkedInAt).not.toBeNull();
  });

  /*
   * The edge the transition map exists for: somebody standing at the desk
   * cannot retrospectively not have turned up. Marking them absent instead of
   * cancelling is how a no-show fee reaches a patient who was there.
   */
  it('refuses NO_SHOW once the patient has checked in', async () => {
    const res = await A.post(`/${appointmentId}/no-show`, {});
    expect(res.status).toBe(409);
  });

  it('refuses to move a booking that is already under way', async () => {
    await A.post(`/${appointmentId}/status`, { status: 'IN_PROGRESS' });

    const res = await A.post(`/${appointmentId}/reschedule`, {
      startsAt: '2027-03-01T05:00:00.000Z',
    });
    expect(res.status).toBe(409);
  });

  it('completes, and records every step in order', async () => {
    const done = await A.post(`/${appointmentId}/status`, { status: 'COMPLETED' });
    expect(done.status).toBe(200);
    expect(done.body.data.completedAt).not.toBeNull();

    const detail = await A.get(`/${appointmentId}`);
    const steps = detail.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
    expect(steps).toEqual(['BOOKED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']);
    // The booking row is the only one with no `fromStatus`.
    expect(detail.body.data.statusHistory[0].fromStatus).toBeNull();
  });

  it('refuses to touch a completed booking at all', async () => {
    const res = await A.post(`/${appointmentId}/cancel`, { reason: 'Too late' });
    expect(res.status).toBe(409);
  });
});

describe('rescheduling', () => {
  let appointmentId: string;

  beforeAll(async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: '2027-03-01T05:30:00.000Z',
    });
    appointmentId = res.body.data.id as string;
  });

  it('moves the booking and frees the slot it left', async () => {
    const res = await A.post(`/${appointmentId}/reschedule`, {
      startsAt: '2027-03-01T06:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.scheduledStart).toBe('2027-03-01T06:00:00.000Z');

    const slots = (await availability(A, orgA.branchId, doctorA, MONDAY)).body.data.slots as {
      startsAt: string;
      available: boolean;
    }[];
    expect(slots.find((s) => s.startsAt === '2027-03-01T05:30:00.000Z')?.available).toBe(true);
    expect(slots.find((s) => s.startsAt === '2027-03-01T06:00:00.000Z')?.available).toBe(false);
  });

  it('refuses to move onto a slot somebody else holds', async () => {
    const res = await A.post(`/${appointmentId}/reschedule`, { startsAt: FIRST_SLOT });
    expect(res.status).toBe(409);
  });
});

describe('leave and closures', () => {
  it('removes the day once leave is APPROVED, and not before', async () => {
    const raise = await request(app)
      .post(`/api/v1/doctors/${doctorA}/exceptions`)
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${await tokenFor(SLUG_A)}`)
      .send({
        exceptionType: 'LEAVE',
        startsAt: '2027-03-08T00:00:00.000Z',
        endsAt: '2027-03-09T00:00:00.000Z',
        reason: 'Conference',
      });
    expect(raise.status).toBe(201);

    // ⚠️ REQUESTED changes nothing. Treating a request as a fact would let any
    // doctor empty their own diary.
    const before = await availability(A, orgA.branchId, doctorA, '2027-03-08');
    expect(before.body.data.slots.some((s: { available: boolean }) => s.available)).toBe(true);

    await request(app)
      .post(`/api/v1/doctors/${doctorA}/exceptions/${raise.body.data.id}/decision`)
      .set('Host', hostFor(SLUG_A))
      .set('Authorization', `Bearer ${await tokenFor(SLUG_A)}`)
      .send({ decision: 'APPROVED' });

    const after = await availability(A, orgA.branchId, doctorA, '2027-03-08');
    expect(after.body.data.slots.every((s: { available: boolean }) => !s.available)).toBe(true);
    expect(after.body.data.slots[0].reason).toBe('ON_LEAVE');
  });

  it('closes the whole day when the branch is shut', async () => {
    await owner.query(
      `INSERT INTO branch_closures (id, branch_id, closure_date, reason)
       VALUES (gen_random_uuid(), $1, '2027-03-15'::date, 'Holi')`,
      [orgA.branchId]
    );

    const res = await availability(A, orgA.branchId, doctorA, '2027-03-15');
    expect(res.body.data.slots.every((s: { available: boolean }) => !s.available)).toBe(true);
    expect(res.body.data.slots[0].reason).toBe('BRANCH_CLOSED');
  });
});

describe('the tenant boundary', () => {
  it("refuses to book one clinic's patient into another's diary", async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientB,
      doctorProfileId: doctorA,
      startsAt: '2027-03-01T06:30:00.000Z',
    });
    // The patient is invisible under org A's RLS, so it is a 404 — not a
    // foreign-key error, and never a 403.
    expect(res.status).toBe(404);
  });

  it("refuses to book against another clinic's doctor", async () => {
    const res = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorB,
      startsAt: '2027-03-01T06:30:00.000Z',
    });
    expect(res.status).toBe(404);
  });

  it("does not serve one clinic another's appointment by id", async () => {
    const mine = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    const id = mine.body.data.appointments[0].id as string;

    const res = await B.get(`/${id}`);
    expect(res.status).toBe(404);
  });
});

/*
 * Vitals: recording accumulates, correcting amends in place, and neither ever
 * lets a measurement reach the audit trail.
 */
describe('vitals', () => {
  let appointmentId: string;
  let readingId: string;

  beforeAll(async () => {
    const list = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    appointmentId = list.body.data.appointments[0].id as string;
  });

  it('records a reading', async () => {
    const res = await A.post(`/${appointmentId}/vitals`, {
      systolicMmHg: 180,
      diastolicMmHg: 110,
      pulseBpm: 96,
    });

    expect(res.status).toBe(201);
    readingId = res.body.data.id as string;
    expect(res.body.data.systolicMmHg).toBe(180);
  });

  /*
   * ⚠️ THE READING THAT PROMPTED THE INTERVENTION STAYS ON THE CHART. A repeat
   *   blood pressure twenty minutes after a high first one is a SECOND
   *   observation; if it replaced the first, the record could no longer explain
   *   why the patient was sat down. Correcting is a different act — see below.
   */
  it('keeps a repeat as a second reading rather than replacing the first', async () => {
    await A.post(`/${appointmentId}/vitals`, { systolicMmHg: 150, diastolicMmHg: 95 });

    const res = await A.get(`/${appointmentId}/vitals`);
    expect(res.body.data.vitals).toHaveLength(2);
    // Oldest first, so the one that mattered is still the one at the top.
    expect(res.body.data.vitals[0].systolicMmHg).toBe(180);
    expect(res.body.data.vitals[1].systolicMmHg).toBe(150);
  });

  it('corrects a mistyped value in place, without adding a reading', async () => {
    const res = await A.put(`/${appointmentId}/vitals/${readingId}`, {
      systolicMmHg: 120,
      diastolicMmHg: 80,
      pulseBpm: 96,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.systolicMmHg).toBe(120);
    expect(res.body.data.id).toBe(readingId);

    const list = await A.get(`/${appointmentId}/vitals`);
    expect(list.body.data.vitals).toHaveLength(2);
  });

  /*
   * ⚠️ A REPLACEMENT, NOT A MERGE. The form arrives populated, so a box left
   *   empty means "not measured" — the same thing it means when the reading is
   *   first taken. A merge would leave a wrongly-entered value unclearable.
   */
  it('clears a measurement the correction leaves out', async () => {
    const res = await A.put(`/${appointmentId}/vitals/${readingId}`, {
      systolicMmHg: 120,
      diastolicMmHg: 80,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.pulseBpm).toBeNull();
  });

  /*
   * ⚠️ THE VALUES, WHICH `audit_logs` DELIBERATELY CANNOT CARRY. A medical record
   *   has to answer "who changed this blood pressure from 180 to 120, and when"
   *   years later. The audit row says an amendment happened and which
   *   measurements moved; this says what they were, from the clinical side.
   */
  /* Newest first: "what changed last?" is the question somebody opening a trail
     has, and it is the same order the audit drawer uses. */
  it('lists the newest correction first', async () => {
    const res = await A.get(`/${appointmentId}/vitals/${readingId}/revisions`);
    const times = (res.body.data.revisions as { supersededAt: string }[]).map((r) =>
      Date.parse(r.supersededAt)
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('keeps both values of every measurement that was corrected', async () => {
    const res = await A.get(`/${appointmentId}/vitals/${readingId}/revisions`);

    expect(res.status).toBe(200);
    // Two corrections have been made above. NEWEST FIRST, so the one that fixed
    // the blood pressure is the LAST entry, not the first.
    expect(res.body.data.revisions).toHaveLength(2);

    const first = res.body.data.revisions[1] as {
      changes: { field: string; before: number | null; after: number | null }[];
      supersededByName: string | null;
      supersededAt: string;
    };

    expect(first.changes).toEqual(
      expect.arrayContaining([
        { field: 'systolicMmHg', before: 180, after: 120 },
        { field: 'diastolicMmHg', before: 110, after: 80 },
      ])
    );
    // Who corrected it, which is a different question from who took it.
    expect(first.supersededByName).not.toBeNull();
    expect(Date.parse(first.supersededAt)).not.toBeNaN();
  });

  /*
   * ⚠️ A SUPERSEDED VERSION IS NOT AN OBSERVATION. It lives on the same table, so
   *   a chart query that forgets `revision_of_id IS NULL` shows one blood
   *   pressure once per time somebody fixed a typo in it — each copy looking
   *   exactly like a repeat measurement.
   */
  it('keeps superseded versions off the chart', async () => {
    const res = await A.get(`/${appointmentId}/vitals`);
    // Still the two real readings, after two corrections to one of them.
    expect(res.body.data.vitals).toHaveLength(2);
  });

  /* A cleared box is a real change, and the trail has to say so — otherwise a
     measurement can be removed from a record with nothing recording it. */
  it('reports a cleared measurement as a change to null', async () => {
    const res = await A.get(`/${appointmentId}/vitals/${readingId}/revisions`);
    const revisions = res.body.data.revisions as {
      changes: { field: string; before: number | null; after: number | null }[];
    }[];

    // The second correction above dropped `pulseBpm` by leaving it out — and
    // newest first means it is at the top.
    const second = revisions[0];
    expect(second?.changes).toEqual(
      expect.arrayContaining([{ field: 'pulseBpm', before: 96, after: null }])
    );
  });

  it("shows another clinic nothing of this reading's corrections", async () => {
    const res = await B.get(`/${appointmentId}/vitals/${readingId}/revisions`);
    expect(res.status).toBe(404);
  });

  it("refuses an id belonging to another visit's reading", async () => {
    const other = await A.post('/', {
      branchId: orgA.branchId,
      patientId: patientA,
      doctorProfileId: doctorA,
      startsAt: '2027-03-22T03:30:00.000Z',
    });
    const otherId = other.body.data.id as string;

    // The path says one appointment, the reading belongs to another.
    const res = await A.put(`/${otherId}/vitals/${readingId}`, { pulseBpm: 70 });
    expect(res.status).toBe(404);
  });

  it('shows another clinic nothing, and lets it correct nothing', async () => {
    const res = await B.put(`/${appointmentId}/vitals/${readingId}`, { pulseBpm: 70 });
    expect(res.status).toBe(404);
  });

  /*
   * ⚠️ THE WHOLE POINT OF `snapshot()`. An audit trail is read by compliance
   *   staff who have no business reading a patient's numbers, and an amendment
   *   is where the naive implementation is most tempting — a before/after of the
   *   VALUES is exactly what a diff wants to show. What the row may say is WHICH
   *   measurements moved.
   */
  it('records which measurements changed and never what they were', async () => {
    const rows = await owner.query<{
      before_data: Record<string, unknown> | null;
      after_data: Record<string, unknown> | null;
    }>(
      `SELECT before_data, after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'appointment_vital'`,
      [orgA.organizationId]
    );

    /*
     * ⚠️ AN ALLOW-LIST OF KEYS, NOT A GREP FOR THE NUMBERS. Searching the JSON
     *   text for "120" would pass by luck and fail by luck — a uuid containing
     *   those three digits is perfectly possible. This asserts the SHAPE: if a
     *   measurement column ever reaches `snapshot()`, its key appears here and
     *   this fails, whatever the value happened to be.
     */
    const ALLOWED = new Set([
      'appointment_id',
      'patient_id',
      'recorded_at',
      'observations',
      'has_note',
      'amended',
    ]);

    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      for (const blob of [row.before_data, row.after_data]) {
        if (blob === null) continue;
        expect(Object.keys(blob).filter((key) => !ALLOWED.has(key))).toEqual([]);
      }
    }

    const amended = await owner.query<{ after_data: { amended?: string[] } }>(
      `SELECT after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'appointment_vital' AND action = 'UPDATE'
        ORDER BY occurred_at ASC LIMIT 1`,
      [orgA.organizationId]
    );

    // The names of what moved, so the trail can answer "the blood pressure on
    // this visit was corrected, by whom, and when".
    expect(amended.rows[0]?.after_data.amended).toEqual(
      expect.arrayContaining(['systolic_mm_hg', 'diastolic_mm_hg'])
    );
  });
});

describe('the two trails', () => {
  let appointmentId: string;

  beforeAll(async () => {
    const list = await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    appointmentId = list.body.data.appointments[0].id as string;
  });

  it('records a VIEW naming the patient when one booking is opened', async () => {
    await clearAccessDedupe();
    await A.get(`/${appointmentId}`);

    const rows = await owner.query(
      `SELECT access_type, resource, patient_id, route
         FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'APPOINTMENT'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].access_type).toBe('VIEW');
    expect(rows.rows[0].patient_id).toBe(patientA);
    // ⚠️ The PATTERN, never the URL.
    expect(rows.rows[0].route).toBe('GET /v1/appointments/:appointmentId');
  });

  /*
   * The day board deliberately writes nothing. It is polled, and logging it
   * would turn a table meant to answer "who read this patient's file?" into a
   * per-refresh firehose — which is the same as not having it.
   */
  it('writes nothing for the day board', async () => {
    const countRows = async (): Promise<number> => {
      const rows = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM data_access_logs
          WHERE organization_id = $1 AND resource = 'APPOINTMENT'`,
        [orgA.organizationId]
      );
      return rows.rows[0]?.n ?? 0;
    };

    const before = await countRows();
    await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    await A.get(`/?branchId=${orgA.branchId}&date=${MONDAY}`);
    expect(await countRows()).toBe(before);
  });

  /*
   * ⚠️ THE MEASUREMENT, not a promise. The allow-list snapshot is the only thing
   *   keeping a chief complaint out of `audit_logs` — `reason` is deliberately
   *   NOT in `REDACTED_KEYS`, because `doctor_schedule_exceptions.reason` is
   *   "annual leave" and blanket-redacting the key would gut that trail.
   */
  it('lets no name and no reason reach the audit trail', async () => {
    const rows = await owner.query<{ blob: string }>(
      `SELECT coalesce(before_data::text, '') || coalesce(after_data::text, '') AS blob
         FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'appointment'`,
      [orgA.organizationId]
    );

    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.blob).not.toContain(SUBJECT.firstName);
      expect(row.blob).not.toContain(SUBJECT.lastName);
      expect(row.blob).not.toContain(REASON);
      expect(row.blob).not.toContain('Patient rang to postpone');
    }
  });

  /*
   * Append-only, layer two: the REVOKE. Layer one is the rule in the migration.
   * Verified against the catalogue rather than by attempting a write, because
   * the DO INSTEAD NOTHING rule makes a forbidden UPDATE succeed silently — it
   * simply changes nothing — which is exactly why both layers exist.
   */
  it('never lets the app role rewrite the status trail', async () => {
    const rows = await owner.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'rcln_app'
          AND table_name = 'appointment_status_history'
          AND privilege_type IN ('UPDATE', 'DELETE')`
    );
    expect(rows.rowCount).toBe(0);
  });
});

/**
 * One patient's own bookings — the Appointments tab on the chart.
 *
 * Three things are pinned here, and none of them is "the list works":
 *
 *   1. IT PAGES RATHER THAN RANGING. The day board is capped at 45 days because
 *      an unbounded range there is every patient the clinic has seen. A history
 *      is unbounded in time by definition, so the bound has to be the page.
 *   2. IT STILL CARRIES NO CHIEF COMPLAINT. Same split as the board: this is
 *      `appointment.read`, and `reason` stays behind the endpoint that logs its
 *      disclosure.
 *   3. IT LOGS, WHERE THE BOARD DOES NOT. The question was asked about ONE named
 *      patient, which is the line `data_access_logs` is drawn on.
 */
describe("a patient's own bookings", () => {
  it('lists them newest first, and never the chief complaint', async () => {
    const res = await A.patientsGet(`/${patientA}/appointments?page=1&pageSize=50`);

    expect(res.status).toBe(200);
    expect(res.body.data.patientId).toBe(patientA);

    const rows = res.body.data.appointments as { scheduledStart: string; reason?: string }[];
    expect(rows.length).toBeGreaterThan(1);

    /* ISO-8601 with a `Z` sorts lexicographically as it sorts chronologically —
       a property of the format, which is why this comparison is honest. */
    const starts = rows.map((row) => row.scheduledStart);
    expect(starts).toEqual([...starts].sort().reverse());

    for (const row of rows) expect(row.reason).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(REASON);
  });

  it('pages, and the second page is not the first', async () => {
    const first = await A.patientsGet(`/${patientA}/appointments?page=1&pageSize=1`);
    expect(first.body.data.appointments).toHaveLength(1);
    expect(first.body.data.total).toBeGreaterThan(1);

    const second = await A.patientsGet(`/${patientA}/appointments?page=2&pageSize=1`);
    expect(second.body.data.appointments[0].id).not.toBe(first.body.data.appointments[0].id);
  });

  /*
   * ⚠️ 404, NOT AN EMPTY LIST. "This patient has no bookings" and "this patient
   *   is not yours" are different answers, and returning the first for the
   *   second is how a tenancy bug goes unnoticed for a year.
   */
  it("answers another clinic 404 for this clinic's patient", async () => {
    const res = await B.patientsGet(`/${patientA}/appointments`);
    expect(res.status).toBe(404);
  });

  it('records the read against the patient, as a SEARCH', async () => {
    await clearAccessDedupe();
    await A.patientsGet(`/${patientA}/appointments`);

    const rows = await owner.query(
      `SELECT access_type, resource, patient_id, route
         FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'APPOINTMENT'
        ORDER BY occurred_at DESC LIMIT 1`,
      [orgA.organizationId]
    );

    expect(rows.rowCount).toBe(1);
    /* SEARCH, never VIEW — a SEARCH is not deduplicated, and somebody reading
       one patient's history eleven times is itself the signal. */
    expect(rows.rows[0].access_type).toBe('SEARCH');
    expect(rows.rows[0].patient_id).toBe(patientA);
    // ⚠️ The PATTERN, never the URL.
    expect(rows.rows[0].route).toBe('GET /v1/patients/:patientId/appointments');
  });
});
