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
  /*
   * ⚠️ `ENCOUNTER_AMEND` IS ONE OF THESE, AND IT ARRIVED AFTER THIS LIST DID.
   *   CE-3 added it to `CLINICAL_AUTHORING` in roles.ts and not to the list here,
   *   which is the exact shape of the omission this file exists to catch — the
   *   audit below now derives the set instead of restating it.
   */
  const authoring = [
    P.ENCOUNTER_CREATE,
    P.ENCOUNTER_CLOSE,
    P.ENCOUNTER_AMEND,
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

  it.each(authoring)('DOCTOR is the only system role that holds %s', (code) => {
    const authors = SYSTEM_ROLE_DEFINITIONS.filter(
      (role) => role.code !== SYSTEM_ROLES.SUPER_ADMIN && role.permissions.includes(code)
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

/**
 * The audit CE-8 owes: EVERY `clinical.*` code, not the ones somebody remembered
 * to list.
 *
 * ⚠️ THE FAILURE MODE IS A CODE THAT NOBODY CLASSIFIED. ORG_OWNER and ORG_ADMIN
 *   are "everything except", so a new clinical code joins them the moment it is
 *   declared; DOCTOR is an explicit list, so the same code joins DOCTOR never.
 *   Both defaults are silent, and one of them is an access-control bug. This
 *   enumerates the codes rather than restating them, so a code added tomorrow is
 *   in the test the day it is added and has to be put somewhere on purpose.
 */
describe('every clinical code is deliberately placed', () => {
  const clinicalCodes = Object.values(PERMISSIONS).filter((code) => code.startsWith('clinical.'));

  /** Authoring the record, per `CLINICAL_AUTHORING` in roles.ts. */
  const authoringCodes: string[] = [
    P.ENCOUNTER_CREATE,
    P.ENCOUNTER_CLOSE,
    P.ENCOUNTER_AMEND,
    P.PRESCRIPTION_CREATE,
    P.PRESCRIPTION_SIGN,
  ];

  /**
   * ⚠️ TAKING AN OBSERVATION IS NOT AUTHORING THE RECORD, AND IT IS THE ONE
   *   CLINICAL CODE A DOCTOR IS DENIED (invariant 7). It belongs to whoever holds
   *   the cuff — the front desk and the nurse. ORG_OWNER keeps it, because
   *   "everything except AUTHORING" is what that role means and taking a blood
   *   pressure is not writing up a consultation.
   */
  const bedsideCodes: string[] = [P.VITALS_RECORD];

  it('names them all', () => {
    /* A guard on the guard: an empty filter would make every case below pass. */
    expect(clinicalCodes.length).toBeGreaterThanOrEqual(11);
  });

  it.each(clinicalCodes)('%s is held by exactly the roles that should hold it', (code) => {
    const owner = permissionsOf(SYSTEM_ROLES.ORG_OWNER);
    const doctor = permissionsOf(SYSTEM_ROLES.DOCTOR);

    if (authoringCodes.includes(code)) {
      expect(owner).not.toContain(code);
      expect(doctor).toContain(code);
      return;
    }
    if (bedsideCodes.includes(code)) {
      expect(owner).toContain(code);
      expect(doctor).not.toContain(code);
      expect(permissionsOf(SYSTEM_ROLES.RECEPTIONIST)).toContain(code);
      return;
    }
    /*
     * Everything else is a read of the record or a configuration of the product
     * — both of which the clinic's owner may do by definition.
     */
    expect(owner).toContain(code);
  });

  /**
   * ⚠️ CONFIGURING A CONSULTATION IS NOT CONDUCTING ONE (CD-7, CE-2, CE-6). A
   *   doctor draws ON a chart with `clinical.encounter.create`; saying what the
   *   chart IS, or what the form is, is an administrative act. Granting either to
   *   DOCTOR by default would let one clinician silently rewrite the form every
   *   other clinician in the practice fills in.
   */
  it.each([P.CLINICAL_TEMPLATE_MANAGE, P.CLINICAL_VISUAL_MAP_MANAGE, P.CLINICAL_MASTER_MANAGE])(
    'DOCTOR does not hold %s',
    (code) => {
      expect(permissionsOf(SYSTEM_ROLES.DOCTOR)).not.toContain(code);
      expect(permissionsOf(SYSTEM_ROLES.ORG_ADMIN)).toContain(code);
    }
  );
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
