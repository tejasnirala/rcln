/**
 * PI-10: recall & traceability — against a real Postgres, through the real
 * services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `stock-ledger` proves quantity moves correctly, `pharmacy` proves it leaves a
 * counter, `consumption` proves it is used on somebody. This proves the thing
 * that has to reach ALL of them at once, backwards.
 *
 *   A DRAFT NOTICE HOLDS NOTHING            recording a recall must not stop a
 *                                           pharmacy mid-shift.
 *   EXECUTING MOVES THE STOCK ONCE          one transaction: the legs, the lot's
 *                                           own status, and the notice's row.
 *   A RECALLED LOT IS UN-DISPENSABLE AND    from every path, because both go
 *   UN-CONSUMABLE                           through one allocator and it reads
 *                                           the balance rather than the flag.
 *   A FULLY-DISPENSED LOT IS RECORDABLE     `NO_STOCK`, not a refusal. It is the
 *                                           urgent case, not the trivial one.
 *   A SERIALISED LOT CAN ACTUALLY BE HELD   ⚠️ the PI-2 defect PI-10 found: the
 *                                           engine refuses a movement of a
 *                                           serial-tracked product that names no
 *                                           serial, so holding a lot of implants
 *                                           moved nothing and raised instead.
 *   FORWARD TRACE FINDS BOTH ROUTES         a dispense AND a procedure. A recall
 *                                           that walked only `dispense_allocations`
 *                                           would miss every implant ever fitted.
 *   BACKWARD TRACE REACHES THE SUPPLIER     lot -> receipt -> order -> supplier.
 *   THE NAMES ARE A SEPARATE, LOGGED ACT    counts under the read code, names
 *                                           under `recall.trace.patients`, and
 *                                           one `RECALL_TRACE` row per read.
 *   RELEASING PUTS IT BACK, AND CANCELLING  does not. A held lot leaving a recall
 *   DOES NOT                                writes a movement and states why.
 *
 * Every fixture is prefixed `RCL-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import type { TenantContext } from '@rcln/db';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch, setBatchHold } from '../../src/services/inventory/batch.service.js';
import { createSerial } from '../../src/services/inventory/serial.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { planStockAllocation } from '../../src/services/inventory/allocation.service.js';
import { createDispense } from '../../src/services/pharmacy/dispense.service.js';
import { recordConsumption } from '../../src/services/consumption/consumption.service.js';
import {
  addRecallBatches,
  cancelRecall,
  closeRecall,
  createRecall,
  executeRecall,
  getRecall,
  listRecallCandidates,
  listRecalls,
  resolveRecallBatch,
} from '../../src/services/recall/recall.service.js';
import {
  backwardTrace,
  forwardTrace,
  listAffectedParties,
} from '../../src/services/recall/trace.service.js';

const SUFFIX = `r${Date.now().toString(36)}`;
const SLUG = `rcl-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
/** The recalled medicine, in two lots: one affected, one not. */
let medicine: string;
/** Something else entirely — the lot a notice must refuse to name. */
let other: string;
/** A serial-tracked implant, and the numbered unit in its lot. */
let implant: string;

let affectedLot: string;
let soundLot: string;
let emptyLot: string;
let implantLot: string;
let implantSerial: string;
let otherLot: string;

let counter: string;
let patientId: string;
let encounterId: string;
let procedureId: string;
let supplierId: string;

let recallId: string;

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

async function makeProduct(code: string, type: string, tracking = 'LOT_BATCH'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ProductType", 'ACTIVE', $3, $4, $5,
             $6::"TrackingMode", true, now())
     RETURNING id`,
    [org.organizationId, type, code, `Rcl ${code}`, baseUnit, tracking]
  );
  return rows[0]?.id ?? '';
}

async function makeLot(productId: string, lotNumber: string, expiresOn: string): Promise<string> {
  const batch = await createBatch(ctx, {
    branchId: org.branchId,
    productId,
    lotNumber,
    expiresOn,
  } as never);
  return batch.id;
}

async function stockUp(
  productId: string,
  batchId: string,
  quantity: string,
  serialId?: string
): Promise<void> {
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId,
    batchId,
    ...(serialId !== undefined ? { serialId } : {}),
    movementType: 'RETURN',
    quantity,
    locationId: counter,
    referenceType: 'MANUAL',
  } as never);
}

/** What one lot holds in one bucket. The ledger's answer, read from the cache. */
async function bucket(batchId: string, status: string): Promise<string> {
  const { rows } = await owner.query<{ total: string | null }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS total
       FROM stock_balances WHERE batch_id = $1 AND status = $2::"StockStatus"`,
    [batchId, status]
  );
  return rows[0]?.total ?? '0';
}

