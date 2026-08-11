/**
 * A patient invoice's whole life, against real Postgres, real RLS and the real
 * triggers.
 *
 * Every case here is one that only a database can answer. The pure package
 * proves the arithmetic and `invoice-pricing.test.ts` proves the wiring; what is
 * left is the set of claims Phase 5 actually makes, and each of them is a claim
 * about what happens when somebody does the wrong thing:
 *
 *   1. A draft's totals are the totals of its lines from the moment it exists,
 *      not from the moment somebody remembers to reprice it.
 *   2. Finalisation refuses an unrated line, refuses a branch whose registration
 *      does not cover it, and takes its number LAST.
 *   3. An ISSUED invoice cannot be edited, deleted, un-issued, or have a line
 *      added under it — through the app role, which is what the API connects as.
 *      These are asserted as raised exceptions rather than as service errors,
 *      because the service is exactly the layer they are not allowed to depend
 *      on.
 *   4. What may still move after issue — settlement and the two reversals —
 *      still moves. An immutability guard that also froze `amount_paid` would
 *      make PAID unreachable and nothing in a single-path test would say so.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { fromMajor } = await import('@rcln/payments');
const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const {
  createDraftInvoice,
  finalizeInvoice,
  cancelDraftInvoice,
  voidInvoice,
  repriceDraftInvoice,
} = await import('../../src/services/invoicing/invoice-lifecycle.service.js');

const SUFFIX = `l${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
/** A Tuesday inside FY 2026-27, so every number below reads `INV-2026-`. */
const SUPPLIED_AT = new Date('2026-08-11T06:00:00Z');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

type Org = { organizationId: string; ownerUserId: string; branchId: string };

/** Registered in Karnataka, billing from a Karnataka branch. The ordinary case. */
let orgA: Org;
/** Registered in Karnataka only, and its branch claims Kerala. The §0.2 gap. */
let orgB: Org;
/** Holds no registration at all — below the threshold, and may still bill. */
let orgC: Org;

let ctxA: TenantContext;
let ctxB: TenantContext;
let ctxC: TenantContext;

const inr = (major: string) => fromMajor(major, 'INR');

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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  orgA = await registerOrganization(payload(`life-a-${SUFFIX}`, 'Life A'));
  orgB = await registerOrganization(payload(`life-b-${SUFFIX}`, 'Life B'));
  orgC = await registerOrganization(payload(`life-c-${SUFFIX}`, 'Life C'));

  await owner.query(
    `UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = ANY($1)`,
    [[orgA.branchId, orgC.branchId]]
  );
  /*
   * ⚠️ THE EXACT SHAPE THE `region_code` CHECK EXISTS FOR. B's branch is in
   *   Kerala and its only registration is Karnataka's. Nothing about this is
   *   detectable while pricing: `registrationFor()` ends `?? inCountry[0]`, so
   *   the bill prices perfectly well under the Karnataka GSTIN and prints a
   *   number that looks entirely right.
   */
  await owner.query(`UPDATE branches SET country_code = 'IN', region_code = 'KL' WHERE id = $1`, [
    orgB.branchId,
  ]);

  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', 'Life A Pvt Ltd', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'KA', 'GST', '29BBBBB2222B1ZB', 'Life B Pvt Ltd', '2025-04-01', now()),
            (gen_random_uuid(), $3, 'IN', 'KA', 'GST', '29CCCCC3333C1ZC', 'Life C Pvt Ltd', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId, orgC.organizationId]
  );

  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE',     500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION',   0, 'EXEMPT',   'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'GST', 'MEDICINE',     500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $3, 'IN', 'GST', 'MEDICINE',     500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId, orgC.organizationId]
  );

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  };
  ctxB = {
    organizationId: orgB.organizationId,
    branchIds: [orgB.branchId],
    userId: orgB.ownerUserId,
  };
  ctxC = {
    organizationId: orgC.organizationId,
    branchIds: [orgC.branchId],
    userId: orgC.ownerUserId,
  };
}, 40_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId, orgC?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId, orgC?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
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
// Helpers
// ---------------------------------------------------------------------------

