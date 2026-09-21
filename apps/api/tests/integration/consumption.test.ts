/**
 * PI-9: clinical consumption — against a real Postgres, through the real
 * services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `pharmacy` proves stock leaves a counter correctly and `charging` proves the
 * money side of that. This proves the OTHER writer of both: what a procedure
 * used, and the seam PI-8 built and left with no caller.
 *
 *   THE TEMPLATE PRE-FILLS AND DEDUCTS NOTHING   planning writes no ledger row
 *                                                and holds no stock.
 *   RECORDING MOVES THE STOCK ONCE               one transaction writes the
 *                                                record, the lots, the legs and
 *                                                the charge requests.
 *   A GLOVE PRODUCES NO INVOICE LINE             and an implant does, through
 *                                                identical code. PI-ADR-005's
 *                                                own test, from the other side.
 *   THE VARIANCE IS DERIVED, NEVER DECLARED      the client sends no flag, and a
 *                                                departure with no reason is
 *                                                refused.
 *   A LINE MAY NOT CLAIM THE WRONG TEMPLATE LINE the PI-9 analogue of PI-8.11's
 *                                                dispensing CRITICAL.
 *   AN OVERRIDE IS AUDITED, NOT OBSTRUCTED       three pairs of gloves is three
 *                                                pairs of gloves.
 *   A CORRECTION IS A SECOND RECORD              never an edit, and it cannot put
 *                                                back more than came off.
 *   A CONSUMED SERIAL NAMES ITS PATIENT          which is what makes a device
 *                                                recall answerable.
 *
 * ⚠️ THE VARIANCE CASES ARE THE ONES MOST LIKELY TO BE BROKEN BY A LATER
 *   REFACTOR. `isOverride` is absent from the request contract on purpose; a
 *   change that "simplifies" it into a client-supplied flag would pass every
 *   other case in this file.
 *
 * Every fixture is prefixed `CNS-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import type { TenantContext } from '@rcln/db';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { createSerial } from '../../src/services/inventory/serial.service.js';
import {
  createConsumptionTemplate,
  updateConsumptionTemplate,
} from '../../src/services/consumption/template.service.js';
import {
  amendConsumption,
  correctConsumption,
  getConsumption,
  listConsumptions,
  planConsumption,
  recordConsumption,
} from '../../src/services/consumption/consumption.service.js';
import type { ConsumptionActionOptions } from '../../src/services/consumption/shared.js';

const SUFFIX = `n${Date.now().toString(36)}`;
const SLUG = `cns-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
/** A consumable — NOT billable by default. The glove. */
let glove: string;
/** An implant — billable by default. The other half of PI-ADR-005's test. */
let implant: string;
/** Something the template never lists. */
let extra: string;
/** A serial-tracked device, and its two numbered units (PI-9.9). */
let device: string;
let serialA: string;
let serialB: string;

let trolley: string;
let patientId: string;
let encounterId: string;
let procedureId: string;
let procedureItemId: string;
let templateId: string;
let gloveTemplateLineId: string;

/**
 * ⚠️ EVERY CALL PASSES THE OVERRIDE CODE, WHICH IS THE DEFAULT FOR A CLINICIAN.
 *   `assertMayOverride` reads exactly this; the one case that withholds it does
 *   so explicitly, and that is the case that proves the split is real.
 */
const MAY_OVERRIDE: ConsumptionActionOptions = {
  permissionCodes: ['consumption.record', 'consumption.override'],
};
const MAY_NOT_OVERRIDE: ConsumptionActionOptions = { permissionCodes: ['consumption.record'] };

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

async function makeProduct(code: string, type: string, tracking = 'NONE'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ProductType", 'ACTIVE', $3, $4, $5,
             $6::"TrackingMode", true, now())
     RETURNING id`,
    [org.organizationId, type, code, `Cns ${code}`, baseUnit, tracking]
  );
  return rows[0]?.id ?? '';
}

async function stockUp(productId: string, quantity: string): Promise<void> {
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId,
    movementType: 'RETURN',
    quantity,
    locationId: trolley,
    referenceType: 'MANUAL',
  });
}

/** What the branch holds of one product, across every bucket that is AVAILABLE. */
async function available(productId: string): Promise<string> {
  const { rows } = await owner.query<{ total: string | null }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS total
       FROM stock_balances
      WHERE organization_id = $1 AND product_id = $2 AND status = 'AVAILABLE'`,
    [org.organizationId, productId]
  );
  return rows[0]?.total ?? '0';
}

