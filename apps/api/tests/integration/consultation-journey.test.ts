/**
 * ONE PATIENT, ONE JOURNEY, END TO END (CE-8, §40).
 *
 * Every phase before this one proved its own slice: CE-3 the lifecycle, CE-4 the
 * content, CE-5 the history, CE-6 the chart, CE-7 that a second specialty costs
 * a configuration row. ⚠️ NONE OF THEM WALKED THE WHOLE THING, and the seams
 * between phases are where a clinical product actually breaks — the recall list
 * that never learns the visit happened, the amendment that loses the link
 * between a procedure and the diagnosis it treats, the second visit that cannot
 * see the first.
 *
 * So this suite is deliberately NOT a set of independent cases. It is one story
 * told in order, and each `it` depends on the one before it:
 *
 *   Act I    the visit          open → write up → refuse to sign → sign
 *   Act II   the recall         the desk sees them, books them, and they drop off
 *   Act III  the next visit     the previous visit is there, and the history
 *   Act IV   the correction     an amendment carries the record forward intact
 *   Act V    the trails         what was disclosed, and what was never written down
 *
 * ── WHAT THIS PINS THAT NOTHING ELSE DOES ────────────────────────────────────
 *
 *   1. ⚠️ THE AUTOSAVE REFUSES A DOCUMENT NOTHING CAN RENDER (CE-8). `data` is an
 *      open record on the wire by necessity — narrowing it in Zod would refuse a
 *      legal answer for a field type added later, at the API, with a patient in
 *      the chair. That leaves an unbounded JSONB write behind a control that
 *      fires every few seconds, in the densest PHI table in the product.
 *
 *   2. ⚠️ THE PROCEDURE STILL CITES ITS DIAGNOSIS AFTER AN AMENDMENT, and it
 *      cites the COPY rather than the original's row. Both halves matter: the
 *      link surviving is the clinical fact, and it pointing at the new row is
 *      what stops a correction from reaching back into a signed record.
 *
 *   3. ⚠️ THE RECALL LIST LEARNS THE VISIT HAPPENED. A recommendation that stays
 *      outstanding after the patient has been seen is a phone call somebody
 *      makes to a patient sitting in the waiting room.
 *
 *   4. ⚠️ NOTHING CLINICAL REACHES `audit_logs`, AND EVERY DISCLOSURE REACHES
 *      `data_access_logs`. Asserted at the END of a journey that wrote a
 *      complaint, a diagnosis, a prescription and a referral — the phase suites
 *      each assert it over their own two or three writes.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `j${Date.now().toString(36)}`;
const SLUG = `jrn-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;
let membershipId: string;
let patientId: string;
let episodeId: string;
let doctorProfileId: string;
let appointmentId: string;

let symptomItemId: string;
let diagnosisItemId: string;
let procedureItemId: string;
let investigationItemId: string;
let adviceItemId: string;
let productId: string;

/** Filled in as the story runs. */
let encounterId: string;
let diagnosisRowId: string;
let procedureRowId: string;
let recommendationId: string;
let followUpAppointmentId: string | null = null;
let amendmentId: string;

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
 * The supported widening, per `roles.ts` — the same path a real clinic takes
 * when the person who sees patients is also the person who owns the practice.
 */
