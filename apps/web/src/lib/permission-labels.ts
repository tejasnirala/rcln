/**
 * Permission codes, in the words someone at a clinic would use.
 *
 * Every code is `module.resource.action`, so both halves of a readable label are
 * already in the string — no lookup table of 80 descriptions to keep in step
 * with `@rcln/permissions`, and nothing to go stale when a code is added.
 *
 * `iam` is the only module that genuinely needs translating; nobody calls it
 * identity and access management. The rest are listed so the headings read as
 * deliberate rather than as a dump of the database.
 *
 * Shared by the roles and staff screens, which must not drift: the same code has
 * to read the same way in the role editor and in a per-person exception.
 */

const MODULE_LABEL: Record<string, string> = {
  organization: 'Clinic',
  branch: 'Branches',
  iam: 'Staff and access',
  patient: 'Patients',
  appointment: 'Appointments',
  clinical: 'Consultations',
  lab: 'Lab',
  pharmacy: 'Pharmacy',
  inventory: 'Stock',
  billing: 'Billing',
  report: 'Reports',
  settings: 'Settings',
};

export function moduleOf(code: string): string {
  return code.split('.')[0] ?? 'other';
}

export function moduleLabel(module: string): string {
  return MODULE_LABEL[module] ?? module;
}

/**
 * `pharmacy.dispense.create` -> "dispense create".
 *
 * The module is dropped because this is only ever rendered under a heading that
 * already names it, and repeating it makes a list of twelve rows read as twelve
 * copies of the same word.
 */
export function actionLabel(code: string): string {
  return code.split('.').slice(1).join(' ').replace(/_/g, ' ');
}