/** The charge requests raised against one consumption, in line order. */
async function chargesFor(
  consumptionId: string
): Promise<
  { status: string; policy: string; kind: string; description: string; quantity: string }[]
> {
  const { rows } = await owner.query(
    `SELECT cr.status, cr.policy, cr.kind, cr.description, cr.quantity::text AS quantity
       FROM charge_requests cr
       JOIN consumption_lines cl ON cl.id = cr.consumption_line_id
      WHERE cl.consumption_id = $1
      ORDER BY cl.line_number`,
    [consumptionId]
  );
  return rows as never;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Cns'));
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

  glove = await makeProduct('CNS-GLOVE', 'CONSUMABLE');
  implant = await makeProduct('CNS-IMPLANT', 'IMPLANT');
  extra = await makeProduct('CNS-EXTRA', 'CONSUMABLE');
  device = await makeProduct('CNS-DEVICE', 'IMPLANT', 'SERIAL');

  trolley = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'PROCEDURE_ROOM',
      code: 'CNS_TROLLEY',
      name: 'Cns Trolley',
      /*
       * ⚠️ NOT A DISPENSING POINT, DELIBERATELY. A treatment room's trolley is
       *   not a counter, and this fixture is what proves `resolveConsumptionLocation`
       *   does not require the flag `resolveDispensingLocation` does.
       */
      isDispensingPoint: false,
      requiresControlledAccess: false,
    })
  ).id;

  await stockUp(glove, '500');
  await stockUp(implant, '50');
  await stockUp(extra, '100');

  /*
   * ⚠️ TWO NUMBERED DEVICES, WHICH IS THE WHOLE POINT OF PI-9.9. One is enough
   *   to prove a serial gets assigned; two is what proves a clinician can say
   *   WHICH — and that the other one is left alone.
   */
  serialA = (
    await createSerial(ctx, {
      branchId: org.branchId,
      productId: device,
      serialNumber: 'CNS-SER-A',
    })
  ).id;
  serialB = (
    await createSerial(ctx, {
      branchId: org.branchId,
      productId: device,
      serialNumber: 'CNS-SER-B',
    })
  ).id;
  for (const serialId of [serialA, serialB]) {
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: device,
      serialId,
      movementType: 'RETURN',
      quantity: '1',
      locationId: trolley,
      referenceType: 'MANUAL',
    });
  }

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'CNS00001', 'Cns', 'Patient', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]?.id ?? '';

  /*
   * The clinical chain, written directly. The consultation engine's own suite
   * proves it builds correctly; repeating that here would make every case below
   * depend on behaviour it is not testing — the call `charging.test.ts` makes
   * about FEFO.
   */
  const doctor = await owner.query<{ id: string }>(
    `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [org.organizationId, org.ownerUserId]
  );

  const episode = await owner.query<{ id: string }>(
    `INSERT INTO clinical_episodes (id, organization_id, patient_id, code, opened_on, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'CNSEP0001', CURRENT_DATE, now()) RETURNING id`,
    [org.organizationId, patientId]
  );

  const template = await owner.query<{ template_id: string; version_id: string }>(
    `SELECT t.id AS template_id, v.id AS version_id
       FROM consultation_templates t
       JOIN consultation_template_versions v ON v.template_id = t.id
      WHERE t.organization_id IS NULL AND v.status = 'PUBLISHED'
      ORDER BY t.code LIMIT 1`
  );
  const consultationTemplateId = template.rows[0]?.template_id ?? '';
  const consultationVersionId = template.rows[0]?.version_id ?? '';
  if (!consultationTemplateId)
    throw new Error('the seed is missing a published consultation template');

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
      consultationTemplateId,
      consultationVersionId,
    ]
  );
  encounterId = encounter.rows[0]?.id ?? '';

  const item = await owner.query<{ id: string }>(
    `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'PROCEDURE', 'CNS_ROOT_CANAL', 'Cns root canal', now())
     RETURNING id`,
    [org.organizationId]
  );
  procedureItemId = item.rows[0]?.id ?? '';

  const procedure = await owner.query<{ id: string }>(
    `INSERT INTO encounter_procedures
       (id, organization_id, branch_id, encounter_id, item_id, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PERFORMED', now())
     RETURNING id`,
    [org.organizationId, org.branchId, encounterId, procedureItemId]
  );
  procedureId = procedure.rows[0]?.id ?? '';
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
// The template
// ---------------------------------------------------------------------------

describe('the template', () => {
  it('is created, filled and put in force', async () => {
    const created = await createConsumptionTemplate(ctx, {
      itemId: procedureItemId,
      name: 'Root canal tray v1',
      status: 'DRAFT',
      lines: [],
    });
    templateId = created.id;
    expect(created.version).toBe(1);
    expect(created.lines).toHaveLength(0);

    const filled = await updateConsumptionTemplate(ctx, templateId, {
      status: 'ACTIVE',
      lines: [
        { productId: glove, quantity: '2', unitId: baseUnit, isOptional: false, displayOrder: 0 },
        { productId: implant, quantity: '1', unitId: baseUnit, isOptional: true, displayOrder: 1 },
      ],
    });
    expect(filled.status).toBe('ACTIVE');
    expect(filled.lines).toHaveLength(2);

    gloveTemplateLineId = filled.lines.find((line) => line.productId === glove)?.id ?? '';
    expect(gloveTemplateLineId).not.toBe('');
  });

  it('refuses a template against something that is not a procedure', async () => {
    const diagnosis = await owner.query<{ id: string }>(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'DIAGNOSIS', 'CNS_NOT_A_PROC', 'Cns diagnosis', now())
       RETURNING id`,
      [org.organizationId]
    );
    await expect(
      createConsumptionTemplate(ctx, {
        itemId: diagnosis.rows[0]?.id ?? '',
        name: 'Nonsense',
        status: 'DRAFT',
        lines: [],
      })
    ).rejects.toThrow(/not a procedure/i);
  });

  /**
   * ⚠️ TWO TEMPLATES IN FORCE ON ONE DAY IS TWO ANSWERS TO WHAT A PROCEDURE
   *   EXPECTS. The database holds the open-ended half; this is the other half.
   */
  it('refuses a second version covering the same days', async () => {
    await expect(
      createConsumptionTemplate(ctx, {
        itemId: procedureItemId,
        name: 'Root canal tray v2',
        status: 'ACTIVE',
        lines: [],
      })
    ).rejects.toThrow(/already covers those dates/i);
  });

  it('refuses to list the same product twice', async () => {
    await expect(
      updateConsumptionTemplate(ctx, templateId, {
        lines: [
          { productId: glove, quantity: '2', unitId: baseUnit, isOptional: false, displayOrder: 0 },
          { productId: glove, quantity: '3', unitId: baseUnit, isOptional: false, displayOrder: 1 },
        ],
      })
    ).rejects.toThrow(/one product, one line/i);
  });
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('the plan', () => {
  /**
   * ⚠️ THE ONE PROPERTY THAT MATTERS: A TEMPLATE DEDUCTS NOTHING. Planning is
   *   read-only, holds no stock and writes no ledger row — asserted against the
   *   balance rather than against the absence of an error, because "it did not
   *   throw" would pass if it had quietly reserved something.
   */
  it('pre-fills from the template in force and moves no stock', async () => {
    const before = await available(glove);

    const plan = await planConsumption(ctx, {
      encounterId,
      encounterProcedureId: procedureId,
    });

    expect(plan.templateId).toBe(templateId);
    expect(plan.patientId).toBe(patientId);
    expect(plan.encounterIsOpen).toBe(true);
    expect(plan.lines).toHaveLength(2);

    const gloveLine = plan.lines.find((line) => line.productId === glove);
    expect(gloveLine?.expectedQuantityBase).toBe('2');
    expect(gloveLine?.isOptional).toBe(false);

    expect(await available(glove)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

describe('recording what was used', () => {
  let recordedId: string;

  it('takes the stock off the shelf and raises the charge requests', async () => {
    const gloveBefore = await available(glove);
    const implantBefore = await available(implant);

    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '2',
            unitId: baseUnit,
          },
        ],
      },
      MAY_OVERRIDE
    );
    recordedId = record.id;

    expect(record.kind).toBe('CONSUMPTION');
    expect(record.lines).toHaveLength(1);
    expect(record.lines[0]?.quantityBase).toBe('2');
    expect(record.lines[0]?.varianceBase).toBe('0');
    expect(record.lines[0]?.isOverride).toBe(false);
    expect(record.hasVariance).toBe(false);

    /* Two gloves came off; nothing else moved. */
    expect(Number(await available(glove))).toBe(Number(gloveBefore) - 2);
    expect(await available(implant)).toBe(implantBefore);

    /*
     * ⚠️ PI-ADR-005, FROM THE OTHER SIDE. A glove reaches a charge request and
     *   that request is SUPPRESSED with the policy's own name as the reason —
     *   "we decided not to charge for this" and "we forgot" are indistinguishable
     *   in a revenue figure and are entirely different problems.
     */
    const charges = await chargesFor(recordedId);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.policy).toBe('NEVER_BILL');
    expect(charges[0]?.status).toBe('SUPPRESSED');
    expect(charges[0]?.kind).toBe('SUPPLY');
  });

  it('writes the ledger legs against the consumption', async () => {
    const { rows } = await owner.query<{ movement_type: string; quantity: string }>(
      `SELECT movement_type, quantity_base::text AS quantity
         FROM stock_ledger
        WHERE organization_id = $1 AND reference_type = 'CONSUMPTION' AND reference_id = $2`,
      [org.organizationId, recordedId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.movement_type).toBe('CLINICAL_CONSUMPTION');
    /* The sign is a property of the movement type, not of the request. */
    expect(Number(rows[0]?.quantity)).toBeLessThan(0);
  });

  /**
   * ⚠️ THE IMPLANT IS THE OTHER HALF OF PI-ADR-005's TEST, AND IT TRAVELS
   *   THROUGH IDENTICAL CODE. Nothing in the consumption service knows which of
   *   the two is billable; the charge policy does.
   */
  it('bills an implant and not a glove, through the same call', async () => {
    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            productId: implant,
            quantity: '1',
            unitId: baseUnit,
            /* Optional lines expect nothing, so using one IS a departure. */
            overrideReason: 'The canal needed a post.',
          },
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '2',
            unitId: baseUnit,
          },
        ],
      },
      MAY_OVERRIDE
    );

    const charges = await chargesFor(record.id);
    const implantCharge = charges.find((charge) => charge.policy === 'SEPARATELY_BILLABLE');
    const gloveCharge = charges.find((charge) => charge.policy === 'NEVER_BILL');

    expect(implantCharge?.status).toBe('PENDING');
    expect(gloveCharge?.status).toBe('SUPPRESSED');
  });

  /**
   * ⚠️ THE PI-9 ANALOGUE OF PI-8.11's DISPENSING CRITICAL. A line that cited the
   *   glove's template line while consuming an implant would be recorded with an
   *   expectation of 2 and a variance of −1, and the variance report would say a
   *   procedure under-used something it never listed.
   */
  it('refuses a line that claims a template line for a different product', async () => {
    await expect(
      recordConsumption(
        ctx,
        {
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId,
          encounterProcedureId: procedureId,
          locationId: trolley,
          lines: [
            {
              templateLineId: gloveTemplateLineId,
              productId: implant,
              quantity: '1',
              unitId: baseUnit,
              overrideReason: 'Trying it on',
            },
          ],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/does not match the template line/i);
  });

  /**
   * ⚠️ THE VARIANCE IS DERIVED. There is no `isOverride` on the request at all,
   *   so a client cannot record a departure as routine — the server compares the
   *   two numbers and decides.
   */
  it('derives the departure and demands a reason for it', async () => {
    await expect(
      recordConsumption(
        ctx,
        {
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId,
          encounterProcedureId: procedureId,
          locationId: trolley,
          lines: [
            {
              templateLineId: gloveTemplateLineId,
              productId: glove,
              quantity: '3',
              unitId: baseUnit,
            },
          ],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/say why/i);
  });

  /**
   * ⚠️ AND AN OVERRIDE IS AUDITED, NEVER OBSTRUCTED. A dentist who used three
   *   pairs of gloves used three pairs of gloves. This is the case that would
   *   break first if somebody "helpfully" clamped the figure to the template.
   */
  it('records three pairs of gloves when three pairs were used', async () => {
    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '3',
            unitId: baseUnit,
            overrideReason: 'A pair tore.',
          },
        ],
      },
      MAY_OVERRIDE
    );

    expect(record.lines[0]?.quantityBase).toBe('3');
    expect(record.lines[0]?.varianceBase).toBe('1');
    expect(record.lines[0]?.isOverride).toBe(true);
    expect(record.hasVariance).toBe(true);
  });

  /** The permission split is real, and refusing is better than clamping. */
  it('refuses a departure to somebody without the override code', async () => {
    await expect(
      recordConsumption(
        ctx,
        {
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId,
          encounterProcedureId: procedureId,
          locationId: trolley,
          lines: [
            {
              templateLineId: gloveTemplateLineId,
              productId: glove,
              quantity: '4',
              unitId: baseUnit,
              overrideReason: 'Two pairs tore.',
            },
          ],
        },
        MAY_NOT_OVERRIDE
      )
    ).rejects.toThrow(/override permission/i);
  });

  /** A product the template never listed is an ordinary event, recorded as one. */
  it('records something the template never listed', async () => {
    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            productId: extra,
            quantity: '1',
            unitId: baseUnit,
            overrideReason: 'Needed a second suction tip.',
          },
        ],
      },
      MAY_OVERRIDE
    );

    expect(record.lines[0]?.expectedQuantityBase).toBe('0');
    expect(record.lines[0]?.isOverride).toBe(true);
  });

  it('refuses a procedure belonging to a different consultation', async () => {
    const other = await owner.query<{ id: string }>(
      `INSERT INTO encounter_procedures
         (id, organization_id, branch_id, encounter_id, item_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PERFORMED', now()) RETURNING id`,
      [org.organizationId, org.branchId, encounterId, procedureItemId]
    );
    /* Same consultation — so this one must PASS, and the id swap below must not. */
    await expect(
      recordConsumption(
        ctx,
        {
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId,
          encounterProcedureId: other.rows[0]?.id ?? '',
          locationId: trolley,
          lines: [{ productId: glove, quantity: '1', unitId: baseUnit, overrideReason: 'x' }],
        },
        MAY_OVERRIDE
      )
    ).resolves.toBeDefined();

    await expect(
      recordConsumption(
        ctx,
        {
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId,
          /* A uuid that is not a procedure of this consultation. */
          encounterProcedureId: patientId,
          locationId: trolley,
          lines: [{ productId: glove, quantity: '1', unitId: baseUnit, overrideReason: 'x' }],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/not found/i);
  });

  it('lists what a consultation used', async () => {
    const list = await listConsumptions(ctx, {
      encounterId,
      page: 1,
      limit: 50,
      sortOrder: 'desc',
    });
    expect(list.total).toBeGreaterThan(1);
    expect(list.items.every((item) => item.encounterId === encounterId)).toBe(true);
  });

  it('lists only the departures when asked', async () => {
    const list = await listConsumptions(ctx, {
      encounterId,
      varianceOnly: true,
      page: 1,
      limit: 50,
      sortOrder: 'desc',
    });
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((item) => item.hasVariance)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Amending, while the consultation is open
// ---------------------------------------------------------------------------

describe('amending before the consultation closes', () => {
  let amendableId: string;

  beforeAll(async () => {
    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '2',
            unitId: baseUnit,
          },
        ],
      },
      MAY_OVERRIDE
    );
    amendableId = record.id;
  });

  /**
   * ⚠️ THE RECORD IS RESTATED AND THE LEDGER IS NOT. A restatement downwards puts
   *   the difference back with a `RETURN` leg; the original `CLINICAL_CONSUMPTION`
   *   leg stays exactly where it is, because `stock_ledger` has no update path.
   */
  it('restates the record and writes only the difference to the ledger', async () => {
    const before = await available(glove);

    const amended = await amendConsumption(
      ctx,
      amendableId,
      {
        reason: 'Miscounted at the chair.',
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '1',
            unitId: baseUnit,
            overrideReason: 'Only one pair was opened.',
          },
        ],
      },
      MAY_OVERRIDE
    );

    expect(amended.lines).toHaveLength(1);
    expect(amended.lines[0]?.quantityBase).toBe('1');
    expect(amended.amendedAt).not.toBeNull();

    /* One glove came back. */
    expect(Number(await available(glove))).toBe(Number(before) + 1);

    const { rows } = await owner.query<{ movement_type: string }>(
      `SELECT movement_type FROM stock_ledger
        WHERE organization_id = $1 AND reference_id = $2
        ORDER BY recorded_at, id`,
      [org.organizationId, amendableId]
    );
    expect(rows.map((row) => row.movement_type)).toEqual(['CLINICAL_CONSUMPTION', 'RETURN']);
  });

  it('adds a line that was not there before', async () => {
    const amended = await amendConsumption(
      ctx,
      amendableId,
      {
        reason: 'Forgot the suction tip.',
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '1',
            unitId: baseUnit,
            overrideReason: 'Only one pair was opened.',
          },
          {
            productId: extra,
            quantity: '1',
            unitId: baseUnit,
            overrideReason: 'Not on the tray.',
          },
        ],
      },
      MAY_OVERRIDE
    );
    expect(amended.lines).toHaveLength(2);
  });

  /**
   * ⚠️ ONCE THE CONSULTATION IS SIGNED, WHAT IT CONSUMED IS PART OF THE RECORD.
   *   The ledger is corrected by another movement, never by an edit.
   */
  it('refuses once the consultation has been signed', async () => {
    /*
     * ⚠️ ALL FOUR FACTS, BECAUSE `encounters_lifecycle_facts` REQUIRES THEM
     *   TOGETHER. A FINALIZED row with no `finalized_by` and no number is a
     *   signed record nobody signed; the CHECK refuses it, which is the
     *   constraint doing its job and not an obstacle to route around.
     */
    await owner.query(
      `UPDATE encounters
          SET status = 'FINALIZED', finalized_at = now(), finalized_by = $2,
              encounter_number = 'ENC-CNS-0001'
        WHERE id = $1`,
      [encounterId, org.ownerUserId]
    );

    await expect(
      amendConsumption(
        ctx,
        amendableId,
        {
          reason: 'Too late.',
          lines: [{ productId: glove, quantity: '1', unitId: baseUnit, overrideReason: 'x' }],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/signed/i);
  });
});

