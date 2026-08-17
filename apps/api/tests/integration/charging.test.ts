/**
 * PI-8: charging and credit notes — against a real Postgres, through the real
 * services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `pharmacy` proves stock leaves the shelf correctly. This proves the MONEY side
 * of the same event, and pins the refusals PI-8 exists to make:
 *
 *   THE SUPPLY RAISES THE CHARGE     one transaction writes the dispense AND its
 *                                    charge requests, with the policy, the price
 *                                    and the tax category all snapshotted.
 *   A GLOVE PRODUCES NO INVOICE LINE and an implant does. BILLING_INTEGRATION.md's
 *                                    own test, end to end through the resolver.
 *   A MISSING PRICE NEVER STOPS A SUPPLY  the charge is written with a NULL price
 *                                    and the dispense goes through. A pharmacist
 *                                    is never blocked by an empty rate card.
 *   THE PRECEDENCE CHAIN IS ORDERED  a product rule beats a category rule beats a
 *                                    type rule beats the default.
 *   AN UNDECIDED `OPTIONAL` CANNOT BE BILLED  which is what makes the policy mean
 *                                    anything at all.
 *   A CREDIT NOTE REVERSES AND DOES NOT EDIT  its own series, its own number, the
 *                                    original invoice untouched, and it refuses
 *                                    to credit more than was charged.
 *   A RETURN CANCELS AN UNBILLED CHARGE  and leaves a billed one for a credit
 *                                    note.
 *
 * ⚠️ THE POLICY AND THE PRICE ARE ASSERTED AS SNAPSHOTS, NOT AS LOOKUPS. The
 *   whole architecture rests on a charge request recording what was true at the
 *   moment of supply; `changing the price afterwards does not restate the charge`
 *   is the case that proves it, and it is the one most likely to be broken by a
 *   later refactor that "simplifies" the resolver into the billing path.
 *
 * Every fixture is prefixed `CHG-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { createDispense } from '../../src/services/pharmacy/dispense.service.js';
import { createDispenseReturn } from '../../src/services/pharmacy/return.service.js';
import {
  createChargePolicyRule,
  resolveChargePolicyFor,
} from '../../src/services/charging/policy.service.js';
import { upsertProductPrice } from '../../src/services/charging/price.service.js';
import {
  decideChargeRequest,
  listChargeRequests,
} from '../../src/services/charging/charge-request.service.js';
import { createInvoiceFromCharges } from '../../src/services/invoicing/charge-billing.service.js';
import { createInvoice } from '../../src/services/invoicing/invoice.service.js';
import { money } from '@rcln/payments';
import { createCreditNote } from '../../src/services/invoicing/credit-note.service.js';
import { issueInvoiceById } from '../../src/services/invoicing/invoice.service.js';
import type { InvoiceVisibility } from '../../src/services/invoicing/invoice-visibility.js';

const SUFFIX = `c${Date.now().toString(36)}`;
const SLUG = `chg-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
/** A medicine — billable by default. */
let medicine: string;
/** A consumable — NOT billable by default. The glove. */
let glove: string;
/** An implant — billable by default, and the other half of the brief's test. */
let implant: string;
let counter: string;

let patientId: string;

/** Everything visible: this suite is not testing `invoice-visibility.ts`. */
const SEES_ALL: InvoiceVisibility = {
  all: true,
  sources: ['APPOINTMENT', 'PROCEDURE', 'SERVICE', 'LAB', 'PHARMACY', 'INVENTORY', 'OTHER'],
  scopedToOwnWork: false,
  practitionerProfileId: null,
};

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

