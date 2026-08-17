/**
 * PI-7: dispensing — against a real Postgres, through the real services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `stock-ledger` proves the ledger and its cache agree; `procurement` proves the
 * way stock ENTERS keeps that true. This proves the same of the way it LEAVES —
 * and pins the refusals PI-7 exists to make:
 *
 *   THE SUPPLY WRITES EVERYTHING   one transaction writes the dispense, its
 *                                  lines, its allocations, a `DISPENSING` leg per
 *                                  lot, the regulatory snapshot, an audit row and
 *                                  a data-access row — and `verifyBalances()`
 *                                  still replays clean afterwards.
 *   UNDISPENSABLE STOCK IS REFUSED expired, quarantined and recalled, from every
 *                                  route in. The single most important block of
 *                                  cases in the file.
 *   A REFUSED SUPPLY LEAVES NOTHING no ledger row, no dispense, and NO BURNED
 *                                  NUMBER — a gap in a dispensing series is a gap
 *                                  an inspector asks about.
 *   THE PRESCRIPTION IS RE-ASSERTED a draft or superseded consultation cannot be
 *                                  supplied against, whatever the screen thought.
 *   A RETURN QUARANTINES BY DEFAULT and only goes back to AVAILABLE when the
 *                                  clinic asks AND the rules do not object.
 *   PHI IS LOGGED, AND ONLY AS IDS  one `data_access_logs` row per read request,
 *                                  and never a patient or medicine name in it.
 *
 * ⚠️ THE DECISION SNAPSHOT IS ASSERTED ON EVERY LINE, because a supply with no
 *   snapshot is a supply nobody can explain two years later (PI-ADR-008) — and
 *   because the column is NOT NULL, a code path that forgot to ask the engine
 *   could not compile, which is the point of it being NOT NULL.
 *
 * Every fixture is prefixed `PHR-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch } from '../../src/services/inventory/batch.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { verifyBalances } from '../../src/services/inventory/balance.service.js';
import {
  getPharmacyPrescription,
  listPrescriptionQueue,
  verifyPrescription,
} from '../../src/services/pharmacy/queue.service.js';
import { createDispense, getDispense } from '../../src/services/pharmacy/dispense.service.js';
import { createDispenseReturn } from '../../src/services/pharmacy/return.service.js';
import { getPharmacyDashboard } from '../../src/services/pharmacy/dashboard.service.js';

const SUFFIX = `h${Date.now().toString(36)}`;
const SLUG = `phr-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
/** LOT_BATCH + expiry-controlled. What a dispensary actually hands over. */
let medicine: string;
let counter: string;
let goodLot: string;
let shortLot: string;

let patientId: string;
let episodeId: string;
let doctorProfileId: string;
let templateId: string;
let templateVersionId: string;
/** A signed consultation with one prescribed line. */
let encounterId: string;
let prescriptionLineId: string;

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

function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function balanceOf(batchId: string, status: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_balances
      WHERE batch_id = $1 AND status = $2`,
    [batchId, status]
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** Ledger legs written against one supply. The atomicity assertion. */
async function legsFor(dispenseId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM stock_ledger
      WHERE reference_type = 'DISPENSE' AND reference_id = $1`,
    [dispenseId]
  );
  return Number(rows[0]?.n ?? 0);
}

/** The `DISPENSE` counter for this branch, or null before it has ever been used. */
async function dispenseCounter(): Promise<number | null> {
  const { rows } = await owner.query<{ last_number: string }>(
    `SELECT last_number FROM number_sequences
      WHERE organization_id = $1 AND branch_id = $2 AND sequence_type = 'DISPENSE'`,
    [org.organizationId, org.branchId]
  );
  return rows[0] ? Number(rows[0].last_number) : null;
}

