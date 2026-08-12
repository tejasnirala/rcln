/**
 * Tenant isolation — spine.
 *
 * The Stage 1 spine: number_sequences and data_access_logs.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import { ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

/**
 * The Stage 1 spine: number_sequences and data_access_logs.
 *
 * Both are org-scoped and both matter for different reasons.
 *
 *   number_sequences hands out UHIDs and MRNs. A leak across the boundary is
 *   not a read of PHI — it is worse in one specific way: clinic A incrementing
 *   clinic B's counter makes B's next patient number jump, and neither clinic
 *   can explain why.
 *
 *   data_access_logs is the record of who read whose chart. A tenant that could
 *   read another's rows would learn which patients that clinic treats from the
 *   trail built to protect them, and one that could write into another's would
 *   be able to forge an alibi.
 */
describe('number_sequences', () => {
  const SEQ_A = 'eeeeeeee-0000-0000-0000-0000000000e1';
  const SEQ_B = 'eeeeeeee-0000-0000-0000-0000000000e2';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO number_sequences
         (id, organization_id, branch_id, sequence_type, period_key, prefix, padding, last_number, updated_at)
       VALUES ($1, $2, NULL, 'UHID', '', 'P', 6, 41, now()),
              ($3, $4, NULL, 'UHID', '', 'P', 6, 7,  now())
       ON CONFLICT DO NOTHING`,
      [SEQ_A, ORG_A, SEQ_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM number_sequences WHERE id = ANY($1)', [[SEQ_A, SEQ_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM number_sequences'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each organization only its own counter', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query<{ last_number: string }>(
        'SELECT last_number FROM number_sequences'
      );
      return rows.map((r) => Number(r.last_number));
    });
    const forB = await asTenant(ORG_B, async () => {
      const { rows } = await app.query<{ last_number: string }>(
        'SELECT last_number FROM number_sequences'
      );
      return rows.map((r) => Number(r.last_number));
    });

    expect(forA).toEqual([41]);
    expect(forB).toEqual([7]);
  });

  it('cannot read another tenant even when its id is known', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM number_sequences WHERE id = $1', [SEQ_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a counter into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO number_sequences
             (id, organization_id, branch_id, sequence_type, period_key, prefix, padding, last_number, updated_at)
           VALUES (gen_random_uuid(), $1, NULL, 'MRN', '', 'X', 6, 1, now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot advance another tenant's counter", async () => {
    // The concrete harm: B's next patient number jumps and nobody can say why.
    const updated = await asTenant(ORG_A, async () => {
      const res = await app.query(
        'UPDATE number_sequences SET last_number = last_number + 100 WHERE id = $1',
        [SEQ_B]
      );
      return res.rowCount;
    });
    expect(updated).toBe(0);

    const { rows } = await owner.query<{ last_number: string }>(
      'SELECT last_number FROM number_sequences WHERE id = $1',
      [SEQ_B]
    );
    expect(Number(rows[0]?.last_number)).toBe(7);
  });
});

describe('data_access_logs', () => {
  const DAL_A = 'ffffffff-0000-0000-0000-0000000000f1';
  const DAL_B = 'ffffffff-0000-0000-0000-0000000000f2';
  const PATIENT_B = 'ffffffff-0000-0000-0000-0000000000b9';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO data_access_logs
         (id, organization_id, patient_id, access_type, resource, result_count)
       VALUES ($1, $2, NULL,  'VIEW', 'PATIENT', 1),
              ($3, $4, $5,    'VIEW', 'PATIENT', 1)
       ON CONFLICT DO NOTHING`,
      [DAL_A, ORG_A, DAL_B, ORG_B, PATIENT_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM data_access_logs WHERE id = ANY($1)', [[DAL_A, DAL_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM data_access_logs'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each organization only its own trail', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM data_access_logs');
      return rows.length;
    });
    expect(forA).toBe(1);
  });

  it('cannot learn which patients another clinic treats', async () => {
    // The specific disclosure: the trail built to protect patients would
    // otherwise name them to a competitor.
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT patient_id FROM data_access_logs WHERE patient_id IS NOT NULL'
      );
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a read-record into another tenant', async () => {
    // Forging an alibi: "someone at clinic B looked at this, not me".
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO data_access_logs
             (id, organization_id, access_type, resource, result_count)
           VALUES (gen_random_uuid(), $1, 'VIEW', 'PATIENT', 1)`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * Append-only, measured from INSIDE the tenant with the row visible.
   *
   * An out-of-context attempt reports 0 rows and proves nothing — it would pass
   * just as happily against a table with no protection at all. These two run
   * with app.current_org set to the row's own organization, so the refusal is a
   * real refusal.
   */
  it('refuses UPDATE from the app role with the row visible', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE data_access_logs SET result_count = 999 WHERE id = $1', [DAL_A])
      )
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses DELETE from the app role with the row visible', async () => {
    await expect(
      asTenant(ORG_A, () => app.query('DELETE FROM data_access_logs WHERE id = $1', [DAL_A]))
    ).rejects.toThrow(/permission denied|append-only/i);

    const { rows } = await owner.query('SELECT id FROM data_access_logs WHERE id = $1', [DAL_A]);
    expect(rows).toHaveLength(1);
  });
});
