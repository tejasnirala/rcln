import { prisma } from './client.js';

/**
 * Job titles, seeded as PLATFORM rows so a new clinic's invite form is not empty
 * on day one. A clinic adds its own through `iam.designation.manage`; those are
 * org-scoped and invisible to everyone else.
 *
 * Deliberately broader than the role list: a role is what someone may DO
 * (permissions), a designation is what they ARE CALLED. Three consultants can
 * share the DOCTOR role and hold three different titles.
 */
const DESIGNATIONS: { code: string; name: string }[] = [
  { code: 'CONSULTANT', name: 'Consultant' },
  { code: 'SENIOR_CONSULTANT', name: 'Senior Consultant' },
  { code: 'JUNIOR_CONSULTANT', name: 'Junior Consultant' },
  { code: 'VISITING_CONSULTANT', name: 'Visiting Consultant' },
  { code: 'RESIDENT_MEDICAL_OFFICER', name: 'Resident Medical Officer' },
  { code: 'MEDICAL_OFFICER', name: 'Medical Officer' },
  { code: 'DUTY_DOCTOR', name: 'Duty Doctor' },
  { code: 'HEAD_OF_DEPARTMENT', name: 'Head of Department' },
  { code: 'MEDICAL_SUPERINTENDENT', name: 'Medical Superintendent' },
  { code: 'NURSING_SUPERINTENDENT', name: 'Nursing Superintendent' },
  { code: 'HEAD_NURSE', name: 'Head Nurse' },
  { code: 'STAFF_NURSE', name: 'Staff Nurse' },
  { code: 'TRAINEE_NURSE', name: 'Trainee Nurse' },
  { code: 'WARD_BOY', name: 'Ward Attendant' },
  { code: 'FRONT_DESK_EXECUTIVE', name: 'Front Desk Executive' },
  { code: 'RECEPTIONIST', name: 'Receptionist' },
  { code: 'CLINIC_MANAGER', name: 'Clinic Manager' },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager' },
  { code: 'ADMINISTRATOR', name: 'Administrator' },
  { code: 'ACCOUNTS_EXECUTIVE', name: 'Accounts Executive' },
  { code: 'ACCOUNTS_MANAGER', name: 'Accounts Manager' },
  { code: 'BILLING_EXECUTIVE', name: 'Billing Executive' },
  { code: 'PHARMACIST', name: 'Pharmacist' },
  { code: 'CHIEF_PHARMACIST', name: 'Chief Pharmacist' },
  { code: 'LAB_TECHNICIAN', name: 'Lab Technician' },
  { code: 'SENIOR_LAB_TECHNICIAN', name: 'Senior Lab Technician' },
  { code: 'PATHOLOGIST', name: 'Pathologist' },
  { code: 'RADIOLOGIST', name: 'Radiologist' },
  { code: 'RADIOGRAPHER', name: 'Radiographer' },
  { code: 'PHYSIOTHERAPIST', name: 'Physiotherapist' },
  { code: 'DIETICIAN', name: 'Dietician' },
  { code: 'COUNSELLOR', name: 'Counsellor' },
  { code: 'IT_ADMINISTRATOR', name: 'IT Administrator' },
  { code: 'HOUSEKEEPING', name: 'Housekeeping' },
  { code: 'SECURITY', name: 'Security' },
];

export async function seedDesignations(): Promise<void> {
  // findFirst then create/update, not upsert: the unique is
  // (organization_id, code) NULLS NOT DISTINCT and Prisma refuses to build a
  // `where` for a compound unique with a nullable component. Same constraint,
  // and the same workaround, as the settings and specialty seeds. See PITFALLS.
  for (const d of DESIGNATIONS) {
    const existing = await prisma.designation.findFirst({
      where: { organizationId: null, code: d.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.designation.update({ where: { id: existing.id }, data: { name: d.name } });
    } else {
      await prisma.designation.create({
        data: { organizationId: null, code: d.code, name: d.name },
      });
    }
  }

  console.warn(`  designations     ${DESIGNATIONS.length}`);
}