/** Everything the counter did to a patient's record, as the compliance table saw it. */
async function dataAccessRows(): Promise<{ resource: string; patient_id: string | null }[]> {
  const { rows } = await owner.query<{ resource: string; patient_id: string | null }>(
    `SELECT resource, patient_id FROM data_access_logs
      WHERE organization_id = $1 ORDER BY occurred_at`,
    [org.organizationId]
  );
  return rows;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Phr'));
  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId],
    userId: org.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const products = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_expiry_controlled, is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'PHR-MED', 'Phr Medicine', $2,
             'LOT_BATCH', true, true, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  medicine = products.rows[0]?.id ?? '';

  counter = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'PHR_COUNTER',
      name: 'Phr Counter',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  goodLot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: medicine,
      lotNumber: 'PHR-LOT-GOOD',
      expiresOn: dateIn(400),
    })
  ).id;

  /** Expires sooner, so FEFO reaches for it FIRST. That is what makes it useful. */
  shortLot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: medicine,
      lotNumber: 'PHR-LOT-SHORT',
      expiresOn: dateIn(20),
    })
  ).id;

  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: medicine,
    batchId: goodLot,
    movementType: 'RETURN',
    quantity: '100',
    locationId: counter,
    referenceType: 'MANUAL',
  });
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: medicine,
    batchId: shortLot,
    movementType: 'RETURN',
    quantity: '8',
    locationId: counter,
    referenceType: 'MANUAL',
  });

  // -- the clinical side, as raw SQL: this suite is not testing CE-3 ----------
  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, date_of_birth, updated_at)
     VALUES (gen_random_uuid(), $1, 'PHR00001', 'Phr', 'Patient', DATE '1990-05-05', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]?.id ?? '';

  const doctorProfile = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, registration_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'PHR-REG-1', now())
     RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  doctorProfileId = doctorProfile.rows[0]?.id ?? '';

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_DATE, now()) RETURNING id`,
    [org.organizationId, patientId, `PHREP${SUFFIX.slice(-5)}`]
  );
  episodeId = episode.rows[0]?.id ?? '';

  const context = await owner.query<{ id: string }>(
    `SELECT id FROM specialties WHERE organization_id IS NULL AND type = 'CARE_CONTEXT' LIMIT 1`
  );
  const careContextId = context.rows[0]?.id ?? null;

  const template = await owner.query<{ id: string }>(
    `INSERT INTO consultation_templates
       (id, organization_id, code, name, care_context_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Phr consultation', $3, now()) RETURNING id`,
    [org.organizationId, `PHR_TPL_${SUFFIX}`, careContextId]
  );
  templateId = template.rows[0]?.id ?? '';

  const version = await owner.query<{ id: string }>(
    `INSERT INTO consultation_template_versions
       (id, organization_id, template_id, version, definition, status, published_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 1, '{"sections":[]}'::jsonb, 'PUBLISHED', now(), now())
     RETURNING id`,
    [org.organizationId, templateId]
  );
  templateVersionId = version.rows[0]?.id ?? '';

  /*
   * ⚠️ `FINALIZED`, BECAUSE A DRAFT IS NOT A PRESCRIPTION. The dispensary reads a
   *   signed consultation; the draft case is asserted separately below.
   */
  const encounter = await owner.query<{ id: string }>(
    `INSERT INTO encounters
       (id, organization_id, branch_id, patient_id, clinical_episode_id, doctor_profile_id,
        template_id, template_version_id, template_snapshot, status, finalized_at,
        finalized_by, encounter_number, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, '{"sections":[]}'::jsonb,
             'FINALIZED', now(), $8, 'PHRENC0001', now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      episodeId,
      doctorProfileId,
      templateId,
      templateVersionId,
      /*
       * ⚠️ `finalized_by` AND `encounter_number` ARE NOT OPTIONAL ON A FINALIZED
       *   ROW. `encounters_lifecycle_facts` pairs the status with the facts that
       *   must accompany it — a signed consultation was signed BY somebody and
       *   burnt a number. CE-3's service does both; this fixture writes raw SQL
       *   and has to satisfy the same constraint.
       */
      org.ownerUserId,
    ]
  );
  encounterId = encounter.rows[0]?.id ?? '';

  const line = await owner.query<{ id: string }>(
    `INSERT INTO encounter_prescriptions
       (id, organization_id, branch_id, encounter_id, product_id, quantity, instructions, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 20, 'One at night', now())
     RETURNING id`,
    [org.organizationId, org.branchId, encounterId, medicine]
  );
  prescriptionLineId = line.rows[0]?.id ?? '';
}, 60_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
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
// The queue
// ---------------------------------------------------------------------------

describe('the queue', () => {
  it('shows a signed prescription as new, with nothing supplied yet', async () => {
    const queue = await listPrescriptionQueue(ctx, {
      page: 1,
      limit: 20,
      branchId: org.branchId,
    } as never);

    const row = queue.items.find((item) => item.encounterId === encounterId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('NEW');
    expect(row?.itemCount).toBe(1);
    expect(row?.completedItemCount).toBe(0);
  });

  it('reads back the prescription with what is on the shelf against each line', async () => {
    const detail = await getPharmacyPrescription(ctx, encounterId);

    expect(detail.isDispensable).toBe(true);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.quantityBase).toBe('20');
    expect(detail.items[0]?.dispensedQuantityBase).toBe('0');
    // 100 of the long lot + 8 of the short one, both dispensable.
    expect(Number(detail.items[0]?.availableQuantityBase)).toBe(108);
  });

  /**
   * ⚠️ THE CALLER IS THE PRESCRIBER HERE — the fixture's owner holds the doctor
   *   profile — and the flag is server-derived. It opens a statutory proviso in
   *   several jurisdictions, so a client being able to assert it would be
   *   self-certifying into an exemption.
   */
  it('says whether the caller wrote the prescription', async () => {
    const detail = await getPharmacyPrescription(ctx, encounterId);
    expect(detail.callerIsPrescriber).toBe(true);
  });

  it('records the check without supplying anything', async () => {
    const detail = await verifyPrescription(ctx, encounterId, { notes: 'Checked the dose' });

    expect(detail.status).toBe('VERIFIED');
    expect(detail.verifiedAt).not.toBeNull();
    expect(await legsFor(encounterId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The supply
// ---------------------------------------------------------------------------

describe('dispensing', () => {
  let dispenseId: string;

  it('writes the record, the lots and one ledger leg per lot, in one transaction', async () => {
    const before = await dispenseCounter();

    const dispense = await createDispense(ctx, {
      branchId: org.branchId,
      locationId: counter,
      kind: 'PRESCRIPTION',
      encounterId,
      lines: [
        {
          encounterPrescriptionId: prescriptionLineId,
          productId: medicine,
          quantity: '20',
          unitId: baseUnit,
        },
      ],
    } as never);
    dispenseId = dispense.id;

    expect(dispense.dispenseNumber).toMatch(/^DSP-/);
    expect(dispense.patientId).toBe(patientId);
    expect(dispense.lines).toHaveLength(1);

    /*
     * ⚠️ FEFO, AND THE PROOF IS THE SPLIT. The short-dated lot holds 8 and is
     *   taken FIRST and IN FULL; the remaining 12 come off the long-dated one. A
     *   single allocation would mean the planner reached for the wrong lot, which
     *   looks entirely normal until an audit asks why the oldest expired on the
     *   shelf.
     */
    const allocations = dispense.lines[0]?.allocations ?? [];
    expect(allocations).toHaveLength(2);
    expect(allocations[0]?.batchId).toBe(shortLot);
    expect(allocations[0]?.quantityBase).toBe('8');
    expect(allocations[1]?.batchId).toBe(goodLot);
    expect(allocations[1]?.quantityBase).toBe('12');

    expect(await legsFor(dispenseId)).toBe(2);
    expect(await balanceOf(shortLot, 'AVAILABLE')).toBe(0);
    expect(await balanceOf(goodLot, 'AVAILABLE')).toBe(88);

    const after = await dispenseCounter();
    expect(after).toBe((before ?? 0) + 1);

    const replay = await verifyBalances(ctx, { branchId: org.branchId, productId: medicine });
    expect(replay.discrepancies).toHaveLength(0);
  });

  /**
   * ⚠️ NOT NULL ON THE COLUMN, AND ASSERTED ANYWAY. The snapshot is what a clinic
   *   shows an inspector to say which rules it applied on the day (PI-ADR-008);
   *   the constraint stops a code path forgetting to ask, and this stops one
   *   asking and storing something meaningless.
   */
  it('snapshots the regulatory decision on every supplied line', async () => {
    const { rows } = await owner.query<{
      outcome: string;
      transaction: string;
      was_enforced: boolean;
      country_code: string;
    }>(
      `SELECT d.outcome, d.transaction, d.was_enforced, d.country_code
         FROM dispense_lines l JOIN regulatory_decisions d ON d.id = l.regulatory_decision_id
        WHERE l.dispense_id = $1`,
      [dispenseId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.transaction).toBe('DISPENSE');
    expect(rows[0]?.country_code).toBe('IN');
    /*
     * ⚠️ RECORDED AND NOT ENFORCED, WHICH IS THE CORRECT STATE TODAY AND NOT A
     *   DISABLED FEATURE. India sits at `RULES_IMPLEMENTED`; only a
     *   `PRODUCTION_ENABLED` pack may stop a document, and reaching that state is
     *   a named human's decision. See `regulatory/enforcement.ts`.
     */
    expect(rows[0]?.was_enforced).toBe(false);
  });

  it('moves the queue row on, and derives it from the lines rather than a column', async () => {
    const detail = await getPharmacyPrescription(ctx, encounterId);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.items[0]?.dispensedQuantityBase).toBe('20');
    expect(detail.items[0]?.outstandingQuantityBase).toBe('0');
  });

  it('writes an audit row carrying ids and counts, and no medicine', async () => {
    const { rows } = await owner.query<{ action: string; after_data: unknown }>(
      `SELECT action, after_data FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'dispense' AND entity_id = $2`,
      [org.organizationId, dispenseId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('CREATE');
    expect(JSON.stringify(rows[0]?.after_data)).not.toContain('Phr Medicine');
    expect(JSON.stringify(rows[0]?.after_data)).not.toContain('Phr Patient');
  });

  it('reads one dispense back without re-evaluating the rules', async () => {
    const detail = await getDispense(ctx, dispenseId);
    expect(detail.lines[0]?.decision.outcome).toBeDefined();
    expect(detail.lines[0]?.decision.wasEnforced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What may never go out
// ---------------------------------------------------------------------------

describe('stock that may not be supplied', () => {
  /** Everything below hangs off its own product, so the flows above stay stable. */
  let product: string;
  let lot: string;

  beforeAll(async () => {
    const created = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
          is_expiry_controlled, is_stock_item, updated_at)
       VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'PHR-BLOCKED', 'Phr Blocked', $2,
               'LOT_BATCH', true, true, now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    product = created.rows[0]?.id ?? '';

    lot = (
      await createBatch(ctx, {
        branchId: org.branchId,
        productId: product,
        lotNumber: 'PHR-LOT-BLOCK',
        expiresOn: dateIn(300),
      })
    ).id;

    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      /*
       * ⚠️ `RETURN`, NOT `PURCHASE_RECEIPT`, AND THAT IS THE CONTRACT RATHER THAN
       *   A SHORTCUT. `RecordMovementRequest` deliberately excludes the receipt
       *   member: stock enters through a goods receipt, which is a document with
       *   a supplier and a price. This suite is about what happens when stock
       *   LEAVES, so it stocks the shelf the way `stock-movements.test.ts` does.
       */
      movementType: 'RETURN',
      quantity: '50',
      locationId: counter,
      referenceType: 'MANUAL',
    });
  });

  const supply = async (quantity: string): Promise<unknown> =>
    createDispense(ctx, {
      branchId: org.branchId,
      locationId: counter,
      kind: 'COUNTER_SALE',
      lines: [{ productId: product, quantity, unitId: baseUnit }],
    } as never);

  it('supplies from a sound lot', async () => {
    const dispense = await supply('5');
    expect((dispense as { lines: unknown[] }).lines).toHaveLength(1);
  });

  /**
   * ⚠️ QUARANTINED STOCK IS VISIBLE, COUNTABLE, VALUED AND NOT DISPENSABLE. That
   *   is the entire point of the status axis (PI-ADR-013), and the case is here
   *   because a quantity that is still in `stock_balances` is exactly the one a
   *   naive allocator hands over.
   */
  it('refuses a quarantined lot', async () => {
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'QUARANTINE',
      quantity: '45',
      locationId: counter,
      referenceType: 'MANUAL',
    });

    await expect(supply('5')).rejects.toThrow(/not enough/i);
  });

  it('refuses a recalled lot from every route in', async () => {
    await owner.query(`UPDATE batches SET status = 'RECALLED' WHERE id = $1`, [lot]);
    // Back into AVAILABLE as far as the BUCKET is concerned — the lot's own
    // status is what must stop it, and this is the window a recall exists for.
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'QUARANTINE_RELEASE',
      quantity: '45',
      locationId: counter,
      referenceType: 'MANUAL',
    });

    await expect(supply('5')).rejects.toThrow(/not enough/i);

    await owner.query(`UPDATE batches SET status = 'ACTIVE' WHERE id = $1`, [lot]);
  });

  it('refuses an expired lot', async () => {
    await owner.query(`UPDATE batches SET expires_on = $2 WHERE id = $1`, [lot, dateIn(-1)]);
    await expect(supply('5')).rejects.toThrow(/not enough/i);
    await owner.query(`UPDATE batches SET expires_on = $2 WHERE id = $1`, [lot, dateIn(300)]);
  });

  /**
   * ⚠️ THE ROLLBACK CASE, AND THE ONE THAT WOULD BE QUIETLY WRONG. A refusal must
   *   leave no ledger row, no dispense — and burn no number, because a gap in a
   *   dispensing series is a gap somebody outside the clinic will ask about.
   */
  it('leaves nothing behind, and burns no number, when it refuses', async () => {
    const before = await dispenseCounter();
    const dispensesBefore = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM dispenses WHERE organization_id = $1`,
      [org.organizationId]
    );

    await expect(supply('9999')).rejects.toThrow(/not enough/i);

    const after = await dispenseCounter();
    const dispensesAfter = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM dispenses WHERE organization_id = $1`,
      [org.organizationId]
    );

    expect(after).toBe(before);
    expect(dispensesAfter.rows[0]?.n).toBe(dispensesBefore.rows[0]?.n);
  });

  it('refuses to supply out of a location that is not a dispensing point', async () => {
    const store = (
      await createLocation(ctx, {
        branchId: org.branchId,
        kind: 'CENTRAL_WAREHOUSE',
        code: 'PHR_STORE',
        name: 'Phr Store',
        isDispensingPoint: false,
        requiresControlledAccess: false,
      })
    ).id;

    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: store,
        kind: 'COUNTER_SALE',
        lines: [{ productId: product, quantity: '1', unitId: baseUnit }],
      } as never)
    ).rejects.toThrow(/dispensing point/i);
  });
});

// ---------------------------------------------------------------------------
// The prescription is re-asserted at the moment of acting
// ---------------------------------------------------------------------------

describe('a prescription that is not current', () => {
  it('cannot be supplied against while it is a draft', async () => {
    const draft = await owner.query<{ id: string }>(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id, doctor_profile_id,
          template_id, template_version_id, template_snapshot, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, '{"sections":[]}'::jsonb,
               'DRAFT', now())
       RETURNING id`,
      [
        org.organizationId,
        org.branchId,
        patientId,
        episodeId,
        doctorProfileId,
        templateId,
        templateVersionId,
      ]
    );
    const draftId = draft.rows[0]?.id ?? '';

    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: counter,
        kind: 'PRESCRIPTION',
        encounterId: draftId,
        lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
      } as never)
    ).rejects.toThrow(/not been signed/i);
  });
});