const line = (description: string, taxCategory: string, major: string, quantity = 1) => ({
  description,
  taxCategory,
  unitPrice: inr(major),
  quantity,
});

type Lines = ReturnType<typeof line>[];

function draft(ctx: TenantContext, org: Org, lines: Lines, extra: Record<string, unknown> = {}) {
  return withTenant(ctx, (tx) =>
    createDraftInvoice(tx, ctx, {
      branchId: org.branchId,
      sourceType: 'OTHER',
      customer: { name: 'Walk-in' },
      suppliedAt: SUPPLIED_AT,
      currency: 'INR',
      lines,
      ...extra,
    } as Parameters<typeof createDraftInvoice>[2])
  );
}

const finalize = (ctx: TenantContext, invoiceId: string, issuedAt = SUPPLIED_AT) =>
  withTenant(ctx, (tx) => finalizeInvoice(tx, ctx, { invoiceId, issuedAt }));

/** Read a row back as the OWNER, so a test never mistakes an RLS miss for a value. */
async function row<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
  const result = await owner.query<T>(sql, params);
  if (!result.rows[0]) throw new Error(`no row for: ${sql}`);
  return result.rows[0];
}

/**
 * Run one statement as `rcln_app`, which is what the API connects as and what
 * every trigger below is written to constrain.
 *
 * ⚠️ ASSERTED THROUGH THE APP ROLE AND NOT THROUGH THE SERVICE. The whole
 *   argument for putting the lifecycle in Postgres is that the service is one of
 *   several paths a write can take. A test that only called the service would
 *   pass just as happily with no trigger at all.
 */
const asApp = <T>(
  ctx: TenantContext,
  fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>
) => withTenant(ctx, fn);

// ---------------------------------------------------------------------------

describe('a draft is priced from the moment it exists', () => {
  it('writes the totals of its lines, not the column defaults', async () => {
    const { id } = await draft(ctxA, orgA, [
      line('Consultation', 'CONSULTATION', '750.00'),
      line('Amoxicillin 500mg', 'MEDICINE', '420.00'),
    ]);

    const invoice = await row<{
      status: string;
      subtotal: string;
      tax_total: string;
      grand_total: string;
      invoice_number: string | null;
      place_of_supply: string | null;
    }>(
      'SELECT status, subtotal, tax_total, grand_total, invoice_number, place_of_supply FROM invoices WHERE id = $1',
      [id]
    );

    expect(invoice.status).toBe('DRAFT');
    expect(invoice.subtotal).toBe('1170.00');
    // Only the medicine is rated: 420.00 at 5%.
    expect(invoice.tax_total).toBe('21.00');
    expect(invoice.grand_total).toBe('1191.00');
    expect(invoice.place_of_supply).toBe('IN-KA');

    /*
     * ⚠️ A DRAFT HOLDS NO NUMBER, AND THAT IS WHAT KEEPS THE SERIES GAPLESS.
     *   `issueNumber()` is called at finalisation and nowhere else, so a draft
     *   the cashier abandons burns no serial.
     */
    expect(invoice.invoice_number).toBeNull();
  });

  it('writes a tax row per printed line, split into CGST and SGST', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '420.00')]);

    const taxes = await owner.query<{ name: string; jurisdiction: string; tax_amount: string }>(
      `SELECT name, jurisdiction, tax_amount FROM invoice_taxes WHERE invoice_id = $1 ORDER BY name`,
      [id]
    );

    expect(taxes.rows.map((t) => t.name)).toEqual(['CGST', 'SGST']);
    expect(taxes.rows.map((t) => t.jurisdiction)).toEqual(['IN', 'IN-KA']);
    expect(taxes.rows.map((t) => t.tax_amount)).toEqual(['10.50', '10.50']);
  });

  it('re-prices from the stored inputs when the rate card changes underneath it', async () => {
    /*
     * The reason finalisation re-prices instead of trusting the draft's totals:
     * a rate correction between the draft being opened and the patient being
     * handed the bill must reach the document.
     */
    const { id } = await draft(ctxC, orgC, [line('Amoxicillin 500mg', 'MEDICINE', '1000.00')]);
    expect(
      (await row<{ tax_total: string }>('SELECT tax_total FROM invoices WHERE id = $1', [id]))
        .tax_total
    ).toBe('50.00');

    await owner.query(
      `UPDATE tax_rules SET rate_bps = 1200 WHERE organization_id = $1 AND tax_category = 'MEDICINE'`,
      [orgC.organizationId]
    );

    await withTenant(ctxC, (tx) => repriceDraftInvoice(tx, ctxC, id));
    expect(
      (await row<{ tax_total: string }>('SELECT tax_total FROM invoices WHERE id = $1', [id]))
        .tax_total
    ).toBe('120.00');

    await owner.query(
      `UPDATE tax_rules SET rate_bps = 500 WHERE organization_id = $1 AND tax_category = 'MEDICINE'`,
      [orgC.organizationId]
    );
  });
});

