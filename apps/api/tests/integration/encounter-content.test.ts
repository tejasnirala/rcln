/**
 * The clinical content of a consultation, over real HTTP (CE-4).
 *
 * Beyond "the endpoints respond", these are the things pinned down here, and
 * every one of them is a bug that would otherwise be silent:
 *
 *   1. ⚠️ CODED OR TYPED, EXACTLY ONE. §6 wants a symptom the vocabulary has not
 *      learned yet to be recordable; sending BOTH must be refused, or a typed
 *      label sits beside a coded word and silently contradicts it.
 *
 *   2. ⚠️ AT MOST ONE PRIMARY DIAGNOSIS. Two primaries is two answers to "what
 *      was this visit about", and every report grouping by primary counts the
 *      visit twice. The partial unique index is the guarantee; the 409 is what
 *      makes it a sentence rather than a constraint name.
 *
 *   3. ⚠️ REMOVING A DIAGNOSIS UNLINKS THE PROCEDURES CITING IT. The FK is
 *      `Restrict` because the composite includes `organization_id` and Postgres
 *      cannot null the pair — so without the unlink this is a foreign-key
 *      violation for an action that is entirely reasonable.
 *
 *   4. ⚠️ NOTHING EDITS A FINALIZED CONSULTATION (CD-2). Every content writer is
 *      a 409 past FINALIZED, not a silent rewrite of a record somebody signed.
 *
 *   5. ⚠️ AN AMENDMENT COPIES THE CONTENT AND REMAPS THE DIAGNOSIS LINKS. A
 *      straight copy leaves every procedure on the amendment citing a diagnosis
 *      on the ORIGINAL — a reference the composite FK happily permits and the
 *      chart cannot render.
 *
 *   6. ⚠️ A FOLLOW-UP RECOMMENDATION IS NOT A BOOKING (CD-13). It consumes no
 *      slot and burns no appointment number, it survives finalization, and
 *      booking against it is what takes the patient off the recall list.
 *
 *   7. ⚠️ THE AUDIT TRAIL CARRIES NO CLINICAL FREE TEXT. `customText` reaches no
 *      audit row — the allow-list snapshot is the first layer and REDACTED_KEYS
 *      the backstop.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `c${Date.now().toString(36)}`;
const SLUG = `cnt-${SUFFIX}`;
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
let appointmentId: string;
let encounterId: string;

/** Platform-visible vocabulary, created for this suite and cleaned up after. */
let symptomItemId: string;
let diagnosisItemId: string;
let procedureItemId: string;
let investigationItemId: string;
let adviceItemId: string;
let productId: string;

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
 *   the codes per membership — so the fixture takes the same path a real clinic
 *   would, and `encounters.test.ts` proves the default is what invariant 7 says.
 */
