/**
 * Tenant isolation — invoices.
 *
 * Patient invoices and their lines, payments and adjustments.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import {
  BRANCH_A,
  BRANCH_B1,
  BRANCH_B2,
  ORG_A,
  ORG_B,
  app,
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

describe('patient invoices', () => {
  const INV_PATIENT_A = 'dddddddd-1111-4111-8111-0000000000a1';
  const INV_PATIENT_B = 'dddddddd-1111-4111-8111-0000000000b1';
  const INV_REG_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const INV_REG_B2 = 'dddddddd-7777-4777-8777-0000000000b2';
  const INV_DOC_USER_A = 'dddddddd-8888-4888-8888-0000000000a1';
  const INV_DOC_USER_B = 'dddddddd-8888-4888-8888-0000000000b1';
  const INV_DOC_A = 'dddddddd-9999-4999-8999-0000000000a1';
  const INV_DOC_B = 'dddddddd-9999-4999-8999-0000000000b1';
  /** The visits the seeded invoices bill for — the new composite FK's target. */
  const INV_APT_A = 'dddddddd-aaaa-4aaa-8aaa-0000000000a1';
  const INV_APT_B2 = 'dddddddd-aaaa-4aaa-8aaa-0000000000b2';
  const INV_A = 'dddddddd-2222-4222-8222-0000000000a1';
  /** Raised at B2, so a reader scoped to B1 must not see it. */
  const INV_B2 = 'dddddddd-2222-4222-8222-0000000000b2';
  const ITEM_B2 = 'dddddddd-3333-4333-8333-0000000000b2';
  const TAX_B2 = 'dddddddd-4444-4444-8444-0000000000b2';
  const FILE_A = 'dddddddd-5555-4555-8555-0000000000a1';
  const FILE_B = 'dddddddd-5555-4555-8555-0000000000b1';
  const DOC_B2 = 'dddddddd-6666-4666-8666-0000000000b2';

  async function asTenantAtBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'INVA0001', 'Inv A', now()), ($3, $4, 'INVB0001', 'Inv B', now())
       ON CONFLICT DO NOTHING`,
      [INV_PATIENT_A, ORG_A, INV_PATIENT_B, ORG_B]
    );

    /*
     * A real visit per tenant, so the seeded invoices cite an appointment
     * through the composite FK rather than a bare uuid. Without these the
     * `invoices_source_reference_matches_type` CHECK refuses the rows outright,
     * which is the point of the constraint.
     */
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'INVMRNA', now()), ($5, $6, $7, $8, 'INVMRNB', now())
       ON CONFLICT DO NOTHING`,
      [INV_REG_A, ORG_A, INV_PATIENT_A, BRANCH_A, INV_REG_B2, ORG_B, INV_PATIENT_B, BRANCH_B2]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Inv Doc A', 'inv-doc-a@example.test', now()),
              ($2, 'Inv Doc B', 'inv-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [INV_DOC_USER_A, INV_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [INV_DOC_A, ORG_A, INV_DOC_USER_A, INV_DOC_B, ORG_B, INV_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, appointment_number, scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'INVA000001',
               '2027-07-01T04:00:00Z', '2027-07-01T04:15:00Z', now()),
              ($7, $8, $9, $10, $11, $12, 'INVB000001',
               '2027-07-01T05:00:00Z', '2027-07-01T05:15:00Z', now())
       ON CONFLICT DO NOTHING`,
      [
        INV_APT_A,
        ORG_A,
        BRANCH_A,
        INV_PATIENT_A,
        INV_REG_A,
        INV_DOC_A,
        INV_APT_B2,
        ORG_B,
        BRANCH_B2,
        INV_PATIENT_B,
        INV_REG_B2,
        INV_DOC_B,
      ]
    );

    await owner.query(
      `INSERT INTO invoices
         (id, organization_id, branch_id, patient_id, invoice_number, source_type,
          appointment_id, customer_name, supplied_at, issued_at, status, grand_total,
          updated_at)
       VALUES ($1, $2, $3, $4, 'INV-2026-APP-MAIN-000001', 'APPOINTMENT', $9,
               'Inv A', now(), now(), 'ISSUED', 500.00, now()),
              ($5, $6, $7, $8, 'INV-2026-APP-B2-000001', 'APPOINTMENT', $10,
               'Inv B', now(), now(), 'ISSUED', 900.00, now())
       ON CONFLICT DO NOTHING`,
      [
        INV_A,
        ORG_A,
        BRANCH_A,
        INV_PATIENT_A,
        INV_B2,
        ORG_B,
        BRANCH_B2,
        INV_PATIENT_B,
        INV_APT_A,
        INV_APT_B2,
      ]
    );

    await owner.query(
      `INSERT INTO invoice_items
         (id, organization_id, branch_id, invoice_id, line_number, description,
          tax_category, unit_price, gross_amount, taxable_amount, line_total, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'MRI Brain with contrast', 'PROCEDURE',
               900.00, 900.00, 900.00, 900.00, now())
       ON CONFLICT DO NOTHING`,
      [ITEM_B2, ORG_B, BRANCH_B2, INV_B2]
    );

    await owner.query(
      `INSERT INTO invoice_taxes
         (id, organization_id, branch_id, invoice_id, invoice_item_id, name,
          jurisdiction, rate_bps, taxable_amount, tax_amount, treatment)
       VALUES ($1, $2, $3, $4, $5, 'CGST', 'IN', 600, 900.00, 54.00, 'STANDARD')
       ON CONFLICT DO NOTHING`,
      [TAX_B2, ORG_B, BRANCH_B2, INV_B2, ITEM_B2]
    );

    await owner.query(
      `INSERT INTO files
         (id, organization_id, branch_id, document_type, status, storage_key,
          original_name, mime_type)
       VALUES ($1, $2, $3, 'INVOICE_PDF', 'READY', $7, 'a.pdf', 'application/pdf'),
              ($4, $5, $6, 'INVOICE_PDF', 'READY', $8, 'b.pdf', 'application/pdf')
       ON CONFLICT DO NOTHING`,
      [FILE_A, ORG_A, BRANCH_A, FILE_B, ORG_B, BRANCH_B2, `iso/${FILE_A}.pdf`, `iso/${FILE_B}.pdf`]
    );

    await owner.query(
      `INSERT INTO invoice_documents
         (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_PDF', 'invoice', 1)
       ON CONFLICT DO NOTHING`,
      [DOC_B2, ORG_B, BRANCH_B2, INV_B2, FILE_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM invoice_documents WHERE id = $1', [DOC_B2]);
    await owner.query('DELETE FROM files WHERE id = ANY($1)', [[FILE_A, FILE_B]]);
    await owner.query('DELETE FROM invoice_taxes WHERE id = $1', [TAX_B2]);
    await owner.query('DELETE FROM invoice_items WHERE id = $1', [ITEM_B2]);
    await owner.query('DELETE FROM invoices WHERE id = ANY($1)', [[INV_A, INV_B2]]);
    await owner.query('DELETE FROM appointments WHERE id = ANY($1)', [[INV_APT_A, INV_APT_B2]]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[INV_DOC_A, INV_DOC_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[INV_DOC_USER_A, INV_DOC_USER_B]]);
    await owner.query('DELETE FROM patient_registrations WHERE id = ANY($1)', [
      [INV_REG_A, INV_REG_B2],
    ]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[INV_PATIENT_A, INV_PATIENT_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM invoices');
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides an invoice belonging to another clinic, even by primary key', async () => {
    const rows = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const r = await app.query('SELECT id FROM invoices WHERE id = $1', [INV_B2]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  /*
   * ⚠️ THE CASE THE CHILDREN CARRY THEIR OWN TENANT COLUMNS FOR. A line reads
   *   "MRI Brain with contrast" — a clinical fact about a named person — and it
   *   is answerable by primary key. Isolated through a parent it would be
   *   protected only by the code never asking; here the database refuses.
   */
  it('hides the lines, taxes and documents of another clinic', async () => {
    const counts = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const items = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      const taxes = await app.query('SELECT id FROM invoice_taxes WHERE id = $1', [TAX_B2]);
      const docs = await app.query('SELECT id FROM invoice_documents WHERE id = $1', [DOC_B2]);
      return [items.rows.length, taxes.rows.length, docs.rows.length];
    });
    expect(counts).toEqual([0, 0, 0]);
  });

  /*
   * ⚠️ THE HALF A PARENT-SCOPED POLICY CANNOT ENFORCE. B1 and B2 are the same
   *   tenant, so tenant_isolation passes for both. Only branch_isolation — on
   *   the CHILD, in its own right — hides B2's takings from a cashier at B1. A
   *   child protected through its parent inherits the org half of that
   *   predicate and none of the branch half, which is the hole
   *   `appointment_status_history` had to restate by hand.
   */
  it('hides another BRANCH of the same clinic, lines included', async () => {
    const counts = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const invoices = await app.query('SELECT id FROM invoices WHERE id = $1', [INV_B2]);
      const items = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      const taxes = await app.query('SELECT id FROM invoice_taxes WHERE id = $1', [TAX_B2]);
      const docs = await app.query('SELECT id FROM invoice_documents WHERE id = $1', [DOC_B2]);
      return [invoices.rows.length, items.rows.length, taxes.rows.length, docs.rows.length];
    });
    expect(counts).toEqual([0, 0, 0, 0]);

    const own = await asTenantAtBranches(ORG_B, [BRANCH_B2], async () => {
      const r = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      return r.rows.length;
    });
    expect(own).toBe(1);
  });

  it('refuses to write an invoice into another tenant', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO invoices
             (id, organization_id, branch_id, source_type, customer_name,
              supplied_at, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Nobody', now(), 'DRAFT', now())`,
          [ORG_B, BRANCH_B2]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * ⚠️ THE POLICY THAT REPLACES A COMPOSITE FK THAT CANNOT EXIST.
   *   `files.organization_id` is nullable, so invoice_documents.file_id is a
   *   plain FK and ADR-0004 does not apply. The row's OWN organization_id would
   *   be perfectly correct here and tenant_isolation would pass; only
   *   `file_in_same_org` notices that the FILE belongs to somebody else.
   */
  it('refuses an invoice document citing a file from another tenant', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO invoice_documents
             (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'credit-note', 1)`,
          [ORG_A, BRANCH_A, INV_A, FILE_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('accepts an invoice document citing a file from its own tenant', async () => {
    const inserted = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const r = await app.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'credit-note', 1)
         RETURNING id`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      );
      return r.rows.length;
    });
    expect(inserted).toBe(1);
    await owner.query('DELETE FROM invoice_documents WHERE invoice_id = $1', [INV_A]);
  });

  /*
   * ⚠️ The one unique in this schema that wants NULLS DISTINCT, which is
   *   Postgres' default. Every DRAFT has a NULL invoice_number and a clinic has
   *   many drafts open at once; NULLS NOT DISTINCT would let it hold one.
   */
  it('allows many numberless drafts and still refuses a duplicate number', async () => {
    await owner.query(
      `INSERT INTO invoices
         (id, organization_id, branch_id, source_type, customer_name, supplied_at,
          status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Draft one', now(), 'DRAFT', now()),
              (gen_random_uuid(), $1, $2, 'OTHER', 'Draft two', now(), 'DRAFT', now())`,
      [ORG_A, BRANCH_A]
    );

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, invoice_number,
            supplied_at, issued_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Clash', 'INV-2026-APP-MAIN-000001',
                 now(), now(), 'ISSUED', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_organization_id_invoice_number_key/);

    await owner.query('DELETE FROM invoices WHERE organization_id = $1 AND status = $2', [
      ORG_A,
      'DRAFT',
    ]);
  });

  /*
   * ⚠️ An ISSUED invoice with no number cannot be cited on a return; a DRAFT
   *   that already holds one has burnt a serial that will never appear on any
   *   document, leaving a gap somebody has to explain years later.
   */
  it('refuses an issued invoice with no number, and a numbered draft', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            issued_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'No number', now(), now(), 'ISSUED', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_number_matches_status/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, invoice_number,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Early number',
                 'INV-2026-OTH-MAIN-000099', now(), 'DRAFT', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_number_matches_status/);
  });

  /*
   * ⚠️ THE WHOLE REASON `source_id` IS NOT A LOOSE UUID.
   *   The risk was never "this invoice bills an appointment that does not
   *   exist" — ids are random and nobody stumbles onto one. It is "this invoice
   *   bills ANOTHER CLINIC'S appointment", and only the composite
   *   (organization_id, appointment_id) reference answers that. A plain FK to
   *   `appointments(id)` would accept this row, and so would a stub table
   *   holding nothing but an id.
   */
  it('refuses an invoice billing an appointment from another clinic', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, appointment_id, customer_name,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'APPOINTMENT', $3, 'Cross tenant', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A, INV_APT_B2]
      )
    ).rejects.toThrow(/invoices_organization_id_appointment_id_fkey/);
  });

  /*
   * ⚠️ The clause list grows with the modules. An APPOINTMENT invoice that cites
   *   nothing has lost the link the moment it was created, and an OTHER invoice
   *   carrying an appointment is billing a visit while claiming to be manual —
   *   two rows that read as fine and reconcile against nothing.
   */
  it('refuses a source type and a reference column that disagree', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'APPOINTMENT', 'No visit', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_source_reference_matches_type/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, appointment_id, customer_name,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', $3, 'Manual with a visit', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A, INV_APT_A]
      )
    ).rejects.toThrow(/invoices_source_reference_matches_type/);
  });

  /*
   * ⚠️ "10% off" and "₹150 off" are different instructions that can produce the
   *   same amount, and the invoice prints which was given. A type without its
   *   input computes one way and prints another.
   */
  it('refuses a discount whose type and input disagree', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, discount_type, discount_fixed, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Wrong shape', now(), 'DRAFT',
                 'PERCENTAGE', 150.00, now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_discount_input_matches_type/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, discount_type, discount_bps, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Over 100%', now(), 'DRAFT',
                 'PERCENTAGE', 12000, now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_discount_input_matches_type/);
  });

  /*
   * ⚠️ Which table priced a line is the difference between a rate the clinic
   *   authored and one it merely inherited — the question the rate-card screen
   *   and an auditor both ask. A row citing both answers neither.
   */
  it('refuses a tax line citing both a tenant rule and a platform default', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'INVCHECK', 1200, 'STANDARD', 'GST',
               '2025-04-01', now())
       RETURNING id`,
      [ORG_B]
    );
    const ruleId = rows[0]!.id;

    const defaults = await owner.query<{ id: string }>(`SELECT id FROM tax_rule_defaults LIMIT 1`);

    if (defaults.rows[0]) {
      await expect(
        owner.query(
          `INSERT INTO invoice_taxes
             (id, organization_id, branch_id, invoice_id, invoice_item_id, tax_rule_id,
              tax_rule_default_id, name, rate_bps, taxable_amount, tax_amount, treatment)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'CGST', 600, 900.00, 54.00,
                   'STANDARD')`,
          [ORG_B, BRANCH_B2, INV_B2, ITEM_B2, ruleId, defaults.rows[0].id]
        )
      ).rejects.toThrow(/invoice_taxes_one_rule_source/);
    }

    await owner.query('DELETE FROM tax_rules WHERE id = $1', [ruleId]);
  });

  /*
   * ⚠️ A render that FAILED and was retried leaves a dead row behind, because
   *   the row is written before the bytes and the failure has to stay findable.
   *   A non-partial unique would refuse the retry: invoice issued, PDF
   *   permanently missing, discovered by a patient at the front desk.
   */
  it('allows a superseded document beside the current one, but not two current', async () => {
    await owner.query(`UPDATE invoice_documents SET superseded_at = now() WHERE id = $1`, [DOC_B2]);

    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO invoice_documents
         (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'INVOICE_PDF', 'invoice', 1)
       RETURNING id`,
      [ORG_B, BRANCH_B2, INV_B2, FILE_B]
    );

    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'INVOICE_PDF', 'invoice', 1)`,
        [ORG_B, BRANCH_B2, INV_B2, FILE_B]
      )
    ).rejects.toThrow(/invoice_documents_current_per_type_key/);

    await owner.query('DELETE FROM invoice_documents WHERE id = $1', [rows[0]!.id]);
    await owner.query('UPDATE invoice_documents SET superseded_at = NULL WHERE id = $1', [DOC_B2]);
  });

  /**
   * ⚠️ A DOCUMENT MUST SAY WHICH TEMPLATE DREW IT, AND THE COLUMNS HAVE NO
   *   DEFAULT ON PURPOSE. They exist so that "what did the document this patient
   *   is holding look like?" has an answer years later, when the template has
   *   moved on several revisions. A DEFAULT would be the reflexive way to make
   *   the migration safe and would stamp a confident, wrong answer onto any row
   *   that did not supply one — indistinguishable from a real one.
   */
  it('refuses an invoice document that does not say which template drew it', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF')`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      )
    ).rejects.toThrow(/template_key/);
  });

  /* A version is a count of revisions. Zero means nothing; negative is a typo. */
  it('refuses a template version that is not a positive count', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'invoice', 0)`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      )
    ).rejects.toThrow(/invoice_documents_template_version_positive/);
  });
});