describe('finalisation', () => {
  it('takes the number, dates the document and records who issued it', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '420.00')]);
    const issued = await finalize(ctxA, id);

    expect(issued.invoiceNumber).toMatch(/^INV-2026-OTH-MAIN-\d{6}$/);
    expect(issued.grandTotal).toEqual(inr('441.00'));

    const invoice = await row<{
      status: string;
      invoice_number: string;
      issued_at: Date;
      issued_by: string;
      issuer_tax_id: string;
      issuer_legal_name: string;
      issuer_tax_registration_id: string;
      tax_treatment: string;
    }>(
      `SELECT status, invoice_number, issued_at, issued_by, issuer_tax_id, issuer_legal_name,
              issuer_tax_registration_id, tax_treatment
         FROM invoices WHERE id = $1`,
      [id]
    );

    expect(invoice.status).toBe('ISSUED');
    expect(invoice.invoice_number).toBe(issued.invoiceNumber);
    expect(invoice.issued_by).toBe(orgA.ownerUserId);
    expect(invoice.issuer_tax_id).toBe('29AAACR1234K1ZP');
    expect(invoice.issuer_legal_name).toBe('Life A Pvt Ltd');
    expect(invoice.issuer_tax_registration_id).not.toBeNull();
    expect(invoice.tax_treatment).toBe('STANDARD');
  });

  it('refuses a line the clinic never gave a rate for, and leaves the counter where it was', async () => {
    /*
     * ⚠️ THE CASE PHASES 2 AND 4 BOTH ENDED WITH "REPORTED AND NOT YET REFUSED".
     *   `PHYSIOTHERAPY` matches no rule, so the engine charged nothing rather
     *   than guessing a rate — and issuing that is a bill that under-collects
     *   tax the clinic still owes.
     */
    const { id } = await draft(ctxA, orgA, [line('Physiotherapy', 'PHYSIOTHERAPY', '900.00')]);

    const before = await currentSerial(orgA.branchId);
    await expect(finalize(ctxA, id)).rejects.toThrow(/every line has a rate/i);

    /*
     * ⚠️ THIS IS THE TRANSACTION'S DOING, NOT THE ORDERING'S, AND MEASURING IT
     *   CORRECTED THE COMMENT THAT SAID OTHERWISE. Moving `issueInvoiceNumber`
     *   ahead of the issuable check above fails NO test: the throw rolls the
     *   whole transaction back and the counter's increment with it. Taking the
     *   number last buys the lock window and nothing more.
     */
    expect(await currentSerial(orgA.branchId)).toBe(before);

    const invoice = await row<{ status: string; invoice_number: string | null }>(
      'SELECT status, invoice_number FROM invoices WHERE id = $1',
      [id]
    );
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.invoice_number).toBeNull();
  });

  it('refuses a branch whose state the clinic holds no registration for', async () => {
    /*
     * ⚠️ THE `region_code` CHECK PHASE 2 DEFERRED, AND THE REASON IT CANNOT BE A
     *   NULL CHECK. B prices perfectly: `registrationFor()` falls back to the
     *   only registration in the country, so the bill comes out taxed, plausible
     *   and issued under KARNATAKA's GSTIN from a KERALA branch. Nothing in the
     *   priced document says so. `branches.region_code` was backfilled from the
     *   organization, so this is the state every second branch a group opens is
     *   in until somebody edits it — and until now nothing prompted anybody.
     */
    const { id } = await draft(ctxB, orgB, [line('Amoxicillin 500mg', 'MEDICINE', '420.00')]);

    await expect(finalize(ctxB, id)).rejects.toThrow(/holds no tax registration there/i);

    // Correct the branch and the same draft issues.
    await owner.query(`UPDATE branches SET region_code = 'KA' WHERE id = $1`, [orgB.branchId]);
    const issued = await finalize(ctxB, id);
    expect(issued.invoiceNumber).toMatch(/^INV-2026-OTH-MAIN-\d{6}$/);
    await owner.query(`UPDATE branches SET region_code = 'KL' WHERE id = $1`, [orgB.branchId]);
  });

  it('lets a clinic that holds no registration at all issue anyway', async () => {
    /*
     * ⚠️ NOT THE SAME FAILURE AS ABOVE, AND CONFLATING THEM WOULD STOP EVERY
     *   UNREGISTERED CLINIC ON THE PLATFORM FROM BILLING ANYBODY. A clinic below
     *   the registration threshold has a legal position, and `NOT_REGISTERED` is
     *   it. Only the clinic that IS registered somewhere, and not where it is
     *   billing from, is the one with a problem.
     */
    await owner.query('DELETE FROM issuer_tax_registrations WHERE organization_id = $1', [
      orgC.organizationId,
    ]);
    // Nothing of C's is issued yet, so the RESTRICT on `issuer_tax_registration_id`
    // has nothing to protect — which is itself the shape that FK is there for.

    const { id } = await draft(ctxC, orgC, [line('Amoxicillin 500mg', 'MEDICINE', '420.00')]);
    await finalize(ctxC, id);

    const invoice = await row<{
      status: string;
      tax_treatment: string;
      tax_total: string;
      issuer_tax_registration_id: string | null;
    }>(
      'SELECT status, tax_treatment, tax_total, issuer_tax_registration_id FROM invoices WHERE id = $1',
      [id]
    );
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.tax_treatment).toBe('NOT_REGISTERED');
    expect(invoice.tax_total).toBe('0.00');
    // Citing a registration it did not charge under would be a claim about which
    // return this invoice belongs on.
    expect(invoice.issuer_tax_registration_id).toBeNull();
  });

  it('refuses to finalise an invoice that is already a document', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '100.00')]);
    await finalize(ctxA, id);

    await expect(finalize(ctxA, id)).rejects.toThrow(/ISSUED/);
  });

  it('gives an abandoned draft no place in the series', async () => {
    /*
     * The whole reason the number is taken at finalisation. Two drafts are
     * opened and one is cancelled; the serial the survivor gets is the next one,
     * not the one after a hole.
     */
    const doomed = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);
    const real = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);

    const before = await currentSerial(orgA.branchId);
    await withTenant(ctxA, (tx) =>
      cancelDraftInvoice(tx, ctxA, { invoiceId: doomed.id, reason: 'Wrong patient' })
    );
    const issued = await finalize(ctxA, real.id);

    expect(Number(issued.invoiceNumber.slice(-6))).toBe(before + 1);
  });
});

