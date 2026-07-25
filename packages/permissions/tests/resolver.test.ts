/**
 * The branch-scoping matrix, asserted directly.
 *
 * These cases are the multi-branch admin requirements written as tests:
 * one admin over three branches, one admin per branch, and an admin over
 * A and B alongside another over A only.
 */
import {
  can,
  effectivePermissions,
  accessibleBranchIds,
  PERMISSIONS,
  type AccessContext,
  type RoleAssignment,
} from '../src/index.js';

const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';
const BRANCH_C = 'branch-c';
const ALL_BRANCHES = [BRANCH_A, BRANCH_B, BRANCH_C];

const adminPerms = [PERMISSIONS.BRANCH_READ, PERMISSIONS.BRANCH_UPDATE, PERMISSIONS.PATIENT_READ];

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    branchId: BRANCH_A,
    isPlatformAdmin: false,
    roleAssignments: [],
    overrides: [],
    ...overrides,
  };
}

function assignment(branchId: string | null, permissions = adminPerms): RoleAssignment {
  return { roleId: 'role-admin', roleCode: 'BRANCH_ADMIN', branchId, permissions };
}

describe('branchId null means every branch in the organization', () => {
  const orgWideAdmin = ctx({ roleAssignments: [assignment(null)] });

  it.each(ALL_BRANCHES)('grants access at %s', (branchId) => {
    expect(can({ ...orgWideAdmin, branchId }, PERMISSIONS.BRANCH_UPDATE)).toBe(true);
  });

  it('lists every branch in the switcher', () => {
    expect(accessibleBranchIds(orgWideAdmin, ALL_BRANCHES)).toEqual(ALL_BRANCHES);
  });
});

describe('a separate admin per branch', () => {
  const adminOfA = ctx({ roleAssignments: [assignment(BRANCH_A)] });

  it('grants at its own branch', () => {
    expect(can({ ...adminOfA, branchId: BRANCH_A }, PERMISSIONS.BRANCH_UPDATE)).toBe(true);
  });

  it('denies at another branch', () => {
    expect(can({ ...adminOfA, branchId: BRANCH_B }, PERMISSIONS.BRANCH_UPDATE)).toBe(false);
  });

  it('denies org-wide operations', () => {
    // A single-branch grant cannot satisfy an action scoped to the whole org.
    expect(can({ ...adminOfA, branchId: null }, PERMISSIONS.BRANCH_UPDATE)).toBe(false);
  });

  it('lists only its own branch in the switcher', () => {
    expect(accessibleBranchIds(adminOfA, ALL_BRANCHES)).toEqual([BRANCH_A]);
  });
});

describe('one admin over A and B, another over A only', () => {
  const adminOfAB = ctx({ roleAssignments: [assignment(BRANCH_A), assignment(BRANCH_B)] });
  const adminOfA = ctx({ roleAssignments: [assignment(BRANCH_A)] });

  it('the A+B admin reaches both', () => {
    expect(can({ ...adminOfAB, branchId: BRANCH_A }, PERMISSIONS.BRANCH_UPDATE)).toBe(true);
    expect(can({ ...adminOfAB, branchId: BRANCH_B }, PERMISSIONS.BRANCH_UPDATE)).toBe(true);
  });

  it('the A+B admin still cannot reach C', () => {
    expect(can({ ...adminOfAB, branchId: BRANCH_C }, PERMISSIONS.BRANCH_UPDATE)).toBe(false);
  });

  it('the A-only admin cannot reach B', () => {
    expect(can({ ...adminOfA, branchId: BRANCH_B }, PERMISSIONS.BRANCH_UPDATE)).toBe(false);
  });

  it('switchers differ per user', () => {
    expect(accessibleBranchIds(adminOfAB, ALL_BRANCHES)).toEqual([BRANCH_A, BRANCH_B]);
    expect(accessibleBranchIds(adminOfA, ALL_BRANCHES)).toEqual([BRANCH_A]);
  });
});

describe('different roles at different branches', () => {
  const doctorAtAReceptionistAtC = ctx({
    roleAssignments: [
      {
        roleId: 'r-doc',
        roleCode: 'DOCTOR',
        branchId: BRANCH_A,
        permissions: [PERMISSIONS.PRESCRIPTION_CREATE, PERMISSIONS.PATIENT_READ],
      },
      {
        roleId: 'r-rec',
        roleCode: 'RECEPTIONIST',
        branchId: BRANCH_C,
        permissions: [PERMISSIONS.APPOINTMENT_CREATE, PERMISSIONS.PATIENT_READ],
      },
    ],
  });

  it('may prescribe at A but not at C', () => {
    expect(
      can({ ...doctorAtAReceptionistAtC, branchId: BRANCH_A }, PERMISSIONS.PRESCRIPTION_CREATE)
    ).toBe(true);
    expect(
      can({ ...doctorAtAReceptionistAtC, branchId: BRANCH_C }, PERMISSIONS.PRESCRIPTION_CREATE)
    ).toBe(false);
  });

  it('may book appointments at C but not at A', () => {
    expect(
      can({ ...doctorAtAReceptionistAtC, branchId: BRANCH_C }, PERMISSIONS.APPOINTMENT_CREATE)
    ).toBe(true);
    expect(
      can({ ...doctorAtAReceptionistAtC, branchId: BRANCH_A }, PERMISSIONS.APPOINTMENT_CREATE)
    ).toBe(false);
  });
});