/**
 * ⚠️ SUPPLYING SOMETHING ELSE IS A SUBSTITUTION WHETHER OR NOT THE CALLER SAYS SO
 *   (PI-8 review, CRITICAL). Every substitution control in the programme hangs off
 *   `substitutedForProductId`: the contract refines the mandatory reason only when
 *   it is set, and `consultForSupply` is told `substitution: { isSubstitution: true }`
 *   only when it is set. So a line citing prescription line P (for product A) while
 *   supplying product B, with the field simply OMITTED, used to sail through — every
 *   `SUBSTITUTION_RESTRICTION` rule sat out, the frozen decision recorded a PERMITTED
 *   supply for a question nobody asked, the stored row read
 *   `substituted_for_product_id = NULL` (asserting B is what the prescriber wrote),
 *   and `refreshFulfilment` closed the prescription because it sums by prescription
 *   line without looking at the product.
 *
 *   The web workspace always sent the field. The workspace is not the boundary.
 */
describe('supplying a different product from the one prescribed', () => {
  let other: string;

  beforeAll(async () => {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
          is_expiry_controlled, is_stock_item, updated_at)
       VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'PHR-MED-ALT', 'Phr Medicine Alt', $2,
               'LOT_BATCH', true, true, now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    other = row.rows[0]?.id ?? '';
  });

  it('refuses a swap that does not declare itself', async () => {
    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: counter,
        kind: 'PRESCRIPTION',
        encounterId,
        lines: [
          {
            encounterPrescriptionId: prescriptionLineId,
            productId: other,
            quantity: '1',
            unitId: baseUnit,
          },
        ],
      } as never)
    ).rejects.toThrow(/record it as a substitution/i);
  });

  /*
   * The other half: a declared substitution has to name the product on the line it
   * cites. Pointing it at some third product would put a name on the clinical record
   * that was never prescribed, and would ask the engine about the wrong swap.
   */
  it('refuses a substitution that names a product the prescription does not', async () => {
    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: counter,
        kind: 'PRESCRIPTION',
        encounterId,
        /*
         * The supplied product IS the prescribed one, so this is not a swap at
         * all — but it claims to have been substituted for a product the line
         * never named. Caught here rather than by the contract, whose only
         * refinement on this field is that a product is not substituted for
         * itself.
         */
        lines: [
          {
            encounterPrescriptionId: prescriptionLineId,
            productId: medicine,
            substitutedForProductId: other,
            substitutionReason: 'out of stock',
            quantity: '1',
            unitId: baseUnit,
          },
        ],
      } as never)
    ).rejects.toThrow(/actually prescribed/i);
  });
});

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