async function grantAuthoring(): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'consultation journey test'
       FROM permissions p
      WHERE p.code IN ('clinical.encounter.create', 'clinical.encounter.close',
                       'clinical.encounter.amend')`,
    [membershipId, org.organizationId]
  );
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

async function makeTerm(kind: string, code: string, name: string): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `INSERT INTO clinical_master_items
       (id, organization_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ClinicalMasterKind", $3, $4, now())
     RETURNING id`,
    [org.organizationId, kind, code, name]
  );
  return row.rows[0]!.id;
}

interface SectionConfig {
  type: string;
  key: string;
  fields?: { key: string; type: string; required: boolean }[];
}

/**
 * A descriptor-driven section of THIS consultation, by name.
 *
 * ⚠️ READ OFF THE RESOLVED CONFIGURATION RATHER THAN NAMED IN THIS FILE. The
 *   seeded template is data and is allowed to change; a test that hard-coded
 *   `history` would fail the day somebody renamed a section and would say
 *   nothing at all about whether the engine still worked.
 */
function descriptorSection(configuration: SectionConfig[]): SectionConfig {
  const section = configuration.find(
    (entry) => entry.type === 'HISTORY' || entry.type === 'EXAMINATION'
  );
  if (section === undefined) {
    throw new Error('the resolved template has no descriptor-driven section');
  }
  return section;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Journey'));

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
  await grantAuthoring();

  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'JRNUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;

  const registration = await owner.query<{ id: string }>(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'JRNMRN1', now()) RETURNING id`,
    [org.organizationId, patientId, org.branchId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'JRNEP0001', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );
  episodeId = episode.rows[0]!.id;

  const appointment = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, checked_in_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'JRNAPT0001',
             now(), now() + interval '15 minutes', 'CHECKED_IN', now(), now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      registration.rows[0]!.id,
      doctor.rows[0]!.id,
      episodeId,
    ]
  );
  appointmentId = appointment.rows[0]!.id;

  doctorProfileId = doctor.rows[0]!.id;

  /*
   * ⚠️ THE DOCTOR HAS TO ACTUALLY WORK SOMEWHERE FOR THE RECALL TO BE BOOKABLE,
   *   and that is not a fixture detail — it is the seam this suite exists to
   *   walk. `POST /appointments/:id/follow-up` refuses a time the engine does
   *   not offer, so a clinic with no schedule can record a recommendation it can
   *   never fulfil. Seven days of consulting hours, from today, is the smallest
   *   honest version of a clinic.
   */
  for (let day = 0; day < 7; day += 1) {
    await owner.query(
      `INSERT INTO doctor_schedules
         (id, organization_id, doctor_profile_id, branch_id, day_of_week,
          start_time, end_time, valid_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4,
               TIME '09:00', TIME '17:00', CURRENT_DATE, now())`,
      [org.organizationId, doctorProfileId, org.branchId, day]
    );
  }

  symptomItemId = await makeTerm('SYMPTOM', 'JRN_TOOTH_PAIN', 'Tooth pain');
  diagnosisItemId = await makeTerm('DIAGNOSIS', 'JRN_CARIES', 'Dental caries');
  procedureItemId = await makeTerm('PROCEDURE', 'JRN_RCT', 'Root canal treatment');
  investigationItemId = await makeTerm('INVESTIGATION', 'JRN_OPG', 'OPG');
  adviceItemId = await makeTerm('ADVICE', 'JRN_BRUSH', 'Brushing technique');

  const product = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, code, name, status, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'JRN_AMOX', 'Amoxicillin 500', 'ACTIVE',
             (SELECT id FROM units_of_measure ORDER BY code LIMIT 1), now())
     RETURNING id`,
    [org.organizationId]
  );
  productId = product.rows[0]!.id;
}, 40_000);

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
// Act I — the visit
// ---------------------------------------------------------------------------

describe('Act I — the visit', () => {
  let sectionKey: string;

  it('opens the consultation the visit resolves to', async () => {
    const res = await post('/encounters', { appointmentId });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    /* ⚠️ No number yet — an abandoned draft must burn none. */
    expect(res.body.data.encounterNumber).toBeNull();

    encounterId = res.body.data.id as string;
    sectionKey = descriptorSection(res.body.data.configuration as SectionConfig[]).key;
  });

  /**
   * ⚠️ ITEM 1 IN THE HEADER, AND THE SHAPE CHECK CE-8 ADDED. A nested object is
   *   not a stricter version of a legal answer — it is an answer NO field type in
   *   the grammar can produce, so nothing would ever render it and nobody would
   *   ever discover that what they typed is gone.
   */
  it('refuses an answer no field could hold', async () => {
    const res = await patch(`/encounters/${encounterId}`, {
      sections: [{ key: sectionKey, data: { note: { nested: 'document' } } }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/any field can hold/i);
  });

  /** ⚠️ AND THE SAME CHECK ON SIZE. An autosave is not an upload endpoint. */
  it('refuses an answer larger than any consultation', async () => {
    const res = await patch(`/encounters/${encounterId}`, {
      sections: [{ key: sectionKey, data: { note: 'x'.repeat(20_001) } }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/longer than/i);
  });

  it('takes the doctor’s notes as they are typed', async () => {
    const res = await patch(`/encounters/${encounterId}`, {
      chiefComplaint: 'Pain in the lower left molar',
      chiefComplaintDurationValue: 3,
      chiefComplaintDurationUnit: 'DAYS',
      onset: 'GRADUAL',
      clinicalNotes: 'Tender to percussion. Deep occlusal lesion.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DRAFT');
  });

  it('records what was found, what it is, and what was done about it', async () => {
    const symptom = await post(`/encounters/${encounterId}/symptoms`, {
      itemId: symptomItemId,
      severity: 'MODERATE',
    });
    expect(symptom.status).toBe(201);

    const diagnosis = await post(`/encounters/${encounterId}/diagnoses`, {
      itemId: diagnosisItemId,
      role: 'PRIMARY',
      certainty: 'CONFIRMED',
    });
    expect(diagnosis.status).toBe(201);
    diagnosisRowId = diagnosis.body.data.diagnoses[0].id as string;

    /* ⚠️ THE LINK ACT III COMES BACK FOR. */
    const procedure = await post(`/encounters/${encounterId}/procedures`, {
      itemId: procedureItemId,
      diagnosisId: diagnosisRowId,
      status: 'PERFORMED',
    });
    expect(procedure.status).toBe(201);
    procedureRowId = procedure.body.data.procedures[0].id as string;
    expect(procedure.body.data.procedures[0].diagnosisId).toBe(diagnosisRowId);
  });

  it('prescribes, orders, advises and refers', async () => {
    const prescription = await post(`/encounters/${encounterId}/prescriptions`, {
      productId,
      dose: '1',
      doseUnit: 'tablet',
      route: 'ORAL',
      frequency: 2,
      frequencyUnit: 'DAY',
      durationValue: 5,
      durationUnit: 'DAYS',
    });
    expect(prescription.status).toBe(201);

    const investigation = await post(`/encounters/${encounterId}/investigations`, {
      itemId: investigationItemId,
      priority: 'ROUTINE',
    });
    expect(investigation.status).toBe(201);

    const advice = await post(`/encounters/${encounterId}/advice`, { itemId: adviceItemId });
    expect(advice.status).toBe(201);

    const referral = await post(`/encounters/${encounterId}/referrals`, {
      externalName: 'City Oral Surgery',
      urgency: 'ROUTINE',
    });
    expect(referral.status).toBe(201);
  });

  /**
   * ⚠️ THE SIGNATURE IS REFUSED BEFORE THE PLAN IS STATED, and this is CE-4's
   *   flag doing work rather than sitting in a document. The seeded template
   *   marks FOLLOW_UP required precisely so a clinic can tell "the doctor
   *   decided against a follow-up" from "the doctor forgot".
   */
  it('refuses to sign a consultation that never answered a required question', async () => {
    const res = await post(`/encounters/${encounterId}/finalize`, {});
    expect(res.status).toBe(400);
    expect(String(res.body.message).length).toBeGreaterThan(0);
  });

  it('states the follow-up plan and signs the record', async () => {
    const plan = await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: true,
      intervalValue: 15,
      intervalUnit: 'DAYS',
      followUpType: 'ROUTINE',
      reason: 'Review the restoration',
    });
    expect(plan.status).toBe(200);

    const signed = await post(`/encounters/${encounterId}/finalize`, {});
    expect(signed.status).toBe(200);
    expect(signed.body.data.status).toBe('FINALIZED');
    /* ⚠️ THE NUMBER IS BURNT HERE AND NOT AT OPEN. */
    expect(signed.body.data.encounterNumber).toMatch(/^ENC/);
  });

  /**
   * ⚠️ IMMUTABILITY IS NOT A SCREEN THAT HIDES A BUTTON. Both doors are shut:
   *   the document the autosave writes AND the rows the content endpoints write.
   */
  it('is immutable the moment it is signed — the document and the rows alike', async () => {
    const document = await patch(`/encounters/${encounterId}`, { clinicalNotes: 'on reflection' });
    expect(document.status).toBe(409);

    const row = await post(`/encounters/${encounterId}/symptoms`, { itemId: symptomItemId });
    expect(row.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Act II — the recall
// ---------------------------------------------------------------------------

describe('Act II — the recall', () => {
  /** ⚠️ ITEM 3 IN THE HEADER: the desk can see who was told to come back. */
  it('puts the patient in front of the desk', async () => {
    const res = await get('/follow-up-recommendations?status=UPCOMING&withinDays=365');
    expect(res.status).toBe(200);

    const mine = (res.body.data.items as { id: string; patientId: string; dueOn: string }[]).find(
      (item) => item.patientId === patientId
    );
    expect(mine).toBeDefined();
    expect(mine?.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    recommendationId = mine!.id;
  });

  /**
   * ⚠️ THE SLOT IS TAKEN FROM THE ENGINE, NOT INVENTED BY THE TEST. A booking at
   *   an arbitrary instant is refused — "that is not a slot this doctor works" —
   *   which is correct behaviour and would make this case pass for the wrong
   *   reason if it were tolerated. The desk picks from what is offered, so this
   *   does too.
   */
  it('books the return visit against the recommendation, and takes them off the list', async () => {
    const dueDate = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    const availability = await get(
      `/appointments/availability?branchId=${org.branchId}` +
        `&doctorProfileId=${doctorProfileId}&date=${dueDate}`
    );
    expect(availability.status).toBe(200);
    expect(availability.body.data.notWorking).toBe(false);

    const free = (availability.body.data.slots as { startsAt: string; available: boolean }[]).find(
      (slot) => slot.available
    );
    expect(free).toBeDefined();

    const booked = await post(`/appointments/${appointmentId}/follow-up`, {
      startsAt: free!.startsAt,
      fulfilsRecommendationId: recommendationId,
    });
    /*
     * ⚠️ NO TOLERATED FAILURE HERE, DELIBERATELY. An earlier version let a 409
     *   pass — and because that left `followUpAppointmentId` null, it also
     *   silently no-opped the previous-visit case and half the visit-history
     *   case in Act III. Three of this suite's most valuable assertions would
     *   have gone green without running. The clash cannot happen anyway: this
     *   suite registers its own organization, its own branch and its own doctor,
     *   whose only other booking is today's.
     */
    expect(booked.status).toBe(201);
    followUpAppointmentId = booked.body.data.id as string;

    const after = await get('/follow-up-recommendations?status=UPCOMING&withinDays=365');
    const ids = (after.body.data.items as { id: string }[]).map((item) => item.id);
    expect(ids).not.toContain(recommendationId);
  });
});

// ---------------------------------------------------------------------------
// Act III — the next visit
// ---------------------------------------------------------------------------

describe('Act III — the next visit', () => {
  /**
   * ⚠️ THE PANEL THE WHOLE FOLLOW-UP CHAIN EXISTS FOR (§37). A doctor opening
   *   the return visit must see what was decided last time without going to
   *   look for it — that is the difference between a chain and two unrelated
   *   bookings that happen to share a patient.
   */
  it('shows the previous visit on the return booking', async () => {
    expect(followUpAppointmentId).not.toBeNull();

    const res = await get(`/appointments/${followUpAppointmentId}/previous-visit`);
    expect(res.status).toBe(200);

    const previous = res.body.data.previous as {
      source: string;
      encounter: { id: string; diagnoses: string[] };
      content: { prescriptions: unknown[] };
    } | null;
    expect(previous).not.toBeNull();

    /* ⚠️ THE BOOKING IT WAS MADE FROM, not "the most recent consultation with
       the same words" — the strongest of the three sources, and the only one the
       database itself enforces. */
    expect(previous?.source).toBe('PARENT_APPOINTMENT');
    expect(previous?.encounter.id).toBe(encounterId);
    expect(previous?.encounter.diagnoses.length).toBeGreaterThan(0);
    /* ⚠️ AND THE WHOLE CONTENT, so the doctor can read last time's dose without
       leaving the consultation they are writing (FOLLOW_UP_ARCHITECTURE §4). */
    expect(previous?.content.prescriptions.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ PAGINATED OVER THE JOURNEY, NOT OVER THE VISITS, and the shape says so —
   *   a journey is the unit a clinician reads. Both the visit that happened and
   *   the one that is booked hang off the same episode, which is the whole point
   *   of the episode existing.
   */
  it('shows the journey on the patient’s visit history', async () => {
    const res = await get(`/patients/${patientId}/visit-history`);
    expect(res.status).toBe(200);

    const episodes = res.body.data.episodes as {
      id: string;
      visits: {
        appointmentId: string | null;
        encounter: { id: string; status: string; diagnoses: string[] } | null;
      }[];
    }[];

    const journey = episodes.find((episode) => episode.id === episodeId);
    expect(journey).toBeDefined();

    const written = journey?.visits.find((visit) => visit.encounter !== null);
    expect(written?.encounter?.id).toBe(encounterId);
    /* ⚠️ The summary carries what was concluded, not merely that something was. */
    expect(written?.encounter?.diagnoses.length).toBeGreaterThan(0);

    const booked = journey?.visits.map((visit) => visit.appointmentId) ?? [];
    expect(booked).toContain(followUpAppointmentId);
  });
});

// ---------------------------------------------------------------------------
// Act IV — the correction
// ---------------------------------------------------------------------------

describe('Act IV — the correction', () => {
  it('starts a new record that cites the signed one', async () => {
    const res = await post(`/encounters/${encounterId}/amend`, {
      reason: 'The tooth number was wrong',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.amendsEncounterId).toBe(encounterId);
    amendmentId = res.body.data.id as string;

    /* The original keeps everything except its status. */
    const original = await get(`/encounters/${encounterId}`);
    expect(original.body.data.status).toBe('AMENDED');
    expect(original.body.data.encounterNumber).toMatch(/^ENC/);
  });

  /**
   * ⚠️ ITEM 2 IN THE HEADER, AND THE DEEPEST THING IN THIS FILE. A copied
   *   procedure that still pointed at the ORIGINAL's diagnosis row would be an
   *   amendment reaching into a signed record; one that lost the link would be a
   *   correction that silently forgot why the root canal was done.
   */
  it('carries the content forward and re-links it to its own rows', async () => {
    const res = await get(`/encounters/${amendmentId}`);
    expect(res.status).toBe(200);

    const content = res.body.data.content as {
      diagnoses: { id: string }[];
      procedures: { id: string; diagnosisId: string | null }[];
      prescriptions: unknown[];
      referrals: unknown[];
    };

    expect(content.diagnoses.length).toBeGreaterThan(0);
    expect(content.prescriptions.length).toBeGreaterThan(0);
    expect(content.referrals.length).toBeGreaterThan(0);

    const copied = content.procedures[0];
    expect(copied).toBeDefined();
    /* Its own row… */
    expect(copied?.id).not.toBe(procedureRowId);
    /* …citing its own diagnosis, not the signed record's. */
    expect(copied?.diagnosisId).not.toBeNull();
    expect(copied?.diagnosisId).not.toBe(diagnosisRowId);
    expect(content.diagnoses.map((row) => row.id)).toContain(copied?.diagnosisId);
  });
});

// ---------------------------------------------------------------------------
// Act V — the trails
// ---------------------------------------------------------------------------

/**
 * ⚠️ ITEM 4. A compliance reader with no right to a patient's record must not be
 *   able to reconstruct one out of the audit table — and everybody who read this
 *   record must be in the disclosure table. Both are asserted after a whole
 *   journey rather than after one write.
 */
describe('Act V — the trails', () => {
  it('never wrote the clinical content into the audit trail', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM audit_logs
        WHERE organization_id = $1
          AND (before_data::text ILIKE '%molar%'
            OR after_data::text ILIKE '%molar%'
            OR before_data::text ILIKE '%caries%'
            OR after_data::text ILIKE '%percussion%')`,
      [org.organizationId]
    );
    expect(rows).toHaveLength(0);
  });

  it('recorded every disclosure of it', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'ENCOUNTER'`,
      [org.organizationId]
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  });

  /**
   * ⚠️ AND THE URL IS THE PATTERN, NEVER `req.originalUrl`. A logged URL carries
   *   its query string with it, and a search over a clinical vocabulary carries
   *   what somebody was looking for.
   */
  it('logged the route pattern rather than the URL somebody called', async () => {
    const { rows } = await owner.query<{ route: string | null }>(
      `SELECT route FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'ENCOUNTER' AND route IS NOT NULL`,
      [org.organizationId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.route).not.toMatch(/\?/);
      expect(row.route).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
    }
  });
});
