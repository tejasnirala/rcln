/**
 * The document an invoice becomes, against real Postgres.
 *
 * `packages/documents` proves the template renders a value correctly. What that
 * cannot prove is that the VALUE is right — and every interesting failure in
 * this phase lives there, because a document assembled from the wrong column is
 * a document that renders perfectly.
 *
 * What is asserted here is the set of claims `loadInvoiceDocumentData` actually
 * makes:
 *
 *   1. The snapshot wins over the live row. A clinic that renames itself does
 *      not silently restate an invoice somebody is holding.
 *   2. The tax table is grouped by name AND jurisdiction AND rate, so CGST 6%
 *      and SGST 6% stay two rows owed to two governments.
 *   3. Money comes back in the CURRENCY's minor units, not in an assumed two
 *      decimal places.
 *   4. It is scoped like everything else: another tenant's invoice is a 404.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { fromMajor } = await import('@rcln/payments');
const { renderInvoiceHtml } = await import('@rcln/documents');
const { loadInvoiceDocumentData } = await import('@rcln/documents/data');
const { DocumentError } = await import('@rcln/documents/store');
const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { createDraftInvoice, finalizeInvoice } =
  await import('../../src/services/invoicing/invoice-lifecycle.service.js');

const SUFFIX = `doc${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
/** Inside FY 2026-27, so every number reads `INV-2026-`. */
const SUPPLIED_AT = new Date('2026-08-11T06:00:00Z');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

type Org = { organizationId: string; ownerUserId: string; branchId: string };

let orgA: Org;
let orgB: Org;
let ctxA: TenantContext;
let ctxB: TenantContext;

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

  orgA = await registerOrganization(payload(`doc-a-${SUFFIX}`, 'Doc A'));
  orgB = await registerOrganization(payload(`doc-b-${SUFFIX}`, 'Doc B'));

  await owner.query(
    `UPDATE branches
        SET country_code = 'IN', region_code = 'KA',
            address_line1 = '418, 12th Main Road', city = 'Bengaluru',
            state = 'Karnataka', pincode = '560008', phone = '+918041238890'
      WHERE id = ANY($1)`,
    [[orgA.branchId, orgB.branchId]]
  );

  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', 'Doc A Pvt Ltd', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'KA', 'GST', '29BBBBB2222B1ZB', 'Doc B Pvt Ltd', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
  );

  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE',    1200, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'CONSUMABLE',  1800, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION',   0, 'EXEMPT',   'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'GST', 'MEDICINE',    1200, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
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
}, 40_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

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

const line = (description: string, taxCategory: string, major: string, quantity = 1) => ({
  description,
  taxCategory,
  unitPrice: inr(major),
  quantity,
});

async function issuedInvoice(
  ctx: TenantContext,
  org: Org,
  lines: ReturnType<typeof line>[],
  extra: Record<string, unknown> = {}
): Promise<string> {
  const { id } = await withTenant(ctx, (tx) =>
    createDraftInvoice(tx, ctx, {
      branchId: org.branchId,
      sourceType: 'OTHER',
      customer: { name: 'Rohit Venkataraman', phone: '+919845011223' },
      suppliedAt: SUPPLIED_AT,
      currency: 'INR',
      lines,
      ...extra,
    } as Parameters<typeof createDraftInvoice>[2])
  );
  await withTenant(ctx, (tx) => finalizeInvoice(tx, ctx, { invoiceId: id, issuedAt: SUPPLIED_AT }));
  return id;
}

const load = (ctx: TenantContext, invoiceId: string) =>
  withTenant(ctx, (tx) => loadInvoiceDocumentData(tx, ctx, invoiceId));

// ---------------------------------------------------------------------------

describe('the document states what the invoice states', () => {
  it('carries the number, the issuer and the registration off the row', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00', 10)]);
    const data = await load(ctxA, id);

    expect(data.invoiceNumber).toMatch(/^INV-2026-OTH-MAIN-\d{6}$/);
    expect(data.issuer.legalName).toBe('Doc A Pvt Ltd');
    expect(data.issuer.taxId).toBe('29AAACR1234K1ZP');
    expect(data.issuer.branchCode).toBe('MAIN');
    expect(data.placeOfSupply).toBe('IN-KA');
    expect(data.status).toBe('ISSUED');
  });

  /*
   * ⚠️ THE LABEL COMES FROM THE COUNTRY CATALOGUE, NOT FROM A CONSTANT. Hard-
   *   coding "GSTIN" over an Irish clinic's VAT number is the mistake Phase 2b
   *   removed from `clinic-settings.tsx`; on a printed document it would be the
   *   same error somewhere nobody looks again.
   */
  it('labels the registration the way its country does', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00')]);
    expect((await load(ctxA, id)).issuer.taxIdLabel).toBe('GSTIN');
  });

  /*
   * ⚠️ THE ONE THAT MATTERS MOST, AND THE ONE A LIVE JOIN WOULD FAIL. The
   *   clinic re-registers under a new legal name AFTER issuing. The invoice a
   *   patient is holding must keep saying what it said — that is why
   *   `issuer_legal_name` is a column and not a relation.
   */
  it('keeps printing the name the clinic had when it issued', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00')]);

    await owner.query(`UPDATE organizations SET legal_name = 'Renamed Health Ltd' WHERE id = $1`, [
      orgA.organizationId,
    ]);

    try {
      expect((await load(ctxA, id)).issuer.legalName).toBe('Doc A Pvt Ltd');
    } finally {
      await owner.query(`UPDATE organizations SET legal_name = 'Doc A Pvt Ltd' WHERE id = $1`, [
        orgA.organizationId,
      ]);
    }
  });
});

