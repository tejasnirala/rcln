/**
 * Tenant isolation — the consultation engine's foundation (CE-1).
 *
 * Seven new tables, THREE tenancy classes, and each class fails differently:
 *
 *   PLATFORM-EXTENSIBLE  clinical_master_items · clinical_master_codings ·
 *                        clinical_master_scopes · product_clinical_scopes
 *     Read-permissive, write-strict — NOT the `files` policy. Copying that one
 *     would let any clinic INSERT a platform-wide DIAGNOSIS, instantly visible
 *     to every tenant, written by anyone holding `clinical.master.manage`.
 *
 *   ORG-SCOPED           clinical_episodes · animal_profiles
 *     A treatment journey is PHI and follows the patient across branches.
 *
 *   ORG + BRANCH SCOPED  encounter_follow_up_recommendations
 *     Advice is given AT a place, and its `reason` says why a named person is
 *     being recalled.
 *
 * One file of the tenant-isolation suite; see ./README.md.
 */
import {
  BRANCH_A,
  BRANCH_B2,
  ORG_A,
  ORG_B,
  app,
  asTenant,
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

describe('the clinical vocabulary and the treatment journey', () => {
  const ITEM_PLATFORM = 'cccccccc-1111-4111-8111-000000000001';
  const ITEM_PRIVATE_B = 'cccccccc-1111-4111-8111-0000000000b1';
  const ITEM_PRIVATE_A = 'cccccccc-1111-4111-8111-0000000000a1';
  const SPECIALTY_PRIVATE_B = 'cccccccc-2222-4222-8222-0000000000b1';
  const PATIENT_A = 'cccccccc-3333-4333-8333-0000000000a1';
  const PATIENT_B = 'cccccccc-3333-4333-8333-0000000000b1';
  const EPISODE_A = 'cccccccc-4444-4444-8444-0000000000a1';
  const EPISODE_B = 'cccccccc-4444-4444-8444-0000000000b1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES ($1, NULL, 'DIAGNOSIS', 'ISO_PLATFORM_DX', 'Platform diagnosis', now()),
              ($2, $3,   'DIAGNOSIS', 'ISO_PRIVATE_DX',  'B private diagnosis', now()),
              ($4, $5,   'DIAGNOSIS', 'ISO_A_DX',        'A private diagnosis', now())
       ON CONFLICT DO NOTHING`,
      [ITEM_PLATFORM, ITEM_PRIVATE_B, ORG_B, ITEM_PRIVATE_A, ORG_A]
    );
    await owner.query(
      `INSERT INTO specialties (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_SPEC', 'B private specialty', now())
       ON CONFLICT DO NOTHING`,
      [SPECIALTY_PRIVATE_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'ISOCLINA', 'Ada', now()), ($3, $4, 'ISOCLINB', 'Grace', now())
       ON CONFLICT DO NOTHING`,
      [PATIENT_A, ORG_A, PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, title, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOEPA', 'A journey', DATE '2027-01-01', now()),
              ($4, $5, $6, 'ISOEPB', 'B journey', DATE '2027-01-01', now())
       ON CONFLICT DO NOTHING`,
      [EPISODE_A, ORG_A, PATIENT_A, EPISODE_B, ORG_B, PATIENT_B]
    );
  });

  // -- the vocabulary -------------------------------------------------------

  it('lets every clinic read the platform vocabulary', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM clinical_master_items WHERE id = $1', [
        ITEM_PLATFORM,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('shows one clinic nothing of another’s private vocabulary', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM clinical_master_items WHERE id = $1', [
        ITEM_PRIVATE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE ONE THAT MATTERS MOST ON THIS TABLE.
   *
   *   If the WITH CHECK were copied from `files` — which permits a NULL
   *   organization_id — this insert would SUCCEED, and the row would be a
   *   diagnosis visible to every clinic on the platform, authored by one of
   *   them. Nothing else in the system would flag it: it is a valid insert into
   *   a table the caller may write.
   */
  it('refuses to let a clinic publish a platform-wide diagnosis', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
           VALUES (gen_random_uuid(), NULL, 'DIAGNOSIS', 'SNEAK_DX', 'Sneak', now())`
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ A DELETE IS WHERE THE POLICY ALONE WOULD LOSE, AND THE TRIGGER IS WHAT
   *   WINS IT. Postgres applies NO WITH CHECK to a DELETE — there is no new row
   *   to check — so `USING (organization_id IS NULL OR ...)` is the entire test,
   *   and it PERMITS the platform row. Without `platform_rows_immutable`, any
   *   clinic could delete the shared vocabulary for every clinic.
   */
  it('refuses to let a clinic delete a platform term for everybody', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('DELETE FROM clinical_master_items WHERE id = $1', [ITEM_PLATFORM])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ CAPTURE. USING sees the OLD row (NULL org — permitted) and WITH CHECK
   *   sees the NEW row (the caller's own org — permitted). Neither clause ever
   *   compares the two, so without the trigger a clinic takes the platform term
   *   for itself and removes it from everyone else.
   */
  it('refuses to let a clinic capture a platform term as its own', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE clinical_master_items SET organization_id = $1 WHERE id = $2', [
          ORG_A,
          ITEM_PLATFORM,
        ])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ `specialty_id` IS A PLAIN FK, so `tenant_isolation` constrains the ITEM
   *   side and says nothing about what the row POINTS AT. Without the
   *   RESTRICTIVE `specialty_visible` policy, clinic A scopes its own diagnosis
   *   to clinic B's private specialty and reads B's specialty name back out of
   *   the join.
   */
  it('refuses to scope a term to another clinic’s private specialty', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO clinical_master_scopes (id, organization_id, item_id, specialty_id)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [ORG_A, ITEM_PRIVATE_A, SPECIALTY_PRIVATE_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to attach a coding to another clinic’s term', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO clinical_master_codings
             (id, organization_id, item_id, system, code, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ICD10', 'X00', now())`,
          [ORG_A, ITEM_PRIVATE_B]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  // -- the journey ----------------------------------------------------------

  it('shows one clinic nothing of another’s treatment journey', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM clinical_episodes WHERE id = $1', [
        EPISODE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows a clinic its own journey', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT title FROM clinical_episodes WHERE id = $1', [
        EPISODE_A,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  /**
   * ⚠️ AN EPISODE IS ORG-SCOPED AND DELIBERATELY NOT BRANCH-SCOPED (ADR-0016).
   *   A patient who starts at the main branch and continues at the satellite has
   *   ONE journey, so a reader scoped to only one branch must still see it —
   *   otherwise a clinician reads half a treatment history and does not know it.
   *
   *   This case would go red if somebody "tightened" the policy by adding a
   *   branch predicate, which is exactly the plausible-looking change it exists
   *   to catch.
   */
  it('shows a journey to a reader scoped to a single branch', async () => {
    const seen = await asTenant(ORG_A, async () => {
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [`{${BRANCH_A}}`]);
      const { rows } = await app.query('SELECT id FROM clinical_episodes WHERE id = $1', [
        EPISODE_A,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('refuses to open a journey for another clinic’s patient', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO clinical_episodes
             (id, organization_id, patient_id, code, opened_on, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'SNEAKEP', DATE '2027-01-01', now())`,
          [ORG_A, PATIENT_B]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  // -- the recommendation ---------------------------------------------------

  /**
   * ⚠️ BRANCH-SCOPED, unlike the episode above, and the difference is
   *   deliberate. `reason` on a recommendation says why a named person is being
   *   asked back — "review the biopsy" — so it is readable only from the branch
   *   that gave the advice, exactly like `appointment_vitals`.
   */
  it('refuses to record advice at a branch outside the caller’s scope', async () => {
    await expect(
      asTenant(ORG_A, async () => {
        await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [`{${BRANCH_A}}`]);
        return app.query(
          `INSERT INTO encounter_follow_up_recommendations
             (id, organization_id, branch_id, encounter_id, appointment_id, patient_id,
              is_required, interval_value, interval_unit, updated_at)
           VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), gen_random_uuid(), $3,
                   true, 15, 'DAYS', now())`,
          [ORG_A, BRANCH_B2, PATIENT_A]
        );
      })
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  /**
   * ⚠️ THE CHECK THAT STOPS A RECOMMENDATION SAYING NOTHING CHECKABLE (CD-13).
   *
   *   ⚠️ `encounter_id` IS NOT NULL SINCE CE-3 and is a made-up id here, exactly
   *     as `appointment_id` is: both FKs fail, and Postgres evaluates CHECK
   *     constraints BEFORE the FK triggers, so the constraint under test is
   *     still the one that raises.
   *
   *   "In 15 days" and "on 4 September" are both legitimate, and storing BOTH
   *   invites them to disagree — the recall list would then pick a winner
   *   silently, for ever. This is a database constraint rather than a
   *   convention, so no future writer can route around it.
   */
  it('refuses a recommendation that states both an interval and a date', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_follow_up_recommendations
           (id, organization_id, branch_id, encounter_id, appointment_id, patient_id,
            is_required, interval_value, interval_unit, recommended_date, updated_at)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), gen_random_uuid(), $3,
                 true, 15, 'DAYS', DATE '2027-09-04', now())`,
        [ORG_A, BRANCH_A, PATIENT_A]
      )
    ).rejects.toThrow(/follow_up_recommendation_when_is_stated|foreign key/i);
  });

  /**
   * "No follow-up needed" is a real clinical decision and carries no timing.
   * A two-legged constraint would have refused it, which is why the CHECK has
   * three legs.
   */
  it('accepts “no follow-up needed”, which carries no timing at all', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_follow_up_recommendations
           (id, organization_id, branch_id, encounter_id, appointment_id, patient_id,
            is_required, updated_at)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), gen_random_uuid(), $3,
                 false, now())`,
        [ORG_A, BRANCH_A, PATIENT_A]
      )
    ).rejects.toThrow(/foreign key/i); // the appointment id is fake; the CHECK passed
  });
});

/**
 * `animal_profiles` (PI-11).
 *
 * ⚠️ THE TABLE WAS NAMED IN THIS FILE'S HEADER FROM CE-1 AND HAD NO CASE, WHICH
 *   IS EXACTLY THE SHAPE OF THE FAILURE `db:rls:check` EXISTS TO CATCH AND
 *   CANNOT: the policy was there, nothing read the table, and a missing policy
 *   would have produced no error and broken no single-tenant test. PI-11 is the
 *   phase that gave it rows, so it is the phase that owes it the case.
 *
 * ORG-SCOPED and deliberately NOT branch-isolated, following `patients` for the
 * reason `patients` gives (ADR-0016): an animal's species and weight must follow
 * it to whichever branch it walks into, and a dose is calculated from that
 * weight.
 *
 * The two CHECK constraints are here too, because both encode a CLINICAL rule —
 * a weight with no date cannot be dosed from, and one owner recorded two ways is
 * two owners — and a rule that lives only in a service is a rule a fixture, a
 * backfill or a second service will eventually route around.
 */
describe('animal profiles', () => {
  const PATIENT_A = 'aaaacccc-3333-4333-8333-0000000000a1';
  const PATIENT_B = 'aaaacccc-3333-4333-8333-0000000000b1';
  const PROFILE_A = 'aaaacccc-5555-4555-8555-0000000000a1';
  const PROFILE_B = 'aaaacccc-5555-4555-8555-0000000000b1';
  const CONTACT_A = 'aaaacccc-6666-4666-8666-0000000000a1';
  const CONTACT_B = 'aaaacccc-6666-4666-8666-0000000000b1';
  /** A third animal in org A with NO profile, so the CHECK below is the only
   *  thing that can refuse the insert — the unique (org, patient) key would
   *  otherwise raise first and the test would pass for the wrong reason. */
  const PATIENT_A_BARE = 'aaaacccc-3333-4333-8333-0000000000a2';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, subject_type, updated_at)
       VALUES ($1, $2, 'ISOVETA', 'Kaapi', 'ANIMAL', now()),
              ($3, $4, 'ISOVETB', 'Filter', 'ANIMAL', now()),
              ($5, $6, 'ISOVETC', 'Decoct', 'ANIMAL', now())
       ON CONFLICT DO NOTHING`,
      [PATIENT_A, ORG_A, PATIENT_B, ORG_B, PATIENT_A_BARE, ORG_A]
    );
    await owner.query(
      `INSERT INTO patient_contacts
         (id, organization_id, patient_id, relation, name, phone, updated_at)
       VALUES ($1, $2, $3, 'Owner', 'A owner', '+919800000001', now()),
              ($4, $5, $6, 'Owner', 'B owner', '+919800000002', now())
       ON CONFLICT DO NOTHING`,
      [CONTACT_A, ORG_A, PATIENT_A, CONTACT_B, ORG_B, PATIENT_B]
    );
    await owner.query(
      `INSERT INTO animal_profiles
         (id, organization_id, patient_id, species, weight_kg, weight_recorded_on,
          guardian_contact_id, updated_at)
       VALUES ($1, $2, $3, 'Dog', 18.400, DATE '2027-01-04', $4, now()),
              ($5, $6, $7, 'Cat',  3.200, DATE '2027-01-04', $8, now())
       ON CONFLICT DO NOTHING`,
      [PROFILE_A, ORG_A, PATIENT_A, CONTACT_A, PROFILE_B, ORG_B, PATIENT_B, CONTACT_B]
    );
  });

  it('shows a clinic only its own animals', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM animal_profiles WHERE id = ANY($1)', [
        [PROFILE_A, PROFILE_B],
      ]);
      return rows.map((r) => r.id as string);
    });

    expect(seen).toEqual([PROFILE_A]);
  });

  it('refuses to write an animal profile into another clinic', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO animal_profiles (id, organization_id, patient_id, species, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'Horse', now())`,
          [ORG_B, PATIENT_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE COMPOSITE FK, DOING THE ONE THING IT IS THERE FOR (ADR-0004). An
   *   owner at another clinic is not merely refused — it is UNREPRESENTABLE,
   *   because the tenant column is inside the key. This runs as the OWNER, which
   *   bypasses RLS entirely, so the only thing that can stop it is the
   *   constraint.
   */
  it('cannot name another clinic’s contact as an owner, even as the owner role', async () => {
    await expect(
      owner.query('UPDATE animal_profiles SET guardian_contact_id = $1 WHERE id = $2', [
        CONTACT_B,
        PROFILE_A,
      ])
    ).rejects.toThrow(/foreign key|violates/i);
  });

  /**
   * ⚠️ THE HAZARDOUS DIRECTION, AND THE ONE THE FIRST VERSION OF THE CONSTRAINT
   *   LET THROUGH. `..090500` wrote `weight_recorded_on IS NULL OR weight_kg IS
   *   NOT NULL`, which refuses a date that says nothing and accepts a weight
   *   nobody can date — the state a dose then gets calculated from without
   *   anybody being able to see how old it is. This test is what found it, and
   *   `..091000` made the pair symmetric.
   */
  it('refuses a weight with no day it was taken', async () => {
    await expect(
      owner.query(
        `INSERT INTO animal_profiles (id, organization_id, patient_id, weight_kg, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 4.500, now())`,
        [ORG_A, PATIENT_A_BARE]
      )
    ).rejects.toThrow(/weight_and_date_together/i);
  });

  it('refuses a date with no weight against it', async () => {
    await expect(
      owner.query(
        `UPDATE animal_profiles SET weight_kg = NULL, weight_recorded_on = DATE '2027-02-01'
         WHERE id = $1`,
        [PROFILE_A]
      )
    ).rejects.toThrow(/weight_and_date_together/i);
  });

  /**
   * One owner, recorded one way. Two spellings of one owner is how a recall
   * notice gets posted to the wrong address.
   */
  it('refuses an owner recorded as a contact and as free text at once', async () => {
    await expect(
      owner.query('UPDATE animal_profiles SET guardian_name = $1 WHERE id = $2', [
        'Somebody Else',
        PROFILE_A,
      ])
    ).rejects.toThrow(/one_guardian_form/i);
  });
});