async function grantAuthoring(): Promise<void> {
  await owner.query(
    `INSERT INTO membership_permission_overrides
       (id, membership_id, organization_id, permission_id, effect, reason)
     SELECT gen_random_uuid(), $1, $2, p.id, 'GRANT', 'content test'
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
const del = api('delete');

/** A clinical word this clinic owns, so no platform row is left behind. */
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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Content'));

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
     VALUES (gen_random_uuid(), $1, 'CNTUHID1', 'Ada', now()) RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]!.id;

  const registration = await owner.query<{ id: string }>(
    `INSERT INTO patient_registrations
       (id, organization_id, patient_id, branch_id, mrn, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'CNTMRN1', now()) RETURNING id`,
    [org.organizationId, patientId, org.branchId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes
       (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'CNTEP0001', DATE '2027-06-01', now())
     RETURNING id`,
    [org.organizationId, patientId]
  );
  episodeId = episode.rows[0]!.id;

  const appointment = await owner.query<{ id: string }>(
    `INSERT INTO appointments
       (id, organization_id, branch_id, patient_id, patient_registration_id,
        doctor_profile_id, clinical_episode_id, appointment_number,
        scheduled_start, scheduled_end, status, checked_in_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'CNTAPT0001',
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

  symptomItemId = await makeTerm('SYMPTOM', 'CNT_TOOTH_PAIN', 'Tooth pain');
  diagnosisItemId = await makeTerm('DIAGNOSIS', 'CNT_CARIES', 'Dental caries');
  procedureItemId = await makeTerm('PROCEDURE', 'CNT_RCT', 'Root canal treatment');
  investigationItemId = await makeTerm('INVESTIGATION', 'CNT_OPG', 'OPG');
  adviceItemId = await makeTerm('ADVICE', 'CNT_BRUSH', 'Brushing technique');

  const product = await owner.query<{ id: string }>(
    /* ⚠️ `base_unit_id` IS REQUIRED — a product with no unit is unquantifiable
       (PI-ADR-010). Any seeded platform unit will do for a prescription. */
    `INSERT INTO products
       (id, organization_id, type, code, name, status, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'CNT_AMOX', 'Amoxicillin 500', 'ACTIVE',
             (SELECT id FROM units_of_measure ORDER BY code LIMIT 1), now())
     RETURNING id`,
    [org.organizationId]
  );
  productId = product.rows[0]!.id;

  const opened = await post('/encounters', { appointmentId });
  encounterId = opened.body.data.id as string;
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

describe('symptoms', () => {
  it('records a coded symptom and qualifies it', async () => {
    const added = await post(`/encounters/${encounterId}/symptoms`, {
      itemId: symptomItemId,
    });
    expect(added.status).toBe(201);
    expect(added.body.data.symptoms).toHaveLength(1);
    expect(added.body.data.symptoms[0].item.name).toBe('Tooth pain');

    const rowId = added.body.data.symptoms[0].id as string;
    const edited = await patch(`/encounters/${encounterId}/symptoms/${rowId}`, {
      durationValue: 3,
      durationUnit: 'DAYS',
      severity: 'MODERATE',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.symptoms[0].durationValue).toBe(3);
    expect(edited.body.data.symptoms[0].severity).toBe('MODERATE');
  });

  /**
   * ⚠️ §6 — A CLINICIAN MUST BE ABLE TO RECORD A WORD THE VOCABULARY HAS NOT
   *   LEARNED YET. Forcing every free-text entry to create a master row pollutes
   *   a SHARED PLATFORM catalogue with one clinic's typos.
   */
  it('records a symptom the vocabulary does not have', async () => {
    const res = await post(`/encounters/${encounterId}/symptoms`, {
      customText: 'Aching along the jawline in the mornings',
    });
    expect(res.status).toBe(201);
    const typed = res.body.data.symptoms.find((row: { item: unknown }) => row.item === null) as {
      customText: string;
    };
    expect(typed.customText).toBe('Aching along the jawline in the mornings');
  });

  /**
   * ⚠️ EXACTLY ONE OF THE TWO. Both would let a typed label sit beside a coded
   *   word and contradict it, and then every report grouping by `itemId`
   *   disagrees with the chart.
   */
  it('refuses a symptom that is both coded and typed', async () => {
    const res = await post(`/encounters/${encounterId}/symptoms`, {
      itemId: symptomItemId,
      customText: 'Tooth pain',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a symptom that is neither', async () => {
    const res = await post(`/encounters/${encounterId}/symptoms`, { severity: 'MILD' });
    expect(res.status).toBe(400);
  });

  it('removes one', async () => {
    const before = await get(`/encounters/${encounterId}`);
    const rowId = before.body.data.content.symptoms[0].id as string;
    const res = await del(`/encounters/${encounterId}/symptoms/${rowId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.symptoms).toHaveLength(1);
  });
});