describe('an issued invoice is immutable in the database, not only in the service', () => {
  let issuedId: string;
  let issuedNumber: string;

  beforeAll(async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '420.00')]);
    const issued = await finalize(ctxA, id);
    issuedId = id;
    issuedNumber = issued.invoiceNumber;
  });

  it('refuses to rewrite the total', async () => {
    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`UPDATE invoices SET grand_total = 1.00 WHERE id = ${issuedId}::uuid`
      )
    ).rejects.toThrow(/may not change: grand_total/);
  });

  it('refuses to rewrite the number, the issue date or the customer snapshot', async () => {
    await expect(
      asApp(
        ctxA,
        (tx) =>
          tx.$executeRaw`UPDATE invoices SET customer_name = 'Somebody Else' WHERE id = ${issuedId}::uuid`
      )
    ).rejects.toThrow(/may not change: customer_name/);

    await expect(
      asApp(
        ctxA,
        (tx) =>
          tx.$executeRaw`UPDATE invoices SET invoice_number = 'INV-2026-OTH-MAIN-999999' WHERE id = ${issuedId}::uuid`
      )
    ).rejects.toThrow(/may not change: invoice_number/);
  });

  it('refuses to un-issue it', async () => {
    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`UPDATE invoices SET status = 'DRAFT' WHERE id = ${issuedId}::uuid`
      )
    ).rejects.toThrow(/cannot move from ISSUED to DRAFT/);
  });

  it('refuses to soft-delete it', async () => {
    /*
     * `deleted_at` is deliberately NOT on the mutable allow-list: soft delete is
     * for a DRAFT, and an issued invoice is VOIDed so the number and the trail
     * stay where they are.
     */
    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`UPDATE invoices SET deleted_at = now() WHERE id = ${issuedId}::uuid`
      )
    ).rejects.toThrow(/may not change: deleted_at/);
  });

  it('refuses to delete it out of the series', async () => {
    await expect(
      asApp(ctxA, (tx) => tx.$executeRaw`DELETE FROM invoices WHERE id = ${issuedId}::uuid`)
    ).rejects.toThrow(/cannot be deleted/);

    expect(
      (
        await row<{ invoice_number: string }>('SELECT invoice_number FROM invoices WHERE id = $1', [
          issuedId,
        ])
      ).invoice_number
    ).toBe(issuedNumber);
  });

  it('refuses a line added, edited or removed underneath it', async () => {
    /*
     * ⚠️ WITHOUT THIS THE FROZEN TOTAL PROTECTS A NUMBER AND NOT A DOCUMENT. An
     *   invoice whose `grand_total` cannot move but whose lines can is an
     *   invoice that states a total which is not the sum of what it prints.
     */
    const item = await row<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1',
      [issuedId]
    );

    await expect(
      asApp(
        ctxA,
        (tx) =>
          tx.$executeRaw`UPDATE invoice_items SET unit_price = 1.00 WHERE id = ${item.id}::uuid`
      )
    ).rejects.toThrow(/already issued/);

    await expect(
      asApp(ctxA, (tx) => tx.$executeRaw`DELETE FROM invoice_items WHERE id = ${item.id}::uuid`)
    ).rejects.toThrow(/already issued/);

    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`
          INSERT INTO invoice_items (id, organization_id, branch_id, invoice_id, line_number, description,
                                     tax_category, quantity, unit_price, gross_amount, taxable_amount,
                                     line_total, updated_at)
          VALUES (gen_random_uuid(), ${ctxA.organizationId}::uuid, ${orgA.branchId}::uuid, ${issuedId}::uuid,
                  99, 'Slipped in later', 'MEDICINE', 1, 10.00, 10.00, 10.00, 10.00, now())`
      )
    ).rejects.toThrow(/already issued/);
  });

  it('refuses a tax row added underneath it', async () => {
    const item = await row<{ id: string }>(
      'SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1',
      [issuedId]
    );

    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`
          INSERT INTO invoice_taxes (id, organization_id, branch_id, invoice_id, invoice_item_id,
                                     name, jurisdiction, rate_bps, taxable_amount, tax_amount, treatment)
          VALUES (gen_random_uuid(), ${ctxA.organizationId}::uuid, ${orgA.branchId}::uuid, ${issuedId}::uuid,
                  ${item.id}::uuid, 'CESS', 'IN', 100, 420.00, 4.20, 'STANDARD')`
      )
    ).rejects.toThrow(/already issued/);
  });

  it('still lets settlement and the reversal move, which is why the guard is an allow-list', async () => {
    /*
     * ⚠️ THE CASE THAT WOULD BE MISSING FROM A SUITE THAT ONLY TESTED REFUSALS.
     *   A guard that froze `amount_paid` too would make PARTIALLY_PAID and PAID
     *   unreachable, and every test above would still pass.
     */
    await asApp(
      ctxA,
      (tx) => tx.$executeRaw`
        UPDATE invoices SET amount_paid = 200.00, status = 'PARTIALLY_PAID', updated_at = now()
         WHERE id = ${issuedId}::uuid`
    );
    await asApp(
      ctxA,
      (tx) => tx.$executeRaw`
        UPDATE invoices SET amount_paid = 441.00, status = 'PAID', updated_at = now()
         WHERE id = ${issuedId}::uuid`
    );

    const invoice = await row<{ status: string; amount_paid: string; grand_total: string }>(
      'SELECT status, amount_paid, grand_total FROM invoices WHERE id = $1',
      [issuedId]
    );
    expect(invoice.status).toBe('PAID');
    expect(invoice.amount_paid).toBe('441.00');
    // The balance is derived from these two and is deliberately not a column.
    expect(invoice.grand_total).toBe('441.00');
  });
});