async function batchStatusOf(batchId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status::text AS status FROM batches WHERE id = $1`,
    [batchId]
  );
  return rows[0]?.status ?? '';
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Rcl'));
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

  medicine = await makeProduct('RCL-MED', 'MEDICINE');
  other = await makeProduct('RCL-OTHER', 'MEDICINE');
  implant = await makeProduct('RCL-IMPLANT', 'IMPLANT', 'LOT_AND_SERIAL');

  counter = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'RCL_COUNTER',
      name: 'Rcl Counter',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  affectedLot = await makeLot(medicine, 'RCL-AFFECTED', '2027-12-31');
  soundLot = await makeLot(medicine, 'RCL-SOUND', '2028-12-31');
  /* ⚠️ Named by the notice and never stocked: the fully-dispensed case. */
  emptyLot = await makeLot(medicine, 'RCL-EMPTY', '2027-06-30');
  implantLot = await makeLot(implant, 'RCL-IMP-LOT', '2029-01-31');
  otherLot = await makeLot(other, 'RCL-OTHER-LOT', '2028-01-31');

  await stockUp(medicine, affectedLot, '100');
  await stockUp(medicine, soundLot, '100');
  await stockUp(other, otherLot, '10');

  implantSerial = (
    await createSerial(ctx, {
      branchId: org.branchId,
      productId: implant,
      batchId: implantLot,
      serialNumber: 'RCL-SER-1',
    } as never)
  ).id;
  await stockUp(implant, implantLot, '1', implantSerial);

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, phone, updated_at)
     VALUES (gen_random_uuid(), $1, 'RCL00001', 'Rcl', 'Patient', '+919700000001', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]?.id ?? '';

  /*
   * The clinical chain, written directly — the consultation engine's own suite
   * proves it builds correctly, and repeating that here would make every case
   * below depend on behaviour it is not testing. The call `consumption.test.ts`
   * makes, for the same reason.
   */
  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );
  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'RCLEP0001', CURRENT_DATE, now()) RETURNING id`,
    [org.organizationId, patientId]
  );
  const template = await owner.query<{ template_id: string; version_id: string }>(
    `SELECT t.id AS template_id, v.id AS version_id
       FROM consultation_templates t
       JOIN consultation_template_versions v ON v.template_id = t.id
      WHERE t.organization_id IS NULL AND v.status = 'PUBLISHED'
      ORDER BY t.code LIMIT 1`
  );
  const encounter = await owner.query<{ id: string }>(
    `INSERT INTO encounters
       (id, organization_id, branch_id, patient_id, clinical_episode_id, doctor_profile_id,
        template_id, template_version_id, template_snapshot, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'DRAFT', now())
     RETURNING id`,
    [
      org.organizationId,
      org.branchId,
      patientId,
      episode.rows[0]?.id ?? '',
      doctor.rows[0]?.id ?? '',
      template.rows[0]?.template_id ?? '',
      template.rows[0]?.version_id ?? '',
    ]
  );
  encounterId = encounter.rows[0]?.id ?? '';

  const item = await owner.query<{ id: string }>(
    `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'PROCEDURE', 'RCL_PROC', 'Rcl procedure', now())
     RETURNING id`,
    [org.organizationId]
  );
  const procedure = await owner.query<{ id: string }>(
    `INSERT INTO encounter_procedures
       (id, organization_id, branch_id, encounter_id, item_id, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PERFORMED', now())
     RETURNING id`,
    [org.organizationId, org.branchId, encounterId, item.rows[0]?.id ?? '']
  );
  procedureId = procedure.rows[0]?.id ?? '';

  /*
   * A delivery for the backward trace, written directly. The procurement suite
   * proves a GRN is BUILT correctly; what is under test here is the WALK from a
   * lot back to the supplier that sent it.
   */
  const supplier = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (id, organization_id, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'RCL-SUP', 'Rcl Supplies', now()) RETURNING id`,
    [org.organizationId]
  );
  supplierId = supplier.rows[0]?.id ?? '';

  const receipt = await owner.query<{ id: string }>(
    `INSERT INTO goods_receipts
       (id, organization_id, branch_id, receipt_number, supplier_id, status, supplier_name,
        supplier_invoice_number, location_id, currency, created_by_id, posted_at, posted_by_id,
        updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'RCL-GRN-1', $3, 'POSTED', 'Rcl Supplies',
             'INV-99', $4, 'INR', $5, now(), $5, now())
     RETURNING id`,
    [org.organizationId, org.branchId, supplierId, counter, org.ownerUserId]
  );
  await owner.query(
    `INSERT INTO goods_receipt_lines
       (id, organization_id, branch_id, goods_receipt_id, line_number, product_id, batch_id,
        received_quantity_base, quantity_entered, unit_id, lot_number, unit_cost_base, currency,
        updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, $5, 100, 100, $6, 'RCL-AFFECTED', 500, 'INR', now())`,
    [org.organizationId, org.branchId, receipt.rows[0]?.id ?? '', medicine, affectedLot, baseUnit]
  );
});

afterAll(async () => {
  if (org?.organizationId) {
    await owner.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
  }
  await owner.end();
  await disconnectDb();
  await redis.quit();
});

// ---------------------------------------------------------------------------
// What went out before anybody knew
// ---------------------------------------------------------------------------

describe('the product reaches people before the notice arrives', () => {
  it('is dispensed to a named patient', async () => {
    const dispense = await createDispense(ctx, {
      branchId: org.branchId,
      locationId: counter,
      kind: 'COUNTER_SALE',
      patientId,
      lines: [{ productId: medicine, quantity: '10', unitId: baseUnit }],
    } as never);

    expect(dispense.lines).toHaveLength(1);
    /* FEFO took the short-dated lot, which is the one about to be recalled. */
    expect(dispense.lines[0]?.allocations?.[0]?.batchId).toBe(affectedLot);
  });

  it('is used during a procedure on the same patient', async () => {
    const record = await recordConsumption(
      ctx,
      {
        branchId: org.branchId,
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: counter,
        /* No template covers this procedure, so every line is a variance. */
        lines: [
          {
            productId: medicine,
            quantity: '5',
            unitId: baseUnit,
            overrideReason: 'Used during the procedure; no template covers it.',
          },
        ],
      } as never,
      { permissionCodes: ['consumption.record', 'consumption.override'] }
    );

    expect(record.lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

describe('the notice', () => {
  it('is recorded with its own reference and holds nothing', async () => {
    const recall = await createRecall(ctx, {
      productId: medicine,
      title: 'Rcl medicine, contamination',
      classification: 'CLASS_I',
      source: 'MANUFACTURER',
      noticeReference: 'MFR-2026-77',
      reason: 'Sterility failure reported in this production run.',
    } as never);
    recallId = recall.id;

    expect(recall.reference).toMatch(/^REC-/);
    expect(recall.status).toBe('DRAFT');
    expect(recall.batches).toHaveLength(0);

    /*
     * ⚠️ THE POINT OF THE DRAFT STATE. Recording that a notice arrived must not
     *   stop a pharmacy mid-shift over lots somebody is still checking.
     */
    expect(await bucket(affectedLot, 'AVAILABLE')).toBe('85.000000');
  });

  it('refuses a lot of a different product', async () => {
    await expect(addRecallBatches(ctx, recallId, { batchIds: [otherLot] })).rejects.toThrow(
      /not a lot of the product/i
    );
  });

  it('offers every lot of the product as a candidate, including the empty one', async () => {
    const candidates = await listRecallCandidates(ctx, recallId);
    const lots = candidates.items.map((item) => item.lotNumber);

    expect(lots).toContain('RCL-AFFECTED');
    expect(lots).toContain('RCL-SOUND');
    /*
     * ⚠️ THE LOT WITH NOTHING ON THE SHELF IS THE ONE THE RECALL MOST NEEDS. It
     *   is where all of the work is contacting people, and filtering candidates
     *   to "has quantity" would hide precisely that case.
     */
    expect(lots).toContain('RCL-EMPTY');
    expect(lots).not.toContain('RCL-OTHER-LOT');
  });

  it('takes the two lots the notice names', async () => {
    const recall = await addRecallBatches(ctx, recallId, {
      batchIds: [affectedLot, emptyLot],
    });
    expect(recall.batches).toHaveLength(2);
    expect(recall.batches.every((lot) => lot.status === 'PENDING')).toBe(true);
  });

  it('cannot be closed before it has been executed', async () => {
    await expect(closeRecall(ctx, recallId, { outcomeNote: 'Nothing found.' })).rejects.toThrow(
      /has not been executed/i
    );
  });
});

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

describe('executing it', () => {
  it('moves the quantity, flags the lot and records what was pulled', async () => {
    const recall = await executeRecall(ctx, recallId, { note: 'Pulled on the notice.' });

    expect(recall.status).toBe('EXECUTED');
    expect(recall.executedByName).not.toBeNull();

    const affected = recall.batches.find((lot) => lot.lotNumber === 'RCL-AFFECTED');
    expect(affected?.status).toBe('HELD');
    expect(affected?.quantityHeldBase).toBe('85');

    /*
     * ⚠️ `NO_STOCK`, NOT A REFUSAL. A lot that was fully dispensed before the
     *   notice arrived is the URGENT case, and refusing to record it would leave
     *   it unrecordable.
     */
    const empty = recall.batches.find((lot) => lot.lotNumber === 'RCL-EMPTY');
    expect(empty?.status).toBe('NO_STOCK');
    expect(empty?.quantityHeldBase).toBe('0');

    expect(await bucket(affectedLot, 'AVAILABLE')).toBe('0.000000');
    expect(await bucket(affectedLot, 'RECALLED')).toBe('85.000000');
    expect(await batchStatusOf(affectedLot)).toBe('RECALLED');
  });

  it('writes every hold against the notice, not against the lot', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stock_ledger
        WHERE reference_type = 'RECALL' AND reference_id = $1 AND movement_type = 'RECALL'`,
      [recallId]
    );
    /*
     * ⚠️ THE REFERENCE IS THE RECALL'S ID. "What did this notice move" is the
     *   question asked when somebody wants to undo it, and it is not answerable
     *   from the batch side once two notices have touched one lot.
     */
    expect(Number(rows[0]?.count ?? '0')).toBe(1);
  });

  it('refuses to execute again with nothing left waiting', async () => {
    await expect(executeRecall(ctx, recallId, {})).rejects.toThrow(/no lots waiting/i);
  });
});

