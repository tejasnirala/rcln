/**
 * Runs after `seedSystemRoles` and `seedDesignations` — it pairs them by code.
 */
import { prisma } from './client.js';

/**
 * Which titles fit which built-in role, so a Receptionist cannot be made a
 * Radiologist.
 *
 * ⚠️ A TITLE ABSENT FROM EVERY LIST HERE FITS EVERY ROLE.
 *   The eligibility query treats "no visible pairing at all" as "fits
 *   anywhere", not "fits nowhere" — otherwise a clinic that adds a title and
 *   forgets to map it watches it vanish from every menu. So the omissions below
 *   are deliberate, not oversights: IT_ADMINISTRATOR, HOUSEKEEPING and SECURITY
 *   are support roles that any of the built-in roles might carry, and pinning
 *   them to one would be a guess.
 *
 * SUPER_ADMIN and PATIENT get nothing: neither is a staff role, and the invite
 * service already refuses a PLATFORM-scoped role outright.
 */
const ROLE_DESIGNATIONS: Record<string, string[]> = {
  ORG_OWNER: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'MEDICAL_SUPERINTENDENT', 'HEAD_OF_DEPARTMENT'],
  ORG_ADMIN: ['ADMINISTRATOR', 'CLINIC_MANAGER', 'BRANCH_MANAGER', 'MEDICAL_SUPERINTENDENT'],
  BRANCH_ADMIN: ['BRANCH_MANAGER', 'CLINIC_MANAGER', 'ADMINISTRATOR'],
  DOCTOR: [
    'CONSULTANT',
    'SENIOR_CONSULTANT',
    'JUNIOR_CONSULTANT',
    'VISITING_CONSULTANT',
    'RESIDENT_MEDICAL_OFFICER',
    'MEDICAL_OFFICER',
    'DUTY_DOCTOR',
    'HEAD_OF_DEPARTMENT',
    'MEDICAL_SUPERINTENDENT',
    'PHYSIOTHERAPIST',
    'DIETICIAN',
    'COUNSELLOR',
  ],
  NURSE: ['NURSING_SUPERINTENDENT', 'HEAD_NURSE', 'STAFF_NURSE', 'TRAINEE_NURSE', 'WARD_BOY'],
  RECEPTIONIST: ['FRONT_DESK_EXECUTIVE', 'RECEPTIONIST', 'CLINIC_MANAGER'],
  LAB_ASSISTANT: ['LAB_TECHNICIAN', 'RADIOGRAPHER'],
  LAB_MANAGER: [
    'SENIOR_LAB_TECHNICIAN',
    'LAB_TECHNICIAN',
    'PATHOLOGIST',
    'RADIOLOGIST',
    'RADIOGRAPHER',
  ],
  PHARMACIST: ['PHARMACIST', 'CHIEF_PHARMACIST'],
  ACCOUNTANT: ['ACCOUNTS_EXECUTIVE', 'ACCOUNTS_MANAGER', 'BILLING_EXECUTIVE'],
};

export async function seedRoleDesignations(): Promise<void> {
  const roles = new Map(
    (
      await prisma.role.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((r) => [r.code, r.id])
  );

  const designations = new Map(
    (
      await prisma.designation.findMany({
        where: { organizationId: null },
        select: { id: true, code: true },
      })
    ).map((d) => [d.code, d.id])
  );

  let pairs = 0;

  for (const [roleCode, designationCodes] of Object.entries(ROLE_DESIGNATIONS)) {
    const roleId = roles.get(roleCode);
    if (!roleId) continue;

    for (const designationCode of designationCodes) {
      const designationId = designations.get(designationCode);
      if (!designationId) {
        throw new Error(`ROLE_DESIGNATIONS names ${designationCode}, which is not in DESIGNATIONS`);
      }

      // findFirst then create, for the same NULLS NOT DISTINCT reason as above.
      const existing = await prisma.roleDesignation.findFirst({
        where: { organizationId: null, roleId, designationId },
        select: { id: true },
      });
      if (!existing) {
        await prisma.roleDesignation.create({
          data: { organizationId: null, roleId, designationId },
        });
      }
      pairs += 1;
    }
  }

  console.warn(`  role↔title       ${pairs}`);
}