// ---------------------------------------------------------------------------
// Correcting, once it has closed
// ---------------------------------------------------------------------------

describe('correcting after the consultation closes', () => {
  let originalId: string;

  beforeAll(async () => {
    /* Recording against a finalized consultation is allowed — a nurse
       reconciling a tray after the doctor has signed is the ordinary case. */
    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: procedureId,
        locationId: trolley,
        lines: [
          {
            templateLineId: gloveTemplateLineId,
            productId: glove,
            quantity: '2',
            unitId: baseUnit,
          },
        ],
      },
      MAY_OVERRIDE
    );
    originalId = record.id;
  });

  it('puts stock back with a second record that cites the first', async () => {
    const before = await available(glove);

    const correction = await correctConsumption(
      ctx,
      originalId,
      {
        kind: 'CONSUMPTION_REVERSAL',
        reason: 'One pair went back unopened.',
        lines: [{ productId: glove, quantity: '1', unitId: baseUnit }],
      },
      MAY_OVERRIDE
    );

    expect(correction.kind).toBe('CONSUMPTION_REVERSAL');
    expect(correction.correctsConsumptionId).toBe(originalId);
    expect(Number(await available(glove))).toBe(Number(before) + 1);

    /* The original is untouched — a correction never edits what it corrects. */
    const original = await getConsumption(ctx, originalId);
    expect(original.lines[0]?.quantityBase).toBe('2');
    expect(original.corrections).toHaveLength(1);

    const charges = await chargesFor(correction.id);
    expect(charges[0]?.kind).toBe('REVERSAL');
    /* ⚠️ Nobody "returns" a consumed material — see `describe` in the engine. */
    expect(charges[0]?.description).toMatch(/not used/i);
  });

  /**
   * ⚠️ THE CEILING, COMPUTED UNDER THE LOCK. Two reversals that together exceed
   *   what came off the shelf would put back stock the clinic never took —
   *   PI-8.11's `alreadyCreditedByItem` finding, in this domain.
   */
  it('refuses to put back more than came off', async () => {
    await expect(
      correctConsumption(
        ctx,
        originalId,
        {
          kind: 'CONSUMPTION_REVERSAL',
          reason: 'Trying to put back two more.',
          lines: [{ productId: glove, quantity: '2', unitId: baseUnit }],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/still outstanding/i);
  });

  it('refuses to put back something the original never used', async () => {
    await expect(
      correctConsumption(
        ctx,
        originalId,
        {
          kind: 'CONSUMPTION_REVERSAL',
          reason: 'Never used it.',
          lines: [{ productId: implant, quantity: '1', unitId: baseUnit }],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/never taken/i);
  });

  it('takes more stock for an additional consumption', async () => {
    const before = await available(glove);

    const correction = await correctConsumption(
      ctx,
      originalId,
      {
        kind: 'ADDITIONAL_CONSUMPTION',
        reason: 'A third pair was opened after the record was written.',
        lines: [{ productId: glove, quantity: '1', unitId: baseUnit }],
      },
      MAY_OVERRIDE
    );

    expect(correction.kind).toBe('ADDITIONAL_CONSUMPTION');
    expect(Number(await available(glove))).toBe(Number(before) - 1);

    const charges = await chargesFor(correction.id);
    expect(charges[0]?.kind).toBe('SUPPLY');
  });

  it('refuses a correction against a correction', async () => {
    const correction = await correctConsumption(
      ctx,
      originalId,
      {
        kind: 'ADDITIONAL_CONSUMPTION',
        reason: 'One more.',
        lines: [{ productId: glove, quantity: '1', unitId: baseUnit }],
      },
      MAY_OVERRIDE
    );

    await expect(
      correctConsumption(
        ctx,
        correction.id,
        {
          kind: 'ADDITIONAL_CONSUMPTION',
          reason: 'And another.',
          lines: [{ productId: glove, quantity: '1', unitId: baseUnit }],
        },
        MAY_OVERRIDE
      )
    ).rejects.toThrow(/cites the original/i);
  });
});

// ---------------------------------------------------------------------------
// Choosing the lot, and the numbered device (PI-9.9)
// ---------------------------------------------------------------------------

describe('choosing which one was used', () => {
  /**
   * ⚠️ ITS OWN PROCEDURE AND ITS OWN TEMPLATE. A second template against the
   *   root canal is refused — correctly — because two templates in force on one
   *   day is two answers to what a procedure expects. Fitting a device is a
   *   different procedure anyway, which is what makes this the honest fixture
   *   rather than a way around the rule.
   */
  let deviceProcedureId: string;
  let deviceTemplateLineId: string;

  beforeAll(async () => {
    const item = await owner.query<{ id: string }>(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'PROCEDURE', 'CNS_FIT_DEVICE', 'Cns fit device', now())
       RETURNING id`,
      [org.organizationId]
    );
    const deviceItemId = item.rows[0]?.id ?? '';

    const procedure = await owner.query<{ id: string }>(
      `INSERT INTO encounter_procedures
         (id, organization_id, branch_id, encounter_id, item_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PERFORMED', now())
       RETURNING id`,
      [org.organizationId, org.branchId, encounterId, deviceItemId]
    );
    deviceProcedureId = procedure.rows[0]?.id ?? '';

    const created = await createConsumptionTemplate(ctx, {
      itemId: deviceItemId,
      name: 'Device tray',
      status: 'DRAFT',
      lines: [
        { productId: device, quantity: '1', unitId: baseUnit, isOptional: false, displayOrder: 0 },
      ],
    });
    const active = await updateConsumptionTemplate(ctx, created.id, { status: 'ACTIVE' });
    deviceTemplateLineId = active.lines[0]?.id ?? '';
  });

  /**
   * ⚠️ THE CANDIDATE LIST IS EVERY DEVICE ON THE SHELF, NOT THE ONE FEFO WOULD
   *   TAKE. This is the assertion PI-9.9 turns on: the planner stops once the
   *   requested quantity is covered, so a plan asked for the EXPECTED quantity
   *   would return exactly one serial and the picker would have nothing to pick
   *   between. Asking for everything is what makes the choice offerable.
   */
  it('offers every numbered device as a candidate, not just the one FEFO picked', async () => {
    const plan = await planConsumption(ctx, {
      encounterId,
      encounterProcedureId: deviceProcedureId,
    });
    const line = plan.lines.find((row) => row.productId === device);

    expect(line?.expectedQuantityBase).toBe('1');
    expect(line?.isSerialTracked).toBe(true);
    /* Both devices offered… */
    expect(line?.candidateLots).toHaveLength(2);
    expect(line?.candidateLots.map((lot) => lot.serialNumber).sort()).toEqual([
      'CNS-SER-A',
      'CNS-SER-B',
    ]);
    /* …and FEFO's proposal is one of them, not both. */
    const proposed = line?.candidateLots.filter((lot) => Number(lot.plannedQuantityBase) > 0) ?? [];
    expect(proposed).toHaveLength(1);

    /*
     * ⚠️ AND THE AVAILABLE TOTAL IS THE TRUE TOTAL. Under a plan asked for the
     *   expected quantity this read `1` — `min(available, expected)` — so a line
     *   with plenty of stock and a line with exactly enough looked identical.
     */
    expect(Number(line?.availableQuantityBase)).toBe(2);
  });

  /** An untracked consumable offers nothing to choose between, and says so. */
  it('offers no lot picker for untracked stock', async () => {
    const plan = await planConsumption(ctx, { encounterId, encounterProcedureId: procedureId });
    const gloveLine = plan.lines.find((row) => row.productId === glove);
    expect(gloveLine).toBeDefined();
    expect(gloveLine?.candidateLots).toEqual([]);
  });

  /**
   * ⚠️ THE RECORD SAYS WHICH DEVICE WENT IN, AND THE OTHER ONE IS UNTOUCHED.
   *   "Serial 7742 is in Mrs Rao" is what makes a device recall answerable at
   *   patient level rather than at lot level; a record that named the wrong
   *   device would send a recall to the wrong person and leave the right one
   *   unwarned.
   */
  it('records the device the clinician chose, and leaves the other alone', async () => {
    const plan = await planConsumption(ctx, {
      encounterId,
      encounterProcedureId: deviceProcedureId,
    });
    const line = plan.lines.find((row) => row.productId === device);
    const notPlanned = line?.candidateLots.find((lot) => Number(lot.plannedQuantityBase) === 0);
    const planned = line?.candidateLots.find((lot) => Number(lot.plannedQuantityBase) > 0);
    expect(notPlanned).toBeDefined();
    expect(planned).toBeDefined();

    const record = await recordConsumption(
      ctx,
      {
        anchorKind: 'ENCOUNTER_PROCEDURE',
        encounterId,
        encounterProcedureId: deviceProcedureId,
        locationId: trolley,
        lines: [
          {
            templateLineId: deviceTemplateLineId,
            productId: device,
            quantity: '1',
            unitId: baseUnit,
            allocations: [
              {
                locationId: notPlanned?.locationId ?? '',
                serialId: notPlanned?.serialId ?? null,
                quantityBase: '1',
                isOverride: true,
                overrideReason: 'The sterile pack for the other one was open.',
              },
            ],
          },
        ],
      },
      MAY_OVERRIDE
    );

    const allocation = record.lines[0]?.allocations[0];
    expect(allocation?.serialId).toBe(notPlanned?.serialId);
    expect(allocation?.serialNumber).toBe(notPlanned?.serialNumber);
    /* ⚠️ Recorded as a departure from the plan, with the reason kept. */
    expect(allocation?.isOverride).toBe(true);
    expect(allocation?.overrideReason).toMatch(/sterile pack/i);

    const { rows } = await owner.query<{ id: string; status: string; assigned: string | null }>(
      `SELECT id, status, assigned_patient_id AS assigned FROM serials WHERE id = ANY($1)`,
      [[notPlanned?.serialId ?? '', planned?.serialId ?? '']]
    );
    const chosenRow = rows.find((row) => row.id === notPlanned?.serialId);
    const otherRow = rows.find((row) => row.id === planned?.serialId);

    expect(chosenRow?.status).toBe('ISSUED');
    expect(chosenRow?.assigned).toBe(patientId);
    /* The one that was not used is still on the shelf and belongs to nobody. */
    expect(otherRow?.status).not.toBe('ISSUED');
    expect(otherRow?.assigned).toBeNull();
  });

  /**
   * ⚠️ AND PUTTING IT BACK UNASSIGNS IT. A device recorded in error and then
   *   corrected is back in stock; leaving the assignment behind would tell a
   *   recall that a named person has an implant they do not have, which is the
   *   more frightening of the two wrong answers.
   */
  it('clears the patient assignment when the device is put back', async () => {
    const list = await listConsumptions(ctx, {
      encounterProcedureId: deviceProcedureId,
      page: 1,
      limit: 10,
      sortOrder: 'desc',
    });
    const recordId = list.items[0]?.id ?? '';
    const before = await getConsumption(ctx, recordId);
    const serialId = before.lines[0]?.allocations[0]?.serialId ?? '';
    expect(serialId).not.toBe('');

    await correctConsumption(
      ctx,
      recordId,
      {
        kind: 'CONSUMPTION_REVERSAL',
        reason: 'It was never opened.',
        lines: [{ productId: device, quantity: '1', unitId: baseUnit }],
      },
      MAY_OVERRIDE
    );

    const { rows } = await owner.query<{ status: string; assigned: string | null }>(
      `SELECT status, assigned_patient_id AS assigned FROM serials WHERE id = $1`,
      [serialId]
    );
    expect(rows[0]?.status).toBe('IN_STOCK');
    expect(rows[0]?.assigned).toBeNull();
  });
});
