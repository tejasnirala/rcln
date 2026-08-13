/**
 * Tenant isolation — audit-logs.
 *
 * Append-only history — a revoked grant plus a trigger, and both are measured.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import { BRANCH_A, ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

/**
 * `audit_logs` is append-only, and Postgres is what says so.
 *
 * The history screen is the product feature; this is the reason anyone can trust
 * it. An audit trail the application can rewrite is not evidence, and "no endpoint
 * does that" is a claim about code that a bug or a future endpoint can falsify —
 * so the guarantee is a revoked grant plus a trigger, and both are measured.
 *
 * The failure mode is silent in exactly the way a missing RLS policy is: nothing
 * errors, the trail keeps working, and history quietly becomes editable.
 */
describe('audit_logs is append-only', () => {
  const ROW = 'eeeeeeee-0000-0000-0000-0000000000e1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO audit_logs (id, organization_id, action, entity_type, entity_id, after_data)
       VALUES ($1, $2, 'CREATE', 'branch', $3, '{"name":"Before"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ROW, ORG_A, BRANCH_A]
    );
  });

  afterAll(async () => {
    // As the owner, which is the only role that can — see the exemption below.
    await owner.query(`DELETE FROM audit_logs WHERE id = $1`, [ROW]);
  });

  it('lets the app read its own tenant’s history', async () => {
    const rows = await asTenant(ORG_A, () =>
      app.query(`SELECT id FROM audit_logs WHERE id = $1`, [ROW])
    );
    expect(rows.rowCount).toBe(1);
  });

  it('shows the app nothing of another tenant’s history', async () => {
    const rows = await asTenant(ORG_B, () =>
      app.query(`SELECT id FROM audit_logs WHERE id = $1`, [ROW])
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuses an UPDATE from the app, in its own tenant', async () => {
    // In its OWN tenant, with the row visible — so this is the grant and the
    // trigger being tested, not RLS filtering the row out and reporting 0.
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `UPDATE audit_logs SET after_data = '{"name":"Rewritten"}'::jsonb WHERE id = $1`,
          [ROW]
        )
      )
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses a DELETE from the app, in its own tenant', async () => {
    await expect(
      asTenant(ORG_A, () => app.query(`DELETE FROM audit_logs WHERE id = $1`, [ROW]))
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('leaves the row exactly as it was', async () => {
    const rows = await owner.query<{ after_data: { name: string } }>(
      `SELECT after_data FROM audit_logs WHERE id = $1`,
      [ROW]
    );
    expect(rows.rows[0]?.after_data.name).toBe('Before');
  });

  /**
   * The trigger exempts the table owner, and that is deliberate — the same
   * decision as RLS being ENABLE rather than FORCE.
   *
   * Two schema behaviours depend on it: `audit_logs.actor_user_id` is ON DELETE SET
   * NULL from `users` (an UPDATE on this table), and `organization_id` is ON DELETE
   * CASCADE. Without the exemption, hard-deleting any user who had ever touched a
   * record would fail — and an actor's account going away must not take the history
   * of what they did with it.
   */
  it('still lets the owner null an actor, so a user can be deleted', async () => {
    await owner.query('BEGIN');
    try {
      const updated = await owner.query(
        `UPDATE audit_logs SET actor_user_id = NULL WHERE id = $1`,
        [ROW]
      );
      expect(updated.rowCount).toBe(1);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