describe('overrides', () => {
  const base = ctx({ roleAssignments: [assignment(null)] });

  it('DENY beats a role grant', () => {
    const denied = {
      ...base,
      overrides: [
        { permission: PERMISSIONS.BRANCH_UPDATE, branchId: BRANCH_A, effect: 'DENY' as const },
      ],
    };
    expect(can({ ...denied, branchId: BRANCH_A }, PERMISSIONS.BRANCH_UPDATE)).toBe(false);
    // and only at that branch
    expect(can({ ...denied, branchId: BRANCH_B }, PERMISSIONS.BRANCH_UPDATE)).toBe(true);
  });

  it('DENY beats GRANT when both apply', () => {
    const conflicted = ctx({
      overrides: [
        { permission: PERMISSIONS.PATIENT_READ, branchId: BRANCH_A, effect: 'GRANT' as const },
        { permission: PERMISSIONS.PATIENT_READ, branchId: BRANCH_A, effect: 'DENY' as const },
      ],
    });
    expect(can(conflicted, PERMISSIONS.PATIENT_READ)).toBe(false);
  });

  it('GRANT adds a permission no role carries', () => {
    const granted = ctx({
      overrides: [
        { permission: PERMISSIONS.REPORT_REVENUE, branchId: null, effect: 'GRANT' as const },
      ],
    });
    expect(can(granted, PERMISSIONS.REPORT_REVENUE)).toBe(true);
  });

  it('is reflected in the flattened permission set', () => {
    const mixed = ctx({
      roleAssignments: [assignment(null)],
      overrides: [
        { permission: PERMISSIONS.PATIENT_READ, branchId: null, effect: 'DENY' as const },
        { permission: PERMISSIONS.REPORT_REVENUE, branchId: null, effect: 'GRANT' as const },
      ],
    });
    const perms = effectivePermissions(mixed);
    expect(perms).toContain(PERMISSIONS.REPORT_REVENUE);
    expect(perms).not.toContain(PERMISSIONS.PATIENT_READ);
  });
});

describe('validity windows', () => {
  const now = new Date('2026-07-25T00:00:00Z');

  it('ignores an assignment that has not started', () => {
    const future = ctx({
      roleAssignments: [{ ...assignment(BRANCH_A), validFrom: new Date('2026-08-01T00:00:00Z') }],
    });
    expect(can(future, PERMISSIONS.BRANCH_UPDATE, now)).toBe(false);
  });

  it('ignores an assignment that has expired', () => {
    const expired = ctx({
      roleAssignments: [{ ...assignment(BRANCH_A), validTo: new Date('2026-07-01T00:00:00Z') }],
    });
    expect(can(expired, PERMISSIONS.BRANCH_UPDATE, now)).toBe(false);
  });

  it('honours an assignment inside its window', () => {
    const active = ctx({
      roleAssignments: [
        {
          ...assignment(BRANCH_A),
          validFrom: new Date('2026-07-01T00:00:00Z'),
          validTo: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    });
    expect(can(active, PERMISSIONS.BRANCH_UPDATE, now)).toBe(true);
  });
});

describe('platform super admin', () => {
  const superAdmin = ctx({ isPlatformAdmin: true, roleAssignments: [] });

  it('bypasses membership entirely', () => {
    expect(can(superAdmin, PERMISSIONS.PLATFORM_IMPERSONATE)).toBe(true);
    expect(can({ ...superAdmin, branchId: BRANCH_C }, PERMISSIONS.INVOICE_CANCEL)).toBe(true);
  });

  it('sees every branch', () => {
    expect(accessibleBranchIds(superAdmin, ALL_BRANCHES)).toEqual(ALL_BRANCHES);
  });
});

describe('default deny', () => {
  it('denies when there is no assignment at all', () => {
    expect(can(ctx(), PERMISSIONS.PATIENT_READ)).toBe(false);
  });

  it('denies a permission the role does not carry', () => {
    const doctor = ctx({
      roleAssignments: [assignment(BRANCH_A, [PERMISSIONS.PATIENT_READ])],
    });
    expect(can(doctor, PERMISSIONS.INVOICE_CANCEL)).toBe(false);
  });
});
