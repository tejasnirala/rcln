/**
 * Visit history, the previous-visit panel and the referral lookup, over real
 * HTTP (CE-5).
 *
 * Beyond "the endpoints respond", these are the things pinned down here, and
 * every one of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ TWO DISCLOSURE CLASSES, TWO CODES (CD-14). The episode endpoint is
 *      `appointment.read` and carries no diagnosis; the visit history is
 *      `clinical.encounter.read` and does. A caller holding only the first must
 *      be refused the second, or the front desk reads the chart through the
 *      booking screen.
 *
 *   2. ⚠️ A WALK-IN APPEARS ON THE TIMELINE (CD-1). It has no appointment, so a
 *      history assembled from `appointments` alone omits it entirely — and
 *      omitting a visit from a clinical history is the failure mode that made
 *      `encounters` its own table.
 *
 *   3. ⚠️ AN AMENDED ORIGINAL STAYS AND A CANCELLED DRAFT GOES. A superseded
 *      record is what was concluded before the correction; an abandoned draft
 *      was never a record of anything.
 *
 *   4. ⚠️ THE PREVIOUS VISIT SAYS HOW IT WAS FOUND. `PARENT_APPOINTMENT` is a
 *      fact the database enforces and `MOST_RECENT` is a convenience; a screen
 *      told only "here is the last visit" would present an unrelated visit as
 *      the one being followed up.
 *
 *   5. ⚠️ A DRAFT IS NEVER "LAST TIME", AND THE CURRENT VISIT IS NOT ITS OWN
 *      HISTORY. Both are `FINALIZED`/`AMENDED`-only filters, and the second is
 *      an explicit exclusion rather than an accident of ordering.
 *
 *   6. ⚠️ THE REFERRAL LOOKUP REFUSES TO ENUMERATE. `search` is required with a
 *      two-character minimum — that is what lets it sit behind the authoring
 *      code rather than the directory one, and a form of it that answered "who
 *      works here" would re-open the door `roles.ts` deliberately closed.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `v${Date.now().toString(36)}`;
const SLUG = `vh-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let membershipId: string;
let doctorProfileId: string;
let patientId: string;

/** Journey A: two booked visits, the second a follow-up of the first. */
let episodeA: string;
let firstAppointmentId: string;
let secondAppointmentId: string;
let firstEncounterId: string;

/** Journey B: one walk-in consultation, no booking at all. */
let episodeB: string;

let diagnosisItemId: string;

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

async function clearAccessCache(): Promise<void> {
  const keys = await redis.keys('access:*');
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * ⚠️ THE SUPPORTED WIDENING, NOT A TEST SHORTCUT. `roles.ts` says a clinic that
 *   wants somebody other than a seeded DOCTOR to write up a consultation grants
 *   the codes per membership; the fixture takes the same path a clinic would.
 */
async function grant(codes: string[]): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'visit history test'
       FROM permissions p
      WHERE p.code = ANY($3)`,
    [membershipId, org.organizationId, codes]
  );
  await clearAccessCache();
}

/**
 * Take a code away from the owner, who otherwise holds everything except the
 * authoring ones. This is how the two-disclosure-class split is testable at all.
 *
 * ⚠️ AN UPSERT, NOT AN INSERT. `membership_permission_overrides` is unique on
 *   (membership, permission, branch) — the branch half included, `NULLS NOT
 *   DISTINCT`, so an org-wide override collides with itself — and `grant` above
 *   has already written a GRANT row
 *   for every authoring code — so denying one of THOSE is a flip rather than a
 *   new row, and a plain INSERT is a duplicate-key error in the middle of a
 *   test that is about permissions.
 */
async function deny(code: string): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'DENY', 'visit history test'
       FROM permissions p
      WHERE p.code = $3
     ON CONFLICT (membership_id, permission_id, branch_id)
       DO UPDATE SET effect = 'DENY'`,
    [membershipId, org.organizationId, code]
  );
  await clearAccessCache();
}

/**
 * Put it back the way it was.
 *
 * ⚠️ `restoreGrant` IS NOT A CONVENIENCE. An authoring code was held through an
 *   explicit GRANT row and a read code is held through the role — so deleting
 *   the override restores the second and REVOKES the first. Getting this wrong
 *   leaves every later test in the file running without authoring.
 */