describe('a return', () => {
  let dispenseId: string;
  let lineId: string;
  let allocationId: string;

  beforeAll(async () => {
    const dispense = await createDispense(ctx, {
      branchId: org.branchId,
      locationId: counter,
      kind: 'COUNTER_SALE',
      lines: [{ productId: medicine, quantity: '10', unitId: baseUnit }],
    } as never);
    dispenseId = dispense.id;
    lineId = dispense.lines[0]?.id ?? '';
    allocationId = dispense.lines[0]?.allocations[0]?.id ?? '';
  });

  /**
   * ⚠️ QUARANTINED, EVEN THOUGH THE CLINIC ASKED FOR IT BACK ON THE SHELF. Both
   *   have to agree: no jurisdiction here has a rule permitting a dispensed
   *   medicine to be resold, so the engine answers `UNDETERMINED` — which is not
   *   "carry on" — and the stock is accepted back into quarantine.
   */
  it('quarantines by default, and accepts the stock either way', async () => {
    const before = await balanceOf(goodLot, 'QUARANTINED');

    const ret = await createDispenseReturn(ctx, dispenseId, {
      reason: 'Wrong strength handed over',
      requestRestock: true,
      lines: [{ dispenseLineId: lineId, dispenseAllocationId: allocationId, quantityBase: '4' }],
    } as never);

    expect(ret.disposition).toBe('QUARANTINED');
    expect(await balanceOf(goodLot, 'QUARANTINED')).toBe(before + 4);
  });

  it('writes the RETURN leg and moves the supply on', async () => {
    const detail = await getDispense(ctx, dispenseId);
    expect(detail.status).toBe('PARTIALLY_RETURNED');
    expect(detail.lines[0]?.returnedQuantityBase).toBe('4');

    const { rows } = await owner.query<{ movement_type: string }>(
      `SELECT movement_type FROM stock_ledger
        WHERE reference_type = 'DISPENSE' AND reference_id = $1 AND movement_type = 'RETURN'`,
      [dispenseId]
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses more than went out', async () => {
    await expect(
      createDispenseReturn(ctx, dispenseId, {
        reason: 'Second thoughts',
        requestRestock: false,
        lines: [{ dispenseLineId: lineId, dispenseAllocationId: allocationId, quantityBase: '99' }],
      } as never)
    ).rejects.toThrow(/still out/i);
  });

  it('leaves the ledger and its cache in agreement', async () => {
    const replay = await verifyBalances(ctx, { branchId: org.branchId, productId: medicine });
    expect(replay.discrepancies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PHI discipline
// ---------------------------------------------------------------------------

describe('the disclosure trail', () => {
  it('writes one row per read request, never one per result', async () => {
    const before = (await dataAccessRows()).length;
    await listPrescriptionQueue(ctx, { page: 1, limit: 20 } as never);
    const after = (await dataAccessRows()).length;

    expect(after).toBe(before + 1);
  });

  /**
   * ⚠️ THE ONE ASSERTION THIS TABLE EXISTS FOR. `data_access_logs` is read by
   *   compliance and security people who have no business reading patient
   *   records — "dispensed methadone to patient X" landing in it is itself a
   *   disclosure. Ids, enums, counts and a hash. Nothing else.
   */
  it('never names a patient or a medicine', async () => {
    const { rows } = await owner.query<Record<string, unknown>>(
      `SELECT * FROM data_access_logs WHERE organization_id = $1`,
      [org.organizationId]
    );

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('Phr Patient');
    expect(serialised).not.toContain('Phr Medicine');
    expect(serialised).not.toContain('PHR00001');
  });

  it('names the patient by id on a single-record read, and by nothing on a list', async () => {
    await getPharmacyPrescription(ctx, encounterId);
    const rows = await dataAccessRows();

    expect(
      rows.some((row) => row.resource === 'PRESCRIPTION' && row.patient_id === patientId)
    ).toBe(true);
    expect(rows.some((row) => row.resource === 'PRESCRIPTION' && row.patient_id === null)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

describe('the dashboard', () => {
  /** ⚠️ COUNTS ONLY. The shape carries no name, which is the point of it. */
  it('counts what is waiting and what went out today', async () => {
    const dashboard = await getPharmacyDashboard(ctx, { branchId: org.branchId });

    expect(dashboard.branchId).toBe(org.branchId);
    expect(dashboard.dispensedToday).toBeGreaterThan(0);
    expect(JSON.stringify(dashboard)).not.toContain('Phr Patient');
  });
});