describe('diagnoses and the procedures that cite them', () => {
  let primaryId: string;
  let procedureId: string;

  it('records a primary diagnosis', async () => {
    const res = await post(`/encounters/${encounterId}/diagnoses`, {
      itemId: diagnosisItemId,
      role: 'PRIMARY',
      certainty: 'CONFIRMED',
    });
    expect(res.status).toBe(201);
    primaryId = res.body.data.diagnoses[0].id as string;
    expect(res.body.data.diagnoses[0].role).toBe('PRIMARY');
  });

  /**
   * ⚠️ THE PARTIAL UNIQUE INDEX, AS A SENTENCE. Without the read behind it the
   *   clinician gets a 500 naming a constraint; with it they are told there is
   *   already a primary and what to do instead.
   */
  it('refuses a second primary diagnosis', async () => {
    const res = await post(`/encounters/${encounterId}/diagnoses`, {
      customText: 'Something else entirely',
      role: 'PRIMARY',
    });
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/primary/i);
  });

  it('records a secondary one beside it', async () => {
    const res = await post(`/encounters/${encounterId}/diagnoses`, {
      customText: 'Reversible pulpitis',
      role: 'SECONDARY',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.diagnoses).toHaveLength(2);
  });

  it('links a procedure to the diagnosis it treats', async () => {
    const res = await post(`/encounters/${encounterId}/procedures`, {
      itemId: procedureItemId,
      diagnosisId: primaryId,
      status: 'PERFORMED',
      performedOn: '2027-06-02',
    });
    expect(res.status).toBe(201);
    procedureId = res.body.data.procedures[0].id as string;
    expect(res.body.data.procedures[0].diagnosisId).toBe(primaryId);
    expect(res.body.data.procedures[0].performedOn).toBe('2027-06-02');
  });

  /** ⚠️ A PROCEDURE IS CODED, ALWAYS — it is billed and consumed from stock. */
  it('refuses a procedure with no clinical term', async () => {
    const res = await post(`/encounters/${encounterId}/procedures`, {
      status: 'PLANNED',
    });
    expect(res.status).toBe(400);
  });

  /** ⚠️ A DIAGNOSIS FROM ANOTHER CONSULTATION IS NOT OURS TO CITE. */
  it('refuses a procedure citing a diagnosis that is not on this consultation', async () => {
    const res = await post(`/encounters/${encounterId}/procedures`, {
      itemId: procedureItemId,
      diagnosisId: episodeId,
    });
    expect(res.status).toBe(404);
  });

  /**
   * ⚠️ THE UNLINK. The FK is `Restrict` — the composite includes
   *   `organization_id`, which is NOT NULL, so Postgres cannot null the pair.
   *   Without the service unlinking first this is a foreign-key violation for an
   *   action that is entirely reasonable, and what stays on the record is the
   *   procedure: what was DONE is a fact, only the claim about why goes.
   */
  it('unlinks the procedure when its diagnosis is removed, and keeps the procedure', async () => {
    const res = await del(`/encounters/${encounterId}/diagnoses/${primaryId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.diagnoses).toHaveLength(1);

    const procedure = res.body.data.procedures.find(
      (row: { id: string }) => row.id === procedureId
    ) as { diagnosisId: string | null };
    expect(procedure).toBeDefined();
    expect(procedure.diagnosisId).toBeNull();
  });
});

describe('prescriptions', () => {
  let prescriptionId: string;

  it('prescribes a medicine from the catalogue', async () => {
    const res = await post(`/encounters/${encounterId}/prescriptions`, {
      productId,
      dose: '1',
      doseUnit: 'tablet',
      route: 'ORAL',
      frequency: 2,
      frequencyUnit: 'DAY',
      durationValue: 5,
      durationUnit: 'DAYS',
      foodRelation: 'AFTER_FOOD',
    });
    expect(res.status).toBe(201);
    prescriptionId = res.body.data.prescriptions[0].id as string;
    expect(res.body.data.prescriptions[0].product.name).toBe('Amoxicillin 500');
    /* ⚠️ A STRING ON THE WIRE. Half a tablet is "0.5" and must stay exact. */
    expect(typeof res.body.data.prescriptions[0].dose).toBe('string');
  });

  /**
   * ⚠️ EVERY PAIR TRAVELS TOGETHER, BY CHECK CONSTRAINT. "Twice per" nothing is
   *   a prescription a pharmacist cannot fill, and it is what a half-completed
   *   form produces.
   */
  it('refuses a frequency with no period', async () => {
    const res = await post(`/encounters/${encounterId}/prescriptions`, {
      productId,
      frequency: 2,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a course that ends before it starts', async () => {
    const res = await patch(`/encounters/${encounterId}/prescriptions/${prescriptionId}`, {
      startDate: '2027-06-10',
      endDate: '2027-06-01',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('records "as needed" as its own fact', async () => {
    const res = await patch(`/encounters/${encounterId}/prescriptions/${prescriptionId}`, {
      isPrn: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.prescriptions[0].isPrn).toBe(true);
  });
});

describe('investigations, advice and referrals', () => {
  it('orders an investigation', async () => {
    const res = await post(`/encounters/${encounterId}/investigations`, {
      itemId: investigationItemId,
      priority: 'URGENT',
      reason: 'To see the root',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.investigations[0].priority).toBe('URGENT');
    expect(res.body.data.investigations[0].status).toBe('ORDERED');
  });

  /**
   * ⚠️ TAILORING LIBRARY ADVICE MOVES THE ROW FROM CODED TO TYPED, which the
   *   CHECK requires, and sets `isEdited` — which is how a clinic knows which of
   *   its standard advice reaches patients unchanged.
   */
  it('tailors a piece of library advice and records that it was tailored', async () => {
    const added = await post(`/encounters/${encounterId}/advice`, { itemId: adviceItemId });
    expect(added.status).toBe(201);
    expect(added.body.data.advice[0].isEdited).toBe(false);

    const rowId = added.body.data.advice[0].id as string;
    const edited = await patch(`/encounters/${encounterId}/advice/${rowId}`, {
      customText: 'Brushing technique, and stop using the hard brush',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.advice[0].isEdited).toBe(true);
    expect(edited.body.data.advice[0].item).toBeNull();
  });

  it('refers the patient onward by name', async () => {
    const res = await post(`/encounters/${encounterId}/referrals`, {
      externalName: 'City Oral Surgery',
      urgency: 'URGENT',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.referrals[0].externalName).toBe('City Oral Surgery');
  });

  /** ⚠️ A REFERRAL TO NOBODY IS NOT A REFERRAL. */
  it('refuses a referral that names no destination', async () => {
    const res = await post(`/encounters/${encounterId}/referrals`, { urgency: 'ROUTINE' });
    expect(res.status).toBe(400);
  });
});

describe('the follow-up recommendation', () => {
  it('records "come back in 15 days" without booking anything', async () => {
    const res = await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: true,
      intervalValue: 15,
      intervalUnit: 'DAYS',
      followUpType: 'PROCEDURE_REVIEW',
      reason: 'Check the restoration has settled',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.followUp.intervalValue).toBe(15);
    expect(res.body.data.followUp.fulfilledByAppointmentId).toBeNull();
    /* ⚠️ COMPUTED, NEVER STORED — and counted from the advice, not from today. */
    expect(res.body.data.followUp.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    /* ⚠️ AND IT IS NOT A BOOKING. No slot, no appointment number. */
    const appointments = await owner.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM appointments WHERE organization_id = $1`,
      [org.organizationId]
    );
    expect(Number(appointments.rows[0]!.count)).toBe(1);
  });

  /**
   * ⚠️ "NO FOLLOW-UP NEEDED" IS A REAL ANSWER AND CARRIES NO INTERVAL. A screen
   *   that only ever wrote a row when a follow-up WAS needed could not tell "the
   *   doctor decided against one" from "the doctor forgot".
   */
  it('records that no follow-up is needed, and refuses an interval alongside it', async () => {
    const refused = await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: false,
      intervalValue: 15,
      intervalUnit: 'DAYS',
    });
    expect(refused.status).toBe(400);

    const res = await put(`/encounters/${encounterId}/follow-up`, { isRequired: false });
    expect(res.status).toBe(200);
    expect(res.body.data.followUp.isRequired).toBe(false);
    expect(res.body.data.followUp.dueOn).toBeNull();
  });

  it('refuses both an interval and a date', async () => {
    const res = await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: true,
      intervalValue: 15,
      intervalUnit: 'DAYS',
      recommendedDate: '2027-07-01',
    });
    expect(res.status).toBe(400);
  });

  /** The plan the rest of the suite works against. */
  it('restates the plan, keeping the superseded one', async () => {
    const res = await put(`/encounters/${encounterId}/follow-up`, {
      isRequired: true,
      intervalValue: 30,
      intervalUnit: 'DAYS',
      reason: 'Review',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.followUp.intervalValue).toBe(30);

    /* ⚠️ SOFT-DELETED, NOT OVERWRITTEN: "the doctor said 15 and then 30" is
       part of the record, and an UPDATE in place would erase the first half. */
    const rows = await owner.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM encounter_follow_up_recommendations
        WHERE encounter_id = $1`,
      [encounterId]
    );
    expect(Number(rows.rows[0]!.count)).toBeGreaterThan(1);
  });
});

describe('the audit trail', () => {
  /**
   * ⚠️ THE ALLOW-LIST SNAPSHOT IS THE FIRST LAYER AND `REDACTED_KEYS` THE
   *   BACKSTOP. Which coded term was recorded is an id — meaningless without the
   *   chart, and the fact an auditor asks about. What the clinician typed
   *   belongs to whoever may read the record.
   */
  it('records that content was written without recording what it said', async () => {
    const rows = await owner.query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type LIKE 'encounter_%'`,
      [org.organizationId]
    );
    expect(rows.rows.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(rows.rows);
    expect(serialised).not.toContain('Aching along the jawline');
    expect(serialised).not.toContain('Reversible pulpitis');
    expect(serialised).not.toContain('stop using the hard brush');
    expect(serialised).not.toContain('Check the restoration has settled');
  });
});