async function undeny(code: string, restoreGrant = false): Promise<void> {
  if (restoreGrant) {
    await owner.query(
      `UPDATE membership_permission_overrides o
          SET effect = 'GRANT'
         FROM permissions p
        WHERE o.permission_id = p.id
          AND o.membership_id = $1
          AND p.code = $2`,
      [membershipId, code]
    );
  } else {
    await owner.query(
      `DELETE FROM membership_permission_overrides o
         USING permissions p
        WHERE o.permission_id = p.id
          AND o.membership_id = $1
          AND o.effect = 'DENY'
          AND p.code = $2`,
      [membershipId, code]
    );
  }
  await clearAccessCache();
}

const api =
  (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (path: string, body?: object) => {
    const r = request(app)
      [method](`/api/v1${path}`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? r : r.send(body);
  };

const get = api('get');
const post = api('post');
const patch = api('patch');
const put = api('put');

/** A booking on a journey, checked in and ready for a consultation. */
async function makeAppointment(
  episodeId: string,
  number: string,
  offsetDays: number,
  parentId: string | null
): Promise<string> {
  const registration = await owner.query<{ id: string }>(
    `SELECT id FROM patient_registrations WHERE patient_id = $1 LIMIT 1`,
    [patientId]
  );
  const row = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, visit_type, checked_in_at,
        parent_appointment_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7,
             now() + ($8 || ' days')::interval,
             now() + ($8 || ' days')::interval + interval '15 minutes',
             'CHECKED_IN', $9::"AppointmentVisitType", now(), $10, now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      registration.rows[0]!.id,
      doctorProfileId,
      episodeId,
      number,
      String(offsetDays),
      parentId === null ? 'NEW' : 'FOLLOW_UP',
      parentId,
    ]
  );
  return row.rows[0]!.id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'History'));

  await clearRateLimits();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier: `${SLUG}@example.test`, password: PASSWORD });
  token = login.body.data.accessToken as string;

  const membership = await owner.query<{ id: string }>(
    `SELECT id FROM memberships WHERE user_id = $1 AND organization_id = $2`,
    [org.ownerUserId, org.organizationId]
  );
  membershipId = membership.rows[0]!.id;
  await grant([
    'clinical.encounter.create',
    'clinical.encounter.close',
    'clinical.encounter.amend',
  ]);

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctor.rows[0]!.id;

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'VHUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;

  await owner.query(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'VHMRN1', now())`,
    [org.organizationId, patientId, org.branchId]
  );

  const a = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, title, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'VHEP0001', DATE '2027-05-01', 'Journey A', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );
  episodeA = a.rows[0]!.id;

  const b = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'VHEP0002', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );
  episodeB = b.rows[0]!.id;

  const item = await owner.query<{ id: string }>(
    `INSERT INTO clinical_master_items
       (id, organization_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'DIAGNOSIS', 'VH_CARIES', 'Dental caries', now())
     RETURNING id`,
    [org.organizationId]
  );
  diagnosisItemId = item.rows[0]!.id;

  firstAppointmentId = await makeAppointment(episodeA, 'VHAPT0001', -30, null);
  secondAppointmentId = await makeAppointment(episodeA, 'VHAPT0002', 0, firstAppointmentId);

  /* The first visit, written up and signed: this is the one everything else
     looks back at. */
  const opened = await post('/encounters', { appointmentId: firstAppointmentId });
  firstEncounterId = opened.body.data.id as string;
  await post(`/encounters/${firstEncounterId}/diagnoses`, {
    itemId: diagnosisItemId,
    role: 'PRIMARY',
  });
  /*
   * ⚠️ THE SEEDED TEMPLATE REQUIRES BOTH OF THESE, AND FINALIZATION ENFORCES IT
   *   (CE-4). A fixture that skipped them would leave the encounter a DRAFT, and
   *   every assertion below about "the previous visit" would pass vacuously
   *   against a null — which is exactly how a fixture stops testing anything.
   */
  await patch(`/encounters/${firstEncounterId}`, {
    chiefComplaint: 'Pain in the lower left molar',
  });
  await put(`/encounters/${firstEncounterId}/follow-up`, {
    isRequired: true,
    intervalValue: 15,
    intervalUnit: 'DAYS',
    followUpType: 'ROUTINE',
  });

  const signed = await post(`/encounters/${firstEncounterId}/finalize`);
  if (signed.status !== 200) {
    throw new Error(`finalize failed ${signed.status}: ${JSON.stringify(signed.body)}`);
  }
}, 60_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);
  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM data_access_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

// ---------------------------------------------------------------------------

describe('visit history', () => {
  it('groups visits by journey, newest journey first', async () => {
    const res = await get(`/patients/${patientId}/visit-history`);
    expect(res.status).toBe(200);

    const codes = res.body.data.episodes.map((e: { code: string }) => e.code);
    /* B opened in June, A in May — newest journey first (§18). */
    expect(codes).toEqual(['VHEP0002', 'VHEP0001']);

    const journeyA = res.body.data.episodes.find(
      (e: { code: string }) => e.code === 'VHEP0001'
    ) as { visits: { appointmentNumber: string | null }[] };
    /* Oldest first WITHIN a journey — the order a course of treatment reads in. */
    expect(journeyA.visits.map((v) => v.appointmentNumber)).toEqual(['VHAPT0001', 'VHAPT0002']);
  });

  it('carries the diagnosis and the counts, and not the prescription lines', async () => {
    const res = await get(`/patients/${patientId}/visit-history`);
    const first = res.body.data.episodes
      .flatMap((e: { visits: unknown[] }) => e.visits)
      .find((v: { appointmentNumber: string | null }) => v.appointmentNumber === 'VHAPT0001') as {
      encounter: { diagnoses: string[]; prescriptionCount: number };
    };

    expect(first.encounter.diagnoses).toEqual(['Dental caries']);
    expect(first.encounter.prescriptionCount).toBe(0);
    /* ⚠️ COUNTS, NOT ROWS. A timeline entry answers what the visit was about;
       every prescription line of every visit would grow without bound and
       disclose more than the screen renders. */
    expect(first.encounter).not.toHaveProperty('prescriptions');
  });

  it('shows a booking with no consultation as a booking with no consultation', async () => {
    const res = await get(`/patients/${patientId}/visit-history`);
    const second = res.body.data.episodes
      .flatMap((e: { visits: unknown[] }) => e.visits)
      .find((v: { appointmentNumber: string | null }) => v.appointmentNumber === 'VHAPT0002') as {
      encounter: unknown;
    };
    expect(second.encounter).toBeNull();
  });

  /**
   * ⚠️ CD-1 — A WALK-IN HAS NO BOOKING AND MUST STILL APPEAR. A history built
   *   from `appointments` alone silently omits every walk-in, which is exactly
   *   the fact that made `encounters` a separate table from `appointments`.
   */
  it('includes a walk-in consultation that has no appointment', async () => {
    const walkIn = await post('/encounters', {
      patientId,
      clinicalEpisodeId: episodeB,
      branchId: org.branchId,
      doctorProfileId,
    });
    expect(walkIn.status).toBe(201);

    const res = await get(`/patients/${patientId}/visit-history`);
    const journeyB = res.body.data.episodes.find(
      (e: { code: string }) => e.code === 'VHEP0002'
    ) as { visits: { appointmentId: string | null; encounter: { id: string } | null }[] };

    expect(journeyB.visits).toHaveLength(1);
    expect(journeyB.visits[0]!.appointmentId).toBeNull();
    expect(journeyB.visits[0]!.encounter?.id).toBe(walkIn.body.data.id);
  });

  /**
   * ⚠️ 404 FOR A PATIENT RLS CANNOT SEE, NOT AN EMPTY HISTORY. "No visits" and
   *   "not your patient" are different answers, and returning the first for the
   *   second is how a tenancy bug goes unnoticed for a year.
   */
  it('404s for a patient that does not exist', async () => {
    const res = await get(`/patients/00000000-0000-4000-8000-000000000000/visit-history`);
    expect(res.status).toBe(404);
  });

  /**
   * ⚠️ CD-14 — THE EPISODE ENDPOINT AND THE VISIT HISTORY ARE TWO DISCLOSURE
   *   CLASSES. The front desk books against the first and holds no clinical code
   *   at all; the second carries diagnoses. Fusing them would hand the desk the
   *   chart through the booking screen.
   */
  it('refuses a caller who may read bookings but not consultations', async () => {
    await deny('clinical.encounter.read');
    try {
      const history = await get(`/patients/${patientId}/visit-history`);
      expect(history.status).toBe(403);

      const episode = await get(`/clinical-episodes/${episodeA}`);
      expect(episode.status).toBe(200);
      /* And what it answers carries no diagnosis at all. */
      expect(JSON.stringify(episode.body.data)).not.toContain('Dental caries');
    } finally {
      await undeny('clinical.encounter.read');
    }
  });
});

describe('the previous visit', () => {
  /**
   * ⚠️ §37 — THE VISIT THIS ONE WAS BOOKED FROM IS A FACT, and the response says
   *   so. `parent_appointment_id` is composite-FK'd; nothing here is inferred.
   */
  it('finds the parent appointment and says that is what it found', async () => {
    const res = await get(`/appointments/${secondAppointmentId}/previous-visit`);
    expect(res.status).toBe(200);
    expect(res.body.data.previous.source).toBe('PARENT_APPOINTMENT');
    expect(res.body.data.previous.appointmentNumber).toBe('VHAPT0001');
    expect(res.body.data.previous.encounter.id).toBe(firstEncounterId);
  });

  it('carries the whole content of that visit, not counts', async () => {
    const res = await get(`/appointments/${secondAppointmentId}/previous-visit`);
    /* ⚠️ THE OPPOSITE OF THE TIMELINE, AND RIGHT FOR THE OPPOSITE REASON: the
       panel exists so a doctor can see the dose without leaving the record they
       are writing. It is one visit, so it is bounded. */
    expect(res.body.data.previous.content.diagnoses).toHaveLength(1);
    expect(res.body.data.previous.content.diagnoses[0].item.name).toBe('Dental caries');
  });

  /**
   * ⚠️ THE CURRENT VISIT IS NOT ITS OWN HISTORY. Without the explicit exclusion
   *   the first appointment's own signed record answers "what happened last
   *   time" for the first appointment.
   */
  it('never answers with the visit being asked about', async () => {
    const res = await get(`/appointments/${firstAppointmentId}/previous-visit`);
    expect(res.status).toBe(200);
    expect(res.body.data.previous).toBeNull();
  });

  /**
   * ⚠️ A DRAFT IS NEVER "LAST TIME". Showing one would present an unsigned,
   *   half-typed record as clinical history.
   */
  it('ignores a draft consultation', async () => {
    const third = await makeAppointment(episodeA, 'VHAPT0003', 1, secondAppointmentId);
    /* The second visit gets a draft and is never signed. */
    await post('/encounters', { appointmentId: secondAppointmentId });

    const res = await get(`/appointments/${third}/previous-visit`);
    expect(res.status).toBe(200);
    /* Still the FIRST visit — the only signed record on the journey. */
    expect(res.body.data.previous.encounter.id).toBe(firstEncounterId);
  });

  it('404s for an appointment that does not exist', async () => {
    const res = await get(`/appointments/00000000-0000-4000-8000-000000000000/previous-visit`);
    expect(res.status).toBe(404);
  });
});

describe('referral targets', () => {
  /**
   * ⚠️ A LOOKUP, NOT AN ENUMERATION, AND THAT IS THE WHOLE REASON IT CAN SIT
   *   BEHIND THE AUTHORING CODE. A DOCTOR does not hold `doctor.directory.read`
   *   because the roster is a personnel list; a form of this call that answered
   *   "who works here" would re-open exactly that door.
   */
  it('refuses to answer without a search term', async () => {
    const res = await get('/doctors/referral-targets');
    expect(res.status).toBe(400);
  });

  it('refuses a one-character term', async () => {
    const res = await get('/doctors/referral-targets?search=H');
    expect(res.status).toBe(400);
  });

  it('finds a colleague by name and answers a name and a specialty only', async () => {
    const res = await get('/doctors/referral-targets?search=History');
    expect(res.status).toBe(200);
    expect(res.body.data.targets.length).toBeGreaterThan(0);

    const target = res.body.data.targets[0] as Record<string, unknown>;
    expect(Object.keys(target).sort()).toEqual(['doctorProfileId', 'name', 'specialtyName']);
    /* No schedule, no contact, no registration number, no fees, no status. */
    expect(target).not.toHaveProperty('registrationNumber');
  });

  /**
   * ⚠️ IT IS THE AUTHORING CODE AND NOT THE DIRECTORY ONE, so a caller who has
   *   had authoring taken away is refused even though they run the clinic.
   */
  it('refuses a caller without the authoring code', async () => {
    await deny('clinical.encounter.create');
    try {
      const res = await get('/doctors/referral-targets?search=History');
      expect(res.status).toBe(403);
    } finally {
      await undeny('clinical.encounter.create', true);
    }
  });

  it('attaches a colleague to a referral on the consultation', async () => {
    const draft = await post('/encounters', { appointmentId: secondAppointmentId });
    const encounterId = draft.body.data.id as string;

    const added = await post(`/encounters/${encounterId}/referrals`, { doctorProfileId });
    expect(added.status).toBe(201);
    expect(added.body.data.referrals[0].doctorProfileId).toBe(doctorProfileId);
    expect(added.body.data.referrals[0].doctorName).toBe('History Owner');
  });
});