describe('the tax table', () => {
  /*
   * ⚠️ CGST AND SGST ARE TWO ROWS AT THE SAME RATE ON THE SAME BASE, OWED TO TWO
   *   DIFFERENT GOVERNMENTS. Grouping on rate alone would merge them into one
   *   12% row — a tax nobody levies, on the table a return is filed from.
   */
  it('keeps both halves of an Indian split apart', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '1000.00')]);
    const { taxSummary } = await load(ctxA, id);

    expect(taxSummary).toHaveLength(2);
    expect(taxSummary.map((row) => row.name).sort()).toEqual(['CGST', 'SGST']);
    expect(new Set(taxSummary.map((row) => row.jurisdiction))).toEqual(new Set(['IN', 'IN-KA']));
    // 12% split into halves, on ₹1000 — 6% each, and they sum to the whole.
    expect(taxSummary.every((row) => row.rateBps === 600)).toBe(true);
    expect(taxSummary.reduce((sum, row) => sum + row.taxAmountMinor, 0)).toBe(12_000);
  });

  /*
   * Two rates under the same component name is the other direction of the same
   * mistake: grouping on name alone would state one rate for both.
   */
  it('keeps two rates under one component apart', async () => {
    const id = await issuedInvoice(ctxA, orgA, [
      line('Paracetamol', 'MEDICINE', '1000.00'),
      line('Dressing pack', 'CONSUMABLE', '1000.00'),
    ]);
    const { taxSummary } = await load(ctxA, id);

    // CGST 6%, SGST 6%, CGST 9%, SGST 9% — four rows, not two.
    expect(taxSummary).toHaveLength(4);
    expect([...new Set(taxSummary.map((row) => row.rateBps))].sort((a, b) => a - b)).toEqual([
      600, 900,
    ]);
  });

  it('is empty for an exempt bill, and the treatment says why', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Consultation', 'CONSULTATION', '600.00')]);
    const data = await load(ctxA, id);

    expect(data.taxSummary).toHaveLength(0);
    expect(data.taxTreatment).toBe('EXEMPT');
    expect(data.totals.taxTotalMinor).toBe(0);
  });

  /*
   * A reprint must be the document that was printed the first time. Postgres
   * promises no row order without an ORDER BY, so the summary is sorted.
   */
  it('orders the summary deterministically', async () => {
    const id = await issuedInvoice(ctxA, orgA, [
      line('Dressing pack', 'CONSUMABLE', '1000.00'),
      line('Paracetamol', 'MEDICINE', '1000.00'),
    ]);

    const first = await load(ctxA, id);
    const second = await load(ctxA, id);
    expect(second.taxSummary).toEqual(first.taxSummary);
    expect(first.taxSummary.map((row) => row.rateBps)).toEqual([600, 600, 900, 900]);
  });
});

describe('money', () => {
  it('reports minor units, not the decimal column', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00', 10)]);
    const data = await load(ctxA, id);

    // ₹1000 of medicine at 12% = ₹1120.
    expect(data.totals.subtotalMinor).toBe(100_000);
    expect(data.totals.taxTotalMinor).toBe(12_000);
    expect(data.totals.grandTotalMinor).toBe(112_000);
  });

  /*
   * The one derived figure on the document, and the reason it is derived is that
   * there is no column for it. Everything else comes straight off a row.
   */
  it('derives the balance from the two columns that hold it', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00', 10)]);
    await owner.query(`UPDATE invoices SET amount_paid = 500.00 WHERE id = $1`, [id]);

    const { totals } = await load(ctxA, id);
    expect(totals.amountPaidMinor).toBe(50_000);
    expect(totals.balanceDueMinor).toBe(62_000);
  });
});

describe('scoping', () => {
  /*
   * Under RLS another tenant's id is indistinguishable from one that does not
   * exist, and both answers are the same — never a 403, which would confirm the
   * row is somebody's.
   */
  it('refuses another tenant’s invoice as not found', async () => {
    const id = await issuedInvoice(ctxA, orgA, [line('Paracetamol', 'MEDICINE', '100.00')]);
    await expect(load(ctxB, id)).rejects.toThrow(DocumentError);
  });
});

describe('the document the worker would render', () => {
  /*
   * The end of the phase's chain, asserted in one place: a real invoice, through
   * the real loader, into the real template. The PDF itself is the worker's, and
   * launching Chromium inside this suite would put a browser in the 1g api
   * container — which is the whole reason the render lives in the worker.
   */
  it('renders a real invoice into the real template', async () => {
    const id = await issuedInvoice(ctxA, orgA, [
      line('Consultation', 'CONSULTATION', '600.00'),
      line('Paracetamol', 'MEDICINE', '100.00', 10),
    ]);
    const data = await load(ctxA, id);
    const html = renderInvoiceHtml(data, { omitFonts: true });

    expect(html).toContain(data.invoiceNumber ?? 'MISSING');
    expect(html).toContain('29AAACR1234K1ZP');
    expect(html).toContain('Consultation');
    // A registered clinic charging tax heads its document a tax invoice.
    expect(html).toContain('Tax Invoice');
    // ₹1,120.00 grand total on a ₹1,600 bill with an exempt consultation.
    expect(html).toContain('1,720.00');
  });
});