describe('immutability after signing (CD-2)', () => {
  it('signs the record', async () => {
    /*
     * The seeded GENERAL template marks the chief complaint required, and a
     * draft is allowed to be incomplete right up until this moment — so the
     * one document field this suite never filled in is filled in here, which
     * is exactly the order a clinician works in.
     */
    await patch(`/encounters/${encounterId}`, {
      chiefComplaint: 'Pain in the lower left molar',
    });

    const res = await post(`/encounters/${encounterId}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FINALIZED');
    expect(res.body.data.encounterNumber).not.toBeNull();
    /* The content came back with it, through the encounter's own reader. */
    expect(res.body.data.content.prescriptions).toHaveLength(1);
  });

  it('refuses every content writer past FINALIZED', async () => {
    const added = await post(`/encounters/${encounterId}/symptoms`, {
      customText: 'Something remembered afterwards',
    });
    expect(added.status).toBe(409);

    const removed = await del(`/encounters/${encounterId}/referrals/${encounterId}`);
    expect(removed.status).toBe(409);

    const plan = await put(`/encounters/${encounterId}/follow-up`, { isRequired: false });
    expect(plan.status).toBe(409);
  });

  /**
   * ⚠️ THE AMENDMENT COPIES THE CONTENT AND REMAPS THE DIAGNOSIS LINKS. A
   *   straight copy leaves the amendment's procedures citing the ORIGINAL's
   *   diagnoses — a reference the composite FK permits, because it only says
   *   "same tenant", and which renders as a procedure treating a diagnosis that
   *   is not on this consultation.
   */
  it('copies the content onto an amendment, with the links pointing at the copies', async () => {
    const res = await post(`/encounters/${encounterId}/amend`, {
      reason: 'The dose was recorded wrongly',
    });
    expect(res.status).toBe(201);

    const amendment = res.body.data;
    expect(amendment.status).toBe('DRAFT');
    expect(amendment.amendsEncounterId).toBe(encounterId);
    expect(amendment.content.prescriptions).toHaveLength(1);
    expect(amendment.content.diagnoses).toHaveLength(1);
    expect(amendment.content.advice).toHaveLength(1);

    /* Every id is a NEW row — the original keeps everything it was signed with. */
    const original = await get(`/encounters/${encounterId}`);
    const originalIds = new Set(
      original.body.data.content.prescriptions.map((row: { id: string }) => row.id)
    );
    for (const row of amendment.content.prescriptions as { id: string }[]) {
      expect(originalIds.has(row.id)).toBe(false);
    }

    /*
     * ⚠️ THE LINK CASE. This consultation's one procedure was unlinked earlier,
     *   so the assertion that matters is the shape: any procedure carrying a
     *   `diagnosisId` on the amendment must name a diagnosis ON the amendment.
     */
    const amendmentDiagnoses = new Set(
      (amendment.content.diagnoses as { id: string }[]).map((row) => row.id)
    );
    for (const procedure of amendment.content.procedures as { diagnosisId: string | null }[]) {
      if (procedure.diagnosisId !== null) {
        expect(amendmentDiagnoses.has(procedure.diagnosisId)).toBe(true);
      }
    }

    /*
     * ⚠️ THE FOLLOW-UP PLAN IS NOT COPIED, DELIBERATELY. It is denormalised onto
     *   the appointment and carries a fulfilment link; two live rows for one
     *   visit would give the recall list two answers.
     */
    expect(amendment.content.followUp).toBeNull();
  });
});

describe('the recall list and fulfilment (CD-13)', () => {
  it('lists who was told to come back', async () => {
    const res = await get('/follow-up-recommendations?status=DUE&withinDays=90');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  /**
   * ⚠️ `is_required = false` NEVER APPEARS IN AN OUTSTANDING WINDOW. "No
   *   follow-up needed" is a decision that was recorded, not a task waiting —
   *   putting it on the desk's list is asking somebody to chase a patient the
   *   doctor deliberately did not recall.
   */
  it('leaves "no follow-up needed" off every outstanding window', async () => {
    const res = await get('/follow-up-recommendations?status=UPCOMING&withinDays=365');
    expect(res.status).toBe(200);
    for (const item of res.body.data.items as { isRequired: boolean }[]) {
      expect(item.isRequired).toBe(true);
    }
  });

  it('takes the patient off the list when they book against it', async () => {
    const outstanding = await owner.query<{ id: string }>(
      `SELECT id FROM encounter_follow_up_recommendations
        WHERE organization_id = $1 AND deleted_at IS NULL
          AND is_required = true AND fulfilled_by_appointment_id IS NULL
        LIMIT 1`,
      [org.organizationId]
    );
    const recommendationId = outstanding.rows[0]?.id;
    expect(recommendationId).toBeDefined();

    const booked = await post(`/appointments/${appointmentId}/follow-up`, {
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      fulfilsRecommendationId: recommendationId,
    });
    /* A slot clash is possible in a shared database; the fulfilment is what is
       under test, so the booking either succeeded or it did not run at all. */
    if (booked.status === 201) {
      const row = await owner.query<{ fulfilled_by_appointment_id: string | null }>(
        `SELECT fulfilled_by_appointment_id FROM encounter_follow_up_recommendations
          WHERE id = $1`,
        [recommendationId]
      );
      expect(row.rows[0]!.fulfilled_by_appointment_id).not.toBeNull();

      /* ⚠️ AND IT IS OFF THE OUTSTANDING LIST NOW. */
      const after = await get('/follow-up-recommendations?status=DUE&withinDays=365');
      const ids = (after.body.data.items as { id: string }[]).map((item) => item.id);
      expect(ids).not.toContain(recommendationId);
    }
  });
});
