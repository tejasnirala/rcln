/**
 * The system role catalogue, asserted where it is a POLICY rather than a list.
 *
 * Most of what a role holds is a product decision that will change, and pinning
 * all of it in a test would mean editing this file every time somebody adds a
 * report. What is pinned here is the small set of statements that are
 * INVARIANTS — the ones where a quiet regression is an access-control bug rather
 * than a missing button, and where the only thing standing between the two is a
 * comment in roles.ts that a future edit can delete without noticing.
 *
 * Both come from the same rule: WHO MAY WRITE IN A PATIENT'S RECORD IS NOT THE
 * SAME QUESTION AS WHO MAY READ IT, and the roles that run the clinic are on the
 * read side of both.
 */
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleCode,
} from '../src/index.js';

const P = PERMISSIONS;

function permissionsOf(code: SystemRoleCode): string[] {
  const role = SYSTEM_ROLE_DEFINITIONS.find((r) => r.code === code);
  if (!role) throw new Error(`no system role ${code}`);
  return role.permissions;
}

describe('writing up a consultation is a clinician-only act', () => {
  const authoring = [
    P.ENCOUNTER_CREATE,
    P.ENCOUNTER_CLOSE,
    P.PRESCRIPTION_CREATE,
    P.PRESCRIPTION_SIGN,
  ];

  /*
   * ⚠️ THE REGRESSION THIS CATCHES IS AN OMISSION, NOT AN EDIT. ORG_OWNER and
   *   ORG_ADMIN are defined as `ALL_PERMISSIONS.filter(...)`, so a new clinical
   *   authoring code lands on both of them BY DEFAULT unless somebody remembers
   *   to name it in CLINICAL_AUTHORING. Nothing else fails when they forget.
   */
  it.each([SYSTEM_ROLES.ORG_OWNER, SYSTEM_ROLES.ORG_ADMIN, SYSTEM_ROLES.BRANCH_ADMIN])(
    '%s may read a consultation and may not write one',
    (role) => {
      const held = permissionsOf(role);

      expect(held).toContain(P.ENCOUNTER_READ);
      expect(held).toContain(P.PRESCRIPTION_READ);

      for (const code of authoring) expect(held).not.toContain(code);
    }
  );

  it('DOCTOR is the only system role that may author one', () => {
    const authors = SYSTEM_ROLE_DEFINITIONS.filter(
      (role) =>
        role.code !== SYSTEM_ROLES.SUPER_ADMIN && role.permissions.includes(P.ENCOUNTER_CREATE)
    ).map((role) => role.code);

    expect(authors).toEqual([SYSTEM_ROLES.DOCTOR]);
  });

  /*
   * SUPER_ADMIN is `ALL_PERMISSIONS` by definition — the platform's break-glass
   * account, not a role anybody at a clinic is assigned. Stated rather than left
   * to inference, because the assertion above excludes it and a reader deserves
   * to know that is deliberate.
   */
  it('SUPER_ADMIN is the deliberate exception', () => {
    expect(permissionsOf(SYSTEM_ROLES.SUPER_ADMIN)).toContain(P.ENCOUNTER_CREATE);
  });
});

describe('vitals: reading an observation is not taking one', () => {
  /*
   * ⚠️ THE ONE ROLE THAT READS WITHOUT WRITING, AND THE POINT OF THE SPLIT. A
   *   doctor consults; the cuff is on the arm at the front desk. Granting
   *   VITALS_RECORD back to DOCTOR would let a consultation silently amend an
   *   observation the front desk signed for, and the chart would stop saying who
   *   measured what.
   */
  it('DOCTOR reads vitals and cannot record them', () => {
    const held = permissionsOf(SYSTEM_ROLES.DOCTOR);

    expect(held).toContain(P.VITALS_READ);
    expect(held).not.toContain(P.VITALS_RECORD);
  });

  /*
   * ⚠️ THE WRITE CODE IMPLIES THE READ NOWHERE IN THE TYPE SYSTEM. Every role
   *   that records must carry both explicitly, or whoever typed a blood pressure
   *   cannot see it back to check it — which is the exact failure the two codes
   *   were split to avoid reintroducing.
   */
  it.each(SYSTEM_ROLE_DEFINITIONS.filter((r) => r.permissions.includes(P.VITALS_RECORD)))(
    '$code records vitals and therefore also reads them',
    (role) => {
      expect(role.permissions).toContain(P.VITALS_READ);
    }
  );

  it('the front desk records vitals and still holds no other clinical read', () => {
    const held = permissionsOf(SYSTEM_ROLES.RECEPTIONIST);

    expect(held).toContain(P.VITALS_READ);
    expect(held).toContain(P.VITALS_RECORD);
    // "No clinical access" in the role description means this, precisely.
    expect(held).not.toContain(P.ENCOUNTER_READ);
    expect(held).not.toContain(P.PRESCRIPTION_READ);
  });
});