describe('cancel and void are different documents’ answers to the same question', () => {
  it('cancels a draft, which never held a number', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);
    await withTenant(ctxA, (tx) =>
      cancelDraftInvoice(tx, ctxA, { invoiceId: id, reason: 'Patient left' })
    );

    const invoice = await row<{
      status: string;
      invoice_number: string | null;
      cancelled_by: string;
      cancellation_reason: string;
    }>(
      'SELECT status, invoice_number, cancelled_by, cancellation_reason FROM invoices WHERE id = $1',
      [id]
    );

    expect(invoice.status).toBe('CANCELLED');
    expect(invoice.invoice_number).toBeNull();
    expect(invoice.cancelled_by).toBe(orgA.ownerUserId);
    expect(invoice.cancellation_reason).toBe('Patient left');
  });

  it('refuses to cancel an issued invoice, and voids it instead — keeping the number', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);
    const issued = await finalize(ctxA, id);

    await expect(
      withTenant(ctxA, (tx) => cancelDraftInvoice(tx, ctxA, { invoiceId: id, reason: 'oops' }))
    ).rejects.toThrow(/voided, which keeps its number/);

    await withTenant(ctxA, (tx) =>
      voidInvoice(tx, ctxA, { invoiceId: id, reason: 'Billed the wrong visit' })
    );

    const invoice = await row<{ status: string; invoice_number: string; voided_at: Date | null }>(
      'SELECT status, invoice_number, voided_at FROM invoices WHERE id = $1',
      [id]
    );
    expect(invoice.status).toBe('VOID');
    expect(invoice.invoice_number).toBe(issued.invoiceNumber);
    expect(invoice.voided_at).not.toBeNull();
  });

  it('refuses to void a draft — there is nothing to reverse', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);

    await expect(
      withTenant(ctxA, (tx) => voidInvoice(tx, ctxA, { invoiceId: id, reason: 'no' }))
    ).rejects.toThrow(/DRAFT/);
  });

  it('refuses to revive a voided invoice', async () => {
    const { id } = await draft(ctxA, orgA, [line('Amoxicillin 500mg', 'MEDICINE', '10.00')]);
    await finalize(ctxA, id);
    await withTenant(ctxA, (tx) => voidInvoice(tx, ctxA, { invoiceId: id, reason: 'Duplicate' }));

    await expect(
      asApp(
        ctxA,
        (tx) => tx.$executeRaw`UPDATE invoices SET status = 'ISSUED' WHERE id = ${id}::uuid`
      )
    ).rejects.toThrow(/cannot move from VOID to ISSUED/);
  });
});

/** The branch's current `OTHER` counter, read past RLS. */
async function currentSerial(branchId: string): Promise<number> {
  const result = await owner.query<{ last_number: string }>(
    `SELECT last_number FROM number_sequences
      WHERE branch_id = $1 AND sequence_type = 'INVOICE' AND period_key LIKE '%:OTH'`,
    [branchId]
  );
  return Number(result.rows[0]?.last_number ?? 0);
}