async function makeProduct(code: string, type: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ProductType", 'ACTIVE', $3, $4, $5, 'NONE', true, now())
     RETURNING id`,
    [org.organizationId, type, code, `Chg ${code}`, baseUnit]
  );
  return rows[0]?.id ?? '';
}

async function stockUp(productId: string, batchId: string | null, quantity: string): Promise<void> {
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId,
    ...(batchId ? { batchId } : {}),
    movementType: 'RETURN',
    quantity,
    locationId: counter,
    referenceType: 'MANUAL',
  });
}

/** The charge requests raised against one supply, oldest first. */
async function chargesFor(dispenseId: string): Promise<
  {
    id: string;
    status: string;
    policy: string;
    policy_scope: string;
    unit_price: string | null;
    quantity: string;
    tax_category: string | null;
    kind: string;
  }[]
> {
  const { rows } = await owner.query(
    `SELECT cr.id, cr.status, cr.policy, cr.policy_scope, cr.unit_price, cr.quantity,
            cr.tax_category, cr.kind
       FROM charge_requests cr
       JOIN dispense_lines dl ON dl.id = cr.dispense_line_id
      WHERE dl.dispense_id = $1
      ORDER BY dl.line_number`,
    [dispenseId]
  );
  return rows as never;
}

async function classify(productId: string, taxCategory: string): Promise<void> {
  await owner.query(
    `INSERT INTO product_tax_classifications
       (id, organization_id, product_id, country_code, tax_category, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'IN', $3, CURRENT_DATE - 1, now())`,
    [org.organizationId, productId, taxCategory]
  );
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Chg'));
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

  medicine = await makeProduct('CHG-MED', 'MEDICINE');
  glove = await makeProduct('CHG-GLOVE', 'CONSUMABLE');
  implant = await makeProduct('CHG-IMPLANT', 'IMPLANT');

  counter = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'CHG_COUNTER',
      name: 'Chg Counter',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  /*
   * ⚠️ EVERY PRODUCT HERE IS `tracking_mode: NONE`, DELIBERATELY. This suite is
   *   about the MONEY side of a supply; `pharmacy.test.ts` already proves FEFO,
   *   lots and expiry, and repeating that machinery here would make every case
   *   depend on inventory behaviour it is not testing.
   */
  await stockUp(medicine, null, '500');
  await stockUp(glove, null, '500');
  await stockUp(implant, null, '50');

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'CHG00001', 'Chg', 'Patient', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]?.id ?? '';

  /*
   * ⚠️ A TAX CATEGORY THE SEEDED CATALOGUE HAS A RULE FOR. Without one the line
   *   resolves `UNRATED` and `finalizeInvoice` refuses to issue — which is
   *   correct behaviour and would make the credit-note cases untestable. The
   *   `missing tax classification` case below asserts the refusal deliberately.
   */
  await classify(medicine, 'CONSULTATION');
  await classify(implant, 'CONSULTATION');

  /*
   * ⚠️ PRICED IN THE FIXTURE, NOT IN THE FIRST CASE. Setting it inside a test
   *   makes every later block depend on that test having run — which is true
   *   under a whole-file run and false under `-t`, so a single filtered case
   *   fails with "has no price" and sends the reader looking at the pricing
   *   resolver instead of at the ordering.
   */
  await upsertProductPrice(ctx, { productId: medicine, unitId: baseUnit, amountMinor: 4500 });
  await upsertProductPrice(ctx, { productId: implant, unitId: baseUnit, amountMinor: 250_000 });
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
// The supply raises the charge
// ---------------------------------------------------------------------------

describe('a supply raises its own charge', () => {
  it('writes a charge request in the same transaction as the dispense', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '2', unitId: baseUnit }],
    });

    const charges = await chargesFor(dispense.id);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.status).toBe('PENDING');
    expect(charges[0]?.policy).toBe('SEPARATELY_BILLABLE');
    /* No rule configured yet, so the chain falls through to the default. */
    expect(charges[0]?.policy_scope).toBe('DEFAULT');
    expect(Number(charges[0]?.unit_price)).toBe(45);
    expect(Number(charges[0]?.quantity)).toBe(2);
    expect(charges[0]?.tax_category).toBe('CONSULTATION');
  });

  /**
   * ⚠️ BILLING_INTEGRATION.md's OWN TEST, VERBATIM, AND THE ONE MOST WORTH
   *   HAVING. "A consumed glove produces no invoice line; an implant does."
   *   Both go out on ONE dispense, so this also proves the resolver runs per
   *   line rather than once per document.
   */
  it('produces no charge for a glove and a charge for an implant', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [
        { productId: glove, quantity: '4', unitId: baseUnit },
        { productId: implant, quantity: '1', unitId: baseUnit },
      ],
    });

    const charges = await chargesFor(dispense.id);
    expect(charges).toHaveLength(2);

    const gloveCharge = charges.find((c) => c.policy === 'NEVER_BILL');
    const implantCharge = charges.find((c) => c.policy === 'SEPARATELY_BILLABLE');

    /*
     * ⚠️ THE GLOVE STILL GETS A ROW — SUPPRESSED, WITH A REASON. That is the
     *   whole argument for `charge_requests` being a table: "we decided not to
     *   charge for this" and "we forgot to charge for this" are identical in a
     *   revenue figure and are entirely different problems.
     */
    expect(gloveCharge?.status).toBe('SUPPRESSED');
    expect(implantCharge?.status).toBe('PENDING');
  });

  /**
   * ⚠️ THE MOST IMPORTANT CASE IN THE FILE. A pharmacist handing somebody their
   *   medicine must NEVER be stopped because an accountant has not filled in a
   *   grid. The gap is a NULL column and a visible row, not an exception.
   */
  it('supplies an unpriced product and records the gap rather than refusing', async () => {
    const unpriced = await makeProduct('CHG-UNPRICED', 'MEDICINE');
    await stockUp(unpriced, null, '50');

    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: unpriced, quantity: '1', unitId: baseUnit }],
    });

    const charges = await chargesFor(dispense.id);
    expect(charges[0]?.unit_price).toBeNull();
    /* And unclassified for tax too — neither stopped the supply. */
    expect(charges[0]?.tax_category).toBeNull();
    expect(charges[0]?.status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// The precedence chain
// ---------------------------------------------------------------------------

describe('charge policy precedence', () => {
  it('takes the default when no rule matches', async () => {
    const resolved = await resolveChargePolicyFor(ctx, glove);
    expect(resolved.policy).toBe('NEVER_BILL');
    expect(resolved.scope).toBe('DEFAULT');
    expect(resolved.ruleId).toBeNull();
  });

  it('lets a type rule beat the default', async () => {
    await createChargePolicyRule(ctx, {
      target: { scope: 'PRODUCT_TYPE', productType: 'CONSUMABLE' },
      policy: 'SEPARATELY_BILLABLE',
    });

    const resolved = await resolveChargePolicyFor(ctx, glove);
    expect(resolved.policy).toBe('SEPARATELY_BILLABLE');
    expect(resolved.scope).toBe('PRODUCT_TYPE');
  });

  /**
   * ⚠️ THE ORDER IS THE ANSWER. A product rule and a type rule both match, and
   *   only one may win — a resolver that took the first row Postgres happened to
   *   return would be right about half the time and would look correct in review.
   */
  it('lets a product rule beat a type rule', async () => {
    await createChargePolicyRule(ctx, {
      target: { scope: 'PRODUCT', productId: glove },
      policy: 'NEVER_BILL',
    });

    const resolved = await resolveChargePolicyFor(ctx, glove);
    expect(resolved.policy).toBe('NEVER_BILL');
    expect(resolved.scope).toBe('PRODUCT');
  });

  it('refuses a second rule about the same thing', async () => {
    await expect(
      createChargePolicyRule(ctx, {
        target: { scope: 'PRODUCT', productId: glove },
        policy: 'SEPARATELY_BILLABLE',
      })
    ).rejects.toThrow(/already has a charge policy/i);
  });

  /**
   * ⚠️ THE SNAPSHOT, WHICH IS THE ARCHITECTURE. A charge raised yesterday must
   *   keep saying what it said, whatever the table says today — otherwise the
   *   answer to "why was this billed?" changes every time somebody edits a rule,
   *   and an old bill stops being able to explain itself.
   */
  it('does not restate an existing charge when the policy changes', async () => {
    const target = await makeProduct('CHG-SNAPSHOT', 'MEDICINE');
    await stockUp(target, null, '20');
    await upsertProductPrice(ctx, { productId: target, unitId: baseUnit, amountMinor: 1000 });

    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: target, quantity: '1', unitId: baseUnit }],
    });

    const before = await chargesFor(dispense.id);
    expect(before[0]?.policy).toBe('SEPARATELY_BILLABLE');
    expect(Number(before[0]?.unit_price)).toBe(10);

    /* Both the policy AND the price move afterwards. */
    await createChargePolicyRule(ctx, {
      target: { scope: 'PRODUCT', productId: target },
      policy: 'NEVER_BILL',
    });
    await upsertProductPrice(ctx, { productId: target, unitId: baseUnit, amountMinor: 9900 });

    const after = await chargesFor(dispense.id);
    expect(after[0]?.policy).toBe('SEPARATELY_BILLABLE');
    expect(Number(after[0]?.unit_price)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

describe('raising an invoice from charges', () => {
  async function supplyOne(quantity = '2'): Promise<string> {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity, unitId: baseUnit }],
    });
    const charges = await chargesFor(dispense.id);
    return charges[0]?.id ?? '';
  }

  it('turns pending charges into one invoice and marks them billed', async () => {
    const chargeId = await supplyOne();

    const invoice = await createInvoiceFromCharges(
      ctx,
      { chargeRequestIds: [chargeId], notes: undefined },
      SEES_ALL
    );

    expect(invoice.sourceType).toBe('PHARMACY');
    expect(invoice.kind).toBe('INVOICE');
    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0]?.unitPriceMinor).toBe(4500);

    const { rows } = await owner.query<{ status: string; invoice_id: string | null }>(
      'SELECT status, invoice_id FROM charge_requests WHERE id = $1',
      [chargeId]
    );
    expect(rows[0]?.status).toBe('INVOICED');
    /*
     * ⚠️ THE INVOICE, NOT THE ITEM, AND THE CHECK CONSTRAINT SAYS THE SAME. An
     *   item id is deleted and recreated by every re-price — see
     *   `attachToInvoice` — so it cannot be the link.
     */
    expect(rows[0]?.invoice_id).toBe(invoice.id);
  });

  it('refuses to bill a charge twice', async () => {
    const chargeId = await supplyOne();
    await createInvoiceFromCharges(ctx, { chargeRequestIds: [chargeId] }, SEES_ALL);

    await expect(
      createInvoiceFromCharges(ctx, { chargeRequestIds: [chargeId] }, SEES_ALL)
    ).rejects.toThrow(/already on an invoice/i);
  });

  it('refuses to bill an unpriced charge', async () => {
    const unpriced = await makeProduct('CHG-NOPRICE2', 'MEDICINE');
    await stockUp(unpriced, null, '10');
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: unpriced, quantity: '1', unitId: baseUnit }],
    });
    const charges = await chargesFor(dispense.id);

    await expect(
      createInvoiceFromCharges(ctx, { chargeRequestIds: [charges[0]?.id ?? ''] }, SEES_ALL)
    ).rejects.toThrow(/has no price/i);
  });

  /**
   * ⚠️ THE CHECK THAT MAKES `OPTIONAL` MEAN ANYTHING. Without it "a human
   *   decides" collapses into "whoever raises the invoice decides, without
   *   recording that they did" — which is the state PI-8 exists to replace.
   */
  it('refuses to bill an OPTIONAL charge nobody has decided', async () => {
    const optional = await makeProduct('CHG-OPTIONAL', 'MEDICINE');
    await stockUp(optional, null, '10');
    await upsertProductPrice(ctx, { productId: optional, unitId: baseUnit, amountMinor: 500 });
    await createChargePolicyRule(ctx, {
      target: { scope: 'PRODUCT', productId: optional },
      policy: 'OPTIONAL',
    });

    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: optional, quantity: '1', unitId: baseUnit }],
    });
    const charges = await chargesFor(dispense.id);
    const chargeId = charges[0]?.id ?? '';

    await expect(
      createInvoiceFromCharges(ctx, { chargeRequestIds: [chargeId] }, SEES_ALL)
    ).rejects.toThrow(/waiting for somebody to decide/i);

    /* Once a human answers it, it bills. */
    await decideChargeRequest(ctx, chargeId, { decision: 'BILL' });
    const invoice = await createInvoiceFromCharges(ctx, { chargeRequestIds: [chargeId] }, SEES_ALL);
    expect(invoice.items).toHaveLength(1);
  });

  it('refuses to suppress a charge that is already on an invoice', async () => {
    const chargeId = await supplyOne();
    await createInvoiceFromCharges(ctx, { chargeRequestIds: [chargeId] }, SEES_ALL);

    await expect(
      decideChargeRequest(ctx, chargeId, { decision: 'SUPPRESS', reason: 'Changed my mind' })
    ).rejects.toThrow(/already on an invoice/i);
  });

  /**
   * ⚠️ AN INVOICE IS ADDRESSED TO ONE PERSON. Billing two patients' supplies on
   *   one document discloses one of them to the other.
   */
  it('refuses to bill two patients on one invoice', async () => {
    const other = await owner.query<{ id: string }>(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES (gen_random_uuid(), $1, 'CHG00002', 'Other', now()) RETURNING id`,
      [org.organizationId]
    );

    const mine = await supplyOne();
    const theirDispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId: other.rows[0]?.id ?? '',
      lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
    });
    const theirs = (await chargesFor(theirDispense.id))[0]?.id ?? '';

    await expect(
      createInvoiceFromCharges(ctx, { chargeRequestIds: [mine, theirs] }, SEES_ALL)
    ).rejects.toThrow(/different people/i);
  });

  it('reports the suppressed and pending counts on the queue', async () => {
    const listed = await listChargeRequests(ctx, {
      page: 1,
      limit: 100,
      status: 'SUPPRESSED',
    } as never);
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((item) => item.suppressedReason !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

describe('credit notes', () => {
  async function issuedInvoice(): Promise<{ id: string; totalMinor: number }> {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '2', unitId: baseUnit }],
    });
    const charges = await chargesFor(dispense.id);
    const draft = await createInvoiceFromCharges(
      ctx,
      { chargeRequestIds: [charges[0]?.id ?? ''] },
      SEES_ALL
    );
    const issued = await issueInvoiceById(ctx, { invoiceId: draft.id }, SEES_ALL);
    return { id: issued.id, totalMinor: issued.grandTotalMinor };
  }

  it('reverses an issued invoice on its own series without editing it', async () => {
    const invoice = await issuedInvoice();

    const note = await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'Patient brought it back', lines: [] },
      SEES_ALL
    );

    expect(note.kind).toBe('CREDIT_NOTE');
    expect(note.creditedInvoiceId).toBe(invoice.id);
    expect(note.status).toBe('ISSUED');
    /* ⚠️ Its own series and its own prefix — what the law actually requires. */
    expect(note.invoiceNumber).toMatch(/^CRN-/);
    expect(note.grandTotalMinor).toBe(invoice.totalMinor);

    /*
     * ⚠️ AND THE ORIGINAL IS UNTOUCHED. Not "mostly untouched" — the lifecycle
     *   guard freezes every money column of an issued document, and a credit note
     *   that had to edit one would have been refused by the trigger rather than
     *   by this assertion.
     */
    const { rows } = await owner.query<{ status: string; grand_total: string }>(
      'SELECT status, grand_total FROM invoices WHERE id = $1',
      [invoice.id]
    );
    expect(rows[0]?.status).toBe('ISSUED');
    expect(Number(rows[0]?.grand_total) * 100).toBeCloseTo(invoice.totalMinor, 0);
  });

  /**
   * ⚠️ THE CEILING IS ACROSS EVERY LIVE NOTE, NOT PER NOTE. A per-note check
   *   alone lets three notes of the full amount through, and the clinic refunds
   *   three times what it charged.
   */
  it('refuses to credit more than the invoice charged', async () => {
    const invoice = await issuedInvoice();
    await createCreditNote(ctx, invoice.id, { reason: 'First', lines: [] }, SEES_ALL);

    /*
     * ⚠️ THE PER-LINE CAP FIRES FIRST NOW, AND SAYS WHICH LINE. It used to be the
     *   total-value ceiling that caught this; the cumulative per-line check is
     *   strictly stronger — it refuses the same case earlier and names the line
     *   rather than the document. Either refusal is correct; the message is the
     *   more useful one.
     */
    await expect(
      createCreditNote(ctx, invoice.id, { reason: 'Second', lines: [] }, SEES_ALL)
    ).rejects.toThrow(/already been credited|credited in full/i);
  });

  it('refuses to credit a draft', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
    });
    const charges = await chargesFor(dispense.id);
    const draft = await createInvoiceFromCharges(
      ctx,
      { chargeRequestIds: [charges[0]?.id ?? ''] },
      SEES_ALL
    );

    await expect(
      createCreditNote(ctx, draft.id, { reason: 'Too soon', lines: [] }, SEES_ALL)
    ).rejects.toThrow(/has not been issued/i);
  });

  it('refuses to credit a credit note', async () => {
    const invoice = await issuedInvoice();
    const note = await createCreditNote(ctx, invoice.id, { reason: 'Back', lines: [] }, SEES_ALL);

    await expect(
      createCreditNote(ctx, note.id, { reason: 'Again', lines: [] }, SEES_ALL)
    ).rejects.toThrow(/cannot itself be credited/i);
  });

  it('refuses to credit a line that is not on the invoice', async () => {
    const a = await issuedInvoice();
    const b = await issuedInvoice();
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1',
      [b.id]
    );

    await expect(
      createCreditNote(
        ctx,
        a.id,
        { reason: 'Wrong line', lines: [{ invoiceItemId: rows[0]?.id ?? '' }] },
        SEES_ALL
      )
    ).rejects.toThrow(/not on the invoice being credited/i);
  });

  it('refuses to credit more of a line than was billed', async () => {
    const invoice = await issuedInvoice();
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1',
      [invoice.id]
    );

    await expect(
      createCreditNote(
        ctx,
        invoice.id,
        { reason: 'Too much', lines: [{ invoiceItemId: rows[0]?.id ?? '', quantity: '99' }] },
        SEES_ALL
      )
    ).rejects.toThrow(/cannot be credited for more than that/i);
  });

  /** A partial credit leaves room for the rest, which is what returns need. */
  it('allows a second credit note up to what is left', async () => {
    const invoice = await issuedInvoice();
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1',
      [invoice.id]
    );
    const itemId = rows[0]?.id ?? '';

    const first = await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'One back', lines: [{ invoiceItemId: itemId, quantity: '1' }] },
      SEES_ALL
    );
    expect(first.grandTotalMinor).toBeLessThan(invoice.totalMinor);

    const second = await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'The other one back', lines: [{ invoiceItemId: itemId, quantity: '1' }] },
      SEES_ALL
    );
    expect(second.invoiceNumber).toMatch(/^CRN-/);
    /* ⚠️ Two notes, one invoice — the series is per document, not per invoice. */
    expect(second.invoiceNumber).not.toBe(first.invoiceNumber);
  });
});

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