// ---------------------------------------------------------------------------
// The whole point: it cannot go out again
// ---------------------------------------------------------------------------

describe('a recalled lot is un-dispensable and un-consumable', () => {
  it('is excluded from the allocation plan every path shares', async () => {
    const plan = await planStockAllocation(ctx, {
      branchId: org.branchId,
      productId: medicine,
      quantity: '200',
      unitId: baseUnit,
    } as never);

    const lots = plan.lines.map((line) => line.batchId);
    expect(lots).not.toContain(affectedLot);
    expect(lots).toContain(soundLot);
  });

  it('cannot be dispensed', async () => {
    /*
     * The sound lot holds 100 and the recalled one 85. Asking for 150 can only
     * be satisfied by reaching into the recalled lot — so a shortfall here IS
     * the proof, and a success would mean the recall leaked.
     */
    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: counter,
        kind: 'COUNTER_SALE',
        lines: [{ productId: medicine, quantity: '150', unitId: baseUnit }],
      } as never)
    ).rejects.toThrow();
  });

  it('cannot be consumed', async () => {
    await expect(
      recordConsumption(
        ctx,
        {
          branchId: org.branchId,
          anchorKind: 'ENCOUNTER',
          encounterId,
          locationId: counter,
          lines: [
            {
              productId: medicine,
              quantity: '5',
              unitId: baseUnit,
              allocations: [{ locationId: counter, batchId: affectedLot, quantityBase: '5' }],
            },
          ],
        } as never,
        { permissionCodes: ['consumption.record', 'consumption.override'] }
      )
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ⚠️ The defect PI-10 found in PI-2
// ---------------------------------------------------------------------------

describe('a serialised lot can actually be held', () => {
  /**
   * ⚠️ THIS FAILED BEFORE PI-10, AND IT FAILED AT THE ONE PRODUCT CLASS A RECALL
   *   MATTERS MOST FOR. `recordMovementIn` refuses a movement of a
   *   `SERIAL`/`LOT_AND_SERIAL` product that names no serial, and neither
   *   `setBatchHold` nor anything else passed one — so holding a lot of implants
   *   raised "this product is serial-tracked" and pulled nothing. Nothing in the
   *   inventory suite had ever held a serialised lot, so it shipped.
   */
  it('pulls the device and marks the serial recalled', async () => {
    const recall = await createRecall(ctx, {
      productId: implant,
      title: 'Rcl implant, fracture reports',
      classification: 'CLASS_I',
      source: 'REGULATOR',
      reason: 'Fracture reports against this production run.',
      batchIds: [implantLot],
    } as never);

    const executed = await executeRecall(ctx, recall.id, {});
    expect(executed.batches[0]?.status).toBe('HELD');
    expect(executed.batches[0]?.quantityHeldBase).toBe('1');

    expect(await bucket(implantLot, 'RECALLED')).toBe('1.000000');

    const { rows } = await owner.query<{ status: string }>(
      `SELECT status::text AS status FROM serials WHERE id = $1`,
      [implantSerial]
    );
    /*
     * ⚠️ AND THE SERIAL FOLLOWS THE LOT. Without this a recalled implant reads
     *   IN_STOCK on the serial screen while its quantity sits in the RECALLED
     *   bucket — two answers to "may this be fitted", and the screen a theatre
     *   nurse looks at is the one that says yes.
     */
    expect(rows[0]?.status).toBe('RECALLED');
  });
});

describe('holding a serialised lot one at a time', () => {
  /**
   * ⚠️ THE SAME PI-2 DEFECT, ON THE OTHER PATH. `POST /batches/:id/hold` has
   *   existed since PI-2 and had never been pointed at a serial-tracked product;
   *   it read the lot's balance rows without their `serial_id` and passed none to
   *   the engine, which refuses a movement of a serialised product that names no
   *   serial. So the storekeeper's own quarantine button raised a validation
   *   error on every implant in the clinic.
   *
   *   ⚠️ THIS CASE WAS VERIFIED TO FAIL AGAINST THE REVERTED CODE. A regression
   *     test that passes either way is worth nothing.
   */
  it('quarantines a lot of implants and follows the serial', async () => {
    const lot = await makeLot(implant, 'RCL-IMP-LOT-2', '2029-06-30');
    const serial = (
      await createSerial(ctx, {
        branchId: org.branchId,
        productId: implant,
        batchId: lot,
        serialNumber: 'RCL-SER-2',
      } as never)
    ).id;
    await stockUp(implant, lot, '1', serial);

    await setBatchHold(ctx, lot, 'QUARANTINE', { reason: 'Cold chain excursion overnight.' });

    expect(await bucket(lot, 'QUARANTINED')).toBe('1.000000');
    expect(await bucket(lot, 'AVAILABLE')).toBe('0.000000');

    const { rows } = await owner.query<{ status: string }>(
      `SELECT status::text AS status FROM serials WHERE id = $1`,
      [serial]
    );
    expect(rows[0]?.status).toBe('QUARANTINED');
  });
});

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

describe('forward trace', () => {
  it('finds the dispense AND the procedure', async () => {
    const trace = await forwardTrace(ctx, { batchId: affectedLot });

    expect(trace.lotNumber).toBe('RCL-AFFECTED');
    expect(trace.quantityDispensedBase).toBe('10');
    /*
     * ⚠️ THE HALF A RECALL THAT WALKED ONLY `dispense_allocations` WOULD MISS.
     *   Nothing consumed during a procedure ever went out of a counter, so an
     *   implant fitted in theatre would be invisible to it.
     */
    expect(trace.quantityConsumedBase).toBe('5');
    expect(trace.supplyCount).toBe(1);
    expect(trace.procedureCount).toBe(1);
    /* One person, reached twice. A set, not a row count. */
    expect(trace.patientCount).toBe(1);

    const recalled = trace.onHand.find((row) => row.status === 'RECALLED');
    expect(recalled?.quantityBase).toBe('85');
  });
});

describe('backward trace', () => {
  it('reaches the supplier that sent it', async () => {
    const trace = await backwardTrace(ctx, { batchId: affectedLot });

    expect(trace.lotNumber).toBe('RCL-AFFECTED');
    expect(trace.receipts).toHaveLength(1);
    expect(trace.receipts[0]?.supplierName).toBe('Rcl Supplies');
    expect(trace.receipts[0]?.supplierInvoiceNumber).toBe('INV-99');
    expect(trace.receipts[0]?.supplierId).toBe(supplierId);
  });
});

describe('the affected-party list', () => {
  it('names the people and files one disclosure row carrying the count', async () => {
    const before = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'RECALL_TRACE'`,
      [org.organizationId]
    );

    const affected = await listAffectedParties(
      ctx,
      { recallId, page: 1, limit: 20, sortOrder: 'desc' } as never,
      { route: 'GET /v1/traceability/affected' }
    );

    expect(affected.total).toBe(2);
    expect(affected.items.map((item) => item.route).sort()).toEqual(['CONSUMPTION', 'DISPENSE']);
    expect(affected.items.every((item) => item.patientId === patientId)).toBe(true);
    expect(affected.items[0]?.patientName).toBe('Rcl Patient');

    const after = await owner.query<{ count: string; result_count: number }>(
      `SELECT count(*)::text AS count, max(result_count) AS result_count
         FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'RECALL_TRACE'`,
      [org.organizationId]
    );

    /*
     * ⚠️ ONE ROW, CARRYING THE COUNT, AND NOT ONE PER PATIENT. A disclosure
     *   review asks "who pulled the affected-patient list" — that is one act by
     *   one person, and a row per patient would bury it under the very reads it
     *   exists to surface.
     */
    expect(Number(after.rows[0]?.count ?? '0')).toBe(Number(before.rows[0]?.count ?? '0') + 1);
    expect(after.rows[0]?.result_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ending it
// ---------------------------------------------------------------------------

describe('ending it', () => {
  it('will not cancel while a lot is still held', async () => {
    await expect(
      cancelRecall(ctx, recallId, { outcomeNote: 'Withdrawn by the manufacturer.' })
    ).rejects.toThrow(/still holding/i);
  });

  it('releases a lot back onto the shelf, with a movement and a reason', async () => {
    const recall = await getRecall(ctx, recallId);
    const held = recall.batches.find((lot) => lot.status === 'HELD');
    expect(held).toBeDefined();

    const resolved = await resolveRecallBatch(ctx, recallId, held?.id ?? '', {
      resolution: 'RELEASE',
      note: 'The manufacturer confirmed this lot was not in the affected run.',
    });

    const row = resolved.batches.find((lot) => lot.id === held?.id);
    expect(row?.status).toBe('RELEASED');
    expect(row?.releasedAt).not.toBeNull();

    expect(await bucket(affectedLot, 'RECALLED')).toBe('0.000000');
    expect(await bucket(affectedLot, 'AVAILABLE')).toBe('85.000000');
    expect(await batchStatusOf(affectedLot)).toBe('ACTIVE');
  });

  it('makes it dispensable again', async () => {
    const plan = await planStockAllocation(ctx, {
      branchId: org.branchId,
      productId: medicine,
      quantity: '200',
      unitId: baseUnit,
    } as never);
    expect(plan.lines.map((line) => line.batchId)).toContain(affectedLot);
  });

  it('closes once every lot has been looked at', async () => {
    const closed = await closeRecall(ctx, recallId, {
      outcomeNote:
        'One lot cleared by the manufacturer; the other was fully dispensed and one patient was contacted.',
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedByName).not.toBeNull();
  });

  it('appears on the list, searchable by the lot number it named', async () => {
    const list = await listRecalls(ctx, {
      page: 1,
      limit: 20,
      sortOrder: 'desc',
      search: 'RCL-AFFECTED',
    } as never);

    expect(list.items.map((item) => item.id)).toContain(recallId);
  });
});