describe('a return undoes the money side', () => {
  /**
   * ⚠️ CANCELLED, NOT CREDITED. Nothing was owed, so nothing is refunded — and
   *   leaving the charge on the queue would mean somebody eventually bills a
   *   patient for stock that is back on the shelf.
   */
  it('cancels an unbilled charge when the whole supply comes back', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '3', unitId: baseUnit }],
    });

    const { rows: lines } = await owner.query<{ id: string }>(
      'SELECT id FROM dispense_lines WHERE dispense_id = $1',
      [dispense.id]
    );

    await createDispenseReturn(ctx, dispense.id, {
      locationId: counter,
      reason: 'Wrong medicine',
      requestRestock: false,
      lines: [{ dispenseLineId: lines[0]?.id ?? '', quantityBase: '3' }],
    });

    const charges = await chargesFor(dispense.id);
    const supply = charges.find((c) => c.kind === 'SUPPLY');
    expect(supply?.status).toBe('CANCELLED');
  });

  /**
   * ⚠️ A PARTIAL RETURN LEAVES THE ORIGINAL STANDING AT ITS FULL QUANTITY. The
   *   reversal is what reduces it, through a credit note; rewriting the original
   *   would lose the fact that three were supplied.
   */
  it('leaves the original charge alone on a partial return', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '4', unitId: baseUnit }],
    });

    const { rows: lines } = await owner.query<{ id: string }>(
      'SELECT id FROM dispense_lines WHERE dispense_id = $1',
      [dispense.id]
    );

    await createDispenseReturn(ctx, dispense.id, {
      locationId: counter,
      reason: 'Took too many',
      requestRestock: false,
      lines: [{ dispenseLineId: lines[0]?.id ?? '', quantityBase: '1' }],
    });

    const charges = await chargesFor(dispense.id);
    const supply = charges.find((c) => c.kind === 'SUPPLY');
    expect(supply?.status).toBe('PENDING');
    expect(Number(supply?.quantity)).toBe(4);

    /* And a REVERSAL charge exists beside it, for the one that came back. */
    const { rows: reversals } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM charge_requests cr
         JOIN dispense_return_lines drl ON drl.id = cr.dispense_return_line_id
         JOIN dispense_lines dl ON dl.id = drl.dispense_line_id
        WHERE dl.dispense_id = $1 AND cr.kind = 'REVERSAL'`,
      [dispense.id]
    );
    expect(Number(reversals[0]?.n)).toBe(1);
  });

  /**
   * ⚠️ A REVERSAL NEVER JOINS AN INVOICE. It reduces what is owed, which is a
   *   credit note against the document that charged it — an invoice carrying a
   *   negative line would be a document whose total is not the sum of what it
   *   says was supplied.
   */
  it('refuses to put a reversal on an invoice', async () => {
    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [{ productId: medicine, quantity: '2', unitId: baseUnit }],
    });
    const { rows: lines } = await owner.query<{ id: string }>(
      'SELECT id FROM dispense_lines WHERE dispense_id = $1',
      [dispense.id]
    );
    await createDispenseReturn(ctx, dispense.id, {
      locationId: counter,
      reason: 'One back',
      requestRestock: false,
      lines: [{ dispenseLineId: lines[0]?.id ?? '', quantityBase: '1' }],
    });

    const { rows: reversal } = await owner.query<{ id: string }>(
      `SELECT cr.id FROM charge_requests cr
         JOIN dispense_return_lines drl ON drl.id = cr.dispense_return_line_id
         JOIN dispense_lines dl ON dl.id = drl.dispense_line_id
        WHERE dl.dispense_id = $1 AND cr.kind = 'REVERSAL'`,
      [dispense.id]
    );

    await expect(
      createInvoiceFromCharges(ctx, { chargeRequestIds: [reversal[0]?.id ?? ''] }, SEES_ALL)
    ).rejects.toThrow(/credited, not invoiced/i);
  });
});

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

/**
 * Supplying something other than what was prescribed (KNOWN_ISSUES #11).
 *
 * ⚠️ THE API HAS ALWAYS TAKEN THIS AND NO SCREEN COULD SEND IT. PI-8 added the
 *   control on the dispensing workspace, which sends NO allocations for a
 *   substituted line — the lots on that screen were planned for the PRESCRIBED
 *   product and are meaningless for the substitute, so the server plans them
 *   itself inside the posting transaction. These cases pin the server half of
 *   that contract, which is the half a screen cannot be trusted to get right.
 *
 * Here rather than in `pharmacy.test.ts` because the money side is the part
 * PI-8 owns: a substituted line must be CHARGED for what was handed over, not
 * for what was written.
 */
describe('a substituted supply', () => {
  it('charges for what was handed over, not for what was prescribed', async () => {
    const prescribed = await makeProduct('CHG-SUB-RX', 'MEDICINE');
    const given = await makeProduct('CHG-SUB-GIVEN', 'MEDICINE');
    await stockUp(given, null, '50');
    await classify(given, 'CONSULTATION');

    /* Deliberately different prices, so the charge cannot pass by coincidence. */
    await upsertProductPrice(ctx, { productId: prescribed, unitId: baseUnit, amountMinor: 1000 });
    await upsertProductPrice(ctx, { productId: given, unitId: baseUnit, amountMinor: 7700 });

    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [
        {
          productId: given,
          substitutedForProductId: prescribed,
          substitutionReason: 'Prescribed brand out of stock',
          quantity: '2',
          unitId: baseUnit,
          /*
           * ⚠️ NO ALLOCATIONS — the workspace sends none on a substitution, and
           *   the server plans FEFO for the product actually being supplied.
           */
        },
      ],
    } as never);

    const charges = await chargesFor(dispense.id);
    expect(charges).toHaveLength(1);
    /* 77.00, the substitute's price — not 10.00, the prescribed one's. */
    expect(Number(charges[0]?.unit_price)).toBe(77);

    const { rows } = await owner.query<{
      product_id: string;
      substituted_for_product_id: string | null;
      substitution_reason: string | null;
    }>(
      `SELECT product_id, substituted_for_product_id, substitution_reason
         FROM dispense_lines WHERE dispense_id = $1`,
      [dispense.id]
    );
    expect(rows[0]?.product_id).toBe(given);
    expect(rows[0]?.substituted_for_product_id).toBe(prescribed);
    expect(rows[0]?.substitution_reason).toBe('Prescribed brand out of stock');
  });

  /**
   * ⚠️ THE STOCK COMES OFF THE SUBSTITUTE'S SHELF. A line that moved the
   *   PRESCRIBED product's stock while recording the substitute's name is the
   *   failure this whole "send no allocations" design exists to prevent, and it
   *   is invisible on the screen that caused it.
   */
  it('takes the stock off the product that was actually handed over', async () => {
    const prescribed = await makeProduct('CHG-SUB2-RX', 'MEDICINE');
    const given = await makeProduct('CHG-SUB2-GIVEN', 'MEDICINE');
    await stockUp(prescribed, null, '30');
    await stockUp(given, null, '30');
    await upsertProductPrice(ctx, { productId: given, unitId: baseUnit, amountMinor: 100 });

    const dispense = await createDispense(ctx, {
      kind: 'COUNTER_SALE',
      branchId: org.branchId,
      locationId: counter,
      patientId,
      lines: [
        {
          productId: given,
          substitutedForProductId: prescribed,
          substitutionReason: 'Same composition, in stock',
          quantity: '4',
          unitId: baseUnit,
        },
      ],
    } as never);

    const { rows } = await owner.query<{ product_id: string; quantity_base: string }>(
      `SELECT product_id, quantity_base FROM stock_ledger
        WHERE reference_type = 'DISPENSE' AND reference_id = $1`,
      [dispense.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product_id).toBe(given);
    /* A dispensing leg is negative — the sign is a property of the movement. */
    expect(Number(rows[0]?.quantity_base)).toBe(-4);
  });

  /**
   * ⚠️ A SUBSTITUTION WITHOUT A REASON IS REFUSED BY A CHECK CONSTRAINT, and the
   *   contract refines the same rule. Pinned because the screen's disabled button
   *   is a courtesy and this is the guarantee.
   */
  it('refuses a substitution with no reason', async () => {
    const prescribed = await makeProduct('CHG-SUB3-RX', 'MEDICINE');
    const given = await makeProduct('CHG-SUB3-GIVEN', 'MEDICINE');
    await stockUp(given, null, '10');

    await expect(
      createDispense(ctx, {
        kind: 'COUNTER_SALE',
        branchId: org.branchId,
        locationId: counter,
        patientId,
        lines: [
          {
            productId: given,
            substitutedForProductId: prescribed,
            quantity: '1',
            unitId: baseUnit,
          },
        ],
      } as never)
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A credit note against a DISCOUNTED invoice
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE DEFECT THIS PINS WAS FOUND IN REVIEW AND NO EXISTING FIXTURE COULD
 *   CATCH IT, because every other invoice in this suite is undiscounted.
 *
 * `ORIGINAL_SELECT` did not read the line's `discount_amount` or its
 * `apportioned_discount`, so `resolveLines` priced the note at GROSS while the
 * invoice had charged NET. Crediting a discounted bill in full issued a
 * statutory document owing MORE than the clinic had ever taken.
 *
 * The second half is the ceiling. It used to compare that gross figure — before
 * tax — against the original's tax-inclusive `grand_total`, which is three bases
 * in one subtraction: it refused a legitimate full credit where the discount
 * exceeded the tax, and let a note through that over-credited where it did not.
 * The check now runs after the draft is priced, so both sides are `grand_total`.
 */
describe('crediting a discounted invoice', () => {
  async function discountedInvoice(): Promise<{ id: string; totalMinor: number }> {
    const draft = await createInvoice(
      ctx,
      {
        branchId: org.branchId,
        sourceType: 'OTHER',
        patientId,
        customer: { name: 'Chg Patient' },
        suppliedOn: new Date().toISOString().slice(0, 10),
        currency: 'INR',
        /* Two lines, so the whole-bill discount actually apportions. */
        lines: [
          {
            description: 'Line one',
            taxCategory: 'CONSULTATION',
            itemCode: null,
            quantity: '2',
            unitPrice: money(30_000, 'INR'),
          },
          {
            description: 'Line two',
            taxCategory: 'CONSULTATION',
            itemCode: null,
            quantity: '1',
            unitPrice: money(40_000, 'INR'),
            /* A line discount as well, so BOTH discount columns are non-zero. */
            discount: { type: 'PERCENTAGE', bps: 1000 },
          },
        ],
        /* And a whole-bill discount on top, apportioned across both lines. */
        discount: { type: 'PERCENTAGE', bps: 2000 },
      } as never,
      SEES_ALL
    );

    const issued = await issueInvoiceById(ctx, { invoiceId: draft.id }, SEES_ALL);
    return { id: issued.id, totalMinor: issued.grandTotalMinor };
  }

  /**
   * ⚠️ THE ASSERTION THAT MATTERS: a full credit reverses EXACTLY what was
   *   charged. Before the fix the note came out larger than the invoice.
   */
  it('credits exactly what was charged, not the pre-discount gross', async () => {
    const invoice = await discountedInvoice();

    const note = await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'Everything came back', lines: [] },
      SEES_ALL
    );

    expect(note.kind).toBe('CREDIT_NOTE');
    expect(note.grandTotalMinor).toBe(invoice.totalMinor);
    /* And the discount really was non-zero, or the case proves nothing. */
    expect(invoice.totalMinor).toBeLessThan(100_000);
  });

  /**
   * ⚠️ THE DIRECTION THE OLD CHECK FAILED IN. A discount larger than the tax made
   *   `creditTotal` (gross) exceed `remaining` (net + tax), so a clinic could not
   *   credit its own discounted invoice at all. It must simply work.
   */
  it('does not refuse a legitimate full credit of a heavily discounted invoice', async () => {
    const invoice = await discountedInvoice();
    await expect(
      createCreditNote(ctx, invoice.id, { reason: 'All of it', lines: [] }, SEES_ALL)
    ).resolves.toBeDefined();
  });

  /**
   * ⚠️ AND THE DIRECTION IT FAILED IN THE OTHER WAY. The security review's exploit
   *   was: credit a sliver, then credit the whole thing — the tax gap between the
   *   two bases left room for both. Now the second is refused.
   */
  it('refuses a second full credit after a partial one', async () => {
    const invoice = await discountedInvoice();
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number LIMIT 1',
      [invoice.id]
    );

    await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'One back', lines: [{ invoiceItemId: rows[0]?.id ?? '', quantity: '1' }] },
      SEES_ALL
    );

    await expect(
      createCreditNote(ctx, invoice.id, { reason: 'Now all of it', lines: [] }, SEES_ALL)
    ).rejects.toThrow(/more than is left to credit|credited in full|already been credited/i);
  });
});

/**
 * ⚠️ THE PER-LINE CAP, CUMULATIVE ACROSS NOTES (KNOWN_ISSUES #13).
 *
 * The total was always bounded — `assertWithinRemaining` compares the priced
 * note's `grand_total` against the invoice's — so no clinic could ever refund
 * more than it charged. What was NOT bounded was the DISTRIBUTION: capping each
 * credited quantity against the original line alone let a two-line bill be
 * credited twice on line A and never on line B, and the document then said more
 * of A came back than ever went out. Stock and returns reconciliation read the
 * lines, not the total.
 *
 * Closed by `invoice_items.credited_invoice_item_id` — before PI-8 there was no
 * link back to sum over.
 */
describe('crediting the same line twice', () => {
  async function twoLineInvoice(): Promise<{ id: string; firstItemId: string }> {
    const draft = await createInvoice(
      ctx,
      {
        branchId: org.branchId,
        sourceType: 'OTHER',
        patientId,
        customer: { name: 'Chg Patient' },
        suppliedOn: new Date().toISOString().slice(0, 10),
        currency: 'INR',
        lines: [
          {
            description: 'Cap line one',
            taxCategory: 'CONSULTATION',
            itemCode: null,
            quantity: '2',
            unitPrice: money(50_000, 'INR'),
          },
          {
            description: 'Cap line two',
            taxCategory: 'CONSULTATION',
            itemCode: null,
            quantity: '2',
            unitPrice: money(50_000, 'INR'),
          },
        ],
      } as never,
      SEES_ALL
    );
    const issued = await issueInvoiceById(ctx, { invoiceId: draft.id }, SEES_ALL);

    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number',
      [issued.id]
    );
    return { id: issued.id, firstItemId: rows[0]?.id ?? '' };
  }

  it('refuses to credit one line beyond what it was billed at, across two notes', async () => {
    const invoice = await twoLineInvoice();

    /* Line one in full — fine, and well within the invoice total. */
    await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'First half back', lines: [{ invoiceItemId: invoice.firstItemId, quantity: '2' }] },
      SEES_ALL
    );

    /*
     * The same line again. The TOTAL still fits under the invoice, which is
     * exactly why the old code let this through — and it would have stated that
     * 4 of a line billed at 2 came back.
     */
    await expect(
      createCreditNote(
        ctx,
        invoice.id,
        {
          reason: 'And again',
          lines: [{ invoiceItemId: invoice.firstItemId, quantity: '2' }],
        },
        SEES_ALL
      )
    ).rejects.toThrow(/already been credited/i);
  });

  /** Two partial credits that together complete a line are legitimate. */
  it('allows two partial credits of one line that together complete it', async () => {
    const invoice = await twoLineInvoice();

    await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'One', lines: [{ invoiceItemId: invoice.firstItemId, quantity: '1' }] },
      SEES_ALL
    );

    await expect(
      createCreditNote(
        ctx,
        invoice.id,
        { reason: 'The other', lines: [{ invoiceItemId: invoice.firstItemId, quantity: '1' }] },
        SEES_ALL
      )
    ).resolves.toBeDefined();
  });

  /**
   * ⚠️ AND THE LINK SURVIVES FINALISATION. `repriceLoadedDraft` deletes and
   *   re-inserts every line, and finalisation always re-prices — a column set at
   *   creation and not carried through `StagedLine` would be NULL by the time
   *   the note became a document, and the cap above would silently stop
   *   aggregating. That is exactly what happened to
   *   `charge_requests.invoice_item_id`.
   */
  it('keeps the link to the credited line after the note is finalised', async () => {
    const invoice = await twoLineInvoice();
    const note = await createCreditNote(
      ctx,
      invoice.id,
      { reason: 'Linked', lines: [{ invoiceItemId: invoice.firstItemId, quantity: '1' }] },
      SEES_ALL
    );

    const { rows } = await owner.query<{ credited_invoice_item_id: string | null }>(
      'SELECT credited_invoice_item_id FROM invoice_items WHERE invoice_id = $1',
      [note.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credited_invoice_item_id).toBe(invoice.firstItemId);
  });
});
